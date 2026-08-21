# -*- coding: utf-8 -*-
"""참조 구간 백엔드 회귀 — 자동 추천/구간 분석/경계/파형 peak/트림(mono·24k·원본 불변).
실제 모델 불필요(합성 스모크는 별도). 합성 신호로 결정적으로 검증."""
import os
import sys
import tempfile
import shutil
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reference_region as rr


def _make(path, sr=24000):
    """30s: [0-5) 무음, [5-15) 톤(발화), [15-18) 무음, [18-28) 톤, [28-30) 무음."""
    import numpy as np
    import soundfile as sf
    n = 30 * sr
    t = np.arange(n) / sr
    sig = np.zeros(n, dtype="float32")
    tone = lambda a, b: (0.3 * np.sin(2 * np.pi * 180 * t[int(a * sr):int(b * sr)])).astype("float32")
    sig[5 * sr:15 * sr] = tone(5, 15)
    sig[18 * sr:28 * sr] = tone(18, 28)
    sf.write(path, sig, sr)


class ReferenceRegionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_region_")
        self.src = os.path.join(self.tmp, "long.wav")
        _make(self.src)
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def test_recommend_in_speech_and_length(self):
        r = rr.recommend_region(self.src)
        self.assertTrue(r["ok"])
        self.assertFalse(r["whole_file"])
        self.assertTrue(rr.REC_MIN_SEC <= r["dur_sec"] <= rr.REC_MAX_SEC, r)
        # 추천 구간은 발화 구간([5,15) 또는 [18,28)) 내에서 시작해야 함(무음 [0,5) 아님)
        s = r["start_sec"]
        self.assertTrue((5.0 <= s <= 15.0) or (18.0 <= s <= 28.0),
                        f"추천 시작 {s}s가 발화 구간이 아님")

    def test_recommend_short_file_whole(self):
        short = os.path.join(self.tmp, "short.wav")
        import numpy as np
        import soundfile as sf
        sf.write(short, (0.3 * np.sin(2 * np.pi * 180 * np.arange(int(5 * 24000)) / 24000)).astype("float32"), 24000)
        r = rr.recommend_region(short)
        self.assertTrue(r["ok"])
        self.assertTrue(r["whole_file"])

    def test_analyze_region_silence_vs_speech(self):
        sil = rr.analyze_region(self.src, 0.0, 4.0)   # 무음 구간
        sp = rr.analyze_region(self.src, 6.0, 7.0)    # 발화 구간
        self.assertGreater(sil["silence_ratio"], 0.8)
        self.assertLess(sp["silence_ratio"], 0.2)
        self.assertTrue(any("무음" in w for w in sil["warnings"]))

    def test_length_boundary(self):
        # 2.99 차단 / 3.0 허용 / 10.0 허용 / 10.01 차단
        self.assertFalse(rr.analyze_region(self.src, 5.0, 2.99)["in_range"])
        self.assertTrue(rr.analyze_region(self.src, 5.0, 3.0)["in_range"])
        self.assertTrue(rr.analyze_region(self.src, 5.0, 10.0)["in_range"])
        self.assertFalse(rr.analyze_region(self.src, 5.0, 10.01)["in_range"])

    def test_coarse_peaks(self):
        p = rr.coarse_peaks(self.src, buckets=300)
        self.assertEqual(len(p["peaks"]), 300)
        self.assertTrue(all(0.0 <= x <= 1.0 for x in p["peaks"]))
        self.assertLess(p["peaks"][0], 0.05)  # 첫 버킷(무음) 거의 0

    def test_trim_mono_24k_and_original_unchanged(self):
        import soundfile as sf
        before = os.stat(self.src)
        out = os.path.join(self.tmp, "derived.wav")
        rr.trim_region(self.src, 6.0, 7.0, out)
        info = sf.info(out)
        self.assertEqual(info.samplerate, 24000)
        self.assertEqual(info.channels, 1)
        self.assertAlmostEqual(info.frames / info.samplerate, 7.0, delta=0.05)
        # 원본 불변(size/mtime)
        after = os.stat(self.src)
        self.assertEqual(before.st_size, after.st_size)
        self.assertEqual(before.st_mtime_ns, after.st_mtime_ns)

    def test_trim_resamples_from_48k(self):
        import numpy as np
        import soundfile as sf
        src48 = os.path.join(self.tmp, "s48.wav")
        sf.write(src48, (0.3 * np.sin(2 * np.pi * 180 * np.arange(int(12 * 48000)) / 48000)).astype("float32"), 48000)
        out = os.path.join(self.tmp, "d48.wav")
        rr.trim_region(src48, 2.0, 6.0, out)
        info = sf.info(out)
        self.assertEqual(info.samplerate, 24000)
        self.assertEqual(info.channels, 1)
        self.assertAlmostEqual(info.frames / info.samplerate, 6.0, delta=0.05)


if __name__ == "__main__":
    unittest.main(verbosity=2)
