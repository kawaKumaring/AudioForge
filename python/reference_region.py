# -*- coding: utf-8 -*-
"""긴 참조 음성에서 3~10초 구간을 다루는 백엔드 — 오류 거부가 아니라 "참조 원본"으로 수용.

역할(엔진 무관 사실 측정 + 파생 클립 생성):
  - recommend_region(): 10초 초과 파일에서 6~8초의 '좋은 발화 구간'을 자동 추천(무음 적음·클리핑
    없음·연속 발화). 확정이 아니라 UI 기본 제안값이다(사용자가 재생·확정).
  - analyze_region(): 선택 구간의 길이·무음비율·클리핑·RMS를 측정하고 품질 경고를 만든다.
  - coarse_peaks(): 파형 렌더링용 다운샘플 peak 배열(전체 파일).
  - trim_region(): 선택 구간만 mono/24kHz PCM WAV로 만든다. 원본은 절대 변경하지 않는다.

경계 정책(3.0/10.0초)과 품질 게이트는 reference_audio.GPTSOVITS_POLICY를 그대로 재사용한다.
speaker-overlap(화자 중첩) 회피는 진단 수준의 확실한 판별이 어려워(전체 diarization 필요) 이번엔
구현하지 않는다 — 요구의 "가능하면"에 해당하며, 추천은 무음·클리핑·연속발화 기준으로만 한다.

의존성: soundfile + numpy(이미 사용). 리샘플은 torchaudio(대화 분리 등에서 이미 사용). 새 패키지 없음.
"""
import os
import math

TARGET_SR = 24000            # 파생 참조 클립 샘플레이트(모델 입력)
DEFAULT_TARGET_SEC = 7.0     # 자동 추천 목표 길이(6~8초 권장의 중앙)
REC_MIN_SEC = 6.0
REC_MAX_SEC = 8.0
HOP_SEC = 0.1                # 추천/구간 분석 시 프레임 홉
SILENCE_DBFS = -45.0         # 무음 창 판정(reference_audio와 동일 기준)
CLIP_THRESHOLD = 0.99


def _load_mono(path):
    """(mono float32 ndarray, sr). 항상 2D로 읽어 모노 믹스다운. 실패는 예외."""
    import soundfile as sf
    import numpy as np
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]
    return np.ascontiguousarray(mono), int(sr)


def _hop_frames(mono, sr):
    """홉 단위 (rms_lin, clip_frac) 배열. 무음/발화·클리핑 판정용."""
    import numpy as np
    hop = max(1, int(round(sr * HOP_SEC)))
    n = len(mono)
    nh = max(1, n // hop)
    rms = np.empty(nh, dtype=np.float64)
    clip = np.empty(nh, dtype=np.float64)
    for i in range(nh):
        seg = mono[i * hop:(i + 1) * hop]
        if seg.size == 0:
            rms[i] = 0.0; clip[i] = 0.0; continue
        rms[i] = math.sqrt(float(np.square(seg, dtype=np.float64).mean()))
        clip[i] = float((np.abs(seg) >= CLIP_THRESHOLD).mean())
    return rms, clip, hop


def recommend_region(path, target_sec=DEFAULT_TARGET_SEC,
                     min_sec=REC_MIN_SEC, max_sec=REC_MAX_SEC):
    """10초 초과 파일에서 좋은 발화 구간 [start,dur]을 추천. 반환 dict(초 단위).
    점수 = 연속 발화(비무음) 비율 − 클리핑 페널티. 여러 후보 중 최고점 창을 고른다.
    파일이 target보다 짧으면 전체를 반환(호출부가 3~10초 판단)."""
    import numpy as np
    mono, sr = _load_mono(path)
    dur = len(mono) / sr if sr > 0 else 0.0
    if dur <= 0:
        return {"ok": False, "reason": "empty", "duration_sec": 0.0}

    win_sec = float(max(min_sec, min(max_sec, target_sec)))
    if dur <= win_sec:
        # 추천 창보다 짧으면 전체가 후보(경계 판정은 호출부/policy가 담당)
        return {"ok": True, "start_sec": 0.0, "dur_sec": round(dur, 3),
                "duration_sec": round(dur, 3), "whole_file": True}

    rms, clip, hop = _hop_frames(mono, sr)
    sil_lin = 10.0 ** (SILENCE_DBFS / 20.0)
    speech = (rms >= sil_lin).astype(np.float64)         # 1=발화, 0=무음
    win_hops = max(1, int(round(win_sec / HOP_SEC)))
    if win_hops >= len(speech):
        return {"ok": True, "start_sec": 0.0, "dur_sec": round(dur, 3),
                "duration_sec": round(dur, 3), "whole_file": True}

    # 슬라이딩 창 누적합으로 각 위치의 발화비율·클리핑비율 계산
    sp_cs = np.concatenate([[0.0], np.cumsum(speech)])
    cl_cs = np.concatenate([[0.0], np.cumsum(clip)])
    best_i, best_score = 0, -1e9
    step = max(1, int(round(0.2 / HOP_SEC)))  # 0.2s 간격으로 후보 탐색(과밀 방지)
    for i in range(0, len(speech) - win_hops + 1, step):
        sp = (sp_cs[i + win_hops] - sp_cs[i]) / win_hops        # 발화 비율
        cl = (cl_cs[i + win_hops] - cl_cs[i]) / win_hops        # 클리핑 비율
        score = sp - 3.0 * cl                                   # 클리핑 강하게 페널티
        if score > best_score:
            best_score, best_i = score, i
    start_sec = round(best_i * HOP_SEC, 3)
    start_sec = max(0.0, min(start_sec, dur - win_sec))
    return {"ok": True, "start_sec": round(start_sec, 3), "dur_sec": round(win_sec, 3),
            "duration_sec": round(dur, 3), "whole_file": False,
            "speech_ratio": round(float(best_score), 4)}


def analyze_region(path, start_sec, dur_sec):
    """선택 구간의 길이·무음비율·클리핑비율·RMS(dBFS)·peak + 품질 경고. 원본 슬라이스만 읽는다."""
    import soundfile as sf
    import numpy as np
    info = sf.info(path)
    sr = int(info.samplerate)
    total = int(info.frames)
    start_f = max(0, int(round(start_sec * sr)))
    n = int(round(dur_sec * sr))
    n = max(0, min(n, total - start_f))
    if n <= 0:
        return {"ok": False, "reason": "empty_region"}
    data, _ = sf.read(path, start=start_f, frames=n, dtype="float32", always_2d=True)
    mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]
    win = max(1, int(round(sr * 0.025)))
    sil_lin = 10.0 ** (SILENCE_DBFS / 20.0)
    sil_w = tot_w = 0
    for i in range(0, len(mono), win):
        w = mono[i:i + win]
        if w.size == 0:
            continue
        tot_w += 1
        if math.sqrt(float(np.square(w, dtype=np.float64).mean())) < sil_lin:
            sil_w += 1
    rms_lin = math.sqrt(float(np.square(mono, dtype=np.float64).mean())) if mono.size else 0.0
    rms_dbfs = max(-120.0, 20.0 * math.log10(rms_lin)) if rms_lin > 0 else -120.0
    peak = float(np.abs(mono).max()) if mono.size else 0.0
    clip_ratio = float((np.abs(mono) >= CLIP_THRESHOLD).mean()) if mono.size else 0.0
    sil_ratio = (sil_w / tot_w) if tot_w else 0.0
    actual_dur = n / sr

    warnings = []
    if actual_dur < 3.0:
        warnings.append(f"길이 부족({actual_dur:.2f}s < 3.0s) — 구간을 늘리세요.")
    elif actual_dur > 10.0:
        warnings.append(f"길이 초과({actual_dur:.2f}s > 10.0s) — 구간을 줄이세요.")
    if sil_ratio >= 0.40:
        warnings.append(f"무음 비율 높음({sil_ratio:.2f}).")
    if clip_ratio >= 0.05:
        warnings.append(f"심각한 클리핑({clip_ratio:.3f}).")
    elif clip_ratio >= 0.001:
        warnings.append(f"클리핑 감지({clip_ratio:.3f}).")
    if rms_dbfs <= -55.0:
        warnings.append(f"거의 무음(RMS {rms_dbfs:.1f}dBFS).")

    return {"ok": True, "start_sec": round(start_sec, 3), "dur_sec": round(actual_dur, 3),
            "silence_ratio": round(sil_ratio, 4), "clipping_ratio": round(clip_ratio, 6),
            "rms_dbfs": round(rms_dbfs, 2), "peak": round(peak, 4),
            "in_range": bool(3.0 <= actual_dur <= 10.0), "warnings": warnings}


