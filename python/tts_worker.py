"""F5-TTS voice synthesis worker."""

import os
import re
from audio_utils import emit, get_device, find_ffmpeg

# Model cache
_tts_cache = {"model": None}


def _get_tts_model():
    """Load or reuse cached F5-TTS model."""
    if _tts_cache["model"] is None:
        emit("progress", percent=10, message="F5-TTS 모델 로딩 중... (첫 실행 시 ~1.2GB 다운로드)")
        from f5_tts.api import F5TTS
        device = get_device(timeout_sec=10)
        _tts_cache["model"] = F5TTS(device=device)
        emit("progress", percent=25, message=f"F5-TTS 로딩 완료 (디바이스: {device.upper()})")
    return _tts_cache["model"]


def synthesize(reference_audio, text, output_dir, speed=1.0, silence_gap=0.5):
    """Synthesize speech from text using a reference voice.

    Args:
        reference_audio: Path to reference voice sample (5-30s WAV/MP3)
        text: Text to synthesize (supports multi-line, each line = one segment)
        output_dir: Directory to save output files
        speed: Speech speed multiplier (0.5 ~ 2.0)
        silence_gap: Seconds of silence between segments
    """
    emit("status", message="음성 합성 시작", percent=0)

    tts = _get_tts_model()

    # Split text into segments (by line or by sentence)
    lines = [l.strip() for l in text.strip().split('\n') if l.strip()]
    if not lines:
        emit("error", message="합성할 텍스트가 없습니다.")
        return

    emit("progress", percent=30, message=f"{len(lines)}개 문장 합성 준비")

    # Convert reference audio to WAV if needed
    ref_path = reference_audio
    tmp_ref = None
    if not ref_path.lower().endswith('.wav'):
        ffmpeg = find_ffmpeg()
        if ffmpeg:
            import tempfile
            tmp_dir = tempfile.mkdtemp(prefix="audioforge_tts_")
            tmp_ref = os.path.join(tmp_dir, "ref.wav")
            import subprocess
            subprocess.run([ffmpeg, "-y", "-i", ref_path, "-ar", "24000", "-ac", "1", tmp_ref],
                          capture_output=True)
            ref_path = tmp_ref

    try:
        segment_paths = []

        for i, line in enumerate(lines):
            pct = 30 + int((i / len(lines)) * 55)
            emit("progress", percent=pct, message=f"문장 {i+1}/{len(lines)} 합성 중: {line[:30]}...")

            seg_path = os.path.join(output_dir, f"segment_{i+1:03d}.wav")
            tts.infer(
                ref_file=ref_path,
                ref_text="",       # Auto-transcribe reference
                gen_text=line,
                file_wave=seg_path,
                speed=speed
            )
            segment_paths.append(seg_path)

        # Concatenate segments with silence gaps
        emit("progress", percent=88, message="문장 이어붙이기 중...")
        final_path = os.path.join(output_dir, "synthesized.wav")

        if len(segment_paths) == 1:
            os.rename(segment_paths[0], final_path)
        else:
            _concat_with_silence(segment_paths, final_path, silence_gap)
            # Clean up individual segments
            for p in segment_paths:
                if os.path.exists(p):
                    os.remove(p)

        emit("progress", percent=95, message="합성 완료")

        tracks = [{
            "name": "synthesized",
            "label": f"합성 음성 ({len(lines)}문장)",
            "path": final_path
        }]

        emit("progress", percent=99, message="완료!")
        emit("result", tracks=tracks, outputDir=output_dir)

    finally:
        # Clean up temp reference
        if tmp_ref and os.path.exists(tmp_ref):
            try:
                os.remove(tmp_ref)
                os.rmdir(os.path.dirname(tmp_ref))
            except OSError:
                pass


def _concat_with_silence(segment_paths, output_path, silence_sec=0.5):
    """Concatenate WAV files with silence gaps between them."""
    import soundfile as sf
    import numpy as np

    all_audio = []
    target_sr = None

    for path in segment_paths:
        data, sr = sf.read(path, dtype="float32")
        if target_sr is None:
            target_sr = sr
        all_audio.append(data)

        # Add silence gap
        if silence_sec > 0:
            silence = np.zeros(int(silence_sec * sr), dtype=np.float32)
            all_audio.append(silence)

    # Remove last silence gap
    if silence_sec > 0 and len(all_audio) > 1:
        all_audio.pop()

    combined = np.concatenate(all_audio)
    sf.write(output_path, combined, target_sr)
