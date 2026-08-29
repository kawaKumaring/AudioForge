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
        # 진단은 사용자 출력 폴더가 아니라 _local/artifacts/diagnostics 로 간다(계약 변경).
        self.local = tempfile.mkdtemp(prefix="af_diag_local_")
        self.addCleanup(lambda: shutil.rmtree(self.local, ignore_errors=True))
        os.environ["AUDIOFORGE_LOCAL_ROOT"] = self.local
        self.addCleanup(lambda: os.environ.pop("AUDIOFORGE_LOCAL_ROOT", None))
        self.diag_root = os.path.join(self.local, "artifacts", "diagnostics",
                                      dg.DIAGNOSTIC_DIR_NAME)
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
        d = os.path.join(self.diag_root, name)
        self.assertTrue(os.path.isfile(os.path.join(d, dg.RAW_NAME)), "raw 가 남는다")
        self.assertTrue(os.path.isfile(os.path.join(d, dg.REPORT_NAME)))

    def test_report_is_numbers_and_nonsensitive_enums_only(self):
        name = self._preserve()
        p = os.path.join(self.diag_root, name, dg.REPORT_NAME)
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
        # 새 계약: 사용자 출력 폴더에는 진단이 생기지 않는다.
        self.assertNotIn(dg.DIAGNOSTIC_DIR_NAME, entries,
                         "진단이 사용자 출력 폴더를 오염시킨다")
        self.assertTrue(os.path.isdir(self.diag_root), "_local 에 진단이 생기지 않았다")
        self.assertTrue(dg.DIAGNOSTIC_DIR_NAME.startswith("."), "숨김 · 전용 이름")
        self.assertFalse(dg.DIAGNOSTIC_DIR_NAME.startswith(".qwen-job-"),
                         "job 정리 스윕(.qwen-job-*)의 대상이 아니다")

    def test_retention_is_bounded(self):
        names = []
        for _ in range(dg.MAX_KEPT + 3):
            names.append(self._preserve())
        root = self.diag_root
        kept = sorted(os.listdir(root))
        self.assertEqual(len(kept), dg.MAX_KEPT)
        self.assertEqual(kept, sorted(names)[-dg.MAX_KEPT:], "오래된 것부터 지운다")

    def _history(self):
        """앞의 두 chunk 는 성공, 마지막이 실패 — 누적 요약에 담길 형태 그대로."""
        return [
            {"segment_index": 0, "chunk_index": 0, "ok": 1, "reason_code": "PREFIX_BOUNDARY_OK",
             "align_anchor_kind": "TARGET_HEAD", "align_stage": "ALIGN_STAGE_NONE",
             "tail_end_sample": 207960, "onset_sample": 211080, "cut_sample": 209760,
             "lead_samples": 1320},
            {"segment_index": 1, "chunk_index": 0, "ok": 1, "reason_code": "PREFIX_BOUNDARY_OK",
             "align_anchor_kind": "REFERENCE_TAIL", "align_stage": "ALIGN_STAGE_NONE",
             "cut_sample": 120240, "lead_samples": 600, "lead_fallback_applied": 1,
             # 아래 둘은 절대 새 나가면 안 되는 값 — 필터가 지워야 한다.
             "leaked_text": SECRET_REF, "leaked_path": "E:/secret/output/x.wav"},
            {"segment_index": 1, "chunk_index": 2, "ok": 0,
             "reason_code": "PREFIX_BOUNDARY_LEAD_TOO_SHORT",
             "tail_end_sample": 202440, "onset_sample": 203400, "valley_sample": 203040,
             "lead_samples": 360, "lead_fallback_applied": 0},
        ]

    def test_earlier_chunks_survive_the_failure_of_a_later_one(self):
        """[8] 뒤 chunk 가 막혀도 앞에서 성공한 chunk 의 수치가 진단에 남는다."""
        name = dg.preserve_failure(self.out, self.raw, "PREFIX_BOUNDARY_LEAD_TOO_SHORT",
                                   self._detection(), 1, 2, "happy",
                                   chunk_history=self._history())
        p = os.path.join(self.diag_root, name, dg.REPORT_NAME)
        rep = json.loads(open(p, encoding="utf-8").read())
        chunks = rep["chunks"]
        self.assertEqual(len(chunks), 3, "성공 2 + 실패 1 이 순서대로 남는다")
        self.assertEqual([c["ok"] for c in chunks], [1, 1, 0])
        self.assertEqual(chunks[0]["cut_sample"], 209760)
        self.assertEqual(chunks[0]["align_anchor_kind"], "TARGET_HEAD")
        self.assertEqual(chunks[1]["align_anchor_kind"], "REFERENCE_TAIL")
        self.assertEqual(chunks[1]["lead_fallback_applied"], 1)
        self.assertEqual(chunks[2]["reason_code"], "PREFIX_BOUNDARY_LEAD_TOO_SHORT")
        self.assertEqual(chunks[2]["lead_samples"], 360)

    def test_chunk_history_is_numbers_and_nonsensitive_enums_only(self):
        """[8] 누적 요약도 detection 과 **같은 필터**를 지난다 — 대사·경로는 통과하지 못한다."""
        name = dg.preserve_failure(self.out, self.raw, "PREFIX_BOUNDARY_LEAD_TOO_SHORT",
                                   self._detection(), 1, 2, "happy",
                                   chunk_history=self._history())
        p = os.path.join(self.diag_root, name, dg.REPORT_NAME)
        blob = open(p, encoding="utf-8").read()
        for secret in (SECRET_REF, SECRET_TARGET, "secret", "E:/", ":\\", ".wav",
                       self.out, self.raw):
            self.assertNotIn(secret, blob, secret[:20])
        rep = json.loads(blob)
        for c in rep["chunks"]:
            self.assertNotIn("leaked_text", c)
            self.assertNotIn("leaked_path", c)
            for k, v in c.items():
                if isinstance(v, str):
                    self.assertTrue(all(ch.isupper() or ch.isdigit() or ch == "_" for ch in v), k)

    def test_history_does_not_publish_any_result_file(self):
        """[9] 실패 경로가 발행하는 결과 파일은 0 이다(누적 요약이 생겨도 마찬가지)."""
        dg.preserve_failure(self.out, self.raw, "PREFIX_BOUNDARY_LEAD_TOO_SHORT",
                            self._detection(), 1, 2, "happy", chunk_history=self._history())
        self.assertEqual([n for n in os.listdir(self.out) if not n.startswith(".")], [],
                         "출력 폴더에 결과가 생기지 않는다(진단 폴더는 숨김 전용 이름)")
        root = self.diag_root
        kept = os.path.join(root, os.listdir(root)[0])
        self.assertEqual(sorted(os.listdir(kept)), sorted([dg.RAW_NAME, dg.REPORT_NAME]),
                         "진단 폴더 안에도 raw 와 리포트 말고는 없다")

    def test_never_raises(self):
        for args in ((None, self.raw), ("E:/does/not/exist/at/all", self.raw),
                     (self.out, None), (self.out, os.path.join(self.job, "missing.wav"))):
            try:
                dg.preserve_failure(args[0], args[1], "X", {"a": 1}, 0, 0)
            except Exception as e:            # noqa: BLE001
                self.fail(f"진단 보존이 예외를 냈다: {e!r}")
        for bad in ("문자열", 42, [None, "x", {"ok": 1}], {"a": 1}):
            try:
                dg.preserve_failure(self.out, self.raw, "X", {"a": 1}, 0, 0, chunk_history=bad)
            except Exception as e:            # noqa: BLE001
                self.fail(f"이상한 누적 요약이 예외를 냈다: {e!r}")


