"""Speaker diarization: Silero VAD + ECAPA-TDNN + spectral clustering."""

import os
import shutil
from audio_utils import emit, load_audio, save_audio, convert_to_wav, get_device


def run_conversation_separation(input_path: str, output_dir: str, n_speakers: int = 2):
    """High-quality speaker separation using:
      1. Silero VAD (neural network) for precise speech detection
      2. Sliding window (1.5s, 0.75s hop) with ECAPA-TDNN embeddings
      3. Per-frame speaker probability map from overlapping windows
      4. Temporal smoothing (min 500ms per speaker turn)
      5. Soft crossfade reconstruction
    """
    emit("progress", percent=1, message="torch 엔진 로딩 중...")

    try:
        import torch
        import numpy as np
    except ImportError as e:
        emit("error", message=f"필요한 패키지가 설치되지 않았습니다: {e}")
        return []

    emit("progress", percent=2, message="GPU 확인 중... (점유 시 CPU로 자동 전환)")
    device = get_device(timeout_sec=10)
    emit("progress", percent=3, message=f"디바이스: {device.upper()}")

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
        emit("progress", percent=6, message="Silero VAD 모델 로딩 중... (첫 실행 시 다운로드)")
        vad_model, vad_utils = torch.hub.load(
            repo_or_dir='snakers4/silero-vad', model='silero_vad',
            trust_repo=True, onnx=False
        )
        emit("progress", percent=8, message="Silero VAD 음성 검출 중...")
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
            emit("error", message="발화 구간이 너무 적습니다. 오디오를 확인해주세요.")
            return []

        # Build speech mask at 16kHz sample level
        n_16k = len(wav_16k_np)
        speech_mask = np.zeros(n_16k, dtype=bool)
        for ts in speech_timestamps:
            speech_mask[ts['start']:ts['end']] = True

        emit("progress", percent=12, message=f"Silero VAD: {len(speech_timestamps)}개 발화 구간")

        # ── Step 2: Load ECAPA-TDNN ──
        emit("progress", percent=14, message="ECAPA-TDNN 모델 로딩 중... (첫 실행 시 다운로드)")

        _orig_symlink = getattr(os, "symlink", None)
        def _copy_instead(src, dst, *a, **kw):
            if os.path.isdir(src):
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(src, dst)
        os.symlink = _copy_instead

        try:
            from speechbrain.inference.speaker import EncoderClassifier
            emit("progress", percent=15, message="SpeechBrain 모델 다운로드/로딩 중...")
            encoder = EncoderClassifier.from_hparams(
                source="speechbrain/spkrec-ecapa-voxceleb",
                savedir=os.path.join(os.path.expanduser("~"), ".cache", "speechbrain", "ecapa"),
                run_opts={"device": device}
            )
            emit("progress", percent=17, message="ECAPA-TDNN 로딩 완료")
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
            return []

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
        features = eigenvectors[:, :n_speakers]
        row_norms = np.linalg.norm(features, axis=1, keepdims=True)
        features = features / np.maximum(row_norms, 1e-8)

        # K-means with multiple restarts for stability
        best_labels = None
        best_inertia = float('inf')
        for _ in range(10):
            labels, inertia = _kmeans(features, n_speakers)
            if inertia < best_inertia:
                best_inertia = inertia
                best_labels = labels.copy()

        # ── Step 5: Build per-frame speaker probability map ──
        emit("progress", percent=62, message="프레임별 화자 확률 맵 생성 중...")

        # Work at 100Hz resolution (10ms frames) for the probability map
        PROB_SR = 100
        n_prob_frames = int(total_dur * PROB_SR) + 1
        speaker_scores = np.zeros((n_prob_frames, n_speakers), dtype=np.float64)
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

            # Compute confidence: cosine similarity to each cluster centroid
            centroids = []
            for c in range(n_speakers):
                mask = best_labels == c
                if mask.sum() > 0:
                    centroids.append(valid_embs_normed[mask].mean(axis=0))
                else:
                    centroids.append(np.zeros(valid_embs_normed.shape[1]))

            emb_n = emb / max(np.linalg.norm(emb), 1e-8)
            confs = np.array([max(0, np.dot(emb_n, ctr)) for ctr in centroids])
            total_conf = max(confs.sum(), 1e-8)
            probs = confs / total_conf

            # Apply to probability map with Gaussian window
            win_start_f = int((center_time - WIN_SEC / 2) * PROB_SR)
            win_end_f = int((center_time + WIN_SEC / 2) * PROB_SR)
            win_start_f = max(0, win_start_f)
            win_end_f = min(n_prob_frames, win_end_f)

            for f in range(win_start_f, win_end_f):
                t = f / PROB_SR
                # Gaussian weight centered at window center
                w = np.exp(-((t - center_time) ** 2) / (2 * (WIN_SEC / 4) ** 2))
                for sp in range(n_speakers):
                    speaker_scores[f, sp] += probs[sp] * w
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
                counts = np.bincount(speech_window, minlength=n_speakers)
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
        speaker_wavs = [torch.zeros(1, n_samples) for _ in range(n_speakers)]

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
        for spk in range(n_speakers):
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
        first_app = [n_samples] * n_speakers
        for f in range(n_prob_frames):
            spk = smoothed[f]
            if 0 <= spk < n_speakers:
                s = int(f / PROB_SR * sr_full)
                if s < first_app[spk]:
                    first_app[spk] = s
        order = sorted(range(n_speakers), key=lambda x: first_app[x])

        emit("progress", percent=92, message="파일 저장 중...")

        tracks = []
        for idx, spk_idx in enumerate(order):
            label = f"화자 {chr(65 + idx)}"
            name = f"speaker_{chr(65 + idx).lower()}"
            out_path = os.path.join(output_dir, f"{name}.wav")
            save_audio(out_path, speaker_wavs[spk_idx], sr_full)
            tracks.append({"name": name, "label": label, "path": out_path})

        emit("progress", percent=95, message="분리 완료")
        return tracks

    finally:
        try:
            os.remove(wav_path)
            os.rmdir(os.path.dirname(wav_path))
        except OSError:
            pass


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

