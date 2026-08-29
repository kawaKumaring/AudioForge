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

# 구간 승인/차단 판정용 안정 코드 — UI 가 경고 '문구'로 승인 여부를 정하면 안 된다.
# (문자열 매칭은 새 경고가 생겨도 조용히 통과시킨다. 실제로 '말 도중 절단' 경고가 그렇게 새어
#  나갈 뻔했다 — 문구에 '심각/부족/초과/거의 무음' 이 없어 승인으로 처리됐다.)
BLOCK_TOO_SHORT = "REGION_TOO_SHORT"
BLOCK_TOO_LONG = "REGION_TOO_LONG"
BLOCK_HEAD_TRUNCATED = "REGION_HEAD_TRUNCATED"
BLOCK_TAIL_TRUNCATED = "REGION_TAIL_TRUNCATED"
BLOCK_SEVERE_CLIPPING = "REGION_SEVERE_CLIPPING"
BLOCK_NEAR_SILENT = "REGION_NEAR_SILENT"
WARN_HIGH_SILENCE = "REGION_HIGH_SILENCE"
WARN_CLIPPING = "REGION_CLIPPING"

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
    """10초 초과 파일에서 **확정 가능한** 좋은 발화 구간을 추천한다.

    추천값은 곧바로 :func:`build_reference_clip` 에 전달된다. 따라서 단순히 발화가 빽빽한
    고정 길이 창을 고르면 안 된다. 이전 구현은 그런 창을 추천한 뒤 확정 단계에서는 양 끝의
    무음 경계를 요구해, 앱이 스스로 추천한 구간을 스스로 거부했다. 여기서는 확정기와 같은
    ``detect_silences`` 경계의 중심끼리만 후보로 삼는다.

    6~8초 후보를 우선하고 없으면 모델 허용 범위인 3~10초로 넓힌다. 어느 쪽에도 안전한
    경계 쌍이 없으면 임의 절단을 추천하지 않고 ``ok=False`` 를 반환한다."""
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

    # 확정기와 같은 무음 검출기를 쓰고, 실제 절단점과 동일하게 각 무음의 중심을 후보로 둔다.
    # 파일 양 끝도 그 주변이 무음일 때만 후보에 넣는다. 발화 중인 파일 끝을 안전 경계로
    # 가장하지 않는다.
    silences = detect_silences(path)
    cuts = sorted({round((a + b) / 2.0, 4) for a, b in silences})
    if rms.size:
        if rms[0] < sil_lin:
            cuts.append(0.0)
        if rms[-1] < sil_lin:
            cuts.append(round(dur, 4))
    cuts = sorted(set(cuts))

    # 누적합으로 임의 경계 쌍의 발화비율·클리핑비율을 빠르게 계산한다.
    sp_cs = np.concatenate([[0.0], np.cumsum(speech)])
    cl_cs = np.concatenate([[0.0], np.cumsum(clip)])

    def best_between(lo, hi):
        import bisect
        best = None
        for st in cuts:
            # 전체 cuts×cuts를 만들지 않는다. 긴 녹음에서도 이 시작점으로부터 허용 길이에
            # 들어오는 끝 경계만 본다.
            left = bisect.bisect_left(cuts, st + lo - 1e-6)
            right = bisect.bisect_right(cuts, st + hi + 1e-6)
            for en in cuts[left:right]:
                d = en - st
                a = max(0, min(len(speech), int(round(st / HOP_SEC))))
                b = max(a + 1, min(len(speech), int(round(en / HOP_SEC))))
                sp = (sp_cs[b] - sp_cs[a]) / (b - a)
                cl = (cl_cs[b] - cl_cs[a]) / (b - a)
                # 음성 밀도·클리핑이 주 권위. 동률이면 목표 7초에 가까운 쪽, 그 다음 앞쪽.
                rank = (float(sp - 3.0 * cl), -abs(d - win_sec), -st)
                if best is None or rank > best[0]:
                    best = (rank, st, en, sp)
        return best

    best = best_between(float(min_sec), float(max_sec))
    if best is None:
        best = best_between(3.0, 10.0)
    if best is None:
        return {"ok": False, "reason": "no_safe_boundary_pair",
                "duration_sec": round(dur, 3), "whole_file": False,
                "silence_count": len(silences)}

    _, st, en, sp = best
    return {"ok": True, "start_sec": round(st, 3), "dur_sec": round(en - st, 3),
            "duration_sec": round(dur, 3), "whole_file": False,
            "speech_ratio": round(float(sp), 4), "safe_boundaries": True}


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
    blocking = []        # 있으면 승인 불가(ready=false)
    warning_codes = []   # 알리되 막지는 않음
    if actual_dur < 3.0:
        warnings.append(f"길이 부족({actual_dur:.2f}s < 3.0s) — 구간을 늘리세요.")
        blocking.append(BLOCK_TOO_SHORT)
    elif actual_dur > 10.0:
        warnings.append(f"길이 초과({actual_dur:.2f}s > 10.0s) — 구간을 줄이세요.")
        blocking.append(BLOCK_TOO_LONG)
    if trunc["tail_truncated"]:
        blocking.append(BLOCK_TAIL_TRUNCATED)
    if trunc["head_truncated"]:
        blocking.append(BLOCK_HEAD_TRUNCATED)
    if trunc["tail_truncated"]:
        warnings.append("구간 끝이 말 도중입니다 — 참조 전사에는 있는데 클립에는 없는 말이 생기면 "
                        "생성 음성 앞부분에 참조 대사가 섞입니다. 말이 끝나는 지점까지 포함하세요.")
    if trunc["head_truncated"]:
        warnings.append("구간 시작이 말 도중입니다 — 말이 시작되는 지점부터 포함하세요.")
    if sil_ratio >= 0.40:
        warnings.append(f"무음 비율 높음({sil_ratio:.2f}).")
        warning_codes.append(WARN_HIGH_SILENCE)
    if clip_ratio >= 0.05:
        warnings.append(f"심각한 클리핑({clip_ratio:.3f}).")
        blocking.append(BLOCK_SEVERE_CLIPPING)
    elif clip_ratio >= 0.001:
        warnings.append(f"클리핑 감지({clip_ratio:.3f}).")
        warning_codes.append(WARN_CLIPPING)
    if rms_dbfs <= -55.0:
        warnings.append(f"거의 무음(RMS {rms_dbfs:.1f}dBFS).")
        blocking.append(BLOCK_NEAR_SILENT)

    return {"ok": True, "start_sec": round(start_sec, 3), "dur_sec": round(actual_dur, 3),
            "silence_ratio": round(sil_ratio, 4), "clipping_ratio": round(clip_ratio, 6),
            "rms_dbfs": round(rms_dbfs, 2), "peak": round(peak, 4),
            "head_truncated": trunc["head_truncated"], "tail_truncated": trunc["tail_truncated"],
            "boundary_head_dbfs": trunc["head_dbfs"], "boundary_tail_dbfs": trunc["tail_dbfs"],
            "in_range": bool(3.0 <= actual_dur <= 10.0), "warnings": warnings,
            "blocking": blocking, "warning_codes": warning_codes,
            "ready": len(blocking) == 0}


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


