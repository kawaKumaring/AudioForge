# -*- coding: utf-8 -*-
"""자동 분할(계약 B) 단위 테스트 — 순수 로직, 모델 없이 주입 count_tokens로.

검증: 내용 보존("".join==원문), 각 chunk<=max, 우선순위(문장>절>공백>문자), 빈 chunk 없음,
재귀 종료, CJK 문자경계 fallback, SegmentTooLong(병리적), 분할 불필요 시 원문 그대로.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import text_segmenter as ts


def by_len(t):
    """테스트용 count_tokens: 문자 수(공백 포함)."""
    return len(t)


class SplitBasicTest(unittest.TestCase):
    def _check(self, text, max_tokens, count=by_len):
        chunks = ts.split_for_generation(text, count, max_tokens)
        self.assertEqual("".join(chunks), text, "내용 보존 실패")
        for c in chunks:
            self.assertNotEqual(c, "", "빈 chunk")
            self.assertLessEqual(count(c), max_tokens, f"chunk 초과: {count(c)}>{max_tokens}")
        return chunks

    def test_no_split_when_within_limit(self):
        text = "안녕하세요."
        self.assertEqual(ts.split_for_generation(text, by_len, 100), [text])   # 원문 그대로

    def test_sentence_priority(self):
        text = "첫째 문장이다. 둘째 문장이다. 셋째다."
        chunks = self._check(text, 16)
        # 문장 경계 우선 → 각 chunk가 문장 종결부호로 끝나는 경향(공백 포함 가능)
        self.assertTrue(any("." in c for c in chunks))

    def test_clause_when_sentence_too_long(self):
        text = "아주 긴 문장인데, 쉼표로, 여러 절로, 나뉜다."
        self._check(text, 10)

    def test_whitespace_level(self):
        text = "word1 word2 word3 word4 word5 word6"
        self._check(text, 12)

    def test_cjk_char_fallback(self):
        # 공백·구두점 없는 CJK 긴 문자열 → 문자 경계로 분할
        text = "가나다라마바사아자차카타파하" * 3
        chunks = self._check(text, 5)
        self.assertGreater(len(chunks), 1)

    def test_english_long_word_char_fallback(self):
        text = "supercalifragilisticexpialidocious"
        self._check(text, 6)

    def test_mixed_punct_numbers(self):
        text = "번호는 010-1234-5678 이고, 금액은 1,234,567원!! 확인?"
        self._check(text, 9)


class SplitEdgeTest(unittest.TestCase):
    def test_content_exactly_preserved_with_spaces(self):
        text = "  앞뒤 공백  포함   문장.  다음.  "
        chunks = ts.split_for_generation(text, by_len, 7)
        self.assertEqual("".join(chunks), text)   # 공백까지 정확 보존

    def test_no_empty_chunks(self):
        text = "。。。！！！??? 짧다."   # 구두점 연발
        chunks = ts.split_for_generation(text, by_len, 4)
        self.assertTrue(all(c != "" for c in chunks))
        self.assertEqual("".join(chunks), text)

    def test_segment_too_long_when_even_char_exceeds(self):
        # 어떤 것도 max 이하로 못 만드는 병리적 count(항상 100) → SegmentTooLong
        with self.assertRaises(ts.SegmentTooLong):
            ts.split_for_generation("가나다", lambda t: 100, 10)

    def test_recursion_terminates_on_no_delimiters(self):
        # 구분자 전무 + 각 문자 1 → 문자 단계에서 종료
        text = "aaaaaaaaaaaaaaaaaaaa"
        chunks = ts.split_for_generation(text, by_len, 5)
        self.assertEqual("".join(chunks), text)
        for c in chunks:
            self.assertLessEqual(len(c), 5)

    def test_greedy_packs_maximally(self):
        # 3자 단어 여러 개, max 8 → 두 단어(공백 포함 7)씩 묶여야(과분할 아님)
        text = "abc def ghi jkl"
        chunks = ts.split_for_generation(text, by_len, 8)
        self.assertEqual("".join(chunks), text)
        self.assertLessEqual(len(chunks), 3)   # 과분할 아님

    def test_max_tokens_validation(self):
        with self.assertRaises(ValueError):
            ts.split_for_generation("x", by_len, 0)
        with self.assertRaises(ValueError):
            ts.split_for_generation("x", by_len, -1)


class SplitWithRealisticCounterTest(unittest.TestCase):
    """production 유사 count_tokens(래퍼 고정오버헤드 + 내용 토큰)로 max_segment_tokens 경계 감각."""
    def _count(self, t):
        # 래퍼 ~10 토큰 + 내용은 대략 문자수/1.5(한글) 근사
        return 10 + max(1, int(len(t.strip()) / 1.5)) if t.strip() else 10

    def test_split_under_33(self):
        text = ("이 문장은 토커의 자기회귀 반복이 늘어날 때 초당 생성 속도가 어떻게 유지되는지 측정하려고 "
                "여러 절을 이어 붙여 조금 더 길게 작성한 한국어 문장입니다.")
        chunks = ts.split_for_generation(text, self._count, 33)
        self.assertEqual("".join(chunks), text)
        for c in chunks:
            self.assertLessEqual(self._count(c), 33)


if __name__ == "__main__":
    unittest.main(verbosity=2)
