# -*- coding: utf-8 -*-
"""음악 분리 P0 무결성 코어 — 순수 함수 모듈 (numpy만).

이 모듈은 파일·모델·GPU·IPC를 전혀 건드리지 않는다. 오직 numpy 배열과
수치만 다루는 순수 함수로, 음악 분리(Demucs / RoFormer 앙상블) 파이프라인이
"조용히 잘못된 출력을 내보내는" 사고를 막기 위한 검증 원시(primitive)를 제공한다.

배열 규약(코드베이스 audio_utils.load_audio와 동일): **채널 우선** `(C, N)`.
  C = 채널 수(모노=1, 스테레오=2), N = 샘플 수.

핵심 설계 원칙
  1. 조용한 절단(truncate) 금지. min-length / min-channel 로 몰래 자르는 대신,
     불일치는 **명시적 실패(Verdict.FAIL)** 로 신호한다.
  2. 정책 결정을 하지 않는다. 이 모듈은 "무엇이 잘못됐는지"를 타입으로 분류만 하며,
     자동 fallback 을 구현하거나 0.5/0.5 앙상블 정책을 바꾸지 않는다.
  3. "명시적 실패" 와 "single-model fallback 후보" 를 **타입(Verdict)** 으로 구분한다.
     - FAIL              : 무결성이 확정적으로 깨짐. 그대로 진행하면 출력이 손상되거나
                            절단이 은폐된다 (NaN/Inf, 스펙 불일치, 하드 클리핑).
     - FALLBACK_CANDIDATE: 앙상블(결합) 자체가 신뢰 불가지만 개별 스템은 멀쩡할 수 있어
                            단일 모델 경로가 후보가 되는 신호 (역위상, 큰 offset,
                            큰 gain 발산, 나쁜 mixture 재구성). *결정은 소비자 몫.*
  4. 오디오 내용은 manifest/지문에 담지 않는다. 가중치·설정·모델 파일 지문은
     해시·크기만, 오디오 배열은 형상·dtype 만 (샘플 값 없음).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Optional, Sequence

import numpy as np


# ---------------------------------------------------------------------------
# 판정 어휘 (정책 아님 — 분류만)
# ---------------------------------------------------------------------------

class Verdict(IntEnum):
    """검사 결과 심각도. 정수 순서로 '최악' 집계가 가능하다 (OK < 후보 < 실패)."""
    OK = 0
    FALLBACK_CANDIDATE = 1
    FAIL = 2


@dataclass(frozen=True)
class CheckResult:
    """단일 검사의 결과. verdict 로 심각도를, metrics 로 근거 수치를 담는다.

    code    : 기계 판독용 안정 식별자 (예: "finite", "spec_match").
    verdict : Verdict.
    message : 사람이 읽는 설명 (한국어).
    metrics : 근거가 되는 수치 dict (오디오 샘플 값은 넣지 않는다 — 통계·형상만).
    """
    code: str
    verdict: Verdict
    message: str
    metrics: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.verdict == Verdict.OK

    @property
    def failed(self) -> bool:
        return self.verdict == Verdict.FAIL


@dataclass
class IntegrityReport:
    """여러 CheckResult 의 집합. 소비자는 failures / fallback_candidates 를
    구분해서 읽고 정책을 스스로 결정한다 (이 모듈은 결정하지 않는다)."""
    checks: list = field(default_factory=list)

    def add(self, result: CheckResult) -> "IntegrityReport":
        self.checks.append(result)
        return self

    @property
    def verdict(self) -> Verdict:
        if not self.checks:
            return Verdict.OK
        return max(c.verdict for c in self.checks)

    @property
    def ok(self) -> bool:
        return self.verdict == Verdict.OK

    @property
    def failures(self) -> list:
        return [c for c in self.checks if c.verdict == Verdict.FAIL]

    @property
    def fallback_candidates(self) -> list:
        return [c for c in self.checks if c.verdict == Verdict.FALLBACK_CANDIDATE]


class IntegrityError(ValueError):
    """무결성 위반을 예외로 승격할 때 사용. code/report 를 함께 전달한다."""

    def __init__(self, message: str, report: Optional[IntegrityReport] = None):
        super().__init__(message)
        self.report = report


# ---------------------------------------------------------------------------
# 형상 · 스펙
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AudioSpec:
    """오디오 배열의 비민감 형상 기술자. **샘플 값은 담지 않는다.**"""
    sample_rate: int
    channels: int
    length: int          # 샘플 수 (프레임 수)
    dtype: str

    @property
    def duration_sec(self) -> float:
        return self.length / self.sample_rate if self.sample_rate else 0.0


def _as_2d(array) -> np.ndarray:
    """입력을 채널 우선 2D `(C, N)` numpy 배열로 강제. 1D 는 모노 `(1, N)` 로 승격.
    3D 이상·0D 는 명시적 오류 (조용한 reshape 금지)."""
    arr = np.asarray(array)
    if arr.ndim == 1:
        arr = arr[np.newaxis, :]
    elif arr.ndim != 2:
        raise IntegrityError(
            f"오디오 배열은 1D(모노) 또는 2D(C,N)만 허용 — 받은 차원: {arr.ndim}D, shape={arr.shape}"
        )
    return arr


def describe_audio(array, sample_rate: int) -> AudioSpec:
    """배열 + sample_rate 로부터 AudioSpec 을 만든다 (순수, 내용 미포함)."""
    arr = _as_2d(array)
    return AudioSpec(
        sample_rate=int(sample_rate),
        channels=int(arr.shape[0]),
        length=int(arr.shape[1]),
        dtype=str(arr.dtype),
    )


# ---------------------------------------------------------------------------
# 검사 1: finite (NaN / Inf 없음)
# ---------------------------------------------------------------------------

def check_finite(array, name: str = "audio") -> CheckResult:
    """배열에 NaN·Inf 가 없는지 검사. 있으면 FAIL (데이터 손상 — 그대로 저장 금지)."""
    arr = _as_2d(array)
    nan_count = int(np.count_nonzero(np.isnan(arr)))
    inf_count = int(np.count_nonzero(np.isinf(arr)))
    metrics = {"nan": nan_count, "inf": inf_count, "total": int(arr.size)}
    if nan_count or inf_count:
        return CheckResult(
            "finite", Verdict.FAIL,
            f"{name}: 유한하지 않은 값 감지 (NaN={nan_count}, Inf={inf_count}) — 저장/전파 금지.",
            metrics,
        )
    return CheckResult("finite", Verdict.OK, f"{name}: 모든 값이 유한.", metrics)


# ---------------------------------------------------------------------------
# 검사 2: 스펙 일치 (sample rate / channels / length) — 조용한 절단 금지
# ---------------------------------------------------------------------------

def check_spec_match(
    specs: Sequence[AudioSpec],
    labels: Optional[Sequence[str]] = None,
    length_tolerance: int = 0,
) -> CheckResult:
    """여러 스펙이 서로 일치하는지 검사.

    sample_rate·channels 는 항상 정확히 일치해야 한다. length 는
    length_tolerance(샘플) 이내면 허용 — 기본값 0(엄격). 불일치는 **FAIL**.
    (min-length / min-channel 로 조용히 잘라 넘어가는 것을 막기 위함이며,
    tolerance 는 '메커니즘'일 뿐 정책 결정이 아니다 — 소비자가 넘겨준다.)
    """
    if len(specs) < 2:
        return CheckResult(
            "spec_match", Verdict.OK,
            "스펙이 1개 이하 — 비교 불필요.",
            {"count": len(specs)},
        )
    labels = list(labels) if labels is not None else [f"#{i}" for i in range(len(specs))]

    ref = specs[0]
    sr_set = sorted({s.sample_rate for s in specs})
    ch_set = sorted({s.channels for s in specs})
    lengths = [s.length for s in specs]
    length_spread = max(lengths) - min(lengths)

    metrics = {
        "sample_rates": sr_set,
        "channels": ch_set,
        "lengths": lengths,
        "length_spread": int(length_spread),
        "length_tolerance": int(length_tolerance),
    }

    problems = []
    if len(sr_set) > 1:
        problems.append(f"sample_rate 불일치 {sr_set}")
    if len(ch_set) > 1:
        problems.append(f"channel 수 불일치 {ch_set}")
    if length_spread > length_tolerance:
        pairs = ", ".join(f"{l}={s.length}" for l, s in zip(labels, specs))
        problems.append(
            f"length 불일치 (편차 {length_spread} > 허용 {length_tolerance} 샘플; {pairs})"
        )

    if problems:
        return CheckResult(
            "spec_match", Verdict.FAIL,
            "스펙 불일치 — 조용한 절단 금지, 명시적 실패: " + "; ".join(problems),
            metrics,
        )
    return CheckResult(
        "spec_match", Verdict.OK,
        f"스펙 일치 (sr={ref.sample_rate}, ch={ref.channels}, len≈{ref.length}).",
        metrics,
    )


# ---------------------------------------------------------------------------
# 내부 수치 헬퍼
# ---------------------------------------------------------------------------

def _to_mono(arr: np.ndarray) -> np.ndarray:
    """채널 우선 2D → 모노 1D (채널 평균), float64."""
    return arr.astype(np.float64).mean(axis=0)


def _rms(x: np.ndarray) -> float:
    x = np.asarray(x, dtype=np.float64)
    if x.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(x * x)))


# ---------------------------------------------------------------------------
# 검사 3: 스템 간 정합 (offset / polarity / gain)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AlignmentReport:
    """두 신호(예: 앙상블 두 모델의 같은 스템)의 정합 상태."""
    offset: int          # b 를 a 에 맞추기 위한 최적 지연 (샘플). +면 b 가 뒤처짐.
    polarity: int        # +1 동상, -1 역위상
    gain_ratio: float    # ||a|| / ||b|| (rms 기준)
    correlation: float   # 최적 offset·극성 정렬 후 정규화 상관 [-1, 1]


def estimate_offset(a, b, max_lag: Optional[int] = None) -> int:
    """b 를 a 에 맞추는 최적 정수 지연(샘플)을 상호상관으로 추정.
    반환 > 0 이면 b 가 a 보다 뒤처져 있다(b 를 앞당겨야 정렬). 순수 numpy."""
    am = _to_mono(_as_2d(a))
    bm = _to_mono(_as_2d(b))
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
    full = np.correlate(am, bm, mode="full")   # 길이 2n-1, 중앙 인덱스 n-1
    center = n - 1
    lo = center - max_lag
    hi = center + max_lag + 1
    window = full[lo:hi]
    best = int(np.argmax(np.abs(window)))
    # np.correlate 의 lag 부호는 우리 규약(>0 이면 b 가 a 보다 뒤처짐)과 반대라 뒤집는다.
    return max_lag - best


def estimate_polarity(a, b) -> int:
    """두 신호가 동상(+1)인지 역위상(-1)인지. 내적 부호로 판정. 순수 numpy.
    역위상은 앙상블 평균 시 신호가 상쇄되므로 중요한 신호다."""
    am = _to_mono(_as_2d(a))
    bm = _to_mono(_as_2d(b))
    n = min(am.size, bm.size)
    if n == 0:
        return 1
    am = am[:n] - am[:n].mean()
    bm = bm[:n] - bm[:n].mean()
    dot = float(np.dot(am, bm))
    return 1 if dot >= 0 else -1


def estimate_gain(a, b) -> float:
    """a 대비 b 의 gain 비율 ||a|| / ||b|| (rms). b 가 무음이면 inf 방지로 0 반환."""
    ra = _rms(_to_mono(_as_2d(a)))
    rb = _rms(_to_mono(_as_2d(b)))
    if rb == 0.0:
        return 0.0
    return ra / rb


def _normalized_correlation(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = _rms(a), _rms(b)
    if na == 0.0 or nb == 0.0:
        return 0.0
    return float(np.dot(a, b) / (np.sqrt(np.dot(a, a)) * np.sqrt(np.dot(b, b))))


def analyze_alignment(a, b, max_lag: Optional[int] = None) -> AlignmentReport:
    """두 신호의 offset·polarity·gain·정렬 후 상관을 한 번에 계산 (순수)."""
    am = _to_mono(_as_2d(a))
    bm = _to_mono(_as_2d(b))
    polarity = estimate_polarity(am, bm)
    offset = estimate_offset(am, bm * polarity, max_lag=max_lag)
    gain = estimate_gain(am, bm)

    # 정렬(offset 보정) 후 상관 계산
    ab = bm * polarity
    if offset > 0:      # b 가 뒤처짐 → b 를 앞당겨 정렬
        bb = ab[offset:]
        aa = am[: bb.size]
    elif offset < 0:    # b 가 앞섬
        aa = am[-offset:]
        bb = ab[: aa.size]
    else:
        m = min(am.size, ab.size)
        aa, bb = am[:m], ab[:m]
    m = min(aa.size, bb.size)
    corr = _normalized_correlation(aa[:m] - aa[:m].mean(), bb[:m] - bb[:m].mean()) if m else 0.0

    return AlignmentReport(offset=int(offset), polarity=int(polarity),
                           gain_ratio=float(gain), correlation=float(corr))


def check_stem_alignment(
    a, b,
    label: str = "stem",
    max_offset: int = 64,
    gain_low: float = 0.5,
    gain_high: float = 2.0,
    max_lag: Optional[int] = None,
) -> CheckResult:
    """앙상블 두 멤버(같은 스템)의 정합을 검사.

    - 역위상(polarity=-1)  → FALLBACK_CANDIDATE (평균 시 상쇄, 결합 신뢰 불가).
    - |offset| > max_offset → FALLBACK_CANDIDATE (시간 어긋남, 평균 시 번짐).
    - gain_ratio 가 [gain_low, gain_high] 밖 → FALLBACK_CANDIDATE (레벨 발산).
    어느 것도 하드 FAIL 이 아니다 — 개별 스템은 멀쩡할 수 있어 단일 모델이 '후보'.
    """
    rep = analyze_alignment(a, b, max_lag=max_lag)
    metrics = {
        "offset": rep.offset, "polarity": rep.polarity,
        "gain_ratio": round(rep.gain_ratio, 6), "correlation": round(rep.correlation, 6),
        "max_offset": max_offset, "gain_low": gain_low, "gain_high": gain_high,
    }
    reasons = []
    if rep.polarity < 0:
        reasons.append("역위상(polarity=-1)")
    if abs(rep.offset) > max_offset:
        reasons.append(f"offset {rep.offset} 샘플 > 허용 {max_offset}")
    if not (gain_low <= rep.gain_ratio <= gain_high):
        reasons.append(f"gain_ratio {rep.gain_ratio:.3f} ∉ [{gain_low}, {gain_high}]")

    if reasons:
        return CheckResult(
            "stem_alignment", Verdict.FALLBACK_CANDIDATE,
            f"{label}: 앙상블 멤버 정합 불량 — " + "; ".join(reasons)
            + " → 결합 대신 단일 모델 후보.",
            metrics,
        )
    return CheckResult(
        "stem_alignment", Verdict.OK,
        f"{label}: 정합 양호 (offset={rep.offset}, polarity=+1, gain={rep.gain_ratio:.3f}).",
        metrics,
    )


# ---------------------------------------------------------------------------
# 검사 4: mixture consistency (stems 합 ≈ mixture) + 재구성 오차
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ReconstructionReport:
    residual_rms: float
    mixture_rms: float
    relative_error: float      # residual_rms / mixture_rms
    snr_db: float              # 20*log10(mixture_rms / residual_rms)


def analyze_reconstruction(mixture, stems: Sequence) -> ReconstructionReport:
    """mixture 와 stems 합의 잔차(residual)를 계산 (순수).
    호출 전 스펙 일치가 보장돼야 한다 — 형상이 다르면 IntegrityError."""
    mix = _as_2d(mixture).astype(np.float64)
    if not stems:
        raise IntegrityError("stems 가 비어 있어 재구성 검사를 할 수 없다.")
    acc = None
    for i, s in enumerate(stems):
        s2 = _as_2d(s).astype(np.float64)
        if s2.shape != mix.shape:
            raise IntegrityError(
                f"stem #{i} 형상 {s2.shape} 이 mixture {mix.shape} 와 불일치 — "
                "조용한 절단 금지 (먼저 check_spec_match 로 걸러야 함)."
            )
        acc = s2 if acc is None else acc + s2
    residual = mix - acc
    r_rms = _rms(residual)
    m_rms = _rms(mix)
    rel = (r_rms / m_rms) if m_rms > 0 else (0.0 if r_rms == 0 else float("inf"))
    if r_rms == 0:
        snr = float("inf")
    elif m_rms == 0:
        snr = float("-inf")
    else:
        snr = 20.0 * float(np.log10(m_rms / r_rms))
    return ReconstructionReport(residual_rms=r_rms, mixture_rms=m_rms,
                                relative_error=rel, snr_db=snr)


def check_mixture_consistency(
    mixture, stems: Sequence,
    label: str = "mixture",
    max_relative_error: float = 1e-3,
) -> CheckResult:
    """stems 합이 mixture 를 복원하는지 검사.
    상대 잔차오차 > max_relative_error → FALLBACK_CANDIDATE (분리 결과가 에너지
    보존을 크게 어겼음 — 결합 신뢰 불가, 단일 모델 후보). 형상 불일치는
    analyze_reconstruction 이 IntegrityError 로 승격 (조용한 절단 금지)."""
    rep = analyze_reconstruction(mixture, stems)
    metrics = {
        "residual_rms": round(rep.residual_rms, 9),
        "mixture_rms": round(rep.mixture_rms, 9),
        "relative_error": rep.relative_error,
        "snr_db": rep.snr_db,
        "max_relative_error": max_relative_error,
        "n_stems": len(stems),
    }
    if rep.relative_error > max_relative_error:
        return CheckResult(
            "mixture_consistency", Verdict.FALLBACK_CANDIDATE,
            f"{label}: 재구성 오차 과다 (상대오차 {rep.relative_error:.3e} "
            f"> 허용 {max_relative_error:.1e}, SNR {rep.snr_db:.1f}dB) → 단일 모델 후보.",
            metrics,
        )
    return CheckResult(
        "mixture_consistency", Verdict.OK,
        f"{label}: 재구성 양호 (상대오차 {rep.relative_error:.3e}, SNR {rep.snr_db:.1f}dB).",
        metrics,
    )


# ---------------------------------------------------------------------------
# 검사 5: peak / clipping 게이트
# ---------------------------------------------------------------------------

def check_peak_clipping(
    array,
    name: str = "audio",
    ceiling: float = 1.0,
    max_clipped_ratio: float = 0.0,
) -> CheckResult:
    """peak 레벨과 클리핑을 검사. |x| >= ceiling 인 샘플이 max_clipped_ratio 를
    초과하면 FAIL (클리핑된 출력은 손상). 기본은 무관용(0.0)."""
    arr = _as_2d(array).astype(np.float64)
    if arr.size == 0:
        return CheckResult("peak_clipping", Verdict.OK, f"{name}: 빈 배열.", {"size": 0})
    peak = float(np.max(np.abs(arr)))
    clipped = int(np.count_nonzero(np.abs(arr) >= ceiling))
    ratio = clipped / arr.size
    metrics = {
        "peak": peak, "ceiling": ceiling,
        "clipped_samples": clipped, "clipped_ratio": ratio,
        "max_clipped_ratio": max_clipped_ratio, "size": int(arr.size),
    }
    if ratio > max_clipped_ratio:
        return CheckResult(
            "peak_clipping", Verdict.FAIL,
            f"{name}: 클리핑 {clipped} 샘플 (비율 {ratio:.3e} > 허용 {max_clipped_ratio:.1e}, "
            f"peak {peak:.4f} ≥ ceiling {ceiling}) — 출력 손상.",
            metrics,
        )
    return CheckResult(
        "peak_clipping", Verdict.OK,
        f"{name}: 클리핑 없음 (peak {peak:.4f} < ceiling {ceiling}).",
        metrics,
    )


# ---------------------------------------------------------------------------
# 가중치·설정·모델 지문 (비민감 manifest — 해시·크기만, 오디오 내용 없음)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class WeightManifest:
    """가중치/설정/모델 파일의 비민감 지문.

    identifier : 논리 이름 (모델명 등). 경로가 아니어도 된다.
    size_bytes : 바이트 크기.
    sha256     : 내용 SHA-256 (16진). 오디오가 아닌 *모델/설정* 바이트 대상.
    algo       : 해시 알고리즘 이름.

    이 타입은 오디오 샘플을 절대 담지 않는다 — 파이프라인 재현성/드리프트
    감지용 지문일 뿐이다. 파일 I/O 는 하지 않는다(호출자가 바이트를 넘긴다).
    """
    identifier: str
    size_bytes: int
    sha256: str
    algo: str = "sha256"


def fingerprint_bytes(data: bytes, identifier: str) -> WeightManifest:
    """이미 읽힌 바이트로부터 WeightManifest 를 만든다 (순수, 파일 I/O 없음)."""
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise IntegrityError("fingerprint_bytes 는 bytes 류만 받는다.")
    b = bytes(data)
    digest = hashlib.sha256(b).hexdigest()
    return WeightManifest(identifier=str(identifier), size_bytes=len(b), sha256=digest)


def manifests_match(a: WeightManifest, b: WeightManifest) -> bool:
    """두 지문이 동일 파일을 가리키는지 (크기 + 해시). identifier 는 비교 제외."""
    return a.size_bytes == b.size_bytes and a.sha256 == b.sha256 and a.algo == b.algo


# ---------------------------------------------------------------------------
# 집계 편의 함수 (여전히 정책은 없음 — 검사를 모아 보고서만 만든다)
# ---------------------------------------------------------------------------

def validate_stem_set(
    stems: Sequence,
    sample_rate: int,
    labels: Optional[Sequence[str]] = None,
    ceiling: float = 1.0,
    length_tolerance: int = 0,
) -> IntegrityReport:
    """스템 집합(같은 분리 결과의 여러 스템)에 대해 finite·스펙일치·클리핑을
    한 번에 검사한 IntegrityReport 를 반환. mixture consistency·정합은 별도 함수로.
    이 함수는 정책 결정을 하지 않는다 — 보고서만 만든다."""
    labels = list(labels) if labels is not None else [f"stem{i}" for i in range(len(stems))]
    report = IntegrityReport()
    specs = []
    for stem, lab in zip(stems, labels):
        report.add(check_finite(stem, name=lab))
        report.add(check_peak_clipping(stem, name=lab, ceiling=ceiling))
        specs.append(describe_audio(stem, sample_rate))
    report.add(check_spec_match(specs, labels=labels, length_tolerance=length_tolerance))
    return report
