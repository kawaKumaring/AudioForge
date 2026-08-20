"""TTS engine abstraction + synthesis worker.

Engines:
  - F5-TTS: English + voice cloning (reference audio)
  - Kokoro: Korean, Japanese, Chinese, English (voice packs)
  - (future) GPT-SoVITS: Korean/Japanese + voice cloning

Engine selection:
  - User can specify engine in UI
  - Auto-select by language: Korean/Japanese → Kokoro, English → F5-TTS
"""

import os
import re
from audio_utils import emit, get_device, find_ffmpeg, patch_torchaudio

# ── Emotion definitions ──
# ⚠️ 감정 id는 UI(src/renderer/components/TTSEditor.tsx의 EMOTION_GROUPS)와 공유된다.
# 여기 값(id)/키(한글 태그)를 바꾸면 TS도 함께 갱신할 것. 불일치는 smoke_test의
# _check_emotions()가 잡는다(TS id ⊆ EMOTION_PROMPTS 키 ∩ EMOTION_TAGS 값). — L-3

EMOTION_TAGS = {
    "기본": "default", "기쁨": "happy", "슬픔": "sad", "화남": "angry",
    "놀람": "surprise", "속삭임": "whisper", "진지": "serious", "명랑": "cheerful",
    "걱정": "worried", "피곤": "tired", "공손": "polite", "냉소": "sarcastic",
    "긴장": "nervous", "부끄러움": "shy", "자신감": "confident", "위로": "comforting",
    "흥분": "excited", "공포": "scared", "짜증": "annoyed", "나레이션": "narration",
    "그리움": "longing", "질투": "jealous", "감동": "touched", "허탈": "empty",
    "비꼼": "mocking", "애교": "cute", "냉정": "cold", "다정": "tender",
    "울먹": "tearful", "한숨": "sighing", "비장": "solemn", "장난": "playful",
    "경멸": "contempt", "동경": "admiring", "초조": "restless", "체념": "resigned",
    "호기심": "curious", "지루함": "bored", "당황": "flustered", "득의": "proud",
    "설렘": "flutter", "유혹": "seductive", "달콤": "sweet", "은밀": "intimate",
    "애틋": "bittersweet", "매력": "charming", "흥분(성적)": "aroused",
    "절정": "climax", "신음": "moaning", "황홀": "ecstasy",
    # English aliases
    "happy": "happy", "sad": "sad", "angry": "angry", "surprise": "surprise",
    "whisper": "whisper", "serious": "serious", "cheerful": "cheerful",
    "worried": "worried", "tired": "tired", "polite": "polite", "sarcastic": "sarcastic",
    "nervous": "nervous", "shy": "shy", "confident": "confident", "comforting": "comforting",
    "excited": "excited", "scared": "scared", "annoyed": "annoyed", "narration": "narration",
    "longing": "longing", "jealous": "jealous", "touched": "touched", "empty": "empty",
    "mocking": "mocking", "cute": "cute", "cold": "cold", "tender": "tender",
    "tearful": "tearful", "sighing": "sighing", "solemn": "solemn", "playful": "playful",
    "contempt": "contempt", "admiring": "admiring", "restless": "restless", "resigned": "resigned",
    "curious": "curious", "bored": "bored", "flustered": "flustered", "proud": "proud",
    "flutter": "flutter", "seductive": "seductive", "sweet": "sweet", "intimate": "intimate",
    "bittersweet": "bittersweet", "charming": "charming", "aroused": "aroused",
    "climax": "climax", "moaning": "moaning", "ecstasy": "ecstasy",
}

