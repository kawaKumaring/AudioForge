# -*- coding: utf-8 -*-
"""dub_timing.py 단위 검사 - 소리도 파일도 쓰지 않는다. 숫자만 본다.

실행: python -X utf8 python/test_dub_timing.py
  주의: unittest 모듈 경로 방식은 이 파이썬에서 'No module named python' 으로 죽는다.
  게이트(scripts/python-tests.mjs)도 파일을 직접 돌린다.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dub_timing as dt


class Test맞음(unittest.TestCase):
    def test_자리에_들어가면_손대지_않는다(self):
        r = dt.plan_line(1.0, 4.0, 2.5, ceil_sec=10.0)
        self.assertEqual(r['status'], 'fit')
        self.assertEqual(r['ratio'], 1.0)
        self.assertAlmostEqual(r['place_start'], 1.0)
        self.assertEqual(r['borrowed_before_sec'], 0.0)
        self.assertEqual(r['borrowed_after_sec'], 0.0)

    def test_딱_맞아도_늘이지_않는다(self):
        r = dt.plan_line(1.0, 4.0, 3.0, ceil_sec=10.0)
        self.assertEqual(r['status'], 'fit')
        self.assertEqual(r['ratio'], 1.0)


class Test쉼을_먼저_먹는다(unittest.TestCase):
    """규칙의 핵심. 늘이기 전에 반드시 무음을 먼저 쓴다 - 공짜로 얻는 시간이다."""

    def test_뒤가_비어_있으면_늘이지_않고_뒤로_넓힌다(self):
        # 3초 자리에 4초짜리. 다음 대사가 9초에 시작하니 뒤에 여유가 많다.
        r = dt.plan_line(1.0, 4.0, 4.0, ceil_sec=9.0)
        self.assertEqual(r['status'], 'fit', '쉼이 충분하면 속도를 건드리지 않는다')
        self.assertEqual(r['ratio'], 1.0)
        self.assertAlmostEqual(r['borrowed_after_sec'], 1.0)
        self.assertAlmostEqual(r['borrowed_before_sec'], 0.0)

    def test_뒤가_모자라면_앞에서도_빌린다(self):
        # 3초 자리에 4초. 뒤는 0.5초만 있고 앞이 열려 있다.
        # 뒤를 먼저 다 쓰고, 앞은 상한(MAX_EARLY_SEC)까지만 빌린다.
        r = dt.plan_line(2.0, 5.0, 4.0, floor_sec=0.0, ceil_sec=5.5)
        self.assertAlmostEqual(r['borrowed_after_sec'], 0.5)
        self.assertAlmostEqual(r['borrowed_before_sec'], dt.MAX_EARLY_SEC)
        self.assertAlmostEqual(r['place_start'], 2.0 - dt.MAX_EARLY_SEC)
        # 그러고도 0.25초 모자라므로 이제서야 늘인다 - 순서가 지켜졌다.
        self.assertEqual(r['status'], 'stretched')
        self.assertLess(r['ratio'], 1.1)

    def test_앞에서_빌리는_양에는_상한이_있다(self):
        """일찍 시작할수록 입모양과 어긋나 보인다 - 뒤보다 짜게 준다."""
        r = dt.plan_line(5.0, 6.0, 3.0, floor_sec=0.0, ceil_sec=6.0)
        self.assertAlmostEqual(r['borrowed_before_sec'], dt.MAX_EARLY_SEC)
        self.assertGreater(r['ratio'], 1.0, '앞에서 다 못 빌리면 그때 늘인다')

    def test_마지막_줄은_뒤가_열려_있다(self):
        r = dt.plan_line(10.0, 12.0, 5.0, ceil_sec=None)
        self.assertEqual(r['status'], 'fit')
        self.assertAlmostEqual(r['borrowed_after_sec'], 3.0)


class Test늘여서_맞춤(unittest.TestCase):
    def test_쉼으로_모자라면_그때_늘인다(self):
        r = dt.plan_line(1.0, 4.0, 3.6, floor_sec=1.0, ceil_sec=4.0)
        self.assertEqual(r['status'], 'stretched')
        self.assertAlmostEqual(r['ratio'], 1.2, places=3)
        self.assertAlmostEqual(r['place_sec'], 3.0, places=3)
        self.assertEqual(r['overflow_sec'], 0.0)

    def test_늘인_뒤_길이가_자리에_정확히_맞는다(self):
        r = dt.plan_line(0.0, 2.0, 2.4, floor_sec=0.0, ceil_sec=2.0)
        self.assertEqual(r['status'], 'stretched')
        self.assertAlmostEqual(r['place_sec'], r['slot_sec'], places=6)


class Test안_맞음(unittest.TestCase):
    def test_한계를_넘으면_억지로_넣지_않고_표시한다(self):
        # 2초 자리에 4초짜리. 1.3배로는 어림없다.
        r = dt.plan_line(1.0, 3.0, 4.0, floor_sec=1.0, ceil_sec=3.0)
        self.assertEqual(r['status'], 'over')
        self.assertEqual(r['ratio'], dt.MAX_RATIO)
        self.assertGreater(r['overflow_sec'], 0.0)
        self.assertIn('넘칩니다', r['reason'])

    def test_넘치는_양은_한계까지_줄인_뒤의_값이다(self):
        """이 숫자가 사용자가 번역문을 얼마나 줄여야 하는지다. 원래 길이 차이가 아니다."""
        r = dt.plan_line(0.0, 2.0, 4.0, floor_sec=0.0, ceil_sec=2.0)
        self.assertAlmostEqual(r['overflow_sec'], 4.0 / dt.MAX_RATIO - 2.0, places=6)

    def test_자리가_아예_없으면_나눗셈하지_않고_안_맞음이다(self):
        r = dt.plan_line(5.0, 5.02, 2.0, floor_sec=5.0, ceil_sec=5.02)
        self.assertEqual(r['status'], 'over')
        self.assertIn('자리가', r['reason'])

    def test_한계선을_올리면_맞을_수도_있다(self):
        r = dt.plan_line(0.0, 2.0, 3.0, floor_sec=0.0, ceil_sec=2.0, max_ratio=1.5)
        self.assertEqual(r['status'], 'stretched')
        self.assertAlmostEqual(r['ratio'], 1.5, places=3)


class Test잘못된_입력(unittest.TestCase):
    def test_거꾸로된_구간은_사유와_함께_실패한다(self):
        with self.assertRaises(dt.DubTimingError):
            dt.plan_line(4.0, 1.0, 2.0)

    def test_길이가_0인_소리는_사유와_함께_실패한다(self):
        with self.assertRaises(dt.DubTimingError):
            dt.plan_line(1.0, 4.0, 0.0)

    def test_순서가_뒤집힌_목록은_사유와_함께_실패한다(self):
        with self.assertRaises(dt.DubTimingError):
            dt.plan_lines([
                {'start': 5.0, 'end': 6.0, 'spoken_sec': 1.0},
                {'start': 1.0, 'end': 2.0, 'spoken_sec': 1.0},
            ])

    def test_값이_빠진_줄은_몇_번째인지_말한다(self):
        with self.assertRaises(dt.DubTimingError) as cm:
            dt.plan_lines([
                {'start': 0.0, 'end': 1.0, 'spoken_sec': 1.0},
                {'start': 2.0, 'end': 3.0},
            ])
        self.assertIn('2번째', str(cm.exception))


class Test여러_줄(unittest.TestCase):
    def test_줄이_서로_겹치지_않는다(self):
        """겹치면 두 말이 동시에 들린다. 어떤 배분을 하든 이것만은 깨지면 안 된다."""
        lines = [
            {'start': 0.0, 'end': 2.0, 'spoken_sec': 3.5},
            {'start': 2.2, 'end': 4.0, 'spoken_sec': 2.6},
            {'start': 4.5, 'end': 7.0, 'spoken_sec': 2.0},
        ]
        plans = dt.plan_lines(lines, media_sec=12.0)
        for a, b in zip(plans, plans[1:]):
            a_end = a['place_start'] + a['place_sec']
            self.assertLessEqual(a_end, b['place_start'] + 1e-6,
                                 '%.3f초에 끝나는데 다음이 %.3f초에 시작한다'
                                 % (a_end, b['place_start']))

    def test_앞줄이_길어지면_뒷줄이_밀린_것을_남긴다(self):
        lines = [
            {'start': 0.0, 'end': 1.0, 'spoken_sec': 3.0},
            {'start': 1.2, 'end': 2.0, 'spoken_sec': 0.5},
        ]
        plans = dt.plan_lines(lines, media_sec=10.0)
        self.assertGreater(plans[1]['pushed_sec'], 0.0, '밀린 사실을 조용히 넘기지 않는다')

    def test_마지막_줄도_영상_끝을_한계로_쓴다(self):
        # 8~9초 자리에 4초짜리. 영상이 10초에 끝나니 뒤로 빌릴 수 있는 것은 1초뿐이다.
        lines = [{'start': 8.0, 'end': 9.0, 'spoken_sec': 4.0}]
        plans = dt.plan_lines(lines, media_sec=10.0)
        self.assertLess(plans[0]['borrowed_after_sec'], 1.0,
                        '영상 끝 너머에서 빌려 오지 않는다')
        # 그래도 모자라면 '안 맞음' 이다. 잘라서 숨기지 않는다 -
        # 실제로 자를지 영상을 늘일지는 조립 단계(5단계)가 정한다.
        self.assertEqual(plans[0]['status'], 'over')
        self.assertGreater(plans[0]['overflow_sec'], 0.0)

    def test_영상_끝까지_여유가_있으면_그_안에_들어간다(self):
        lines = [{'start': 8.0, 'end': 9.0, 'spoken_sec': 2.0}]
        plans = dt.plan_lines(lines, media_sec=12.0)
        end = plans[0]['place_start'] + plans[0]['place_sec']
        self.assertEqual(plans[0]['status'], 'fit')
        self.assertLessEqual(end, 12.0 + 1e-6)

    def test_영상_길이를_모르면_뒤가_열려_있다(self):
        plans = dt.plan_lines([{'start': 8.0, 'end': 9.0, 'spoken_sec': 4.0}])
        self.assertEqual(plans[0]['status'], 'fit')

    def test_빈_목록은_빈_결과다(self):
        self.assertEqual(dt.plan_lines([]), [])


class Test요약(unittest.TestCase):
    def test_상태별로_센다(self):
        lines = [
            {'start': 0.0, 'end': 5.0, 'spoken_sec': 2.0},
            {'start': 6.0, 'end': 8.0, 'spoken_sec': 8.0},
        ]
        s = dt.summarize(dt.plan_lines(lines, media_sec=9.0))
        self.assertEqual(s['total'], 2)
        self.assertEqual(s['fit'], 1)
        self.assertEqual(s['over'], 1)
        self.assertEqual(s['over_indexes'], [1])
        self.assertGreater(s['worst_overflow_sec'], 0.0)

    def test_빈_목록도_숫자를_돌려준다(self):
        s = dt.summarize([])
        self.assertEqual(s['total'], 0)
        self.assertEqual(s['worst_overflow_sec'], 0.0)
        self.assertEqual(s['max_ratio_used'], 1.0)


if __name__ == '__main__':
    unittest.main()
