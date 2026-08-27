# -*- coding: utf-8 -*-
"""긴 참조 음성에서 3~10초 구간을 다루는 백엔드 — 오류 거부가 아니라 "참조 원본"으로 수용.

역할(엔진 무관 사실 측정 + 파생 클립 생성):
  - recommend_region(): 10초 초과 파일에서 6~8초의 '좋은 발화 구간'을 자동 추천(무음 적음·클리핑
    없음·연속 발화). 확정이 아니라 UI 기본 제안값이다(사용자가 재생·확정).
  - analyze_region(): 선택 구간의 길이·무음비율·클리핑·RMS + 경계 절단(말 도중에 끊겼는가)을
    측정하고 품질 경고를 만든다. 경계 절단은 참조 대사 혼입의 직접 원인이라 별도 필드로 낸다.
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

    # 경계 절단 계측 — 구간이 '말 도중'에 끊겼는지. 혼입(참조 대사 섞임)의 직접 원인이라
    # 무음비율·클리핑과 같은 등급의 1급 경고로 다룬다(reference_leakage 참조).
    import reference_leakage as rl
    trunc = rl.boundary_truncation(mono, sr)

    warnings = []
    if actual_dur < 3.0:
        warnings.append(f"길이 부족({actual_dur:.2f}s < 3.0s) — 구간을 늘리세요.")
    elif actual_dur > 10.0:
        warnings.append(f"길이 초과({actual_dur:.2f}s > 10.0s) — 구간을 줄이세요.")
    if trunc["tail_truncated"]:
        warnings.append("구간 끝이 말 도중입니다 — 참조 전사에는 있는데 클립에는 없는 말이 생기면 "
                        "생성 음성 앞부분에 참조 대사가 섞입니다. 말이 끝나는 지점까지 포함하세요.")
    if trunc["head_truncated"]:
        warnings.append("구간 시작이 말 도중입니다 — 말이 시작되는 지점부터 포함하세요.")
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
            "head_truncated": trunc["head_truncated"], "tail_truncated": trunc["tail_truncated"],
            "boundary_head_dbfs": trunc["head_dbfs"], "boundary_tail_dbfs": trunc["tail_dbfs"],
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


# ────────── 정렬 보장 구간 선택(참조 대사 혼입의 원인 수정, 2026-08-28) ──────────
#
# 기존 trim_region 은 "요청한 구간을 그대로 자른다". 그것이 사고의 경로였다 — 끝이 발화
# 한가운데였는데도 잘렸고, ref_text 는 그 창에 걸친 전사 세그먼트를 통째로 이어 붙였다.
# 아래 경로는 자르기 전에 reference_alignment 정책으로 경계를 보정하고, 보정이 불가능하면
# **자르지 않고 실패시킨다**(경고만 내고 통과시키지 않는다).

def detect_silences(path, min_len_sec=None, dbfs=SILENCE_DBFS,
                    frame_ms=20.0, hop_ms=10.0, start_sec=0.0, dur_sec=None):
    """파형에서 무음 구간 [(start,end), ...] 을 직접 잰다(초 단위, 홉 10ms).

    전사 타임스탬프(표시용 1초 단위일 수 있다)가 아니라 **실제 파형**을 근거로 삼는 자리다.
    이 구분이 무너지면 '일치'를 잘못 판정한다 — 이번 사고의 직접 원인이다."""
    import numpy as np
    import reference_alignment as ra
    mono, sr = _load_mono(path)
    if dur_sec is not None:
        a = max(0, int(round(start_sec * sr)))
        b = min(len(mono), a + int(round(dur_sec * sr)))
        mono, off = mono[a:b], start_sec
    else:
        off = 0.0
    if min_len_sec is None:
        min_len_sec = ra.MIN_BOUNDARY_SILENCE_SEC
    n, h = max(1, int(sr * frame_ms / 1000.0)), max(1, int(sr * hop_ms / 1000.0))
    thr = 10.0 ** (dbfs / 20.0)
    k = max(0, (len(mono) - n) // h + 1)
    active = np.empty(k, dtype=bool)
    for i in range(k):
        w = mono[i * h:i * h + n]
        active[i] = math.sqrt(float(np.square(w, dtype=np.float64).mean())) >= thr
    out, s = [], None
    for i in range(k):
        if not active[i] and s is None:
            s = i
        elif active[i] and s is not None:
            out.append((off + s * hop_ms / 1000.0, off + i * hop_ms / 1000.0))
            s = None
    if s is not None:
        out.append((off + s * hop_ms / 1000.0, off + (k * hop_ms / 1000.0)))
    return [(round(a, 4), round(b, 4)) for a, b in out if (b - a) >= min_len_sec]


def plan_aligned_region(path, requested_start_sec, requested_dur_sec, segments,
                        min_sec=None, max_sec=None):
    """요청 구간 + 전사 세그먼트 → 정렬이 보장된 계획. 자르지는 않는다(계획만)."""
    import reference_alignment as ra
    import soundfile as sf
    info = sf.info(path)
    total_sec = float(info.frames) / float(info.samplerate)
    sil = detect_silences(path)
    return ra.plan_reference_region(
        requested_start_sec, requested_start_sec + requested_dur_sec, segments, sil,
        min_sec=ra.MIN_CLIP_SEC if min_sec is None else min_sec,
        max_sec=ra.MAX_CLIP_SEC if max_sec is None else max_sec,
        source_duration=total_sec)


def build_aligned_reference(path, requested_start_sec, requested_dur_sec, segments, out_path,
                            min_sec=None, max_sec=None):
    """정렬 보장 참조 클립 + ref_text 를 만든다. **fail-closed** — 계획이 실패하면 예외.

    반환 (out_path, plan). plan['ref_text'] 는 클립에 완전히 들어간 세그먼트만으로 만들어졌고,
    plan 은 assert_alignment 를 통과한 것만 돌아온다. 예외가 나면 합성을 시작하면 안 된다."""
    import numpy as np
    import reference_alignment as ra
    plan = plan_aligned_region(path, requested_start_sec, requested_dur_sec, segments,
                              min_sec=min_sec, max_sec=max_sec)
    ra.assert_alignment(plan)                      # 실패면 여기서 AlignmentError
    trim_region(path, plan["clip_start"], plan["clip_end"] - plan["clip_start"], out_path)
    # 만들어진 클립이 실제로 말 도중에 끊기지 않았는지 파형으로 다시 확인(계획과 산출물의 대조).
    import reference_leakage as rl
    mono, sr = _load_mono(out_path)
    b = rl.boundary_truncation(np.asarray(mono, dtype=np.float64), sr)
    plan["clip_boundary_check"] = b
    if b["head_truncated"] or b["tail_truncated"]:
        raise ra.AlignmentError(
            "CLIP_BOUNDARY_STILL_TRUNCATED",
            f"head={b['head_dbfs']}dBFS tail={b['tail_dbfs']}dBFS")
    return out_path, plan