EMOTION_PROMPTS = {
    "default": "", "happy": "(happily, with joy and excitement) ",
    "sad": "(sadly, with a sorrowful and melancholic tone) ",
    "angry": "(angrily, with frustration and strong intensity) ",
    "surprise": "(with genuine surprise and wide-eyed astonishment) ",
    "whisper": "(whispering very softly and quietly, barely audible) ",
    "serious": "(in a serious, formal and composed authoritative tone) ",
    "cheerful": "(cheerfully, with a bright, upbeat and light-hearted tone) ",
    "worried": "(with worry and anxiety, voice slightly trembling) ",
    "tired": "(tiredly, with a weary, slow and exhausted tone) ",
    "polite": "(politely and respectfully, with a warm courteous tone) ",
    "sarcastic": "(sarcastically, with a dry and ironic undertone) ",
    "nervous": "(nervously, with a shaky and hesitant voice) ",
    "shy": "(shyly, with a soft, bashful and timid tone) ",
    "confident": "(confidently, with a strong, bold and assured voice) ",
    "comforting": "(gently and warmly, with a soothing comforting tone) ",
    "excited": "(excitedly, with high energy and enthusiastic tone) ",
    "scared": "(fearfully, with a trembling and frightened voice) ",
    "annoyed": "(with annoyance and slight irritation in voice) ",
    "narration": "(in a calm, clear narrator voice with even pacing) ",
    "longing": "(with deep longing and nostalgic yearning) ",
    "jealous": "(with jealousy and envious undertone) ",
    "touched": "(deeply moved and emotionally touched, voice quivering) ",
    "empty": "(with an empty, hollow and defeated tone) ",
    "mocking": "(mockingly, with a taunting and derisive tone) ",
    "cute": "(cutely, with an adorable and sweet aegyo tone) ",
    "cold": "(coldly, with an icy and emotionless flat tone) ",
    "tender": "(tenderly, with warmth and gentle affection) ",
    "tearful": "(on the verge of tears, voice cracking with emotion) ",
    "sighing": "(with a heavy sigh, weary and resigned) ",
    "solemn": "(solemnly, with gravity and dignified seriousness) ",
    "playful": "(playfully, with a teasing and fun-loving tone) ",
    "contempt": "(with contempt and disdain, looking down) ",
    "admiring": "(with admiration and awe, deeply impressed) ",
    "restless": "(restlessly, with urgent and fidgety energy) ",
    "resigned": "(with resigned acceptance, giving up hope) ",
    "curious": "(curiously, with inquisitive wonder) ",
    "bored": "(boredly, with a flat and uninterested monotone) ",
    "flustered": "(flustered, confused and embarrassed) ",
    "proud": "(proudly, with triumphant satisfaction) ",
    "flutter": "(with heart fluttering, nervous romantic excitement and anticipation) ",
    "seductive": "(in a low, seductive and alluring tone, slow and breathy) ",
    "sweet": "(sweetly, with a honey-like warm and loving tone) ",
    "intimate": "(intimately, in a close, quiet and private whisper) ",
    "bittersweet": "(with bittersweet longing, tender yet painful) ",
    "charming": "(charmingly, with confident and magnetic allure) ",
    "aroused": "(with heavy breathing, heated and passionate intensity) ",
    "climax": "(with intense, overwhelming emotional peak, gasping) ",
    "moaning": "(with a low, breathy moan-like quality) ",
    "ecstasy": "(in a dreamy, euphoric and blissful daze) ",
}


# ── Engine base class ──

class TTSEngine:
    """Base class for TTS engines. Subclass to add new engines."""
    name = "base"
    supported_languages = []

    def load(self):
        raise NotImplementedError

    def synthesize_segment(self, text, ref_audio, emotion_id, speed, output_path):
        raise NotImplementedError


# ── F5-TTS Engine (English + voice cloning) ──

class F5TTSEngine(TTSEngine):
    name = "f5tts"
    supported_languages = ["en"]

    def __init__(self):
        self._model = None

    def load(self):
        if self._model is None:
            emit("progress", percent=10, message="F5-TTS 모델 로딩 중...")
            patch_torchaudio()  # F5-TTS loads ref audio via torchaudio.load
            from f5_tts.api import F5TTS
            device = get_device(timeout_sec=10)
            self._model = F5TTS(device=device)
            emit("progress", percent=20, message=f"F5-TTS 로딩 완료 ({device.upper()})")

    def synthesize_segment(self, text, ref_audio, emotion_id, speed, output_path):
        self.load()
        ref_text = EMOTION_PROMPTS.get(emotion_id, "")
        self._model.infer(
            ref_file=ref_audio, ref_text=ref_text,
            gen_text=text, file_wave=output_path, speed=speed
        )


