# -*- coding: utf-8 -*-
"""macro gain drift 보정 — **연기가 아니라 gain 으로 새어 나온 느린 감쇠만** 되돌린다.

왜 필요한가
-----------
연기·언성과 트랙 gain 은 같은 축이 아니다. 저음·속삭임·친밀함은 F0, spectral tilt, breathiness,
articulation, tempo 로 표현되어야 하고 트랙 gain 으로 대신 표현되면 안 된다. 그런데 실측에서
모델이 후반부 register 를 **gain 을 내려서** 대신 표현했다(goback chunk-2: 마지막 20초 active RMS
−0.296 dB/s, 그동안 F0 중앙값은 192 Hz 로 거의 평평). 사용자 청취 판정은
`ENDING_GAIN_ATTENUATION_INSTEAD_OF_LOW_TONE` 이었다.

무엇이 아닌가
-------------
normalization 도, compressor 도, limiter 도, AGC 도 아니다. 짧은 강약·호흡·웃음·단어 강조는
건드리지 않는다 — 보정 곡선이 **수십 초 규모**라 구조적으로 통과한다. 어떤 구간도 깎지 않는다
(boost-only). 명시적 공간 연출(`[멀어짐]`, `[다가옴]`)은 `protected_spans` 로 제외해
`spatial_automation` 축의 의도된 gain curve 와 싸우지 않는다.

어디에 한 번 걸리는가
---------------------
**조립이 끝난 최종 트랙 하나**에만 건다. chunk 마다 따로 걸지 않는다 — chunk 별 보정은
"chunk 별 동일 gain" 과 다를 바 없어 경계에서 단차를 만든다. 호출 지점은
`tts_worker._finish_and_place` 이며 순서는 pitch → **macro gain** → 경계 envelope → tail 이다.
바깥쪽 10 ms/20 ms fade 계약은 그대로 마지막 권위로 남는다.

언제 켜지는가
-------------
활성화 통계는 **지속 결손**(sustained deficit)이다 — 추세가 한 번 내려간 뒤 끝까지 돌아오지
않는 폭. 잠깐 내려갔다 회복하는 구절 단위 강약은 여기 잡히지 않는다.

    deficit = max(0, p75(trend) − max(trend[t:]))

청취 라벨 실측(2026-08-30, 같은 계측 규약):

    A-goback-379   PASS(무보정)   2.47 dB
    C-sample4-572  PASS(무보정)   1.46 dB
    B-FULL         PASS(보정본)   3.63 dB      ← 보정 결과가 다시 걸리면 안 된다
    FULL-goback    FAIL(무보정)   8.18 dB

PASS 최대 3.63 과 FAIL 최소 8.18 사이가 비어 있고, 게이트는 그 간극의 중간이다. 자동 계측으로
올리거나 내리지 않는다 — 청취 라벨이 쌓일 때만 provenance 와 함께 조정한다.
"""
import hashlib
import math

import numpy as np


class MacroGainError(Exception):
    def __init__(self, message, code="MACRO_GAIN_INVALID"):
        super().__init__(message)
        self.code = code


# ── 계측 규약 ────────────────────────────────────────────────────────────────
# 제품 임계값이 아니라 '무엇을 재는가' 의 정의다. 감사 스크립트와 같은 값을 쓴다.
ANALYSIS_FRAME_MS = 50.0
ANALYSIS_HOP_MS = 25.0
#: active-speech 게이트. 파일 자신의 p95 프레임 RMS 대비 상대값이라 절대 dB floor 가 아니다.
ACTIVE_GATE_REL_DB = -20.0
#: 레벨 궤적 — 4초 창을 1초 간격으로.
LEVEL_WINDOW_SEC = 4.0
LEVEL_HOP_SEC = 1.0
#: macro 추세 — 11초 중심 이동평균. 음절·구절 단위 강약은 여기서 이미 사라진다.
TREND_WINDOW_SEC = 11.0
#: 보정 곡선 추가 평활 — 5초.
CURVE_SMOOTH_SEC = 5.0
#: 추세를 말하려면 최소한 레벨 창 하나 + 추세 창 하나가 필요하다(발명값이 아니라 파생값).
MIN_ANALYSIS_SEC = LEVEL_WINDOW_SEC + TREND_WINDOW_SEC
#: 정상 레벨 기준 분위수. 게이트의 멱등성이 이 분위수 선택에 걸려 있다(모듈 문서 참조).
PLATEAU_PERCENTILE = 75.0

