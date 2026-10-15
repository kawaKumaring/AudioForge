"""CosyVoice3 추론만 흡수. 원문/한국어 정규화는 앱이 소유하고 네트워크는 쓰지 않는다."""
import hashlib
import io
import json
import os
import re
from pathlib import Path
import sys
import time

MODEL_ID = 'FunAudioLLM/Fun-CosyVoice3-0.5B-2512'
MODEL_REV = '29e01c4e8d000f4bcd70751be16fa94bf3d85a18'
SUPPORTED_EMOTIONS = {'default', 'happy', 'sad', 'angry', 'whisper', 'cheerful',
                      'confident', 'tender', 'narration', 'sighing'}
INSTRUCTIONS = {
    'default': 'You are a helpful assistant.',
    'happy': 'You are a helpful assistant. 请非常开心地说一句话。',
    'sad': 'You are a helpful assistant. 请非常伤心地说一句话。',
    'angry': 'You are a helpful assistant. 请非常生气地说一句话。',
    'whisper': 'You are a helpful assistant. Please say a sentence in a very soft voice.',
    'cheerful': 'You are a helpful assistant. 请非常开心地说一句话。',
    'confident': 'You are a helpful assistant. Speak with a confident tone.',
    'tender': 'You are a helpful assistant. Speak gently and warmly.',
    'narration': 'You are a helpful assistant. Read calmly and clearly.',
    'sighing': 'You are a helpful assistant.',
}

def instruction_for(emotion):
    if emotion not in SUPPORTED_EMOTIONS:
        raise RuntimeError('CosyVoice3에서 아직 연결하지 않은 감정입니다: ' + str(emotion))
    return INSTRUCTIONS[emotion] + '<|endofprompt|>'

def engine_text(text, emotion):
    # 숨은 제어 토큰을 사용자가 대사에 주입하면 발음/조건 계약이 무너진다.
    if '<|' in text or '|>' in text:
        raise RuntimeError('대사에는 엔진 내부 제어 토큰을 넣을 수 없습니다')
    return ('[sigh]' if emotion == 'sighing' else '') + text

def group_context_segments(parsed, gaps, kinds):
    """같은 화자·감정의 일반 줄만 묶는다. 문단/명시적 쉼/조건 전환은 그대로."""
    out, out_gaps, out_kinds = [], [], []
    for i, (emotion, text, speaker) in enumerate(parsed):
        # 크기는 호출 시 실제 토큰 수로 다시 검사. 과도한 합치기는 여기서 보수적으로 제한.
        if (out and kinds[i] in ('line', 'internal') and out[-1][0] == emotion
                and out[-1][2] == speaker and len(out[-1][1]) + len(text) < 280):
            out[-1] = (emotion, out[-1][1] + ' ' + text, speaker)
        else:
            out.append((emotion, text, speaker))
            out_gaps.append(gaps[i])
            out_kinds.append(kinds[i])
    return out, out_gaps, out_kinds

def split_by_budget(text, token_count, budget=220):
    """문장/어절을 보존하는 토큰 예산 분할. 단어 중간을 강제로 끊지 않는다."""
    parts=[]
    remaining=text
    while remaining:
        if token_count(remaining)<=budget:
            parts.append(remaining)
            break
        boundaries=[m.end() for m in re.finditer(r'(?<=[.!?。！？])\s+|\s+',remaining)]
        feasible=[p for p in boundaries if token_count(remaining[:p])<=budget]
        if not feasible:
            raise RuntimeError('CosyVoice3 한 어절이 생성 예산을 넘습니다. 단어 중간은 자르지 않습니다')
        position=max(feasible)
        sentence=[p for p in feasible if re.search(r'[.!?。！？]\s*$',remaining[:p])]
        if sentence and max(sentence)>position//2:
            position=max(sentence)
        parts.append(remaining[:position])
        remaining=remaining[position:]
    assert ''.join(parts)==text
    return parts

def asset_paths(root=None):
    if root is None:
        import app_runtime
        root = Path(app_runtime.assets_root()) / 'cosyvoice3_models'
    root = Path(root)
    needed = ['cosyvoice3.yaml', 'llm.pt', 'flow.pt', 'hift.pt', 'campplus.onnx',
              'speech_tokenizer_v3.onnx', 'CosyVoice-BlankEN/config.json',
              'CosyVoice-BlankEN/model.safetensors', 'CosyVoice-BlankEN/tokenizer_config.json',
              'CosyVoice-BlankEN/vocab.json', 'CosyVoice-BlankEN/merges.txt', 'audioforge-manifest.json']
    missing = [x for x in needed if not (root / x).is_file()]
    if missing:
        raise RuntimeError('CosyVoice3 필수 파일이 없습니다(자동 다운로드 없음): ' + ', '.join(missing))
    manifest = json.loads((root / 'audioforge-manifest.json').read_text(encoding='utf-8'))
    if manifest.get('revision') != MODEL_REV:
        raise RuntimeError('CosyVoice3 모델 버전 기록이 맞지 않습니다')
    return root