# ── Kokoro Engine (Korean, Japanese, Chinese, English) ──

class KokoroEngine(TTSEngine):
    name = "kokoro"
    supported_languages = ["ko", "ja", "zh", "en"]

    def __init__(self):
        self._pipeline = None
        self._lang = "k"  # default Korean

    def load(self, lang_code="ko"):
        lang_map = {"ko": "k", "ja": "j", "zh": "z", "en": "a"}
        new_lang = lang_map.get(lang_code, "k")

        # Reload only when the language actually changes
        if self._pipeline is not None and self._lang == new_lang:
            return

        emit("progress", percent=10, message=f"Kokoro TTS 로딩 중... (언어: {lang_code})")
        from kokoro import KPipeline
        self._pipeline = KPipeline(lang_code=new_lang)
        self._lang = new_lang
        emit("progress", percent=20, message="Kokoro 로딩 완료")

    def synthesize_segment(self, text, ref_audio, emotion_id, speed, output_path):
        # Do not force-reload here — the caller sets the language via load(lang)
        if self._pipeline is None:
            self.load()
        import soundfile as sf

        generator = self._pipeline(text, speed=speed)
        all_audio = []
        for _, _, audio in generator:
            all_audio.append(audio)

        if all_audio:
            import numpy as np
            combined = np.concatenate(all_audio)
            sf.write(output_path, combined, 24000)


# ── GPT-SoVITS Engine (Korean, Japanese, Chinese, English — via isolated venv) ──