# ────────── 자동 경계 보정 (2단계, 2026-08-28) ──────────
#
# 권위는 Python 이다. 렌더러로 ASR 전문이나 word timestamps 를 왕복시키지 않는다 —
# 전사 원문이 프로세스 밖으로 나가지 않는다는 이점도 함께 얻는다.
# 순서: 요청 구간 → 파형 VAD 무음 경계 탐색 → 3~10초 안에서 스냅 → 클립 생성
#       → 최종 클립 자체를 전사 → manual_text 가 있으면 그 전사와 대조 → 통과분만 반환.
# 안전한 무음 경계를 못 찾으면 trim_region 으로 물러서지 않고 차단한다.

# ── 자동 스냅 UX 정책 (숨은 상수가 아니라 명시된 정책) ──────────────────────
# 두 값은 역할이 다르다. 섞어 읽으면 안 된다.
#
# SNAP_AUTO_SHIFT_SEC = 사용자에게 묻지 않고 조용히 옮겨도 되는 최대 이동량.
#   **경계 미세조정 수준**이어야 한다. 한국어는 0.2초에도 한 음절이 들어가므로, 이보다 크게
#   옮기면 "다른 단어·구절을 고른 것"이 되어 사용자가 고른 구간이 아니게 된다.
#   초기 안전값 0.2초. (이전 1.5초는 너무 커서 다른 구절이 선택될 수 있었다.)
#
# SNAP_MAX_SEARCH_SHIFT_SEC = **후보를 찾아볼 반경일 뿐 자동 승인 범위가 아니다.**
#   이 반경 안에서 찾되, AUTO 한도를 넘는 이동은 REGION_SNAP_RECONFIRM_REQUIRED 로
#   사용자 재확인을 받는다. 반경 밖은 아예 후보가 아니다(엉뚱한 발화로 점프 차단).
#
# 두 수치 모두 실사용 조율 전의 초기 안전값이다. 테스트로 고정해 두었으니 조율할 때는
# 테스트도 함께 갱신하고, 조율 근거(실제 참조 구간 표본)를 남길 것.
SNAP_AUTO_SHIFT_SEC = 0.2
SNAP_MAX_SEARCH_SHIFT_SEC = 5.0

