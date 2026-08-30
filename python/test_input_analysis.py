# -*- coding: utf-8 -*-
"""입력 분석·시간 estimator parity 회귀 (GPU 없음).

핵심은 하나다 — estimator 의 planned_calls 가 실제 planner 의 chunk 수와 **같아야** 한다.
두 경로가 갈라지는 순간 UI 는 안내가 아니라 오정보가 된다.
"""
import unittest

import chunk_budget as cb
import input_analysis as ia
import text_segmenter as ts


def _count(t):
    """1자 = 1 production token 근사. 실제 tokenizer 는 주입되므로 계약만 본다."""
    return max(1, len(t))


class ParagraphRuleTest(unittest.TestCase):
    def test_no_newline_is_one_paragraph(self):
        r = ia.analyze("문장 하나입니다. 두 번째입니다.", _count)
        self.assertEqual(r["paragraph_count"], 1)

    def test_enter_is_a_user_boundary(self):
        r = ia.analyze("첫 줄입니다." + chr(10) + "둘째 줄입니다.", _count)
        self.assertEqual(r["paragraph_count"], 2)

    def test_blank_lines_do_not_create_paragraphs(self):
        t = "첫 줄." + chr(10) * 3 + "둘째 줄."
        r = ia.analyze(t, _count)
        self.assertEqual(r["paragraph_count"], 2, "연속 빈 줄이 문단을 만들면 안 된다")

    def test_paragraph_offsets_are_recorded(self):
        t = "가나다." + chr(10) + "라마바."
        r = ia.analyze(t, _count)
        self.assertEqual(r["paragraphs"][0]["char_start"], 0)
        self.assertEqual(r["paragraphs"][1]["char_start"], len("가나다.") + 1)


class PlannerParityTest(unittest.TestCase):
    """estimator 의 planned_calls == splitter 의 실제 chunk 수."""

    def _actual_chunks(self, text, cap):
        total = 0
        for p in ia.paragraphs_of(text):
            tok = _count(p["text"])
            chunks = ([p["text"]] if tok <= cap
                      else ts.split_for_generation(p["text"], _count, cap))
            total += len(chunks)
        return total

    def test_parity_on_various_inputs(self):
        cap = cb.max_production_tokens()
        cases = [
            "짧은 문장.",
            "문장 하나입니다. 두 번째입니다. 세 번째입니다.",
            "첫 문단입니다." + chr(10) + "둘째 문단입니다." + chr(10) + "셋째 문단입니다.",
            "긴 문단입니다. " * 40,
            ("가나다라마바사아자차. " * 30) + chr(10) + ("타파하 " * 50),
        ]
        for t in cases:
            r = ia.analyze(t, _count)
            self.assertEqual(r["planned_calls"], self._actual_chunks(t, cap),
                             "planned_calls 가 실제 chunk 수와 다르다: %r" % t[:20])

    def test_split_cap_comes_from_budget(self):
        self.assertEqual(ia.analyze("가나다.", _count)["split_cap_production_tokens"],
                         cb.max_production_tokens())

    def test_paragraph_within_budget_stays_one_call(self):
        r = ia.analyze("문장입니다. 또 문장입니다.", _count)
        self.assertEqual(r["planned_calls"], 1)
        self.assertFalse(r["paragraphs"][0]["auto_split"])

    def test_oversized_paragraph_is_split_and_marked(self):
        cap = cb.max_production_tokens()
        t = "가나다라마바사아자차. " * (cap // 5)
        r = ia.analyze(t, _count)
        self.assertGreater(r["planned_calls"], 1)
        self.assertTrue(r["paragraphs"][0]["auto_split"])


class EstimateTest(unittest.TestCase):
    def test_measured_range_is_labelled(self):
        r = ia.analyze("문장입니다. " * 20, _count)
        self.assertIn(r["confidence"],
                      (ia.CONFIDENCE_MEASURED, ia.CONFIDENCE_EXTRAPOLATED))
        self.assertIsNotNone(r["estimated_generation_seconds"])
        self.assertLess(r["estimated_generation_seconds"]["min"],
                        r["estimated_generation_seconds"]["max"])

    def test_untested_modes_do_not_invent_numbers(self):
        for mode in ("safe_xvector", "auto"):
            r = ia.analyze("문장입니다.", _count, mode=mode)
            self.assertEqual(r["confidence"], ia.CONFIDENCE_INSUFFICIENT)
            self.assertIsNone(r["estimated_generation_seconds"],
                              "%s 는 통제 표본이 없어 숫자를 내면 안 된다" % mode)

    def test_extrapolated_outside_measured_frames(self):
        r = ia.analyze("문장입니다. " * 400, _count)
        self.assertEqual(r["confidence"], ia.CONFIDENCE_EXTRAPOLATED)

    def test_audio_estimate_is_positive_and_monotonic(self):
        short = ia.analyze("문장입니다.", _count)["estimated_audio_seconds"]
        long = ia.analyze("문장입니다. " * 10, _count)["estimated_audio_seconds"]
        self.assertGreater(short, 0)
        self.assertGreater(long, short)

    def test_empty_input_is_safe(self):
        r = ia.analyze("", _count)
        self.assertEqual(r["paragraph_count"], 0)
        self.assertEqual(r["planned_calls"], 0)
        self.assertEqual(r["confidence"], ia.CONFIDENCE_INSUFFICIENT)


class NoDuplicateImplementationTest(unittest.TestCase):
    def test_uses_production_splitter_and_budget(self):
        src = open("input_analysis.py", encoding="utf-8").read()
        self.assertIn("text_segmenter", src)
        self.assertIn("chunk_budget", src)
        self.assertNotIn("SENTENCE_ENDERS = ", src, "문장 분리기를 재구현하면 안 된다")


if __name__ == "__main__":
    unittest.main()
