"""F5-TTS voice synthesis worker with emotion support."""

import os
import re
from audio_utils import emit, get_device, find_ffmpeg

_tts_cache = {"model": None}

# Emotion tag → reference audio mapping
EMOTION_TAGS = {
    "기본": "default", "기쁨": "happy", "슬픔": "sad", "화남": "angry",
    "놀람": "surprise", "속삭임": "whisper", "진지": "serious", "명랑": "cheerful",
    # English aliases
    "happy": "happy", "sad": "sad", "angry": "angry", "surprise": "surprise",
    "whisper": "whisper", "serious": "serious", "cheerful": "cheerful",
}


def _get_tts_model():
    if _tts_cache["model"] is None:
        emit("progress", percent=10, message="F5-TTS 모델 로딩 중... (첫 실행 시 ~1.2GB 다운로드)")
        from f5_tts.api import F5TTS
        device = get_device(timeout_sec=10)
        emit("progress", percent=15, message=f"F5-TTS 초기화 중... (디바이스: {device.upper()})")
        _tts_cache["model"] = F5TTS(device=device)
        emit("progress", percent=25, message="F5-TTS 로딩 완료")
    return _tts_cache["model"]


def _parse_line(line):
    """Parse emotion tag from line. Returns (emotion_id, text).
    Examples:
      '[기쁨] 안녕하세요' → ('happy', '안녕하세요')
      '그냥 텍스트' → ('default', '그냥 텍스트')
    """
    match = re.match(r'^\[([^\]]+)\]\s*(.+)', line.strip())
    if match:
        tag = match.group(1).strip()
        text = match.group(2).strip()
        emotion_id = EMOTION_TAGS.get(tag, "default")
        return emotion_id, text
    return "default", line.strip()


def _prepare_ref(ref_path):
    """Convert reference audio to WAV if needed."""
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


def synthesize(reference_audio, text, output_dir, speed=1.0, silence_gap=0.5, emotion_refs=None):
    """Synthesize speech with emotion support.

    Args:
        reference_audio: Default reference voice (used for [기본] or untagged lines)
        text: Multi-line text, each line optionally prefixed with [감정] tag
        output_dir: Output directory
        speed: Speech speed (0.5 ~ 2.0)
        silence_gap: Seconds between segments
        emotion_refs: Dict of emotion_id → audio_path (e.g. {"happy": "path/to/happy.wav"})
    """
    emit("status", message="음성 합성 시작", percent=0)

    if not emotion_refs:
        emotion_refs = {}

    tts = _get_tts_model()

    # Parse lines with emotion tags
    lines = [l.strip() for l in text.strip().split('\n') if l.strip()]
    if not lines:
        emit("error", message="합성할 텍스트가 없습니다.")
        return

    parsed = [_parse_line(l) for l in lines]
    emit("progress", percent=30, message=f"{len(parsed)}개 문장 합성 준비")

    # Prepare reference audios (convert to WAV if needed)
    ref_cache = {}
    tmp_dirs = []

    # Default reference
    default_wav, tmp = _prepare_ref(reference_audio)
    if tmp:
        tmp_dirs.append(tmp)
    ref_cache["default"] = default_wav

    # Emotion-specific references
    for emo_id, emo_path in emotion_refs.items():
        if emo_path and os.path.exists(emo_path):
            wav, tmp = _prepare_ref(emo_path)
            if tmp:
                tmp_dirs.append(tmp)
            ref_cache[emo_id] = wav

    try:
        segment_paths = []

        for i, (emotion_id, line_text) in enumerate(parsed):
            pct = 30 + int((i / len(parsed)) * 55)

            # Select reference audio for this emotion
            ref = ref_cache.get(emotion_id, ref_cache["default"])
            emotion_label = next((k for k, v in EMOTION_TAGS.items() if v == emotion_id), emotion_id)

            emit("progress", percent=pct, message=f"[{emotion_label}] {line_text[:30]}...")

            seg_path = os.path.join(output_dir, f"segment_{i+1:03d}.wav")
            tts.infer(
                ref_file=ref,
                ref_text="",
                gen_text=line_text,
                file_wave=seg_path,
                speed=speed
            )
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

        emit("progress", percent=95, message="합성 완료")

        tracks = [{
            "name": "synthesized",
            "label": f"합성 음성 ({len(parsed)}문장)",
            "path": final_path
        }]

        emit("progress", percent=99, message="완료!")
        emit("result", tracks=tracks, outputDir=output_dir)

    finally:
        for d in tmp_dirs:
            try:
                import shutil
                shutil.rmtree(d, ignore_errors=True)
            except OSError:
                pass


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
