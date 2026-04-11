#!/usr/bin/env python3
"""AudioForge - Audio source separation entry point.

Modes:
  music        - Separate vocals/drums/bass/other using Demucs
  conversation - Separate speakers using pyannote speaker diarization

Communication with Electron is via JSON lines on stdout:
  {"type": "status",   "message": "...", "percent": 0}
  {"type": "progress", "percent": 50,    "message": "..."}
  {"type": "result",   "tracks": [{"name": "vocals", "label": "...", "path": "..."}]}
  {"type": "error",    "message": "..."}
"""

import argparse
import json
import sys
import os
import subprocess
import tempfile
import shutil


def load_audio(path):
    """Load audio with soundfile backend (avoids torchcodec dependency)."""
    import soundfile as sf
    import torch
    data, sr = sf.read(path, dtype="float32")
    # soundfile returns (samples, channels), torch expects (channels, samples)
    tensor = torch.from_numpy(data).T
    if tensor.dim() == 1:
        tensor = tensor.unsqueeze(0)
    return tensor, sr


def save_audio(path, tensor, sr):
    """Save audio with soundfile backend."""
    import soundfile as sf
    # tensor is (channels, samples), soundfile expects (samples, channels)
    data = tensor.T.numpy()
    sf.write(path, data, sr)


def emit(msg_type: str, **kwargs):
    """Send a JSON message to Electron via stdout."""
    print(json.dumps({"type": msg_type, **kwargs}, ensure_ascii=False), flush=True)


def find_ffmpeg():
    """Find ffmpeg executable."""
    # Try winget install location first (most reliable on this system)
    local = os.environ.get("LOCALAPPDATA", "")
    if local:
        winget_base = os.path.join(local, "Microsoft", "WinGet", "Packages")
        if os.path.isdir(winget_base):
            for entry in os.listdir(winget_base):
                if "FFmpeg" in entry:
                    # Search for ffmpeg.exe inside this package
                    for root, dirs, files in os.walk(os.path.join(winget_base, entry)):
                        if "ffmpeg.exe" in files:
                            return os.path.join(root, "ffmpeg.exe")
    # Try system PATH
    path_ffmpeg = shutil.which("ffmpeg")
    if path_ffmpeg:
        return path_ffmpeg
    return None


