# -*- coding: utf-8 -*-
"""음악 품질 P1 — 순수 정렬/앙상블/보정 모듈 (numpy만).

P0 코어(`music_separation_integrity`)가 "무엇이 잘못됐는지"를 **분류만** 하는 반면,
이 P1 모듈은 그 위에서 실제 **보정(correction)** 을 수행하는 순수 함수를 제공한다.
파일·모델·GPU·IPC·외부 API 를 전혀 건드리지 않는다 — 오직 numpy 배열과 수치만.

배열 규약(코드베이스 audio_utils.load_audio·P0 코어와 동일): **채널 우선** `(C, N)`.

이 모듈은 production 에 **자동 적용되지 않는다**. music_worker 등 기존 워커/IPC/UI 는
수정하지 않으며, 이 모듈은 순수 함수 + synthetic 테스트로만 존재한다. 향후 배선은
소비자(worker)가 명시적으로 호출해 결정한다.

핵심 설계 원칙
  1. **무익한 보정 금지 (no-op 규칙).** 개선이 측정되지 않으면 보정하지 않는다.
     이미 정렬·정합된 입력은 보정 후에도 **출력이 바뀌지 않는다(무변성)**. 모든 보정
     함수는 `applied: bool` 을 함께 반환하며 applied=False 일 때 입력을 그대로 돌려준다.
  2. **조용한 절단 금지.** 스펙 불일치·비유한값은 명시적 오류(QualityError)로 승격한다.
     (P0 철학과 동일 — min-length/min-channel 로 몰래 자르지 않는다.)
  3. **정책 결정 최소화.** 보정 적용 여부는 측정 가능한 개선 임계값(gate)으로만 정한다.
  4. 오디오 내용은 담지 않는다 — 지표는 통계·형상만.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

import numpy as np


class QualityError(ValueError):
    """P1 보정 전제(유한·스펙 일치)가 깨졌을 때 승격하는 예외 — 조용한 절단 금지."""


# ---------------------------------------------------------------------------
# 순수 수치 헬퍼 (자기완결 — 코어에 import-time 의존하지 않는다)
# ---------------------------------------------------------------------------

def _as_2d(array) -> np.ndarray:
    """입력을 채널 우선 2D `(C, N)` 으로 강제. 1D 는 모노 `(1, N)`. 3D+ 는 명시적 오류."""
    arr = np.asarray(array)
    if arr.ndim == 1:
        arr = arr[np.newaxis, :]
    elif arr.ndim != 2:
        raise QualityError(
            f"오디오 배열은 1D(모노) 또는 2D(C,N)만 허용 — 받은 차원: {arr.ndim}D, shape={arr.shape}"
        )
    return arr


def _to_mono(arr: np.ndarray) -> np.ndarray:
    """채널 우선 2D → 모노 1D (채널 평균), float64."""
    return _as_2d(arr).astype(np.float64).mean(axis=0)


def _rms(x: np.ndarray) -> float:
    x = np.asarray(x, dtype=np.float64)
    if x.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(x * x)))


def _normalized_correlation(a: np.ndarray, b: np.ndarray) -> float:
    """정규화 상관 [-1, 1]. 둘 중 하나라도 무음이면 0."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    na = float(np.sqrt(np.dot(a, a)))
    nb = float(np.sqrt(np.dot(b, b)))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def _require_finite(*arrays_with_names) -> None:
    """모든 배열이 유한한지 확인. NaN/Inf 있으면 QualityError (저장/전파 금지)."""
    for arr, name in arrays_with_names:
        a = np.asarray(arr)
        if not np.all(np.isfinite(a)):
            n_nan = int(np.count_nonzero(np.isnan(a)))
            n_inf = int(np.count_nonzero(np.isinf(a)))
            raise QualityError(
                f"{name}: 유한하지 않은 값 (NaN={n_nan}, Inf={n_inf}) — 보정 거부."
            )


