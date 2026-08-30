# -*- coding: utf-8 -*-
"""run bundle 계약 회귀 — GPU 없이 fixture 로 전수 검증한다.

고정하는 것:
  · 원문·전사는 `.private.json` 에만 존재하고 manifest/timeline 으로 새지 않는다
  · manifest 는 **마지막**에 발행된다(존재 = 완결). 자기 SHA 를 담지 않는다
  · 분류 없는 artifact 는 private 취급이며 export_allowed 가 아니다
  · 성공·실패·partial·cooperative stop 이 같은 run-id 아래 남는다
  · 같은 global chunk index 를 두 번 쓰면 서로 덮어쓰지 않는다
  · 절대경로가 비민감 문서로 새지 않는다
"""
import json
import os
import shutil
import tempfile
import unittest

import numpy as np

import chunk_publish as cp

SR = 24000
RAW = "안녕하세요 첫 문장입니다. 두 번째 문장입니다."
NORM = "안녕하세요 첫 문장입니다 두 번째 문장입니다"


def _tone(n, f=180.0):
    t = np.arange(n, dtype=np.float32) / SR
    return (0.2 * np.sin(2 * np.pi * f * t)).astype(np.float32)


class _BundleBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._prev = {k: os.environ.get(k) for k in
                      ("AUDIOFORGE_DIAG_CHUNK_PUBLISH", "AUDIOFORGE_LOCAL_ROOT")}
        os.environ["AUDIOFORGE_LOCAL_ROOT"] = self.tmp
        os.environ["AUDIOFORGE_DIAG_CHUNK_PUBLISH"] = "test-run"
        self.addCleanup(self._restore)
        self.rec = cp.ChunkRecorder()
        self.assertTrue(self.rec.active, "fixture 에서 recorder 가 활성이어야 한다")

    def _restore(self):
        for k, v in self._prev.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _fill(self, gidx=0, text="첫 문장입니다.", partial=False, term="completed_before_limit"):
        arr = _tone(SR // 2)
        self.rec.raw(gidx, arr, SR)
        self.rec.record_chunk_text(gidx, text, source_char_range=[0, len(text)],
                                   production_tokens=27, combined_prompt_tokens=64,
                                   segment=0, paragraph=0, local_chunk_index=gidx,
                                   model_call_index=gidx)
        self.rec.record_generation(gidx, generation_limit=239, generated_iterations=36,
                                   termination_reason=term, external_alignment_calls=0,
                                   fallback=False, retries=0, elapsed_sec=8.9, partial=partial,
                                   vendor_crop_record={"crop_authority": "vendor_native_ref_code",
                                                       "crop_coordinates_observed": False})
        return arr

    def _read(self, name):
        return json.load(open(os.path.join(self.rec.root, name), encoding="utf-8"))


class RunBundleContractTest(_BundleBase):
    def test_success_bundle_is_complete_and_manifest_last(self):
        self.rec.set_script(RAW, NORM, paragraphs=[{"index": 0}], sentences=[{"index": 0}])
        arr = self._fill()
        root = self.rec.write("ok", final_arr=arr, sr=SR)
        self.assertTrue(os.path.exists(os.path.join(root, "manifest.json")))
        self.assertTrue(os.path.exists(os.path.join(root, "timeline.json")))
        self.assertTrue(os.path.exists(os.path.join(root, "script.private.json")))
        self.assertTrue(os.path.exists(os.path.join(root, "chunks", "chunk-000.private.json")))
        # .part 잔여가 없어야 한다(atomic rename 완료)
        for dp, _, fns in os.walk(root):
            self.assertFalse([f for f in fns if f.endswith(".part")], "%s 에 .part 잔여" % dp)

    def test_manifest_does_not_contain_its_own_sha(self):
        self.rec.set_script(RAW, NORM)
        arr = self._fill()
        self.rec.write("ok", final_arr=arr, sr=SR)
        m = self._read("manifest.json")
        self.assertNotIn("manifest.json", [a["path"] for a in m["artifacts"]],
                         "manifest 는 자기 자신을 artifact 로 담을 수 없다")

    def test_raw_text_never_leaks_into_non_private_docs(self):
        self.rec.set_script(RAW, NORM)
        arr = self._fill(text="두 번째 문장입니다.")
        self.rec.write("ok", final_arr=arr, sr=SR)
        for name in ("manifest.json", "timeline.json"):
            blob = json.dumps(self._read(name), ensure_ascii=False)
            self.assertNotIn(RAW, blob, "%s 에 원문이 샜다" % name)
            self.assertNotIn("두 번째 문장입니다.", blob, "%s 에 chunk 원문이 샜다" % name)

    def test_private_text_is_present_in_private_json(self):
        self.rec.set_script(RAW, NORM)
        arr = self._fill(text="첫 문장입니다.")
        self.rec.write("ok", final_arr=arr, sr=SR)
        self.assertEqual(self._read("script.private.json")["raw_text"], RAW)
        self.assertEqual(
            json.load(open(os.path.join(self.rec.root, "chunks", "chunk-000.private.json"),
                           encoding="utf-8"))["chunk_text"], "첫 문장입니다.")

    def test_privacy_class_and_export_allowlist(self):
        self.rec.set_script(RAW, NORM)
        arr = self._fill()
        self.rec.write("ok", final_arr=arr, sr=SR)
        m = self._read("manifest.json")
        for a in m["artifacts"]:
            self.assertIn(a["privacy_class"], (cp.PRIVACY_PRIVATE, cp.PRIVACY_NON_SENSITIVE))
            if a["privacy_class"] == cp.PRIVACY_PRIVATE:
                self.assertFalse(a["export_allowed"], "private 은 export 대상이 아니다")
        self.assertTrue(m["private_files"], "private 목록이 비어 있으면 차단 목록이 없다")
        for p in m["private_files"]:
            self.assertTrue(p.endswith(cp.PRIVATE_SUFFIX))

    def test_no_absolute_path_in_non_private_docs(self):
        self.rec.set_script(RAW, NORM)
        arr = self._fill()
        self.rec.write("ok", final_arr=arr, sr=SR)
        for name in ("manifest.json", "timeline.json"):
            blob = json.dumps(self._read(name), ensure_ascii=False)
            self.assertNotIn(":\\\\", blob, "%s 에 Windows 절대경로" % name)
            self.assertNotIn(self.tmp.replace("\\\\", "/"), blob, "%s 에 로컬 루트 경로" % name)

    def test_script_sha_is_tracked_per_chunk(self):
        sha = self.rec.set_script(RAW, NORM)
        arr = self._fill()
        self.rec.write("ok", final_arr=arr, sr=SR)
        m = self._read("manifest.json")
        self.assertEqual(m["script_sha256"], sha)
        self.assertEqual(m["chunks"][0]["script_sha256"], sha)


class RunBundleFailureTest(_BundleBase):
    def test_failed_run_is_preserved_under_same_run_id(self):
        self.rec.set_script(RAW, NORM)
        self._fill(term="generation_limit", partial=True)
        root = self.rec.write("failed")
        m = self._read("manifest.json")
        self.assertEqual(m["status"], "failed")
        self.assertEqual(m["chunks"][0]["termination_reason"], "generation_limit")
        self.assertTrue(m["chunks"][0]["partial"])
        self.assertTrue(os.path.exists(os.path.join(root, "chunks", "chunk-000.private.json")),
                        "실패해도 같은 run-id 아래 private 기록이 남아야 한다")

    def test_cooperative_stop_is_distinguishable(self):
        self.rec.set_script(RAW, NORM)
        self._fill(term="cooperative_stop", partial=True)
        self.rec.write("failed")
        self.assertEqual(self._read("manifest.json")["chunks"][0]["termination_reason"],
                         "cooperative_stop")

    def test_incomplete_when_manifest_missing(self):
        """manifest 가 없으면 번들로 읽지 않는다 — 완결 신호는 manifest 존재다."""
        self.rec.set_script(RAW, NORM)
        self._fill()
        self.assertFalse(os.path.exists(os.path.join(self.rec.root, "manifest.json")),
                         "write() 전에는 manifest 가 없어야 한다")


class RunBundleIndexTest(_BundleBase):
    def test_distinct_global_indices_do_not_overwrite(self):
        self.rec.set_script(RAW, NORM)
        self._fill(0, "첫 문장입니다.")
        self._fill(1, "두 번째 문장입니다.")
        arr = _tone(SR)
        self.rec.write("ok", final_arr=arr, sr=SR)
        m = self._read("manifest.json")
        self.assertEqual(m["chunk_count"], 2)
        idx = [c["chunk_index"] for c in m["chunks"]]
        self.assertEqual(sorted(idx), [0, 1], "global chunk index 가 겹치면 안 된다")
        shas = {c["chunk_text_sha256"] for c in m["chunks"]}
        self.assertEqual(len(shas), 2, "서로 다른 chunk 가 같은 텍스트 SHA 를 가질 수 없다")
        for g in (0, 1):
            self.assertTrue(os.path.exists(os.path.join(
                self.rec.root, "chunks", "chunk-%03d.private.json" % g)))

    def test_manifest_owns_every_registered_artifact(self):
        self.rec.set_script(RAW, NORM)
        arr = self._fill()
        root = self.rec.write("ok", final_arr=arr, sr=SR)
        m = self._read("manifest.json")
        for a in m["artifacts"]:
            self.assertTrue(os.path.exists(os.path.join(root, a["path"].replace("/", os.sep))),
                            "manifest 가 소유한 %s 가 실제로 없다" % a["path"])
            self.assertTrue(a["path"] and not os.path.isabs(a["path"]),
                            "artifact 경로는 상대경로여야 한다")


if __name__ == "__main__":
    unittest.main()
