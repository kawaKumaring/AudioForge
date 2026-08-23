# -*- coding: utf-8 -*-
"""대화 품질 P1 합성 평가 fixture — 실제 음성·모델·오디오 없음(순수 합성).

각 fixture 는 프레임 posterior 타임라인(+선택 confidence/speech_mask)과 의도된
ground-truth 세그먼트를 제공한다. 이것으로 interpret_posteriors 의 overlap/unknown/
backchannel/경계 동작을 수치로 평가한다.

필수 시나리오 9종:
  single_speaker / two_person_overlap / low_conf_unknown / short_backchannel /
  speaker_transition_boundary / silence / all_backchannel_speaker /
  posterior_tie / threshold_min_max
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dialogue_canonical as dc
import dialogue_quality_p1 as q1


FRAME_RATE = 100.0  # worker PROB_SR 과 동일(10ms 프레임)


@dataclass
class Fixture:
    name: str
    frame_rate: float
    speaker_names: List[str]
    frame_posteriors: List[List[float]]
    truth: List[dc.DialogueSegment]
    note: str
    frame_confidence: Optional[List[float]] = None
    speech_mask: Optional[List[bool]] = None
    policy: q1.ThresholdPolicy = q1.DEFAULT_POLICY
    # threshold_min_max 전용: (정책, 기대 상태) 목록.
    policy_checks: List[Tuple[q1.ThresholdPolicy, dc.SegmentStatus]] = field(default_factory=list)


def _rows(n: int, row: List[float]) -> List[List[float]]:
    return [list(row) for _ in range(n)]


def _truth_seg(start, end, posterior, confidence, speakers) -> dc.DialogueSegment:
    return dc.make_segment(start, end, posterior=posterior,
                           confidence=confidence, speakers=list(speakers))


# ── 1. 단일 화자 ──
def single_speaker() -> Fixture:
    post = _rows(100, [1.0, 0.0])           # A 1.0s
    truth = [_truth_seg(0.0, 1.0, {"A": 1.0, "B": 0.0}, 1.0, ["A"])]
    return Fixture("single_speaker", FRAME_RATE, ["A", "B"], post, truth,
                   "A 혼자 1.0s. overlap 없음, OK.")


# ── 2. 2인 overlap ──
def two_person_overlap() -> Fixture:
    post = (_rows(50, [0.9, 0.1])           # A 단독 0.0~0.5
            + _rows(50, [0.55, 0.45])        # overlap 0.5~1.0
            + _rows(50, [0.1, 0.9]))         # B 단독 1.0~1.5
    conf = [0.9] * 150                        # 근거 충분 → overlap 은 OK(불명확 아님)
    truth = [
        _truth_seg(0.0, 0.5, {"A": 0.9, "B": 0.1}, 0.9, ["A"]),
        _truth_seg(0.5, 1.0, {"A": 0.55, "B": 0.45}, 0.9, ["A", "B"]),
        _truth_seg(1.0, 1.5, {"A": 0.1, "B": 0.9}, 0.9, ["B"]),
    ]
    return Fixture("two_person_overlap", FRAME_RATE, ["A", "B"], post, truth,
                   "가운데 0.5s 동시 발화 → 다중 라벨(A,B).", frame_confidence=conf)


# ── 3. 저신뢰 UNKNOWN ──
def low_conf_unknown() -> Fixture:
    post = _rows(100, [0.8, 0.2])           # posterior 는 A 우세지만
    conf = [0.1] * 100                        # 근거 신뢰 낮음 → UNKNOWN
    truth = [_truth_seg(0.0, 1.0, {"A": 0.8, "B": 0.2}, 0.1, ["A"])]
    return Fixture("low_conf_unknown", FRAME_RATE, ["A", "B"], post, truth,
                   "posterior 는 A 우세, 근거 신뢰 0.1 → UNKNOWN(overlap 아님).",
                   frame_confidence=conf)


# ── 4. 짧은 backchannel ──
def short_backchannel() -> Fixture:
    post = (_rows(100, [0.9, 0.1])           # A 0.0~1.0
            + _rows(30, [0.1, 0.9])          # B 맞장구 1.0~1.3 (0.3s<500ms)
            + _rows(70, [0.9, 0.1]))         # A 1.3~2.0
    truth = [
        _truth_seg(0.0, 1.0, {"A": 0.9, "B": 0.1}, 0.8, ["A"]),
        _truth_seg(1.0, 1.3, {"A": 0.1, "B": 0.9}, 0.8, ["B"]),   # backchannel
        _truth_seg(1.3, 2.0, {"A": 0.9, "B": 0.1}, 0.8, ["A"]),
    ]
    return Fixture("short_backchannel", FRAME_RATE, ["A", "B"], post, truth,
                   "B 0.3s 맞장구 — 병합·삭제 없이 backchannel 로 보존돼야 함.")


# ── 5. 화자 전환 경계 ──
def speaker_transition_boundary() -> Fixture:
    post = _rows(50, [0.9, 0.1]) + _rows(50, [0.1, 0.9])   # 0.5s 에서 급전환
    truth = [
        _truth_seg(0.0, 0.5, {"A": 0.9, "B": 0.1}, 0.8, ["A"]),
        _truth_seg(0.5, 1.0, {"A": 0.1, "B": 0.9}, 0.8, ["B"]),
    ]
    return Fixture("speaker_transition_boundary", FRAME_RATE, ["A", "B"], post, truth,
                   "0.5s 경계 급전환 — 경계 오차 ~0 이어야 함.")


# ── 6. 무음 ──
def silence() -> Fixture:
    post = _rows(50, [0.5, 0.5])            # 값은 있으나
    mask = [False] * 50                       # 전 구간 무음 마스크
    return Fixture("silence", FRAME_RATE, ["A", "B"], post, [],
                   "전 구간 무음 → 세그먼트 0개.", speech_mask=mask)


# ── 7. 전량 backchannel 화자 ──
def all_backchannel_speaker() -> Fixture:
    # A 는 0.6s 정상 발화(>500ms), B 는 항상 0.2s 맞장구(<500ms).
    post = (_rows(60, [0.9, 0.1])            # A 0.0~0.6
            + _rows(20, [0.1, 0.9])          # B 0.6~0.8 (0.2s)
            + _rows(60, [0.9, 0.1])          # A 0.8~1.4
            + _rows(20, [0.1, 0.9])          # B 1.4~1.6 (0.2s)
            + _rows(60, [0.9, 0.1]))         # A 1.6~2.2
    truth = [
        _truth_seg(0.0, 0.6, {"A": 0.9, "B": 0.1}, 0.8, ["A"]),
        _truth_seg(0.6, 0.8, {"A": 0.1, "B": 0.9}, 0.8, ["B"]),   # backchannel
        _truth_seg(0.8, 1.4, {"A": 0.9, "B": 0.1}, 0.8, ["A"]),
        _truth_seg(1.4, 1.6, {"A": 0.1, "B": 0.9}, 0.8, ["B"]),   # backchannel
        _truth_seg(1.6, 2.2, {"A": 0.9, "B": 0.1}, 0.8, ["A"]),
    ]
    return Fixture("all_backchannel_speaker", FRAME_RATE, ["A", "B"], post, truth,
                   "B 는 항상 0.2s 짧은 발화 — 모두 backchannel 로 보존(병합 시 소실).")


# ── 8. posterior 동률 ──
def posterior_tie() -> Fixture:
    post = _rows(100, [0.5, 0.5])           # 완전 동률, confidence 미지정→margin=0
    truth = [_truth_seg(0.0, 1.0, {"A": 0.5, "B": 0.5}, 0.0, ["A", "B"])]
    return Fixture("posterior_tie", FRAME_RATE, ["A", "B"], post, truth,
                   "0.5/0.5 동률 → 라벨 사전순 tie-break(A 우선)+다중 라벨, margin0→UNKNOWN.")


# ── 9. threshold min·max ──
def threshold_min_max() -> Fixture:
    post = _rows(100, [1.0, 0.0])
    conf = [0.5] * 100                        # 중간 confidence
    truth = [_truth_seg(0.0, 1.0, {"A": 1.0, "B": 0.0}, 0.5, ["A"])]
    checks = [
        # min: unknown_below=0, review_below=0 → conf 0.5 는 항상 OK
        (q1.ThresholdPolicy(unknown_below=0.0, review_below=0.0), dc.SegmentStatus.OK),
        # max: unknown_below=1, review_below=1 → conf 0.5 는 항상 UNKNOWN
        (q1.ThresholdPolicy(unknown_below=1.0, review_below=1.0), dc.SegmentStatus.UNKNOWN),
        # 중간: 기본 정책 → conf 0.5 는 REVIEW(0.25<=0.5<0.55)
        (q1.ThresholdPolicy(), dc.SegmentStatus.REVIEW),
    ]
    return Fixture("threshold_min_max", FRAME_RATE, ["A", "B"], post, truth,
                   "동일 입력이 정책 min→OK, max→UNKNOWN, 기본→REVIEW 로 갈림.",
                   frame_confidence=conf, policy_checks=checks)


ALL_FIXTURES = [
    single_speaker,
    two_person_overlap,
    low_conf_unknown,
    short_backchannel,
    speaker_transition_boundary,
    silence,
    all_backchannel_speaker,
    posterior_tie,
    threshold_min_max,
]


def all_fixtures() -> List[Fixture]:
    return [f() for f in ALL_FIXTURES]
