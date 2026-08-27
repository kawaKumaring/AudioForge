"""Speaker diarization: Silero VAD + ECAPA-TDNN + spectral clustering."""

import os
import shutil
from audio_utils import emit, load_audio, save_audio, convert_to_wav
from gpu_policy import select_device, run_with_oom_retry


def _canonical_labels(order, n_speakers):
    """cluster index → 'order 첫 등장 순' canonical 라벨 (트랙 라벨 규칙과 동일:
    enumerate(order)). 반환 (label_of, speaker_names[0..n_speakers-1]).

    hard-label sidecar 와 posterior 해석이 같은 라벨 규약을 쓰도록 단일 소스로 둔다.
    """
    label_of = {}
    for idx, c in enumerate(order):
        label_of[c] = f"화자 {chr(65 + idx)}"
    speaker_names = [label_of.get(c, f"화자 {chr(65 + c)}") for c in range(n_speakers)]
    return label_of, speaker_names


def _speaker_track_plan(order, first_app, n_samples):
    """저장할 화자 트랙 계획 — 출력 프레임이 하나도 없는 화자는 제외한다 (순수 함수).

    MIN_TURN_FRAMES 병합이 어떤 화자의 구간을 전부 흡수하면 그 화자의
    speaker_wavs 는 끝까지 all-zero 로 남는다. 예전에는 order 전체를 돌며 무조건
    save_audio 를 불러서, 사용자 트랙 목록에 재생해도 아무 소리가 없는 무음 WAV 가
    섞여 나왔다. 그런 화자는 파일을 쓰지도, tracks 에 넣지도 않는다.

    판정 근거는 이미 계산된 first_app 뿐이다(재분석 없음). first_app[spk] 는
    Step 8 에서 '그 화자가 처음 등장한 샘플 위치'로 채워지고, smoothed 에 한 프레임도
    남지 않은 화자는 초기 sentinel(n_samples)에 그대로 머문다. 재구성 루프도
    s >= n_samples 에서 멈추므로 first_app[spk] < n_samples 인 화자만 실제로
    샘플을 배정받는다 — 즉 first_app 이 곧 '출력 프레임 유무'다.

    살아남은 화자에게는 order(첫 등장 순)를 유지한 채 화자 A, B, … 를 빈틈없이
    다시 매긴다(중간에 빠진 화자가 있어도 라벨에 구멍이 생기지 않는다).

    반환: [(spk_idx, name, label), ...] — order 순. plain int 만 다루므로
    torch/numpy 없이 합성 테스트가 가능하다.
    """
    plan = []
    for spk_idx in order:
        if first_app[spk_idx] >= n_samples:
            continue   # 병합으로 전부 흡수됨 → 무음 WAV 만 나올 화자, 저장하지 않는다
        letter = chr(65 + len(plan))
        plan.append((spk_idx, f"speaker_{letter.lower()}", f"화자 {letter}"))
    return plan


def _save_speaker_tracks(order, first_app, n_samples, speaker_wavs, sr, output_dir):
    """계획대로 화자 WAV 를 저장하고 tracks 목록을 돌려준다.

    출력 프레임이 없는 화자는 파일을 만들지 않는다(_speaker_track_plan 참조).
    save_audio 는 모듈 전역을 통해 부르므로, 테스트가 이를 가짜로 바꿔 끼우면
    실제 오디오·파일 없이 저장 배선을 검증할 수 있다."""
    tracks = []
    for spk_idx, name, label in _speaker_track_plan(order, first_app, n_samples):
        out_path = os.path.join(output_dir, f"{name}.wav")
        save_audio(out_path, speaker_wavs[spk_idx], sr)
        tracks.append({"name": name, "label": label, "path": out_path})
    return tracks


# posterior 해석 임계 메타(직렬화용). synthetic 검증값이며 실제 정확도 확정값이 아니다.
def _interpretation_thresholds():
    import dialogue_canonical as dc
    import dialogue_quality_p1 as q1
    return {
        "reviewBelow": q1.DEFAULT_POLICY.review_below,
        "unknownBelow": q1.DEFAULT_POLICY.unknown_below,
        "overlapMinPosterior": dc.DEFAULT_OVERLAP_MIN_POSTERIOR,
        "note": "synthetic 검증값 — 실제 정확도 확정값 아님",
    }