def coarse_peaks(path, buckets=400):
    """파형 렌더링용 다운샘플 peak(0..1) 배열. 전체 파일을 buckets개 구간의 최대 절댓값으로 요약."""
    import numpy as np
    mono, sr = _load_mono(path)
    n = len(mono)
    if n == 0:
        return {"ok": True, "peaks": [], "duration_sec": 0.0, "sample_rate": sr}
    b = max(1, min(buckets, n))
    idx = np.linspace(0, n, b + 1, dtype=np.int64)
    peaks = [round(float(np.abs(mono[idx[i]:idx[i + 1]]).max()) if idx[i + 1] > idx[i] else 0.0, 4)
             for i in range(b)]
    return {"ok": True, "peaks": peaks, "duration_sec": round(n / sr, 3), "sample_rate": sr}


def trim_region(path, start_sec, dur_sec, out_path):
    """선택 구간만 mono/24kHz PCM_16 WAV로 저장. 원본은 읽기만(변경 없음). 저장 경로 반환.
    실패는 명확한 예외(부분 출력은 호출부/임시폴더 정책이 정리)."""
    import soundfile as sf
    import numpy as np
    info = sf.info(path)
    sr = int(info.samplerate)
    total = int(info.frames)
    start_f = max(0, int(round(start_sec * sr)))
    n = int(round(dur_sec * sr))
    n = max(0, min(n, total - start_f))
    if n <= 0:
        raise RuntimeError("빈 구간 — 트림할 오디오가 없습니다.")
    data, _ = sf.read(path, start=start_f, frames=n, dtype="float32", always_2d=True)
    mono = data.mean(axis=1).astype("float32") if data.shape[1] > 1 else data[:, 0].astype("float32")
    if sr != TARGET_SR:
        import torch
        import torchaudio
        t = torch.from_numpy(np.ascontiguousarray(mono)).unsqueeze(0)
        t = torchaudio.functional.resample(t, sr, TARGET_SR)
        mono = t.squeeze(0).numpy()
    # 클리핑 방지 clamp 후 PCM_16
    mono = np.clip(mono, -1.0, 1.0)
    sf.write(out_path, mono, TARGET_SR, subtype="PCM_16")
    if not (os.path.exists(out_path) and os.path.getsize(out_path) > 0):
        raise RuntimeError("파생 참조 WAV 생성 실패(빈/0바이트).")
    return out_path
