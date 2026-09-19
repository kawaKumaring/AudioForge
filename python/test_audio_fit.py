# -*- coding: utf-8 -*-
"""audio_fit.py 단위 검사 — 저장소 fixture 음성과 합성 신호만 쓴다(사용자 미디어 미사용).

실행: python -X utf8 python/test_audio_fit.py
  ★`-m unittest python/...` 는 이 파이썬에서 'No module named python' 으로 죽는다.
    게이트(scripts/python-tests.mjs)도 파일을 직접 돌린다.

의존이 없으면(soundfile·numpy·librosa) 해당 검사를 **건너뛰고 그 사실을 남긴다.**
건너뛴 것을 통과로 주장하지 않는다.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(REPO, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')

try:
    import soundfile as sf
    import numpy as np
    HAVE_SF = True
except Exception:
    HAVE_SF = False

try:
    import librosa            # 음높이 확인에만 쓴다
    HAVE_LIBROSA = True
except Exception:
    HAVE_LIBROSA = False

import audio_fit


@unittest.skipUnless(HAVE_SF, 'soundfile 없음 — 공용 venv 필요')
class TestProbeDuration(unittest.TestCase):
    def test_길이를_초로_돌려준다(self):
        sec = audio_fit.probe_duration(FIXTURE)
        self.assertGreater(sec, 1.0)
        self.assertLess(sec, 60.0)

    def test_없는_파일은_사유와_함께_실패한다(self):
        with self.assertRaises(audio_fit.AudioFitError):
            audio_fit.probe_duration(os.path.join(REPO, 'no-such-file.wav'))



@unittest.skipUnless(HAVE_SF, 'soundfile 없음 — 공용 venv 필요')
class TestStretchTo(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.dir = tempfile.mkdtemp(prefix='af-fit-')

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_원하는_길이로_맞춘다(self):
        src_sec = audio_fit.probe_duration(FIXTURE)
        target = src_sec * 0.8                      # 20% 짧게
        dest = os.path.join(self.dir, 'out.wav')
        r = audio_fit.stretch_to(FIXTURE, dest, target)
        self.assertTrue(os.path.isfile(dest))
        # 오차 50ms 안. rubberband 는 프레임 단위로 끊으므로 정확히 같지는 않다.
        self.assertLess(abs(r['out_sec'] - target), 0.05,
                        '실제 %.3f초 vs 목표 %.3f초' % (r['out_sec'], target))
        self.assertAlmostEqual(r['ratio'], src_sec / target, places=3)

    def test_늘이는_쪽도_된다(self):
        src_sec = audio_fit.probe_duration(FIXTURE)
        target = src_sec * 1.25                     # 25% 길게
        dest = os.path.join(self.dir, 'long.wav')
        r = audio_fit.stretch_to(FIXTURE, dest, target)
        self.assertLess(abs(r['out_sec'] - target), 0.05)
        self.assertLess(r['ratio'], 1.0)

    def test_배율_한계를_넘으면_한계까지만_하고_그_사실을_알린다(self):
        src_sec = audio_fit.probe_duration(FIXTURE)
        dest = os.path.join(self.dir, 'clamped.wav')
        r = audio_fit.stretch_to(FIXTURE, dest, src_sec / 10.0)   # 10배는 불가능
        self.assertEqual(r['ratio'], audio_fit.STRETCH_MAX_RATIO)
        self.assertTrue(r['clamped'], '한계에 걸렸으면 그 사실을 돌려준다')

    def test_목표가_0_이하면_사유와_함께_실패한다(self):
        dest = os.path.join(self.dir, 'bad.wav')
        with self.assertRaises(audio_fit.AudioFitError):
            audio_fit.stretch_to(FIXTURE, dest, 0.0)

    @unittest.skipUnless(HAVE_LIBROSA, 'librosa 없음 — 음높이 확인 건너뜀')
    def test_음높이가_유지된다(self):
        """★이것이 rubberband 를 쓰는 이유다. 단순 배속은 음높이가 올라가 다른 사람이 된다."""
        dest = os.path.join(self.dir, 'p.wav')
        src_sec = audio_fit.probe_duration(FIXTURE)
        audio_fit.stretch_to(FIXTURE, dest, src_sec * 0.8)

        def median_f0(path):
            y, sr = librosa.load(path, sr=16000, mono=True)
            f0 = librosa.yin(y, fmin=70, fmax=400, sr=sr)
            return float(np.median(f0))

        before, after = median_f0(FIXTURE), median_f0(dest)
        cents = 1200.0 * np.log2(after / before)
        self.assertLess(abs(cents), 50.0,
                        '음높이가 %.1f센트 움직였다(50센트=반음의 절반)' % cents)



@unittest.skipUnless(HAVE_SF, 'soundfile 없음 — 공용 venv 필요')
class TestLoudness(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.dir = tempfile.mkdtemp(prefix='af-loud-')

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def _short_copy(self, name, seconds=0.2):
        path = os.path.join(self.dir, name)
        y, sr = sf.read(FIXTURE)
        sf.write(path, y[: int(sr * seconds)], sr)
        return path

    def test_음량을_숫자로_돌려준다(self):
        lufs = audio_fit.measure_loudness(FIXTURE)
        self.assertIsNotNone(lufs)
        self.assertLess(lufs, 0.0, '정상 음원은 0 LUFS 보다 작다')
        self.assertGreater(lufs, -60.0)

    def test_너무_짧으면_잴_수_없다고_말한다(self):
        """★없는 값을 지어내지 않는다. 0.4초 미만은 이 방식으로 잴 수 없다."""
        self.assertIsNone(audio_fit.measure_loudness(self._short_copy('short.wav')))

    def test_목표_음량에_맞춘다(self):
        dest = os.path.join(self.dir, 'matched.wav')
        target = -23.0
        r = audio_fit.match_loudness(FIXTURE, dest, target)
        self.assertLess(abs(r['after_lufs'] - target), 1.0,
                        '맞춘 뒤 %.1f LUFS (목표 %.1f)' % (r['after_lufs'], target))

    def test_지나친_증폭은_한계까지만_하고_알린다(self):
        dest = os.path.join(self.dir, 'loudclamp.wav')
        r = audio_fit.match_loudness(FIXTURE, dest, 0.0, max_gain_db=6.0)
        self.assertEqual(r['gain_db'], 6.0)
        self.assertTrue(r['clamped'])

    def test_잴_수_없는_음원은_사유와_함께_실패한다(self):
        with self.assertRaises(audio_fit.AudioFitError):
            audio_fit.match_loudness(self._short_copy('s2.wav'),
                                     os.path.join(self.dir, 'o.wav'), -23.0)



@unittest.skipUnless(HAVE_SF, 'soundfile 없음 — 공용 venv 필요')
class TestDuck(unittest.TestCase):
    """합성 신호만 쓴다 — 사용자 음원도 fixture 도 필요 없다."""

    def setUp(self):
        import tempfile
        self.dir = tempfile.mkdtemp(prefix='af-duck-')
        self.sr = 24000
        t = np.arange(self.sr * 6) / float(self.sr)
        # 배경음: 6초 내내 같은 크기의 낮은 음.
        self.bg = os.path.join(self.dir, 'bg.wav')
        sf.write(self.bg, (0.3 * np.sin(2 * np.pi * 220.0 * t)).astype('float32'), self.sr)
        # 목소리: 2~4초 구간에만 소리가 있다.
        v = np.zeros_like(t, dtype='float32')
        seg = slice(self.sr * 2, self.sr * 4)
        v[seg] = (0.5 * np.sin(2 * np.pi * 440.0 * t[seg])).astype('float32')
        self.voice = os.path.join(self.dir, 'voice.wav')
        sf.write(self.voice, v, self.sr)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def _rms(self, path, a, b):
        y, sr = sf.read(path)
        if y.ndim > 1:
            y = y.mean(axis=1)
        seg = y[int(a * sr):int(b * sr)]
        return float(np.sqrt(np.mean(seg ** 2)))

    def test_말하는_동안_배경음이_낮아진다(self):
        dest = os.path.join(self.dir, 'mixed.wav')
        r = audio_fit.duck(self.bg, self.voice, dest)
        self.assertTrue(os.path.isfile(dest))
        # 섞인 결과에서는 목소리가 더해져 커지므로 **배경음만** 따로 눌러 확인한다.
        self.assertTrue(os.path.isfile(r['ducked_bg_path']))
        quiet = self._rms(r['ducked_bg_path'], 0.2, 1.5)
        during = self._rms(r['ducked_bg_path'], 2.5, 3.5)
        self.assertLess(during, quiet * 0.7,
                        '말하는 동안 배경 %.4f, 조용할 때 %.4f — 충분히 낮아지지 않았다'
                        % (during, quiet))

    def test_말이_끝나면_배경음이_돌아온다(self):
        dest = os.path.join(self.dir, 'back.wav')
        r = audio_fit.duck(self.bg, self.voice, dest)
        quiet_before = self._rms(r['ducked_bg_path'], 0.2, 1.5)
        after = self._rms(r['ducked_bg_path'], 5.0, 5.8)
        self.assertGreater(after, quiet_before * 0.8, '말이 끝난 뒤 배경이 돌아와야 한다')

    def test_길이가_원본_배경음을_따른다(self):
        dest = os.path.join(self.dir, 'len.wav')
        audio_fit.duck(self.bg, self.voice, dest)
        self.assertLess(abs(audio_fit.probe_duration(dest)
                            - audio_fit.probe_duration(self.bg)), 0.05)


if __name__ == '__main__':
    unittest.main()
