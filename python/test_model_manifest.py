# -*- coding: utf-8 -*-
"""model_manifest 단위 계약 — synthetic (실모델 0, 소형 임시파일만).

검증:
  - present: 모든 파일 존재 & size>0
  - 부재/빈 파일 → MODEL_MISSING, present False
  - expected 없으면 present-only(actualChecksum None) — 대용량 해시 회피
  - expected 일치 → reasonCode None, actualChecksum 채워짐
  - expected 불일치 → MODEL_CHECKSUM_MISMATCH
  - build_evidence: 계약 키(qwen3/separator_bs/separator_melband/gptsovits) 형태 정합

실행: python python/test_model_manifest.py
"""
import os
import sys
import tempfile
import shutil
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import model_manifest as mm


class VerifyModel(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="af_mm_")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _write(self, name, data=b"x"):
        p = os.path.join(self.d, name)
        with open(p, "wb") as f:
            f.write(data)
        return p

    def test_present_no_manifest(self):
        f = self._write("a.bin", b"hello")
        r = mm.verify_model([f])  # expected 없음
        self.assertTrue(r["present"])
        self.assertIsNone(r["expectedChecksum"])
        self.assertIsNone(r["actualChecksum"])  # present-only(해시 생략)
        self.assertIsNone(r["reasonCode"])

    def test_missing_file(self):
        r = mm.verify_model([os.path.join(self.d, "nope.bin")])
        self.assertFalse(r["present"])
        self.assertEqual(r["reasonCode"], mm.MODEL_MISSING)

    def test_empty_file_not_present(self):
        f = self._write("empty.bin", b"")
        r = mm.verify_model([f])
        self.assertFalse(r["present"])
        self.assertEqual(r["reasonCode"], mm.MODEL_MISSING)

    def test_empty_files_list(self):
        r = mm.verify_model([])
        self.assertFalse(r["present"])
        self.assertEqual(r["reasonCode"], mm.MODEL_MISSING)

    def test_checksum_match(self):
        f = self._write("m.bin", b"payload-123")
        expected = mm.aggregate_digest([f])
        r = mm.verify_model([f], expected)
        self.assertTrue(r["present"])
        self.assertEqual(r["expectedChecksum"], expected)
        self.assertEqual(r["actualChecksum"], expected)
        self.assertIsNone(r["reasonCode"])

    def test_checksum_mismatch(self):
        f = self._write("m.bin", b"payload-123")
        r = mm.verify_model([f], "deadbeef" * 8)  # 잘못된 기대값
        self.assertTrue(r["present"])
        self.assertEqual(r["reasonCode"], mm.MODEL_CHECKSUM_MISMATCH)
        self.assertNotEqual(r["actualChecksum"], r["expectedChecksum"])

    def test_aggregate_digest_order_stable(self):
        a = self._write("a.bin", b"AAA")
        b = self._write("b.bin", b"BBB")
        self.assertEqual(mm.aggregate_digest([a, b]), mm.aggregate_digest([b, a]))


class BuildEvidence(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="af_mm_")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_keys_and_shape(self):
        present = os.path.join(self.d, "p.bin")
        with open(present, "wb") as f:
            f.write(b"z")
        spec = {
            "qwen3": {"files": [present], "expected": None},
            "separator_bs": {"files": [os.path.join(self.d, "missing.ckpt")], "expected": None},
        }
        ev = mm.build_evidence(spec)
        self.assertEqual(set(ev.keys()), {"qwen3", "separator_bs"})
        for v in ev.values():
            self.assertEqual(set(v.keys()),
                             {"present", "expectedChecksum", "actualChecksum", "reasonCode"})
        self.assertTrue(ev["qwen3"]["present"])
        self.assertFalse(ev["separator_bs"]["present"])
        self.assertEqual(ev["separator_bs"]["reasonCode"], mm.MODEL_MISSING)

    def test_contract_model_keys(self):
        self.assertEqual(mm.MODEL_KEYS,
                         ("qwen3", "separator_bs", "separator_melband", "gptsovits"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
