# -*- coding: utf-8 -*-
"""오디오 finishing — 말끝(tail) 다듬기 + 경계(boundary) 간격 해석의 순수 array 엔진.

계약(tts-expression-s1-scaffold.md §audio_finishing API + boundary-pause 브랜치 계약):
  - 이 모듈은 **순수 array in/out**만 한다. 파일 read/write, pending, os.replace, 취소/정리는
    호출부(tts_worker)가 책임진다. 여기엔 어떤 파일 I/O도 없다.
  - numpy에만 의존한다(soundfile/torch/ffmpeg 없음). 이 워크트리엔 venv가 없어 numpy 기반
    테스트는 실행 불가 — 통합 담당이 공유 qwen venv에서 검증한다.

핵심 순수 함수(계약 고정):
  - compute_tail_plan(samples, sr, cfg) -> TailPlan
  - apply_final_tail(samples, sr, plan) -> np.ndarray
  - validate_audio_array(samples, sr) -> AudioStats(dict)

경계(boundary) — 이 브랜치는 텍스트 파서를 구현하지 않는다. A의 파서가 나중에 넘겨줄
'검증된 duration_ms 서술자'를 **소비**하는 순수 API만 정의한다. 우선순위(비합산):
    explicitPause > lineGap > emotionGap > internal(0)
  전환 방식은 immediate|pause 둘뿐. smooth/crossfade/zero-cross-shift는 구현하지 않는다.

주의(사용자 증상):
  - "말끝이 칼로 자른 듯"(abrupt cut)은 **코드상 유력한 발생 경로**이며 synthetic sine에서 재현된다.
    실제 사용자 음성으로 '해결됨'을 주장하지 않는다. 120ms/8ms 기본값도 실청취 전엔 최적이라 하지 않는다.
"""

from dataclasses import dataclass, field
from typing import Optional

import numpy as np


# ────────────────────────── 정책 상수(계약) ──────────────────────────

# tail 범위(계약 §3) — 벗어나면 조용한 clamp 없이 INVALID_TTS_CONFIG.
TAIL_PAD_MIN_MS = 0.0
TAIL_PAD_MAX_MS = 300.0
TAIL_FADE_MIN_MS = 0.0
TAIL_FADE_MAX_MS = 20.0

# new 기본값(미지정 시). 실청취 검증 전 최적 주장 금지.
TAIL_PAD_DEFAULT_MS = 120.0
TAIL_FADE_DEFAULT_MS = 8.0

# 이미 무음 판정: 마지막 ≤5ms 구간의 peak ≤ 1e-4 → fade 없이 padding만(계약 §3).
# (프로토타입 test_boundary_pause_synth.py의 0.02와 다르다 — 계약값 1e-4를 권위로 채택.)
SILENCE_WIN_MS = 5.0
SILENCE_PEAK = 1e-4

# emotion 전환 간격 범위(ttsEmotionBoundaryPauseMs 0~1000).
EMOTION_GAP_MIN_MS = 0.0
EMOTION_GAP_MAX_MS = 1000.0

VALID_TAIL_MODES = ("off", "auto")
VALID_BOUNDARY_MODES = ("immediate", "pause")


class AudioFinishingError(RuntimeError):
    """finishing 실패. code로 원인 식별(INVALID_TTS_CONFIG / AUDIO_INVALID / AUDIO_SR_MISMATCH /
    TAIL_DOUBLE_APPLY)."""

    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


# ────────────────────────── tail config / plan ──────────────────────────

@dataclass(frozen=True)
class TailConfig:
    mode: str = "off"          # 'off' | 'auto'
    pad_ms: float = TAIL_PAD_DEFAULT_MS
    fade_ms: float = TAIL_FADE_DEFAULT_MS


@dataclass
class TailPlan:
    mode: str                  # 'off' | 'auto'
    fade_ms: float
    pad_ms: float
    already_silent: bool
    fade_applied: bool
    sr: int
    # 이중 적용 방지 — 호출자 단계가 권위지만, 방어적으로 array-level에서도 재적용을 차단한다.
    _applied: bool = field(default=False, repr=False, compare=False)