def _same_shape(a2: np.ndarray, b2: np.ndarray) -> bool:
    return a2.shape == b2.shape


# ---------------------------------------------------------------------------
# 추정: offset / polarity / gain  (순수)
# ---------------------------------------------------------------------------
# 부호 규약은 P0 코어(music_separation_integrity)와 정확히 일치한다:
#   offset > 0  →  b 가 a 보다 뒤처짐 (b 를 앞당겨야 정렬).

def estimate_offset(a, b, max_lag: Optional[int] = None) -> int:
    """b 를 a 에 맞추는 최적 정수 지연(샘플)을 상호상관으로 추정. 순수 numpy."""
    am = _to_mono(a)
    bm = _to_mono(b)
    n = min(am.size, bm.size)
    if n == 0:
        return 0
    am = am[:n] - am[:n].mean()
    bm = bm[:n] - bm[:n].mean()
    if not np.any(am) or not np.any(bm):
        return 0
    if max_lag is None:
        max_lag = n - 1
    max_lag = int(min(max_lag, n - 1))
    if max_lag <= 0:
        return 0
    full = np.correlate(am, bm, mode="full")  # 길이 2n-1, 중앙 인덱스 n-1
    center = n - 1
    window = full[center - max_lag: center + max_lag + 1]
    best = int(np.argmax(np.abs(window)))
    return max_lag - best


def estimate_polarity(a, b) -> int:
    """동상(+1)/역위상(-1). 내적 부호로 판정. 순수 numpy."""
    am = _to_mono(a)
    bm = _to_mono(b)
    n = min(am.size, bm.size)
    if n == 0:
        return 1
    am = am[:n] - am[:n].mean()
    bm = bm[:n] - bm[:n].mean()
    return 1 if float(np.dot(am, bm)) >= 0 else -1


def estimate_gain(a, b) -> float:
    """a 대비 b 의 gain 비율 ||a|| / ||b|| (rms). b 무음이면 0 (inf 방지)."""
    ra = _rms(_to_mono(a))
    rb = _rms(_to_mono(b))
    if rb == 0.0:
        return 0.0
    return ra / rb


def _align_crop_mono(am: np.ndarray, bm: np.ndarray, offset: int) -> Tuple[np.ndarray, np.ndarray]:
    """offset 규약에 따라 두 모노 신호를 겹치는 구간으로 크롭 (등길이 반환)."""
    n = min(am.size, bm.size)
    am, bm = am[:n], bm[:n]
    if offset > 0:      # b 가 뒤처짐 → b 를 앞당김
        bb = bm[offset:]
        aa = am[:bb.size]
    elif offset < 0:    # b 가 앞섬
        aa = am[-offset:]
        bb = bm[:aa.size]
    else:
        aa, bb = am, bm
    m = min(aa.size, bb.size)
    return aa[:m], bb[:m]


@dataclass(frozen=True)
class AlignmentEstimate:
    """정렬 추정치. corr_raw 는 보정 전, corr_aligned 는 offset+polarity 보정 후 상관."""
    offset: int
    polarity: int
    gain_ratio: float
    corr_raw: float       # 보정 전 (원신호 그대로) 정규화 상관
    corr_aligned: float   # polarity·offset 보정 후 정규화 상관


