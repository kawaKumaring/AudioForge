# -*- coding: utf-8 -*-
"""P1 앙상블 배선 계약 — synthetic 재현 테스트 (test-only, production 미배선).

이 테스트는 music_worker 를 **수정하지 않는다**. 대신 향후 배선이 반드시 지켜야 할
계약을, 순수 P1 모듈(music_quality_p1)로 앙상블 결합 경로를 재현해 못 박는다.

재현 대상: music_worker.run_roformer_ensemble 의 P0 게이트 통과 직후 결합부
    baseline(현행): mixed = (wa + wb) / 2.0        # music_worker.py:116
    candidate(P1) : a2,b2,dec = align_pair(wa, wb)
                    cand      = weighted_ensemble([a2, b2])   # 등가중 = 0.5/0.5

계약:
  C1. P0 게이트가 보장하는 정합(등형상·in-phase·offset 0) 입력에서
      align_pair 는 no-op(applied=False), weighted_ensemble 는 현행 평균과
      수치 동일(float64) — 배선해도 값이 안 바뀐다(무변성).
  C2. float32 로 되돌리면 현행 baseline float32 평균과 바이트 동일 —
      기본 write 경로를 바꾸지 않고도 후보를 계산할 수 있다(shadow 가능).
  C3. offset 이 있으면 align_pair.applied=True 이고 정렬 후 상관이 개선(gate 통과),
      후보가 naive 평균과 달라진다 — '개선 탐지 시에만' 규칙.
  C4. 역위상이면 naive 평균은 상쇄(에너지 급감)되지만 P1 후보는 상쇄되지 않는다.
  C5. mixture_consistency_correct 는 이미 정합된 스템에 no-op(applied=False) —
      기본 자동 적용 금지(opt-in) 의 수치 근거.

실행: python python/test_music_p1_wiring_contract.py
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import music_quality_p1 as q  # noqa: E402


def _tone(freq=440, sr=8000, dur=0.25, ch=2, amp=0.2, phase=0.0):
    n = int(sr * dur)
    t = np.arange(n) / sr
    sig = (amp * np.sin(2 * np.pi * freq * t + phase)).astype(np.float32)
    return np.tile(sig, (ch, 1))


def _baseline_avg(wa, wb):
    """music_worker.py:116 현행 결합(등형상 전제)."""
    n = min(wa.shape[-1], wb.shape[-1])
    ch = min(wa.shape[0], wb.shape[0])
    return (wa[:ch, :n] + wb[:ch, :n]) / 2.0


class MatchedInvarianceTest(unittest.TestCase):
    """C1/C2 — 정합 입력에서 배선이 값을 바꾸지 않는다."""

    def test_align_is_noop_and_ensemble_equals_baseline_float64(self):
        wa = _tone(440)
        wb = _tone(440, phase=0.0)  # 완전 동일 위상
        a2, b2, dec = q.align_pair(wa, wb)
        self.assertFalse(dec.applied, "정합 입력은 align no-op 이어야 함")
        self.assertEqual(dec.offset, 0)
        self.assertEqual(dec.polarity, 1)
        cand = q.weighted_ensemble([a2, b2])            # 등가중 = 0.5/0.5
        base = _baseline_avg(wa, wb).astype(np.float64)
        self.assertEqual(cand.shape, base.shape)
        self.assertTrue(np.allclose(cand, base, atol=0.0, rtol=0.0))

    def test_candidate_cast_to_float32_matches_baseline_bytes(self):
        # 살짝 다른 위상의 두 톤(현실적 앙상블 쌍). offset 0, in-phase 유지.
        wa = _tone(440, phase=0.0)
        wb = _tone(440, phase=0.05)
        a2, b2, dec = q.align_pair(wa, wb)
        self.assertFalse(dec.applied)
        cand = q.weighted_ensemble([a2, b2]).astype(np.float32)
        base = _baseline_avg(wa, wb).astype(np.float32)
        # float32 로 되돌린 후보 == 현행 baseline 바이트 동일
        self.assertEqual(cand.dtype, base.dtype)
        self.assertTrue(np.array_equal(cand, base))


class OffsetImprovementTest(unittest.TestCase):
    """C3 — offset 이 있을 때만 적용, 상관 개선."""

    def test_offset_triggers_apply_and_changes_candidate(self):
        sr = 8000
        wa = _tone(300, sr=sr, dur=0.5, phase=0.0)
        # b 를 12 샘플 지연(뒤처짐): 앞을 잘라 앞당김이 필요한 상황
        shift = 12
        base_b = _tone(300, sr=sr, dur=0.5, phase=0.0)
        wb = np.zeros_like(base_b)
        wb[:, shift:] = base_b[:, :-shift]
        a2, b2, dec = q.align_pair(wa, wb, max_lag=64)
        self.assertTrue(dec.applied, "offset 있으면 적용되어야 함")
        self.assertNotEqual(dec.offset, 0)
        self.assertGreater(dec.corr_aligned, dec.corr_raw,
                           "정렬 후 상관이 개선되어야 게이트 통과")
        cand = q.weighted_ensemble([a2, b2])
        naive = _baseline_avg(wa, wb).astype(np.float64)
        # 정렬 후보는 naive 평균과 형상 or 값이 다르다(정렬로 겹침 구간이 달라짐)
        differs = (cand.shape != naive.shape) or (not np.allclose(cand, naive[:, :cand.shape[-1]]))
        self.assertTrue(differs, "offset 정렬 후보는 naive 평균과 달라야 함")


class PolarityCancellationTest(unittest.TestCase):
    """C4 — 역위상에서 naive 평균은 상쇄, P1 후보는 보존."""

    def test_naive_cancels_but_p1_preserves_energy(self):
        wa = _tone(440, phase=0.0)
        wb = -_tone(440, phase=0.0)  # 완전 역위상
        naive = _baseline_avg(wa, wb).astype(np.float64)
        a2, b2, dec = q.align_pair(wa, wb)
        self.assertTrue(dec.applied)
        self.assertEqual(dec.polarity, -1)
        cand = q.weighted_ensemble([a2, b2])
        naive_rms = float(np.sqrt(np.mean(naive ** 2)))
        cand_rms = float(np.sqrt(np.mean(cand ** 2)))
        self.assertLess(naive_rms, 1e-6, "naive 평균은 역위상에서 상쇄")
        self.assertGreater(cand_rms, 0.1, "P1 후보는 극성 보정으로 에너지 보존")


class MixtureCorrectionOptInTest(unittest.TestCase):
    """C5 — mixture 보정은 정합 입력에 no-op(기본 미적용의 근거)."""

    def test_consistent_stems_noop(self):
        vocals = _tone(440, phase=0.0)
        instrumental = _tone(110, phase=0.3)
        mixture = vocals + instrumental  # 정확히 정합
        corrected, dec = q.mixture_consistency_correct(mixture, [vocals, instrumental])
        self.assertFalse(dec.applied, "이미 정합이면 no-op")
        self.assertTrue(np.array_equal(corrected[0], vocals.astype(np.float64)))
        self.assertTrue(np.array_equal(corrected[1], instrumental.astype(np.float64)))


class RequireEqualContractTest(unittest.TestCase):
    """weighted_ensemble 는 정렬 없이 어긋난 형상을 받으면 QualityError 로 승격.
    → 배선 순서(align_pair 선행)가 계약임을 못 박는다."""

    def test_unequal_frames_raise(self):
        a = _tone(440, dur=0.20)
        b = _tone(440, dur=0.25)
        with self.assertRaises(q.QualityError):
            q.weighted_ensemble([a, b])  # 정렬 안 함 → 형상 불일치 승격


if __name__ == "__main__":
    unittest.main(verbosity=2)
