"""Demucs music source separation."""

import os
from audio_utils import emit, load_audio, save_audio, convert_to_wav


def run_music_separation(input_path: str, output_dir: str, model: str = "htdemucs"):
    """Separate music into stems using Demucs."""
    emit("status", message="Demucs 모델 로딩 중...", percent=0)

    try:
        import torch
        from demucs.pretrained import get_model
        from demucs.apply import apply_model
    except ImportError as e:
        emit("error", message=f"필요한 패키지가 설치되지 않았습니다: {e}")
        return []

    device = "cuda" if torch.cuda.is_available() else "cpu"
    emit("status", message=f"디바이스: {device}, 모델: {model}", percent=5)

    separator = get_model(model)
    separator.to(device)
    emit("progress", percent=15, message="모델 로딩 완료")

    emit("progress", percent=18, message="오디오 변환 중...")
    wav_path = convert_to_wav(input_path)

    try:
        emit("progress", percent=20, message="오디오 파일 로딩 중...")
        wav, sr = load_audio(wav_path)

        if sr != separator.samplerate:
            emit("progress", percent=22, message="리샘플링 중...")
            import torchaudio
            wav = torchaudio.transforms.Resample(sr, separator.samplerate)(wav)
            sr = separator.samplerate

        if wav.shape[0] == 1:
            wav = wav.repeat(2, 1)

        wav = wav.unsqueeze(0).to(device)
        emit("progress", percent=30, message="분리 처리 중... (시간이 걸릴 수 있습니다)")

        with torch.no_grad():
            sources = apply_model(separator, wav, progress=False, device=device)

        sources = sources.squeeze(0).cpu()
        source_names = separator.sources

        labels = {"vocals": "보컬", "drums": "드럼", "bass": "베이스", "other": "기타 악기"}

        tracks = []
        for i, name in enumerate(source_names):
            percent = 70 + int((i / len(source_names)) * 25)
            emit("progress", percent=percent, message=f"{labels.get(name, name)} 저장 중...")
            out_path = os.path.join(output_dir, f"{name}.wav")
            save_audio(out_path, sources[i], sr)
            tracks.append({"name": name, "label": labels.get(name, name), "path": out_path})

        emit("progress", percent=90, message="분리 완료")
        return tracks

    finally:
        try:
            os.remove(wav_path)
            os.rmdir(os.path.dirname(wav_path))
        except OSError:
            pass
