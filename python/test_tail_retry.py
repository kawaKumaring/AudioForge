# -*- coding: utf-8 -*-
"""tail_retry.py 단위 검사 — 소리를 만들지도 재지도 않는다. 숫자만 본다.

★왜 있는가(2026-09-24)
  말끝이 살아 있는 채 끊기는 일에 대해 우리는 **재기·판정·표시까지만** 갖고 있었다.
  그때 적어 둔 "되살릴 수는 없다" 는 **파형을 고칠 수 없다**는 뜻이었지,
  좋은 결과를 못 얻는다는 뜻이 아니었다 — 다시 만들면 된다.
  그리고 **더빙 경로는 재지도 않았다.** 사용자가 겪은 자리가 바로 거기다.

실행: python -X utf8 python/test_tail_retry.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import tail_retry as tr


class Test잘렸는가(unittest.TestCase):
    def test_실측된_끊긴_회차를_잡는다(self):
        """2026-09-16 실측: 끊긴 1회 0.087."""
        self.assertTrue(tr.is_cut(0.087))

    def test_실측된_정상_회차는_넘긴다(self):
        """같은 실측: 정상 3회 0.000 / 0.002 / 0.007."""
        for v in (0.0, 0.002, 0.007):
            self.assertFalse(tr.is_cut(v), v)

    def test_기준값_자체는_잘린_것으로_본다(self):
        self.assertTrue(tr.is_cut(tr.CUT_RATIO))

    def test_재지_못했으면_잘렸다고_말하지_않는다(self):
        """★모르는 것을 잘렸다고 하면 멀쩡한 줄을 자꾸 다시 만든다."""
        for v in (None, '', 'abc', float('nan')):
            self.assertFalse(tr.is_cut(v), repr(v))

    def test_기준값이_화면_쪽과_같다(self):
        """★src/shared/labWorkspace.ts 의 TAIL_RESIDUAL_CUT 과 같아야 한다.

        말이 다르면 화면은 "잘렸다" 는데 여기서는 다시 만들지 않는 일이 생긴다.
        언어가 달라 한 곳에 둘 수 없으므로 값을 검사로 붙잡는다.
        """
        self.assertEqual(tr.CUT_RATIO, 0.03)


class Test다시_만들까(unittest.TestCase):
    def test_잘렸고_기회가_남았으면_다시_만든다(self):
        self.assertTrue(tr.should_retry(0.087, 1))

    def test_멀쩡하면_다시_만들지_않는다(self):
        self.assertFalse(tr.should_retry(0.001, 1))

    def test_횟수를_넘기면_그만둔다(self):
        """★값이 비싸다(합성 한 번). 끝없이 하지 않는다."""
        self.assertTrue(tr.should_retry(0.5, tr.MAX_RETRIES))
        self.assertFalse(tr.should_retry(0.5, tr.MAX_RETRIES + 1))

    def test_못_쟀으면_다시_만들지_않는다(self):
        self.assertFalse(tr.should_retry(None, 1))


class Test가장_덜_잘린_것_고르기(unittest.TestCase):
    def test_제일_작은_것을_고른다(self):
        self.assertEqual(tr.pick_best([{'ratio': 0.09}, {'ratio': 0.002}, {'ratio': 0.05}]), 1)

    def test_못_잰_것은_뒤로_민다(self):
        """★모르는 것을 좋은 것으로 치지 않는다."""
        self.assertEqual(tr.pick_best([{'ratio': None}, {'ratio': 0.5}]), 1)

    def test_전부_못_쟀으면_첫_번째다(self):
        self.assertEqual(tr.pick_best([{'ratio': None}, {'ratio': None}]), 0)

    def test_하나뿐이면_그것이다(self):
        self.assertEqual(tr.pick_best([{'ratio': 0.9}]), 0)

    def test_빈_목록은_None(self):
        self.assertIsNone(tr.pick_best([]))
        self.assertIsNone(tr.pick_best(None))

    def test_같은_값이면_먼저_만든_것(self):
        self.assertEqual(tr.pick_best([{'ratio': 0.01}, {'ratio': 0.01}]), 0)


class Test요약(unittest.TestCase):
    def test_살린_줄과_못_살린_줄을_센다(self):
        rows = [{'index': 0, 'attempts': 1, 'ratio': 0.001, 'cut': False},
                {'index': 1, 'attempts': 3, 'ratio': 0.002, 'cut': False},
                {'index': 2, 'attempts': 3, 'ratio': 0.2, 'cut': True}]
        s = tr.summarize(rows)
        self.assertEqual(s['lines'], 3)
        self.assertEqual(s['retried'], 2)
        self.assertEqual(s['still_cut'], 1)
        self.assertEqual(s['rescued'], 1)

    def test_다시_만든_적이_없으면_0이다(self):
        s = tr.summarize([{'index': 0, 'attempts': 1, 'ratio': 0.0, 'cut': False}])
        self.assertEqual((s['retried'], s['still_cut'], s['rescued']), (0, 0, 0))

    def test_빈_것도_터지지_않는다(self):
        self.assertEqual(tr.summarize([])['lines'], 0)
        self.assertEqual(tr.summarize(None)['lines'], 0)


if __name__ == '__main__':
    unittest.main()