class AlignmentDiagnosticJsonTest(unittest.TestCase):
    """[회귀 8] P2 — 실제 정렬 실패에서 나온 detection 이 진단 JSON 에 어떻게 남는가.

    스텁 dict 가 아니라 icl_alignment.plan_cut 이 실제로 만든 detection 을 그대로 흘려 넣는다 —
    '기록하기로 한 수치가 진짜 기록되는가'와 '텍스트가 한 글자도 새지 않는가'를 동시에 본다."""

    def setUp(self):
        self.out = tempfile.mkdtemp(prefix="af_diag_align_")
        self.addCleanup(lambda: shutil.rmtree(self.out, ignore_errors=True))
        # 진단은 사용자 출력 폴더가 아니라 _local/artifacts/diagnostics 로 간다(계약 변경).
        self.local = tempfile.mkdtemp(prefix="af_diag_local_")
        self.addCleanup(lambda: shutil.rmtree(self.local, ignore_errors=True))
        os.environ["AUDIOFORGE_LOCAL_ROOT"] = self.local
        self.addCleanup(lambda: os.environ.pop("AUDIOFORGE_LOCAL_ROOT", None))
        self.diag_root = os.path.join(self.local, "artifacts", "diagnostics",
                                      dg.DIAGNOSTIC_DIR_NAME)
        self.raw = os.path.join(self.out, "segment_qwen_001_c000.wav")
        import numpy as np
        import soundfile as sf
        sf.write(self.raw, np.zeros(2400, dtype="float32"), 24000)

    @staticmethod
    def _fail(asr, wave=None):
        import icl_alignment as ia
        import test_icl_alignment as fx
        try:
            ia.plan_cut(fx.REF_TEXT, fx.TARGET_TEXT, asr,
                        fx._decoy_wave() if wave is None else wave, fx.SR)
        except ia.IclAlignmentFailed as af:
            return af
        raise AssertionError("실패가 나야 하는 픽스처인데 통과했다")

    def _report(self, af):
        name = dg.preserve_failure(self.out, self.raw, af.reason_code, af.detection, 0, 0, "happy")
        self.assertIsNotNone(name)
        p = os.path.join(self.diag_root, name, dg.REPORT_NAME)
        blob = open(p, encoding="utf-8").read()
        return json.loads(blob), blob

    def test_the_nine_recorded_numbers_are_present(self):
        import test_icl_alignment as fx
        af = self._fail(fx._head_corrupted_asr(
            ref_words=[("참조", 0.00, 0.45), ("음성의", 0.45, 1.00),
                       ("원래", 1.30, 1.80), ("대사임다", 1.80, 2.30)]))
        rep, _blob = self._report(af)
        d = rep["detection"]
        self.assertEqual(d["align_asr_units"], 27)          # ASR 스트림 음절 길이
        self.assertEqual(d["align_target_units"], 16)       # 목표 음절 길이
        self.assertEqual(d["align_reference_units"], 12)    # 참조 음절 길이
        for n in range(1, 6):                               # 목표 머리 길이별 매치 개수
            self.assertIn("align_head_match_n%d" % n, d)
        for n in range(3, 6):                               # 참조 꼬리 길이별 매치 개수
            self.assertIn("align_ref_tail_match_n%d" % n, d)
        self.assertEqual(d["align_head_longest_units"], 2)  # 최장 일치 길이
        self.assertEqual(d["align_ref_tail_longest_units"], 0)
        self.assertEqual(d["align_stage"], "ALIGN_STAGE_REFERENCE_TAIL_ANCHOR")  # 최종 실패 단계
        self.assertEqual(d["align_ref_tail_reason"], "ICL_ALIGN_REF_TAIL_NOT_FOUND")

    def test_selected_anchor_kind_and_position_survive_the_filter(self):
        """anchor 를 고른 뒤 파형에서 막힌 경우 — 종류·위치·시각이 그대로 남는다."""
        import test_icl_alignment as fx
        af = self._fail(fx._head_corrupted_asr(), wave=fx._speech(fx.TOTAL_N))
        rep, _blob = self._report(af)
        d = rep["detection"]
        self.assertEqual(d["align_anchor_kind"], "REFERENCE_TAIL")   # 선택된 anchor 종류
        self.assertIsInstance(d["align_anchor_stream_index"], int)   # 선택된 anchor 위치
        self.assertAlmostEqual(d["align_anchor_time_sec"], 2.30, places=4)
        self.assertIn(d["align_anchor_units"], (3, 4, 5))
        self.assertEqual(d["align_stage"], "ALIGN_STAGE_BOUNDARY")

    def test_no_transcript_no_dialogue_no_absolute_path(self):
        import test_icl_alignment as fx
        for af in (self._fail(fx._head_corrupted_asr(
                       ref_words=[("참조", 0.0, 0.45), ("대사임다", 1.8, 2.3)])),
                   self._fail(fx._head_corrupted_asr(), wave=fx._speech(fx.TOTAL_N))):
            _rep, blob = self._report(af)
            for secret in (fx.REF_TEXT, fx.TARGET_TEXT, "안녕", "참조", "대사",
                           self.out, self.raw, ".wav", ":\\", ":/"):
                self.assertNotIn(secret, blob, secret[:16])


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

    def test_successful_chunks_are_accumulated_before_the_failure(self):
        """[8] 성공한 chunk 도 이력에 쌓고, 실패 시 그 이력을 진단으로 넘긴다."""
        self.assertIn("chunk_history=history", self.src)
        self.assertIn("history.append(_icl_chunk_record(e, r[\"summary\"]", self.src)
        self.assertIn("history.append(_icl_chunk_record(e, af.detection", self.src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
