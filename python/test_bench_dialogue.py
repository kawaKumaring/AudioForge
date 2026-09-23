# -*- coding: utf-8 -*-
"""bench_dialogue.py 단위 검사 — 합성기를 가짜로 넣어 모델 없이 본다.

★여기서 지키는 것은 하나다: **참값이 참값인가.**
  계측대의 값이 틀리면 그 위에서 내린 모든 판단이 틀린다.

실행: python -X utf8 python/test_bench_dialogue.py
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import numpy as np
    HAVE_NP = True
except Exception:
    HAVE_NP = False

try:
    import soundfile as _sf   # noqa: F401
    HAVE_SF = True
except Exception:
    HAVE_SF = False

import bench_dialogue as bd


def fake_synth(text, sr, lead=0.0, tail=0.0):
    """글자 수에 비례하는 소리. 앞뒤에 정적을 붙일 수 있다(참값 시험용)."""
    n = int(sr * (0.05 * max(1, len(text))))
    t = np.arange(n) / float(sr)
    body = 0.4 * np.sin(2 * np.pi * 180.0 * t)
    return np.concatenate([np.zeros(int(sr * lead)), body, np.zeros(int(sr * tail))])


@unittest.skipUnless(HAVE_NP, 'numpy 없음')
class Test앞뒤_정적_걷어내기(unittest.TestCase):
    """★이 단계가 없으면 참값이 어긋난다 — 계측대의 생명이다."""

    def test_앞뒤_정적을_걷어낸다(self):
        sr = 16000
        y = fake_synth('가나다', sr, lead=0.5, tail=0.5)
        got = bd.trim_silence(y, sr)
        self.assertLess(len(got), len(y))
        self.assertGreater(len(got), sr * 0.1)

    def test_자음_앞을_너무_바짝_자르지_않는다(self):
        sr = 16000
        y = fake_synth('가나다', sr, lead=0.5)
        got = bd.trim_silence(y, sr, pad_sec=0.02)
        self.assertGreaterEqual(len(got), int(sr * 0.05 * 3))

    def test_통째로_조용하면_그대로_둔다(self):
        y = np.zeros(1000)
        self.assertEqual(len(bd.trim_silence(y, 16000)), 1000)

    def test_빈_것도_터지지_않는다(self):
        self.assertEqual(len(bd.trim_silence(np.zeros(0), 16000)), 0)


@unittest.skipUnless(HAVE_NP, 'numpy 없음')
class Test참값이_참값인가(unittest.TestCase):
    def build(self, lead=0.0, tail=0.0):
        return bd.build('.', lambda t, sr: fake_synth(t, sr, lead, tail), sr=16000)

    def test_적어_둔_시작에서_실제로_소리가_난다(self):
        """★합성 결과에 정적이 붙어 있어도 참값이 어긋나면 안 된다."""
        made = self.build(lead=0.4, tail=0.3)
        y, sr = made['audio'], made['sr']
        for ln in made['lines']:
            a = int(ln['start'] * sr)
            near = y[a:a + int(0.05 * sr)]
            self.assertGreater(float(np.max(np.abs(near))), 0.01,
                               '%d번 줄 시작에 소리가 없다' % ln['index'])

    def test_적어_둔_시작_직전은_조용하다(self):
        made = self.build(lead=0.4)
        y, sr = made['audio'], made['sr']
        for ln in made['lines']:
            a = int(ln['start'] * sr)
            before = y[max(0, a - int(0.15 * sr)):max(0, a - int(0.03 * sr))]
            if before.size:
                self.assertLess(float(np.max(np.abs(before))), 0.01,
                                '%d번 줄 앞이 조용하지 않다' % ln['index'])

    def test_적어_둔_끝_뒤로는_그_줄_소리가_없다(self):
        made = self.build()
        y, sr = made['audio'], made['sr']
        ln = made['lines'][-1]
        after = y[int(ln['end'] * sr) + int(0.05 * sr):]
        if after.size:
            self.assertLess(float(np.max(np.abs(after))), 0.01)

    def test_줄이_서로_겹치지_않는다(self):
        made = self.build()
        for a, b in zip(made['lines'], made['lines'][1:]):
            self.assertLessEqual(a['end'], b['start'], '줄이 겹쳤다')

    def test_대본에_적은_빈_자리가_지켜진다(self):
        made = self.build()
        for (text, gap), prev, cur in zip(bd.SCRIPT[1:], made['lines'], made['lines'][1:]):
            self.assertAlmostEqual(cur['start'] - prev['end'], gap, places=3)

    def test_글이_그대로_실린다(self):
        made = self.build()
        self.assertEqual([l['text'] for l in made['lines']],
                         [t for t, _ in bd.SCRIPT])

    def test_합성이_비면_조용히_넘기지_않는다(self):
        with self.assertRaises(bd.BenchError):
            bd.build('.', lambda t, sr: np.zeros(0), sr=16000)


@unittest.skipUnless(HAVE_NP, 'numpy 없음')
class Test배경음_섞기(unittest.TestCase):
    def test_같은_씨앗이면_같은_배경음(self):
        a = bd.noise_bed(8000, 16000, seed=3)
        b = bd.noise_bed(8000, 16000, seed=3)
        self.assertTrue(np.allclose(a, b), '결정적이지 않으면 비교가 성립하지 않는다')

    def test_씨앗이_다르면_다른_배경음(self):
        self.assertFalse(np.allclose(bd.noise_bed(8000, 16000, seed=3),
                                     bd.noise_bed(8000, 16000, seed=4)))

    def test_크기_차이를_정한_대로_맞춘다(self):
        sr = 16000
        made = bd.build('.', lambda t, s: fake_synth(t, s), sr=sr)
        y = made['audio']
        bed = bd.noise_bed(len(y), sr, seed=1)
        loud = bd.mix_at_snr(y, bed, 20.0)
        quiet = bd.mix_at_snr(y, bed, 0.0)
        # 크기 차이가 작을수록 배경이 커지므로 빈 자리가 시끄러워진다.
        gap_a, gap_b = int(0.1 * sr), int(0.4 * sr)
        self.assertGreater(float(np.max(np.abs(quiet[gap_a:gap_b]))),
                           float(np.max(np.abs(loud[gap_a:gap_b]))))

    def test_섞어도_넘치지_않는다(self):
        sr = 16000
        made = bd.build('.', lambda t, s: fake_synth(t, s), sr=sr)
        mixed = bd.mix_at_snr(made['audio'], bd.noise_bed(len(made['audio']), sr), 0.0)
        self.assertLessEqual(float(np.max(np.abs(mixed))), 0.9501)


@unittest.skipUnless(HAVE_NP and HAVE_SF, 'numpy/soundfile 없음')
class Test파일로_내보내기(unittest.TestCase):
    def test_소리와_참값이_함께_나온다(self):
        made = bd.build('.', lambda t, s: fake_synth(t, s), sr=16000)
        with tempfile.TemporaryDirectory() as d:
            info = bd.write(d, made)
            self.assertTrue(os.path.isfile(info['audio_path']))
            with open(info['truth_path'], encoding='utf-8') as f:
                truth = json.load(f)
            self.assertEqual(len(truth['lines']), len(bd.SCRIPT))
            self.assertIn('start', truth['lines'][0])

    def test_배경음을_섞으면_이름이_달라진다(self):
        made = bd.build('.', lambda t, s: fake_synth(t, s), sr=16000)
        with tempfile.TemporaryDirectory() as d:
            info = bd.write(d, made, snr_db=5)
            self.assertIn('snr5', os.path.basename(info['audio_path']))


if __name__ == '__main__':
    unittest.main()