#: 활성화 게이트(dB). 청취 라벨 사이의 빈 구간 중간값.
ACTIVATION_GATE_DB = 6.0
ACTIVATION_PROVENANCE = {
    "statistic": "sustained_deficit_db = max(0, p75(trend) - suffix_max(trend))",
    "measurement": {"frame_ms": ANALYSIS_FRAME_MS, "hop_ms": ANALYSIS_HOP_MS,
                    "active_gate_rel_db": ACTIVE_GATE_REL_DB,
                    "level_window_sec": LEVEL_WINDOW_SEC, "level_hop_sec": LEVEL_HOP_SEC,
                    "trend_window_sec": TREND_WINDOW_SEC},
    "verified_on": "2026-08-30",
    "conditioning_mode": "high_quality_icl (vendor native ref-code ICL)",
    "listening_labels": [
        {"run": "envelope-goback-384", "verdict": "PASS", "corrected": False, "statistic_db": 2.47},
        {"run": "envelope-sample4-576", "verdict": "PASS", "corrected": False, "statistic_db": 1.46},
        {"run": "macro-gain-drift-ab/B-FULL", "verdict": "PASS", "corrected": True,
         "statistic_db": 3.63},
        {"run": "goback-split-production-1", "verdict": "FAIL", "corrected": False,
         "statistic_db": 8.18},
    ],
    "gap": {"max_pass_db": 3.63, "min_fail_db": 8.18},
    "note": ("보정 결과(B-FULL 3.63)가 게이트 아래에 있어야 재적용이 일어나지 않는다. "
             "게이트는 자동 계측으로 움직이지 않는다."),
    "raise_policy": "청취 라벨이 추가로 쌓일 때만 provenance 와 함께 조정한다.",
}

# 적용하지 않은 이유(비민감 enum).
REASON_APPLIED = "APPLIED"
REASON_BELOW_GATE = "BELOW_GATE"
REASON_TOO_SHORT = "TOO_SHORT"
REASON_NO_ACTIVE_SPEECH = "NO_ACTIVE_SPEECH"
REASON_FULLY_PROTECTED = "FULLY_PROTECTED"


class MacroGainPlan(object):
    """한 트랙에 대한 보정 계획. **한 번만** 적용할 수 있다.

    같은 계획을 두 번 걸면 gain 이 제곱된다 — 경계 envelope 과 같은 이유로 금지한다.
    """

    __slots__ = ("applied", "reason", "statistic_db", "gate_db", "gain_db", "times_sec",
                 "sample_rate", "max_boost_db", "headroom_cap_db", "protected_spans", "_used")

    def __init__(self, applied, reason, statistic_db, gate_db, gain_db, times_sec,
                 sample_rate, max_boost_db, headroom_cap_db, protected_spans):
        self.applied = bool(applied)
        self.reason = str(reason)
        self.statistic_db = float(statistic_db)
        self.gate_db = float(gate_db)
        self.gain_db = gain_db
        self.times_sec = times_sec
        self.sample_rate = int(sample_rate)
        self.max_boost_db = float(max_boost_db)
        self.headroom_cap_db = headroom_cap_db
        self.protected_spans = tuple(protected_spans or ())
        self._used = False

    @property
    def curve_sha8(self):
        """보정 곡선의 지문. 대사·경로가 아니라 수치 배열만 해싱한다."""
        if self.gain_db is None or len(self.gain_db) == 0:
            return None
        body = ",".join("%.3f" % float(v) for v in self.gain_db).encode("utf-8")
        return hashlib.sha256(body).hexdigest()[:8]


def _as_mono(samples):
    a = np.asarray(samples)
    if a.ndim == 1:
        return a.astype("float64")
    if a.ndim == 2:
        return a.astype("float64").mean(axis=1)
    raise MacroGainError("1-D 또는 2-D 배열이어야 합니다")


def _frame_rms(mono, sr):
    n_frame = max(1, int(round(ANALYSIS_FRAME_MS * sr / 1000.0)))
    n_hop = max(1, int(round(ANALYSIS_HOP_MS * sr / 1000.0)))
    if len(mono) < n_frame:
        return np.zeros(0), n_frame, n_hop
    count = 1 + (len(mono) - n_frame) // n_hop
    a = np.ascontiguousarray(mono)
    F = np.lib.stride_tricks.as_strided(a, (count, n_frame),
                                        (a.strides[0] * n_hop, a.strides[0]))
    return np.sqrt(np.mean(F ** 2, axis=1)), n_frame, n_hop


def _db(x):
    return 20.0 * np.log10(np.maximum(x, 1e-12))


def _moving_average(v, taps):
    """중심 이동평균. 양끝은 끝값을 복제해 길이를 유지한다."""
    if taps <= 1 or len(v) < 3:
        return np.array(v, dtype="float64")
    k = int(taps) if int(taps) % 2 else int(taps) - 1
    k = min(k, len(v) if len(v) % 2 else len(v) - 1)
    if k < 3:
        return np.array(v, dtype="float64")
    pad = k // 2
    p = np.concatenate([np.repeat(v[0], pad), np.asarray(v, dtype="float64"), np.repeat(v[-1], pad)])
    return np.convolve(p, np.ones(k) / float(k), "valid")


