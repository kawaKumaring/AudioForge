# -*- coding: utf-8 -*-
"""참조 대사 혼입 검출 회귀 — 합성 신호로만 검증(GPU·모델·실제 음성 불필요).

핵심은 '인위적으로 섞은 참조 조각을 반드시 잡는가' 다. 검출기가 조용히 무력화되면
기존 검사와 똑같은 위음성(혼입이 있는데 없다고 판정)으로 되돌아간다.
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reference_leakage as rl  # noqa: E402
import reference_region as rr   # noqa: E402

SR = 24000


def _speechlike(sec, f0, seed):
    """유성음 비슷한 신호 — 기본 주파수 + 배음 + 약한 잡음. 화자 유사성을 흉내내되 내용은 다르다."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(sec * SR)) / SR
    sig = np.zeros_like(t)
    for k, a in enumerate((1.0, 0.5, 0.25, 0.12), start=1):
        sig += a * np.sin(2 * np.pi * f0 * k * t + rng.uniform(0, 2 * np.pi))
    env = 0.5 + 0.5 * np.sin(2 * np.pi * rng.uniform(2.5, 4.5) * t)
    sig = sig * env + 0.02 * rng.standard_normal(t.size)
    return (0.3 * sig / max(float(np.abs(sig).max()), 1e-9)).astype(np.float64)


class WaveformCopyScanTest(unittest.TestCase):
    """검출기 2 — 파형이 그대로 복사된 경우(ASR 로는 절대 안 잡히는 종류)."""

    def setUp(self):
        self.ref = _speechlike(9.0, 190.0, seed=11)
        self.clean = _speechlike(4.8, 205.0, seed=22)   # 같은 성격·다른 내용 = 정상 출력

    def test_clean_output_is_not_flagged(self):
        r = rl.waveform_copy_scan(self.clean, self.ref, SR)
        self.assertFalse(r["copy_detected"], r["peak_ncc"])
        self.assertLess(r["peak_ncc"], rl.COPY_NCC_THRESHOLD)
        self.assertGreater(r["scanned_windows"], 0)

    def test_synthetic_contamination_is_caught(self):
        """참조 파형 0.8초를 생성 신호 앞에 이어 붙인 합성 혼입 — 반드시 잡아야 한다."""
        frag = self.ref[int(2.0 * SR):int(2.8 * SR)]
        mixed = np.concatenate([frag, self.clean])
        r = rl.waveform_copy_scan(mixed, self.ref, SR)
        self.assertTrue(r["copy_detected"], r)
        self.assertGreaterEqual(r["peak_ncc"], 0.99)
        self.assertLess(r["peak_out_sec"], 0.5)          # 히트는 머리 쪽
        # 조각이 0.8초라 완전히 겹치는 창이 여럿이고 전부 NCC 1.0 이다(어느 창이 최대인지는
        # 부동소수 오차가 정한다). 고정할 불변식은 '어느 창이 이겼든 지연이 조각의 출처를
        # 정확히 가리킨다' — 생성 위치 + 2.0s = 참조 위치.
        self.assertAlmostEqual(r["peak_ref_sec"] - r["peak_out_sec"], 2.0, delta=0.02)

    def test_gain_scaled_copy_still_caught(self):
        """볼륨만 줄여 붙인 복사도 잡아야 한다 — NCC 는 진폭 배율에 불변이다."""
        frag = 0.25 * self.ref[int(5.0 * SR):int(5.8 * SR)]
        mixed = np.concatenate([self.clean[:int(1.5 * SR)], frag, self.clean[int(1.5 * SR):]])
        r = rl.waveform_copy_scan(mixed, self.ref, SR)
        self.assertTrue(r["copy_detected"], r)
        self.assertGreaterEqual(r["peak_ncc"], 0.99)

    def test_short_window_would_have_missed_nothing_but_long_window_is_specific(self):
        """창이 짧으면 같은 화자끼리 우연히 높아진다 — 500 ms 기본값의 근거를 고정한다."""
        short = rl.waveform_copy_scan(self.clean, self.ref, SR, window_ms=100.0, hop_ms=25.0)
        long_ = rl.waveform_copy_scan(self.clean, self.ref, SR, window_ms=500.0, hop_ms=100.0)
        self.assertLess(long_["peak_ncc"], short["peak_ncc"])


