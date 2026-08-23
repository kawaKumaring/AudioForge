# -*- coding: utf-8 -*-
"""music_separation_integrity 순수 무결성 코어 회귀 — 합성 numpy 배열만 사용.

실제 오디오 파일·모델·GPU 없음. 채널 우선 `(C, N)` 규약.

실행:
  python python/test_music_separation_integrity.py
  python -m unittest discover -s python -p "test_music_separation_integrity.py"
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import music_separation_integrity as msi  # noqa: E402


def _tone(freq, sr, dur, ch=2, amp=0.3, phase=0.0):
    """결정적 정현파 `(ch, N)`."""
    n = int(sr * dur)
    t = np.arange(n) / sr
    sig = (amp * np.sin(2 * np.pi * freq * t + phase)).astype(np.float32)
    return np.tile(sig, (ch, 1))


class FiniteTest(unittest.TestCase):
    def test_clean_ok(self):
        r = msi.check_finite(_tone(440, 8000, 0.1))
        self.assertEqual(r.verdict, msi.Verdict.OK)
        self.assertEqual(r.metrics["nan"], 0)

    def test_nan_fails(self):
        a = _tone(440, 8000, 0.1)
        a[0, 5] = np.nan
        r = msi.check_finite(a)
        self.assertEqual(r.verdict, msi.Verdict.FAIL)
        self.assertEqual(r.metrics["nan"], 1)

    def test_inf_fails(self):
        a = _tone(440, 8000, 0.1)
        a[1, 3] = np.inf
        r = msi.check_finite(a)
        self.assertEqual(r.verdict, msi.Verdict.FAIL)
        self.assertEqual(r.metrics["inf"], 1)

    def test_mono_1d_promoted(self):
        r = msi.check_finite(np.zeros(100, dtype=np.float32))
        self.assertEqual(r.verdict, msi.Verdict.OK)


class DescribeTest(unittest.TestCase):
    def test_shape_only_no_samples(self):
        spec = msi.describe_audio(_tone(440, 44100, 0.5, ch=2), 44100)
        self.assertEqual(spec.sample_rate, 44100)
        self.assertEqual(spec.channels, 2)
        self.assertEqual(spec.length, 22050)
        self.assertAlmostEqual(spec.duration_sec, 0.5, places=6)

    def test_reject_3d(self):
        with self.assertRaises(msi.IntegrityError):
            msi.describe_audio(np.zeros((2, 2, 2)), 8000)


class SpecMatchTest(unittest.TestCase):
    def test_all_match(self):
        specs = [msi.describe_audio(_tone(440, 8000, 0.1), 8000) for _ in range(3)]
        r = msi.check_spec_match(specs)
        self.assertEqual(r.verdict, msi.Verdict.OK)

    def test_length_mismatch_fails_no_silent_truncate(self):
        a = msi.describe_audio(_tone(440, 8000, 0.10), 8000)
        b = msi.describe_audio(_tone(440, 8000, 0.11), 8000)
        r = msi.check_spec_match([a, b], labels=["a", "b"])
        self.assertEqual(r.verdict, msi.Verdict.FAIL)
        self.assertIn("length", r.message)

    def test_channel_mismatch_fails(self):
        a = msi.describe_audio(_tone(440, 8000, 0.1, ch=2), 8000)
        b = msi.describe_audio(_tone(440, 8000, 0.1, ch=1), 8000)
        r = msi.check_spec_match([a, b])
        self.assertEqual(r.verdict, msi.Verdict.FAIL)

    def test_sample_rate_mismatch_fails(self):
        a = msi.describe_audio(_tone(440, 8000, 0.1), 8000)
        b = msi.describe_audio(_tone(440, 16000, 0.05), 16000)
        r = msi.check_spec_match([a, b])
        self.assertEqual(r.verdict, msi.Verdict.FAIL)

    def test_tolerance_allows_small_diff(self):
        a = msi.describe_audio(np.zeros((2, 1000), np.float32), 8000)
        b = msi.describe_audio(np.zeros((2, 1003), np.float32), 8000)
        strict = msi.check_spec_match([a, b])
        self.assertEqual(strict.verdict, msi.Verdict.FAIL)
        lenient = msi.check_spec_match([a, b], length_tolerance=8)
        self.assertEqual(lenient.verdict, msi.Verdict.OK)

    def test_single_spec_ok(self):
        r = msi.check_spec_match([msi.describe_audio(np.zeros((2, 10)), 8000)])
        self.assertEqual(r.verdict, msi.Verdict.OK)


class AlignmentTest(unittest.TestCase):
    def test_identical_ok(self):
        a = _tone(300, 8000, 0.2, phase=0.3)
        r = msi.check_stem_alignment(a, a.copy())
        self.assertEqual(r.verdict, msi.Verdict.OK)
        self.assertEqual(r.metrics["polarity"], 1)
        self.assertEqual(r.metrics["offset"], 0)

    def test_polarity_inversion_is_fallback_candidate(self):
        a = _tone(300, 8000, 0.2)
        r = msi.check_stem_alignment(a, -a)
        self.assertEqual(r.verdict, msi.Verdict.FALLBACK_CANDIDATE)
        self.assertEqual(r.metrics["polarity"], -1)

    def test_estimate_polarity_direct(self):
        a = _tone(200, 8000, 0.2)
        self.assertEqual(msi.estimate_polarity(a, a.copy()), 1)
        self.assertEqual(msi.estimate_polarity(a, -a), -1)

    def test_offset_detected(self):
        sr = 8000
        base = np.random.RandomState(0).randn(1, sr).astype(np.float32) * 0.2
        shift = 20
        shifted = np.zeros_like(base)
        shifted[:, shift:] = base[:, :-shift]
        off = msi.estimate_offset(base, shifted)
        self.assertEqual(off, shift)

    def test_large_offset_is_fallback_candidate(self):
        sr = 8000
        base = np.random.RandomState(1).randn(1, sr).astype(np.float32) * 0.2
        shift = 200
        shifted = np.zeros_like(base)
        shifted[:, shift:] = base[:, :-shift]
        r = msi.check_stem_alignment(base, shifted, max_offset=64, max_lag=1024)
        self.assertEqual(r.verdict, msi.Verdict.FALLBACK_CANDIDATE)
        self.assertEqual(abs(r.metrics["offset"]), shift)

    def test_gain_divergence_is_fallback_candidate(self):
        a = _tone(300, 8000, 0.2)
        b = a * 5.0  # gain_ratio = 1/5 = 0.2 < gain_low 0.5
        r = msi.check_stem_alignment(a, b)
        self.assertEqual(r.verdict, msi.Verdict.FALLBACK_CANDIDATE)
        self.assertLess(r.metrics["gain_ratio"], 0.5)

    def test_gain_ratio_direct(self):
        a = _tone(300, 8000, 0.2, amp=0.4)
        b = _tone(300, 8000, 0.2, amp=0.2)
        self.assertAlmostEqual(msi.estimate_gain(a, b), 2.0, places=3)
        self.assertEqual(msi.estimate_gain(a, np.zeros_like(a)), 0.0)


class MixtureConsistencyTest(unittest.TestCase):
    def test_perfect_reconstruction_ok(self):
        v = _tone(440, 8000, 0.2, amp=0.2)
        i = _tone(110, 8000, 0.2, amp=0.2, phase=1.1)
        mixture = v + i
        r = msi.check_mixture_consistency(mixture, [v, i])
        self.assertEqual(r.verdict, msi.Verdict.OK)
        self.assertLess(r.metrics["relative_error"], 1e-6)

    def test_poor_reconstruction_is_fallback_candidate(self):
        v = _tone(440, 8000, 0.2, amp=0.2)
        i = _tone(110, 8000, 0.2, amp=0.2)
        mixture = v + i
        # 스템 하나가 크게 어긋남 → 합이 mixture 를 복원 못함
        bad = i * 0.3
        r = msi.check_mixture_consistency(mixture, [v, bad])
        self.assertEqual(r.verdict, msi.Verdict.FALLBACK_CANDIDATE)
        self.assertGreater(r.metrics["relative_error"], 1e-3)

    def test_shape_mismatch_raises_not_silent(self):
        mixture = _tone(440, 8000, 0.20)
        short = _tone(440, 8000, 0.19)
        with self.assertRaises(msi.IntegrityError):
            msi.check_mixture_consistency(mixture, [short])

    def test_empty_stems_raises(self):
        with self.assertRaises(msi.IntegrityError):
            msi.analyze_reconstruction(_tone(440, 8000, 0.1), [])


class PeakClippingTest(unittest.TestCase):
    def test_clean_ok(self):
        r = msi.check_peak_clipping(_tone(440, 8000, 0.1, amp=0.5))
        self.assertEqual(r.verdict, msi.Verdict.OK)
        self.assertLess(r.metrics["peak"], 1.0)

    def test_clipping_fails(self):
        a = _tone(440, 8000, 0.1, amp=0.5)
        a[0, 10] = 1.5
        a[0, 20] = -1.2
        r = msi.check_peak_clipping(a)
        self.assertEqual(r.verdict, msi.Verdict.FAIL)
        self.assertEqual(r.metrics["clipped_samples"], 2)

    def test_tolerance_allows_some(self):
        a = _tone(440, 8000, 0.1, amp=0.5)
        a[0, 10] = 1.5
        n = a.size
        r = msi.check_peak_clipping(a, max_clipped_ratio=2.0 / n)
        self.assertEqual(r.verdict, msi.Verdict.OK)

    def test_empty_ok(self):
        r = msi.check_peak_clipping(np.zeros((2, 0), np.float32))
        self.assertEqual(r.verdict, msi.Verdict.OK)


class FingerprintTest(unittest.TestCase):
    def test_deterministic_and_size(self):
        data = b"\x00\x01\x02\x03model-weights"
        m1 = msi.fingerprint_bytes(data, "roformer")
        m2 = msi.fingerprint_bytes(data, "roformer-again")
        self.assertEqual(m1.size_bytes, len(data))
        self.assertEqual(m1.sha256, m2.sha256)
        self.assertTrue(msi.manifests_match(m1, m2))

    def test_different_bytes_differ(self):
        a = msi.fingerprint_bytes(b"aaaa", "x")
        b = msi.fingerprint_bytes(b"aaab", "x")
        self.assertNotEqual(a.sha256, b.sha256)
        self.assertFalse(msi.manifests_match(a, b))

    def test_rejects_non_bytes(self):
        with self.assertRaises(msi.IntegrityError):
            msi.fingerprint_bytes("not-bytes", "x")

    def test_manifest_has_no_audio_fields(self):
        m = msi.fingerprint_bytes(b"weights", "m")
        fields = set(m.__dataclass_fields__.keys())
        self.assertEqual(fields, {"identifier", "size_bytes", "sha256", "algo"})


class ReportAggregationTest(unittest.TestCase):
    def test_worst_verdict_wins(self):
        rep = msi.IntegrityReport()
        rep.add(msi.CheckResult("a", msi.Verdict.OK, ""))
        rep.add(msi.CheckResult("b", msi.Verdict.FALLBACK_CANDIDATE, ""))
        self.assertEqual(rep.verdict, msi.Verdict.FALLBACK_CANDIDATE)
        rep.add(msi.CheckResult("c", msi.Verdict.FAIL, ""))
        self.assertEqual(rep.verdict, msi.Verdict.FAIL)

    def test_failures_and_candidates_separated(self):
        rep = msi.IntegrityReport()
        rep.add(msi.CheckResult("fail1", msi.Verdict.FAIL, ""))
        rep.add(msi.CheckResult("cand1", msi.Verdict.FALLBACK_CANDIDATE, ""))
        rep.add(msi.CheckResult("ok1", msi.Verdict.OK, ""))
        self.assertEqual([c.code for c in rep.failures], ["fail1"])
        self.assertEqual([c.code for c in rep.fallback_candidates], ["cand1"])

    def test_empty_report_ok(self):
        self.assertEqual(msi.IntegrityReport().verdict, msi.Verdict.OK)

    def test_validate_stem_set_clean(self):
        v = _tone(440, 8000, 0.2, amp=0.3)
        i = _tone(110, 8000, 0.2, amp=0.3)
        rep = msi.validate_stem_set([v, i], 8000, labels=["vocals", "inst"])
        self.assertEqual(rep.verdict, msi.Verdict.OK)

    def test_validate_stem_set_catches_length_and_nan(self):
        v = _tone(440, 8000, 0.20, amp=0.3)
        i = _tone(110, 8000, 0.19, amp=0.3)  # 길이 다름
        i[0, 0] = np.nan                      # NaN
        rep = msi.validate_stem_set([v, i], 8000, labels=["vocals", "inst"])
        self.assertEqual(rep.verdict, msi.Verdict.FAIL)
        codes = {c.code for c in rep.failures}
        self.assertIn("finite", codes)
        self.assertIn("spec_match", codes)


class EnsembleTruncationScenarioTest(unittest.TestCase):
    """music_worker.run_roformer_ensemble 의 조용한 min-length/min-channel 절단
    (현재 line 86-88) 이 이 코어로는 명시적 실패가 됨을 합성 데이터로 재현."""

    def test_two_model_length_mismatch_surfaces_as_fail(self):
        a = _tone(440, 8000, 0.20, ch=2, amp=0.2)   # 모델 A 출력
        b = _tone(440, 8000, 0.205, ch=2, amp=0.2)  # 모델 B 출력 (길이 다름)
        specs = [msi.describe_audio(a, 8000), msi.describe_audio(b, 8000)]
        r = msi.check_spec_match(specs, labels=["A", "B"])
        self.assertEqual(r.verdict, msi.Verdict.FAIL)

    def test_two_model_channel_mismatch_surfaces_as_fail(self):
        a = _tone(440, 8000, 0.20, ch=2)
        b = _tone(440, 8000, 0.20, ch=1)
        specs = [msi.describe_audio(a, 8000), msi.describe_audio(b, 8000)]
        r = msi.check_spec_match(specs, labels=["A", "B"])
        self.assertEqual(r.verdict, msi.Verdict.FAIL)


if __name__ == "__main__":
    unittest.main(verbosity=2)
