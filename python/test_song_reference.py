# -*- coding: utf-8 -*-
"""짧은 참조 고르기 — **아무 데나 자르지 않는가.**

★왜 이 부품이 있나(2026-09-20 실측): 변환기의 처리 창이 `30초 - 참조 길이` 라
  참조를 통째로 넘기면 곡이 잘게 토막 나 이음매가 쌓인다. 그래서 짧게 잘라야 한다.
  그런데 **앞에서 8초를 그냥 떼면** 무음이나 숨소리가 걸려 음색을 못 잡는다.

판정(어디를 고를까)은 소리 없이 숫자만으로 검사한다 — 그래야 GPU 없이 돈다.
"""
import io
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import song_reference as sr  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


class TestScore(unittest.TestCase):
    """★셋을 곱한다 — 하나라도 나쁘면 쓸 수 없는 구간이기 때문이다."""

    def test_다_좋으면_점수가_높다(self):
        self.assertAlmostEqual(sr.window_score(1.0, 1.0, 0.0), 1.0)

    def test_소리가_끊기면_깎인다(self):
        self.assertLess(sr.window_score(0.5, 1.0, 0.0), sr.window_score(1.0, 1.0, 0.0))

    def test_음높이_확신이_낮으면_깎인다(self):
        self.assertLess(sr.window_score(1.0, 0.3, 0.0), sr.window_score(1.0, 0.9, 0.0))

    def test_급변이_잦으면_깎인다(self):
        self.assertLess(sr.window_score(1.0, 1.0, 0.8), sr.window_score(1.0, 1.0, 0.1))

    def test_하나가_바닥이면_전체가_바닥이다(self):
        """곱하기를 고른 이유. 다른 둘이 좋아도 구제되면 안 된다."""
        self.assertEqual(sr.window_score(0.0, 1.0, 0.0), 0.0)
        self.assertEqual(sr.window_score(1.0, 1.0, 1.0), 0.0)


class TestPickBest(unittest.TestCase):
    def test_가장_좋은_자리를_고른다(self):
        # 0.5초 간격 — 세 번째(1.0초 자리)가 가장 좋다.
        self.assertAlmostEqual(sr.best_window([0.1, 0.2, 0.9, 0.3]), 1.0)

    # ★앞에서 그냥 떼면 안 된다는 것이 이 부품의 존재 이유다.
    def test_앞부터_고르지_않는다(self):
        self.assertAlmostEqual(sr.best_window([0.2, 0.1, 0.1, 0.8]), 1.5,
                               '무조건 앞을 골랐다 — 무음이 걸릴 수 있다')

    def test_쓸_수_없는_구간은_건너뛴다(self):
        self.assertAlmostEqual(sr.best_window([None, None, 0.4]), 1.0)

    def test_쓸_만한_구간이_없으면_사유를_들고_실패한다(self):
        with self.assertRaises(sr.SongReferenceError) as e:
            sr.best_window([None, None, 0.0])
        self.assertIn('목소리', str(e.exception), '왜 못 골랐는지 말하지 않는다')

    def test_빈_목록도_조용히_0을_주지_않는다(self):
        with self.assertRaises(sr.SongReferenceError):
            sr.best_window([])


class TestMeasuredReason(unittest.TestCase):
    """★왜 8초인지가 코드에 남아 있어야, 다음 사람이 무심코 늘리지 않는다."""

    def test_기본_길이가_실측값이다(self):
        self.assertEqual(sr.WINDOW_SEC, 8.0)

    def test_사슬의_한계선_안에_들어간다(self):
        import song_chain
        self.assertLessEqual(sr.WINDOW_SEC, song_chain.REF_MAX_SEC,
                             '잘라 낸 참조가 사슬이 막는 길이보다 길다 — 서로 어긋난다')

    def test_왜_짧아야_하는지_적혀_있다(self):
        with io.open(os.path.join(HERE, 'song_reference.py'), encoding='utf-8') as f:
            src = f.read()
        self.assertIn('30초', src, '실측 근거가 없으면 다음 사람이 그냥 늘린다')


class TestDoesOneThing(unittest.TestCase):
    """★한 칸만 맡는다 — 경계가 새면 나중에 갈아 끼울 때 같이 뜯긴다."""

    def test_변환도_분리도_하지_않는다(self):
        with io.open(os.path.join(HERE, 'song_reference.py'), encoding='utf-8') as f:
            src = f.read().lower()
        for bad in ('separator', 'diffusion', 'f0-condition', 'subprocess'):
            self.assertNotIn(bad, src, '고르고 자르기만 하기로 한 부품이 %s 까지 한다' % bad)


if __name__ == '__main__':
    unittest.main(verbosity=2)
