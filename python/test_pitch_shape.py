# -*- coding: utf-8 -*-
"""음높이 곡선 빚기 — **손잡이가 말한 대로 하는가.**

★이 검사가 유난히 촘촘한 이유(2026-09-26)
  이날 소리 품질을 재는 지표를 **여섯 번 고르고 여섯 번 빗나갔다.**
  마지막에는 자연스러운 원본과 찢어지는 결과물에 완전히 같은 값이 나왔다.
  소리의 좋고 나쁨은 여기서 판정하지 않는다 — 그건 귀와 눈의 몫이다.
  대신 **빚는 규칙만큼은** 소리 없이 확실히 못 박는다.
"""
import io
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pitch_shape as ps  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


class TestSemitones(unittest.TestCase):
    """★Hz 로 다루면 높은 음에서만 폭이 커져 사람 감각과 어긋난다."""

    def test_한_옥타브는_열두_반음이다(self):
        a, b = ps.to_semitones([220.0, 440.0])
        self.assertAlmostEqual(b - a, 12.0, places=6)

    def test_같은_비율이면_같은_반음_차다(self):
        lo = ps.to_semitones([100.0, 200.0])
        hi = ps.to_semitones([400.0, 800.0])
        self.assertAlmostEqual(lo[1] - lo[0], hi[1] - hi[0], places=6)

    def test_소리_없는_자리를_지어내지_않는다(self):
        self.assertEqual(ps.to_semitones([0.0, None, -3.0]), [None, None, None])
        self.assertEqual(ps.to_hz([None]), [0.0])

    def test_갔다_오면_제자리다(self):
        back = ps.to_hz(ps.to_semitones([123.4, 456.7]))
        for got, want in zip(back, [123.4, 456.7]):
            self.assertAlmostEqual(got, want, places=4)


class TestSmooth(unittest.TestCase):
    """★찢어지는 음을 다루는 일이라 **튄 점에 끌려가면 안 된다.**"""

    def test_튄_점을_없앤다(self):
        v = [10.0, 10.0, 10.0, 40.0, 10.0, 10.0, 10.0]
        out = ps.smooth(v, 0.3)
        self.assertLess(max(out), 20.0, '튄 점이 남았다')

    def test_평균이_아니라_중앙값이다(self):
        """평균이면 튄 점이 **주변까지** 끌어올린다. 중앙값은 이웃을 안 건드린다."""
        v = [10.0] * 6 + [100.0] + [10.0] * 6
        out = ps.smooth(v, 0.2)
        self.assertTrue(all(abs(x - 10.0) < 1e-6 for x in out),
                        '튄 점 하나가 주변까지 망가뜨렸다: %s' % out[:5])

    def test_0이면_그대로다(self):
        v = [1.0, 5.0, 2.0]
        self.assertEqual(ps.smooth(v, 0.0), v)

    def test_많이_펼수록_평평해진다(self):
        v = [float(i % 2) for i in range(40)]
        rough = max(ps.smooth(v, 0.1)) - min(ps.smooth(v, 0.1))
        flat = max(ps.smooth(v, 1.0)) - min(ps.smooth(v, 1.0))
        self.assertLessEqual(flat, rough)

    # ★쉬는 자리를 가로지르면 원본에 없던 소리를 만들어 낸다.
    def test_쉬는_자리를_가로지르지_않는다(self):
        v = [10.0, 10.0, None, 50.0, 50.0]
        out = ps.smooth(v, 1.0)
        self.assertIsNone(out[2], '쉬는 자리를 메워 버렸다')
        self.assertAlmostEqual(out[0], 10.0)
        self.assertAlmostEqual(out[4], 50.0, msg='끊긴 두 구간이 서로 섞였다')


class TestSpread(unittest.TestCase):
    def test_1이면_그대로다(self):
        v = [1.0, 5.0, 9.0]
        self.assertEqual(ps.spread(v, 1.0), v)

    def test_넓히면_폭이_커진다(self):
        v = [1.0, 5.0, 9.0]
        out = ps.spread(v, 2.0)
        self.assertGreater(max(out) - min(out), 8.0)

    def test_좁히면_가운데로_모인다(self):
        v = [1.0, 5.0, 9.0]
        out = ps.spread(v, 0.5)
        self.assertLess(max(out) - min(out), 8.0)

    def test_가운데는_움직이지_않는다(self):
        """★축이 흔들리면 조가 바뀐다."""
        v = [1.0, 5.0, 9.0]
        self.assertAlmostEqual(ps.spread(v, 2.5)[1], 5.0)

    def test_쉬는_자리는_그대로_둔다(self):
        self.assertIsNone(ps.spread([1.0, None, 9.0], 2.0)[1])


