# -*- coding: utf-8 -*-
"""대화 품질 P1 — posterior 해석 · overlap 다중 라벨 · 임계/calibration · 평가 지표.

이 모듈은 순수(pure) 해석 계층이다. torch/numpy/모델/오디오/파일 I/O에 의존하지
않고, `dialogue_canonical`(develop 코어)의 데이터 구조만 참조한다. 코어는 수정하지
않는다(읽기 전용 참조).

★ 이 모듈이 하는 일과 하지 않는 일 (명확히):
  - 하는 일: conversation_worker 가 만든 프레임별 화자 posterior(=speaker_scores)와
    선택적 프레임 신뢰도(=speaker_weights 유래 근거량)를 *해석* 하여
      · posterior 기반 overlap(동시 발화) 다중 라벨 세그먼트,
      · confidence calibration 을 통과한 UNKNOWN/REVIEW/OK 상태,
      · 짧은 backchannel 을 병합·삭제 없이 보존한 세그먼트
    로 표준화한다.
  - 하지 않는 일: 이것은 "source separation(음원 분리)" 이 아니다. production
    경로(conversation_worker.py)는 argmax 단일 화자 마스킹으로 WAV/track 을 만든다.
    이 모듈은 그 argmax 결과와 별개로, posterior 를 *해석* 만 하며 production 오디오
    출력을 바꾸지 않는다. "완전한 화자 분리"라고 표현하지 않는다.

★ posterior 만으로는 구별할 수 없는 근본 한계(정직하게 기록):
  cosine-유사도 posterior 는 n_speakers 에 대해 합=1 로 정규화된다. 2인 기준
  0.5/0.5 프레임은 "둘 다 말함(overlap)" 인지 "둘 중 누군지 모름(unknown)" 인지
  posterior 모양만으로는 구별할 수 없다. 그래서 이 모듈은 두 신호를 분리해 쓴다:
    · overlap  ← posterior 질량(2순위 화자 >= overlap_min_posterior)
    · unknown  ← 별도 confidence 신호(프레임 근거량/margin), calibration 후 임계
  confidence 를 주지 않으면 top1-top2 margin 을 대용으로 쓴다.
"""

from __future__ import annotations

import math
import os
import sys
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dialogue_canonical as dc  # develop 코어 — 읽기 전용 참조, 수정 금지.


# ─────────────────────────────────────────────────────────────────────────
# Confidence calibration 구조 (순수·결정적)
#
# calibration 은 "원시 신뢰 신호 → 보정된 confidence[0,1]" 매핑이다. 실제 모델·
# 데이터로 fitting 하지 않는다(합성/구조만). 세 가지 구조를 제공한다:
#   IdentityCalibrator        : 그대로 통과(기본).
#   PiecewiseLinearCalibrator : (raw, cal) knot 사이 선형 보간 — reliability map.
#   TemperatureCalibrator     : 온도 스케일링(logit/T → sigmoid). T>1 은 과신 완화.
# ─────────────────────────────────────────────────────────────────────────

def _clamp01(x: float) -> float:
    if x < 0.0:
        return 0.0
    if x > 1.0:
        return 1.0
    return x


class Calibrator:
    """confidence 보정기 인터페이스. calibrate(raw)->[0,1] 결정적."""
    def calibrate(self, raw: float) -> float:  # pragma: no cover - 인터페이스
        raise NotImplementedError


class IdentityCalibrator(Calibrator):
    def calibrate(self, raw: float) -> float:
        return _clamp01(float(raw))