def inference_config(source):
    # 공식 YAML의 학습 discriminator/dataset는 생성에 필요하지 않다.
    head = source.split('# gan related module', 1)[0]
    return head + '''
get_tokenizer: !name:cosyvoice.tokenizer.tokenizer.get_qwen_tokenizer
    token_path: !ref <qwen_pretrain_path>
    skip_special_tokens: True
    version: cosyvoice3
allowed_special: 'all'
feat_extractor: !name:matcha.utils.audio.mel_spectrogram
    n_fft: 1920
    num_mels: 80
    sampling_rate: !ref <sample_rate>
    hop_size: 480
    win_size: 1920
    fmin: 0
    fmax: null
    center: False
'''


def cached_attention_step(encoder, xs, masks, cache=None):
    """최근 transformers에서 KV 이전 문맥이 0으로 패딩되지 않도록 전체 길이를 전달."""
    import torch
    past = 0
    if cache is not None:
        if hasattr(cache, 'get_seq_length'):
            past = int(cache.get_seq_length())
        else:
            past = int(cache[0][0].shape[-2])
    attention = masks[:, -1, :]
    if past:
        # 앱 추론은 batch=1이며 패딩 없이 생성한다. 이전 토큰을 모두 다시 볼 수 있어야 한다.
        attention = torch.ones((xs.shape[0], past + xs.shape[1]), dtype=torch.bool, device=xs.device)
    outputs = encoder.model(inputs_embeds=xs, attention_mask=attention,
        output_hidden_states=True, return_dict=True, use_cache=True, past_key_values=cache)
    return outputs.hidden_states[-1], outputs.past_key_values

