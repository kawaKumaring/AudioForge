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
    """스냅은 **요청 주변**의 무음 한가운데 후보만 본다. 전체 파일을 뒤지지 않는다."""

    SIL = [(0.0, 1.0), (5.0, 5.6), (9.0, 9.8), (14.0, 15.0)]

    def test_picks_nearest_within_range(self):
        got = rr.snap_region_to_silence(self.SIL, 5.2, 9.5, 3.0, 10.0)
        self.assertEqual((got["start"], got["end"]), (5.3, 9.4))
        self.assertEqual(got["status"], "auto")

    def test_does_not_jump_to_unrelated_speech(self):
        """실측 결함 재현: 요청 100~107초인데 0.5~6.5초를 돌려주던 조용한 점프."""
        got = rr.snap_region_to_silence([(0, 1), (6, 7)], 100.0, 107.0, 3.0, 10.0)
        self.assertIsNone(got, "요청에서 멀리 떨어진 구간을 자동으로 고르면 안 된다")

    def test_large_shift_requires_reconfirm(self):
        got = rr.snap_region_to_silence([(0, 1), (6, 7)], 2.5, 8.5, 3.0, 10.0)
        self.assertIsNotNone(got)
        self.assertEqual(got["status"], "reconfirm")
        self.assertGreater(got["max_shift_sec"], rr.SNAP_AUTO_SHIFT_SEC)

    def test_small_shift_is_auto(self):
        got = rr.snap_region_to_silence([(0, 1), (6, 7)], 0.45, 6.55, 3.0, 10.0)
        self.assertEqual(got["status"], "auto")
        self.assertLessEqual(got["max_shift_sec"], rr.SNAP_AUTO_SHIFT_SEC)

    def test_auto_shift_limit_is_fine_adjustment_only(self):
        """정책 고정: 자동 승인은 경계 미세조정 수준이어야 한다.

        한국어는 0.2초에도 한 음절이 들어간다 — 이보다 크게 조용히 옮기면 사용자가 고른
        구간이 아니게 된다. 실사용 조율 전의 초기 안전값이며, 조율 시 이 테스트도 갱신할 것."""
        self.assertLessEqual(rr.SNAP_AUTO_SHIFT_SEC, 0.2)

    def test_search_radius_is_not_auto_approval_range(self):
        """탐색 반경(5.0s)은 후보를 찾는 범위일 뿐 자동 승인 범위가 아니다."""
        self.assertGreater(rr.SNAP_MAX_SEARCH_SHIFT_SEC, rr.SNAP_AUTO_SHIFT_SEC)
        got = rr.snap_region_to_silence([(0, 1), (6, 7)], 1.0, 6.0, 3.0, 10.0)
        self.assertIsNotNone(got, "탐색 반경 안이면 후보는 나온다")
        self.assertEqual(got["status"], "reconfirm", "그러나 자동 승인은 아니다")

    def test_blocks_when_range_unsatisfiable(self):
        self.assertIsNone(rr.snap_region_to_silence([(0.0, 0.4), (1.0, 1.4)], 0.2, 1.2, 3.0, 10.0))

    def test_never_exceeds_max_sec(self):
        got = rr.snap_region_to_silence(self.SIL, 4.8, 14.6, 3.0, 10.0)
        if got is not None:
            self.assertLessEqual(got["end"] - got["start"], 10.0 + 1e-6)

    def test_respects_min_sec(self):
        got = rr.snap_region_to_silence(self.SIL, 5.2, 5.4, 3.0, 10.0)
        if got is not None:
            self.assertGreaterEqual(got["end"] - got["start"], 3.0 - 1e-6)

    def test_search_window_is_bounded_by_policy(self):
        """탐색 반경 밖 후보는 아예 보지 않는다(정책값으로 확인)."""
        far = rr.SNAP_MAX_SEARCH_SHIFT_SEC + 5.0
        self.assertIsNone(
            rr.snap_region_to_silence([(0, 1), (6, 7)], far, far + 6.0, 3.0, 10.0))


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
        r = rr.build_reference_clip(src, 0.4, 8.8, self.out,
                                    transcribe_fn=lambda p: "가나다라마바사")
        self.assertTrue(r["ready"], r)
        self.assertEqual(r["requested_region"]["start_sec"], 0.4)
        self.assertEqual(r["requested_region"]["end_sec"], 9.2)
        self.assertIsNotNone(r["effective_region"])
        self.assertIn("start_shift_sec", r["snap"])
        self.assertIn("end_shift_sec", r["snap"])
        # 두 값이 같더라도 **둘 다 기록**되는 것이 계약이다(재현 권위는 effective).
        self.assertIn("start_sec", r["requested_region"])
        self.assertIn("start_sec", r["effective_region"])

    def test_produced_clip_is_not_truncated(self):
        src = self._normal()
        r = rr.build_reference_clip(src, 0.4, 8.8, self.out,
                                    transcribe_fn=lambda p: "가나다라마바사")
        self.assertTrue(os.path.exists(r["clip_path"]))
        self.assertFalse(r["boundary"]["head_truncated"], r["boundary"])
        self.assertFalse(r["boundary"]["tail_truncated"], r["boundary"])

    def test_no_silence_blocks_and_leaves_no_clip(self):
        src = self._src("dense.wav", [_speech(12.0)])
        r = rr.build_reference_clip(src, 0.4, 8.8, self.out,
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
        r = rr.build_reference_clip(src, 0.4, 8.8, self.out, transcribe_fn=lambda p: None)
        self.assertFalse(r["ready"])
        self.assertIn(rr.BLOCK_TRANSCRIBE_FAILED, r["blocking"])
        self.assertFalse(os.path.exists(self.out))

    def test_manual_text_tail_mismatch_blocks(self):
        """클립에 없는 꼬리가 manual_text 에 있으면 차단 — 사고 조건 그대로."""
        src = self._normal()
        r = rr.build_reference_clip(src, 0.4, 8.8, self.out,
                                    manual_text="가나다라마바사입니다",
                                    transcribe_fn=lambda p: "가나다라마바사")
        self.assertFalse(r["ready"])
        self.assertIn(rr.BLOCK_TEXT_MISMATCH, r["blocking"])
        self.assertEqual(r["validation"]["status"], "blocked")
        self.assertIn("tail", r["validation"]["mismatch_where"])
        self.assertFalse(os.path.exists(self.out))

    def test_manual_text_aligned_passes(self):
        src = self._normal()
        r = rr.build_reference_clip(src, 0.4, 8.8, self.out,
                                    manual_text="가나다라마바사",
                                    transcribe_fn=lambda p: "가나다라마바사")
        self.assertTrue(r["ready"], r)
        self.assertEqual(r["validation"]["status"], "validated")
        self.assertEqual(r["blocking"], [])

    def test_internal_variance_is_warning_not_block(self):
        src = self._normal()
        r = rr.build_reference_clip(src, 0.4, 8.8, self.out,
                                    manual_text="가나다라마바사아자차카타파하",
                                    transcribe_fn=lambda p: "가나다라먀뱌사아자차카타파하")
        self.assertTrue(r["ready"], r)
        self.assertIn(rr.WARN_TEXT_INTERNAL_VARIANCE, r["warning_codes"])

    def test_no_manual_text_still_transcribes_clip(self):
        src = self._normal()
        seen = []
        r = rr.build_reference_clip(src, 0.4, 8.8, self.out,
                                    transcribe_fn=lambda p: seen.append(p) or "가나다")
        self.assertTrue(r["ready"])
        self.assertEqual(len(seen), 1, "최종 클립을 전사해야 한다")
        self.assertEqual(os.path.abspath(seen[0]), os.path.abspath(self.out))
        self.assertEqual(r["validation"]["status"], "no_manual_text")

    def test_validation_carries_no_transcript_text(self):
        src = self._normal()
        r = rr.build_reference_clip(src, 0.4, 8.8, self.out,
                                    manual_text="가나다라마바사",
                                    transcribe_fn=lambda p: "가나다라마바사")
        blob = repr(r)
        self.assertNotIn("가나다라마바사", blob, "전사 원문이 반환값에 새면 안 된다")

    def test_large_shift_is_applied_not_blocked(self):
        """큰 자동 이동은 차단 사유가 아니다 — 보정된 구간으로 클립을 만들고 준비 상태가 된다.

        예전에는 status=='reconfirm' 이면 REGION_SNAP_RECONFIRM_REQUIRED 로 막고 제안만 돌려줬는데,
        UI 에 그 제안을 승인하는 수단이 없어서 사용자가 구간을 다시 골라도 같은 보정이 다시 일어나
        영원히 막히는 순환이 됐다. 이제는 분석기가 찾은 구간을 그대로 적용한다."""
        src = self._src("shift.wav", [_sil(0.8), _speech(4.0), _sil(0.6),
                                      _speech(3.5, 200.0, 5), _sil(0.8)])
        r = rr.build_reference_clip(src, 3.2, 3.6, self.out,
                                    transcribe_fn=lambda p: "가나다")
        self.assertNotIn(rr.BLOCK_SNAP_RECONFIRM, r["blocking"],
                         "자동 이동이 크다는 이유만으로 막으면 안 된다")
        if r["snap"] and r["snap"].get("status") == "reconfirm":
            # 큰 이동이 실제로 일어난 표본 — 그래도 통과해야 한다.
            self.assertTrue(r["ready"], "보정된 구간으로 준비 상태가 되어야 한다")
            self.assertIsNotNone(r["clip_path"], "실제 클립을 만들어야 한다")
            self.assertTrue(os.path.exists(self.out))
            eff = r["effective_region"]
            self.assertIsNotNone(eff)
            self.assertGreaterEqual(eff["dur_sec"], 3.0)
            self.assertLessEqual(eff["dur_sec"], 10.0)
            # 진단 정보는 그대로 남는다(재현·추적용).
            self.assertIsNotNone(r["requested_region"])
            self.assertIn("status", r["snap"])

    def test_real_safety_errors_still_block(self):
        """완화한 것은 '이동이 크다' 하나뿐 — 실제 안전 오류는 그대로 막는다."""
        # 안전한 발화 경계가 없음(무음 없이 통짜 발화)
        src = self._src("nosil.wav", [_speech(12.0)])
        r = rr.build_reference_clip(src, 1.0, 5.0, self.out,
                                    transcribe_fn=lambda p: "가나다")
        self.assertFalse(r["ready"])
        self.assertTrue(len(r["blocking"]) > 0, "안전 경계 없음은 계속 차단")
        # 전사 실패
        src2 = self._normal()
        r2 = rr.build_reference_clip(src2, 0.4, 8.8, self.out, transcribe_fn=lambda p: None)
        self.assertFalse(r2["ready"])
        self.assertIn(rr.BLOCK_TRANSCRIBE_FAILED, r2["blocking"])
        # manual_text 불일치
        r3 = rr.build_reference_clip(src2, 0.4, 8.8, self.out,
                                     manual_text="전혀 다른 문장입니다",
                                     transcribe_fn=lambda p: "가나다라마바사")
        self.assertFalse(r3["ready"])
        self.assertIn(rr.BLOCK_TEXT_MISMATCH, r3["blocking"])

    def test_contract_shape_matches_step1(self):
        """1단계 계약 그대로 — blocking/warning_codes/ready 가 일관되어야 한다."""
        src = self._normal()
        for mt, tf in (("가나다라마바사", lambda p: "가나다라마바사"),
                       ("가나다라마바사입니다", lambda p: "가나다라마바사")):
            r = rr.build_reference_clip(src, 0.4, 8.8, self.out, manual_text=mt,
                                        transcribe_fn=tf)
            self.assertIsInstance(r["blocking"], list)
            self.assertIsInstance(r["warning_codes"], list)
            self.assertEqual(r["ready"], len(r["blocking"]) == 0)
            self.assertEqual(r["clip_path"] is None, not r["ready"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