@dataclass(frozen=True)
class PiecewiseLinearCalibrator(Calibrator):
    """(raw, cal) knot 사이 선형 보간. knot 은 raw 기준 정렬·[0,1] 클램프.

    reliability diagram(예측 신뢰 vs 실측 정확도)을 knot 으로 넣으면 신뢰도 보정이
    된다. from_reliability 로 (predicted, empirical) 쌍에서 바로 만들 수 있다.
    """
    knots: Tuple[Tuple[float, float], ...]

    def __post_init__(self):
        if len(self.knots) < 2:
            raise ValueError("PiecewiseLinearCalibrator: knot 은 최소 2개")
        xs = [k[0] for k in self.knots]
        if any(b <= a for a, b in zip(xs, xs[1:])):
            raise ValueError("knot 의 raw 값은 순증가(strictly increasing) 여야 함")

    @classmethod
    def from_reliability(cls, pairs: Sequence[Tuple[float, float]]) -> "PiecewiseLinearCalibrator":
        ordered = tuple(sorted((float(p), float(q)) for p, q in pairs))
        return cls(knots=ordered)

    def calibrate(self, raw: float) -> float:
        x = float(raw)
        ks = self.knots
        if x <= ks[0][0]:
            return _clamp01(ks[0][1])
        if x >= ks[-1][0]:
            return _clamp01(ks[-1][1])
        for (x0, y0), (x1, y1) in zip(ks, ks[1:]):
            if x0 <= x <= x1:
                t = (x - x0) / (x1 - x0)
                return _clamp01(y0 + t * (y1 - y0))
        return _clamp01(x)  # pragma: no cover - 방어


@dataclass(frozen=True)
class TemperatureCalibrator(Calibrator):
    """온도 스케일링: p -> sigmoid(logit(p)/T). T>1 과신 완화, T<1 심화."""
    temperature: float = 1.0

    def __post_init__(self):
        if self.temperature <= 0:
            raise ValueError(f"temperature 는 >0: {self.temperature}")

    def calibrate(self, raw: float) -> float:
        p = _clamp01(float(raw))
        eps = 1e-9
        p = min(max(p, eps), 1.0 - eps)
        logit = math.log(p / (1.0 - p))
        z = logit / self.temperature
        return _clamp01(1.0 / (1.0 + math.exp(-z)))


# ─────────────────────────────────────────────────────────────────────────
# UNKNOWN/REVIEW 임계 정책
# ─────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ThresholdPolicy:
    """confidence 기반 상태 임계. [0,1] 클램프 + unknown<=review 불변식 강제."""
    unknown_below: float = dc.DEFAULT_UNKNOWN_BELOW
    review_below: float = dc.DEFAULT_REVIEW_BELOW

    def __post_init__(self):
        u = _clamp01(self.unknown_below)
        r = _clamp01(self.review_below)
        object.__setattr__(self, "unknown_below", u)
        object.__setattr__(self, "review_below", r)
        if u > r:
            raise ValueError(f"unknown_below({u}) 는 review_below({r}) 이하여야 함")

    def classify(self, confidence: float, posterior: Dict[str, float]) -> dc.SegmentStatus:
        return dc.classify_status(confidence, posterior,
                                  review_below=self.review_below,
                                  unknown_below=self.unknown_below)


DEFAULT_POLICY = ThresholdPolicy()


# ─────────────────────────────────────────────────────────────────────────
# posterior 해석 헬퍼 (순수)
# ─────────────────────────────────────────────────────────────────────────

def normalize_row(row: Sequence[float]) -> List[float]:
    """프레임 posterior 한 행을 음수 클램프 후 합=1 정규화. 합<=0 이면 전부 0."""
    clamped = [max(0.0, float(v)) for v in row]
    total = sum(clamped)
    if total <= 0.0:
        return [0.0] * len(clamped)
    return [v / total for v in clamped]


def top2(row: Sequence[float]) -> Tuple[int, float, int, float]:
    """정규화 행에서 (top1_idx, top1_p, top2_idx, top2_p). 동률은 인덱스 오름차순.

    길이<2 면 top2_idx=-1, top2_p=0.0.
    """
    idxs = sorted(range(len(row)), key=lambda i: (-row[i], i))
    i1 = idxs[0]
    p1 = row[i1]
    if len(idxs) >= 2:
        i2 = idxs[1]
        p2 = row[i2]
    else:
        i2, p2 = -1, 0.0
    return i1, p1, i2, p2


