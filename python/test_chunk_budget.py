# -*- coding: utf-8 -*-
"""budget_for 결합 계약 회귀.

고정하는 것:
  · 분할 상한은 생성 예산에서 **파생**된다 — 둘을 독립 상수로 유지할 수 없다
  · 상한만 올리고 생성 예산은 그대로인 상태가 코드상 존재하지 않는다
  · 예상 frame 은 상한 쪽(high)과 reserve 로 tier 를 고른다
  · architecture headroom 을 함께 본다
  · 실측 성공 표본(production 191 tok / 396 frame)이 예산 안에 들어온다
"""
import unittest

import chunk_budget as cb
import generation_limit as gl
import text_segmenter as ts


class BudgetDerivationTest(unittest.TestCase):
    def test_split_cap_is_derived_not_constant(self):
        """분할 상한이 예산 함수에서 나온다 — 고정 33 과 다른 값이어야 한다."""
        derived = cb.max_production_tokens()
        self.assertGreater(derived, 0)
        self.assertNotEqual(derived, gl.max_segment_tokens(),
                            "파생 상한이 옛 고정 상한과 같으면 결합이 성립하지 않는다")

    def test_derived_cap_actually_fits(self):
        """분할 상한은 예산 안에 있다. 경계 판정은 예산 축(_max_budget_tokens)에서 본다 —
        최종 상한은 종료 상한과의 min 이라 그 위가 곧바로 !fits 는 아니다."""
        self.assertTrue(cb.budget_for(cb.max_production_tokens())["fits"])
        edge = cb._max_budget_tokens()
        self.assertTrue(cb.budget_for(edge)["fits"])
        self.assertFalse(cb.budget_for(edge + 1)["fits"],
                         "예산 경계 바로 위는 fits 가 아니어야 한다")

    def test_every_fitting_token_count_has_a_generation_limit(self):
        """상한만 올리고 생성 예산이 없는 상태는 존재할 수 없다."""
        for t in (1, 27, 100, 191, 500, 1200, cb.max_production_tokens()):
            b = cb.budget_for(t)
            if b["fits"]:
                self.assertIsNotNone(b["generation_limit"],
                                     "fits 인데 generation_limit 이 없다 (tok=%d)" % t)
                self.assertGreaterEqual(b["generation_limit"], b["required_frames"])

    def test_tier_chosen_by_upper_bound_not_median(self):
        b = cb.budget_for(191)
        self.assertGreaterEqual(b["generation_limit"],
                                b["predicted_frames"]["high"] + b["reserve_frames"])

    def test_measured_success_sample_fits(self):
        """실측: production 191 token 이 396 frame 을 생성해 자연 종료했다."""
        b = cb.budget_for(191)
        self.assertTrue(b["fits"])
        self.assertGreaterEqual(b["generation_limit"], 396,
                                "실측 396 frame 을 수용하지 못하면 같은 입력이 다시 실패한다")

    def test_architecture_headroom_is_checked(self):
        b = cb.budget_for(100, reference_prefix_tokens=37)
        self.assertEqual(b["combined_prompt_tokens"], 137)
        self.assertEqual(b["architecture_headroom"],
                         cb.ARCHITECTURE_LIMIT - (137 + b["generation_limit"]))
        self.assertGreaterEqual(b["architecture_headroom"], 0)

    def test_reference_replay_raises_required_frames(self):
        """controlled-prefix 는 참조를 재발화하므로 예산이 더 필요하다."""
        a = cb.budget_for(191, reference_replay_frames=0)
        b = cb.budget_for(191, reference_replay_frames=83)
        self.assertGreater(b["required_frames"], a["required_frames"])

    def test_replay_lowers_the_budget_cap(self):
        """참조 재발화는 예산을 더 먹는다. (최종 분할 상한은 종료 상한에 눌려 같을 수 있다.)"""
        self.assertLess(cb._max_budget_tokens(reference_replay_frames=83),
                        cb._max_budget_tokens(reference_replay_frames=0))

    def test_invalid_inputs_raise(self):
        for bad in (0, -1, None, 3.5):
            with self.assertRaises(ValueError):
                cb.budget_for(bad)

    def test_provenance_is_recorded(self):
        prov = cb.budget_for(100)["frames_anchor_provenance"]
        self.assertIn("자연 종료", prov, "앵커가 어떤 관측에서 왔는지 남아야 한다")
        self.assertIn("censored", prov, "censored 관측 제외 사실이 명시돼야 한다")


class SplitterIntegrationTest(unittest.TestCase):
    """splitter 는 budget 을 만족하는 최대 의미 단위를 쓰고 원문을 보존한다."""

    def _count(self, t):
        return max(1, len(t))          # 1자 = 1 production token 근사(계약 검증용)

    def test_join_preserves_source(self):
        cap = 40
        text = "안녕하세요 첫 문장입니다. 두 번째 문장입니다. 세 번째 문장은 조금 더 깁니다."
        chunks = ts.split_for_generation(text, self._count, cap)
        self.assertEqual("".join(chunks), text)
        for c in chunks:
            self.assertLessEqual(self._count(c), cap)

    def test_short_text_is_not_split(self):
        text = "짧은 문장."
        self.assertEqual(ts.split_for_generation(text, self._count, 100), [text])

    def test_verified_paragraph_stays_whole(self):
        """실증된 250자(191 tok)는 한 chunk 로 남는다 — 옛 33 에서는 불가능했다."""
        cap = cb.max_production_tokens()
        self.assertGreaterEqual(cap, 191, "실증 앵커가 분할되면 안 된다")
        self.assertGreater(cap, 33)


