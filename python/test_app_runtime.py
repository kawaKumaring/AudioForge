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
        # 런타임(앱 소유)과 자산(외부 참조) 양쪽을 임시 폴더로 묶어 실제 설치와 격리한다.
        self._saved = {k: os.environ.get(k)
                       for k in ("AUDIOFORGE_RUNTIME_ROOT", "AUDIOFORGE_ASSETS_ROOT")}
        os.environ["AUDIOFORGE_RUNTIME_ROOT"] = self.root
        os.environ["AUDIOFORGE_ASSETS_ROOT"] = self.root

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
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

    def _link(self, venv, repo, verified=True, fingerprint=None, host=None):
        cfg = rt.load_config()
        entry = {
            "status": "linked",
            "python": rt.venv_python(venv),
            "venv": venv,
            "repo": repo,
            "owned": {"runtime_root": rt.runtime_root(), "venv": venv,
                      "python": rt.venv_python(venv), "managed": True},
            "external": {"repo": {"path": repo, "managed": False}},
            "fingerprint": fingerprint if fingerprint is not None else rt.venv_fingerprint(venv),
            "verification": {"ok": verified, "at": "test"},
        }
        if host is not None:
            entry["recorded_on"] = {"host": host}
        cfg["components"]["gptsovits"] = entry
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

    def test_legacy_paths_come_from_assets_root_not_runtime_root(self):
        """예전 venv 는 externals/ 바로 밑에 있었다. 런타임 루트를 옮겨도 거기를 봐야 한다."""
        other = os.path.join(self.tmp, "다른 런타임")
        os.makedirs(other)
        os.environ["AUDIOFORGE_RUNTIME_ROOT"] = other
        paths = rt.resolve_gptsovits()
        self.assertTrue(paths["python"].startswith(self.root), paths["python"])
        self.assertFalse(paths["python"].startswith(other), paths["python"])

    # ── 앱 소유 vs 외부 참조 ─────────────────────────────────────────────

    def test_record_separates_owned_runtime_from_external_asset(self):
        venv, repo = self._make_venv(), self._make_repo()
        self._link(venv, repo)
        comp = rt.load_config()["components"]["gptsovits"]
        self.assertTrue(comp["owned"]["managed"], "venv 는 앱이 소유·관리한다")
        self.assertFalse(comp["external"]["repo"]["managed"],
                         "코드·모델은 외부 참조 — 설치기의 수정·삭제 대상이 아니다")
        self.assertTrue(rt.resolve_gptsovits()["owned"])

    def test_legacy_resolution_is_not_marked_owned(self):
        self.assertFalse(rt.resolve_gptsovits()["owned"])

    # ── 다른 PC 안내 ─────────────────────────────────────────────────────

    def test_record_from_other_host_is_named_not_silently_ignored(self):
        """다른 PC 의 경로가 무효일 때 조용히 예전 경로로 미끄러지지 않는다."""
        venv, repo = self._make_venv(), self._make_repo()
        self._link(venv, repo, host="다른PC")
        shutil.rmtree(venv)  # 그 PC 에만 있던 경로 = 여기엔 없다
        p = rt.probe_gptsovits(spec=FAKE_SPEC)
        self.assertFalse(p["ok"])
        self.assertEqual(p["reason"], "RECORDED_ON_OTHER_HOST")
        self.assertIn("다른PC", p["details"]["hint"])
        self.assertEqual(p["source"], "runtime.json",
                         "폴백하지 않고 기록을 그대로 가리켜야 원인이 보인다")

    def test_same_host_missing_python_keeps_plain_reason(self):
        venv, repo = self._make_venv(), self._make_repo()
        self._link(venv, repo, host=rt._hostname())
        shutil.rmtree(venv)
        self.assertEqual(rt.probe_gptsovits(spec=FAKE_SPEC)["reason"], "PYTHON_MISSING")


