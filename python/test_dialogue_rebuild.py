"""수정한 구간으로 다시 만들기 — **시간 범위 오류를 조용히 고치지 않는가**."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dialogue_rebuild as dr   # noqa: E402


class Normalize(unittest.TestCase):
    def test_good_segments_pass(self):
        good, dropped = dr.normalize_segments(
            [{"start": 0, "end": 5, "speaker": "화자 A"},
             {"start": 5, "end": 11, "speaker": "화자 B"}], 18.0)
        self.assertEqual(len(good), 2)
        self.assertEqual(dropped, [])

    def test_inverted_is_dropped_with_reason(self):
        good, dropped = dr.normalize_segments([{"start": 9, "end": 3, "speaker": "A"}], 18.0)
        self.assertEqual(good, [])
        self.assertEqual(dropped, [{"index": 0, "reason": "END_BEFORE_START"}])

    def test_out_of_range_is_dropped(self):
        _, dropped = dr.normalize_segments([{"start": 100, "end": 120, "speaker": "A"}], 18.0)
        self.assertEqual(dropped[0]["reason"], "OUT_OF_RANGE")

    def test_over_length_is_clipped_and_said(self):
        good, dropped = dr.normalize_segments([{"start": 17, "end": 99, "speaker": "A"}], 18.0)
        self.assertEqual(good[0]["end"], 18.0)
        self.assertEqual(dropped[0]["reason"], "CLIPPED_TO_RANGE",
                         "조용히 잘라 놓고 넘어가지 않는다")

    def test_missing_speaker_is_dropped(self):
        _, dropped = dr.normalize_segments([{"start": 0, "end": 1}], 18.0)
        self.assertEqual(dropped[0]["reason"], "NO_SPEAKER")

    def test_sorted_by_start(self):
        good, _ = dr.normalize_segments(
            [{"start": 5, "end": 6, "speaker": "A"}, {"start": 1, "end": 2, "speaker": "B"}], 18.0)
        self.assertEqual([s["start"] for s in good], [1, 5])

    def test_overlap_is_allowed(self):
        # 두 사람이 동시에 말할 수 있다 — 겹침은 오류가 아니다.
        good, dropped = dr.normalize_segments(
            [{"start": 0, "end": 5, "speaker": "A"}, {"start": 4, "end": 7, "speaker": "B"}], 18.0)
        self.assertEqual(len(good), 2)
        self.assertEqual(dropped, [])


class Naming(unittest.TestCase):
    def test_unsafe_chars_are_dropped(self):
        self.assertEqual(dr._safe_name('화자 A'), '화자 A')
        self.assertEqual(dr._safe_name('a/b:c'), 'abc')


if __name__ == "__main__":
    unittest.main(verbosity=2)
