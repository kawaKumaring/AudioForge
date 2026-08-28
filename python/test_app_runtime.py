#!/usr/bin/env python3
"""app_runtime 판정 규칙 회귀 테스트 — 표준 라이브러리만, 새 의존성 0.

무엇을 지키는 테스트인가
------------------------
2026-08-29 사고에서 venv 디렉터리와 python.exe 는 남고 site-packages 의 일부
구간만 사라졌다. "폴더가 있으니 정상"이라는 판정이 그 상태를 통과시켰다.
여기서는 그 상태가 **반드시 불합격으로 잡히는지**를 고정한다.

경로에 공백과 한글이 섞여도 같은 결론이 나오는지도 함께 고정한다.
GPU·모델·네트워크가 전혀 없어도 돌아간다.

실행:
  <python> python/test_app_runtime.py
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import app_runtime as rt  # noqa: E402

# 공백 + 한글 + 대괄호. 윈도우에서 자주 깨지는 조합을 일부러 쓴다.
AWKWARD = "앱 런타임 [테스트] dir"

# 테스트용 축소 명세 — 실제 모델(수백 MB) 없이 판정 규칙만 검사한다.
FAKE_SPEC = {
    "components": {
        "gptsovits": {
            "model_files": [
                {"path": "GPT_SoVITS/pretrained_models/fake/weights.bin", "min_bytes": 32},
            ]
        }
    }
}


class RuntimeCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af-rt-")
        self.root = os.path.join(self.tmp, AWKWARD, "externals")
        os.makedirs(self.root)
        self._saved = os.environ.get("AUDIOFORGE_RUNTIME_ROOT")
        os.environ["AUDIOFORGE_RUNTIME_ROOT"] = self.root

    def tearDown(self):
        if self._saved is None:
            os.environ.pop("AUDIOFORGE_RUNTIME_ROOT", None)
        else:
            os.environ["AUDIOFORGE_RUNTIME_ROOT"] = self._saved
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ── 도우미: 그럴듯한 venv 와 repo 를 만든다 ──────────────────────────

    def _make_venv(self, name="venv", dists=("torch-2.11.0.dist-info", "numpy-1.26.4.dist-info")):
        venv = os.path.join(self.root, name)
        site = rt.venv_site_packages(venv)
        os.makedirs(site)
        os.makedirs(os.path.dirname(rt.venv_python(venv)), exist_ok=True)
        with open(rt.venv_python(venv), "wb") as f:
            f.write(b"x" * 1024)
        for d in dists:
            os.makedirs(os.path.join(site, d))
        return venv

    def _make_repo(self, size=64):
        repo = os.path.join(self.root, "GPT-SoVITS")
        p = os.path.join(repo, "GPT_SoVITS", "pretrained_models", "fake")
        os.makedirs(p)
        with open(os.path.join(p, "weights.bin"), "wb") as f:
            f.write(b"w" * size)
        return repo

    def _link(self, venv, repo, verified=True, fingerprint=None):
        cfg = rt.load_config()
        cfg["components"]["gptsovits"] = {
            "status": "linked",
            "python": rt.venv_python(venv),
            "venv": venv,
            "repo": repo,
            "fingerprint": fingerprint if fingerprint is not None else rt.venv_fingerprint(venv),
            "verification": {"ok": verified, "at": "test"},
        }
        rt.save_config(cfg)

    # ── 경로 해석 ────────────────────────────────────────────────────────

    def test_runtime_root_honours_env_with_space_and_hangul(self):
        self.assertEqual(rt.runtime_root(), self.root)
        self.assertIn(AWKWARD, rt.config_path())

    def test_missing_config_is_empty_not_error(self):
        cfg = rt.load_config()
        self.assertEqual(cfg["components"], {})
        self.assertNotIn("_unreadable", cfg)

    def test_corrupt_config_is_flagged_not_silently_overwritten(self):
        with open(rt.config_path(), "w", encoding="utf-8") as f:
            f.write("{ this is not json")
        cfg = rt.load_config()
        self.assertTrue(cfg.get("_unreadable"))
        self.assertEqual(cfg["components"], {})

    def test_save_config_roundtrip_leaves_no_temp_file(self):
        rt.save_config({"schema": 1, "components": {"x": {"a": 1}}})
        self.assertEqual(rt.load_config()["components"]["x"]["a"], 1)
        leftovers = [n for n in os.listdir(self.root) if n.startswith(".runtime-")]
        self.assertEqual(leftovers, [])

    # ── 지문 ─────────────────────────────────────────────────────────────

    def test_fingerprint_changes_when_packages_disappear(self):
        """2026-08-29 사고 재현: 디렉터리는 남고 패키지만 사라진다."""
        venv = self._make_venv(dists=("a-1.dist-info", "b-1.dist-info", "c-1.dist-info"))
        before = rt.venv_fingerprint(venv)
        self.assertEqual(before["distributions"], 3)

        shutil.rmtree(os.path.join(rt.venv_site_packages(venv), "a-1.dist-info"))
        after = rt.venv_fingerprint(venv)

        self.assertTrue(os.path.exists(rt.venv_python(venv)),
                        "인터프리터는 그대로 남아 있어야 사고 상황이 재현된다")
        self.assertEqual(after["distributions"], 2)
        self.assertNotEqual(before["sha256"], after["sha256"])

    def test_fingerprint_stable_across_calls(self):
        venv = self._make_venv()
        self.assertEqual(rt.venv_fingerprint(venv)["sha256"],
                         rt.venv_fingerprint(venv)["sha256"])

    # ── 판정 ─────────────────────────────────────────────────────────────

    def test_not_linked_when_no_record(self):
        self._make_venv("gptsovits_venv")
        self._make_repo()
        p = rt.probe_gptsovits(spec=FAKE_SPEC)
        self.assertFalse(p["ok"])
        self.assertEqual(p["reason"], "NOT_LINKED")
        self.assertEqual(p["source"], "legacy")

    def test_linked_and_verified_is_ok(self):
        venv, repo = self._make_venv(), self._make_repo()
        self._link(venv, repo)
        p = rt.probe_gptsovits(spec=FAKE_SPEC)
        self.assertTrue(p["ok"], p)
        self.assertEqual(p["source"], "runtime.json")

    def test_python_missing_is_detected(self):
        venv, repo = self._make_venv(), self._make_repo()
        self._link(venv, repo)
        os.remove(rt.venv_python(venv))
        self.assertEqual(rt.probe_gptsovits(spec=FAKE_SPEC)["reason"], "PYTHON_MISSING")

    def test_repo_missing_is_detected(self):
        venv, repo = self._make_venv(), self._make_repo()
        self._link(venv, repo)
        shutil.rmtree(repo)
        self.assertEqual(rt.probe_gptsovits(spec=FAKE_SPEC)["reason"], "REPO_MISSING")

    def test_truncated_model_file_is_not_accepted(self):
        """0 바이트 껍데기를 정상으로 보지 않는다."""
        venv, repo = self._make_venv(), self._make_repo(size=1)
        self._link(venv, repo)
        p = rt.probe_gptsovits(spec=FAKE_SPEC)
        self.assertEqual(p["reason"], "MODEL_INCOMPLETE")
        self.assertEqual(p["details"]["missing"][0]["size"], 1)

    def test_package_loss_after_link_is_caught(self):
        """설치·연결 후에 패키지가 사라지면 다음 점검에서 반드시 잡힌다."""
        venv = self._make_venv(dists=("a-1.dist-info", "b-1.dist-info"))
        repo = self._make_repo()
        self._link(venv, repo)
        self.assertTrue(rt.probe_gptsovits(spec=FAKE_SPEC)["ok"])

        shutil.rmtree(os.path.join(rt.venv_site_packages(venv), "a-1.dist-info"))
        p = rt.probe_gptsovits(spec=FAKE_SPEC)
        self.assertFalse(p["ok"])
        self.assertEqual(p["reason"], "FINGERPRINT_MISMATCH")
        self.assertIn("2", p["details"]["hint"])  # 2개 -> 1개 로 줄었다는 사실이 보여야 한다

    def test_record_without_verification_is_not_ok(self):
        venv, repo = self._make_venv(), self._make_repo()
        self._link(venv, repo, verified=False)
        self.assertEqual(rt.probe_gptsovits(spec=FAKE_SPEC)["reason"], "NOT_VERIFIED")

    def test_record_without_fingerprint_is_not_ok(self):
        venv, repo = self._make_venv(), self._make_repo()
        self._link(venv, repo, fingerprint={})
        self.assertEqual(rt.probe_gptsovits(spec=FAKE_SPEC)["reason"], "NO_FINGERPRINT")

    def test_every_reason_has_korean_text(self):
        for reason in rt.REASON_TEXT:
            self.assertTrue(rt.describe(reason))
        self.assertEqual(rt.describe(None), "")

    # ── 다른 구성요소 보존 ───────────────────────────────────────────────

    def test_linking_gptsovits_preserves_other_components(self):
        """Qwen 등 이미 정상인 연결을 설치기가 지우지 않는다."""
        cfg = rt.load_config()
        cfg["components"]["qwen3"] = {"status": "linked", "python": "Q:/qwen/python.exe"}
        rt.save_config(cfg)

        venv, repo = self._make_venv(), self._make_repo()
        self._link(venv, repo)

        after = rt.load_config()["components"]
        self.assertIn("qwen3", after)
        self.assertEqual(after["qwen3"]["python"], "Q:/qwen/python.exe")
        self.assertIn("gptsovits", after)

    def test_resolve_falls_back_to_legacy_paths(self):
        paths = rt.resolve_gptsovits()
        self.assertEqual(paths["source"], "legacy")
        self.assertTrue(paths["python"].endswith(os.path.join("Scripts", "python.exe")))
        self.assertIn("gptsovits_venv", paths["python"])


class SpecCase(unittest.TestCase):
    """저장소에 커밋된 설치 명세 자체의 최소 무결성."""

    def setUp(self):
        self.spec = rt.load_spec()

    def test_interpreter_pins_are_present(self):
        i = self.spec["interpreter"]
        self.assertRegex(i["sha256"], r"^[0-9a-f]{64}$")
        self.assertTrue(i["url"].startswith("https://github.com/astral-sh/python-build-standalone/"))
        self.assertIn(i["release_tag"], i["url"])
        self.assertGreater(i["download_bytes"], 0)
        self.assertTrue(i["license"])

    def test_component_declares_license_and_models(self):
        c = self.spec["components"]["gptsovits"]
        self.assertTrue(c["license"])
        self.assertGreaterEqual(len(c["model_files"]), 4)
        for m in c["model_files"]:
            self.assertGreater(m["min_bytes"], 0)

    def test_japanese_only_dependency_is_explicitly_excluded(self):
        """이번 범위는 한국어 복구다. 일본어 전용 의존성이 슬며시 들어오지 않게 고정."""
        c = self.spec["components"]["gptsovits"]
        allp = c["packages"] + c["optional_packages"] + c["torch"]["packages"]
        self.assertNotIn("pyopenjtalk", [p.split("==")[0] for p in allp])
        self.assertIn("pyopenjtalk", c["excluded_packages"])

    def test_verify_imports_cover_the_shims(self):
        v = self.spec["components"]["gptsovits"]["verify"]["imports"]
        for shim in ("jieba_fast", "eunjeon"):
            self.assertIn(shim, v, "shim 은 반드시 실제 import 로 검증돼야 한다")


if __name__ == "__main__":
    unittest.main(verbosity=2)
