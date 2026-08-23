# -*- coding: utf-8 -*-
"""music_worker.run_roformer_ensemble 의 '조용한 절단' 특성화(characterization) 테스트.

목적: 현재 production 동작(python/music_worker.py:86-88)이 두 모델 출력을
  n  = min(wa.shape[-1], wb.shape[-1])   # 샘플 길이
  ch = min(wa.shape[0],  wb.shape[0])    # 채널 수
  mixed = (wa[:ch, :n] + wb[:ch, :n]) / 2.0
로 **조용히 잘라** 평균한다는 사실을, 합성 numpy 배열만으로 재현·고정한다.

이 파일은 production 을 import 하지 않는다 — line 86-88 의 수식을 그대로 옮겨
(`_current_ensemble_truncate`) 현재 계약을 문서화하고, 배선 이후에도
정합 입력에서는 이 결과가 바이트 동일하게 유지돼야 함을 명시한다.

채널 우선 `(C, N)` 규약 (audio_utils.load_audio 와 동일). 실제 오디오·모델·GPU 없음.

실행:
  python python/test_music_worker_truncation_repro.py
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import music_separation_integrity as msi  # noqa: E402


def _current_ensemble_truncate(wa: np.ndarray, wb: np.ndarray) -> np.ndarray:
    """music_worker.py:86-88 현행 수식 재현 (특성화용, production 미변경).

    n  = min(wa.shape[-1], wb.shape[-1])
    ch = min(wa.shape[0],  wb.shape[0])
    return (wa[:ch, :n] + wb[:ch, :n]) / 2.0
    """
    n = min(wa.shape[-1], wb.shape[-1])
    ch = min(wa.shape[0], wb.shape[0])
    return (wa[:ch, :n] + wb[:ch, :n]) / 2.0


def _tone(freq, sr, dur, ch=2, amp=0.3, phase=0.0):
    n = int(sr * dur)
    t = np.arange(n) / sr
    sig = (amp * np.sin(2 * np.pi * freq * t + phase)).astype(np.float32)
    return np.tile(sig, (ch, 1))


class SilentLengthTruncationTest(unittest.TestCase):
    """길이가 다른 두 출력에서 긴 쪽 꼬리가 조용히 버려짐을 재현."""

    def test_output_length_collapses_to_min_no_error(self):
        a = _tone(440, 8000, 0.20, ch=2, amp=0.2)   # 1600 샘플
        b = _tone(440, 8000, 0.25, ch=2, amp=0.2)   # 2000 샘플
        mixed = _current_ensemble_truncate(a, b)
        # 현행: 오류 없이 짧은 쪽 길이로 붕괴
        self.assertEqual(mixed.shape[1], 1600)
        # b 의 마지막 400 샘플(0.05초)은 출력에서 완전히 사라진다
        self.assertEqual(b.shape[1] - mixed.shape[1], 400)

    def test_dropped_tail_is_nonzero_signal_lost_silently(self):
        # 긴 쪽에만 존재하는 꼬리가 무음이 아님을 확인 → 실제 신호가 유실됨
        a = _tone(440, 8000, 0.20, ch=2, amp=0.2)
        b = _tone(440, 8000, 0.25, ch=2, amp=0.2)
        n = min(a.shape[-1], b.shape[-1])
        dropped = b[:, n:]
        self.assertGreater(dropped.shape[1], 0)
        self.assertGreater(float(np.max(np.abs(dropped))), 0.0)


class SilentChannelTruncationTest(unittest.TestCase):
    """채널 수가 다르면 여분 채널이 조용히 버려짐을 재현."""

    def test_stereo_plus_mono_collapses_to_mono_no_error(self):
        a = _tone(440, 8000, 0.20, ch=2, amp=0.2)   # 스테레오
        b = _tone(440, 8000, 0.20, ch=1, amp=0.2)   # 모노
        mixed = _current_ensemble_truncate(a, b)
        # 현행: 오류 없이 채널 1개로 붕괴 (a 의 두 번째 채널은 평균에 반영되지 않음)
        self.assertEqual(mixed.shape[0], 1)


class MatchedInputBaselineTest(unittest.TestCase):
    """정합 입력에서는 현행 절단 수식이 순수 0.5/0.5 평균과 바이트 동일 —
    배선 이후에도 반드시 보존돼야 하는 '무해 배선' 기준선."""

    def test_matched_equals_plain_half_half_average(self):
        a = _tone(440, 8000, 0.20, ch=2, amp=0.2)
        b = _tone(330, 8000, 0.20, ch=2, amp=0.2, phase=0.7)
        current = _current_ensemble_truncate(a, b)
        plain = (a + b) / 2.0
        self.assertEqual(current.shape, plain.shape)
        # 바이트 동일 (정합 입력에서는 min-slice 가 no-op)
        self.assertTrue(np.array_equal(current, plain))


class CoreSurfacesWhatCurrentHidesTest(unittest.TestCase):
    """같은 불일치 입력을 무결성 코어에 넣으면 조용한 절단 대신 FAIL 로 드러남."""

    def test_length_mismatch_is_fail_in_core(self):
        a = _tone(440, 8000, 0.20, ch=2, amp=0.2)
        b = _tone(440, 8000, 0.25, ch=2, amp=0.2)
        specs = [msi.describe_audio(a, 8000), msi.describe_audio(b, 8000)]
        r = msi.check_spec_match(specs, labels=["A", "B"])
        self.assertEqual(r.verdict, msi.Verdict.FAIL)
        self.assertIn("length", r.message)

    def test_channel_mismatch_is_fail_in_core(self):
        a = _tone(440, 8000, 0.20, ch=2, amp=0.2)
        b = _tone(440, 8000, 0.20, ch=1, amp=0.2)
        specs = [msi.describe_audio(a, 8000), msi.describe_audio(b, 8000)]
        r = msi.check_spec_match(specs, labels=["A", "B"])
        self.assertEqual(r.verdict, msi.Verdict.FAIL)


if __name__ == "__main__":
    unittest.main(verbosity=2)
