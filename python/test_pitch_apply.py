# -*- coding: utf-8 -*-
"""손잡이를 소리에 잇는 자리 — **그린 것과 먹는 것이 같은가.**

★여기서 소리 품질은 판정하지 않는다. 2026-09-26에 품질 지표를 여섯 번 고르고
  여섯 번 빗나갔다. 좋고 나쁨은 귀와 눈의 몫이다. 이 검사가 지키는 것은 **약속**이다.

★확인은 **곡선으로** 한다. 처음에는 되합성한 소리를 다시 분석해 보려 했는데,
  그건 내 계산이 아니라 **분석기를 시험하는 것**이었다. 분석기는 되합성된 소리에서
  다른 값을 내놓아, 멀쩡한 코드가 실패로 나왔다.

★검사용 소리는 **배음이 풍부해야** 한다. 단순한 사인파를 썼더니 201칸 중 1칸만
  유성음으로 잡혔다 — 분석기가 목소리로 보지 않는다.
"""
import io
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pitch_apply as pa  # noqa: E402
import pitch_shape as ps  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def _voice(path, hz=220.0, seconds=1.0, sr=32000, gap=False):
    """목소리처럼 배음이 쌓인 소리. 사용자 미디어를 쓰지 않는다."""
    import numpy as np
    import soundfile as sf
    t = np.arange(int(sr * seconds)) / float(sr)
    y = np.zeros_like(t)
    for n in range(1, 21):                      # 배음 20개, 1/n 로 줄여 가며
        if hz * n < sr / 2:
            y += np.sin(2 * np.pi * hz * n * t) / n
    y *= 0.3 / max(1e-9, float(np.max(np.abs(y))))
    if gap:
        y[int(len(y) * 0.4):int(len(y) * 0.6)] = 0.0
    sf.write(path, y, sr)
    return path