def margin_confidence(row: Sequence[float]) -> float:
    """top1-top2 margin 을 confidence 대용으로. 단일 화자면 top1 자체."""
    _, p1, _, p2 = top2(row)
    return _clamp01(p1 - p2)


def active_speakers(row: Sequence[float],
                    speaker_names: Sequence[str],
                    overlap_min_posterior: float = dc.DEFAULT_OVERLAP_MIN_POSTERIOR) -> Tuple[str, ...]:
    """posterior 행 → 활성 화자 집합(overlap 다중 라벨).

    top1 은 항상 포함(합>0 인 경우). 그 외 화자는 posterior>=overlap_min_posterior
    이면 동시 발화로 포함. 반환은 (posterior 내림차순, 라벨 오름차순) 정렬 튜플.
    합<=0(무음/미배정) 이면 빈 튜플.
    """
    norm = normalize_row(row)
    if sum(norm) <= 0.0:
        return ()
    i1, p1, _, _ = top2(norm)
    chosen = {i1}
    for i, p in enumerate(norm):
        if i != i1 and p >= overlap_min_posterior:
            chosen.add(i)
    ordered = sorted(chosen, key=lambda i: (-norm[i], speaker_names[i]))
    return tuple(speaker_names[i] for i in ordered)


# ─────────────────────────────────────────────────────────────────────────
# 핵심: 프레임 posterior 타임라인 → 해석 세그먼트 (순수)
#
# ★ 이것이 conversation_worker.py 후속 배선 지점의 소비자다. worker 는
#   speaker_scores(:296, normalize :336)와 frame_labels(:342, np.argmax) 를 갖는다.
#   ★ 반드시 병합 전 신호(speaker_scores / frame_labels)를 넘긴다 — 병합 후
#     `smoothed`(:354~383, MIN_TURN_FRAMES=50=500ms 병합)는 <500ms backchannel 이
#     이미 소실됐다. 이 모듈은 병합 전 posterior 를 써서 backchannel 을 보존한다.
#   ★ production WAV/track 출력(:385~)은 그대로 두고 이 해석만 사이드카로 추가한다.
# ─────────────────────────────────────────────────────────────────────────

def interpret_posteriors(
    frame_posteriors: Sequence[Sequence[float]],
    frame_rate: float,
    speaker_names: Sequence[str],
    frame_confidence: Optional[Sequence[float]] = None,
    speech_mask: Optional[Sequence[bool]] = None,
    calibrator: Optional[Calibrator] = None,
    policy: ThresholdPolicy = DEFAULT_POLICY,
    overlap_min_posterior: float = dc.DEFAULT_OVERLAP_MIN_POSTERIOR,
) -> List[dc.DialogueSegment]:
    """프레임별 posterior 를 해석해 overlap 다중 라벨 + 상태 세그먼트로 묶는다.

    frame_posteriors : [n_frames][n_speakers] 확률(정규화 전이어도 됨).
    frame_rate       : 프레임/초 (worker PROB_SR=100 대응).
    speaker_names    : 인덱스→라벨.
    frame_confidence : 선택 — 프레임별 근거 신뢰[0,1] (worker speaker_weights 유래).
                       주면 세그먼트 confidence = 구간 평균(→calibration). 없으면
                       posterior margin(top1-top2)을 대용.
    speech_mask      : 선택 — False 프레임은 무음으로 세그먼트 경계.
    calibrator       : confidence 보정기(기본 Identity).
    policy           : UNKNOWN/REVIEW 임계.
    overlap_min_posterior : 2순위 화자 동시 발화 판정 임계.

    ★ <500ms turn 도 병합·삭제 없이 그대로 세그먼트로 보존(backchannel 손실 방지).
      활성 화자 *집합* 이 바뀌는 지점에서만 경계를 만든다 → overlap 진입/이탈도 경계.
    """
    cal = calibrator or IdentityCalibrator()
    n = len(frame_posteriors)
    if n == 0:
        return []
    if frame_rate <= 0:
        raise ValueError(f"frame_rate must be >0: {frame_rate}")

    def is_speech(f: int) -> bool:
        if speech_mask is not None and not speech_mask[f]:
            return False
        return sum(max(0.0, float(v)) for v in frame_posteriors[f]) > 0.0

    # 프레임별 활성 집합(무음이면 None).
    frame_active: List[Optional[Tuple[str, ...]]] = []
    for f in range(n):
        if not is_speech(f):
            frame_active.append(None)
        else:
            frame_active.append(active_speakers(frame_posteriors[f], speaker_names,
                                                overlap_min_posterior))

    segments: List[dc.DialogueSegment] = []
    i = 0
    while i < n:
        act = frame_active[i]
        if act is None or len(act) == 0:
            i += 1
            continue
        j = i
        while j < n and frame_active[j] == act:
            j += 1
        start = i / frame_rate
        end = j / frame_rate

        # 구간 posterior 평균 → 정규화.
        ncols = len(speaker_names)
        acc = [0.0] * ncols
        conf_acc = 0.0
        cnt = 0
        for f in range(i, j):
            row = normalize_row(frame_posteriors[f])
            for c in range(min(ncols, len(row))):
                acc[c] += row[c]
            if frame_confidence is not None:
                conf_acc += _clamp01(float(frame_confidence[f]))
            else:
                conf_acc += margin_confidence(frame_posteriors[f])
            cnt += 1
        mean_post = {speaker_names[c]: (acc[c] / cnt) for c in range(ncols)} if cnt else {}
        raw_conf = (conf_acc / cnt) if cnt else 0.0
        conf = cal.calibrate(raw_conf)

        # 활성 집합을 명시 speakers 로 강제(posterior 기반 overlap 라벨 보존).
        seg = dc.make_segment(
            start, end,
            posterior=mean_post,
            confidence=conf,
            speakers=list(act),
            review_below=policy.review_below,
            unknown_below=policy.unknown_below,
        )
        segments.append(seg)
        i = j
    return segments