def estimate_alignment(a, b, max_lag: Optional[int] = None) -> AlignmentEstimate:
    """offset·polarity·gain 과, 보정 전/후 상관을 한 번에 추정 (순수).

    **offset 을 먼저** 추정한다 (상호상관 절댓값 argmax 이므로 극성과 무관). 그다음
    정렬된 겹침 구간에서 polarity 를 판정한다. 극성을 정렬 전에 추정하면 offset 이 있는
    신호에서 원신호 내적이 잡음성으로 음수가 되어 거짓 역위상이 나올 수 있다."""
    am = _to_mono(a)
    bm = _to_mono(b)
    n = min(am.size, bm.size)
    if n == 0:
        return AlignmentEstimate(0, 1, 0.0, 0.0, 0.0)

    amc = am[:n] - am[:n].mean()
    bmc = bm[:n] - bm[:n].mean()
    corr_raw = _normalized_correlation(amc, bmc)

    offset = estimate_offset(am, bm, max_lag=max_lag)   # 극성 독립 (|corr| argmax)
    gain = estimate_gain(a, b)

    aa, bb = _align_crop_mono(am, bm, offset)
    if aa.size:
        aac = aa - aa.mean()
        bbc = bb - bb.mean()
        polarity = 1 if float(np.dot(aac, bbc)) >= 0 else -1
        corr_aligned = _normalized_correlation(aac, bbc * polarity)
    else:
        polarity = 1
        corr_aligned = 0.0
    return AlignmentEstimate(int(offset), int(polarity), float(gain),
                             float(corr_raw), float(corr_aligned))


# ---------------------------------------------------------------------------
# 보정 1: 스템 정렬 (polarity flip + integer offset [+ 선택적 gain match])
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AlignmentDecision:
    offset: int
    polarity: int
    gain_ratio: float
    corr_raw: float
    corr_aligned: float
    applied: bool
    reasons: Tuple[str, ...] = ()


def align_pair(
    a, b,
    max_lag: Optional[int] = None,
    min_corr_gain: float = 1e-9,
    match_gain: bool = False,
    gain_low: float = 0.5,
    gain_high: float = 2.0,
) -> Tuple[np.ndarray, np.ndarray, AlignmentDecision]:
    """b 를 a 에 정렬한 (a_out, b_out) 등길이 2D 쌍과 결정을 반환.

    보정은 **개선이 측정될 때만** 적용된다:
      - polarity/offset 보정은 정렬 후 상관(corr_aligned)이 보정 전(corr_raw)보다
        min_corr_gain 이상 커질 때만 적용. 아니면 no-op (applied=False).
      - match_gain=True 이고 gain_ratio 가 [gain_low, gain_high] 밖이면 b 를 스케일해
        a 레벨에 맞춘다 (기본 False — 현행 동작 보존).

    **무변성 보장**: 이미 정렬·동상인 입력(offset=0, polarity=+1)은 corr_aligned==corr_raw
    이므로 게이트를 통과하지 못해 no-op → 출력이 입력과 정확히 동일하다.
    비유한값·차원 불일치는 QualityError 로 승격 (조용한 처리 금지)."""
    a2 = _as_2d(a).astype(np.float64)
    b2 = _as_2d(b).astype(np.float64)
    _require_finite((a2, "a"), (b2, "b"))
    if a2.shape[0] != b2.shape[0]:
        raise QualityError(
            f"채널 수 불일치 (a={a2.shape[0]}, b={b2.shape[0]}) — 정렬 거부, 조용한 절단 금지."
        )

    est = estimate_alignment(a2, b2, max_lag=max_lag)
    reasons: List[str] = []

    # 두 보정은 서로 독립적으로 게이팅된다:
    #  - offset/polarity: 정렬 후 상관이 보정 전보다 min_corr_gain 이상 커질 때만.
    #  - gain match(opt-in): gain_ratio 가 밴드 밖일 때만 (alignment 개선과 무관).
    improves = est.corr_aligned > est.corr_raw + min_corr_gain
    do_align = improves and (est.polarity < 0 or est.offset != 0)
    do_gain = (
        match_gain and est.gain_ratio > 0
        and not (gain_low <= est.gain_ratio <= gain_high)
    )

    if not do_align and not do_gain:
        # no-op 경로: 길이만 공통 구간으로 맞춘다 (값 변경 없음). 등길이면 그대로.
        n = min(a2.shape[1], b2.shape[1])
        decision = AlignmentDecision(
            offset=est.offset, polarity=est.polarity, gain_ratio=est.gain_ratio,
            corr_raw=est.corr_raw, corr_aligned=est.corr_aligned,
            applied=False, reasons=("개선 없음 — no-op",),
        )
        return a2[:, :n], b2[:, :n], decision

    # polarity 먼저(스칼라 곱), 그다음 offset 크롭 — 순서 무관(교환 가능).
    b_corr = b2
    if do_align and est.polarity < 0:
        b_corr = b_corr * est.polarity
        reasons.append("polarity 반전 보정")

    n = min(a2.shape[1], b_corr.shape[1])
    a2c, b2c = a2[:, :n], b_corr[:, :n]
    off = est.offset
    if do_align and off > 0:
        b_out = b2c[:, off:]
        a_out = a2c[:, :b_out.shape[1]]
        reasons.append(f"offset {off} 샘플 정렬")
    elif do_align and off < 0:
        a_out = a2c[:, -off:]
        b_out = b2c[:, :a_out.shape[1]]
        reasons.append(f"offset {off} 샘플 정렬")
    else:
        a_out, b_out = a2c, b2c

    if do_gain:
        b_out = b_out * est.gain_ratio
        reasons.append(f"gain ×{est.gain_ratio:.3f} 매칭")

    decision = AlignmentDecision(
        offset=est.offset, polarity=est.polarity, gain_ratio=est.gain_ratio,
        corr_raw=est.corr_raw, corr_aligned=est.corr_aligned,
        applied=True, reasons=tuple(reasons),
    )
    return np.ascontiguousarray(a_out), np.ascontiguousarray(b_out), decision