class CosyVoiceEngine:
    name = 'cosyvoice3'
    supported_languages = ['ko', 'en', 'ja', 'zh', 'de', 'es', 'fr', 'it', 'ru']

    def __init__(self):
        self.model = self.frontend = None
        self.run_seed = 0
        self.records = []
        self._prompts = {}

    def load(self):
        if self.model is not None:
            return
        root = asset_paths()
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['TRANSFORMERS_OFFLINE'] = '1'
        vendor = str(Path(__file__).parent / 'cosyvoice_vendor')
        if vendor not in sys.path:
            sys.path.insert(0, vendor)
        import torch
        # 비용 큰 모델 로딩 전에 명확히 거절. 몰래 CPU로 바꾸지 않는다.
        if not torch.cuda.is_available():
            raise RuntimeError('CosyVoice3 연출 경로는 현재 GPU가 필요합니다')
        free, _ = torch.cuda.mem_get_info()
        if free < 6 * 1024 ** 3:
            raise RuntimeError('CosyVoice3를 준비할 GPU 여유가 부족합니다. 다른 GPU 작업을 마친 뒤 다시 시도하세요')
        from audio_utils import patch_torchaudio
        patch_torchaudio()
        from hyperpyyaml import load_hyperpyyaml
        from cosyvoice.cli.frontend import CosyVoiceFrontEnd
        from cosyvoice.cli.model import CosyVoice3Model
        import onnxruntime as ort
        import logging
        # 외부 코드는 입력 전문을 debug 로그에 쓴다. 공개 이벤트/로그로 보내지 않는다.
        logging.getLogger().setLevel(logging.WARNING)
        config = load_hyperpyyaml(io.StringIO(inference_config((root / 'cosyvoice3.yaml').read_text(encoding='utf-8'))),
                                 overrides={'qwen_pretrain_path': str(root / 'CosyVoice-BlankEN')})
        # 공식 특성 추출 함수를 쓰되 자동 다운로드 가능한 텍스트 정규화 초기화는 제외한다.
        fe = CosyVoiceFrontEnd.__new__(CosyVoiceFrontEnd)
        fe.tokenizer = config['get_tokenizer']()
        fe.feat_extractor = config['feat_extractor']
        fe.device = torch.device('cuda')
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        fe.campplus_session = ort.InferenceSession(str(root / 'campplus.onnx'), sess_options=opts, providers=['CPUExecutionProvider'])
        # 작은 참조 추출은 CPU ONNX로 고정, 공유 런타임에 GPU ONNX를 설치하지 않는다.
        fe.speech_tokenizer_session = ort.InferenceSession(str(root / 'speech_tokenizer_v3.onnx'), sess_options=opts, providers=['CPUExecutionProvider'])
        fe.spk2info = {}
        fe.allowed_special = 'all'
        fe.text_frontend = ''
        model = CosyVoice3Model(config['llm'], config['flow'], config['hift'], fp16=False)
        model.load(str(root / 'llm.pt'), str(root / 'flow.pt'), str(root / 'hift.pt'))
        self.model = model
        from types import MethodType
        self.model.llm.llm.forward_one_step = MethodType(cached_attention_step, self.model.llm.llm)
        self.frontend = fe
        self.sample_rate = int(config['sample_rate'])
        self.asset_root = root
        # vendor thread 실패는 end 플래그를 세우지 않아 영원히 기다릴 수 있다.
        original_job = self.model.llm_job
        self._thread_error = None
        def guarded_job(*args, **kwargs):
            try:
                original_job(*args, **kwargs)
            except BaseException as exc:
                self._thread_error = exc
                self.model.llm_end_dict[args[-1]] = True
        self.model.llm_job = guarded_job
        original_inference = self.model.llm.inference_wrapper
        def guarded_inference(lm_input, sampling, min_len, max_len, uuid):
            count = 0
            for token in original_inference(lm_input, sampling, min_len, max_len, uuid):
                count += 1
                yield token
            if count >= max_len:
                raise RuntimeError('CosyVoice3 생성 상한에 도달했습니다. 미완성 음성은 발행하지 않습니다')
        self.model.llm.inference_wrapper = guarded_inference

    def synthesize_segment(self, text, ref_audio, emotion_id, speed, output_path):
        instruct = instruction_for(emotion_id)
        sent = engine_text(text, emotion_id)
        if not sent.strip() or not ref_audio or not Path(ref_audio).is_file():
            raise RuntimeError('CosyVoice3에는 읽을 대사와 유효한 참조 목소리가 필요합니다')
        self.load()
        import torch
        import numpy as np
        import random
        import soundfile as sf
        import copy
        # 내용 지문으로 캐시. 같은 경로의 참조를 교체해도 이전 사람이 섞이지 않는다.
        ref_hash = hashlib.sha256(Path(ref_audio).read_bytes()).hexdigest()
        key = (ref_hash, instruct)
        if key not in self._prompts:
            if len(self._prompts) >= 12:
                self._prompts.pop(next(iter(self._prompts)))
            self._prompts[key] = self.frontend.frontend_instruct2(sent, instruct, str(ref_audio), self.sample_rate, '')
        inputs = copy.copy(self._prompts[key])
        # vendor inference가 길이 텐서를 in-place 변경하므로 매 생성마다 clone한다.
        inputs = {k: v.clone() if torch.is_tensor(v) else v for k, v in inputs.items()}
        chunks=split_by_budget(sent,lambda t:len(self.frontend.tokenizer.encode(t,allowed_special='all')))
        seed = int(self.run_seed)
        random.seed(seed)
        np.random.seed(seed % (2 ** 32))
        torch.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)
        started = time.monotonic()
        pieces=[]
        chunk_records=[]
        for index, chunk in enumerate(chunks):
            self._thread_error = None
            actual_seed=(seed+index) % (2 ** 31-1)
            random.seed(actual_seed); np.random.seed(actual_seed); torch.manual_seed(actual_seed); torch.cuda.manual_seed_all(actual_seed)
            current={k:v.clone() if torch.is_tensor(v) else v for k,v in inputs.items()}
            current['text'],current['text_len']=self.frontend._extract_text_token(chunk)
            chunk_pieces=[p['tts_speech'].detach().cpu() for p in self.model.tts(**current,stream=False,speed=float(speed))]
            if self._thread_error is not None:
                raise RuntimeError('CosyVoice3 생성에 실패했습니다') from self._thread_error
            if not chunk_pieces:
                raise RuntimeError('CosyVoice3가 빈 조각을 반환했습니다')
            chunk_records.append({'index':index,'seed':actual_seed,'sent_text':chunk,
                                  'frames':sum(p.shape[1] for p in chunk_pieces)})
            pieces.extend(chunk_pieces)
        if not pieces:
            raise RuntimeError('CosyVoice3가 빈 음성을 반환했습니다')
        audio = torch.cat(pieces, dim=1).squeeze(0).numpy()
        if not np.isfinite(audio).all() or len(audio) == 0:
            raise RuntimeError('CosyVoice3가 유효하지 않은 음성을 반환했습니다')
        # 잘라내기/시간 변형 없음. 레벨 초과 시에만 전체에 같은 계수를 곱한다.
        peak = float(np.abs(audio).max())
        gain = min(1.0, .98 / peak) if peak > 0 else 1.0
        audio = audio * gain
        target = Path(output_path)
        if target.resolve() == Path(ref_audio).resolve() or (target.exists() and os.path.samefile(target, ref_audio)):
            raise RuntimeError('참조 목소리를 덮어쓸 수 없습니다')
        temp = target.with_name(target.name + '.cosy-part.wav')
        try:
            sf.write(str(temp), audio, self.sample_rate, subtype='FLOAT')
            os.replace(temp, target)
        finally:
            if temp.exists():
                temp.unlink()
        self.records.append({'sent_text': sent, 'instruction': instruct, 'emotion_id': emotion_id,
            'seed': seed, 'reference_sha256': ref_hash, 'model_revision': MODEL_REV,
            'gain': gain, 'frames': len(audio), 'sample_rate': self.sample_rate, 'chunks': chunk_records,
            'elapsed_sec': round(time.monotonic() - started, 3)})