# ─────────────────────────────────────────────────────────────────────────
# 평가 지표 (순수·결정적)
#
# overlap/unknown 은 공통 프레임 격자에 rasterize 후 프레임 단위 P/R.
# backchannel 보존율·경계 오차는 세그먼트 매칭 기반.
# ─────────────────────────────────────────────────────────────────────────

def _grid_frames(segments: Sequence[dc.DialogueSegment], frame_rate: float) -> int:
    end = 0.0
    for s in segments:
        end = max(end, s.end)
    return int(round(end * frame_rate))


def rasterize_active(segments: Sequence[dc.DialogueSegment],
                     frame_rate: float, n_frames: int) -> List[frozenset]:
    """세그먼트를 프레임 격자의 활성 화자 집합으로 전개(무음=빈 집합)."""
    grid: List[set] = [set() for _ in range(n_frames)]
    for s in segments:
        a = int(round(s.start * frame_rate))
        b = int(round(s.end * frame_rate))
        a = max(0, a)
        b = min(n_frames, b)
        for f in range(a, b):
            grid[f].update(s.speakers)
    return [frozenset(x) for x in grid]


def rasterize_status(segments: Sequence[dc.DialogueSegment],
                     frame_rate: float, n_frames: int) -> List[Optional[dc.SegmentStatus]]:
    """프레임별 상태(겹치면 마지막 세그먼트 우선; 결정적 정렬 후 전개)."""
    grid: List[Optional[dc.SegmentStatus]] = [None] * n_frames
    for s in sorted(segments, key=dc.canonical_sort_key):
        a = max(0, int(round(s.start * frame_rate)))
        b = min(n_frames, int(round(s.end * frame_rate)))
        for f in range(a, b):
            grid[f] = s.status
    return grid


def _prf(tp: int, fp: int, fn: int) -> Dict[str, float]:
    precision = tp / (tp + fp) if (tp + fp) > 0 else 1.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 1.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0.0
    return {"precision": precision, "recall": recall, "f1": f1,
            "tp": tp, "fp": fp, "fn": fn}


