# -*- coding: utf-8 -*-
"""dub_assemble.py 단위 검사 - 합성 신호만 쓴다(사용자 미디어도 영상도 쓰지 않는다).

실행: python -X utf8 python/test_dub_assemble.py
의존이 없으면 건너뛰고 그 사실을 남긴다. 건너뛴 것을 통과로 주장하지 않는다.
"""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import numpy as np
    import soundfile as sf
    HAVE_SF = True
except Exception:
    HAVE_SF = False

import dub_assemble as da
import dub_timing as dt


class Base(unittest.TestCase):
    SR = 24000

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='af-asm-')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def tone(self, name, seconds, freq=440.0, amp=0.3, sr=None):
        sr = sr or self.SR
        t = np.arange(int(sr * seconds)) / float(sr)
        path = os.path.join(self.dir, name)
        sf.write(path, (amp * np.sin(2 * np.pi * freq * t)).astype('float32'), sr)
        return path

    def rms(self, path, a, b):
        y, sr = sf.read(path, always_2d=True)
        seg = y[int(a * sr):int(b * sr)]
        return float(np.sqrt(np.mean(seg ** 2))) if seg.size else 0.0


@unittest.skipUnless(HAVE_SF, 'soundfile 없음 - 공용 venv 필요')
class Test자리에_놓기(Base):
    def test_각_줄이_제_시각에_놓인다(self):
        a = self.tone('a.wav', 1.0)
        b = self.tone('b.wav', 1.0)
        dest = os.path.join(self.dir, 'voice.wav')
        da.place_clips([{'path': a, 'start_sec': 1.0},
                        {'path': b, 'start_sec': 4.0}], dest, 6.0)
        self.assertLess(self.rms(dest, 0.1, 0.9), 1e-4, '앞은 조용해야 한다')
        self.assertGreater(self.rms(dest, 1.1, 1.9), 0.1, '1초 자리에 소리가 있다')
        self.assertLess(self.rms(dest, 2.5, 3.5), 1e-4, '사이는 조용하다')
        self.assertGreater(self.rms(dest, 4.1, 4.9), 0.1, '4초 자리에 소리가 있다')

    def test_트랙_길이가_요청한_길이다(self):
        a = self.tone('a.wav', 1.0)
        dest = os.path.join(self.dir, 'v.wav')
        r = da.place_clips([{'path': a, 'start_sec': 0.5}], dest, 8.0)
        self.assertAlmostEqual(sf.info(dest).duration, 8.0, places=2)
        self.assertEqual(r['placed'], 1)

    def test_트랙_밖으로_나가는_줄은_잘리고_그_사실을_알린다(self):
        a = self.tone('a.wav', 3.0)
        dest = os.path.join(self.dir, 'v.wav')
        r = da.place_clips([{'path': a, 'start_sec': 1.5}], dest, 2.0)
        self.assertEqual(r['trimmed'], 1, '잘린 사실을 조용히 넘기지 않는다')

    def test_표본율이_다르면_조용히_섞지_않고_실패한다(self):
        a = self.tone('a.wav', 1.0)
        b = self.tone('b.wav', 1.0, sr=16000)
        with self.assertRaises(da.DubAssembleError) as cm:
            da.place_clips([{'path': a, 'start_sec': 0.0},
                            {'path': b, 'start_sec': 2.0}],
                           os.path.join(self.dir, 'v.wav'), 4.0)
        self.assertIn('표본율', str(cm.exception))

    def test_없는_파일은_어느_것인지_말한다(self):
        with self.assertRaises(da.DubAssembleError) as cm:
            da.place_clips([{'path': os.path.join(self.dir, '없다.wav'),
                             'start_sec': 0.0}],
                           os.path.join(self.dir, 'v.wav'), 2.0)
        self.assertIn('없다.wav', str(cm.exception))

    def test_넘치면_줄이고_그_사실을_알린다(self):
        a = self.tone('a.wav', 1.0, amp=0.9)
        b = self.tone('b.wav', 1.0, amp=0.9)
        dest = os.path.join(self.dir, 'v.wav')
        r = da.place_clips([{'path': a, 'start_sec': 0.0},
                            {'path': b, 'start_sec': 0.0}], dest, 2.0)
        self.assertLess(r['scaled'], 1.0)

    def test_빈_목록은_사유와_함께_실패한다(self):
        with self.assertRaises(da.DubAssembleError):
            da.place_clips([], os.path.join(self.dir, 'v.wav'), 2.0)