# ---------------------------------------------------------------------------
# 보정 2: 가중 앙상블 (weighted ensemble)
# ---------------------------------------------------------------------------

def weighted_ensemble(
    stems: Sequence,
    weights: Optional[Sequence[float]] = None,
    require_equal: bool = True,
) -> np.ndarray:
    """여러 모델 출력(같은 스템)의 가중 평균. 순수.

    weights=None → 등가중(1/k) → 현행 0.5/0.5 평균과 동일.
    require_equal=True(기본) 이면 모든 배열이 정확히 같은 형상이어야 하며, 아니면
    QualityError 로 승격한다 (조용한 min-length/min-channel 절단 금지). 서로 어긋난
    입력은 먼저 align_pair 로 정렬해 등길이로 만든 뒤 넣어야 한다.

    **무변성 보장**: 동일한 스템들을 등가중으로 결합하면 결과는 그 스템과 정확히 같다."""
    stems = list(stems)
    if not stems:
        raise QualityError("stems 가 비어 있어 앙상블할 수 없다.")
    arrs = [_as_2d(s).astype(np.float64) for s in stems]
    for i, arr in enumerate(arrs):
        _require_finite((arr, f"stem#{i}"))

    ref_shape = arrs[0].shape
    for i, arr in enumerate(arrs):
        if arr.shape != ref_shape:
            if require_equal:
                raise QualityError(
                    f"stem#{i} 형상 {arr.shape} 이 기준 {ref_shape} 와 불일치 — "
                    "조용한 절단 금지 (먼저 align_pair 로 정렬 필요)."
                )
            raise QualityError("require_equal=False 는 아직 지원하지 않는다 (명시적 정렬 요구).")

    if weights is None:
        w = np.full(len(arrs), 1.0 / len(arrs), dtype=np.float64)
    else:
        w = np.asarray(weights, dtype=np.float64)
        if w.shape != (len(arrs),):
            raise QualityError(f"weights 길이 {w.shape} 가 stems 개수 {len(arrs)} 와 불일치.")
        if np.any(w < 0):
            raise QualityError("weights 에 음수가 있다.")
        s = float(w.sum())
        if s <= 0:
            raise QualityError("weights 합이 0 이하 — 정규화 불가.")
        w = w / s

    acc = np.zeros(ref_shape, dtype=np.float64)
    for wi, arr in zip(w, arrs):
        acc += wi * arr
    return acc