class TestOrderMatters(unittest.TestCase):
    """★튄 점을 먼저 펴지 않고 폭을 벌리면 튄 점까지 같이 커진다."""

    def test_펴기가_폭보다_먼저다(self):
        v = [10.0] * 6 + [100.0] + [10.0] * 6
        out = ps.apply_knobs(v, {'smooth': 0.2, 'spread': 2.0})
        self.assertLess(max(out), 30.0,
                        '튄 점을 그대로 둔 채 폭을 벌렸다: %.1f' % max(out))

    def test_아무_손잡이도_안_돌리면_그대로다(self):
        v = [1.0, 7.0, 3.0]
        self.assertEqual(ps.apply_knobs(v), v)


class TestSimilarity(unittest.TestCase):
    def test_같으면_1이다(self):
        v = [1.0, 2.0, 3.0]
        self.assertAlmostEqual(ps.similarity(v, v), 1.0)

    def test_멀수록_낮다(self):
        t = [0.0, 0.0, 0.0]
        self.assertGreater(ps.similarity(t, [0.1, 0.1, 0.1]),
                           ps.similarity(t, [5.0, 5.0, 5.0]))

    def test_겹치는_자리가_없으면_0이다(self):
        self.assertEqual(ps.similarity([None, None], [1.0, 2.0]), 0.0)

    def test_한쪽만_소리가_있는_자리는_견주지_않는다(self):
        """빚어서 될 일이 아니다 — 점수를 깎아 봐야 손잡이가 헛돈다."""
        self.assertAlmostEqual(ps.similarity([1.0, None], [1.0, 9.0]), 1.0)


class TestAutoFit(unittest.TestCase):
    """★자동은 '사람이 돌리는 그 손잡이' 를 프로그램이 돌리는 것이다."""

    def test_들쑥날쑥한_것을_원본에_가깝게_맞춘다(self):
        target = [10.0] * 30
        current = [10.0 + (3.0 if i % 3 == 0 else -3.0) for i in range(30)]
        knobs, score = ps.auto_fit(target, current)
        self.assertGreater(score, ps.similarity(target, current),
                           '맞추기 전보다 나아지지 않았다')
        self.assertGreater(knobs['smooth'], 0.0, '펴지 않고 맞췄다고 한다')

    def test_이미_같으면_손잡이를_거의_안_돌린다(self):
        v = [float(i % 5) for i in range(30)]
        knobs, score = ps.auto_fit(v, v)
        self.assertGreater(score, 0.9)
        self.assertLess(abs(knobs['shift']), 0.5)

    def test_통째로_어긋난_것은_옮겨서_맞춘다(self):
        target = [float(i % 5) for i in range(30)]
        current = [x + 7.0 for x in target]
        knobs, score = ps.auto_fit(target, current)
        self.assertGreater(score, 0.9, '옮기기만 하면 되는데 못 맞췄다')
        self.assertAlmostEqual(knobs['shift'], -7.0, delta=1.0)

    def test_돌려준_손잡이가_실제로_그_점수를_낸다(self):
        """★자동이 고른 값을 사람이 이어받아 돌릴 수 있어야 한다 — 같은 엔진이므로."""
        target = [10.0] * 20
        current = [10.0 + (2.0 if i % 2 else -2.0) for i in range(20)]
        knobs, score = ps.auto_fit(target, current)
        self.assertAlmostEqual(
            ps.similarity(target, ps.apply_knobs(current, knobs)), score, places=6)

    def test_빈_곡선은_사유를_들고_실패한다(self):
        with self.assertRaises(ps.PitchShapeError):
            ps.auto_fit([], [1.0])


class TestDoesOneThing(unittest.TestCase):
    """★소리를 들이면 GPU 없이 검사할 수 없다. 숫자만 다룬다."""

    def test_소리도_파일도_건드리지_않는다(self):
        with io.open(os.path.join(HERE, 'pitch_shape.py'), encoding='utf-8') as f:
            src = f.read().lower()
        for bad in ('librosa', 'soundfile', 'subprocess', 'open(', 'pyworld'):
            self.assertNotIn(bad, src, '빚기만 하기로 한 부품이 %s 까지 한다' % bad)


if __name__ == '__main__':
    unittest.main(verbosity=2)