class GPTSoVITSEngine(TTSEngine):
    name = "gptsovits"
    supported_languages = ["ko", "ja", "zh", "en"]

    # 전사 캐시 상한(엔진 인스턴스 범위) — 정상 작업은 참조가 소수라 도달하지 않지만,
    # 비정상적으로 많은 참조에서도 무한히 쌓이지 않게 하는 방어적 상한.
    _TRANSCRIPT_CACHE_MAX = 128

    def __init__(self):
        self._venv_python = None
        self._bridge_script = None
        self._ref_assess_cache = {}  # (path,size,mtime) → ReferenceAssessment (재판정 방지)
        self._warned_refs = set()    # 참조당 판정 경고 1회만 알림
        self._ref_transcript_cache = {}  # (path,size,mtime,model) → ReferenceTranscript (전사 1회)
        self._warned_transcripts = set()  # (transcript_key, code) → 전사 강등 경고 1회만
        self._announced_transcripts = set()  # transcript_key → 전사 완료 메시지 1회만(로그 오염 방지)
        self._prompt_overrides = {}  # abspath → {manual_text, prompt_lang, mode} (사용자 수동 override)

    def set_prompt_overrides(self, overrides_by_path):
        """경로별 사용자 프롬프트 override 설정. 매 작업 시작 시 호출(빈 dict면 이전 override 해제)."""
        self._prompt_overrides = overrides_by_path or {}

    def _emit_prompt_warnings(self, key, prompt):
        """ref-free 등 강등 경고를 참조·원인당 1회만 emit."""
        for w in prompt.warnings:
            wkey = (key, w.code)
            if wkey not in self._warned_transcripts:
                self._warned_transcripts.add(wkey)
                emit("progress", percent=8, message=f"참조 전사 경고 [{w.code}] {w.message}")

    def load(self):
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self._venv_python = os.path.join(base_dir, "externals", "gptsovits_venv", "Scripts", "python.exe")
        self._bridge_script = os.path.join(base_dir, "python", "gptsovits_bridge.py")

        if not os.path.exists(self._venv_python):
            raise RuntimeError("GPT-SoVITS venv가 설치되지 않았습니다. externals/gptsovits_venv를 확인하세요.")

    def _transcript_key(self, ref_audio, model_name):
        """전사 캐시 키: 절대경로 + size + mtime_ns + Whisper 모델명.
        경로가 같아도 파일이 교체(size/mtime 변경)되면 키가 달라져 재전사된다."""
        try:
            st = os.stat(ref_audio)
            return (os.path.abspath(ref_audio), st.st_size, st.st_mtime_ns, model_name)
        except OSError:
            return (os.path.abspath(ref_audio), None, None, model_name)

    def _get_ref_prompt(self, ref_audio, target_language, model_name="small"):
        """참조 음성을 전사하고 GPT-SoVITS용 ReferencePrompt를 만든다(구조화).
        - 전사는 (경로+size+mtime+모델) 캐시로 참조당 1회.
        - 성공: 언어+글자 수만 progress로 표시(전문은 로그에 출력하지 않음).
        - 실패/빈 결과/미지원 언어: ref-free로 강등하되, 같은 참조·같은 원인당 1회만 경고 emit."""
        from reference_transcript import (transcribe_reference, build_gpt_prompt,
                                          build_manual_prompt, build_user_ref_free_prompt,
                                          normalize_language, MODE_TRANSCRIBED, MODE_REF_FREE)
        key = self._transcript_key(ref_audio, model_name)

        # ── 사용자 override(수동 전사/프롬프트 언어/모드) — 자동 전사보다 우선 ──
        ov = self._prompt_overrides.get(os.path.abspath(ref_audio)) if self._prompt_overrides else None
        user_lang = (ov or {}).get("prompt_lang")
        if ov:
            # 우선순위 고정: 명시적 ref_free > 명시적 manual(비어있지 않음) > auto.
            if ov.get("mode") == MODE_REF_FREE:
                # ref-free에서는 manual_text가 남아 있어도 무시하고 참조 없이 합성.
                prompt = build_user_ref_free_prompt(target_language, user_lang)
                self._emit_prompt_warnings(key, prompt)
                return prompt
            manual_text = (ov.get("manual_text") or "").strip()
            if manual_text:
                # 비어있지 않은 수동 전사문 → Whisper 미호출
                prompt = build_manual_prompt(manual_text, user_lang, target_language)
                if key not in self._announced_transcripts:
                    self._announced_transcripts.add(key)
                    emit("progress", percent=9,
                         message=f"참조 전사(수동): {prompt.prompt_language}, {len(manual_text)}자")
                return prompt
            # 빈 수동 입력 + auto → 아래 자동 경로로(빈 수동을 자동 성공으로 오인하지 않음)

        # ── 자동 전사 경로 ──
        if key in self._ref_transcript_cache:
            transcript = self._ref_transcript_cache[key]
        else:
            emit("progress", percent=8, message="참조 음성 전사 중... (클로닝 품질 향상)")
            transcript = transcribe_reference(ref_audio, model_name)
            # 실패/빈 결과도 캐시해 같은 작업에서 반복 모델 호출을 막는다.
            if len(self._ref_transcript_cache) < self._TRANSCRIPT_CACHE_MAX:
                self._ref_transcript_cache[key] = transcript

        prompt = build_gpt_prompt(transcript, target_language)
        # 사용자가 프롬프트 언어를 지정했으면 자동 감지 언어를 덮어씀(전사문은 자동 유지)
        if user_lang and prompt.mode == MODE_TRANSCRIBED:
            nl = normalize_language(user_lang)
            if nl:
                prompt.prompt_language = nl

        if prompt.mode == MODE_TRANSCRIBED:
            if key not in self._announced_transcripts:
                self._announced_transcripts.add(key)
                emit("progress", percent=9,
                     message=f"참조 전사 완료: {prompt.prompt_language}, {len(prompt.prompt_text)}자")
        else:
            self._emit_prompt_warnings(key, prompt)
        return prompt

    def _assess_ref(self, ref_audio):
        """모델/Whisper/브리지 로딩 전에 참조 음성을 판정한다.
        invalid면 구조화된 오류로 즉시 실패 → 2초·20초·무음·손상 파일은 모델을 전혀 로딩하지 않는다.
        같은 참조(size/mtime 동일)는 재판정하지 않고, 경고는 참조당 한 번만 알린다."""
        from reference_audio import assess_reference_file, GPTSOVITS_POLICY
        try:
            st = os.stat(ref_audio)
            key = (os.path.abspath(ref_audio), st.st_size, st.st_mtime_ns)
        except OSError:
            key = (os.path.abspath(ref_audio), None, None)

        if key in self._ref_assess_cache:
            assessment = self._ref_assess_cache[key]
        else:
            assessment = assess_reference_file(ref_audio, GPTSOVITS_POLICY)
            self._ref_assess_cache[key] = assessment

        if not assessment.valid:
            codes = "; ".join(f"[{e.code}] {e.message}" for e in assessment.errors)
            raise RuntimeError(f"참조 음성 부적합(GPT-SoVITS): {codes}")

        if assessment.warnings and key not in self._warned_refs:
            self._warned_refs.add(key)
            for w in assessment.warnings:
                emit("progress", percent=7, message=f"참조 경고 [{w.code}] {w.message}")

    def synthesize_segment(self, text, ref_audio, emotion_id, speed, output_path):
        # 실제 모델/Whisper/브리지 로딩 전에 참조 판정(부적합이면 로딩 없이 실패)
        self._assess_ref(ref_audio)
        self.load()
        import subprocess, json, tempfile

        # 목표 텍스트 언어는 기존 방식(_detect_language)으로 판별.
        target_language = _detect_language(text)
        # 참조 프롬프트는 구조화된 전사 정책으로 결정.
        # 전사 성공 시 Whisper 언어를 그대로 쓰고 _detect_language(ref_text)로 재추정하지 않는다.
        # ref-free일 때만 프롬프트 언어 기본값으로 목표 텍스트 언어를 쓴다.
        prompt = self._get_ref_prompt(ref_audio, target_language)
        config = {
            "ref_audio": ref_audio,
            "text": text,
            "output_path": output_path,
            "language": target_language,
            "speed": speed,
            "prompt_text": prompt.prompt_text,
            "prompt_lang": prompt.prompt_language,
        }

        result = subprocess.run(
            [self._venv_python, "-X", "utf8", "-u", self._bridge_script],
            input=json.dumps(config, ensure_ascii=False),
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=300  # 첫 모델 로딩 + CPU 폴백 대비
        )

        if result.returncode != 0:
            stderr = result.stderr[-500:] if result.stderr else ""
            raise RuntimeError(f"GPT-SoVITS 실패: {stderr}")

        # Parse output for errors
        for line in result.stdout.split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
                if msg.get("type") == "error":
                    raise RuntimeError(msg.get("message", "Unknown error"))
                if msg.get("type") == "progress":
                    emit("progress", percent=msg.get("percent", 0), message=msg.get("message", ""))
            except json.JSONDecodeError:
                pass