def _median_live(values):
    live = sorted(v for v in values if v > 0)
    return live[len(live) // 2] if live else 0.0


class TestCurve(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.d = tempfile.mkdtemp(prefix='afpa-')

    def test_곡선을_뽑는다(self):
        p = _voice(os.path.join(self.d, 'a.wav'), hz=220.0)
        t, f = pa.curve(p)
        self.assertEqual(len(t), len(f), '시각과 값의 개수가 다르다 — 화면이 어긋난다')
        self.assertGreater(sum(1 for x in f if x > 0), len(f) * 0.5,
                           '유성음을 절반도 못 잡았다 — 검사용 소리가 목소리답지 않다')
        self.assertAlmostEqual(_median_live(f), 220.0, delta=10.0)

    def test_없는_파일은_사유를_들고_실패한다(self):
        with self.assertRaises(pa.PitchApplyError):
            pa.curve(os.path.join(self.d, '없음.wav'))


class TestReshape(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.d = tempfile.mkdtemp(prefix='afpa-')
        self.src = _voice(os.path.join(self.d, 'src.wav'), hz=220.0)

    # ★공짜가 아닌 일을 헛되이 치르지 않는다.
    def test_손잡이를_안_돌리면_되합성하지_않는다(self):
        r = pa.reshape(self.src, os.path.join(self.d, 'out.wav'))
        self.assertFalse(r['changed'])
        self.assertEqual(r['path'], self.src, '아무것도 안 바꾸는데 소리를 다시 만들었다')
        self.assertFalse(os.path.isfile(os.path.join(self.d, 'out.wav')))

    def test_옮기면_빚은_곡선이_올라간다(self):
        r = pa.reshape(self.src, os.path.join(self.d, 'up.wav'), {'shift': 5.0})
        self.assertTrue(r['changed'])
        self.assertTrue(os.path.isfile(r['path']), '소리를 만들지 않았다')
        before, after = _median_live(r['before']), _median_live(r['after'])
        want = before * (2 ** (5.0 / 12.0))
        self.assertAlmostEqual(after, want, delta=want * 0.03,
                               msg='옮겼다는데 곡선이 안 올라갔다: %.1f → %.1f' % (before, after))

    def test_폭을_넓히면_곡선이_벌어진다(self):
        r = pa.reshape(self.src, os.path.join(self.d, 'w.wav'), {'spread': 2.0})
        b = [x for x in r['before'] if x > 0]
        a = [x for x in r['after'] if x > 0]
        self.assertGreaterEqual(max(a) / min(a), max(b) / min(b),
                                '넓히라고 했는데 좁아졌다')

    # ★없던 소리를 만들어 내면 원본에 없던 말이 생긴다.
    def test_쉬는_자리를_살려_내지_않는다(self):
        src = _voice(os.path.join(self.d, 'gap.wav'), seconds=1.2, gap=True)
        r = pa.reshape(src, os.path.join(self.d, 'gap_out.wav'),
                       {'smooth': 1.0, 'spread': 2.0})
        revived = [i for i, (b, a) in enumerate(zip(r['before'], r['after']))
                   if b <= 0 and a > 0]
        self.assertEqual(revived, [], '쉬던 자리에 소리가 생겼다(%d칸)' % len(revived))

    def test_빚은_곡선의_길이가_원래와_같다(self):
        r = pa.reshape(self.src, os.path.join(self.d, 'x.wav'), {'shift': 1.0})
        self.assertEqual(len(r['before']), len(r['after']),
                         '칸 수가 달라지면 화면과 소리가 어긋난다')


class TestDrawnEqualsApplied(unittest.TestCase):
    """★그린 것과 먹는 것이 다르면, 사람이 보고 맞춘 것이 헛수고가 된다."""

    def test_빚기를_공용_엔진에_맡긴다(self):
        with io.open(os.path.join(HERE, 'pitch_apply.py'), encoding='utf-8') as f:
            src = f.read()
        self.assertIn('pitch_shape.apply_knobs', src, '빚기를 딴 데서 한다')

    def test_그리기와_빚기가_같은_간격을_쓴다(self):
        """간격이 다르면 화면의 눈금과 소리가 어긋난다."""
        with io.open(os.path.join(HERE, 'pitch_apply.py'), encoding='utf-8') as f:
            body = [l for l in f.read().split(chr(10)) if 'frame_period' in l
                    and not l.strip().startswith('#')]
        self.assertTrue(body, 'frame_period 를 쓰는 자리가 없다')
        for l in body:
            self.assertIn('FRAME_MS', l, '간격을 손으로 적은 자리가 있다: %s' % l.strip())

    def test_화면이_받는_모양이_고정돼_있다(self):
        import tempfile
        d = tempfile.mkdtemp(prefix='afpa-')
        r = pa.reshape(_voice(os.path.join(d, 'a.wav')), os.path.join(d, 'b.wav'),
                       {'shift': 1.0})
        self.assertEqual(set(r), {'path', 'before', 'after', 'changed'})


class TestFitKnobs(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.d = tempfile.mkdtemp(prefix='afpa-')

    def test_어긋난_것을_맞출_손잡이를_찾아_준다(self):
        a = _voice(os.path.join(self.d, 'a.wav'), hz=220.0)
        b = _voice(os.path.join(self.d, 'b.wav'), hz=294.0)   # 약 5반음 위
        knobs, score = pa.fit_knobs(a, b)
        self.assertGreater(score, 0.5, '맞추지 못했다')
        self.assertLess(knobs['shift'], -2.0, '내려야 맞는데 올리라고 한다')

    def test_돌려준_손잡이는_사람이_이어받을_수_있는_모양이다(self):
        a = _voice(os.path.join(self.d, 'a.wav'))
        knobs, _ = pa.fit_knobs(a, a)
        self.assertEqual(set(knobs), set(ps.NEUTRAL),
                         '자동이 사람과 다른 손잡이를 쓴다')


if __name__ == '__main__':
    unittest.main(verbosity=2)
