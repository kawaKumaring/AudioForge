"""Demucs music source separation + RoFormer 고품질 보컬 분리."""

import os
from audio_utils import emit, load_audio, save_audio, convert_to_wav, get_device

# audio-separator RoFormer 보컬 모델 (SDR 12.97, ComfyUI 환경에 이미 설치됨)
_ROFORMER_MODEL = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"


def run_roformer_separation(input_path: str, output_dir: str):
    """BS-RoFormer로 보컬/반주 2트랙 분리 (Demucs보다 보컬 SDR 우수).
    audio-separator(onnxruntime+torch)는 ComfyUI 환경에 이미 존재 — 별도 설치 불필요."""
    emit("status", message="RoFormer 보컬 분리", percent=0)

    try:
        from audio_separator.separator import Separator
    except ImportError as e:
        emit("error", message=f"audio-separator가 설치되지 않았습니다: {e}")
        return []

    # 모델은 프로젝트 externals에 캐싱 (gitignore, 재다운로드 방지)
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    model_dir = os.path.join(base_dir, "externals", "separator_models")
    os.makedirs(model_dir, exist_ok=True)

    emit("progress", percent=10, message="RoFormer 모델 로딩 중... (첫 실행 시 다운로드)")
    sep = Separator(model_file_dir=model_dir, output_dir=output_dir, output_format="WAV")
    sep.load_model(_ROFORMER_MODEL)

    emit("progress", percent=40, message="보컬/반주 분리 중... (GPU)")
    outputs = sep.separate(input_path)  # output_dir에 파일 저장, 파일명 리스트 반환

    tracks = []
    for fn in outputs:
        full = os.path.join(output_dir, fn)
        if "Vocals" in fn:
            name, label = "vocals", "보컬"
        elif "Instrumental" in fn:
            name, label = "instrumental", "반주"
        else:
            name, label = os.path.splitext(fn)[0], fn
        clean = os.path.join(output_dir, f"{name}.wav")
        if os.path.exists(full) and os.path.abspath(full) != os.path.abspath(clean):
            os.replace(full, clean)
        tracks.append({"name": name, "label": label, "path": clean})

    if not tracks:
        emit("error", message="RoFormer 분리 결과가 없습니다.")
        return []

    emit("progress", percent=90, message="분리 완료")
    return tracks


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

    emit("progress", percent=3, message="GPU 확인 중...")
    device = get_device(timeout_sec=10)
    emit("status", message=f"디바이스: {device.upper()}, 모델: {model}", percent=5)

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