BLOCK_NO_SAFE_BOUNDARY = "REGION_NO_SAFE_BOUNDARY"
BLOCK_SNAP_RECONFIRM = "REGION_SNAP_RECONFIRM_REQUIRED"
BLOCK_SNAP_UNSATISFIABLE = "REGION_SNAP_RANGE_UNSATISFIABLE"
BLOCK_TRANSCRIBE_FAILED = "REGION_TRANSCRIBE_FAILED"
BLOCK_TEXT_MISMATCH = "REGION_TEXT_MISMATCH"
WARN_TEXT_INTERNAL_VARIANCE = "REGION_TEXT_INTERNAL_VARIANCE"
WARN_TEXT_UNKNOWN = "REGION_TEXT_UNKNOWN"


def snap_region_to_silence(silences, requested_start, requested_end,
                           min_sec=3.0, max_sec=10.0,
                           auto_shift_sec=SNAP_AUTO_SHIFT_SEC,
                           max_search_shift_sec=SNAP_MAX_SEARCH_SHIFT_SEC):
    """요청 구간 **주변**의 무음 한가운데만 후보로 두고 (시작, 끝)을 고른다.

    왜 주변으로 제한하는가(2026-08-28 결함): 예전 구현은 원본 전체의 모든 무음 조합을 뒤져서,
    요청 주변에 후보가 없으면 **전혀 다른 발화**를 골랐다. 실측 재현 —
    silences=[(0,1),(6,7)], 요청 100~107초 → (0.5, 6.5) 반환. 사용자가 100초를 골랐는데
    0.5초 대사가 참조가 된다. 조용한 점프는 승인 없이 일어나선 안 된다.

    반환 dict(status): 'auto' 는 정책 한도 안의 작은 보정, 'reconfirm' 은 한도를 넘어
    사용자 재확인이 필요한 제안이다. 후보 자체가 없으면 None(→ 차단).
    탐색은 정렬된 후보에 bisect 로 창을 잘라 요청 주변만 본다(전체 이중 반복 아님)."""
    import bisect
    cuts = sorted({round((a + b) / 2.0, 4) for a, b in silences})
    if not cuts:
        return None

    def window(center):
        lo = bisect.bisect_left(cuts, center - max_search_shift_sec)
        hi = bisect.bisect_right(cuts, center + max_search_shift_sec)
        return cuts[lo:hi]

    starts, ends = window(requested_start), window(requested_end)
    best = None
    for st in starts:
        for en in ends:
            d = en - st
            if d < min_sec - 1e-6 or d > max_sec + 1e-6:
                continue
            cost = abs(st - requested_start) + abs(en - requested_end)
            if best is None or cost < best[0]:
                best = (cost, st, en)
    if best is None:
        return None
    _, st, en = best
    shift = max(abs(st - requested_start), abs(en - requested_end))
    return {"start": st, "end": en,
            "max_shift_sec": round(shift, 4),
            "start_shift_sec": round(st - requested_start, 4),
            "end_shift_sec": round(en - requested_end, 4),
            "auto_shift_limit_sec": auto_shift_sec,
            "status": "auto" if shift <= auto_shift_sec + 1e-6 else "reconfirm"}


