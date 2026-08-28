# -*- coding: utf-8 -*-
"""정렬 실패 진단 보존의 계약.

고정하는 것:
  - 기본 활성 · 출력 폴더 하위 **진단 전용** 서브폴더 · job_dir 정리에 휩쓸리지 않는다.
  - 남는 것은 raw 와 **수치/비민감 enum 뿐**: 전사 원문·목표 대사·절대경로 없음(raw 는 sha8 로만 식별).
  - 결과가 아니다: 최종 결과 파일명(synthesized.wav)으로 발행하지 않는다.
  - 무한히 쌓이지 않는다(MAX_KEPT 초과분은 오래된 것부터 삭제).
  - 진단 보존이 실패해도 예외를 밖으로 내지 않는다(합성 실패 사유를 바꾸지 않는다).
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import icl_diagnostics as dg  # noqa: E402

SECRET_REF = "참조 음성의 원래 대사입니다"
SECRET_TARGET = "안녕하세요 오늘 좋은 소식이 있습니다"


class PreserveTest(unittest.TestCase):
    def setUp(self):
        self.out = tempfile.mkdtemp(prefix="af_diag_out_")
        self.addCleanup(lambda: shutil.rmtree(self.out, ignore_errors=True))
        self.job = os.path.join(self.out, ".qwen-job-test")
        os.makedirs(self.job)
        self.raw = os.path.join(self.job, "segment_qwen_001_c000.wav")
        import numpy as np
        import soundfile as sf
        sf.write(self.raw, np.zeros(2400, dtype="float32"), 24000)

    def _detection(self):
        return {"ok": False, "reason_code": "PREFIX_BOUNDARY_ONSET_NOT_FOUND",
                "sample_rate": 24000, "window_start_sample": 216480,
                "window_end_sample": 237720, "anchor_start_sample": 227520,
                "tail_end_sample": 225480, "onset_sample": None,
                "noise_floor_dbfs": -68.08, "quiet_frame_count": 26,
                # 아래 둘은 절대 새 나가면 안 되는 값 — 필터가 지워야 한다.
                "leaked_text": SECRET_TARGET, "leaked_path": "E:/secret/output/x.wav"}

    def _preserve(self):
        return dg.preserve_failure(self.out, self.raw, "PREFIX_BOUNDARY_ONSET_NOT_FOUND",
                                   self._detection(), 0, 0, "happy")

    def test_raw_and_report_survive_job_dir_cleanup(self):
        name = self._preserve()
        self.assertIsNotNone(name)
        shutil.rmtree(self.job, ignore_errors=True)   # job_dir 통째 정리(실제 finally 와 같은 동작)
        d = os.path.join(self.out, dg.DIAGNOSTIC_DIR_NAME, name)
        self.assertTrue(os.path.isfile(os.path.join(d, dg.RAW_NAME)), "raw 가 남는다")
        self.assertTrue(os.path.isfile(os.path.join(d, dg.REPORT_NAME)))

    def test_report_is_numbers_and_nonsensitive_enums_only(self):
        name = self._preserve()
        p = os.path.join(self.out, dg.DIAGNOSTIC_DIR_NAME, name, dg.REPORT_NAME)
        blob = open(p, encoding="utf-8").read()
        for secret in (SECRET_REF, SECRET_TARGET, "secret", self.out, self.raw):
            self.assertNotIn(secret, blob, secret[:20])
        rep = json.loads(blob)
        self.assertEqual(rep["reason_code"], "PREFIX_BOUNDARY_ONSET_NOT_FOUND")
        self.assertEqual(rep["detection"]["window_start_sample"], 216480)
        self.assertEqual(rep["detection"]["reason_code"], "PREFIX_BOUNDARY_ONSET_NOT_FOUND")
        self.assertNotIn("leaked_text", rep["detection"])
        self.assertNotIn("leaked_path", rep["detection"])
        self.assertEqual(len(rep["raw_sha8"]), 8, "raw 는 sha8 로만 식별한다")
        self.assertEqual(rep["raw_frames"], 2400)
        self.assertEqual(rep["raw_sample_rate"], 24000)

    def test_not_published_as_a_result(self):
        """진단 폴더는 결과가 아니다 — 출력 폴더에 결과 파일을 만들지 않는다."""
        self._preserve()
        self.assertEqual([n for n in os.listdir(self.out) if n.endswith(".wav")], [])
        entries = sorted(os.listdir(self.out))
        self.assertIn(dg.DIAGNOSTIC_DIR_NAME, entries)
        self.assertTrue(dg.DIAGNOSTIC_DIR_NAME.startswith("."), "숨김 · 전용 이름")
        self.assertFalse(dg.DIAGNOSTIC_DIR_NAME.startswith(".qwen-job-"),
                         "job 정리 스윕(.qwen-job-*)의 대상이 아니다")

    def test_retention_is_bounded(self):
        names = []
        for _ in range(dg.MAX_KEPT + 3):
            names.append(self._preserve())
        root = os.path.join(self.out, dg.DIAGNOSTIC_DIR_NAME)
        kept = sorted(os.listdir(root))
        self.assertEqual(len(kept), dg.MAX_KEPT)
        self.assertEqual(kept, sorted(names)[-dg.MAX_KEPT:], "오래된 것부터 지운다")

    def test_never_raises(self):
        for args in ((None, self.raw), ("E:/does/not/exist/at/all", self.raw),
                     (self.out, None), (self.out, os.path.join(self.job, "missing.wav"))):
            try:
                dg.preserve_failure(args[0], args[1], "X", {"a": 1}, 0, 0)
            except Exception as e:            # noqa: BLE001
                self.fail(f"진단 보존이 예외를 냈다: {e!r}")


class WiringTest(unittest.TestCase):
    """tts_worker 배선 — 실패 지점에서 실제로 호출되고, 폴더 '이름'만 오류에 실린다."""

    def setUp(self):
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "tts_worker.py"),
                  "r", encoding="utf-8") as f:
            self.src = f.read()

    def test_preserve_is_called_on_alignment_failure(self):
        self.assertIn("icl_diagnostics.preserve_failure", self.src)
        self.assertIn("diagnostic_dir_name", self.src)

    def test_payload_carries_a_name_not_a_path(self):
        self.assertIn('"diagnostic_dir_name": getattr(ibe, "diagnostic_dir_name", None)', self.src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
