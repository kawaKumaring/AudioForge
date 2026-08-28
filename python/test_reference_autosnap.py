# -*- coding: utf-8 -*-
"""자동 경계 보정 회귀 — 파형 VAD 만으로 스냅하고, 최종 클립을 전사해 검증한다.

Whisper 는 부르지 않는다(transcribe_fn 주입). 모델·GPU 불필요.
"""
import os
import shutil
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reference_region as rr   # noqa: E402

SR = 24000


def _speech(sec, f0=180.0, seed=1):
    rng = np.random.default_rng(seed)
    t = np.arange(int(sec * SR)) / SR
    x = np.zeros_like(t)
    for k, a in enumerate((1.0, 0.5, 0.25), start=1):
        x += a * np.sin(2 * np.pi * f0 * k * t + rng.uniform(0, 6.28))
    x *= 0.6 + 0.4 * np.sin(2 * np.pi * 3.0 * t)
    return (0.3 * x / max(float(np.abs(x).max()), 1e-9)).astype("float32")


def _sil(sec):
    return np.zeros(int(sec * SR), dtype="float32")


class SnapPureTest(unittest.TestCase):
    """스냅은 무음 한가운데 후보 중 요청에 가장 가까운 조합을 고른다."""

    SIL = [(0.0, 1.0), (5.0, 5.6), (9.0, 9.8), (14.0, 15.0)]

    def test_picks_nearest_within_range(self):
        got = rr.snap_region_to_silence(self.SIL, 5.2, 9.5, 3.0, 10.0)
        self.assertEqual(got, (5.3, 9.4))          # 각 무음의 한가운데

    def test_blocks_when_range_unsatisfiable(self):
        # 3~10초를 만족하는 조합이 없는 무음 배치
        self.assertIsNone(rr.snap_region_to_silence([(0.0, 0.4), (1.0, 1.4)], 0.2, 1.2, 3.0, 10.0))

    def test_never_exceeds_max_sec(self):
        got = rr.snap_region_to_silence(self.SIL, 0.0, 14.5, 3.0, 10.0)
        self.assertIsNotNone(got)
        self.assertLessEqual(got[1] - got[0], 10.0 + 1e-6)

    def test_respects_min_sec(self):
        got = rr.snap_region_to_silence(self.SIL, 5.2, 5.4, 3.0, 10.0)
        self.assertIsNotNone(got)
        self.assertGreaterEqual(got[1] - got[0], 3.0 - 1e-6)


class BuildClipTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_snap_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.out = os.path.join(self.tmp, "clip.wav")

    def _src(self, name, parts):
        p = os.path.join(self.tmp, name)
        sf.write(p, np.concatenate(parts), SR)
        return p

    def _normal(self):
        # 무음 0.8 / 말 4.0 / 무음 0.5 / 말 3.5 / 무음 0.8
        return self._src("src.wav", [_sil(0.8), _speech(4.0), _sil(0.5),
                                     _speech(3.5, 200.0, 2), _sil(0.8)])

    def test_records_requested_and_effective_region(self):
        src = self._normal()
        r = rr.build_reference_clip(src, 1.0, 7.0, self.out,
                                    transcribe_fn=lambda p: "가나다라마바사")
        self.assertTrue(r["ready"], r)
        self.assertEqual(r["requested_region"]["start_sec"], 1.0)
        self.assertEqual(r["requested_region"]["end_sec"], 8.0)
        self.assertIsNotNone(r["effective_region"])
        self.assertNotEqual(r["effective_region"], r["requested_region"])
        self.assertIn("start_shift_sec", r["snap"])

    def test_produced_clip_is_not_truncated(self):
        src = self._normal()
        r = rr.build_reference_clip(src, 1.0, 7.0, self.out,
                                    transcribe_fn=lambda p: "가나다라마바사")
        self.assertTrue(os.path.exists(r["clip_path"]))
        self.assertFalse(r["boundary"]["head_truncated"], r["boundary"])
        self.assertFalse(r["boundary"]["tail_truncated"], r["boundary"])

    def test_no_silence_blocks_and_leaves_no_clip(self):
        src = self._src("dense.wav", [_speech(12.0)])
        r = rr.build_reference_clip(src, 1.0, 7.0, self.out,
                                    transcribe_fn=lambda p: "가나다")
        self.assertFalse(r["ready"])
        self.assertIn(rr.BLOCK_NO_SAFE_BOUNDARY, r["blocking"])
        self.assertIsNone(r["clip_path"])
        self.assertFalse(os.path.exists(self.out), "차단이면 클립을 남기지 않는다")

    def test_range_unsatisfiable_blocks(self):
        src = self._src("short.wav", [_sil(0.5), _speech(1.0), _sil(0.5)])
        r = rr.build_reference_clip(src, 0.2, 1.5, self.out,
                                    transcribe_fn=lambda p: "가나다")
        self.assertFalse(r["ready"])
        self.assertIn(rr.BLOCK_SNAP_UNSATISFIABLE, r["blocking"])
        self.assertFalse(os.path.exists(self.out))

    def test_transcribe_failure_blocks(self):
        src = self._normal()
        r = rr.build_reference_clip(src, 1.0, 7.0, self.out, transcribe_fn=lambda p: None)
        self.assertFalse(r["ready"])
        self.assertIn(rr.BLOCK_TRANSCRIBE_FAILED, r["blocking"])
        self.assertFalse(os.path.exists(self.out))

    def test_manual_text_tail_mismatch_blocks(self):
        """클립에 없는 꼬리가 manual_text 에 있으면 차단 — 사고 조건 그대로."""
        src = self._normal()
        r = rr.build_reference_clip(src, 1.0, 7.0, self.out,
                                    manual_text="가나다라마바사입니다",
                                    transcribe_fn=lambda p: "가나다라마바사")
        self.assertFalse(r["ready"])
        self.assertIn(rr.BLOCK_TEXT_MISMATCH, r["blocking"])
        self.assertEqual(r["validation"]["status"], "blocked")
        self.assertIn("tail", r["validation"]["mismatch_where"])
        self.assertFalse(os.path.exists(self.out))

    def test_manual_text_aligned_passes(self):
        src = self._normal()
        r = rr.build_reference_clip(src, 1.0, 7.0, self.out,
                                    manual_text="가나다라마바사",
                                    transcribe_fn=lambda p: "가나다라마바사")
        self.assertTrue(r["ready"], r)
        self.assertEqual(r["validation"]["status"], "validated")
        self.assertEqual(r["blocking"], [])

    def test_internal_variance_is_warning_not_block(self):
        src = self._normal()
        r = rr.build_reference_clip(src, 1.0, 7.0, self.out,
                                    manual_text="가나다라마바사아자차카타파하",
                                    transcribe_fn=lambda p: "가나다라먀뱌사아자차카타파하")
        self.assertTrue(r["ready"], r)
        self.assertIn(rr.WARN_TEXT_INTERNAL_VARIANCE, r["warning_codes"])

    def test_no_manual_text_still_transcribes_clip(self):
        src = self._normal()
        seen = []
        r = rr.build_reference_clip(src, 1.0, 7.0, self.out,
                                    transcribe_fn=lambda p: seen.append(p) or "가나다")
        self.assertTrue(r["ready"])
        self.assertEqual(len(seen), 1, "최종 클립을 전사해야 한다")
        self.assertEqual(os.path.abspath(seen[0]), os.path.abspath(self.out))
        self.assertEqual(r["validation"]["status"], "no_manual_text")

    def test_validation_carries_no_transcript_text(self):
        src = self._normal()
        r = rr.build_reference_clip(src, 1.0, 7.0, self.out,
                                    manual_text="가나다라마바사",
                                    transcribe_fn=lambda p: "가나다라마바사")
        blob = repr(r)
        self.assertNotIn("가나다라마바사", blob, "전사 원문이 반환값에 새면 안 된다")

    def test_contract_shape_matches_step1(self):
        """1단계 계약 그대로 — blocking/warning_codes/ready 가 일관되어야 한다."""
        src = self._normal()
        for mt, tf in (("가나다라마바사", lambda p: "가나다라마바사"),
                       ("가나다라마바사입니다", lambda p: "가나다라마바사")):
            r = rr.build_reference_clip(src, 1.0, 7.0, self.out, manual_text=mt,
                                        transcribe_fn=tf)
            self.assertIsInstance(r["blocking"], list)
            self.assertIsInstance(r["warning_codes"], list)
            self.assertEqual(r["ready"], len(r["blocking"]) == 0)
            self.assertEqual(r["clip_path"] is None, not r["ready"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