def _build_dialogue_interpretation(frame_posteriors, prob_speech_mask, speaker_names, frame_rate):
    """experimental posterior 해석 블록(순수). 프레임 posterior 를 overlap 다중 라벨 +
    UNKNOWN/REVIEW 상태 세그먼트로 해석해 additive namespace 로 반환한다.

    ★ 이것은 "source separation" 이 아니다 — production argmax WAV/track 은 이 함수와
      무관하게 이미 확정·저장됐다. 여기서는 posterior 를 *해석* 만 한다(오디오 불변).
    ★ frame_confidence 는 넘기지 않는다(=None). worker 의 speaker_weights 는 [0,1] 이
      아니라 Gaussian 근거량 합이라, 근거 없는 변환 대신 posterior margin(top1-top2)을
      confidence 대용으로 쓴다. status 는 synthetic 검증 임계 기준이다.
    실패 격리는 호출부(_attach_interpretation)의 책임. 파일을 절대 쓰지 않는다.
    """
    import dialogue_canonical as dc
    import dialogue_quality_p1 as q1

    segs = q1.interpret_posteriors(
        frame_posteriors, frame_rate, speaker_names,
        frame_confidence=None,               # 결정 7: 근거 없는 speaker_weights 변환 금지.
        speech_mask=prob_speech_mask,
        policy=q1.DEFAULT_POLICY,
    )
    return {
        "schemaVersion": dc.SCHEMA_VERSION,
        "status": "available",
        "experimental": True,
        "segments": [s.to_dict() for s in segs],
        "summary": {
            "overlapCount": sum(1 for s in segs if s.is_overlap),
            "unknownCount": sum(1 for s in segs if s.status == dc.SegmentStatus.UNKNOWN),
            "reviewCount": sum(1 for s in segs if s.status == dc.SegmentStatus.REVIEW),
        },
        "thresholds": _interpretation_thresholds(),
        "source": {"pipeline": "posterior-interpret", "frameRate": str(int(frame_rate))},
    }


def _unavailable_interpretation(error_code):
    """해석 실패 시의 additive 블록. safe error code 만 포함(traceback·경로·score 배열 금지)."""
    import dialogue_canonical as dc
    return {
        "schemaVersion": dc.SCHEMA_VERSION,
        "status": "unavailable",
        "experimental": True,
        "segments": [],
        "summary": {"overlapCount": 0, "unknownCount": 0, "reviewCount": 0},
        "thresholds": _interpretation_thresholds(),
        "source": {"pipeline": "posterior-interpret"},
        "errorCode": str(error_code),
    }


def _attach_interpretation(payload, frame_posteriors, prob_speech_mask, speaker_names, frame_rate):
    """payload 에 experimental posterior 해석을 additive namespace('interpretation')로
    붙인다. **내부 try 로 격리** — 해석이 실패해도 hard-label payload(sidecar/speakerMeta)
    는 절대 건드리지 않고, interpretation.status='unavailable' + safe error code 만 담는다.

    반환은 (mutated) payload. frame_confidence 는 넘기지 않는다(결정 7).
    """
    try:
        payload["interpretation"] = _build_dialogue_interpretation(
            frame_posteriors, prob_speech_mask, speaker_names, frame_rate)
    except Exception as ie:
        # safe error code = 예외 클래스명만(메시지·traceback·경로·score 미포함).
        payload["interpretation"] = _unavailable_interpretation(type(ie).__name__)
    return payload