def _finite_number(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return f


def _require_range(value, lo, hi, label):
    """[lo, hi] 밖이면 INVALID_TTS_CONFIG(조용한 clamp 금지)."""
    f = _finite_number(value)
    if f is None:
        raise AudioFinishingError(f"{label} 값이 수치가 아님/비유한: {value!r}", code="INVALID_TTS_CONFIG")
    if f < lo or f > hi:
        raise AudioFinishingError(
            f"{label} 범위 초과({f}) — 허용 [{lo}, {hi}]. 조용한 clamp 없음.",
            code="INVALID_TTS_CONFIG")
    return f


def parse_tail_config(cfg) -> TailConfig:
    """raw dict/None/TailConfig → 정규화된 TailConfig.
    - None/{} → mode 'off'(레거시 회귀 보존: config 부재 → off).
    - mode 미지정 → 'off'. mode ∉ {off,auto} → INVALID_TTS_CONFIG.
    - mode 'auto'일 때만 pad/fade 범위 검증(off일 땐 값을 읽지 않는다)."""
    if cfg is None:
        return TailConfig(mode="off")
    if isinstance(cfg, TailConfig):
        # 이미 정규화됨. auto면 재검증(방어적).
        if cfg.mode not in VALID_TAIL_MODES:
            raise AudioFinishingError(f"tail mode 이상: {cfg.mode!r}", code="INVALID_TTS_CONFIG")
        if cfg.mode == "auto":
            _require_range(cfg.pad_ms, TAIL_PAD_MIN_MS, TAIL_PAD_MAX_MS, "ttsTailPaddingMs")
            _require_range(cfg.fade_ms, TAIL_FADE_MIN_MS, TAIL_FADE_MAX_MS, "ttsTailFadeMs")
        return cfg
    if not isinstance(cfg, dict):
        raise AudioFinishingError(f"tail cfg 형태 이상: {type(cfg).__name__}", code="INVALID_TTS_CONFIG")

    mode = cfg.get("mode", "off")
    if mode not in VALID_TAIL_MODES:
        raise AudioFinishingError(f"tail mode 이상: {mode!r} — 'off'|'auto'만 허용", code="INVALID_TTS_CONFIG")
    if mode == "off":
        return TailConfig(mode="off")

    pad_raw = cfg.get("pad_ms", cfg.get("padding_ms", TAIL_PAD_DEFAULT_MS))
    fade_raw = cfg.get("fade_ms", TAIL_FADE_DEFAULT_MS)
    pad = _require_range(pad_raw, TAIL_PAD_MIN_MS, TAIL_PAD_MAX_MS, "ttsTailPaddingMs")
    fade = _require_range(fade_raw, TAIL_FADE_MIN_MS, TAIL_FADE_MAX_MS, "ttsTailFadeMs")
    return TailConfig(mode="auto", pad_ms=pad, fade_ms=fade)


def _as_mono_float32(samples):
    """입력을 1-D float32 ndarray로. 2-D(스테레오)는 여기서 거부하지 않고 그대로 반환(검증은 별도).
    스칼라/빈 것도 그대로 통과시켜 검증 함수가 판정하게 한다."""
    arr = np.asarray(samples, dtype=np.float32)
    return arr


def _last_window_peak(arr, sr, win_ms):
    if arr.size == 0:
        return 0.0
    w = max(1, int(round(win_ms * sr / 1000.0)))
    w = min(w, arr.size)
    tail = arr[-w:]
    if not np.all(np.isfinite(tail)):
        return float("inf")
    return float(np.max(np.abs(tail)))


def compute_tail_plan(samples, sr, cfg) -> TailPlan:
    """말끝 처리 계획 산출(순수·결정적, 파일 I/O 없음).
    - cfg off/부재 → mode 'off' plan(적용 시 무변경).
    - auto → 마지막 ≤5ms peak ≤ 1e-4면 already_silent(fade 없이 pad만). 아니면 fade 대상.
    - fade_applied = auto ∧ ¬already_silent ∧ fade_ms>0 ∧ len>0."""
    tail = parse_tail_config(cfg)
    sr = int(sr)
    if sr <= 0:
        raise AudioFinishingError(f"sr는 양수여야 함: {sr}", code="AUDIO_INVALID")
    arr = _as_mono_float32(samples)

    if tail.mode == "off":
        return TailPlan(mode="off", fade_ms=0.0, pad_ms=0.0,
                        already_silent=False, fade_applied=False, sr=sr)

    peak = _last_window_peak(arr, sr, SILENCE_WIN_MS)
    already_silent = (arr.size > 0) and (peak <= SILENCE_PEAK)
    fade_applied = (not already_silent) and (tail.fade_ms > 0.0) and (arr.size > 0)
    return TailPlan(mode="auto", fade_ms=float(tail.fade_ms), pad_ms=float(tail.pad_ms),
                    already_silent=already_silent, fade_applied=fade_applied, sr=sr)


def _cosine_fade_window(n):
    """길이 n의 fade-to-zero 창(1→0). 끝점이 **정확히 0**이 되도록 (k+1)/n 위상 사용:
    w[k] = 0.5*(1+cos(pi*(k+1)/n)) → w[n-1] = 0.5*(1+cos(pi)) = 0.0."""
    if n <= 0:
        return np.ones(0, dtype=np.float32)
    k = np.arange(1, n + 1, dtype=np.float64)
    w = 0.5 * (1.0 + np.cos(np.pi * k / n))
    w[-1] = 0.0  # 부동소수 오차 제거 — 끝점 정확히 0
    return w.astype(np.float32)


def apply_final_tail(samples, sr, plan: TailPlan) -> np.ndarray:
    """계획을 적용해 새 배열 반환(입력 비변형). 순수 array — 파일 I/O 없음.
    - mode off → 입력 복사본을 그대로 반환.
    - auto → fade_applied면 마지막 min(fade, len) 구간 cosine fade-to-zero, 이후 정확한 0 padding.
    - 같은 plan 재적용 금지(TAIL_DOUBLE_APPLY). plan.sr != sr → AUDIO_SR_MISMATCH."""
    if not isinstance(plan, TailPlan):
        raise AudioFinishingError("apply_final_tail: TailPlan이 필요합니다", code="AUDIO_INVALID")
    if plan._applied:
        raise AudioFinishingError("같은 tail plan을 두 번 적용할 수 없습니다(호출자 단계 권위)",
                                  code="TAIL_DOUBLE_APPLY")
    if int(sr) != int(plan.sr):
        raise AudioFinishingError(f"sr 불일치: plan.sr={plan.sr} vs sr={sr}", code="AUDIO_SR_MISMATCH")

    arr = _as_mono_float32(samples)
    if arr.ndim != 1:
        raise AudioFinishingError(f"mono(1-D)만 처리 가능: ndim={arr.ndim}", code="AUDIO_INVALID")

    plan._applied = True

    if plan.mode == "off":
        return arr.copy()

    body = arr.copy()
    if plan.fade_applied and body.size > 0:
        f = int(round(plan.fade_ms * sr / 1000.0))
        f = max(1, min(f, body.size))
        body[body.size - f:] = body[body.size - f:] * _cosine_fade_window(f)

    pad_samples = int(round(plan.pad_ms * sr / 1000.0))
    if pad_samples > 0:
        body = np.concatenate([body, np.zeros(pad_samples, dtype=np.float32)])
    return body


# ────────────────────────── 검증(순수 계산 — reject는 호출부) ──────────────────────────

def validate_audio_array(samples, sr) -> dict:
    """순수 통계 산출: {channels, samplerate, frames, finite, peak}. **경로/파일을 받지 않는다.**
    이 함수는 판정만 계산한다 — reject(예외)는 require_valid_mono가 담당(계약 §4: mono·sr>0·
    non-empty·finite·peak, NaN/inf·stereo 거부)."""
    arr = np.asarray(samples)
    if arr.ndim <= 1:
        channels = 1
        frames = int(arr.shape[0]) if arr.ndim == 1 else 1
    else:
        # soundfile 관례: (frames, channels)
        frames = int(arr.shape[0])
        channels = int(arr.shape[1]) if arr.ndim == 2 else int(np.prod(arr.shape[1:]))
    try:
        finite = bool(np.all(np.isfinite(arr))) if arr.size > 0 else True
    except TypeError:
        finite = False
    if arr.size == 0:
        peak = 0.0
    elif finite:
        peak = float(np.max(np.abs(arr)))
    else:
        peak = float("inf")
    return {
        "channels": channels,
        "samplerate": int(sr) if _finite_number(sr) is not None else None,
        "frames": frames,
        "finite": finite,
        "peak": peak,
    }


def require_valid_mono(stats: dict):
    """validate_audio_array 통계로 reject 판정(계약 §4). 위반 시 AUDIO_INVALID.
    호출부는 실패 시 기존 synthesized.wav를 보존하고 pending/job temp를 정리해야 한다."""
    if stats.get("samplerate") is None or stats["samplerate"] <= 0:
        raise AudioFinishingError(f"sr 이상: {stats.get('samplerate')}", code="AUDIO_INVALID")
    if stats.get("channels") != 1:
        raise AudioFinishingError(f"mono만 허용 — channels={stats.get('channels')}(stereo 거부)",
                                  code="AUDIO_INVALID")
    if stats.get("frames", 0) <= 0:
        raise AudioFinishingError("빈 오디오(non-empty 요구)", code="AUDIO_INVALID")
    if not stats.get("finite", False):
        raise AudioFinishingError("비유한 샘플(NaN/inf 거부)", code="AUDIO_INVALID")
    return stats


def expected_tail_frames(input_len, plan: TailPlan) -> int:
    """apply_final_tail 결과의 예상 프레임 수 = 입력 길이 + padding(off면 0). fade는 길이 불변."""
    if plan.mode != "auto":
        return int(input_len)
    pad = int(round(plan.pad_ms * plan.sr / 1000.0))
    return int(input_len) + max(0, pad)


def require_valid_finished(samples, sr, plan: TailPlan, input_len) -> dict:
    """불변식 B(원자 교체 전, in-memory): mono·non-empty·finite + 예상 프레임 수 + padding 구간 정확히 0.
    위반 시 AUDIO_INVALID. (apply_final_tail이 구조적으로 보장하지만 write 전 방어적 재확인.)"""
    stats = require_valid_mono(validate_audio_array(samples, sr))
    exp = expected_tail_frames(input_len, plan)
    if stats["frames"] != exp:
        raise AudioFinishingError(f"finished 프레임 수 불일치: {stats['frames']} != {exp}",
                                  code="AUDIO_INVALID")
    pad = exp - int(input_len)
    if pad > 0:
        arr = np.asarray(samples)
        if not bool(np.all(arr[-pad:] == 0.0)):
            raise AudioFinishingError("padding 구간이 정확히 0이 아님", code="AUDIO_INVALID")
    return stats


def require_valid_reopened(samples, sr, meta_samplerate, meta_frames, expected_frames) -> dict:
    """불변식 C(원자 교체 전, 파일 재오픈 후): 디코드된 array가 mono·non-empty·finite,
    메타 sr == 실제 sr, 프레임 수 == 예상, peak 유한. 위반 시 AUDIO_INVALID.
    호출부는 파일을 실제로 재오픈(sf.read/sf.info)해 이 함수에 넘긴다 — 여기 자체는 파일 I/O 없음."""
    stats = require_valid_mono(validate_audio_array(samples, sr))
    if meta_samplerate is None or int(meta_samplerate) != int(sr):
        raise AudioFinishingError(f"메타 sr != 실제 sr: {meta_samplerate} != {sr}", code="AUDIO_INVALID")
    if int(meta_frames) != int(expected_frames) or stats["frames"] != int(expected_frames):
        raise AudioFinishingError(
            f"재오픈 프레임 수 불일치: meta={meta_frames} read={stats['frames']} exp={expected_frames}",
            code="AUDIO_INVALID")
    if not np.isfinite(stats["peak"]):
        raise AudioFinishingError("재오픈 peak 비유한", code="AUDIO_INVALID")
    return stats


# ────────────────────────── 경계(boundary) 간격 해석 ──────────────────────────

@dataclass(frozen=True)
class BoundaryDescriptor:
    """A의 파서가 나중에 넘겨줄 '검증된' 경계 서술자를 소비하는 형태.
    한 경계(세그먼트 i-1과 i 사이)에 적용 가능한 후보값을 담고, resolve가 하나만 고른다(비합산).
      - explicit_pause_ms: [쉼] 등 명시적 쉼(있으면 최우선). None이면 없음.
      - is_line_boundary/line_gap_ms: 사용자 줄바꿈 경계 + 간격.
      - is_emotion_boundary/emotion_gap_ms/emotion_mode: 감정 전환 경계 + 간격 + 방식.
      - 모두 아니면 internal(자동분할 내부) → 0."""
    explicit_pause_ms: Optional[float] = None
    is_line_boundary: bool = False
    line_gap_ms: float = 0.0
    is_emotion_boundary: bool = False
    emotion_gap_ms: float = 0.0
    emotion_mode: str = "pause"          # 'immediate' | 'pause'


def resolve_boundary_gap_ms(desc: BoundaryDescriptor) -> float:
    """단일 경계의 최종 간격(ms)을 우선순위로 하나만 선택 — **절대 합산하지 않는다**.
        explicitPause > lineGap > emotionGap > internal(0)
    emotion_mode 'immediate'면 감정 경계는 0(쉼 없이 즉시 전환), 'pause'면 emotion_gap_ms."""
    if not isinstance(desc, BoundaryDescriptor):
        raise AudioFinishingError("BoundaryDescriptor가 필요합니다", code="INVALID_TTS_CONFIG")

    if desc.explicit_pause_ms is not None:
        return _require_range(desc.explicit_pause_ms, 0.0, float("inf"), "explicitPauseMs")

    if desc.is_line_boundary:
        return _require_range(desc.line_gap_ms, 0.0, float("inf"), "lineGapMs")

    if desc.is_emotion_boundary:
        if desc.emotion_mode not in VALID_BOUNDARY_MODES:
            raise AudioFinishingError(
                f"emotion_mode 이상: {desc.emotion_mode!r} — 'immediate'|'pause'만",
                code="INVALID_TTS_CONFIG")
        if desc.emotion_mode == "immediate":
            return 0.0
        return _require_range(desc.emotion_gap_ms, EMOTION_GAP_MIN_MS, EMOTION_GAP_MAX_MS,
                              "ttsEmotionBoundaryPauseMs")

    return 0.0  # internal


def resolve_boundary_plan(descriptors) -> list:
    """경계 서술자 리스트 → 각 경계의 간격(ms) 리스트. 순수·비합산. (concat 배선은 통합 담당.)"""
    return [resolve_boundary_gap_ms(d) for d in (descriptors or [])]


def gap_ms_to_samples(gap_ms, sr) -> int:
    """간격(ms) → 무음 샘플 수(정확 반올림). 음수/비유한 → INVALID_TTS_CONFIG."""
    f = _require_range(gap_ms, 0.0, float("inf"), "gapMs")
    return int(round(f * int(sr) / 1000.0))


# ────────────────────────── 내부 요약(선택) — 공유 metadata/스키마 미배선 ──────────────────────────

def summarize_finishing(plan: Optional[TailPlan], descriptors=None) -> dict:
    """재현용 내부 요약(대사/경로 없음). 계약: 공유 metadata/renderer에 배선하지 않는다 — 통합 담당 몫.
    필드: tail_mode, tail_padding_ms, tail_fade_ms, tail_fade_applied,
          emotion_boundary_mode, explicit_pause_count, explicit_pause_total_ms."""
    descriptors = descriptors or []
    explicit = [d for d in descriptors if isinstance(d, BoundaryDescriptor)
                and d.explicit_pause_ms is not None]
    explicit_total = float(sum(float(d.explicit_pause_ms) for d in explicit))
    emo_mode = None
    for d in descriptors:
        if isinstance(d, BoundaryDescriptor) and d.is_emotion_boundary:
            emo_mode = d.emotion_mode
            break
    if plan is not None and plan.mode == "auto":
        tail_mode = "auto"
        tail_pad = plan.pad_ms
        tail_fade = plan.fade_ms
        tail_fade_applied = plan.fade_applied
    else:
        tail_mode = "off"
        tail_pad = None
        tail_fade = None
        tail_fade_applied = False
    return {
        "tail_mode": tail_mode,
        "tail_padding_ms": tail_pad,
        "tail_fade_ms": tail_fade,
        "tail_fade_applied": tail_fade_applied,
        "emotion_boundary_mode": emo_mode,
        "explicit_pause_count": len(explicit),
        "explicit_pause_total_ms": explicit_total,
    }