@unittest.skipUnless(HAVE_SF, 'soundfile 없음 - 공용 venv 필요')
class Test줄_손보기(Base):
    def test_늘여야_하는_줄은_자리_길이에_맞는다(self):
        src = self.tone('line.wav', 3.0)
        plan = dt.plan_line(0.0, 2.4, 3.0, floor_sec=0.0, ceil_sec=2.4)
        self.assertEqual(plan['status'], 'stretched')
        dest = os.path.join(self.dir, 'fit.wav')
        done = da.fit_one_line(src, dest, plan, work_dir=self.dir)
        self.assertTrue(done['stretched'])
        self.assertLess(abs(sf.info(dest).duration - plan['place_sec']), 0.05)

    def test_맞는_줄은_늘이지_않는다(self):
        src = self.tone('line.wav', 1.0)
        plan = dt.plan_line(0.0, 3.0, 1.0, ceil_sec=3.0)
        dest = os.path.join(self.dir, 'fit.wav')
        done = da.fit_one_line(src, dest, plan, work_dir=self.dir)
        self.assertFalse(done['stretched'])
        self.assertAlmostEqual(sf.info(dest).duration, 1.0, places=2)

    def test_목표_음량을_주면_거기에_맞춘다(self):
        src = self.tone('line.wav', 2.0, amp=0.05)
        plan = dt.plan_line(0.0, 3.0, 2.0, ceil_sec=3.0)
        dest = os.path.join(self.dir, 'fit.wav')
        done = da.fit_one_line(src, dest, plan, target_lufs=-20.0, work_dir=self.dir)
        self.assertTrue(done['loudness_matched'])
        self.assertLess(abs(audio_fit_measure(dest) - (-20.0)), 1.5)

    def test_음량을_못_재면_소리를_버리지_않고_사실만_적는다(self):
        """★줄 하나를 통째로 잃는 것보다 음량이 안 맞는 편이 낫다."""
        src = self.tone('short.wav', 0.2)
        plan = dt.plan_line(0.0, 1.0, 0.2, ceil_sec=1.0)
        dest = os.path.join(self.dir, 'fit.wav')
        done = da.fit_one_line(src, dest, plan, target_lufs=-20.0, work_dir=self.dir)
        self.assertTrue(os.path.isfile(dest), '소리는 남는다')
        self.assertFalse(done['loudness_matched'])
        self.assertTrue(done['loudness_note'], '왜 못 맞췄는지 적는다')

    def test_목표를_안_주면_음량을_건드리지_않는다(self):
        src = self.tone('line.wav', 2.0)
        plan = dt.plan_line(0.0, 3.0, 2.0, ceil_sec=3.0)
        dest = os.path.join(self.dir, 'fit.wav')
        done = da.fit_one_line(src, dest, plan, work_dir=self.dir)
        self.assertFalse(done['loudness_matched'])


@unittest.skipUnless(HAVE_SF, 'soundfile 없음 - 공용 venv 필요')
class Test구간_음량(Base):
    def test_구간마다_다른_값을_돌려준다(self):
        sr = self.SR
        t = np.arange(sr * 6) / float(sr)
        y = 0.5 * np.sin(2 * np.pi * 220.0 * t)
        y[: sr * 3] *= 0.05                      # 앞 3초는 아주 작게
        path = os.path.join(self.dir, 'v.wav')
        sf.write(path, y.astype('float32'), sr)
        quiet = da.segment_loudness(path, 0.0, 2.5, self.dir)
        loud = da.segment_loudness(path, 3.5, 6.0, self.dir)
        self.assertIsNotNone(quiet)
        self.assertIsNotNone(loud)
        self.assertLess(quiet, loud - 10.0, '작게 말한 대목이 더 작게 나와야 한다')

    def test_잴_수_없는_구간은_None_이다(self):
        path = self.tone('v.wav', 2.0)
        self.assertIsNone(da.segment_loudness(path, 1.0, 1.1, self.dir))
        self.assertIsNone(da.segment_loudness(path, 9.0, 9.5, self.dir))


class Test자막(Base):
    def test_한국어가_있는_줄만_적는다(self):
        dest = os.path.join(self.dir, 'ko.srt')
        r = da.write_srt([
            {'start_sec': 0.0, 'end_sec': 1.5, 'korean': '안녕하세요'},
            {'start_sec': 2.0, 'end_sec': 3.0, 'korean': ''},
            {'start_sec': 3.0, 'end_sec': 4.25, 'korean': '반갑습니다'},
        ], dest)
        self.assertEqual(r['count'], 2)
        with open(dest, encoding='utf-8') as f:
            text = f.read()
        self.assertIn('00:00:00,000 --> 00:00:01,500', text)
        self.assertIn('00:00:03,000 --> 00:00:04,250', text)
        self.assertIn('안녕하세요', text)

    def test_번호가_1부터_이어진다(self):
        dest = os.path.join(self.dir, 'ko.srt')
        da.write_srt([{'start_sec': i, 'end_sec': i + 0.5, 'korean': '줄%d' % i}
                      for i in range(3)], dest)
        with open(dest, encoding='utf-8') as f:
            lines = f.read().splitlines()
        self.assertEqual([lines[0], lines[4], lines[8]], ['1', '2', '3'])


class Test되붙이기_경계(Base):
    def test_원본_영상_위에_덮어쓰지_않는다(self):
        """★원본은 건드리지 않는다. 이것만은 ffmpeg 를 부르기 전에 막는다."""
        fake = os.path.join(self.dir, 'v.mp4')
        open(fake, 'w').close()
        with self.assertRaises(da.DubAssembleError) as cm:
            da.mux_video(fake, os.path.join(self.dir, 'a.wav'), fake)
        self.assertIn('덮어쓸 수 없습니다', str(cm.exception))


def audio_fit_measure(path):
    import audio_fit
    return audio_fit.measure_loudness(path)


if __name__ == '__main__':
    unittest.main()
