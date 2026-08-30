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
        cap = cb.max_production_tokens()
        self.assertTrue(cb.budget_for(cap)["fits"])
        self.assertFalse(cb.budget_for(cap + 1)["fits"],
                         "상한 바로 위는 fits 가 아니어야 경계가 의미를 갖는다")

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

    def test_replay_lowers_the_split_cap(self):
        self.assertLess(cb.max_production_tokens(reference_replay_frames=83),
                        cb.max_production_tokens(reference_replay_frames=0))

    def test_invalid_inputs_raise(self):
        for bad in (0, -1, None, 3.5):
            with self.assertRaises(ValueError):
                cb.budget_for(bad)

    def test_provenance_is_recorded(self):
        self.assertIn("vendor-icl", cb.budget_for(100)["frames_anchor_provenance"])


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

    def test_derived_cap_keeps_typical_paragraph_whole(self):
        """파생 상한이면 일반 문단이 한 덩어리로 남는다 — 옛 33 에서는 불가능했다."""
        cap = cb.max_production_tokens()
        self.assertGreater(cap, 191, "실측 250자(191 tok)가 한 chunk 로 남아야 한다")


if __name__ == "__main__":
    unittest.main()
