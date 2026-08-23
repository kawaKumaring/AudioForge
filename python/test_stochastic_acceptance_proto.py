# -*- coding: utf-8 -*-
"""stochastic_acceptance_proto 단위테스트 — 합성 수치만, GPU/합성/모델 없음.

검증: Wilson CI · rule-of-three · required_n · token_bucket 경계 · classify 재사용 · envelope/margin ·
bounded 강제(check_bounded) · aggregate 계수(세 acceptance 분리) · G2 관측 재현(tok18→cap213→tail, margin≈4.73).
"""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import generation_limit as gl
import stochastic_acceptance_proto as sap


class WilsonTest(unittest.TestCase):
    def test_known_midpoint(self):
        lo, hi = sap.wilson_interval(47, 50)
        # 0.94 근방, Wilson 폭은 대략 [0.84, 0.98]
        self.assertAlmostEqual((lo + hi) / 2, 0.905, delta=0.03)  # center는 p̂보다 약간 낮음
        self.assertGreater(lo, 0.83)
        self.assertLess(hi, 0.99)
        self.assertTrue(0.0 <= lo <= hi <= 1.0)

    def test_all_success_upper_is_one_lower_below_one(self):
        lo, hi = sap.wilson_interval(50, 50)
        self.assertEqual(hi, 1.0)
        self.assertGreater(lo, 0.9)
        self.assertLess(lo, 1.0)

    def test_zero_success(self):
        lo, hi = sap.wilson_interval(0, 50)
        self.assertEqual(lo, 0.0)
        self.assertGreater(hi, 0.0)
        self.assertLess(hi, 0.1)

    def test_n_zero_no_information(self):
        self.assertEqual(sap.wilson_interval(0, 0), (0.0, 1.0))

    def test_validation(self):
        for bad in ((-1, 5), (6, 5), (2, -1)):
            with self.assertRaises(ValueError):
                sap.wilson_interval(*bad)


class RuleOfThreeAndNTest(unittest.TestCase):
    def test_rule_of_three(self):
        self.assertAlmostEqual(sap.rule_of_three_upper(50), 0.06)
        self.assertAlmostEqual(sap.rule_of_three_upper(300), 0.01)
        self.assertAlmostEqual(sap.rule_of_three_upper(30), 0.1)
        self.assertEqual(sap.rule_of_three_upper(0), 1.0)

    def test_required_n_for_margin_worst_case(self):
        # E=0.10 → ~96, E=0.05 → ~385 (z=1.96, p=0.5)
        self.assertEqual(sap.required_n_for_margin(0.10), math.ceil(1.959963984540054**2 * 0.25 / 0.01))
        self.assertGreaterEqual(sap.required_n_for_margin(0.10), 96)
        self.assertLessEqual(sap.required_n_for_margin(0.10), 97)
        self.assertGreaterEqual(sap.required_n_for_margin(0.05), 384)
        self.assertLessEqual(sap.required_n_for_margin(0.05), 385)

    def test_required_n_for_upper_bound(self):
        self.assertEqual(sap.required_n_for_upper_bound(0.05), 60)
        self.assertEqual(sap.required_n_for_upper_bound(0.01), 300)

    def test_required_n_validation(self):
        for bad in (0, 1, -0.1, 1.5):
            with self.assertRaises(ValueError):
                sap.required_n_for_margin(bad)
            with self.assertRaises(ValueError):
                sap.required_n_for_upper_bound(bad)


class BucketAndClassifyTest(unittest.TestCase):
    def test_bucket_boundaries(self):
        # B1: unclamped <= MIN_LIMIT(200). unclamped(tok)=ceil(2.9*tok+160).
        #   tok=13 → ceil(197.7)=198 <=200 → B1 ; tok=14 → ceil(200.6)=201 >200 → B2
        self.assertEqual(sap.token_bucket(1), "B1")
        self.assertEqual(sap.token_bucket(13), "B1")
        self.assertEqual(sap.token_bucket(14), "B2")
        self.assertEqual(sap.token_bucket(18), "B2")   # G2
        self.assertEqual(sap.token_bucket(33), "B2")   # 채택 최대
        self.assertEqual(sap.token_bucket(34), "OVER") # 자동분할 대상
        self.assertEqual(gl.max_segment_tokens(), 33)

    def test_classify_reuses_generation_limit(self):
        self.assertEqual(sap.classify_trial({"prod_tokens": 18, "iters": 212}), "completed_before_limit")
        self.assertEqual(sap.classify_trial({"prod_tokens": 18, "iters": 213}), "generation_limit")
        # applied_limit 명시가 있으면 그것을 사용
        self.assertEqual(sap.classify_trial({"prod_tokens": 18, "iters": 200, "applied_limit": 200}),
                         "generation_limit")

    def test_resolve_limit_matches_formula(self):
        self.assertEqual(sap.resolve_limit({"prod_tokens": 18}), 213)   # ceil(2.9*18+160)=213
        self.assertEqual(sap.resolve_limit({"prod_tokens": 18, "applied_limit": 999}), 999)

    def test_envelope_and_margin(self):
        env = sap.normal_envelope(18)
        self.assertAlmostEqual(env, 45.048, places=3)
        self.assertAlmostEqual(213 / env, 4.728, places=2)   # G2 margin 4.7배


