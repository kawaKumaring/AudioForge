# -*- coding: utf-8 -*-
"""리미터 — 합성 신호만 쓴다(사용자 음성 없음)."""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import shutil
import tempfile
import unittest

import numpy as np

import audio_limiter as L

SR = 44100


def sine(freq, amp, sec=1.0, phase=0.0, sr=SR):
    t = np.arange(int(sr * sec)) / sr
    return (amp * np.sin(2 * np.pi * freq * t + phase)).astype(np.float64)


class TestTruePeak(unittest.TestCase):
    def test_샘플_사이에_숨은_최대치를_찾는다(self):
        # fs/4 사인을 45도 어긋나게 찍으면 샘플 값은 모두 ±0.707, 실제 파형 꼭대기는 1.0 이다.
        x = sine(SR / 4, 1.0, 0.2, phase=np.pi / 4)
        self.assertLess(np.abs(x).max(), 0.72)
        self.assertGreater(L.true_peak(x), 0.97)

    def test_보통_사인은_샘플_최대와_거의_같다(self):
        x = sine(440, 0.5, 0.5)
        self.assertAlmostEqual(L.true_peak(x), 0.5, delta=0.005)


class TestLimit(unittest.TestCase):
    def test_상한_아래면_바꾸지_않는다(self):
        x = sine(440, 0.5)
        y, info = L.limit(x, SR)
        self.assertFalse(info['limited'])
        self.assertTrue(np.allclose(y, x, atol=1e-6))

    def test_넘는_소리는_실제_최대치가_상한을_넘지_않는다(self):
        x = sine(440, 0.3, 2.0)
        x[SR // 2: SR // 2 + 4410] *= 5.0            # 0.1초 동안 1.5 까지 튀는 구간
        y, info = L.limit(x, SR, ceiling_db=-1.0)
        self.assertTrue(info['limited'])
        self.assertLessEqual(L.lin_to_db(L.true_peak(y)), -1.0 + 1e-6)
        self.assertGreater(info['max_reduction_db'], 3.0)

    def test_튄_구간_밖은_거의_그대로다(self):
        x = sine(440, 0.3, 2.0)
        x[SR // 2: SR // 2 + 4410] *= 5.0
        y, _ = L.limit(x, SR)
        before = slice(0, SR // 2 - 200)                 # 앞보기 1.5ms 보다 충분히 앞
        after = slice(SR // 2 + 4410 + int(SR * 0.4), None)  # 해제(50ms) 가 끝난 뒤
        self.assertTrue(np.allclose(y[before], x[before], atol=1e-4))
        self.assertTrue(np.allclose(y[after], x[after], atol=0.01))

    def test_스테레오는_같은_이득을_쓴다(self):
        left = sine(440, 1.4, 0.5)
        right = sine(440, 0.7, 0.5)
        y, _ = L.limit(np.stack([left, right], axis=1), SR)
        ratio = y[:, 1] / np.where(np.abs(y[:, 0]) > 1e-3, y[:, 0], np.nan)
        self.assertAlmostEqual(float(np.nanmedian(ratio)), 0.5, places=3)

    def test_앞보기보다_짧은_소리도_처리한다(self):
        y, info = L.limit(np.array([2.0, -2.0, 1.5]), SR)
        self.assertLessEqual(L.lin_to_db(L.true_peak(y)), -1.0 + 1e-6)

    def test_빈_소리와_숫자가_아닌_값은_거절한다(self):
        with self.assertRaises(L.LimiterError):
            L.limit(np.array([]), SR)
        with self.assertRaises(L.LimiterError):
            L.limit(np.array([0.1, np.nan]), SR)


class TestLimitFile(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='af-limit-')

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_32비트_실수_파일의_1_넘는_값을_잡는다(self):
        import soundfile as sf
        p = os.path.join(self.d, 'over.wav')
        sf.write(p, sine(440, 1.6, 0.5), SR, subtype='FLOAT')   # 노래 변환기가 쓰는 형식
        info = L.limit_file(p)
        y, _ = sf.read(p)
        self.assertEqual(sf.info(p).subtype, 'FLOAT')
        self.assertLessEqual(L.lin_to_db(L.true_peak(y)), -1.0 + 1e-6)
        self.assertTrue(info['limited'])
        self.assertFalse(os.path.exists(p + '.limit.part'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
