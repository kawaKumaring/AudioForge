# -*- coding: utf-8 -*-
"""엔진별 참조 정책 — 필수(차단) 와 권장(경고) 의 분리.

GPT-SoVITS 는 벤더가 실제로 요구하는 3~10초를 필수로 유지한다.
Qwen3 에는 GPT-SoVITS 의 10초 상한을 적용하지 않는다(길이 필수 한계 없음). 3~10초는 이 앱이
검증한 권장 범위이며 밖은 경고다 — 차단이 아니고, '길수록 좋다' 도 아니다.
"""
import os
import shutil
import tempfile
import unittest

import numpy as np
import soundfile as sf

import reference_audio as ra


def _write(path, sec, sr=24000):
    t = np.arange(int(sec * sr)) / sr
    x = 0.3 * np.sin(2 * np.pi * 180 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t))
    sf.write(path, x.astype("float32"), sr, subtype="PCM_16")
    return path


class PolicyTable(unittest.TestCase):
    def test_gptsovits_required_unchanged(self):
        p = ra.GPTSOVITS_POLICY
        self.assertEqual((p.min_duration_sec, p.max_duration_sec), (3.0, 10.0))
        self.assertTrue(p.basis)                       # 출처 없는 수치는 없다
        self.assertEqual(p.region_bounds(60.0), (3.0, 10.0))
        self.assertEqual(p.region_threshold_sec(), 10.0)

    def test_qwen3_has_no_required_length_but_recommended_range(self):
        p = ra.QWEN3_POLICY
        self.assertIsNone(p.min_duration_sec)
        self.assertIsNone(p.max_duration_sec)
        self.assertEqual((p.recommended_min_sec, p.recommended_max_sec), (3.0, 10.0))
        self.assertTrue(p.basis and p.recommended_basis)
        # 구간 도구의 한계 = 원본 전체(필수 상한이 없으므로). 추천은 권장 범위를 노린다.
        self.assertEqual(p.region_bounds(58.3), (0.0, 58.3))
        self.assertEqual(p.recommended_bounds(), (3.0, 10.0))
        self.assertEqual(p.region_threshold_sec(), 10.0)     # 10초를 넘으면 '구간 추천' 대상(필수 아님)

    def test_describe_shape_for_ipc(self):
        d = ra.QWEN3_POLICY.describe()
        self.assertEqual(set(d), {"engine", "required", "recommended", "basis", "recommended_basis"})
        self.assertEqual(d["required"], {"min_sec": None, "max_sec": None})
        self.assertEqual(d["recommended"], {"min_sec": 3.0, "max_sec": 10.0})

    def test_resolve_policy_engine(self):
        self.assertEqual(ra.resolve_policy_engine("auto", True), "qwen3")
        self.assertEqual(ra.resolve_policy_engine("auto", False), "gptsovits")
        self.assertEqual(ra.resolve_policy_engine(None, True), "qwen3")
        self.assertEqual(ra.resolve_policy_engine("qwen3", False), "qwen3")   # 지목한 엔진의 정책을 보인다
        self.assertEqual(ra.resolve_policy_engine("gptsovits", True), "gptsovits")
        # 이번 범위 밖 엔진은 기존 표시(GPT-SoVITS 정책) 유지
        self.assertEqual(ra.resolve_policy_engine("f5tts", True), "gptsovits")
        self.assertEqual(ra.resolve_policy_engine("kokoro", True), "gptsovits")

    def test_policy_for_engine_rejects_unknown(self):
        self.assertIs(ra.policy_for_engine("qwen3"), ra.QWEN3_POLICY)
        with self.assertRaises(ValueError):
            ra.policy_for_engine("f5tts")


class Assessment(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_refpol_")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _codes(self, issues):
        return [i.code for i in issues]

    def test_gptsovits_boundaries_still_block(self):
        long = _write(os.path.join(self.tmp, "g15.wav"), 15.0)
        a = ra.assess_reference_file(long, ra.GPTSOVITS_POLICY)
        self.assertFalse(a.valid)
        self.assertIn(ra.TOO_LONG, self._codes(a.errors))
        short = _write(os.path.join(self.tmp, "g2.wav"), 2.0)
        a = ra.assess_reference_file(short, ra.GPTSOVITS_POLICY)
        self.assertFalse(a.valid)
        self.assertIn(ra.TOO_SHORT, self._codes(a.errors))

    def test_qwen3_long_reference_is_valid_with_warning_not_error(self):
        long = _write(os.path.join(self.tmp, "q15.wav"), 15.0)
        a = ra.assess_reference_file(long, ra.QWEN3_POLICY)
        self.assertTrue(a.valid, self._codes(a.errors))
        self.assertNotIn(ra.TOO_LONG, self._codes(a.errors))
        self.assertIn(ra.OUTSIDE_RECOMMENDED_LENGTH, self._codes(a.warnings))
        # 권장 상한을 넘는 원본은 전체 품질 스캔을 생략한다(구간이 추천되고 그 구간을 따로 잰다).
        self.assertFalse(a.analysis.quality_scanned)

    def test_qwen3_short_reference_is_valid_with_warning(self):
        short = _write(os.path.join(self.tmp, "q2.wav"), 2.0)
        a = ra.assess_reference_file(short, ra.QWEN3_POLICY)
        self.assertTrue(a.valid, self._codes(a.errors))
        self.assertIn(ra.OUTSIDE_RECOMMENDED_LENGTH, self._codes(a.warnings))

    def test_qwen3_recommended_range_no_length_warning(self):
        ok = _write(os.path.join(self.tmp, "q7.wav"), 7.0)
        a = ra.assess_reference_file(ok, ra.QWEN3_POLICY)
        self.assertTrue(a.valid, self._codes(a.errors))
        self.assertNotIn(ra.OUTSIDE_RECOMMENDED_LENGTH, self._codes(a.warnings))
        self.assertTrue(a.analysis.quality_scanned)

    def test_qwen3_still_blocks_unprocessable_files(self):
        empty = os.path.join(self.tmp, "empty.wav")
        sf.write(empty, np.zeros(0, dtype="float32"), 24000, subtype="PCM_16")
        a = ra.assess_reference_file(empty, ra.QWEN3_POLICY)
        self.assertFalse(a.valid)
        self.assertIn(ra.EMPTY_AUDIO, self._codes(a.errors))
        silent = os.path.join(self.tmp, "silent.wav")
        sf.write(silent, np.zeros(int(6 * 24000), dtype="float32"), 24000, subtype="PCM_16")
        a = ra.assess_reference_file(silent, ra.QWEN3_POLICY)
        self.assertFalse(a.valid)
        self.assertIn(ra.NEAR_SILENT, self._codes(a.errors))
        broken = os.path.join(self.tmp, "broken.wav")
        with open(broken, "wb") as f:
            f.write(b"RIFF....WAVEjunk")
        a = ra.assess_reference_file(broken, ra.QWEN3_POLICY)
        self.assertFalse(a.valid)
        self.assertIn(ra.DECODE_FAILED, self._codes(a.errors))


if __name__ == "__main__":
    unittest.main()
