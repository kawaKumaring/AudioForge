# -*- coding: utf-8 -*-
"""timing_audit.py 단위 검사 - 지어낸 신호만 쓴다. 모델도 사용자 소리도 쓰지 않는다.

실행: python -X utf8 python/test_timing_audit.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import numpy as np
    HAVE_NP = True
except Exception:
    HAVE_NP = False

import timing_audit as ta


@unittest.skipUnless(HAVE_NP, 'numpy 없음')
class Test소리_시작_찾기(unittest.TestCase):
    def energy(self, loud_from_sec, total_sec=6.0, frame=0.02):
        n = int(total_sec / frame)
        e = np.full(n, 0.001, dtype=float)
        e[int(loud_from_sec / frame):] = 0.5
        return e, frame

    def test_조용하다_커지는_자리를_찾는다(self):
        e, f = self.energy(3.0)
        got = ta.find_onset(e, f, 3.0, search_sec=1.5)
        self.assertIsNotNone(got)
        self.assertAlmostEqual(got, 3.0, delta=0.05)

    def test_말한_시각이_늦으면_음수_쪽으로_어긋난다(self):
        e, f = self.energy(3.0)
        got = ta.find_onset(e, f, 3.5, search_sec=1.5)
        self.assertLess(got, 3.5, '실제 소리가 더 먼저 시작했다')

    def test_내내_조용하면_못_찾는다(self):
        e = np.full(300, 0.001, dtype=float)
        self.assertIsNone(ta.find_onset(e, 0.02, 3.0))

    def test_창이_너무_좁으면_못_찾는다(self):
        e, f = self.energy(3.0)
        self.assertIsNone(ta.find_onset(e, f, 3.0, search_sec=0.01))


class Test빈_자리가_있는_구간만(unittest.TestCase):
    """★노래는 보컬이 끊기지 않아 '조용하다 커지는 자리' 가 없다.

    2026-09-21: 그걸 모르고 전부 쟀더니 값이 탐색 창 끝에 몰렸다
    (중앙 1460 · 최대 1520밀리초, 창이 1500밀리초). 포화된 측정이었다.
    앞에 진짜 빈 자리가 있는 구간만 골라야 한다.
    """

    def test_바짝_붙은_구간은_건너뛴다(self):
        segs = [{'start': 0.0, 'end': 2.0}, {'start': 2.05, 'end': 4.0},
                {'start': 6.0, 'end': 7.0}]
        seen = []

        def fake_onset(energy, frame, at, search_sec=1.5, ratio=3.0):
            seen.append(at)
            return at

        old = ta.find_onset
        ta.find_onset = fake_onset
        try:
            import types
            # 오디오 읽기를 건너뛰려고 frame_energy 도 가짜로 바꾼다.
            old_fe = ta.frame_energy
            ta.frame_energy = lambda y, sr, frame_sec=0.02: ([0.0] * 10, 0.02)
            old_load = sys.modules.get('librosa')
            class FakeLibrosa:
                @staticmethod
                def load(path, sr=None, mono=True):
                    return [0.0] * 100, 16000
            sys.modules['librosa'] = FakeLibrosa
            rows = ta.audit('x.wav', segs, min_gap=0.5)
        finally:
            ta.find_onset = old
            ta.frame_energy = old_fe
            if old_load is not None:
                sys.modules['librosa'] = old_load
            else:
                sys.modules.pop('librosa', None)
        self.assertEqual(seen, [6.0], '붙어 있는 구간은 재지 않는다')
        self.assertEqual(len(rows), 1)


class Test요약(unittest.TestCase):
    def test_얼마나_크게_어긋났는지_센다(self):
        rows = [{'offset': 0.1, 'word_gap': 0.0},
                {'offset': 0.5, 'word_gap': 0.02},
                {'offset': 1.2, 'word_gap': None},
                {'offset': None, 'word_gap': 0.1}]
        s = ta.summarize(rows)
        self.assertEqual(s['measured'], 3)
        self.assertEqual(s['over_300ms'], 2)
        self.assertEqual(s['over_1s'], 1)

    def test_아무것도_못_쟀으면_수치를_지어내지_않는다(self):
        s = ta.summarize([{'offset': None, 'word_gap': None}])
        self.assertEqual(s['measured'], 0)
        self.assertNotIn('median_err', s)

    def test_낱말_시각과_구간_시각의_차이도_센다(self):
        s = ta.summarize([{'offset': 0.1, 'word_gap': 0.0},
                          {'offset': 0.2, 'word_gap': 0.14}])
        self.assertIn('median_word_gap', s)
        self.assertAlmostEqual(s['max_word_gap'], 0.14)


if __name__ == '__main__':
    unittest.main()