def convert_to_wav(input_path: str) -> str:
    """Convert any audio file to WAV using ffmpeg for reliable loading."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("ffmpeg을 찾을 수 없습니다. ffmpeg을 설치해주세요.")

    # Create temp dir with ASCII-safe paths (avoids encoding issues on Windows)
    tmp_dir = tempfile.mkdtemp(prefix="audioforge_")
    ext = os.path.splitext(input_path)[1]
    tmp_input = os.path.join(tmp_dir, f"input{ext}")
    wav_path = os.path.join(tmp_dir, "input.wav")

    # Copy input to temp (handles Unicode paths via Python's native fs API)
    shutil.copy2(input_path, tmp_input)

    # Preserve original sample rate and channels — only convert container to WAV PCM
    cmd = [ffmpeg, "-y", "-i", tmp_input, "-acodec", "pcm_f32le", wav_path]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        stderr_text = result.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"ffmpeg 변환 실패: {stderr_text[-500:]}")

    # Remove temp input copy
    try:
        os.remove(tmp_input)
    except OSError:
        pass

    return wav_path


def run_music_separation(input_path: str, output_dir: str, model: str = "htdemucs"):
    """Separate music into stems using Demucs."""
    emit("status", message="Demucs 모델 로딩 중...", percent=0)

    try:
        import torch
        from demucs.pretrained import get_model
        from demucs.apply import apply_model
    except ImportError as e:
        emit("error", message=f"필요한 패키지가 설치되지 않았습니다: {e}")
        return

    device = "cuda" if torch.cuda.is_available() else "cpu"
    emit("status", message=f"디바이스: {device}, 모델: {model}", percent=5)

    # Load model
    separator = get_model(model)
    separator.to(device)
    emit("progress", percent=15, message="모델 로딩 완료")

    # Convert to WAV first (handles m4a, mp3, etc.)
    emit("progress", percent=18, message="오디오 변환 중...")
    wav_path = convert_to_wav(input_path)

    try:
        emit("progress", percent=20, message="오디오 파일 로딩 중...")
        wav, sr = load_audio(wav_path)

        # Resample if needed
        if sr != separator.samplerate:
            emit("progress", percent=22, message="리샘플링 중...")
            import torchaudio
            wav = torchaudio.transforms.Resample(sr, separator.samplerate)(wav)
            sr = separator.samplerate

        # Ensure stereo
        if wav.shape[0] == 1:
            wav = wav.repeat(2, 1)

        wav = wav.unsqueeze(0).to(device)  # (1, channels, samples)
        emit("progress", percent=30, message="분리 처리 중... (시간이 걸릴 수 있습니다)")

        # Apply model
        with torch.no_grad():
            sources = apply_model(separator, wav, progress=False, device=device)

        # sources shape: (1, n_sources, channels, samples)
        sources = sources.squeeze(0).cpu()
        source_names = separator.sources  # e.g., ['drums', 'bass', 'other', 'vocals']

        labels = {
            "vocals": "보컬",
            "drums": "드럼",
            "bass": "베이스",
            "other": "기타 악기",
        }

        tracks = []
        for i, name in enumerate(source_names):
            percent = 70 + int((i / len(source_names)) * 25)
            emit("progress", percent=percent, message=f"{labels.get(name, name)} 저장 중...")

            out_path = os.path.join(output_dir, f"{name}.wav")
            save_audio(out_path, sources[i], sr)
            tracks.append({
                "name": name,
                "label": labels.get(name, name),
                "path": out_path,
            })

        emit("progress", percent=90, message="분리 완료")
        return tracks

    finally:
        try:
            os.remove(wav_path)
            os.rmdir(os.path.dirname(wav_path))
        except OSError:
            pass
    return []


def run_conversation_separation(input_path: str, output_dir: str):
    """High-quality speaker separation using:
      1. Silero VAD (neural network) for precise speech detection
      2. Sliding window (1.5s, 0.75s hop) with ECAPA-TDNN embeddings
      3. Per-frame speaker probability map from overlapping windows
      4. Temporal smoothing (min 500ms per speaker turn)
      5. Soft crossfade reconstruction
    """
    emit("status", message="AI 화자 분리 준비 중...", percent=0)

    try:
        import torch
        import numpy as np
    except ImportError as e:
        emit("error", message=f"필요한 패키지가 설치되지 않았습니다: {e}")
        return

    device = "cuda" if torch.cuda.is_available() else "cpu"

    # ── Convert to WAV ──
    emit("progress", percent=2, message="오디오 변환 중...")
    wav_path = convert_to_wav(input_path)

    try:
        wav_full, sr_full = load_audio(wav_path)
        if wav_full.shape[0] > 1:
            wav_full = wav_full.mean(dim=0, keepdim=True)

        # Resample to 16kHz for speech models
        emit("progress", percent=4, message="리샘플링 중...")
        SR = 16000
        import torchaudio
        wav_16k = torchaudio.transforms.Resample(sr_full, SR)(wav_full).squeeze(0)  # tensor (samples,)
        wav_16k_np = wav_16k.numpy()
        total_dur = len(wav_16k_np) / SR

        # ── Step 1: Silero VAD ──
        emit("progress", percent=6, message="Silero VAD 음성 검출 중...")
        vad_model, vad_utils = torch.hub.load(
            repo_or_dir='snakers4/silero-vad', model='silero_vad',
            trust_repo=True, onnx=False
        )
        get_speech_ts = vad_utils[0]  # get_speech_timestamps

        speech_timestamps = get_speech_ts(
            wav_16k, vad_model,
            sampling_rate=SR,
            threshold=0.4,
            min_speech_duration_ms=250,
            min_silence_duration_ms=100,
            speech_pad_ms=30
        )

        if len(speech_timestamps) < 2:
            emit("error", message="발화 구간이 너무 적습니다.")
            return

        # Build speech mask at 16kHz sample level
        n_16k = len(wav_16k_np)
        speech_mask = np.zeros(n_16k, dtype=bool)
        for ts in speech_timestamps:
            speech_mask[ts['start']:ts['end']] = True

        emit("progress", percent=12, message=f"Silero VAD: {len(speech_timestamps)}개 발화 구간")

        # ── Step 2: Load ECAPA-TDNN ──
        emit("progress", percent=14, message="ECAPA-TDNN 모델 로딩 중...")

        _orig_symlink = getattr(os, "symlink", None)
        def _copy_instead(src, dst, *a, **kw):
            if os.path.isdir(src):
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(src, dst)
        os.symlink = _copy_instead

        try:
            from speechbrain.inference.speaker import EncoderClassifier
            encoder = EncoderClassifier.from_hparams(
                source="speechbrain/spkrec-ecapa-voxceleb",
                savedir=os.path.join(os.path.expanduser("~"), ".cache", "speechbrain", "ecapa"),
                run_opts={"device": device}
            )
        finally:
            if _orig_symlink:
                os.symlink = _orig_symlink

        # ── Step 3: Sliding window embedding extraction ──
        WIN_SEC = 1.5    # window size in seconds
        HOP_SEC = 0.5    # hop size (overlap = WIN - HOP = 1.0s)
        MIN_SPEECH_RATIO = 0.3  # minimum speech ratio in window to extract embedding

        win_samples = int(WIN_SEC * SR)
        hop_samples = int(HOP_SEC * SR)

        n_windows = max(1, (n_16k - win_samples) // hop_samples + 1)
        emit("progress", percent=18, message=f"슬라이딩 윈도우 분석: {n_windows}개 윈도우")

        window_embeddings = []  # list of (center_time, embedding_or_None)

        for w in range(n_windows):
            if w % 20 == 0:
                pct = 18 + int((w / n_windows) * 35)
                emit("progress", percent=pct, message=f"임베딩 추출 중... ({w+1}/{n_windows})")

            start = w * hop_samples
            end = min(start + win_samples, n_16k)
            center_time = (start + end) / 2 / SR

            # Check speech ratio in this window
            speech_ratio = speech_mask[start:end].mean()
            if speech_ratio < MIN_SPEECH_RATIO:
                window_embeddings.append((center_time, None))
                continue

            # Extract only the speech parts for cleaner embedding
            chunk = wav_16k_np[start:end].copy()
            # Zero out non-speech parts
            chunk_mask = speech_mask[start:end]
            chunk[~chunk_mask] = 0.0

            chunk_tensor = torch.from_numpy(chunk).unsqueeze(0).float().to(device)
            with torch.no_grad():
                emb = encoder.encode_batch(chunk_tensor)
            window_embeddings.append((center_time, emb.squeeze().cpu().numpy()))

        valid_windows = [(t, e) for t, e in window_embeddings if e is not None]
        if len(valid_windows) < 2:
            emit("error", message="유효한 음성 윈도우가 부족합니다.")
            return

        # ── Step 4: Spectral clustering ──
        emit("progress", percent=55, message="스펙트럴 클러스터링 중...")
        valid_times = np.array([t for t, _ in valid_windows])
        valid_embs = np.array([e for _, e in valid_windows])

        # Normalize
        norms = np.linalg.norm(valid_embs, axis=1, keepdims=True)
        valid_embs_normed = valid_embs / np.maximum(norms, 1e-8)

        # Cosine similarity → affinity
        sim = valid_embs_normed @ valid_embs_normed.T
        affinity = (sim + 1) / 2

        # Gaussian kernel refinement: boost nearby windows, suppress distant ones
        time_diff = np.abs(valid_times[:, None] - valid_times[None, :])
        temporal_weight = np.exp(-time_diff ** 2 / (2 * 5.0 ** 2))  # sigma=5s
        affinity = affinity * 0.8 + affinity * temporal_weight * 0.2

        # Normalized Laplacian
        degree = np.diag(affinity.sum(axis=1))
        d_inv_sqrt = np.diag(1.0 / np.sqrt(np.maximum(np.diag(degree), 1e-8)))
        L_norm = d_inv_sqrt @ (degree - affinity) @ d_inv_sqrt

        eigenvalues, eigenvectors = np.linalg.eigh(L_norm)
        features = eigenvectors[:, :2]
        row_norms = np.linalg.norm(features, axis=1, keepdims=True)
        features = features / np.maximum(row_norms, 1e-8)

        # K-means with multiple restarts for stability
        best_labels = None
        best_inertia = float('inf')
        for _ in range(10):
            labels, inertia = _kmeans(features, 2)
            if inertia < best_inertia:
                best_inertia = inertia
                best_labels = labels.copy()

        # ── Step 5: Build per-frame speaker probability map ──
        emit("progress", percent=62, message="프레임별 화자 확률 맵 생성 중...")

        # Work at 100Hz resolution (10ms frames) for the probability map
        PROB_SR = 100
        n_prob_frames = int(total_dur * PROB_SR) + 1
        speaker_scores = np.zeros((n_prob_frames, 2), dtype=np.float64)
        speaker_weights = np.zeros(n_prob_frames, dtype=np.float64)

        for idx, (center_time, emb) in enumerate(window_embeddings):
            if emb is None:
                continue
            # Find this window's label
            vi = None
            for j, (vt, _) in enumerate(valid_windows):
                if abs(vt - center_time) < 0.01:
                    vi = j
                    break
            if vi is None:
                continue

            spk = best_labels[vi]

            # Compute confidence: cosine similarity to cluster centroid
            centroid_0 = valid_embs_normed[best_labels == 0].mean(axis=0)
            centroid_1 = valid_embs_normed[best_labels == 1].mean(axis=0)
            emb_n = emb / max(np.linalg.norm(emb), 1e-8)
            conf_0 = np.dot(emb_n, centroid_0)
            conf_1 = np.dot(emb_n, centroid_1)

            # Soft assignment based on similarity
            total_conf = max(abs(conf_0) + abs(conf_1), 1e-8)
            prob_0 = max(0, conf_0) / total_conf
            prob_1 = max(0, conf_1) / total_conf

            # Apply to probability map with Gaussian window
            win_start_f = int((center_time - WIN_SEC / 2) * PROB_SR)
            win_end_f = int((center_time + WIN_SEC / 2) * PROB_SR)
            win_start_f = max(0, win_start_f)
            win_end_f = min(n_prob_frames, win_end_f)

            for f in range(win_start_f, win_end_f):
                t = f / PROB_SR
                # Gaussian weight centered at window center
                w = np.exp(-((t - center_time) ** 2) / (2 * (WIN_SEC / 4) ** 2))
                speaker_scores[f, 0] += prob_0 * w
                speaker_scores[f, 1] += prob_1 * w
                speaker_weights[f] += w

        # Normalize scores
        mask = speaker_weights > 0
        speaker_scores[mask] /= speaker_weights[mask, None]

        # ── Step 6: Temporal smoothing ──
        emit("progress", percent=70, message="시간 스무딩 적용 중...")

        # Determine speaker per frame
        frame_labels = np.argmax(speaker_scores, axis=1)

        # Apply speech mask at prob resolution
        prob_speech_mask = np.zeros(n_prob_frames, dtype=bool)
        for ts in speech_timestamps:
            fs = int(ts['start'] / SR * PROB_SR)
            fe = int(ts['end'] / SR * PROB_SR)
            prob_speech_mask[fs:fe] = True
        frame_labels[~prob_speech_mask] = -1  # silence

        # Median filter to remove rapid switches (window = 500ms = 50 frames)
        median_win = 50
        smoothed = frame_labels.copy()
        for i in range(n_prob_frames):
            if not prob_speech_mask[i]:
                continue
            start_w = max(0, i - median_win // 2)
            end_w = min(n_prob_frames, i + median_win // 2)
            window = frame_labels[start_w:end_w]
            speech_window = window[window >= 0]
            if len(speech_window) > 0:
                counts = np.bincount(speech_window, minlength=2)
                smoothed[i] = np.argmax(counts)

        # Remove speaker turns shorter than 500ms
        MIN_TURN_FRAMES = int(0.5 * PROB_SR)
        i = 0
        while i < n_prob_frames:
            if smoothed[i] < 0:
                i += 1
                continue
            j = i
            while j < n_prob_frames and smoothed[j] == smoothed[i]:
                j += 1
            if (j - i) < MIN_TURN_FRAMES:
                # Too short, merge with surrounding
                prev_spk = smoothed[i - 1] if i > 0 else -1
                next_spk = smoothed[j] if j < n_prob_frames else -1
                merge_to = prev_spk if prev_spk >= 0 else next_spk
                if merge_to >= 0:
                    smoothed[i:j] = merge_to
            i = j

        # ── Step 7: Reconstruct per-speaker audio ──
        emit("progress", percent=80, message="화자별 오디오 재구성 중...")

        n_samples = wav_full.shape[1]
        speaker_wavs = [torch.zeros(1, n_samples), torch.zeros(1, n_samples)]

        fade_samples = int(0.015 * sr_full)  # 15ms crossfade

        for f in range(n_prob_frames):
            spk = smoothed[f]
            if spk < 0:
                continue

            # Map prob frame to full-resolution samples
            s = int(f / PROB_SR * sr_full)
            e = int((f + 1) / PROB_SR * sr_full)
            e = min(e, n_samples)
            if s >= n_samples:
                break

            speaker_wavs[spk][:, s:e] = wav_full[:, s:e]

        # Apply crossfade at speaker transitions
        for spk in range(2):
            wav_np = speaker_wavs[spk].squeeze().numpy()
            # Find transition points (silence → speech and speech → silence)
            is_active = np.abs(wav_np) > 1e-8
            transitions = np.diff(is_active.astype(int))

            # Fade in at onset
            onsets = np.where(transitions == 1)[0]
            for onset in onsets:
                start = max(0, onset)
                end = min(len(wav_np), onset + fade_samples)
                fade = np.linspace(0, 1, end - start)
                wav_np[start:end] *= fade

            # Fade out at offset
            offsets = np.where(transitions == -1)[0]
            for offset in offsets:
                start = max(0, offset - fade_samples)
                end = min(len(wav_np), offset)
                fade = np.linspace(1, 0, end - start)
                wav_np[start:end] *= fade

            speaker_wavs[spk] = torch.from_numpy(wav_np).unsqueeze(0)

        # ── Step 8: Order by first appearance ──
        first_app = [n_samples, n_samples]
        for f in range(n_prob_frames):
            spk = smoothed[f]
            if spk >= 0:
                s = int(f / PROB_SR * sr_full)
                if s < first_app[spk]:
                    first_app[spk] = s
        order = [0, 1] if first_app[0] <= first_app[1] else [1, 0]

        emit("progress", percent=92, message="파일 저장 중...")

        tracks = []
        for idx, spk_idx in enumerate(order):
            label = f"화자 {chr(65 + idx)}"
            name = f"speaker_{chr(65 + idx).lower()}"
            out_path = os.path.join(output_dir, f"{name}.wav")
            save_audio(out_path, speaker_wavs[spk_idx], sr_full)
            tracks.append({"name": name, "label": label, "path": out_path})

        emit("progress", percent=90, message="분리 완료")
        return tracks

    finally:
        try:
            os.remove(wav_path)
            os.rmdir(os.path.dirname(wav_path))
        except OSError:
            pass
    return []


def _kmeans(data, k, max_iter=100):
    """K-means with inertia tracking. Returns (labels, inertia)."""
    import numpy as np
    n = data.shape[0]
    # k-means++ init
    centers = [data[np.random.randint(n)]]
    for _ in range(1, k):
        dists = np.min([np.sum((data - c) ** 2, axis=1) for c in centers], axis=0)
        probs = dists / max(dists.sum(), 1e-12)
        centers.append(data[np.random.choice(n, p=probs)])
    centers = np.array(centers)

    labels = np.zeros(n, dtype=int)
    for _ in range(max_iter):
        dists = np.array([np.sum((data - c) ** 2, axis=1) for c in centers])
        new_labels = np.argmin(dists, axis=0)
        if np.all(new_labels == labels):
            break
        labels = new_labels
        for j in range(k):
            m = labels == j
            if m.sum() > 0:
                centers[j] = data[m].mean(axis=0)

    inertia = sum(np.sum((data[labels == j] - centers[j]) ** 2) for j in range(k))
    return labels, inertia


def trim_silence(wav_tensor, sr, silence_gap_sec=0.0, threshold_db=-40):
    """Remove silence from audio, insert specified gap between speech segments.

    Args:
        wav_tensor: (1, samples) or (channels, samples) torch tensor
        sr: sample rate
        silence_gap_sec: seconds of silence to insert between speech segments (0 = no gap)
        threshold_db: silence threshold in dB

    Returns:
        trimmed tensor with same shape
    """
    import torch
    import numpy as np

    mono = wav_tensor.mean(dim=0).numpy() if wav_tensor.shape[0] > 1 else wav_tensor.squeeze().numpy()

    # Compute energy in small frames
    frame_len = int(0.02 * sr)  # 20ms frames
    hop = frame_len // 2
    n_frames = max(1, (len(mono) - frame_len) // hop + 1)

    threshold = 10 ** (threshold_db / 20)

    is_speech = np.array([
        np.sqrt(np.mean(mono[i * hop:i * hop + frame_len] ** 2)) > threshold
        for i in range(n_frames)
    ])

    # Fill very short silence gaps (< 100ms) to avoid chopping words
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

    # Collect speech segments
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

    # Build output: speech segments with configurable silence gap between them
    fade_len = int(0.015 * sr)  # 15ms crossfade
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
        # Insert silence gap between segments (not after last)
        if silence_gap is not None and idx < len(segments) - 1:
            pieces.append(silence_gap)

    return torch.cat(pieces, dim=1)


def _fmt_time(seconds):
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f"{m}:{s:02d}"


def _fmt_srt_time(seconds):
    """Format seconds as SRT timestamp: HH:MM:SS,mmm"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


