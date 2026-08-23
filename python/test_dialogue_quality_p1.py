# -*- coding: utf-8 -*-
"""dialogue_quality_p1 단위 테스트 + 합성 평가 하니스 — 실제 음성·모델 없음.

검증: calibration 구조 / 임계 정책(min·max) / posterior 해석(overlap 다중 라벨) /
backchannel 보존(병합 없음) / 무음 / 동률 tie-break / 평가 지표(overlap·unknown P/R,
backchannel 보존율, 경계 오차) / 결정적 직렬화.
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dialogue_canonical as dc
import dialogue_quality_p1 as q1
import dialogue_quality_fixtures as fx


def _interpret(f: fx.Fixture, policy=None):
    return q1.interpret_posteriors(
        f.frame_posteriors, f.frame_rate, f.speaker_names,
        frame_confidence=f.frame_confidence, speech_mask=f.speech_mask,
        policy=policy or f.policy,
    )


# ─────────────────────────── calibration ───────────────────────────
class CalibrationTest(unittest.TestCase):
    def test_identity(self):
        c = q1.IdentityCalibrator()
        self.assertEqual(c.calibrate(0.7), 0.7)
        self.assertEqual(c.calibrate(-1.0), 0.0)
        self.assertEqual(c.calibrate(2.0), 1.0)

    def test_piecewise_linear_interp_and_clamp(self):
        c = q1.PiecewiseLinearCalibrator(knots=((0.0, 0.0), (0.5, 0.2), (1.0, 1.0)))
        self.assertAlmostEqual(c.calibrate(0.25), 0.1)   # (0,0)->(0.5,0.2) 중간
        self.assertAlmostEqual(c.calibrate(0.75), 0.6)   # (0.5,0.2)->(1,1) 중간
        self.assertAlmostEqual(c.calibrate(-0.5), 0.0)   # 좌측 클램프
        self.assertAlmostEqual(c.calibrate(5.0), 1.0)    # 우측 클램프

    def test_piecewise_from_reliability_sorts(self):
        c = q1.PiecewiseLinearCalibrator.from_reliability([(1.0, 0.9), (0.0, 0.05)])
        self.assertEqual(c.knots[0][0], 0.0)
        self.assertEqual(c.knots[-1][0], 1.0)

    def test_piecewise_requires_increasing(self):
        with self.assertRaises(ValueError):
            q1.PiecewiseLinearCalibrator(knots=((0.5, 0.1), (0.5, 0.2)))

    def test_temperature_softens(self):
        hot = q1.TemperatureCalibrator(temperature=2.0)   # 과신 완화
        # 0.9(logit>0) 를 0.5 쪽으로 당김
        self.assertLess(hot.calibrate(0.9), 0.9)
        self.assertGreater(hot.calibrate(0.9), 0.5)
        self.assertAlmostEqual(q1.TemperatureCalibrator(1.0).calibrate(0.8), 0.8, places=6)

    def test_temperature_rejects_nonpositive(self):
        with self.assertRaises(ValueError):
            q1.TemperatureCalibrator(temperature=0.0)


# ─────────────────────────── 임계 정책 ───────────────────────────
class ThresholdPolicyTest(unittest.TestCase):
    def test_clamp_and_invariant(self):
        p = q1.ThresholdPolicy(unknown_below=-0.5, review_below=2.0)
        self.assertEqual(p.unknown_below, 0.0)
        self.assertEqual(p.review_below, 1.0)

    def test_invariant_violation_raises(self):
        with self.assertRaises(ValueError):
            q1.ThresholdPolicy(unknown_below=0.8, review_below=0.3)

    def test_classify_delegates(self):
        p = q1.ThresholdPolicy(unknown_below=0.25, review_below=0.55)
        self.assertEqual(p.classify(0.9, {"A": 1.0}), dc.SegmentStatus.OK)
        self.assertEqual(p.classify(0.4, {"A": 1.0}), dc.SegmentStatus.REVIEW)
        self.assertEqual(p.classify(0.1, {"A": 1.0}), dc.SegmentStatus.UNKNOWN)
        self.assertEqual(p.classify(0.9, {}), dc.SegmentStatus.UNKNOWN)  # 빈 posterior


# ─────────────────────────── posterior 해석 헬퍼 ───────────────────────────
class HelperTest(unittest.TestCase):
    def test_normalize_row(self):
        self.assertEqual(q1.normalize_row([3.0, 1.0]), [0.75, 0.25])
        self.assertEqual(q1.normalize_row([0.0, 0.0]), [0.0, 0.0])
        self.assertEqual(q1.normalize_row([-1.0, 1.0]), [0.0, 1.0])

    def test_top2_tie_index_order(self):
        i1, p1, i2, p2 = q1.top2([0.5, 0.5])
        self.assertEqual((i1, i2), (0, 1))   # 동률 → 인덱스 오름차순

    def test_margin_confidence(self):
        self.assertAlmostEqual(q1.margin_confidence([0.9, 0.1]), 0.8)
        self.assertAlmostEqual(q1.margin_confidence([0.5, 0.5]), 0.0)

    def test_active_speakers_overlap(self):
        self.assertEqual(q1.active_speakers([0.9, 0.1], ["A", "B"]), ("A",))
        self.assertEqual(q1.active_speakers([0.55, 0.45], ["A", "B"]), ("A", "B"))
        self.assertEqual(q1.active_speakers([0.0, 0.0], ["A", "B"]), ())


# ─────────────────────────── fixture 별 해석 ───────────────────────────
class FixtureInterpretTest(unittest.TestCase):
    def test_single_speaker(self):
        f = fx.single_speaker()
        segs = _interpret(f)
        self.assertEqual(len(segs), 1)
        self.assertEqual(segs[0].speakers, ("A",))
        self.assertFalse(segs[0].is_overlap)
        self.assertEqual(segs[0].status, dc.SegmentStatus.OK)

    def test_two_person_overlap(self):
        f = fx.two_person_overlap()
        segs = _interpret(f)
        self.assertEqual(len(segs), 3)
        mid = segs[1]
        self.assertTrue(mid.is_overlap)
        self.assertEqual(mid.speakers, ("A", "B"))
        self.assertEqual(mid.status, dc.SegmentStatus.OK)  # 근거 충분

    def test_low_conf_unknown(self):
        f = fx.low_conf_unknown()
        segs = _interpret(f)
        self.assertEqual(len(segs), 1)
        self.assertFalse(segs[0].is_overlap)          # overlap 아님
        self.assertEqual(segs[0].status, dc.SegmentStatus.UNKNOWN)

    def test_short_backchannel_preserved(self):
        f = fx.short_backchannel()
        segs = _interpret(f)
        self.assertEqual(len(segs), 3)                # 병합 안 됨
        bc = segs[1]
        self.assertTrue(bc.is_backchannel)            # <500ms 보존
        self.assertEqual(bc.speakers, ("B",))
        self.assertAlmostEqual(bc.duration, 0.3, places=6)

    def test_speaker_transition_boundary(self):
        f = fx.speaker_transition_boundary()
        segs = _interpret(f)
        self.assertEqual(len(segs), 2)
        self.assertAlmostEqual(segs[0].end, 0.5, places=6)
        self.assertAlmostEqual(segs[1].start, 0.5, places=6)

    def test_silence_empty(self):
        f = fx.silence()
        self.assertEqual(_interpret(f), [])

    def test_all_backchannel_speaker_preserved(self):
        f = fx.all_backchannel_speaker()
        segs = _interpret(f)
        self.assertEqual(len(segs), 5)                # B 짧은 발화 전부 보존
        b_segs = [s for s in segs if s.speakers == ("B",)]
        self.assertEqual(len(b_segs), 2)
        self.assertTrue(all(s.is_backchannel for s in b_segs))

    def test_posterior_tie(self):
        f = fx.posterior_tie()
        segs = _interpret(f)
        self.assertEqual(len(segs), 1)
        self.assertEqual(segs[0].primary_speaker(), "A")   # 사전순 tie-break
        self.assertEqual(segs[0].speakers, ("A", "B"))     # 다중 라벨
        self.assertEqual(segs[0].status, dc.SegmentStatus.UNKNOWN)  # margin 0

    def test_threshold_min_max(self):
        f = fx.threshold_min_max()
        for policy, expected in f.policy_checks:
            segs = _interpret(f, policy=policy)
            self.assertEqual(len(segs), 1)
            self.assertEqual(segs[0].status, expected,
                             f"policy u={policy.unknown_below} r={policy.review_below}")


# ─────────────────────────── 경계 판정(frozenset + 상태 종류) ───────────────────────────
class BoundaryGroupingTest(unittest.TestCase):
    def test_rank_crossing_same_set_single_segment(self):
        # 집합 {A,B} 불변, posterior 순위만 교차 → 한 segment 유지.
        f = fx.overlap_rank_crossing()
        segs = _interpret(f)
        self.assertEqual(len(segs), 1)
        self.assertTrue(segs[0].is_overlap)
        self.assertEqual(segs[0].speakers, ("A", "B"))   # 평균 동률→라벨순 결정적
        self.assertAlmostEqual(segs[0].start, 0.0, places=6)
        self.assertAlmostEqual(segs[0].end, 1.0, places=6)

    def test_actual_set_change_splits(self):
        # 화자 집합 실제 변경({A}→{A,B}→{B}) → 분할 유지.
        post = ([[0.9, 0.1]] * 40 + [[0.55, 0.45]] * 40 + [[0.1, 0.9]] * 40)
        conf = [0.9] * 120
        segs = q1.interpret_posteriors(post, 100.0, ["A", "B"], frame_confidence=conf)
        self.assertEqual(len(segs), 3)
        self.assertEqual(segs[0].speakers, ("A",))
        self.assertEqual(frozenset(segs[1].speakers), frozenset({"A", "B"}))
        self.assertEqual(segs[2].speakers, ("B",))

    def test_status_change_splits(self):
        # 집합 {A,B} 불변이나 상태가 OK→UNKNOWN 으로 변화 → 분할 유지.
        post = [[0.55, 0.45]] * 100
        # 앞 절반 근거 충분(OK), 뒤 절반 근거 희박(UNKNOWN) — 집합은 동일.
        conf = [0.9] * 50 + [0.05] * 50
        segs = q1.interpret_posteriors(post, 100.0, ["A", "B"], frame_confidence=conf)
        self.assertEqual(len(segs), 2)
        self.assertEqual(segs[0].status, dc.SegmentStatus.OK)
        self.assertEqual(segs[1].status, dc.SegmentStatus.UNKNOWN)
        # 두 세그먼트 모두 화자 집합은 {A,B} 로 동일.
        self.assertEqual(frozenset(segs[0].speakers), frozenset({"A", "B"}))
        self.assertEqual(frozenset(segs[1].speakers), frozenset({"A", "B"}))

    def test_rank_crossing_deterministic_serialization(self):
        f = fx.overlap_rank_crossing()
        segs = _interpret(f)
        sc = q1.to_sidecar(segs, source={"fixture": f.name})
        self.assertEqual(sc.to_json(), sc.to_json())
        again = dc.CanonicalSidecar.from_json(sc.to_json())
        self.assertEqual(sc.to_json(), again.to_json())


# ─────────────────────────── 평가 지표 ───────────────────────────
class MetricsTest(unittest.TestCase):
    def test_overlap_recall_precision_perfect(self):
        f = fx.two_person_overlap()
        segs = _interpret(f)
        m = q1.overlap_metrics(segs, f.truth, f.frame_rate)
        self.assertEqual(m["recall"], 1.0)
        self.assertEqual(m["precision"], 1.0)
        self.assertGreater(m["tp"], 0)

    def test_unknown_precision_recall(self):
        f = fx.low_conf_unknown()
        segs = _interpret(f)
        m = q1.unknown_metrics(segs, f.truth, f.frame_rate)
        self.assertEqual(m["recall"], 1.0)
        self.assertEqual(m["precision"], 1.0)

    def test_backchannel_preservation_rate(self):
        f = fx.all_backchannel_speaker()
        segs = _interpret(f)
        m = q1.backchannel_preservation(segs, f.truth)
        self.assertEqual(m["total"], 2)
        self.assertEqual(m["rate"], 1.0)

    def test_boundary_error_small(self):
        f = fx.speaker_transition_boundary()
        segs = _interpret(f)
        m = q1.boundary_error(segs, f.truth)
        self.assertEqual(m["unmatched"], 0)
        self.assertLess(m["mean_boundary_err"], 0.011)   # <=1 프레임(10ms)

    def test_overlap_absent_is_unity(self):
        f = fx.single_speaker()
        segs = _interpret(f)
        m = q1.overlap_metrics(segs, f.truth, f.frame_rate)
        self.assertEqual(m["tp"], 0)
        self.assertEqual(m["precision"], 1.0)
        self.assertEqual(m["recall"], 1.0)


# ─────────────────────────── 결정적 직렬화 ───────────────────────────
class DeterministicSerializationTest(unittest.TestCase):
    def test_repeated_json_identical(self):
        f = fx.two_person_overlap()
        segs = _interpret(f)
        sc = q1.to_sidecar(segs, source={"fixture": f.name})
        self.assertEqual(sc.to_json(), sc.to_json())

    def test_order_independent(self):
        f = fx.all_backchannel_speaker()
        segs = _interpret(f)
        a = q1.to_sidecar(list(segs)).to_json()
        b = q1.to_sidecar(list(reversed(segs))).to_json()
        self.assertEqual(a, b)   # canonical 정렬 → 입력 순서 무관

    def test_roundtrip_stable(self):
        f = fx.two_person_overlap()
        segs = _interpret(f)
        sc = q1.to_sidecar(segs)
        again = dc.CanonicalSidecar.from_json(sc.to_json())
        self.assertEqual(sc.to_json(), again.to_json())


# ─────────────────────────── 평가 하니스(수치 산출) ───────────────────────────
def run_evaluation():
    """모든 fixture 를 해석하고 지표를 dict 로 반환(보고용 수치)."""
    results = {}
    for f in fx.all_fixtures():
        if f.name == "threshold_min_max":
            segs = _interpret(f, policy=q1.ThresholdPolicy())
        else:
            segs = _interpret(f)
        ov = q1.overlap_metrics(segs, f.truth, f.frame_rate)
        un = q1.unknown_metrics(segs, f.truth, f.frame_rate)
        bc = q1.backchannel_preservation(segs, f.truth)
        bd = q1.boundary_error(segs, f.truth)
        sc = q1.to_sidecar(segs, source={"fixture": f.name})
        det = sc.to_json() == q1.to_sidecar(list(reversed(segs)),
                                             source={"fixture": f.name}).to_json()
        results[f.name] = {
            "n_pred_segments": len(segs),
            "n_truth_segments": len(f.truth),
            "overlap": ov, "unknown": un,
            "backchannel": bc, "boundary": bd,
            "deterministic": det,
        }
    return results


def _aggregate(results):
    """전 fixture 프레임 합산 micro P/R (overlap·unknown) + 보존율/경계 평균."""
    def micro(keys):
        tp = sum(results[n][keys]["tp"] for n in results)
        fp = sum(results[n][keys]["fp"] for n in results)
        fn = sum(results[n][keys]["fn"] for n in results)
        return q1._prf(tp, fp, fn)
    bc_pres = sum(results[n]["backchannel"]["preserved"] for n in results)
    bc_tot = sum(results[n]["backchannel"]["total"] for n in results)
    matched = [results[n]["boundary"]["mean_boundary_err"] for n in results
               if results[n]["boundary"]["matched"] > 0]
    return {
        "overlap_micro": micro("overlap"),
        "unknown_micro": micro("unknown"),
        "backchannel_rate": (bc_pres / bc_tot) if bc_tot else 1.0,
        "backchannel_preserved": bc_pres, "backchannel_total": bc_tot,
        "mean_boundary_err": (sum(matched) / len(matched)) if matched else 0.0,
        "all_deterministic": all(results[n]["deterministic"] for n in results),
    }


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--eval":
        res = run_evaluation()
        agg = _aggregate(res)
        print(json.dumps({"per_fixture": res, "aggregate": agg},
                         ensure_ascii=False, indent=2, sort_keys=True))
    else:
        unittest.main()