def _build_dialogue_sidecar_payload(frame_labels, smoothed, order, n_speakers, frame_rate):
    """canonical dialogue sidecar 를 in-memory versioned payload 로 만든다 (순수 함수).

    ★ frame_labels 는 **speech-mask 적용 후 · MIN_TURN_FRAMES 병합 전** 라벨(무음=-1)이어야
      <500ms backchannel 이 세그먼트로 보존된다. smoothed 는 트랙 존재(오디오 출력) 판정용으로만
      읽고, 오디오/트랙 결과에 손대지 않는다.

    plain list 만 받으므로(numpy·torch·파일 I/O 없음) synthetic 테스트가 가능하다.
    파일을 절대 쓰지 않는다. 실패 격리는 호출부(try/except)의 책임.

    화자 라벨 규약(확정):
      - order(첫 등장 순) 매핑으로 cluster index → "화자 A/B..." = 트랙 라벨과 동일.
      - smoothed 에 남은(트랙 오디오가 있는) 화자: trackAvailable=True, trackIndex=order 위치.
      - 병합으로 smoothed 에서 사라진 backchannel-only 화자: 삭제하지 않고 보존하되
        trackAvailable=False, trackIndex=None, reviewRequired=True (없는 트랙 생성·타 화자
        강제 귀속 금지 — deterministic canonical speaker ID 만 유지).
    """
    import dialogue_canonical as dc

    # cluster index → order 기반 canonical 라벨 (track 라벨 규칙과 동일: enumerate(order)).
    label_of, speaker_names = _canonical_labels(order, n_speakers)

    # 병합 전 hard label → 세그먼트(posterior={label:1.0}). 현재 파이프라인은 argmax 마스킹이라
    # overlap 개념이 없으므로 frame_posteriors 를 넘기지 않는다(트랙 배정과 동일한 hard label 유지).
    segments = dc.build_segments_from_frames(frame_labels, frame_rate, speaker_names)

    sidecar = dc.CanonicalSidecar(
        segments=segments,
        speakers=[label_of[c] for c in order],   # deterministic 전 화자 목록
        source={"pipeline": "argmax-mask", "frame_rate": str(int(frame_rate))},
    )

    premerge_present = {int(x) for x in frame_labels if x is not None and int(x) >= 0}
    smoothed_present = {int(x) for x in smoothed if x is not None and int(x) >= 0}

    # trackIndex 는 실제 tracks 배열의 위치여야 한다. 출력 프레임이 없는 화자는 이제 트랙을
    # 만들지 않으므로(_speaker_track_plan), order 위치를 그대로 쓰면 그 뒤 화자들의 인덱스가
    # 한 칸씩 밀려 어긋난다. 저장 순서와 동일하게 '사용 가능한 화자만' 세어 매긴다.
    speaker_meta = []
    track_pos = 0
    for c in order:
        avail = c in smoothed_present
        backchannel_only = (c in premerge_present) and not avail
        speaker_meta.append({
            "id": label_of[c],
            "trackAvailable": avail,
            "trackIndex": track_pos if avail else None,
            "reviewRequired": backchannel_only,
        })
        if avail:
            track_pos += 1
    speaker_meta.sort(key=lambda m: m["id"])   # deterministic

    return {
        "schema": dc.SCHEMA_ID,
        "schemaVersion": dc.SCHEMA_VERSION,
        "sidecar": sidecar.to_dict(),
        "speakerMeta": speaker_meta,
    }