class TerminationCeilingTest(unittest.TestCase):
    """예산에 들어와도 EOS 에 닿지 못하면 결과가 없다 — 종료 상한은 별개 축이다."""

    def test_split_cap_never_exceeds_termination_ceiling(self):
        """종료 상한은 상한 중 하나다 — planner 는 품질 상한까지 함께 보므로 더 낮을 수 있다."""
        self.assertLessEqual(cb.max_production_tokens(), cb.termination_ceiling())
        self.assertLessEqual(cb.max_production_tokens(), cb._max_budget_tokens())

    def test_ceiling_binds_below_budget(self):
        """실측상 종료 상한이 예산 상한보다 낮다 — 예산만 보면 안 된다."""
        self.assertLess(cb.termination_ceiling(), cb._max_budget_tokens())

    def test_verified_anchor_is_safe_and_failure_is_not(self):
        self.assertTrue(cb.terminates_safely(191), "실증된 성공 앵커")
        self.assertFalse(cb.terminates_safely(1054), "EOS 없이 limit 에 닿은 값")

    def test_ceiling_has_provenance(self):
        p = cb.TERMINATION_CEILING["provenance"]
        for k in ("token_definition", "validated_runs", "conditioning_mode",
                  "generation_tier", "largest_natural_termination",
                  "smallest_observed_failure", "failure_run", "verified_on", "note"):
            self.assertIn(k, p, "provenance 없이 상한을 쓰지 않는다: %s" % k)
        self.assertLess(p["largest_natural_termination"], p["smallest_observed_failure"])
        # 두 텍스트 이상에서 자연 종료한 것만 채택한다
        ok = [r for r in p["validated_runs"] if r["termination"] == "completed_before_limit"]
        self.assertGreaterEqual(len(ok), 2, "교차 검증 없이 ceiling 을 올리지 않는다")
        self.assertLessEqual(p["largest_natural_termination"],
                             max(r["production_tokens"] for r in ok))

    def test_censored_observation_is_not_an_anchor(self):
        """3072 iterations 는 censored 다 — frame/token 앵커에 들어가면 안 된다."""
        self.assertLess(cb.FRAMES_PER_PRODUCTION_TOKEN, 2.0,
                        "2.91 frame/token(censored) 이 앵커로 새어 들어갔다")

    def test_does_not_regress_to_33(self):
        self.assertGreater(cb.max_production_tokens(), 33)


class QualityOperatingCeilingTest(unittest.TestCase):
    """종료했다고 품질이 유지되는 것은 아니다 — 세 축을 따로 본다."""

    def test_planner_cap_is_min_of_three_axes(self):
        self.assertEqual(cb.max_production_tokens(),
                         min(cb._max_budget_tokens(), cb.termination_ceiling(),
                             cb.quality_operating_ceiling()))

    def test_quality_ceiling_binds(self):
        """품질 상한이 가장 보수적이라 planner 를 실제로 제한한다."""
        self.assertLess(cb.quality_operating_ceiling(), cb.termination_ceiling())
        self.assertEqual(cb.max_production_tokens(), cb.quality_operating_ceiling())

    def test_boundary_379_and_380(self):
        cap = cb.max_production_tokens()
        self.assertEqual(cap, 379)
        self.assertTrue(cb.budget_for(379)["fits"])
        self.assertGreater(380, cap, "380 은 분할 대상이어야 한다")

    def test_termination_ceiling_is_not_a_production_allowance(self):
        """563 을 단일 호출 허용 근거로 쓰지 않는다."""
        self.assertGreater(cb.termination_ceiling(), cb.max_production_tokens())
        self.assertIn("production 단일 호출 허용 근거로 쓰지 않는다",
                      cb.TERMINATION_CEILING["provenance"]["note"])

    def test_quality_provenance_records_listening(self):
        p = cb.QUALITY_OPERATING_CEILING["provenance"]
        for k in ("token_definition", "conditioning_mode", "model_revision",
                  "parser_version", "verified_on", "listening_passed",
                  "listening_failed", "state", "raise_policy"):
            self.assertIn(k, p)
        self.assertGreaterEqual(len(p["listening_passed"]), 2,
                                "두 대본 이상에서 청취 통과해야 운영 상한이 된다")
        self.assertTrue(p["listening_failed"], "실패 관측도 함께 남긴다")
        self.assertLessEqual(cb.quality_operating_ceiling(),
                             min(r["production_tokens"] for r in p["listening_passed"]))

    def test_does_not_regress_to_33(self):
        self.assertGreater(cb.max_production_tokens(), 33)


if __name__ == "__main__":
    unittest.main()