class CheckBoundedTest(unittest.TestCase):
    def _trial(self, tok=18, iters=100, mode="icl", emo="default"):
        return {"prod_tokens": tok, "iters": iters, "mode": mode, "emotion": emo}

    def test_exact_count_passes(self):
        plan = {("B2", "icl", "default"): 3}
        trials = [self._trial(iters=i) for i in (40, 41, 213)]
        self.assertTrue(sap.check_bounded(trials, plan))

    def test_early_stop_underrun_fails(self):
        plan = {("B2", "icl", "default"): 5}
        trials = [self._trial(iters=40), self._trial(iters=41)]
        with self.assertRaises(AssertionError):
            sap.check_bounded(trials, plan)

    def test_extra_reruns_overrun_fails(self):
        # "통과할 때까지 반복" = 계획 3인데 completed 나올 때까지 5회 → 초과 감지
        plan = {("B2", "icl", "default"): 3}
        trials = [self._trial(iters=i) for i in (213, 213, 213, 213, 40)]
        with self.assertRaises(AssertionError):
            sap.check_bounded(trials, plan)

    def test_unregistered_cell_fails(self):
        plan = {("B2", "icl", "default"): 1}
        trials = [self._trial(), self._trial(mode="xvector")]
        with self.assertRaises(AssertionError):
            sap.check_bounded(trials, plan)

    def test_excluded_needs_reason(self):
        plan = {("B2", "icl", "default"): 1}
        trials = [self._trial(), {"prod_tokens": 18, "iters": 0, "mode": "icl",
                                  "emotion": "default", "excluded": True}]
        with self.assertRaises(ValueError):
            sap.check_bounded(trials, plan)

    def test_excluded_with_reason_not_counted(self):
        plan = {("B2", "icl", "default"): 1}
        trials = [self._trial(),
                  {"prod_tokens": 18, "iters": 0, "mode": "icl", "emotion": "default",
                   "excluded": True, "exclude_reason": "GPU 포화(nvidia-smi free~1200)"}]
        self.assertTrue(sap.check_bounded(trials, plan))   # 제외분은 분모에서 빠져 계획과 일치


class AggregateTest(unittest.TestCase):
    def test_g2_cell_counts_and_margin(self):
        # B2|icl|default, n=50: 47 completed + 3 tail(iters==213). tail 중 safety_ok 전부 True.
        trials = []
        for i in range(47):
            trials.append({"prod_tokens": 18, "iters": 40 + (i % 6), "mode": "icl",
                           "emotion": "default", "prosody_ok": True})
        for _ in range(3):
            trials.append({"prod_tokens": 18, "iters": 213, "mode": "icl",
                           "emotion": "default", "safety_ok": True})
        plan = {("B2", "icl", "default"): 50}
        agg = sap.aggregate(trials, plan)
        c = agg[("B2", "icl", "default")]
        self.assertEqual(c["n"], 50)
        self.assertEqual(c["completed"], 47)
        self.assertEqual(c["generation_limit"], 3)
        self.assertEqual(c["other_error"], 0)
        self.assertAlmostEqual(c["success_rate"], 0.94)
        self.assertAlmostEqual(c["tail_rate"], 0.06)
        # 안전장치: tail 3건 전부 계약 만족 → 1.000
        self.assertEqual(c["safety_total"], 3)
        self.assertEqual(c["safety_correct"], 3)
        self.assertAlmostEqual(c["safety_correct_rate"], 1.0)
        # prosody: completed 47건에 대해서만 평가
        self.assertEqual(c["prosody_total"], 47)
        self.assertEqual(c["prosody_ok"], 47)
        # margin: max iters 213 / envelope(18)=45.05 ≈ 4.73
        self.assertAlmostEqual(c["max_margin"], 4.728, places=2)
        self.assertEqual(c["iters"]["max"], 213.0)
        # Wilson CI가 점추정을 포함하고 폭이 0이 아님
        self.assertLess(c["success_ci"][0], 0.94)
        self.assertGreater(c["success_ci"][1], 0.94)

    def test_zero_tail_reports_rule_of_three(self):
        trials = [{"prod_tokens": 5, "iters": 20, "mode": "xvector", "emotion": "happy"}
                  for _ in range(50)]
        plan = {("B1", "xvector", "happy"): 50}
        agg = sap.aggregate(trials, plan)
        c = agg[("B1", "xvector", "happy")]
        self.assertEqual(c["generation_limit"], 0)
        self.assertAlmostEqual(c["tail_upper_if_zero"], 0.06)   # 3/50
        self.assertEqual(c["tail_rate"], 0.0)

    def test_safety_total_zero_is_na_not_pass(self):
        # tail이 없으면 안전장치는 '미발동' — PASS로 표기하지 않는다(rate=None).
        trials = [{"prod_tokens": 5, "iters": 20, "mode": "xvector", "emotion": "calm"}
                  for _ in range(30)]
        agg = sap.aggregate(trials, {("B1", "xvector", "calm"): 30})
        c = agg[("B1", "xvector", "calm")]
        self.assertEqual(c["safety_total"], 0)
        self.assertIsNone(c["safety_correct_rate"])

    def test_aggregate_enforces_bounded(self):
        # plan과 개수 불일치면 aggregate도 실패(집계 전 check_bounded)
        trials = [{"prod_tokens": 18, "iters": 40, "mode": "icl", "emotion": "default"}]
        with self.assertRaises(AssertionError):
            sap.aggregate(trials, {("B2", "icl", "default"): 5})

    def test_format_report_smoke(self):
        trials = [{"prod_tokens": 18, "iters": 40, "mode": "icl", "emotion": "default"} for _ in range(2)]
        trials.append({"prod_tokens": 18, "iters": 213, "mode": "icl", "emotion": "default",
                       "safety_ok": True})
        agg = sap.aggregate(trials, {("B2", "icl", "default"): 3})
        rep = sap.format_report(agg)
        self.assertIn("B2|icl|default", rep)
        self.assertIn("success[95% CI]", rep)
        self.assertIn("분모=사전 등록 n", rep)


if __name__ == "__main__":
    unittest.main(verbosity=2)