# Whisper language code → NLLB-200 language code mapping
LANG_TO_NLLB = {
    "ja": "jpn_Jpan", "en": "eng_Latn", "zh": "zho_Hans", "ko": "kor_Hang",
    "fr": "fra_Latn", "de": "deu_Latn", "es": "spa_Latn", "it": "ita_Latn",
    "pt": "por_Latn", "ru": "rus_Cyrl", "ar": "arb_Arab", "th": "tha_Thai",
    "vi": "vie_Latn", "id": "ind_Latn", "tr": "tur_Latn", "nl": "nld_Latn",
    "pl": "pol_Latn", "sv": "swe_Latn", "da": "dan_Latn", "fi": "fin_Latn",
    "cs": "ces_Latn", "ro": "ron_Latn", "hu": "hun_Latn", "el": "ell_Grek",
    "hi": "hin_Deva", "bn": "ben_Beng", "ta": "tam_Taml", "uk": "ukr_Cyrl",
}


def translate_to_korean(text: str, src_lang: str):
    """Translate text to Korean using NLLB-200."""
    if src_lang == "ko":
        return text  # already Korean

    nllb_src = LANG_TO_NLLB.get(src_lang)
    if not nllb_src:
        return None  # unsupported language

    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    model_name = "facebook/nllb-200-distilled-600M"
    tokenizer = AutoTokenizer.from_pretrained(model_name, src_lang=nllb_src)
    model = AutoModelForSeq2SeqLM.from_pretrained(model_name)

    # Translate in chunks (max ~200 chars each to avoid truncation)
    sentences = [s.strip() for s in text.replace('\n', '. ').split('. ') if s.strip()]
    translated_parts = []
    kor_id = tokenizer.convert_tokens_to_ids("kor_Hang")

    for sent in sentences:
        inputs = tokenizer(sent, return_tensors="pt", truncation=True, max_length=512)
        output = model.generate(**inputs, forced_bos_token_id=kor_id, max_length=512)
        translated_parts.append(tokenizer.batch_decode(output, skip_special_tokens=True)[0])

    return " ".join(translated_parts)