def _normalize_spans(protected_spans, total):
    out = []
    for span in (protected_spans or ()):
        try:
            s, e = int(span[0]), int(span[1])
        except Exception:
            raise MacroGainError("protected_spans 는 (start, end) 샘플 쌍이어야 합니다")
        s, e = max(0, min(s, total)), max(0, min(e, total))
        if e > s:
            out.append((s, e))
    out.sort()
    merged = []
    for s, e in out:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return tuple(merged)


def _level_series(mono, sr, protected):
    """1초 간격 / 4초 창의 active-speech RMS(dB). 보호 구간의 프레임은 분석에서 뺀다."""
    rms, n_frame, n_hop = _frame_rms(mono, sr)
    if len(rms) == 0:
        return np.zeros(0), np.zeros(0)
    gate = float(np.percentile(rms, 95) * (10.0 ** (ACTIVE_GATE_REL_DB / 20.0)))
    active = rms >= gate
    if protected:
        starts = np.arange(len(rms)) * n_hop
        ends = starts + n_frame
        for s, e in protected:
            active &= ~((starts < e) & (ends > s))
    win = max(1, int(round(LEVEL_WINDOW_SEC * sr / n_hop)))
    hop = max(1, int(round(LEVEL_HOP_SEC * sr / n_hop)))
    times, vals = [], []
    for k in range(0, max(1, len(rms) - win + 1), hop):
        sel = active[k:k + win]
        times.append((k * n_hop + win * n_hop / 2.0) / float(sr))
        vals.append(float(_db(rms[k:k + win][sel].mean())) if sel.any() else np.nan)
    t = np.asarray(times, dtype="float64")
    v = np.asarray(vals, dtype="float64")
    ok = ~np.isnan(v)
    if not ok.any():
        return t, v
    idx = np.arange(len(v))
    return t, np.interp(idx, idx[ok], v[ok])


def sustained_deficit_db(trend):
    """추세가 내려간 뒤 **끝까지 회복하지 않는** 폭. 회복하는 구절 강약은 0 에 가깝다."""
    if len(trend) == 0:
        return 0.0
    suffix_max = np.maximum.accumulate(trend[::-1])[::-1]
    return float(np.maximum(0.0, float(np.percentile(trend, PLATEAU_PERCENTILE)) - suffix_max).max())


def compute_macro_gain_plan(samples, sr, protected_spans=None, gate_db=None):
    """보정 계획을 만든다(순수·결정적). 배열을 바꾸지 않는다."""
    sr = int(sr)
    if sr <= 0:
        raise MacroGainError("sr 은 양수여야 합니다: %r" % (sr,))
    gate = float(ACTIVATION_GATE_DB if gate_db is None else gate_db)
    mono = _as_mono(samples)
    total = len(mono)
    protected = _normalize_spans(protected_spans, total)

    def off(reason, stat=0.0):
        return MacroGainPlan(False, reason, stat, gate, None, None, sr, 0.0, None, protected)

    if total < MIN_ANALYSIS_SEC * sr:
        return off(REASON_TOO_SHORT)
    if protected and sum(e - s for s, e in protected) >= total:
        return off(REASON_FULLY_PROTECTED)

    t, level = _level_series(mono, sr, protected)
    if len(level) == 0 or not np.all(np.isfinite(level)):
        return off(REASON_NO_ACTIVE_SPEECH)

    trend = _moving_average(level, int(round(TREND_WINDOW_SEC / LEVEL_HOP_SEC)))
    statistic = sustained_deficit_db(trend)
    if statistic < gate:
        return off(REASON_BELOW_GATE, statistic)

    plateau = float(np.percentile(trend, PLATEAU_PERCENTILE))
    depth = float(plateau - trend.min())
    gain = _moving_average(np.clip(plateau - trend, 0.0, depth),
                           int(round(CURVE_SMOOTH_SEC / LEVEL_HOP_SEC)))
    gain = np.maximum(gain, 0.0)                     # boost-only 는 불변식이다
    if float(gain.max()) <= 0.0:
        return off(REASON_BELOW_GATE, statistic)

    cap = _headroom_cap_db(samples, sr, t, gain, protected)
    if cap is not None:
        gain = np.minimum(gain, cap)
    return MacroGainPlan(True, REASON_APPLIED, statistic, gate, gain, t, sr,
                         float(gain.max()), cap, protected)


