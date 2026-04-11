"""Audio I/O utilities, ffmpeg integration, silence trimming."""

import os
import json
import shutil
import subprocess
import tempfile


def emit(msg_type: str, **kwargs):
    """Send a JSON message to Electron via stdout."""
    print(json.dumps({"type": msg_type, **kwargs}, ensure_ascii=False), flush=True)


def load_audio(path):
    """Load audio with soundfile backend."""
    import soundfile as sf
    import torch
    data, sr = sf.read(path, dtype="float32")
    tensor = torch.from_numpy(data).T
    if tensor.dim() == 1:
        tensor = tensor.unsqueeze(0)
    return tensor, sr


def save_audio(path, tensor, sr):
    """Save audio with soundfile backend."""
    import soundfile as sf
    data = tensor.T.numpy()
    sf.write(path, data, sr)


def find_ffmpeg():
    """Find ffmpeg executable."""
    local = os.environ.get("LOCALAPPDATA", "")
    if local:
        winget_base = os.path.join(local, "Microsoft", "WinGet", "Packages")
        if os.path.isdir(winget_base):
            for entry in os.listdir(winget_base):
                if "FFmpeg" in entry:
                    for root, dirs, files in os.walk(os.path.join(winget_base, entry)):
                        if "ffmpeg.exe" in files:
                            return os.path.join(root, "ffmpeg.exe")
    path_ffmpeg = shutil.which("ffmpeg")
    if path_ffmpeg:
        return path_ffmpeg
    return None


def convert_to_wav(input_path: str) -> str:
    """Convert any audio file to WAV PCM using ffmpeg."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("ffmpeg을 찾을 수 없습니다.")

    tmp_dir = tempfile.mkdtemp(prefix="audioforge_")
    ext = os.path.splitext(input_path)[1]
    tmp_input = os.path.join(tmp_dir, f"input{ext}")
    wav_path = os.path.join(tmp_dir, "input.wav")

    shutil.copy2(input_path, tmp_input)

    cmd = [ffmpeg, "-y", "-i", tmp_input, "-acodec", "pcm_f32le", wav_path]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        stderr_text = result.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"ffmpeg 변환 실패: {stderr_text[-500:]}")

    try:
        os.remove(tmp_input)
    except OSError:
        pass

    return wav_path


def trim_silence(wav_tensor, sr, silence_gap_sec=0.0, threshold_db=-40):
    """Remove silence, insert specified gap between speech segments."""
    import torch
    import numpy as np

    mono = wav_tensor.mean(dim=0).numpy() if wav_tensor.shape[0] > 1 else wav_tensor.squeeze().numpy()

    frame_len = int(0.02 * sr)
    hop = frame_len // 2
    n_frames = max(1, (len(mono) - frame_len) // hop + 1)
    threshold = 10 ** (threshold_db / 20)

    is_speech = np.array([
        np.sqrt(np.mean(mono[i * hop:i * hop + frame_len] ** 2)) > threshold
        for i in range(n_frames)
    ])

    min_silence_frames = int(100 / 20)
    i = 0
    while i < len(is_speech):
        if not is_speech[i]:
            j = i
            while j < len(is_speech) and not is_speech[j]:
                j += 1
            if (j - i) < min_silence_frames:
                is_speech[i:j] = True
            i = j
        else:
            i += 1

    segments = []
    in_seg = False
    seg_start = 0
    for i in range(len(is_speech)):
        if is_speech[i] and not in_seg:
            seg_start = i
            in_seg = True
        elif not is_speech[i] and in_seg:
            segments.append((seg_start * hop, i * hop + frame_len))
            in_seg = False
    if in_seg:
        segments.append((seg_start * hop, len(mono)))

    if not segments:
        return wav_tensor

    fade_len = int(0.015 * sr)
    gap_samples = int(silence_gap_sec * sr)
    silence_gap = torch.zeros(wav_tensor.shape[0], gap_samples) if gap_samples > 0 else None

    pieces = []
    for idx, (s, e) in enumerate(segments):
        e = min(e, wav_tensor.shape[1])
        chunk = wav_tensor[:, s:e].clone()
        chunk_len = chunk.shape[1]
        if chunk_len > fade_len * 2:
            fade_in = torch.linspace(0, 1, fade_len).unsqueeze(0)
            fade_out = torch.linspace(1, 0, fade_len).unsqueeze(0)
            chunk[:, :fade_len] *= fade_in
            chunk[:, -fade_len:] *= fade_out
        pieces.append(chunk)
        if silence_gap is not None and idx < len(segments) - 1:
            pieces.append(silence_gap)

    return torch.cat(pieces, dim=1)


def fmt_time(seconds):
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f"{m}:{s:02d}"


def fmt_srt_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
