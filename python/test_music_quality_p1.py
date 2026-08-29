# -*- coding: utf-8 -*-
"""music_quality_p1 순수 정렬/앙상블/보정 회귀 — 합성 numpy 배열만 사용.

실제 오디오 파일·모델·GPU·외부 API 없음. 채널 우선 `(C, N)` 규약.

필수 fixture(전부 합성): 정렬됨 / ±offset / polarity 반전 / gain 차이 / stereo /
silence / transient / 길이·sr·channel 불일치 / 비유한 값.

핵심 계약:
  - 개선 없는 조건에서는 보정하지 않는다 (no-op / 무변성).
  - 스펙 불일치·비유한값은 조용히 넘어가지 않고 QualityError 로 승격.

실행:
  python python/test_music_quality_p1.py
  python -m unittest discover -s python -p "test_music_quality_p1.py"
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import music_quality_p1 as mq  # noqa: E402


# ---------------------------------------------------------------------------
# 합성 fixture 생성기 (결정적)
# ---------------------------------------------------------------------------

SR = 8000


def tone(freq, sr=SR, dur=0.25, ch=2, amp=0.3, phase=0.0):
    """결정적 정현파 `(ch, N)` float32."""
    n = int(sr * dur)
    t = np.arange(n) / sr
    sig = (amp * np.sin(2 * np.pi * freq * t + phase)).astype(np.float32)
    return np.tile(sig, (ch, 1))


def noise(n, ch=1, seed=0, amp=0.2):
    """결정적 백색잡음 `(ch, N)` — offset 검출 fixture 용 (넓은 대역)."""
    rs = np.random.RandomState(seed)
    base = (rs.randn(n) * amp).astype(np.float32)
    return np.tile(base, (ch, 1))


def shifted(base, k):
    """base 를 +k 샘플 지연시킨 사본 (앞을 0 패딩). 규약상 offset=+k 를 만든다."""
    out = np.zeros_like(base)
    if k > 0:
        out[:, k:] = base[:, :-k]
    elif k < 0:
        out[:, :k] = base[:, -k:]
    else:
        out[:] = base
    return out


def silence(n=2000, ch=2):
    return np.zeros((ch, n), dtype=np.float32)


def transient(n=2000, ch=2, pos=500, amp=0.8):
    """단일 클릭(임펄스) — transient fixture."""
    a = np.zeros((ch, n), dtype=np.float32)
    a[:, pos] = amp
    return a


# ===========================================================================
# 추정 (offset / polarity / gain) + P0 코어 교차검증
# ===========================================================================

class EstimationTest(unittest.TestCase):
    def test_offset_positive_detected(self):
        base = noise(SR, seed=1)
        b = shifted(base, 20)
        self.assertEqual(mq.estimate_offset(base, b), 20)

    def test_offset_negative_detected(self):
        base = noise(SR, seed=2)
        b = shifted(base, -15)
        self.assertEqual(mq.estimate_offset(base, b), -15)

    def test_polarity(self):
        a = tone(300)
        self.assertEqual(mq.estimate_polarity(a, a.copy()), 1)
        self.assertEqual(mq.estimate_polarity(a, -a), -1)

    def test_gain(self):
        a = tone(300, amp=0.4)
        b = tone(300, amp=0.2)
        self.assertAlmostEqual(mq.estimate_gain(a, b), 2.0, places=3)
        self.assertEqual(mq.estimate_gain(a, silence(a.shape[1], a.shape[0])), 0.0)

    def test_crossvalidate_with_p0_core(self):
        """P0 코어(music_separation_integrity)와 부호·값 규약이 일치하는지 (반증)."""
        try:
            import music_separation_integrity as msi
        except Exception:  # noqa: BLE001
            self.skipTest("P0 코어 없음")
        base = noise(SR, seed=7)
        b = shifted(base, 33)
        self.assertEqual(mq.estimate_offset(base, b), msi.estimate_offset(base, b))
        a = tone(220)
        self.assertEqual(mq.estimate_polarity(a, -a), msi.estimate_polarity(a, -a))
        self.assertAlmostEqual(mq.estimate_gain(a, a * 0.5),
                               msi.estimate_gain(a, a * 0.5), places=6)


# ===========================================================================
# 정렬 보정 (align_pair) — 개선 있을 때만 적용, 아니면 no-op
# ===========================================================================

class AlignPairTest(unittest.TestCase):
    def test_aligned_input_is_noop_invariance(self):
        """정렬·동상 입력 → 보정이 출력을 바꾸지 않는다 (무변성)."""
        a = tone(300, phase=0.3)
        b = a.copy()
        a_out, b_out, dec = mq.align_pair(a, b)
        self.assertFalse(dec.applied)
        self.assertTrue(mq.is_noop(a, a_out))
        self.assertTrue(mq.is_noop(b, b_out))

    def test_polarity_inversion_corrected(self):
        a = tone(300)
        a_out, b_out, dec = mq.align_pair(a, -a)
        self.assertTrue(dec.applied)
        self.assertEqual(dec.polarity, -1)
        # 보정 후 b 는 a 와 동상이 되어 앙상블 상쇄가 사라진다.
        self.assertTrue(mq.is_noop(a_out, b_out, atol=1e-9))

    def test_offset_corrected_raises_correlation(self):
        base = noise(SR, seed=3)
        b = shifted(base, 40)
        pre = mq.measure_pair(base, b, max_lag=512)
        a_out, b_out, dec = mq.align_pair(base, b, max_lag=512)
        self.assertTrue(dec.applied)
        self.assertEqual(dec.offset, 40)
        post = mq._normalized_correlation(
            mq._to_mono(a_out) - mq._to_mono(a_out).mean(),
            mq._to_mono(b_out) - mq._to_mono(b_out).mean())
        self.assertGreater(post, pre.correlation - 1e-9)
        self.assertGreater(post, 0.99)

    def test_negative_offset_corrected(self):
        base = noise(SR, seed=4)
        b = shifted(base, -25)
        a_out, b_out, dec = mq.align_pair(base, b, max_lag=512)
        self.assertTrue(dec.applied)
        self.assertEqual(dec.offset, -25)
        self.assertEqual(a_out.shape, b_out.shape)

    def test_silence_is_noop(self):
        """무음 입력 → 개선할 것이 없으므로 no-op."""
        s = silence()
        a_out, b_out, dec = mq.align_pair(s, s.copy())
        self.assertFalse(dec.applied)
        self.assertTrue(mq.is_noop(s, b_out))

    def test_gain_match_optional_and_gated(self):
        a = tone(300, amp=0.3)
        b = tone(300, amp=0.06)  # gain_ratio ≈ 5 → 밴드 밖
        # 기본(match_gain=False): gain 스케일 안 함
        _, b_off, dec_off = mq.align_pair(a, b, match_gain=False)
        self.assertNotIn("gain", " ".join(dec_off.reasons))
        # match_gain=True: b 를 a 레벨로 스케일
        _, b_on, dec_on = mq.align_pair(a, b, match_gain=True)
        self.assertTrue(any("gain" in r for r in dec_on.reasons))
        self.assertAlmostEqual(mq._rms(mq._to_mono(b_on)),
                               mq._rms(mq._to_mono(a)), places=3)

    def test_non_finite_raises(self):
        a = tone(300)
        b = a.copy()
        b[0, 5] = np.nan
        with self.assertRaises(mq.QualityError):
            mq.align_pair(a, b)

    def test_channel_mismatch_raises(self):
        a = tone(300, ch=2)
        b = tone(300, ch=1)
        with self.assertRaises(mq.QualityError):
            mq.align_pair(a, b)

    def test_transient_alignment(self):
        a = transient(pos=500)
        b = transient(pos=540)  # +40 지연
        a_out, b_out, dec = mq.align_pair(a, b, max_lag=256)
        self.assertTrue(dec.applied)
        self.assertEqual(dec.offset, 40)


# ===========================================================================
# 가중 앙상블 (weighted_ensemble)
# ===========================================================================

class WeightedEnsembleTest(unittest.TestCase):
    def test_equal_weights_matches_half_half(self):
        """등가중 = 현행 0.5/0.5 평균과 동일."""
        a = tone(440, amp=0.2)
        b = tone(110, amp=0.2, phase=1.1)
        out = mq.weighted_ensemble([a, b])
        ref = (a.astype(np.float64) + b.astype(np.float64)) / 2.0
        self.assertTrue(np.allclose(out, ref, atol=1e-12))

    def test_identical_stems_invariance(self):
        """동일 스템 등가중 결합 → 결과는 그 스템과 정확히 동일 (무변성)."""
        a = tone(440, amp=0.25)
        out = mq.weighted_ensemble([a, a.copy(), a.copy()])
        self.assertTrue(np.allclose(out, a.astype(np.float64), atol=1e-12))

    def test_weights_normalized(self):
        a = tone(440, amp=0.2)
        b = tone(440, amp=0.2)
        out = mq.weighted_ensemble([a, b], weights=[3.0, 1.0])
        ref = 0.75 * a.astype(np.float64) + 0.25 * b.astype(np.float64)
        self.assertTrue(np.allclose(out, ref, atol=1e-12))

    def test_stereo_preserved(self):
        a = tone(440, ch=2, amp=0.2)
        b = tone(440, ch=2, amp=0.2)
        out = mq.weighted_ensemble([a, b])
        self.assertEqual(out.shape, (2, a.shape[1]))

    def test_shape_mismatch_raises_no_silent_truncate(self):
        a = tone(440, dur=0.20)
        b = tone(440, dur=0.21)  # 길이 다름
        with self.assertRaises(mq.QualityError):
            mq.weighted_ensemble([a, b])

    def test_channel_mismatch_raises(self):
        with self.assertRaises(mq.QualityError):
            mq.weighted_ensemble([tone(440, ch=2), tone(440, ch=1)])

    def test_non_finite_raises(self):
        a = tone(440)
        b = a.copy()
        b[0, 0] = np.inf
        with self.assertRaises(mq.QualityError):
            mq.weighted_ensemble([a, b])

    def test_negative_weight_raises(self):
        a = tone(440)
        with self.assertRaises(mq.QualityError):
            mq.weighted_ensemble([a, a.copy()], weights=[-1.0, 2.0])

    def test_polarity_aligned_then_ensembled_recovers_signal(self):
        """역위상 두 출력을 정렬 후 결합하면 상쇄 없이 신호가 보존된다."""
        a = tone(300, amp=0.3)
        b = -a  # 역위상
        naive = mq.weighted_ensemble([a, b])           # 상쇄 → ~0
        a2, b2, dec = mq.align_pair(a, b)
        corrected = mq.weighted_ensemble([a2, b2])      # 정렬 후 → 신호 유지
        self.assertLess(mq._rms(naive), 1e-6)
        self.assertGreater(mq._rms(corrected), 0.1)
        self.assertTrue(dec.applied)


# ===========================================================================
# mixture consistency 보정
# ===========================================================================

class MixtureCorrectionTest(unittest.TestCase):
    def test_consistent_input_is_noop_invariance(self):
        """이미 Σstems==mixture 이면 보정 no-op — 스템이 바뀌지 않는다 (무변성)."""
        v = tone(440, amp=0.2)
        i = tone(110, amp=0.2, phase=0.7)
        mixture = v + i
        corrected, dec = mq.mixture_consistency_correct(mixture, [v, i])
        self.assertFalse(dec.applied)
        self.assertTrue(mq.is_noop(v, corrected[0]))
        self.assertTrue(mq.is_noop(i, corrected[1]))

    def test_energy_mode_restores_reconstruction(self):
        v = tone(440, amp=0.2)
        i = tone(110, amp=0.2)
        mixture = v + i
        bad = i * 0.3  # 스템 하나가 크게 어긋남 → 재구성 오차 큼
        before = mq.measure_reconstruction(mixture, [v, bad])
        self.assertGreater(before.relative_error, 1e-3)
        corrected, dec = mq.mixture_consistency_correct(mixture, [v, bad], mode="energy")
        self.assertTrue(dec.applied)
        after = mq.measure_reconstruction(mixture, corrected)
        self.assertLess(after.relative_error, 1e-9)  # Σ== mixture

    def test_equal_mode_restores_reconstruction(self):
        v = tone(440, amp=0.2)
        i = tone(110, amp=0.2)
        mixture = v + i
        bad = i * 0.5
        corrected, dec = mq.mixture_consistency_correct(mixture, [v, bad], mode="equal")
        self.assertTrue(dec.applied)
        after = mq.measure_reconstruction(mixture, corrected)
        self.assertLess(after.relative_error, 1e-9)

    def test_silence_mixture_is_noop(self):
        s = silence()
        corrected, dec = mq.mixture_consistency_correct(s, [s.copy(), s.copy()])
        self.assertFalse(dec.applied)
        self.assertTrue(mq.is_noop(s, corrected[0]))

    def test_shape_mismatch_raises(self):
        mixture = tone(440, dur=0.20)
        short = tone(440, dur=0.19)
        with self.assertRaises(mq.QualityError):
            mq.mixture_consistency_correct(mixture, [short])

    def test_non_finite_raises(self):
        mixture = tone(440)
        bad = mixture.copy()
        bad[0, 0] = np.nan
        with self.assertRaises(mq.QualityError):
            mq.mixture_consistency_correct(mixture, [bad])

    def test_unknown_mode_raises(self):
        # 재구성 오차가 커서 no-op 게이트를 통과해 mode 분기에 도달해야 raise 가 뜬다.
        v = tone(440, amp=0.2)
        i = tone(110, amp=0.2)
        mixture = v + i
        with self.assertRaises(mq.QualityError):
            mq.mixture_consistency_correct(mixture, [v, i * 0.3], mode="bogus")


# ===========================================================================
# 반증 harness — "개선 없는 조건에서 보정하지 않는다" 를 정면으로 반증 시도
# ===========================================================================

class FalsificationHarnessTest(unittest.TestCase):
    """각 보정 함수에 대해 '개선이 없는 입력'을 넣고 no-op(무변성)을 강제 검증.
    보정이 스스로 무익하게 출력을 바꾸면 이 테스트가 실패해 반증한다."""

    def test_align_noop_across_fixtures(self):
        fixtures = {
            "aligned_mono": (tone(300, ch=1), None),
            "aligned_stereo": (tone(300, ch=2, phase=0.5), None),
            "silence": (silence(), None),
            "transient_same": (transient(), None),
        }
        for name, (a, _) in fixtures.items():
            b = a.copy()
            a_out, b_out, dec = mq.align_pair(a, b, max_lag=256)
            with self.subTest(fixture=name):
                self.assertFalse(dec.applied, f"{name}: 개선 없는데 보정됨")
                self.assertTrue(mq.is_noop(b, b_out), f"{name}: no-op 위반")

    def test_ensemble_identity_across_fixtures(self):
        for name, a in {
            "tone": tone(440, amp=0.25),
            "stereo": tone(440, ch=2, amp=0.25),
            "silence": silence(),
            "transient": transient(),
        }.items():
            out = mq.weighted_ensemble([a, a.copy()])
            with self.subTest(fixture=name):
                self.assertTrue(np.allclose(out, a.astype(np.float64), atol=1e-12),
                                f"{name}: 동일 스템 결합이 변형됨")

    def test_mixture_noop_when_already_consistent(self):
        v = tone(440, amp=0.2)
        i = tone(110, amp=0.2, phase=0.4)
        mixture = v + i
        corrected, dec = mq.mixture_consistency_correct(mixture, [v, i])
        self.assertFalse(dec.applied)
        for s, c in zip([v, i], corrected):
            self.assertTrue(mq.is_noop(s, c))

    def test_compare_quality_shows_alignment_gain(self):
        """정렬 보정이 실제로 alignment_error 를 낮췄음을 harness 로 수치 확인."""
        base = noise(SR, seed=9)
        b = shifted(base, 30)
        before = mq.measure_pair(base, b, max_lag=512)  # corr_aligned 는 이미 정렬 후
        # 원신호(보정 전) 상관은 낮고, 정렬 후 상관은 높다.
        raw_corr = mq._normalized_correlation(
            mq._to_mono(base) - mq._to_mono(base).mean(),
            mq._to_mono(b) - mq._to_mono(b).mean())
        self.assertLess(raw_corr, before.correlation)
        self.assertLess(before.alignment_error, 1.0 - raw_corr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
