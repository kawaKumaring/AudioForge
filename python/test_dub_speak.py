# -*- coding: utf-8 -*-
"""dub_speak.py 검사 - 모델도 GPU도 부르지 않는다. 구간 고르기만 본다.

실행: python -X utf8 python/test_dub_speak.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dub_speak as ds


class Test참조_구간_고르기(unittest.TestCase):
    def test_가장_긴_대사_구간을_고른다(self):
        start, dur = ds.pick_reference_span([
            {'start': 0.0, 'end': 1.0},
            {'start': 10.0, 'end': 15.0},
            {'start': 20.0, 'end': 22.0},
        ])
        self.assertEqual(start, 10.0)
        self.assertAlmostEqual(dur, 5.0)

    def test_너무_긴_구간은_잘라_쓴다(self):
        """참조가 길면 여러 소리가 섞인다."""
        _, dur = ds.pick_reference_span([{'start': 0.0, 'end': 60.0}])
        self.assertEqual(dur, ds.REF_SEC)

    def test_너무_짧아도_최소_길이는_준다(self):
        _, dur = ds.pick_reference_span([{'start': 5.0, 'end': 5.4}])
        self.assertGreaterEqual(dur, 2.0)

    def test_길이가_0이하인_구간은_쓰지_않는다(self):
        start, _ = ds.pick_reference_span([
            {'start': 3.0, 'end': 3.0},
            {'start': 8.0, 'end': 9.0},
        ])
        self.assertEqual(start, 8.0)

    def test_쓸_구간이_없으면_사유와_함께_멈춘다(self):
        for bad in ([], None, [{'start': 1.0, 'end': 1.0}]):
            with self.assertRaises(ds.DubSpeakError):
                ds.pick_reference_span(bad)


if __name__ == '__main__':
    unittest.main()
