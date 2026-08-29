# -*- coding: utf-8 -*-
"""내부 snapshot 해석 계약 — 전역 환경을 바꾸지 않고, 전역 캐시로 새지 않는다."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import model_registry as mr
import app_runtime

WATCHED = ("HF_HOME", "HUGGINGFACE_HUB_CACHE", "TRANSFORMERS_CACHE",
           "XDG_CACHE_HOME", "HOME", "USERPROFILE")


class TestSnapshotResolution(unittest.TestCase):
    def test_snapshot_is_exact_revision_dir_under_externals(self):
        man = mr.load_manifest()
        internal = [m for m in man["models"] if m.get("status") == "INTERNALIZED" and m.get("revision")]
        self.assertTrue(internal, "내부화된 HF 모델이 없다")
        root = os.path.realpath(app_runtime.assets_root())
        for m in internal:
            snap = mr.snapshot_path(m["model"])
            self.assertTrue(snap.endswith(m["revision"]), "정확한 revision 디렉터리가 아니다")
            real = os.path.realpath(snap)
            self.assertEqual(os.path.commonpath([root, real]), root, "externals 밖을 가리킨다")
            self.assertTrue(os.path.isdir(snap))

    def test_required_files_present(self):
        for m in mr.load_manifest()["models"]:
            if m.get("status") != "INTERNALIZED" or not m.get("file_sha256"):
                continue
            snap = mr.snapshot_path(m["model"])
            for rel in m["file_sha256"]:
                self.assertTrue(os.path.isfile(os.path.join(snap, rel.replace("/", os.sep))), rel)

    def test_unknown_model_is_structured_error(self):
        with self.assertRaises(mr.ModelRegistryError) as cm:
            mr.snapshot_path("acme/__definitely_absent__")
        self.assertIn("MODEL_NOT_IN_MANIFEST", str(cm.exception))

    def test_resolution_does_not_touch_global_env(self):
        before = {k: os.environ.get(k) for k in WATCHED}
        for m in mr.load_manifest()["models"]:
            if m.get("status") == "INTERNALIZED" and m.get("revision"):
                mr.snapshot_path(m["model"])
        mr.whisper_checkpoint("large-v3")
        after = {k: os.environ.get(k) for k in WATCHED}
        self.assertEqual(before, after, "resolver 가 전역 환경변수를 변경했다")

    def test_repeated_calls_do_not_cross_contaminate(self):
        a = mr.snapshot_path("facebook/nllb-200-distilled-600M")
        b = mr.snapshot_path("Qwen/Qwen2.5-3B-Instruct")
        c = mr.snapshot_path("facebook/nllb-200-distilled-600M")
        self.assertEqual(a, c, "다른 모델 해석이 앞선 경로를 오염시켰다")
        self.assertNotEqual(a, b)

    def test_loader_uses_snapshot_path_not_cache_dir(self):
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "transcribe_worker.py"), encoding="utf-8").read()
        self.assertIn("model_registry.snapshot_path(model_name)", src)
        self.assertIn("AutoTokenizer.from_pretrained(\n            snap", src)
        # 전역 환경을 바꾸는 방식이 다시 들어오지 않게 고정한다.
        for bad in ('os.environ["HF_HOME"]', "os.environ['HF_HOME']",
                    'os.environ["HUGGINGFACE_HUB_CACHE"]'):
            self.assertNotIn(bad, src, "process 전역 HF 환경을 변경한다")


if __name__ == "__main__":
    unittest.main(verbosity=2)
