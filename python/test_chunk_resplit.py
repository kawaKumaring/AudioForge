# -*- coding: utf-8 -*-
"""안전 분할·1회 재분할 — GPU 없이 순수 로직만. 토큰 수는 글자 수로 흉내낸다."""
import unittest

import chunk_budget
import chunk_resplit
import text_segmenter as ts


def n(t):
    return len(t)


class SafeTargetTest(unittest.TestCase):
    def test_safe_target_is_below_hard_cap(self):
        safe = chunk_budget.safe_production_tokens()
        hard = chunk_budget.max_production_tokens()
        self.assertGreaterEqual(safe, chunk_budget.SAFE_PRODUCTION_TOKENS_FLOOR)
        self.assertLess(safe, hard)
        self.assertEqual(safe, int(round(chunk_budget.quality_operating_ceiling() * 0.5)))


class SoftSplitTest(unittest.TestCase):
    def test_soft_max_cuts_at_sentence_boundary_before_hard_cap(self):
        text = "첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다."
        # hard 상한은 충분히 크고(분할 불필요), soft 목표는 문장 하나 반 정도.
        chunks = ts.split_for_generation(text, n, 200, soft_max=12)
        self.assertEqual("".join(chunks), text)
        self.assertEqual(len(chunks), 3)
        for c in chunks:
            self.assertLessEqual(n(c), 200)
        # soft 가 없으면 예전처럼 한 덩어리.
        self.assertEqual(ts.split_for_generation(text, n, 200), [text])

    def test_soft_max_never_cuts_inside_a_word(self):
        text = "경계없는긴단어" * 5   # 문장·절·공백 경계가 전혀 없다
        chunks = ts.split_for_generation(text, n, 200, soft_max=10)
        self.assertEqual(chunks, [text])   # soft 목표 때문에 단어 한가운데를 자르지 않는다
        # hard 상한은 여전히 문자 레벨에서 지킨다.
        hard = ts.split_for_generation(text, n, 20)
        self.assertEqual("".join(hard), text)
        self.assertTrue(all(n(c) <= 20 for c in hard))

    def test_soft_max_validation(self):
        with self.assertRaises(ValueError):
            ts.split_for_generation("a. b.", n, 10, soft_max=0)


class ResplitOnceTest(unittest.TestCase):
    def test_resplit_at_sentence_then_clause(self):
        text = "첫 문장입니다. 둘째 문장입니다."
        pieces = ts.resplit_once(text, n, 100)
        self.assertEqual(len(pieces), 2)
        self.assertEqual("".join(pieces), text)
        clause = "하나, 둘, 셋, 넷"
        pieces2 = ts.resplit_once(clause, n, 100)
        self.assertGreaterEqual(len(pieces2), 2)
        self.assertEqual("".join(pieces2), clause)

    def test_resplit_returns_single_when_no_boundary(self):
        self.assertEqual(ts.resplit_once("경계없는긴단어입니다", n, 100), ["경계없는긴단어입니다"])
        self.assertEqual(ts.resplit_once("a", n, 100), ["a"])


class RenumberTest(unittest.TestCase):
    def seg(self, idx):
        return {"index": idx, "speaker_id": "a", "emotion_id": "happy", "out_path": "x/segment_qwen_%03d.wav" % idx}

    def test_renumber_keeps_contiguous_indices_and_consistent_count(self):
        s1 = self.seg(1)
        done = [{"original_segment_index": 1, "chunk_index": 0, "chunk_count": 3},
                {"original_segment_index": 0, "chunk_index": 0, "chunk_count": 1}]
        queue = [{"seg": s1, "chunk_index": 2, "chunk_count": 3, "text": "c"},
                 {"seg": self.seg(2), "chunk_index": 0, "chunk_count": 1, "text": "d"}]
        pieces = ["b1.", " b2."]
        grow = chunk_resplit.renumber_after_resplit(done, queue, 1, 1, pieces)
        self.assertEqual(grow, 1)
        new_items = chunk_resplit.make_pieces(s1, 1, 3 + grow, pieces)
        self.assertEqual([it["chunk_index"] for it in new_items], [1, 2])
        self.assertEqual(queue[0]["chunk_index"], 3)            # 같은 segment 의 뒤 항목은 밀린다
        self.assertEqual(queue[0]["chunk_count"], 4)
        self.assertEqual(queue[1]["chunk_index"], 0)            # 다른 segment 는 그대로
        self.assertEqual(queue[1]["chunk_count"], 1)
        self.assertEqual(done[0]["chunk_count"], 4)             # 이미 끝난 같은 segment 항목도 count 갱신
        self.assertEqual(done[1]["chunk_count"], 1)
        # 조각은 원래 발화의 화자·감정·참조를 그대로 상속한다(seg 객체 동일).
        for it in new_items:
            self.assertIs(it["seg"], s1)
            self.assertEqual(it["resplit_of"], 1)
        # 전체 인덱스 집합이 0..3 으로 빈틈없다.
        idx = sorted([done[0]["chunk_index"]] + [it["chunk_index"] for it in new_items] + [queue[0]["chunk_index"]])
        self.assertEqual(idx, [0, 1, 2, 3])

    def test_pieces_must_be_two_or_more(self):
        with self.assertRaises(ValueError):
            chunk_resplit.renumber_after_resplit([], [], 0, 0, ["only"])


if __name__ == "__main__":
    unittest.main()