# ---------------------------------------------------------------------------
# 보정 3: mixture consistency correction
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class MixtureCorrectionDecision:
    relative_error_before: float
    relative_error_after: float
    applied: bool
    mode: str
    reason: str


def mixture_consistency_correct(
    mixture,
    stems: Sequence,
    max_relative_error: float = 1e-3,
    mode: str = "energy",
) -> Tuple[List[np.ndarray], MixtureCorrectionDecision]:
    """stems 합이 mixture 를 정확히 복원하도록 잔차(residual)를 스템에 분배한다.

    residual = mixture - Σ stems 를 각 스템에 나눠 더해 Σ(corrected) == mixture 가 되게 한다.
      mode="energy" : 샘플별 에너지 비율(Wiener 유사)로 분배. 무음 지점은 등분.
      mode="equal"  : 모든 스템에 균등 분배.

    **무익한 보정 금지 (no-op 규칙)**: 보정 전 상대 재구성 오차가 max_relative_error 이하면
    이미 정합된 것으로 보고 **아무것도 하지 않는다** (applied=False, 입력 그대로 반환) —
    이미 mixture 를 복원하는 입력은 출력이 바뀌지 않는다(무변성).

    주의(반증용 관찰): 이 보정은 재구성 오차를 0 으로 만들지만, 잔차에 섞인 '다른 소스'
    성분을 스템에 되돌려 넣으므로 분리도(SDR)는 오히려 나빠질 수 있다. 재구성 정합과
    분리 품질은 다른 축이며, 이 함수는 재구성 축만 보정한다. 형상 불일치·비유한값은
    QualityError 로 승격."""
    mix = _as_2d(mixture).astype(np.float64)
    stems = list(stems)
    if not stems:
        raise QualityError("stems 가 비어 있어 mixture 보정을 할 수 없다.")
    arrs = [_as_2d(s).astype(np.float64) for s in stems]
    _require_finite((mix, "mixture"), *[(a, f"stem#{i}") for i, a in enumerate(arrs)])
    for i, arr in enumerate(arrs):
        if arr.shape != mix.shape:
            raise QualityError(
                f"stem#{i} 형상 {arr.shape} 이 mixture {mix.shape} 와 불일치 — 조용한 절단 금지."
            )

    acc = np.zeros_like(mix)
    for arr in arrs:
        acc += arr
    residual = mix - acc
    m_rms = _rms(mix)
    r_rms = _rms(residual)
    rel_before = (r_rms / m_rms) if m_rms > 0 else (0.0 if r_rms == 0 else float("inf"))

    if rel_before <= max_relative_error:
        return (
            [arr.copy() for arr in arrs],
            MixtureCorrectionDecision(
                relative_error_before=rel_before, relative_error_after=rel_before,
                applied=False, mode=mode, reason="이미 정합 — no-op",
            ),
        )

    if mode == "equal":
        share = 1.0 / len(arrs)
        corrected = [arr + share * residual for arr in arrs]
    elif mode == "energy":
        # 샘플별 에너지 가중치. 분모 0(전 스템 무음) 지점은 등분으로 대체.
        eps = 1e-20
        energies = [np.square(arr) for arr in arrs]
        denom = np.zeros_like(mix)
        for e in energies:
            denom += e
        equal_share = 1.0 / len(arrs)
        corrected = []
        for arr, e in zip(arrs, energies):
            frac = np.where(denom > eps, e / (denom + eps), equal_share)
            corrected.append(arr + frac * residual)
    else:
        raise QualityError(f"알 수 없는 mode: {mode!r} (energy|equal).")

    acc2 = np.zeros_like(mix)
    for arr in corrected:
        acc2 += arr
    rel_after = (_rms(mix - acc2) / m_rms) if m_rms > 0 else 0.0
    return (
        corrected,
        MixtureCorrectionDecision(
            relative_error_before=rel_before, relative_error_after=rel_after,
            applied=True, mode=mode, reason="잔차 분배로 재구성 정합",
        ),
    )