def _curve_for_samples(total, sr, times, gain_db, protected):
    """창 중심 좌표의 곡선을 샘플 축으로 편다. 보호 구간은 진입 시점 값으로 고정한다."""
    xs = np.arange(total, dtype="float64") / float(sr)
    g = np.interp(xs, times, gain_db, left=float(gain_db[0]), right=float(gain_db[-1]))
    for s, e in protected:
        g[s:e] = g[s] if s > 0 else 0.0
    return g


#: 클리핑 판정 상한. 오디오 임계값이 아니라 float32 반올림이 full scale 로 올라붙는 것을 막는
#: 수치 여유다(float64 로 0.9999 여도 float32 로 캐스팅하면 1.0 이 될 수 있다).
_PEAK_CEILING = 0.999


def _headroom_cap_db(samples, sr, times, gain_db, protected):
    """클리핑이 나지 않는 최대 boost 상한. 곡선을 통째로 낮추지 않는다(그러면 감쇠가 생긴다)."""
    a = np.asarray(samples, dtype="float64")
    total = a.shape[0]
    top = float(np.abs(a).max()) if a.size else 0.0
    if top <= 0.0:
        return None
    g = _curve_for_samples(total, sr, times, gain_db, protected)
    lin = 10.0 ** (g / 20.0)
    peak = float(np.abs(a * (lin[:, None] if a.ndim == 2 else lin)).max())
    if peak < _PEAK_CEILING:
        return None
    lo, hi = 0.0, float(gain_db.max())
    for _ in range(40):
        mid = (lo + hi) / 2.0
        lin = 10.0 ** (np.minimum(g, mid) / 20.0)
        p = float(np.abs(a * (lin[:, None] if a.ndim == 2 else lin)).max())
        if p < _PEAK_CEILING:
            lo = mid
        else:
            hi = mid
    return lo


def apply_macro_gain(samples, sr, plan):
    """계획을 적용해 **새 배열**을 돌려준다. 길이·채널·표본율 불변. 재적용 금지."""
    if not isinstance(plan, MacroGainPlan):
        raise MacroGainError("MacroGainPlan 이 필요합니다")
    if plan._used:
        raise MacroGainError("같은 macro gain 계획을 두 번 적용할 수 없습니다",
                             code="MACRO_GAIN_DOUBLE_APPLY")
    plan._used = True
    a = np.asarray(samples)
    if not plan.applied:
        return a.copy()
    if int(sr) != plan.sample_rate:
        raise MacroGainError("계획과 다른 표본율입니다")
    g = _curve_for_samples(a.shape[0], plan.sample_rate, plan.times_sec, plan.gain_db,
                           plan.protected_spans)
    lin = 10.0 ** (g / 20.0)
    out = a.astype("float64") * (lin[:, None] if a.ndim == 2 else lin)
    if not np.all(np.isfinite(out)):
        raise MacroGainError("보정 결과에 비유한 값이 있습니다")
    if out.shape != a.shape:
        raise MacroGainError("보정이 형상을 바꿨습니다")
    result = out.astype(a.dtype if a.dtype == np.float32 else "float32")
    # 캐스팅 **후** 로 검사한다 — float64 에서 0.9999 여도 float32 에서 1.0 이 될 수 있다.
    if float(np.abs(result).max()) >= 1.0:
        raise MacroGainError("보정 결과가 클리핑됩니다", code="MACRO_GAIN_CLIPPING")
    return result


def plan_metadata(plan):
    """재현 metadata. 대사·전사·절대경로를 담지 않는다 — 수치와 enum 뿐이다."""
    if plan is None:
        return {"macro_gain_applied": False, "macro_gain_reason": "UNAVAILABLE",
                "macro_gain_statistic_db": None, "macro_gain_gate_db": None,
                "macro_gain_max_boost_db": 0.0, "macro_gain_curve_sha8": None,
                "macro_gain_headroom_cap_db": None, "macro_gain_protected_span_count": 0,
                "macro_gain_trend_window_sec": TREND_WINDOW_SEC,
                "macro_gain_level_window_sec": LEVEL_WINDOW_SEC}
    return {"macro_gain_applied": bool(plan.applied),
            "macro_gain_reason": plan.reason,
            "macro_gain_statistic_db": round(float(plan.statistic_db), 3),
            "macro_gain_gate_db": round(float(plan.gate_db), 3),
            "macro_gain_max_boost_db": round(float(plan.max_boost_db), 3),
            "macro_gain_curve_sha8": plan.curve_sha8,
            "macro_gain_headroom_cap_db": (None if plan.headroom_cap_db is None
                                           else round(float(plan.headroom_cap_db), 3)),
            "macro_gain_protected_span_count": len(plan.protected_spans),
            "macro_gain_trend_window_sec": TREND_WINDOW_SEC,
            "macro_gain_level_window_sec": LEVEL_WINDOW_SEC}