class ShortNgramLeakTest(unittest.TestCase):
    """검출기 3 — 4음절 이상만 보던 기존 검사의 사각지대(2~3음절)."""

    def setUp(self):
        self.ref = tuple("가나다라마바사")
        self.tgt = tuple("하호후herr"[:5])

    def test_two_syllable_leak_is_caught(self):
        asr = tuple(self.tgt) + ("마", "바")
        r = rl.short_ngram_leaks(self.ref, self.tgt, asr)
        self.assertTrue(r["leak_detected"], r)
        self.assertIn("마바", r["per_size"]["2"]["items"])

    def test_clean_output_is_not_flagged(self):
        r = rl.short_ngram_leaks(self.ref, self.tgt, self.tgt)
        self.assertFalse(r["leak_detected"], r)
        self.assertEqual(r["total"], 0)

    def test_fragment_shared_with_target_is_not_a_leak(self):
        """타깃에도 있는 조각은 정상 출력이다 — 혼입으로 세면 안 된다."""
        ref = tuple("가나다라")
        tgt = tuple("나다마")
        r = rl.short_ngram_leaks(ref, tgt, tgt)
        self.assertFalse(r["leak_detected"], r)

    def test_previous_four_gram_only_check_would_have_missed_it(self):
        """길이 4 만 보면 놓치는 조각을 2·3 은 잡는다 — 기존 위음성의 재발 방지."""
        asr = tuple(self.tgt) + ("마", "바")
        self.assertEqual(rl.short_ngram_leaks(self.ref, self.tgt, asr, sizes=(4,))["total"], 0)
        self.assertGreater(rl.short_ngram_leaks(self.ref, self.tgt, asr, sizes=(2, 3))["total"], 0)


class BoundaryTruncationTest(unittest.TestCase):
    """검출기 1 — 참조 클립이 말 도중에 끊겼는가(혼입의 원인)."""

    def test_speech_at_both_edges_is_truncated(self):
        sig = _speechlike(9.0, 190.0, seed=33)
        r = rl.boundary_truncation(sig, SR)
        self.assertTrue(r["tail_truncated"], r)
        self.assertTrue(r["head_truncated"], r)
        self.assertGreaterEqual(r["tail_dbfs"], rl.SPEECH_DBFS)

    def test_silence_padded_clip_is_not_truncated(self):
        sig = _speechlike(7.0, 190.0, seed=44)
        pad = np.zeros(int(0.4 * SR))
        r = rl.boundary_truncation(np.concatenate([pad, sig, pad]), SR)
        self.assertFalse(r["head_truncated"], r)
        self.assertFalse(r["tail_truncated"], r)

    def test_tail_only_truncation(self):
        sig = _speechlike(7.0, 190.0, seed=55)
        pad = np.zeros(int(0.4 * SR))
        r = rl.boundary_truncation(np.concatenate([pad, sig]), SR)
        self.assertFalse(r["head_truncated"], r)
        self.assertTrue(r["tail_truncated"], r)


class AnalyzeRegionWiringTest(unittest.TestCase):
    """배선 — 구간 분석이 절단을 실제로 경고로 올리는가."""

    def setUp(self):
        import tempfile
        import shutil
        self.tmp = tempfile.mkdtemp(prefix="af_leak_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def _write(self, name, sig):
        import soundfile as sf
        p = os.path.join(self.tmp, name)
        sf.write(p, sig.astype("float32"), SR)
        return p

    def test_mid_utterance_cut_is_warned(self):
        p = self._write("cut.wav", _speechlike(7.0, 190.0, seed=66))
        r = rr.analyze_region(p, 0.0, 7.0)
        self.assertTrue(r["ok"])
        self.assertTrue(r["tail_truncated"], r)
        self.assertTrue(any("말 도중" in w for w in r["warnings"]), r["warnings"])

    def test_clean_region_has_no_truncation_warning(self):
        pad = np.zeros(int(0.5 * SR))
        p = self._write("clean.wav", np.concatenate([pad, _speechlike(6.0, 190.0, seed=77), pad]))
        r = rr.analyze_region(p, 0.0, 7.0)
        self.assertTrue(r["ok"])
        self.assertFalse(r["tail_truncated"], r)
        self.assertFalse(r["head_truncated"], r)
        self.assertFalse(any("말 도중" in w for w in r["warnings"]), r["warnings"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