def run_conversation_separation(input_path: str, output_dir: str, n_speakers: int = 2,
                                gpu_policy: str = "auto"):
    """High-quality speaker separation using:
      1. Silero VAD (neural network) for precise speech detection
      2. Sliding window (1.5s, 0.5s hop) with ECAPA-TDNN embeddings
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

    emit("progress", percent=2, message="GPU 확인 중... (실제 여유 VRAM 기준, 점유 시 CPU 전환)")
    try:
        device, reason = select_device(gpu_policy, timeout_sec=10)
    except RuntimeError as e:
        # 강제 GPU인데 CUDA 미가용 등 — 조용히 CPU로 낮추지 않고 명확히 실패
        emit("error", message=str(e))
        return []
    emit("progress", percent=3, message=f"디바이스: {device.upper()} ({reason})")

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

        # ── Step 2/3: 윈도우 준비(CPU) → ECAPA 임베딩 추출(GPU, OOM 시 CPU 1회 재시도) ──
        WIN_SEC = 1.5    # window size in seconds
        HOP_SEC = 0.5    # hop size (overlap = WIN - HOP = 1.0s)
        MIN_SPEECH_RATIO = 0.3  # minimum speech ratio in window to extract embedding

        win_samples = int(WIN_SEC * SR)
        hop_samples = int(HOP_SEC * SR)

        n_windows = max(1, (n_16k - win_samples) // hop_samples + 1)
        emit("progress", percent=13, message=f"슬라이딩 윈도우 분석: {n_windows}개 윈도우")

        # Pass 1: 윈도우별 발화 청크 준비 (GPU 호출 없음 — 재시도해도 재계산 불필요)
        EMB_BATCH = 32
        window_meta = []  # (center_time, chunk_np or None)
        for w in range(n_windows):
            start = w * hop_samples
            end = min(start + win_samples, n_16k)
            center_time = (start + end) / 2 / SR

            # Check speech ratio in this window
            speech_ratio = speech_mask[start:end].mean()
            if speech_ratio < MIN_SPEECH_RATIO:
                window_meta.append((center_time, None))
                continue

            # Extract only the speech parts for cleaner embedding
            chunk = wav_16k_np[start:end].copy()
            chunk[~speech_mask[start:end]] = 0.0  # zero out non-speech
            window_meta.append((center_time, chunk))

        # Pass 2 준비: 같은 길이 청크끼리 묶어 배치 추론(패딩 없어 개별 추론과 동일).
        from collections import defaultdict
        length_groups = defaultdict(list)
        for i, (_, chunk) in enumerate(window_meta):
            if chunk is not None:
                length_groups[len(chunk)].append(i)
        n_valid_total = sum(len(v) for v in length_groups.values())

        # ECAPA 로딩 + 배치 추론을 하나의 재시도 단위로 — CUDA OOM 시 정리 후 CPU로 1회 재시도.
        def _extract_embeddings(dev):
            emit("progress", percent=14,
                 message=f"ECAPA-TDNN 모델 로딩 중... ({dev.upper()}, 첫 실행 시 다운로드)")
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
                enc = EncoderClassifier.from_hparams(
                    source="speechbrain/spkrec-ecapa-voxceleb",
                    savedir=os.path.join(os.path.expanduser("~"), ".cache", "speechbrain", "ecapa"),
                    run_opts={"device": dev}
                )
                emit("progress", percent=17, message=f"ECAPA-TDNN 로딩 완료 ({dev.upper()})")
            finally:
                if _orig_symlink:
                    os.symlink = _orig_symlink

            emb_by_idx = {}
            done = 0
            for _length, idxs in length_groups.items():
                for b in range(0, len(idxs), EMB_BATCH):
                    batch_idxs = idxs[b:b + EMB_BATCH]
                    batch_np = np.stack([window_meta[i][1] for i in batch_idxs])
                    batch_tensor = torch.from_numpy(batch_np).float().to(dev)
                    with torch.no_grad():
                        embs = enc.encode_batch(batch_tensor)  # (B, 1, D)
                    embs = embs.squeeze(1).cpu().numpy()
                    for k, i in enumerate(batch_idxs):
                        emb_by_idx[i] = embs[k]
                    done += len(batch_idxs)
                    pct = 18 + int((done / max(n_valid_total, 1)) * 35)
                    emit("progress", percent=pct,
                         message=f"임베딩 추출 중... ({done}/{n_valid_total}, {dev.upper()})")
            return emb_by_idx

        def _cleanup_cuda():
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass

        def _on_oom(e):
            emit("progress", percent=14,
                 message=f"CUDA 메모리 부족 → CPU로 1회 재시도 ({str(e)[:60]})")

        embeddings_by_idx, used_device = run_with_oom_retry(
            _extract_embeddings, device, cleanup=_cleanup_cuda, on_fallback=_on_oom)
        if used_device != device:
            emit("progress", percent=53,
                 message=f"임베딩 추출: {used_device.upper()}로 완료 (GPU→CPU 전환됨)")

        window_embeddings = [(t, embeddings_by_idx.get(i)) for i, (t, _) in enumerate(window_meta)]

        valid_windows = []
        window_to_valid = {}  # window_embeddings 인덱스 → valid_windows 인덱스 (O(1) 매칭)
        for wi, (t, e) in enumerate(window_embeddings):
            if e is not None:
                window_to_valid[wi] = len(valid_windows)
                valid_windows.append((t, e))
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
        # 재현성: 시드된 생성기를 재시작 전체에서 공유 → 재시작 간 다양성 유지,
        # 실행 간 동일 입력이면 동일 결과 (L-7)
        km_rng = np.random.default_rng(0)
        best_labels = None
        best_inertia = float('inf')
        for _ in range(10):
            labels, inertia = _kmeans(features, n_speakers, rng=km_rng)
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

        # 클러스터 중심은 루프 불변 — 윈도우마다 재계산하지 않고 1회만 계산
        centroids = []
        for c in range(n_speakers):
            c_mask = best_labels == c
            if c_mask.sum() > 0:
                centroids.append(valid_embs_normed[c_mask].mean(axis=0))
            else:
                centroids.append(np.zeros(valid_embs_normed.shape[1]))

        for idx, (center_time, emb) in enumerate(window_embeddings):
            if emb is None:
                continue
            vi = window_to_valid.get(idx)
            if vi is None:
                continue

            emb_n = emb / max(np.linalg.norm(emb), 1e-8)
            confs = np.array([max(0, np.dot(emb_n, ctr)) for ctr in centroids])
            total_conf = max(confs.sum(), 1e-8)
            probs = confs / total_conf

            # Apply to probability map with Gaussian window
            win_start_f = int((center_time - WIN_SEC / 2) * PROB_SR)
            win_end_f = int((center_time + WIN_SEC / 2) * PROB_SR)
            win_start_f = max(0, win_start_f)
            win_end_f = min(n_prob_frames, win_end_f)

            # 프레임×화자 이중 루프를 벡터화 (윈도우별 누적 순서·곱 동일 → 수치 동등)
            if win_end_f > win_start_f:
                frames = np.arange(win_start_f, win_end_f)
                ts = frames / PROB_SR
                gw = np.exp(-((ts - center_time) ** 2) / (2 * (WIN_SEC / 4) ** 2))
                speaker_scores[win_start_f:win_end_f] += gw[:, None] * probs[None, :]
                speaker_weights[win_start_f:win_end_f] += gw

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

        # 출력 프레임이 없는 화자(MIN_TURN 병합에 전부 흡수됨)는 건너뛴다 — 예전에는
        # 무음 WAV 가 저장돼 트랙 목록에 그대로 노출됐다. 남는 화자의 오디오 내용과
        # 순서(order)는 그대로이고, 라벨만 빈틈없이 다시 매겨진다.
        tracks = _save_speaker_tracks(order, first_app, n_samples,
                                      speaker_wavs, sr_full, output_dir)

        emit("progress", percent=95, message="분리 완료")

        # ── canonical dialogue sidecar (in-memory, versioned payload) ──
        # 병합 전 frame_labels(무음=-1)의 복사본으로 <500ms backchannel 을 보존한 sidecar 를
        # 생성해 versioned payload 로 방출한다. 파일을 쓰지 않으며, smoothed 기반 오디오/트랙
        # 출력에는 전혀 관여하지 않는다(위 tracks 는 이미 확정·저장됨). 실패해도 오디오/트랙은
        # 정상이며, 부분 sidecar·파일 산출은 없다.
        try:
            payload = _build_dialogue_sidecar_payload(
                frame_labels.copy().tolist(),   # speech-mask 후·병합 전
                smoothed.tolist(),              # 트랙 존재 판정용(읽기 전용)
                order, n_speakers, PROB_SR,
            )
            # ── experimental posterior 해석 (additive namespace) ──
            # 병합 전 speaker_scores(:296 정규화 :336)와 prob_speech_mask(:345-350)를
            # plain list 로 넘겨 overlap/UNKNOWN/REVIEW 를 해석한다. **내부 try 로 격리**되어
            # 해석이 실패해도 위 hard-label payload·아래 WAV/track 은 불변으로 나간다.
            # frame_confidence 는 넘기지 않는다(결정 7). 파일 저장·UI 노출 없음.
            _, interp_names = _canonical_labels(order, n_speakers)
            _attach_interpretation(
                payload,
                speaker_scores.tolist(),        # 병합 전 프레임 posterior
                prob_speech_mask.tolist(),      # 무음 경계(읽기 전용)
                interp_names, PROB_SR,
            )
            emit("dialogueSidecar", **payload)
        except Exception as e:
            # 구조화 오류 — 비치명적. 기존 WAV/track 결과 불변, 파일 산출 없음.
            emit("dialogueSidecarError",
                 message=f"canonical sidecar 생성 실패(오디오·트랙은 정상): {e}")

        return tracks

    finally:
        try:
            os.remove(wav_path)
            os.rmdir(os.path.dirname(wav_path))
        except OSError:
            pass


def _kmeans(data, k, max_iter=100, rng=None):
    """K-means with inertia tracking. Returns (labels, inertia).

    rng: np.random.Generator — 재현성을 위해 호출부에서 시드된 생성기를 넘긴다.
    None이면 비시드 생성기(기존 동작에 준함).
    """
    import numpy as np
    if rng is None:
        rng = np.random.default_rng()
    n = data.shape[0]
    # k-means++ init
    centers = [data[rng.integers(n)]]
    for _ in range(1, k):
        dists = np.min([np.sum((data - c) ** 2, axis=1) for c in centers], axis=0)
        probs = dists / max(dists.sum(), 1e-12)
        centers.append(data[rng.choice(n, p=probs)])
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