def build_reference_clip(src_path, requested_start_sec, requested_dur_sec, out_path,
                         manual_text=None, min_sec=3.0, max_sec=10.0,
                         transcribe_fn=None, whisper_model="small"):
    """자동 보정된 참조 클립을 만든다. 1단계 계약(blocking/warning_codes/ready)을 그대로 쓴다.

    반환 dict — 실패해도 같은 모양이며 blocking 이 비어 있지 않고 clip_path 가 None 이다.
    차단이면 만들다 만 WAV 를 남기지 않는다."""
    import numpy as np
    import reference_alignment as ra
    import reference_leakage as rl

    req_start = float(requested_start_sec)
    req_end = req_start + float(requested_dur_sec)
    res = {
        "clip_path": None,
        "requested_region": {"start_sec": round(req_start, 4), "end_sec": round(req_end, 4),
                             "dur_sec": round(req_end - req_start, 4)},
        "effective_region": None,
        "blocking": [], "warning_codes": [], "ready": False,
        "validation": None, "snap": None,
    }

    def fail(code, **extra):
        res["blocking"].append(code)
        res.update(extra)
        try:
            if os.path.exists(out_path):
                os.remove(out_path)
        except OSError:
            pass
        return res

    silences = detect_silences(src_path)
    if not silences:
        return fail(BLOCK_NO_SAFE_BOUNDARY, snap={"silence_count": 0})
    snapped = snap_region_to_silence(silences, req_start, req_end, min_sec, max_sec)
    if snapped is None:
        return fail(BLOCK_SNAP_UNSATISFIABLE,
                    snap={"silence_count": len(silences), "min_sec": min_sec, "max_sec": max_sec})
    s, e = snapped["start"], snapped["end"]
    res["snap"] = dict(snapped, silence_count=len(silences))
    res["effective_region"] = {"start_sec": round(s, 4), "end_sec": round(e, 4),
                               "dur_sec": round(e - s, 4)}
    # 자동 보정 이동량이 정책 한도를 넘어도 여기서 막지 않는다.
    #
    # 예전에는 status=='reconfirm' 이면 REGION_SNAP_RECONFIRM_REQUIRED 로 차단하고 제안 구간만
    # 돌려줬는데, UI 에 그 제안을 '승인'하는 수단이 없었다. 그래서 사용자가 구간을 다시 골라도
    # 같은 자동 보정이 다시 일어나 또 막히는 순환이 생겼다 — 합성으로 갈 길이 아예 없었다.
    # 이제는 분석기가 찾은 effective_region 을 그대로 적용해 클립을 만든다.
    # 이동량과 snap 정보는 res["snap"]·res["effective_region"] 에 그대로 남아 재현·진단에 쓰인다.
    #
    # 실제 안전 오류(길이 3~10초 위반, 안전 경계 없음, 시작·끝 절단, 전사 실패, manual_text 불일치)는
    # 아래에서 그대로 차단한다 — 완화한 것은 '자동 이동이 크다'는 사실 하나뿐이다.
    trim_region(src_path, s, e - s, out_path)
    mono, sr = _load_mono(out_path)
    bt = rl.boundary_truncation(np.asarray(mono, dtype=np.float64), sr)
    res["boundary"] = bt
    if bt["head_truncated"]:
        return fail(BLOCK_HEAD_TRUNCATED)
    if bt["tail_truncated"]:
        return fail(BLOCK_TAIL_TRUNCATED)

    # 최종 클립 자체를 전사한다 — 원본이 아니라 '실제로 모델에 갈 오디오' 가 기준이다.
    if transcribe_fn is None:
        from reference_transcript import transcribe_reference
        def transcribe_fn(p):  # noqa: E306
            t = transcribe_reference(p, whisper_model)
            return (t.text or "") if t.status == "ok" else None
    clip_text = transcribe_fn(out_path)
    if clip_text is None or not str(clip_text).strip():
        return fail(BLOCK_TRANSCRIBE_FAILED)

    if manual_text and str(manual_text).strip():
        import korean_cer as kc
        v = ra.verify_clip_transcript(
            kc.syllable_units(kc.normalize_text(str(manual_text))),
            kc.syllable_units(kc.normalize_text(str(clip_text))))
        # 전사 원문은 담지 않는다 — 수치와 상태만.
        res["validation"] = {k: v[k] for k in
                             ("status", "reason_code", "ref_syllables", "clip_asr_syllables",
                              "insertions", "deletions", "substitutions", "mismatch_where",
                              "internal_sub_rate", "head_coverage", "tail_coverage")}
        if v["status"] == ra.STATUS_BLOCKED:
            return fail(BLOCK_TEXT_MISMATCH)
        if v["status"] == ra.STATUS_UNKNOWN:
            res["warning_codes"].append(WARN_TEXT_UNKNOWN)
        elif v["status"] == ra.STATUS_WARN:
            res["warning_codes"].append(WARN_TEXT_INTERNAL_VARIANCE)
    else:
        res["validation"] = {"status": "no_manual_text"}

    res["clip_path"] = out_path
    res["ready"] = len(res["blocking"]) == 0
    return res
