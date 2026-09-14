"""분할 조각 규칙 — **화면이 보여 준 것과 저장되는 것이 같은가**.

같은 규칙이 shared/splitPieces.ts 에도 있다. 두 쪽이 갈라지면 미리듣기가 거짓말이 되므로,
여기 적힌 기대값은 그쪽 단위 시험(splitPieces.test.ts)과 **같은 예제**다.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import split_markers as sm   # noqa: E402


class BuildPieces(unittest.TestCase):
    def test_no_marker_is_one_piece(self):
        p = sm.build_pieces([], 30)
        self.assertEqual(len(p), 1)
        self.assertEqual((p[0]["start"], p[0]["end"], p[0]["duration"]), (0.0, 30.0, 30.0))
        self.assertEqual(p[0]["name"], "01_Track 01")

    def test_markers_make_adjacent_pieces(self):
        p = sm.build_pieces([10, 20], 30, ["첫곡", "둘째곡", "셋째곡"])
        self.assertEqual([(x["start"], x["end"]) for x in p], [(0.0, 10), (10, 20), (20, 30.0)])
        self.assertEqual([x["name"] for x in p], ["01_첫곡", "02_둘째곡", "03_셋째곡"])

    def test_unsafe_name_chars_are_dropped(self):
        p = sm.build_pieces([5], 10, ["a/b:c*d", ""])
        self.assertEqual(p[0]["name"], "01_abcd")
        self.assertEqual(p[1]["name"], "02_Track 02")
        self.assertEqual(sm.build_pieces([], 10, ["///"])[0]["name"], "track_01")

    def test_removing_a_boundary_merges_neighbours(self):
        two = sm.build_pieces([20], 30)
        self.assertEqual(len(two), 2)
        self.assertEqual((two[0]["start"], two[0]["end"]), (0.0, 20))


class Selection(unittest.TestCase):
    def test_numbers_do_not_shift(self):
        p = sm.build_pieces([10, 20], 30, ["가", "나", "다"])
        keep = sm.selected_pieces(p, [0, 2])
        self.assertEqual([x["name"] for x in keep], ["01_가", "03_다"],
                         "가운데를 빼도 번호가 바뀌면 미리듣기와 저장본이 어긋난다")
        self.assertEqual([(x["start"], x["end"]) for x in keep], [(0.0, 10), (20, 30.0)])

    def test_none_means_all(self):
        p = sm.build_pieces([10], 20)
        self.assertEqual(len(sm.selected_pieces(p, None)), 2)

    def test_empty_selection_keeps_nothing(self):
        p = sm.build_pieces([10], 20)
        self.assertEqual(sm.selected_pieces(p, []), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
