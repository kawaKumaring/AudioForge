# -*- coding: utf-8 -*-
"""asr_preprocess.py 단위 검사 - 모델도 GPU도 소리 파일도 쓰지 않는다. 가짜 함수로 돈다.

실행: python -X utf8 python/test_asr_preprocess.py
"""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import asr_preprocess as ap


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='af-pre-')
        self.src = os.path.join(self.dir, 'source.wav')
        open(self.src, 'w').close()
        self.vocals = os.path.join(self.dir, 'vocals.wav')
        self.inst = os.path.join(self.dir, 'instrumental.wav')
        for p in (self.vocals, self.inst):
            open(p, 'w').close()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def sep(self, tracks=None):
        made = tracks if tracks is not None else [
            {'name': 'vocals', 'path': self.vocals},
            {'name': 'instrumental', 'path': self.inst},
        ]
        return lambda src, out: made

    def loud(self, vocals_lufs, bg_lufs):
        return lambda p: vocals_lufs if p == self.vocals else bg_lufs


class Test모드(Base):
    def test_기본은_건드리지_않는다(self):
        """★예전 동작이 기본이다. 부르지 않으면 아무것도 달라지지 않는다."""
        r = ap.prepare(self.src, self.dir)
        self.assertEqual(r['path'], self.src)
        self.assertFalse(r['separated'])

    def test_모르는_모드는_건드리지_않는_쪽으로_본다(self):
        self.assertEqual(ap.normalize_mode('엉뚱한값'), ap.MODE_NEVER)
        self.assertEqual(ap.normalize_mode(None), ap.MODE_NEVER)
        self.assertEqual(ap.normalize_mode('AUTO'), ap.MODE_AUTO)

    def test_늘_걷어내기를_고르면_재지_않고_걷어낸다(self):
        called = []
        r = ap.prepare(self.src, self.dir, 'always', separate_fn=self.sep(),
                       loudness_fn=lambda p: called.append(p) or -20.0)
        self.assertEqual(r['path'], self.vocals)
        self.assertTrue(r['separated'])
        self.assertEqual(called, [], '늘 걷어낼 거면 잴 필요가 없다')


class Test자동_판단(Base):
    """★늘 켜면 안 된다. 배경음 없는 말소리는 분리기가 오히려 상하게 한다."""

    def test_배경음이_충분히_작으면_원본을_쓴다(self):
        r = ap.prepare(self.src, self.dir, 'auto', separate_fn=self.sep(),
                       loudness_fn=self.loud(-16.0, -50.0))     # 34dB 차이
        self.assertEqual(r['path'], self.src)
        self.assertFalse(r['separated'])
        self.assertIn('걷어낼 것이 없습니다', r['reason'])

    def test_배경음이_크면_걷어낸다(self):
        r = ap.prepare(self.src, self.dir, 'auto', separate_fn=self.sep(),
                       loudness_fn=self.loud(-16.0, -22.0))     # 6dB 차이
        self.assertEqual(r['path'], self.vocals)
        self.assertTrue(r['separated'])
        self.assertAlmostEqual(r['gap_db'], 6.0)

    def test_경계값에서_한쪽으로만_기운다(self):
        for gap, want in ((ap.QUIET_BACKGROUND_DB - 0.1, True),
                          (ap.QUIET_BACKGROUND_DB, False),
                          (ap.QUIET_BACKGROUND_DB + 0.1, False)):
            use, _ = ap.decide_from_gap(gap)
            self.assertEqual(use, want, '%.1fdB 에서 판단이 다르다' % gap)

    def test_못_재면_원본을_쓴다(self):
        """모르면 건드리지 않는 쪽이 안전하다."""
        r = ap.prepare(self.src, self.dir, 'auto', separate_fn=self.sep(),
                       loudness_fn=lambda p: None)
        self.assertEqual(r['path'], self.src)
        self.assertIn('재지 못해', r['reason'])

    def test_음량_재는_것이_터져도_원본으로_돌아간다(self):
        def boom(p):
            raise RuntimeError('못 잰다')
        r = ap.prepare(self.src, self.dir, 'auto', separate_fn=self.sep(), loudness_fn=boom)
        self.assertEqual(r['path'], self.src)


class Test막혔을_때(Base):
    """★어떤 경우에도 알아듣기 자체가 막히면 안 된다. 실패하면 원본으로 돌아간다."""

    def test_분리기가_없으면_원본을_쓴다(self):
        r = ap.prepare(self.src, self.dir, 'auto', separate_fn=None)
        self.assertEqual(r['path'], self.src)
        self.assertIn('분리기를 쓸 수 없어', r['reason'])

    def test_분리가_터져도_원본을_쓴다(self):
        def boom(src, out):
            raise RuntimeError('모델 없음')
        r = ap.prepare(self.src, self.dir, 'auto', separate_fn=boom)
        self.assertEqual(r['path'], self.src)
        self.assertIn('분리에 실패해', r['reason'])

    def test_보컬이_안_나오면_원본을_쓴다(self):
        r = ap.prepare(self.src, self.dir, 'auto',
                       separate_fn=self.sep([{'name': 'drums', 'path': self.inst}]))
        self.assertEqual(r['path'], self.src)
        self.assertIn('보컬이 없어', r['reason'])

    def test_빈_결과여도_원본을_쓴다(self):
        r = ap.prepare(self.src, self.dir, 'auto', separate_fn=self.sep([]))
        self.assertEqual(r['path'], self.src)

    def test_왜_그렇게_했는지_늘_남긴다(self):
        """조용히 정하지 않는다 - 나중에 되짚을 수 있어야 한다."""
        for mode, sep in (('never', None), ('auto', None), ('always', self.sep()),
                          ('auto', self.sep())):
            r = ap.prepare(self.src, self.dir, mode, separate_fn=sep,
                           loudness_fn=self.loud(-16.0, -22.0))
            self.assertTrue(r['reason'], '%s 에서 사유가 비었다' % mode)


class Test배경음_없는_분리기(Base):
    def test_반주_트랙이_없으면_다른_조각으로_가늠한다(self):
        """Demucs 는 반주를 통째로 주지 않는다 - 조각 하나로 가늠한다."""
        drums = os.path.join(self.dir, 'drums.wav')
        open(drums, 'w').close()
        r = ap.prepare(self.src, self.dir, 'auto',
                       separate_fn=self.sep([{'name': 'vocals', 'path': self.vocals},
                                             {'name': 'drums', 'path': drums}]),
                       loudness_fn=lambda p: -16.0 if p == self.vocals else -22.0)
        self.assertTrue(r['separated'])


if __name__ == '__main__':
    unittest.main()