# ---------------------------------------------------------------------------
# 품질 지표 / 반증 harness (순수, 오디오 내용 미포함)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PairQuality:
    offset: int
    polarity: int
    gain_ratio: float
    correlation: float        # 정렬 후 상관 [-1, 1]
    alignment_error: float    # 1 - correlation  (0=완벽 정렬)
    peak: float
    clipped_ratio: float


def measure_pair(a, b, max_lag: Optional[int] = None, ceiling: float = 1.0) -> PairQuality:
    """두 신호의 정합·peak·클리핑 지표. 반증/품질 비교 harness 용."""
    est = estimate_alignment(a, b, max_lag=max_lag)
    both = np.concatenate([_as_2d(a).ravel(), _as_2d(b).ravel()]).astype(np.float64)
    if both.size:
        peak = float(np.max(np.abs(both)))
        clipped = int(np.count_nonzero(np.abs(both) >= ceiling))
        clipped_ratio = clipped / both.size
    else:
        peak, clipped_ratio = 0.0, 0.0
    return PairQuality(
        offset=est.offset, polarity=est.polarity, gain_ratio=est.gain_ratio,
        correlation=est.corr_aligned, alignment_error=1.0 - est.corr_aligned,
        peak=peak, clipped_ratio=clipped_ratio,
    )


@dataclass(frozen=True)
class ReconQuality:
    residual_rms: float
    mixture_rms: float
    relative_error: float
    snr_db: float


def measure_reconstruction(mixture, stems: Sequence) -> ReconQuality:
    """mixture 와 Σstems 의 재구성 오차 지표 (mixture-consistency error)."""
    mix = _as_2d(mixture).astype(np.float64)
    arrs = [_as_2d(s).astype(np.float64) for s in stems]
    if not arrs:
        raise QualityError("stems 가 비어 있다.")
    acc = np.zeros_like(mix)
    for arr in arrs:
        if arr.shape != mix.shape:
            raise QualityError(
                f"형상 불일치 {arr.shape} vs {mix.shape} — 조용한 절단 금지."
            )
        acc += arr
    r_rms = _rms(mix - acc)
    m_rms = _rms(mix)
    rel = (r_rms / m_rms) if m_rms > 0 else (0.0 if r_rms == 0 else float("inf"))
    if r_rms == 0:
        snr = float("inf")
    elif m_rms == 0:
        snr = float("-inf")
    else:
        snr = 20.0 * float(np.log10(m_rms / r_rms))
    return ReconQuality(residual_rms=r_rms, mixture_rms=m_rms,
                        relative_error=rel, snr_db=snr)


def is_noop(before, after, atol: float = 0.0) -> bool:
    """보정 전/후 배열이 동일한지 (무변성 확인용). atol=0 이면 정확 일치.

    형상이 다르면 False. 반증 harness 의 핵심 술어 — '개선 없는 조건에서 보정이
    출력을 바꾸지 않았다'를 기계적으로 검증한다."""
    ba = _as_2d(before).astype(np.float64)
    aa = _as_2d(after).astype(np.float64)
    if ba.shape != aa.shape:
        return False
    if atol <= 0.0:
        return bool(np.array_equal(ba, aa))
    return bool(np.allclose(ba, aa, atol=atol, rtol=0.0))


def compare_quality(before: dict, after: dict) -> dict:
    """두 지표 dict 의 스칼라 차이(delta)를 계산. 반증/품질 비교 harness 용.
    개선(양수 delta) 여부를 소비자가 직접 판단하도록 delta 만 돌려준다 (정책 없음)."""
    deltas = {}
    for k in set(before) & set(after):
        vb, va = before[k], after[k]
        if isinstance(vb, (int, float)) and isinstance(va, (int, float)):
            deltas[k] = va - vb
    return deltas