class MainRepoRootCase(unittest.TestCase):
    """작업 트리에서 실행해도 런타임 위치가 본체 저장소를 가리키는가.

    2026-08-29 에 런타임을 작업 트리 안에 만들었다가 트리 정리와 함께 잃었다.
    여기서 고정하는 것은 "어디에 만들 것인가"의 답이 체크아웃 위치에 흔들리지 않는다는 것.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af-wt-")
        self._saved = {k: os.environ.get(k)
                       for k in ("AUDIOFORGE_RUNTIME_ROOT", "AUDIOFORGE_ASSETS_ROOT")}
        os.environ.pop("AUDIOFORGE_RUNTIME_ROOT", None)
        os.environ.pop("AUDIOFORGE_ASSETS_ROOT", None)
        self._real_repo_root = rt.repo_root

    def tearDown(self):
        rt.repo_root = self._real_repo_root
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _fake_main(self, name="본체 repo"):
        main = os.path.join(self.tmp, name)
        os.makedirs(os.path.join(main, ".git", "worktrees"))
        return main

    def _fake_worktree(self, main, name="설치기 트리", gitdir=None):
        wt = os.path.join(self.tmp, name)
        os.makedirs(wt)
        target = gitdir or os.path.join(main, ".git", "worktrees", name)
        with open(os.path.join(wt, ".git"), "w", encoding="utf-8") as f:
            f.write(f"gitdir: {target.replace(os.sep, '/')}\n")
        return wt

    def _as_checkout(self, path):
        rt.repo_root = lambda: path

    def test_plain_clone_is_its_own_main(self):
        main = self._fake_main()
        self._as_checkout(main)
        self.assertEqual(rt.main_repo_root(), main)

    def test_worktree_resolves_to_main_repo(self):
        main = self._fake_main()
        wt = self._fake_worktree(main)
        self._as_checkout(wt)
        self.assertEqual(rt.main_repo_root(), main)

    def test_runtime_root_is_under_main_repo_not_the_worktree(self):
        main = self._fake_main()
        wt = self._fake_worktree(main)
        self._as_checkout(wt)
        self.assertEqual(rt.runtime_root(), os.path.join(main, "externals", "runtime"))
        self.assertEqual(rt.assets_root(), os.path.join(main, "externals"))
        self.assertNotIn(os.path.basename(wt), rt.runtime_root())

    def test_two_worktrees_of_same_main_agree(self):
        main = self._fake_main()
        a, b = self._fake_worktree(main, "트리 A"), self._fake_worktree(main, "트리 B")
        self._as_checkout(a)
        first = rt.runtime_root()
        self._as_checkout(b)
        self.assertEqual(first, rt.runtime_root())

    def test_explicit_override_wins_over_main_repo(self):
        main = self._fake_main()
        self._as_checkout(self._fake_worktree(main))
        chosen = os.path.join(self.tmp, "지정한 위치")
        os.environ["AUDIOFORGE_RUNTIME_ROOT"] = chosen
        self.assertEqual(rt.runtime_root(), os.path.abspath(chosen))

    def test_unparsable_gitdir_falls_back_to_this_checkout(self):
        """.git 을 못 읽어도 답은 나와야 한다 — 다만 조용히 엉뚱한 곳을 잡지 않는다."""
        wt = os.path.join(self.tmp, "고아 트리")
        os.makedirs(wt)
        with open(os.path.join(wt, ".git"), "w", encoding="utf-8") as f:
            f.write("이건 gitdir 줄이 아니다\n")
        self._as_checkout(wt)
        self.assertEqual(rt.main_repo_root(), wt)

    def test_gitdir_without_worktrees_segment_falls_back(self):
        main = self._fake_main()
        wt = self._fake_worktree(main, "이상한 트리", gitdir=os.path.join(self.tmp, "어딘가", ".git"))
        self._as_checkout(wt)
        self.assertEqual(rt.main_repo_root(), wt)


class LauncherAgreementCase(unittest.TestCase):
    """런처(Node)와 판정기(Python)가 같은 런타임 루트를 말하는가.

    af-launch.mjs 는 파이썬이 아직 없는 시점에 "어디에 내려받을지"를 정해야 해서
    같은 규칙을 Node 로 한 번 더 구현한다. 둘이 어긋나면 파이썬은 A 에 깔리고
    판정은 B 를 보게 되므로 영원히 재설치를 반복한다. 그 상태를 여기서 막는다.
    """

    def test_node_and_python_agree_on_runtime_root(self):
        import shutil as _sh
        import subprocess
        node = _sh.which("node")
        if not node:
            self.skipTest("node 없음 — 이 PC 에서는 일치 검사를 건너뛴다")
        script = os.path.join(rt.repo_root(), "scripts", "af-launch.mjs")
        # --where 는 아무것도 내려받지 않고 위치만 답한다. 테스트가 46 MiB 를
        # 끌고 오면 그건 테스트가 아니라 설치다.
        r = subprocess.run([node, script, "--where"], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=120,
                           cwd=rt.repo_root())
        self.assertEqual(r.returncode, 0, (r.stdout or "") + (r.stderr or ""))
        got = json.loads(r.stdout.strip().splitlines()[-1])
        for key in ("runtime_root", "main_repo"):
            self.assertEqual(
                os.path.normcase(os.path.abspath(got[key])),
                os.path.normcase(os.path.abspath(
                    rt.runtime_root() if key == "runtime_root" else rt.main_repo_root())),
                f"{key} 에서 Node 와 Python 의 판단이 다르다")


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
