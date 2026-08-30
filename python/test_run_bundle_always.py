# -*- coding: utf-8 -*-
"""모든 TTS 생성이 재현 JSON 기록을 남긴다 — 진단 환경변수와 무관하다.

실측으로 확인한 결함이 출발점이다: recorder 가 `_align_icl_chunks` 안에서만 만들어져서
**production 기본 경로인 vendor native ICL 은 번들을 통째로 남기지 않았다.**

여기서 고정하는 것:
  · vendor native / safe_xvector / legacy controlled-prefix / auto 어느 경로든 번들이 생긴다
  · 성공·실패·partial 이 같은 계약으로 기록된다
  · manifest 는 **마지막**에 발행되고, 없으면 읽는 쪽이 INCOMPLETE 로 본다
  · 최종 WAV 는 복사하지 않고 basename·길이·표본율·채널·SHA 로 연결한다
  · 비민감 문서에 대사·전사·절대경로가 새지 않는다
  · 기록이 실패해도 사용자 WAV 를 지우지 않고 원래 오류를 덮지 않는다
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import chunk_publish as cp                                        # noqa: E402
import local_assets as la                                        # noqa: E402
import tts_worker                                                # noqa: E402
import _vendor_crop_fixture as _vcf                               # noqa: E402
from test_reference_conditioning_mode import _QwenJobBase         # noqa: E402

SECRET_TEXT = "안녕하세요 첫 문장입니다.\n[기쁨] 좋은 소식이 있어요!\n마지막 문장입니다."


class _BundleJobBase(_QwenJobBase):
    """_QwenJobBase 위에 '기록은 어디로 가는가' 만 얹는다. 진단 env 는 켜지 않는다."""

    RC_MODE = "high_quality_icl"

    def setUp(self):
        super().setUp()
        self.localroot = tempfile.mkdtemp(prefix="af_bundle_local_")
        self.addCleanup(lambda: shutil.rmtree(self.localroot, ignore_errors=True))
        self._env = {k: os.environ.get(k)
                     for k in (la.LOCAL_ROOT_ENV, cp.ENV, cp.STAGE_ENV,
                               "AUDIOFORGE_LEGACY_CONTROLLED_PREFIX")}
        os.environ[la.LOCAL_ROOT_ENV] = self.localroot
        for k in (cp.ENV, cp.STAGE_ENV):
            os.environ.pop(k, None)          # 진단 스위치 없이도 기록돼야 한다
        cp._AUTO_RUN_ID = None
        self.addCleanup(self._restore_env)
        # vendor native 는 발행 근거가 있어야 통과한다(실제 bridge 와 같은 조건).
        # 실제 bridge 와 같은 형태 — 이 호출에 넘어간 대사도 함께 돌려준다.
        self.entry_extra = lambda s: dict(
            {"text": s["text"]},
            **({"vendor_crop_record": _vcf.vendor_crop_record(s["out_path"])}
               if not s.get("x_vector_only") else {}))

    def _restore_env(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        cp._AUTO_RUN_ID = None
        tts_worker._CONCAT_RECORDER = None

    def _synth(self, text=None, mode=None, **kw):
        tts_worker.synthesize(
            self.ref5, text or SECRET_TEXT, self.out, speed=1.0, silence_gap=0.5,
            emotion_refs={"happy": self.happy_ref},
            emotion_ref_sources={"happy": self.happy_ref},
            preferred_engine="qwen3",
            # 참조 억양 반영 모드는 참조 대사가 필요하다 — 픽스처는 수동 전사를 준다(Whisper 미사용).
            reference_prompts={"default": {"manual_text": "참조 음성의 원래 대사입니다",
                                           "mode": "manual"},
                               "happy": {"manual_text": "참조 음성의 원래 대사입니다",
                                         "mode": "manual"}},
            reference_conditioning_mode=mode or self.RC_MODE, **kw)

    # ── 번들 접근 ────────────────────────────────────────────────────────────
    def _bundle_root(self):
        base = os.path.join(self.localroot, "artifacts", "runs")
        self.assertTrue(os.path.isdir(base), "run bundle 루트가 없다 — 기록이 아예 안 열렸다")
        runs = sorted(os.listdir(base))
        self.assertEqual(len(runs), 1, "한 작업은 번들 하나다: %s" % runs)
        return os.path.join(base, runs[0])

    def _manifest(self):
        p = os.path.join(self._bundle_root(), cp.MANIFEST_NAME)
        self.assertTrue(os.path.isfile(p), "manifest 가 없다")
        with open(p, encoding="utf-8") as f:
            return json.load(f)

    def _nonsensitive_blob(self):
        """private 이 아닌 모든 문서를 합쳐서 본다 — 누출은 어느 한 파일에만 있어도 누출이다."""
        root = self._bundle_root()
        blob = []
        for dirpath, _dirs, files in os.walk(root):
            for n in files:
                if n.endswith(cp.PRIVATE_SUFFIX) or not n.endswith(".json"):
                    continue
                with open(os.path.join(dirpath, n), encoding="utf-8") as f:
                    blob.append(f.read())
        return "\n".join(blob)


class VendorNativePathTest(_BundleJobBase):
    RC_MODE = "high_quality_icl"

    def test_bundle_exists_without_any_diagnostic_env(self):
        self._synth()
        m = self._manifest()
        self.assertEqual(m["status"], "ok")
        self.assertEqual(m["schema"], cp.SCHEMA_VERSION)
        self.assertTrue(m["run_id"])
        self.assertTrue(m["created_at"])
        self.assertEqual(m["header"]["reference_conditioning_mode_requested"], "high_quality_icl")
        self.assertEqual(m["header"]["input_chars"], len(SECRET_TEXT))
        self.assertTrue(m["header"]["raw_text_sha256"])

    def test_chunk_rows_carry_coordinates_and_generation_evidence(self):
        self._synth()
        m = self._manifest()
        self.assertEqual(m["chunk_count"], 3, "3 segment → 3 chunk 행")
        for i, row in enumerate(m["chunks"]):
            self.assertEqual(row["chunk_index"], i, "global index 가 어긋났다")
            self.assertEqual(row["production_tokens"], 20)
            self.assertEqual(row["generation_limit"], 256)
            self.assertEqual(row["termination_reason"], "completed_before_limit")
            self.assertEqual(row["external_alignment_calls"], 0,
                             "vendor native 는 외부 alignment 를 부르지 않는다")
            self.assertEqual(row["crop_authority"], "vendor_native_ref_code")
            self.assertIn("vendor_returned", row, "vendor 반환 단계가 기록되지 않았다")
            self.assertIn("array_sha256", row["vendor_returned"])

    def test_final_wav_is_linked_by_sha_not_copied(self):
        self._synth()
        m = self._manifest()
        res = m["result"]
        self.assertEqual(res["basename"], "synthesized.wav")
        self.assertFalse(res["copied_into_bundle"])
        self.assertGreater(res["frames"], 0)
        self.assertEqual(res["sample_rate"], 24000)
        self.assertGreaterEqual(res["channels"], 1)
        import hashlib
        published = os.path.join(self.out, "synthesized.wav")
        actual = hashlib.sha256(open(published, "rb").read()).hexdigest()
        self.assertEqual(res["sha256"], actual, "기록된 SHA 가 실제 발행물과 다르다")
        # 번들 안에 WAV 사본이 없다.
        wavs = [n for _d, _s, fs in os.walk(self._bundle_root()) for n in fs
                if n.endswith(".wav")]
        self.assertEqual(wavs, [], "최종 WAV 를 진단 폴더에 복사하면 안 된다: %s" % wavs)

    def test_stage_wavs_are_not_written_when_diagnostics_off(self):
        self._synth()
        self.assertFalse(self._manifest()["stage_wavs_kept"])
        self.assertFalse(os.path.isdir(os.path.join(self._bundle_root(), "chunks", "wav")))

    def test_no_script_transcript_or_absolute_path_leaks(self):
        self._synth()
        blob = self._nonsensitive_blob()
        for secret in ("안녕하세요 첫 문장입니다", "좋은 소식이 있어요", "마지막 문장입니다"):
            self.assertNotIn(secret, blob, "대사가 비민감 문서로 샜다: %s" % secret)
        for p in (self.out, self.ref5, self.localroot):
            self.assertNotIn(p.replace("\\", "\\\\"), blob, "절대경로가 샜다")
            self.assertNotIn(p.replace("\\", "/"), blob, "절대경로가 샜다")

    def test_script_and_chunk_text_live_only_in_private_files(self):
        self._synth()
        m = self._manifest()
        private = m["private_files"]
        self.assertTrue(private, "private 목록이 비었다")
        for rel in private:
            self.assertTrue(rel.endswith(cp.PRIVATE_SUFFIX))
        found = False
        for rel in private:
            with open(os.path.join(self._bundle_root(), rel.replace("/", os.sep)),
                      encoding="utf-8") as f:
                if "첫 문장입니다" in f.read():
                    found = True
        self.assertTrue(found, "대사가 private 기록에도 없으면 재현이 불가능하다")
        for a in m["artifacts"]:
            self.assertEqual(a["export_allowed"], a["privacy_class"] == cp.PRIVACY_NON_SENSITIVE)

    def test_manifest_is_published_last(self):
        self._synth()
        root = self._bundle_root()
        mt_manifest = os.path.getmtime(os.path.join(root, cp.MANIFEST_NAME))
        for n in ("timeline.json", cp.OPEN_RECORD_NAME):
            p = os.path.join(root, n)
            self.assertTrue(os.path.isfile(p), n)
            self.assertLessEqual(os.path.getmtime(p), mt_manifest + 1e-6,
                                 "%s 가 manifest 뒤에 쓰였다" % n)

    def test_macro_gain_and_envelope_decisions_are_recorded(self):
        self._synth()
        h = self._manifest()["header"]
        self.assertIn("macro_gain_applied", h)
        self.assertIn("macro_gain_reason", h)
        self.assertIn("boundary_onset_samples", h)
        self.assertIn("boundary_offset_samples", h)
        self.assertIn("elapsed_seconds", h)


class SafeXvectorPathTest(_BundleJobBase):
    RC_MODE = "safe_xvector"

    def test_bundle_exists(self):
        self._synth()
        m = self._manifest()
        self.assertEqual(m["status"], "ok")
        self.assertEqual(m["header"]["reference_conditioning_mode_requested"], "safe_xvector")
        self.assertEqual(m["chunk_count"], 3)


class FailurePathTest(_BundleJobBase):
    def test_engine_failure_is_recorded_and_wav_is_not_published(self):
        self.run_job_error = RuntimeError("BRIDGE_BOOM")
        with self.assertRaises(Exception):
            self._synth()
        m = self._manifest()
        self.assertEqual(m["status"], "failed")
        self.assertEqual(m["header"]["error_code"], "RuntimeError")
        self.assertIsNone(m["result"], "발행되지 않은 결과를 있다고 적으면 안 된다")

    def test_generation_limit_is_partial_not_failed(self):
        self.run_job_error = tts_worker.QwenGenerationLimitError(0, 3072, 3072, "default", 0)
        with self.assertRaises(Exception):
            self._synth()
        m = self._manifest()
        self.assertEqual(m["status"], "partial",
                         "부분 파형을 보존한 종료는 단순 실패가 아니다")
        self.assertEqual(m["header"]["error_code"], "GENERATION_LIMIT_EXCEEDED")

    def test_open_record_alone_reads_as_incomplete(self):
        """취소·강제 종료로 마감에 못 가면 중간 기록만 남고 INCOMPLETE 로 읽힌다."""
        rec = cp.ChunkRecorder()
        rec.open()
        self.assertEqual(cp.read_run_status(rec.root), cp.STATUS_INCOMPLETE)
        self.assertFalse(os.path.isfile(os.path.join(rec.root, cp.MANIFEST_NAME)))


class RecordFailureDoesNotHarmOutputTest(_BundleJobBase):
    def test_wav_survives_and_original_result_stands_when_recording_fails(self):
        real_write = cp.ChunkRecorder.write

        def boom(inner_self, *a, **k):
            raise OSError("DISK_FULL")

        with mock.patch.object(cp.ChunkRecorder, "write", new=boom):
            self._synth()                       # 예외가 밖으로 나오면 안 된다
        published = os.path.join(self.out, "synthesized.wav")
        self.assertTrue(os.path.isfile(published), "기록 실패로 사용자 WAV 가 사라졌다")
        self.assertGreater(os.path.getsize(published), 0)
        warns = [k for mt, k in self.events if mt == "warning"]
        self.assertTrue(any(w.get("code") == "RECORD_INCOMPLETE" for w in warns),
                        "기록 실패를 알리지 않았다: %s" % warns)
        results = [k for mt, k in self.events if mt == "result"]
        self.assertEqual(len(results), 1, "기록 실패가 결과 발행을 바꾸면 안 된다")
        root = self._bundle_root()
        self.assertTrue(os.path.isfile(os.path.join(root, "record-incomplete.json")),
                        "복구 가능한 임시 기록이 없다")
        self.assertEqual(cp.read_run_status(root), cp.STATUS_INCOMPLETE)
        self.assertIs(cp.ChunkRecorder.write, real_write)


class StatusMappingTest(unittest.TestCase):
    """예외 → 상태 매핑은 한 곳에서만 정해진다."""

    def test_ok_partial_cancelled_failed(self):
        self.assertEqual(tts_worker._run_record_status_for(None), ("ok", None))
        st, code = tts_worker._run_record_status_for(
            tts_worker.QwenGenerationLimitError(0, 10, 10, "default", 0))
        self.assertEqual((st, code), ("partial", "GENERATION_LIMIT_EXCEEDED"))
        st, _ = tts_worker._run_record_status_for(RuntimeError("x"))
        self.assertEqual(st, "failed")

    def test_partial_codes_are_named_not_guessed(self):
        self.assertIn("GENERATION_LIMIT_EXCEEDED", tts_worker._PARTIAL_ERROR_CODES)
        self.assertIn("JOB_WALL_TIME_EXCEEDED", tts_worker._PARTIAL_ERROR_CODES)


class GitHygieneTest(unittest.TestCase):
    """번들·private JSON·WAV 는 Git 에 들어가지 않는다."""

    def test_local_tree_is_ignored(self):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        p = os.path.join(root, ".gitignore")
        self.assertTrue(os.path.isfile(p), ".gitignore 가 없다")
        with open(p, encoding="utf-8") as f:
            body = f.read()
        self.assertTrue(any(line.strip().strip("/") == "_local"
                            for line in body.splitlines()),
                        "_local 이 무시 목록에 없다 — 기록이 Git 으로 새어 나간다")


if __name__ == "__main__":
    unittest.main()