# ── Engine registry ──

ENGINES = {
    "f5tts": F5TTSEngine,
    "kokoro": KokoroEngine,
    "gptsovits": GPTSoVITSEngine,
}

# Engine instances are cached so loaded models survive across segments —
# creating a new instance per sentence reloads the model every time.
_engine_cache = {}


def _get_engine(name):
    if name not in _engine_cache:
        _engine_cache[name] = ENGINES[name]()
    return _engine_cache[name]


def _detect_language(text):
    """Simple language detection from text."""
    korean = sum(1 for c in text if '\uac00' <= c <= '\ud7a3')
    japanese = sum(1 for c in text if '\u3040' <= c <= '\u30ff' or '\u31f0' <= c <= '\u31ff')
    chinese = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    total = len(text.replace(' ', ''))
    if total == 0:
        return "en"
    if korean / max(total, 1) > 0.3:
        return "ko"
    if japanese / max(total, 1) > 0.3:
        return "ja"
    if chinese / max(total, 1) > 0.3:
        return "zh"
    return "en"


def _select_engine(text, preferred_engine=None):
    """Select best engine for the given text.
    Priority: user preference > GPT-SoVITS (ko/ja) > Kokoro (ja/zh) > F5-TTS (en)
    """
    if preferred_engine and preferred_engine in ENGINES:
        return _get_engine(preferred_engine)

    lang = _detect_language(text)

    # Korean/Japanese → GPT-SoVITS (best quality), fallback to Kokoro
    if lang in ("ko", "ja"):
        try:
            engine = _get_engine("gptsovits")
            engine.load()  # Check if venv exists
            return engine
        except Exception:
            return _get_engine("kokoro")

    # Chinese → Kokoro
    if lang == "zh":
        return _get_engine("kokoro")

    # English → F5-TTS (voice cloning)
    return _get_engine("f5tts")


