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
from audio_utils import emit, get_device, find_ffmpeg

# ── Emotion definitions ──

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
        self._lang = lang_map.get(lang_code, "k")

        if self._pipeline is None or True:  # reload on language change
            emit("progress", percent=10, message=f"Kokoro TTS 로딩 중... (언어: {lang_code})")
            from kokoro import KPipeline
            self._pipeline = KPipeline(lang_code=self._lang)
            emit("progress", percent=20, message="Kokoro 로딩 완료")

    def synthesize_segment(self, text, ref_audio, emotion_id, speed, output_path):
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


# ── Engine registry ──

ENGINES = {
    "f5tts": F5TTSEngine,
    "kokoro": KokoroEngine,
    # future: "gptsovits": GPTSoVITSEngine,
}


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
    """Select best engine for the given text."""
    if preferred_engine and preferred_engine in ENGINES:
        return ENGINES[preferred_engine]()

    lang = _detect_language(text)
    # Korean/Japanese/Chinese → Kokoro, English → F5-TTS
    if lang in ("ko", "ja", "zh"):
        return KokoroEngine()
    return F5TTSEngine()


# ── Helpers ──

def _parse_line(line):
    match = re.match(r'^\[([^\]]+)\]\s*(.+)', line.strip())
    if match:
        tag = match.group(1).strip()
        text = match.group(2).strip()
        return EMOTION_TAGS.get(tag, "default"), text
    return "default", line.strip()


def _prepare_ref(ref_path):
    if ref_path.lower().endswith('.wav'):
        return ref_path, None
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return ref_path, None
    import tempfile, subprocess
    tmp_dir = tempfile.mkdtemp(prefix="audioforge_tts_")
    tmp_wav = os.path.join(tmp_dir, "ref.wav")
    subprocess.run([ffmpeg, "-y", "-i", ref_path, "-ar", "24000", "-ac", "1", tmp_wav], capture_output=True)
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
               emotion_refs=None, preferred_engine=None):
    """Synthesize speech. Auto-selects engine by language."""
    emit("status", message="음성 합성 시작", percent=0)

    if not emotion_refs:
        emotion_refs = {}

    lines = [l.strip() for l in text.strip().split('\n') if l.strip()]
    if not lines:
        emit("error", message="합성할 텍스트가 없습니다.")
        return

    parsed = [_parse_line(l) for l in lines]
    emit("progress", percent=5, message=f"{len(parsed)}개 문장 합성 준비")

    # Prepare reference audio
    ref_wav, tmp_ref_dir = _prepare_ref(reference_audio)
    ref_cache = {"default": ref_wav}
    tmp_dirs = [tmp_ref_dir] if tmp_ref_dir else []

    for emo_id, emo_path in emotion_refs.items():
        if emo_path and os.path.exists(emo_path):
            wav, tmp = _prepare_ref(emo_path)
            if tmp:
                tmp_dirs.append(tmp)
            ref_cache[emo_id] = wav

    try:
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
