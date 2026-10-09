# -*- coding: utf-8 -*-
"""노래 목소리 변환 — seed-vc inference.py 의 f0(44.1kHz) 경로만 옮겨 온 진입 스크립트.

★무엇을 옮겼나 (2026-10-10, 흡수 1단계 — GPU 검증 전)
  원본: resources/seed-vc/inference.py (Plachta/seed-vc, GPL-3.0 — 같은 폴더 LICENSE·ATTRIBUTION.md).
  song_voice.py 가 넘기는 인자 묶음(확산 40, f0 켬, 자동 음높이 끔, 반음 이동)만 받는다.
  계산 순서·수치는 원본과 같게 둔다. 바꾼 것은 **모델을 읽는 곳**과 **저장 함수**뿐이다.
    · 모델: HF 캐시·다운로드 대신 --models-dir(기본 externals/song_vc_models) 의 고정 경로.
    · 저장: torchaudio.save 대신 soundfile(32비트 실수 wav — torchaudio 가 실수 텐서를 쓰던 형식과 같다).
    · f0 를 끈 말하기 모델·hifigan·vocos·hubert·xlsr 분기는 쓰지 않아 뺐다.

★출력 이름은 원본과 같다: vc_{원본}_{참조}_{길이}_{단계}_{cfg}.wav
  song_voice.py 는 출력 폴더에 새로 생긴 wav 를 집으므로 이름이 같아야 바꿔 끼울 수 있다.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)  # modules.* 를 이 폴더에서 찾는다(원본 import 경로 유지).

# ★외부 접속 금지 — 모델은 로컬 폴더에서만 읽는다.
os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')

import argparse
import time
import warnings

import numpy as np
import torch
import yaml

warnings.simplefilter('ignore')

ROOT = os.path.dirname(os.path.dirname(HERE))
DEFAULT_MODELS = os.path.join(ROOT, 'externals', 'song_vc_models')
MODELS_ENV = 'AF_SONG_VC_MODELS'

DIT_FILE = os.path.join('dit', 'DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema_v2.pth')
DIT_CONFIG = os.path.join('dit', 'config_dit_mel_seed_uvit_whisper_base_f0_44k.yml')
BIGVGAN_DIR = 'bigvgan_v2_44khz_128band_512x'
WHISPER_DIR = 'whisper-small'
RMVPE_FILE = 'rmvpe.pt'
CAMPPLUS_FILE = 'campplus_cn_common.bin'


def pick_device():
    if torch.cuda.is_available():
        return torch.device('cuda')
    if torch.backends.mps.is_available():
        return torch.device('mps')
    return torch.device('cpu')


def model_paths(models_dir):
    d = models_dir or os.environ.get(MODELS_ENV) or DEFAULT_MODELS
    return {
        'dit': os.path.join(d, DIT_FILE),
        'config': os.path.join(d, DIT_CONFIG),
        'bigvgan': os.path.join(d, BIGVGAN_DIR),
        'whisper': os.path.join(d, WHISPER_DIR),
        'rmvpe': os.path.join(d, RMVPE_FILE),
        'campplus': os.path.join(d, CAMPPLUS_FILE),
    }


# ---- 부품별 읽기(검사 스크립트도 이 함수들을 그대로 쓴다) ----

def load_dit(dit_path, config_path, device):
    from modules.commons import recursive_munch, build_model, load_checkpoint
    config = yaml.safe_load(open(config_path, 'r', encoding='utf-8'))
    model_params = recursive_munch(config['model_params'])
    model_params.dit_type = 'DiT'
    model = build_model(model_params, stage='DiT')
    model, _, _, _ = load_checkpoint(model, None, dit_path, load_only_params=True,
                                     ignore_modules=[], is_distributed=False)
    for key in model:
        model[key].eval()
        model[key].to(device)
    model.cfm.estimator.setup_caches(max_batch_size=1, max_seq_length=8192)
    return model, config


def load_rmvpe(path, device):
    from modules.rmvpe import RMVPE
    return RMVPE(path, is_half=False, device=device)


def load_campplus(path, device):
    from modules.campplus.DTDNN import CAMPPlus
    m = CAMPPlus(feat_dim=80, embedding_size=192)
    m.load_state_dict(torch.load(path, map_location='cpu', weights_only=True))
    return m.eval().to(device)


def load_bigvgan(model_dir, device):
    from modules.bigvgan import bigvgan
    m = bigvgan.BigVGAN.load_local(model_dir, use_cuda_kernel=False)
    m.remove_weight_norm()
    return m.eval().to(device)


def load_whisper(model_dir, device, dtype=torch.float16):
    from transformers import AutoFeatureExtractor, WhisperModel
    wm = WhisperModel.from_pretrained(model_dir, torch_dtype=dtype, local_files_only=True).to(device)
    del wm.decoder
    fe = AutoFeatureExtractor.from_pretrained(model_dir, local_files_only=True)

    def semantic_fn(waves_16k):
        ori_inputs = fe([waves_16k.squeeze(0).cpu().numpy()], return_tensors='pt',
                        return_attention_mask=True)
        ori_input_features = wm._mask_input_features(
            ori_inputs.input_features, attention_mask=ori_inputs.attention_mask).to(device)
        with torch.no_grad():
            ori_outputs = wm.encoder(ori_input_features.to(wm.encoder.dtype), head_mask=None,
                                     output_attentions=False, output_hidden_states=False,
                                     return_dict=True)
        S_ori = ori_outputs.last_hidden_state.to(torch.float32)
        return S_ori[:, :waves_16k.size(-1) // 320 + 1]
    return wm, semantic_fn


def mel_args(config):
    sp = config['preprocess_params']['spect_params']
    return {
        'n_fft': sp['n_fft'], 'win_size': sp['win_length'], 'hop_size': sp['hop_length'],
        'num_mels': sp['n_mels'], 'sampling_rate': config['preprocess_params']['sr'],
        'fmin': sp.get('fmin', 0),
        'fmax': None if sp.get('fmax', 'None') == 'None' else 8000,
        'center': False,
    }


def load_models(paths, device, whisper_dtype=torch.float16):
    from modules.audio import mel_spectrogram
    model, config = load_dit(paths['dit'], paths['config'], device)
    f0_fn = load_rmvpe(paths['rmvpe'], device).infer_from_audio
    campplus_model = load_campplus(paths['campplus'], device)
    vocoder_fn = load_bigvgan(paths['bigvgan'], device)
    _, semantic_fn = load_whisper(paths['whisper'], device, whisper_dtype)
    margs = mel_args(config)
    to_mel = lambda x: mel_spectrogram(x, **margs)
    return model, semantic_fn, f0_fn, vocoder_fn, campplus_model, to_mel, margs


def adjust_f0_semitones(f0_sequence, n_semitones):
    factor = 2 ** (n_semitones / 12)
    return f0_sequence * factor


def crossfade(chunk1, chunk2, overlap):
    fade_out = np.cos(np.linspace(0, np.pi / 2, overlap)) ** 2
    fade_in = np.cos(np.linspace(np.pi / 2, 0, overlap)) ** 2
    if len(chunk2) < overlap:
        chunk2[:overlap] = chunk2[:overlap] * fade_in[:len(chunk2)] + (chunk1[-overlap:] * fade_out)[:len(chunk2)]
    else:
        chunk2[:overlap] = chunk2[:overlap] * fade_in + chunk1[-overlap:] * fade_out
    return chunk2


@torch.no_grad()
def main(args):
    import librosa
    import soundfile as sf
    import torchaudio

    if not args.f0_condition:
        # ★흡수한 것은 f0 노래 모델 하나뿐이다. 조용히 다른 모델로 돌지 않게 막는다.
        raise SystemExit('song_vc: --f0-condition False(말하기 모델)는 옮기지 않았습니다.')
    device = pick_device()
    fp16 = args.fp16
    paths = model_paths(args.models_dir)
    if args.checkpoint:
        paths['dit'] = args.checkpoint
    if args.config:
        paths['config'] = args.config
    model, semantic_fn, f0_fn, vocoder_fn, campplus_model, mel_fn, mel_fn_args = load_models(paths, device)

    sr = mel_fn_args['sampling_rate']
    auto_f0_adjust = args.auto_f0_adjust
    pitch_shift = args.semi_tone_shift
    source = args.source
    target_name = args.target
    diffusion_steps = args.diffusion_steps
    length_adjust = args.length_adjust
    inference_cfg_rate = args.inference_cfg_rate
    source_audio = librosa.load(source, sr=sr)[0]
    ref_audio = librosa.load(target_name, sr=sr)[0]

    sr = 44100
    hop_length = 512
    max_context_window = sr // hop_length * 30
    overlap_frame_len = 16
    overlap_wave_len = overlap_frame_len * hop_length

    source_audio = torch.tensor(source_audio).unsqueeze(0).float().to(device)
    ref_audio = torch.tensor(ref_audio[:sr * 25]).unsqueeze(0).float().to(device)

    time_vc_start = time.time()
    converted_waves_16k = torchaudio.functional.resample(source_audio, sr, 16000)
    if converted_waves_16k.size(-1) <= 16000 * 30:
        S_alt = semantic_fn(converted_waves_16k)
    else:
        overlapping_time = 5
        S_alt_list = []
        buffer = None
        traversed_time = 0
        while traversed_time < converted_waves_16k.size(-1):
            if buffer is None:
                chunk = converted_waves_16k[:, traversed_time:traversed_time + 16000 * 30]
            else:
                chunk = torch.cat(
                    [buffer, converted_waves_16k[:, traversed_time:traversed_time + 16000 * (30 - overlapping_time)]],
                    dim=-1)
            S_alt = semantic_fn(chunk)
            if traversed_time == 0:
                S_alt_list.append(S_alt)
            else:
                S_alt_list.append(S_alt[:, 50 * overlapping_time:])
            buffer = chunk[:, -16000 * overlapping_time:]
            traversed_time += 30 * 16000 if traversed_time == 0 else chunk.size(-1) - 16000 * overlapping_time
        S_alt = torch.cat(S_alt_list, dim=1)

    ori_waves_16k = torchaudio.functional.resample(ref_audio, sr, 16000)
    S_ori = semantic_fn(ori_waves_16k)

    mel = mel_fn(source_audio.to(device).float())
    mel2 = mel_fn(ref_audio.to(device).float())

    target_lengths = torch.LongTensor([int(mel.size(2) * length_adjust)]).to(mel.device)
    target2_lengths = torch.LongTensor([mel2.size(2)]).to(mel2.device)

    feat2 = torchaudio.compliance.kaldi.fbank(ori_waves_16k, num_mel_bins=80, dither=0,
                                              sample_frequency=16000)
    feat2 = feat2 - feat2.mean(dim=0, keepdim=True)
    style2 = campplus_model(feat2.unsqueeze(0))

    F0_ori = f0_fn(ori_waves_16k[0], thred=0.03)
    F0_alt = f0_fn(converted_waves_16k[0], thred=0.03)
    F0_ori = torch.from_numpy(F0_ori).to(device)[None]
    F0_alt = torch.from_numpy(F0_alt).to(device)[None]
    voiced_F0_ori = F0_ori[F0_ori > 1]
    voiced_F0_alt = F0_alt[F0_alt > 1]
    log_f0_alt = torch.log(F0_alt + 1e-5)
    voiced_log_f0_ori = torch.log(voiced_F0_ori + 1e-5)
    voiced_log_f0_alt = torch.log(voiced_F0_alt + 1e-5)
    median_log_f0_ori = torch.median(voiced_log_f0_ori)
    median_log_f0_alt = torch.median(voiced_log_f0_alt)
    shifted_log_f0_alt = log_f0_alt.clone()
    if auto_f0_adjust:
        shifted_log_f0_alt[F0_alt > 1] = log_f0_alt[F0_alt > 1] - median_log_f0_alt + median_log_f0_ori
    shifted_f0_alt = torch.exp(shifted_log_f0_alt)
    if pitch_shift != 0:
        shifted_f0_alt[F0_alt > 1] = adjust_f0_semitones(shifted_f0_alt[F0_alt > 1], pitch_shift)

    cond, _, codes, commitment_loss, codebook_loss = model.length_regulator(
        S_alt, ylens=target_lengths, n_quantizers=3, f0=shifted_f0_alt)
    prompt_condition, _, codes, commitment_loss, codebook_loss = model.length_regulator(
        S_ori, ylens=target2_lengths, n_quantizers=3, f0=F0_ori)

    max_source_window = max_context_window - mel2.size(2)
    processed_frames = 0
    generated_wave_chunks = []
    while processed_frames < cond.size(1):
        chunk_cond = cond[:, processed_frames:processed_frames + max_source_window]
        is_last_chunk = processed_frames + max_source_window >= cond.size(1)
        cat_condition = torch.cat([prompt_condition, chunk_cond], dim=1)
        with torch.autocast(device_type=device.type, dtype=torch.float16 if fp16 else torch.float32):
            vc_target = model.cfm.inference(cat_condition,
                                            torch.LongTensor([cat_condition.size(1)]).to(mel2.device),
                                            mel2, style2, None, diffusion_steps,
                                            inference_cfg_rate=inference_cfg_rate)
            vc_target = vc_target[:, :, mel2.size(-1):]
        vc_wave = vocoder_fn(vc_target.float()).squeeze()
        vc_wave = vc_wave[None, :]
        if processed_frames == 0:
            if is_last_chunk:
                generated_wave_chunks.append(vc_wave[0].cpu().numpy())
                break
            generated_wave_chunks.append(vc_wave[0, :-overlap_wave_len].cpu().numpy())
            previous_chunk = vc_wave[0, -overlap_wave_len:]
            processed_frames += vc_target.size(2) - overlap_frame_len
        elif is_last_chunk:
            generated_wave_chunks.append(
                crossfade(previous_chunk.cpu().numpy(), vc_wave[0].cpu().numpy(), overlap_wave_len))
            processed_frames += vc_target.size(2) - overlap_frame_len
            break
        else:
            generated_wave_chunks.append(
                crossfade(previous_chunk.cpu().numpy(), vc_wave[0, :-overlap_wave_len].cpu().numpy(),
                          overlap_wave_len))
            previous_chunk = vc_wave[0, -overlap_wave_len:]
            processed_frames += vc_target.size(2) - overlap_frame_len
    vc_wave = torch.tensor(np.concatenate(generated_wave_chunks))[None, :].float()
    time_vc_end = time.time()
    print(f"RTF: {(time_vc_end - time_vc_start) / vc_wave.size(-1) * sr}")

    source_name = os.path.basename(source).split(".")[0]
    target_name = os.path.basename(target_name).split(".")[0]
    os.makedirs(args.output, exist_ok=True)
    out = os.path.join(args.output,
                       f"vc_{source_name}_{target_name}_{length_adjust}_{diffusion_steps}_{inference_cfg_rate}.wav")
    # torchaudio.save(실수 텐서) 와 같은 32비트 실수 wav.
    sf.write(out, vc_wave[0].cpu().numpy(), sr, subtype='FLOAT')


def build_parser():
    from modules.commons import str2bool as s2b
    p = argparse.ArgumentParser()
    p.add_argument('--source', type=str, required=True)
    p.add_argument('--target', type=str, required=True)
    p.add_argument('--output', type=str, default='./reconstructed')
    p.add_argument('--diffusion-steps', type=int, default=30)
    p.add_argument('--length-adjust', type=float, default=1.0)
    p.add_argument('--inference-cfg-rate', type=float, default=0.7)
    p.add_argument('--f0-condition', type=s2b, default=True)
    p.add_argument('--auto-f0-adjust', type=s2b, default=False)
    p.add_argument('--semi-tone-shift', type=int, default=0)
    p.add_argument('--checkpoint', type=str, default=None, help='DiT 가중치(기본: 모델 폴더)')
    p.add_argument('--config', type=str, default=None, help='DiT 설정 yml(기본: 모델 폴더)')
    p.add_argument('--fp16', type=s2b, default=True)
    p.add_argument('--models-dir', type=str, default=None,
                   help='모델 폴더(기본: 환경변수 %s → externals/song_vc_models)' % MODELS_ENV)
    return p


if __name__ == '__main__':
    main(build_parser().parse_args())