# ── Helpers ──

def _parse_line(line):
    match = re.match(r'^\[([^\]]+)\]\s*(.+)', line.strip())
    if match:
        tag = match.group(1).strip()
        text = match.group(2).strip()
        return EMOTION_TAGS.get(tag, "default"), text
    return "default", line.strip()


def _prepare_ref(ref_path):
    """참조 음성을 mono PCM WAV로 준비. 실패를 조용히 원본 반환으로 넘기지 않고 명확히 실패한다.
    정상 WAV는 그대로 사용(기존 흐름 유지)."""
    # 입력 존재 확인
    if not os.path.exists(ref_path):
        raise RuntimeError(f"참조 음성 파일을 찾을 수 없습니다: {ref_path}")
    # 정상 WAV는 변환 없이 사용
    if ref_path.lower().endswith('.wav'):
        return ref_path, None
    # 비 WAV → ffmpeg 필요
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError(f"WAV가 아닌 참조 음성 변환에는 ffmpeg가 필요합니다(미설치): {ref_path}")
    import tempfile, subprocess, shutil
    tmp_dir = tempfile.mkdtemp(prefix="audioforge_tts_")
    tmp_wav = os.path.join(tmp_dir, "ref.wav")
    # 출력은 명시적으로 mono / 24kHz / PCM s16le
    # timeout=120s 근거: PCM WAV 트랜스코딩은 I/O 위주로 실시간보다 훨씬 빠르다(수분짜리도
    # 수초). 참조 음성은 원래 수 초짜리라 정상 파일을 과도 차단하지 않으면서, 멈춘 ffmpeg의
    # 무한 대기만 끊는다.
    try:
        proc = subprocess.run(
            [ffmpeg, "-y", "-i", ref_path, "-ar", "24000", "-ac", "1",
             "-acodec", "pcm_s16le", tmp_wav],
            capture_output=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as e:
        # ffmpeg 실행 자체 실패(경로/권한) 또는 timeout 등 → 임시 폴더 정리 후 명확히 실패
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise RuntimeError(f"참조 음성 변환 중 오류({ref_path}): {e}")
    ok = proc.returncode == 0 and os.path.exists(tmp_wav) and os.path.getsize(tmp_wav) > 0
    if not ok:
        stderr_tail = ""
        try:
            stderr_tail = proc.stderr.decode("utf-8", errors="replace")[-300:]
        except Exception:
            pass
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise RuntimeError(f"참조 음성 변환 실패({ref_path}): {stderr_tail}")
    return tmp_wav, tmp_dir


def _concat_with_silence(segment_paths, output_path, silence_sec=0.5):
    import soundfile as sf
    import numpy as np
    all_audio = []
    target_sr = None
    for path in segment_paths:
        data, sr = sf.read(path, dtype="float32")
        if target_sr is None:
            target_sr = sr
        all_audio.append(data)
        if silence_sec > 0:
            all_audio.append(np.zeros(int(silence_sec * sr), dtype=np.float32))
    if silence_sec > 0 and len(all_audio) > 1:
        all_audio.pop()
    combined = np.concatenate(all_audio)
    sf.write(output_path, combined, target_sr)


# ── Main synthesize function ──

def synthesize(reference_audio, text, output_dir, speed=1.0, silence_gap=0.5,
               emotion_refs=None, preferred_engine=None, reference_prompts=None):
    """Synthesize speech. Auto-selects engine by language.
    reference_prompts: 식별자(default/emotionId) → {manual_text, prompt_lang, mode} 사용자 override."""
    emit("status", message="음성 합성 시작", percent=0)

    if not emotion_refs:
        emotion_refs = {}

    lines = [l.strip() for l in text.strip().split('\n') if l.strip()]
    if not lines:
        emit("error", message="합성할 텍스트가 없습니다.")
        return

    parsed = [_parse_line(l) for l in lines]
    emit("progress", percent=5, message=f"{len(parsed)}개 문장 합성 준비")

    # 참조 준비부터 finally 정리 범위에 포함 — 기본 참조 준비로 임시 폴더가 생긴 뒤
    # 감정 참조 준비가 실패해도, 이미 만든 임시 폴더가 새지 않게 한다.
    tmp_dirs = []
    try:
        ref_wav, tmp_ref_dir = _prepare_ref(reference_audio)
        if tmp_ref_dir:
            tmp_dirs.append(tmp_ref_dir)
        ref_cache = {"default": ref_wav}

        for emo_id, emo_path in emotion_refs.items():
            if emo_path and os.path.exists(emo_path):
                wav, tmp = _prepare_ref(emo_path)
                if tmp:
                    tmp_dirs.append(tmp)
                ref_cache[emo_id] = wav

        # 사용자 프롬프트 override(식별자 기준)를 준비된 참조 '경로' 기준으로 매핑해 GPT 엔진에 전달.
        # 항상 설정(빈 dict 포함)해 이전 작업의 override가 남지 않게 한다.
        overrides_by_path = {}
        for ident, ov in (reference_prompts or {}).items():
            p = ref_cache.get(ident)
            if p and isinstance(ov, dict):
                overrides_by_path[os.path.abspath(p)] = ov
        # override가 있거나 GPT 엔진이 이미 존재할 때만 설정(없으면 굳이 인스턴스화하지 않음).
        # 이미 존재하면 빈 dict로 덮어써 이전 작업의 override 잔재를 해제.
        if overrides_by_path or "gptsovits" in _engine_cache:
            _get_engine("gptsovits").set_prompt_overrides(overrides_by_path)

        segment_paths = []

        for i, (emotion_id, line_text) in enumerate(parsed):
            pct = 25 + int((i / len(parsed)) * 60)
            ref = ref_cache.get(emotion_id, ref_cache["default"])
            emotion_label = next((k for k, v in EMOTION_TAGS.items() if v == emotion_id), emotion_id)

            # Select engine based on text language
            engine = _select_engine(line_text, preferred_engine)
            engine_name = engine.name

            emit("progress", percent=pct, message=f"[{engine_name}] [{emotion_label}] {line_text[:25]}...")

            seg_path = os.path.join(output_dir, f"segment_{i+1:03d}.wav")

            if isinstance(engine, KokoroEngine):
                lang = _detect_language(line_text)
                engine.load(lang)

            engine.synthesize_segment(line_text, ref, emotion_id, speed, seg_path)
            segment_paths.append(seg_path)

        # Concatenate
        emit("progress", percent=88, message="문장 이어붙이기 중...")
        final_path = os.path.join(output_dir, "synthesized.wav")

        if len(segment_paths) == 1:
            os.rename(segment_paths[0], final_path)
        else:
            _concat_with_silence(segment_paths, final_path, silence_gap)
            for p in segment_paths:
                if os.path.exists(p):
                    os.remove(p)

        tracks = [{"name": "synthesized", "label": f"합성 음성 ({len(parsed)}문장)", "path": final_path}]
        emit("progress", percent=99, message="완료!")
        emit("result", tracks=tracks, outputDir=output_dir)

    finally:
        for d in tmp_dirs:
            try:
                import shutil
                shutil.rmtree(d, ignore_errors=True)
            except OSError:
                pass