def main():
    parser = argparse.ArgumentParser(description="AudioForge separator")
    parser.add_argument("--mode", choices=["music", "conversation", "transcribe", "split"], required=True)
    parser.add_argument("--input", required=True, help="Input audio file path")
    parser.add_argument("--output", required=True, help="Output directory")
    parser.add_argument("--model", default="htdemucs", help="Demucs model name")
    parser.add_argument("--trim-silence", action="store_true", help="Remove silence gaps")
    parser.add_argument("--silence-gap", type=float, default=0.0, help="Silence gap to keep between segments (seconds)")
    parser.add_argument("--transcribe", action="store_true", help="Auto-transcribe with Whisper")
    parser.add_argument("--output-format", default="wav", choices=["wav", "mp3", "flac"], help="Output audio format")
    parser.add_argument("--whisper-model", default="large-v3", help="Whisper model name")
    parser.add_argument("--translate", action="store_true", help="Translate to Korean using NLLB-200")
    parser.add_argument("--srt", action="store_true", help="Export SRT subtitle file")
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)

    try:
        # ── Track split mode ──
        if args.mode == "split":
            emit("status", message="트랙 분할 모드", percent=0)
            emit("progress", percent=3, message="오디오 변환 중...")
            wav_path = convert_to_wav(args.input)

            try:
                emit("progress", percent=5, message="오디오 분석 중...")
                wav_full, sr_full = load_audio(wav_path)
                if wav_full.shape[0] > 1:
                    wav_full = wav_full.mean(dim=0, keepdim=True)
                audio_np = wav_full.squeeze().numpy()

                import numpy as np

                # Detect silence regions to find track boundaries
                frame_len = int(0.05 * sr_full)  # 50ms frames
                hop = frame_len
                n_frames = len(audio_np) // hop

                emit("progress", percent=10, message="무음 구간 탐색 중...")
                rms = np.array([
                    np.sqrt(np.mean(audio_np[i * hop:i * hop + frame_len] ** 2))
                    for i in range(n_frames)
                ])

                # Adaptive threshold
                if rms.max() > 0:
                    sorted_rms = np.sort(rms)
                    noise_floor = sorted_rms[int(len(sorted_rms) * 0.1)]
                    threshold = max(noise_floor * 5, 0.005)
                else:
                    threshold = 0.005

                is_sound = rms > threshold

                # Find silence gaps longer than 1.5 seconds (track boundaries)
                min_silence_frames = int(1.5 * sr_full / hop)
                min_track_frames = int(10.0 * sr_full / hop)  # minimum 10s per track

                # Detect silence segments
                silence_segments = []
                i = 0
                while i < len(is_sound):
                    if not is_sound[i]:
                        j = i
                        while j < len(is_sound) and not is_sound[j]:
                            j += 1
                        if (j - i) >= min_silence_frames:
                            center = ((i + j) // 2) * hop
                            silence_segments.append(center)
                        i = j
                    else:
                        i += 1

                emit("progress", percent=20, message=f"{len(silence_segments)}개 분할 지점 감지")

                # Build track boundaries
                boundaries = [0] + silence_segments + [len(audio_np)]
                track_ranges = []
                for k in range(len(boundaries) - 1):
                    start = boundaries[k]
                    end = boundaries[k + 1]
                    # Skip very short segments
                    dur_frames = (end - start) // hop
                    if dur_frames >= min_track_frames:
                        track_ranges.append((start, end))

                if not track_ranges:
                    track_ranges = [(0, len(audio_np))]

                emit("progress", percent=25, message=f"{len(track_ranges)}개 트랙 분할")

                # Save each track
                tracks = []
                for idx, (start, end) in enumerate(track_ranges):
                    pct = 25 + int((idx / max(len(track_ranges), 1)) * 30)
                    label = f"Track {idx + 1:02d}"
                    name = f"track_{idx + 1:02d}"
                    emit("progress", percent=pct, message=f"{label} 저장 중...")

                    end = min(end, wav_full.shape[1])
                    chunk = wav_full[:, start:end]
                    out_path = os.path.join(args.output, f"{name}.wav")
                    save_audio(out_path, chunk, sr_full)

                    dur = (end - start) / sr_full
                    tracks.append({
                        "name": name,
                        "label": f"{label} ({_fmt_time(dur)})",
                        "path": out_path
                    })

                # Transcribe + translate each track if requested
                if args.transcribe or args.translate:
                    emit("progress", percent=55, message="Whisper 모델 로딩 중...")
                    import whisper
                    import torch
                    device = "cuda" if torch.cuda.is_available() else "cpu"
                    w_model = whisper.load_model(args.whisper_model, device=device)

                    nllb_model = None
                    nllb_tokenizer = None

                    for idx, t in enumerate(tracks):
                        pct = 60 + int((idx / max(len(tracks), 1)) * 35)
                        emit("progress", percent=pct, message=f"{t['label']}: 텍스트 추출 중...")

                        result = w_model.transcribe(t["path"], language=None, task="transcribe", verbose=False)
                        text = result["text"].strip()
                        language = result.get("language", "unknown")

                        base = os.path.splitext(os.path.basename(t["path"]))[0]
                        txt_path = os.path.join(args.output, f"{base}.txt")
                        with open(txt_path, "w", encoding="utf-8") as f:
                            f.write(text)

                        t["text"] = text
                        t["language"] = language
                        t["txt_path"] = txt_path

                        # SRT
                        if args.srt:
                            srt_path = os.path.join(args.output, f"{base}.srt")
                            with open(srt_path, "w", encoding="utf-8") as f:
                                for si, seg in enumerate(result["segments"], 1):
                                    f.write(f"{si}\n{_fmt_srt_time(seg['start'])} --> {_fmt_srt_time(seg['end'])}\n{seg['text'].strip()}\n\n")

                        # Translate
                        if args.translate and language != "ko":
                            emit("progress", percent=pct + 1, message=f"{t['label']}: {language}→한국어 번역 중...")
                            kr = translate_to_korean(text, language)
                            if kr:
                                kr_path = os.path.join(args.output, f"{base}_korean.txt")
                                with open(kr_path, "w", encoding="utf-8") as f:
                                    f.write(kr)
                                t["translated_text"] = kr

                        emit("progress", percent=pct + 1, message=f"{t['label']}: {language} 감지")

                emit("progress", percent=99, message="완료!")
                emit("result", tracks=tracks, outputDir=args.output)
                sys.exit(0)

            finally:
                try:
                    os.remove(wav_path)
                    os.rmdir(os.path.dirname(wav_path))
                except OSError:
                    pass

        # ── Transcribe-only mode ──
        if args.mode == "transcribe":
            emit("status", message="텍스트 추출 모드", percent=0)
            emit("progress", percent=5, message="Whisper 모델 로딩 중... (첫 실행 시 다운로드)")
            import whisper
            device = "cuda"
            try:
                import torch
                if not torch.cuda.is_available():
                    device = "cpu"
            except Exception:
                device = "cpu"

            model = whisper.load_model(args.whisper_model, device=device)
            emit("progress", percent=30, message="텍스트 변환 중...")

            # Convert to wav first for compatibility
            wav_path = convert_to_wav(args.input)
            try:
                result = model.transcribe(wav_path, language=None, task="transcribe", verbose=False)
            finally:
                try:
                    os.remove(wav_path)
                    os.rmdir(os.path.dirname(wav_path))
                except OSError:
                    pass

            text = result["text"].strip()
            language = result.get("language", "unknown")

            # Save text
            base = os.path.splitext(os.path.basename(args.input))[0]
            txt_path = os.path.join(args.output, f"{base}.txt")
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(text)

            # Save with timestamps
            srt_path = os.path.join(args.output, f"{base}_timestamps.txt")
            with open(srt_path, "w", encoding="utf-8") as f:
                for seg in result["segments"]:
                    s, e, txt = seg["start"], seg["end"], seg["text"].strip()
                    f.write(f"[{_fmt_time(s)} → {_fmt_time(e)}] {txt}\n")

            emit("progress", percent=80, message=f"언어 감지: {language}")

            # SRT export
            if args.srt:
                srt_export_path = os.path.join(args.output, f"{base}.srt")
                with open(srt_export_path, "w", encoding="utf-8") as f:
                    for i, seg in enumerate(result["segments"], 1):
                        f.write(f"{i}\n")
                        f.write(f"{_fmt_srt_time(seg['start'])} --> {_fmt_srt_time(seg['end'])}\n")
                        f.write(f"{seg['text'].strip()}\n\n")
                emit("progress", percent=85, message="SRT 자막 파일 생성 완료")

            # Translation to Korean
            translated_text = None
            if args.translate and language != "ko":
                emit("progress", percent=87, message=f"NLLB-200 한국어 번역 중 ({language}→ko)...")
                translated_text = translate_to_korean(text, language)
                if translated_text:
                    kr_path = os.path.join(args.output, f"{base}_korean.txt")
                    with open(kr_path, "w", encoding="utf-8") as f:
                        f.write(translated_text)
                    emit("progress", percent=95, message="한국어 번역 완료")

            tracks = [{
                "name": "transcript",
                "label": f"텍스트 ({language})",
                "path": txt_path,
                "text": text,
                "language": language,
                "txt_path": txt_path
            }]
            if translated_text:
                tracks.append({
                    "name": "translation",
                    "label": "한국어 번역",
                    "path": os.path.join(args.output, f"{base}_korean.txt"),
                    "text": translated_text,
                    "language": "ko",
                    "txt_path": os.path.join(args.output, f"{base}_korean.txt")
                })

            emit("progress", percent=99, message="완료!")
            emit("result", tracks=tracks, outputDir=args.output)
            sys.exit(0)

        # ── Step 1: Separation ──
        tracks = []
        if args.mode == "music":
            tracks = run_music_separation(args.input, args.output, args.model) or []
        elif args.mode == "conversation":
            tracks = run_conversation_separation(args.input, args.output) or []

        if not tracks:
            emit("error", message="분리 결과가 없습니다.")
            sys.exit(1)

        # ── Step 2: Trim silence (optional) ──
        if args.trim_silence:
            import torch
            emit("progress", percent=91, message="무음 구간 제거 중...")
            for t in tracks:
                wav, sr = load_audio(t["path"])
                trimmed = trim_silence(wav, sr, silence_gap_sec=args.silence_gap)
                trimmed_path = t["path"].replace(".wav", "_trimmed.wav")
                save_audio(trimmed_path, trimmed, sr)
                t["trimmed_path"] = trimmed_path
                emit("progress", percent=93, message=f"{t['label']} 무음 제거 완료")

        # ── Step 3: Whisper transcription (optional) ──
        if args.transcribe:
            emit("progress", percent=94, message="Whisper 모델 로딩 중... (첫 실행 시 다운로드)")
            import whisper
            device = "cuda"
            try:
                import torch
                if not torch.cuda.is_available():
                    device = "cpu"
            except Exception:
                device = "cpu"

            model = whisper.load_model(args.whisper_model, device=device)
            emit("progress", percent=95, message="텍스트 변환 중...")

            for i, t in enumerate(tracks):
                audio_path = t["path"]
                pct = 95 + int((i / max(len(tracks), 1)) * 4)
                emit("progress", percent=pct, message=f"텍스트 변환: {t['label']}")

                result = model.transcribe(audio_path, language=None, task="transcribe", verbose=False)
                text = result["text"].strip()
                language = result.get("language", "unknown")

                # Save text file
                base = os.path.splitext(os.path.basename(audio_path))[0]
                txt_path = os.path.join(args.output, f"{base}.txt")
                with open(txt_path, "w", encoding="utf-8") as f:
                    f.write(text)

                # Save with timestamps
                srt_path = os.path.join(args.output, f"{base}_timestamps.txt")
                with open(srt_path, "w", encoding="utf-8") as f:
                    for seg in result["segments"]:
                        s, e, txt = seg["start"], seg["end"], seg["text"].strip()
                        f.write(f"[{_fmt_time(s)} → {_fmt_time(e)}] {txt}\n")

                # SRT for this track
                if args.srt:
                    srt_export = os.path.join(args.output, f"{base}.srt")
                    with open(srt_export, "w", encoding="utf-8") as f:
                        for si, seg in enumerate(result["segments"], 1):
                            f.write(f"{si}\n{_fmt_srt_time(seg['start'])} --> {_fmt_srt_time(seg['end'])}\n{seg['text'].strip()}\n\n")

                # Translate this track
                if args.translate and language != "ko":
                    emit("progress", percent=pct + 1, message=f"{t['label']}: {language}→한국어 번역 중...")
                    kr = translate_to_korean(text, language)
                    if kr:
                        kr_path = os.path.join(args.output, f"{base}_korean.txt")
                        with open(kr_path, "w", encoding="utf-8") as f:
                            f.write(kr)
                        t["translated_text"] = kr

                t["text"] = text
                t["language"] = language
                t["txt_path"] = txt_path
                emit("progress", percent=pct + 1, message=f"{t['label']}: {language} 감지")

        # ── Step 4: Convert output format (optional) ──
        if args.output_format != "wav":
            ffmpeg = find_ffmpeg()
            if ffmpeg:
                emit("progress", percent=98, message=f"{args.output_format.upper()} 변환 중...")
                for t in tracks:
                    src = t["path"]
                    if not src.endswith(".wav"):
                        continue
                    dst = src.replace(".wav", f".{args.output_format}")
                    codec = {"mp3": ["-codec:a", "libmp3lame", "-q:a", "2"], "flac": ["-codec:a", "flac"]}
                    cmd = [ffmpeg, "-y", "-i", src, *codec.get(args.output_format, []), dst]
                    subprocess.run(cmd, capture_output=True)
                    if os.path.exists(dst):
                        t["path"] = dst

                    # Also convert trimmed version if exists
                    if "trimmed_path" in t:
                        tsrc = t["trimmed_path"]
                        tdst = tsrc.replace(".wav", f".{args.output_format}")
                        cmd = [ffmpeg, "-y", "-i", tsrc, *codec.get(args.output_format, []), tdst]
                        subprocess.run(cmd, capture_output=True)
                        if os.path.exists(tdst):
                            t["trimmed_path"] = tdst

        # ── Final: Emit result ──
        emit("progress", percent=99, message="완료!")
        emit("result", tracks=tracks, outputDir=args.output)

    except Exception as e:
        emit("error", message=str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