def overlap_metrics(pred: Sequence[dc.DialogueSegment],
                    truth: Sequence[dc.DialogueSegment],
                    frame_rate: float) -> Dict[str, float]:
    """프레임 단위 overlap(활성 화자>=2) precision/recall/f1."""
    n = max(_grid_frames(pred, frame_rate), _grid_frames(truth, frame_rate))
    pa = rasterize_active(pred, frame_rate, n)
    ta = rasterize_active(truth, frame_rate, n)
    tp = fp = fn = 0
    for f in range(n):
        p = len(pa[f]) >= 2
        t = len(ta[f]) >= 2
        if p and t:
            tp += 1
        elif p and not t:
            fp += 1
        elif t and not p:
            fn += 1
    return _prf(tp, fp, fn)


def unknown_metrics(pred: Sequence[dc.DialogueSegment],
                    truth: Sequence[dc.DialogueSegment],
                    frame_rate: float) -> Dict[str, float]:
    """프레임 단위 UNKNOWN 상태 precision/recall/f1."""
    n = max(_grid_frames(pred, frame_rate), _grid_frames(truth, frame_rate))
    ps = rasterize_status(pred, frame_rate, n)
    ts = rasterize_status(truth, frame_rate, n)
    tp = fp = fn = 0
    for f in range(n):
        p = ps[f] == dc.SegmentStatus.UNKNOWN
        t = ts[f] == dc.SegmentStatus.UNKNOWN
        if p and t:
            tp += 1
        elif p and not t:
            fp += 1
        elif t and not p:
            fn += 1
    return _prf(tp, fp, fn)


def _overlap_dur(a: dc.DialogueSegment, b: dc.DialogueSegment) -> float:
    return max(0.0, min(a.end, b.end) - max(a.start, b.start))


def backchannel_preservation(pred: Sequence[dc.DialogueSegment],
                             truth: Sequence[dc.DialogueSegment]) -> Dict[str, float]:
    """실측 backchannel(<500ms, 화자 있음) 중 예측이 짧은 세그먼트로 보존한 비율.

    보존 판정: 시간 겹침>0 인 예측 세그먼트가 존재하고 그것도 backchannel(짧음).
    """
    truth_bc = [s for s in truth if s.is_backchannel and s.speakers]
    if not truth_bc:
        return {"preserved": 0, "total": 0, "rate": 1.0}
    preserved = 0
    for t in truth_bc:
        for p in pred:
            if _overlap_dur(p, t) > 0.0 and p.is_backchannel:
                preserved += 1
                break
    return {"preserved": preserved, "total": len(truth_bc),
            "rate": preserved / len(truth_bc)}


def boundary_error(pred: Sequence[dc.DialogueSegment],
                   truth: Sequence[dc.DialogueSegment]) -> Dict[str, float]:
    """실측↔예측 매칭(시간 겹침 최대) 후 경계(start/end) 절대 오차 평균(초).

    매칭 안 되는 실측 세그먼트는 unmatched 로 카운트(오차 평균에서 제외).
    """
    start_errs: List[float] = []
    end_errs: List[float] = []
    unmatched = 0
    for t in truth:
        best = None
        best_ov = 0.0
        for p in pred:
            ov = _overlap_dur(p, t)
            if ov > best_ov:
                best_ov = ov
                best = p
        if best is None:
            unmatched += 1
            continue
        start_errs.append(abs(best.start - t.start))
        end_errs.append(abs(best.end - t.end))
    matched = len(start_errs)
    mean_start = sum(start_errs) / matched if matched else 0.0
    mean_end = sum(end_errs) / matched if matched else 0.0
    return {"matched": matched, "unmatched": unmatched,
            "mean_start_err": mean_start, "mean_end_err": mean_end,
            "mean_boundary_err": (mean_start + mean_end) / 2.0}


def to_sidecar(segments: Sequence[dc.DialogueSegment],
               source: Optional[Dict[str, str]] = None) -> dc.CanonicalSidecar:
    """해석 세그먼트를 코어 CanonicalSidecar 로 감싼다(결정적 직렬화 재사용)."""
    return dc.CanonicalSidecar(segments=list(segments), source=dict(source or {}))
