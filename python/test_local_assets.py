# -*- coding: utf-8 -*-
"""로컬 자산 루트 해석·생성 검증 — 파일시스템만 쓰고 GPU·네트워크 0."""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import local_assets as la
import icl_diagnostics
import app_runtime


class TestLocalAssets(unittest.TestCase):
    def setUp(self):
        self._env = os.environ.get(la.LOCAL_ROOT_ENV)
        self.tmp = tempfile.mkdtemp(prefix="af-local-")

    def tearDown(self):
        if self._env is None:
            os.environ.pop(la.LOCAL_ROOT_ENV, None)
        else:
            os.environ[la.LOCAL_ROOT_ENV] = self._env
        shutil.rmtree(self.tmp, ignore_errors=True)

    # 1. 기본은 **본체 저장소**의 _local — worktree 안에 만들지 않는다
    def test_default_root_is_main_repo(self):
        os.environ.pop(la.LOCAL_ROOT_ENV, None)
        self.assertEqual(os.path.normcase(la.local_root()),
                         os.path.normcase(os.path.join(app_runtime.main_repo_root(), "_local")))
        here = os.path.dirname(os.path.abspath(__file__))
        worktree_root = os.path.dirname(here)
        self.assertNotEqual(os.path.normcase(la.local_root()),
                            os.path.normcase(os.path.join(worktree_root, "_local")))

    # 2. 환경변수가 언제나 이긴다
    def test_env_override_wins(self):
        os.environ[la.LOCAL_ROOT_ENV] = self.tmp
        self.assertEqual(os.path.normcase(la.local_root()), os.path.normcase(self.tmp))
        self.assertEqual(la.resolve_source(), "env:" + la.LOCAL_ROOT_ENV)

    # 3. 최초 생성 + 재실행 멱등 (공백·한글이 든 경로에서도)
    def test_create_and_idempotent_in_unicode_path(self):
        base = os.path.join(self.tmp, "새 폴더 test 저장소")
        os.makedirs(base)
        os.environ[la.LOCAL_ROOT_ENV] = base
        root, created = la.ensure_structure()
        self.assertEqual(sorted(created), sorted(r for r, _ in la.STRUCTURE))
        for rel, _ in la.STRUCTURE:
            self.assertTrue(os.path.isdir(os.path.join(base, rel.replace("/", os.sep))), rel)
        root2, created2 = la.ensure_structure()
        self.assertEqual(created2, [], "두 번째 실행에서 다시 만들면 멱등이 아니다")
        self.assertEqual(os.path.normcase(root), os.path.normcase(root2))

    # 4. 기존 파일을 덮어쓰거나 초기화하지 않는다
    def test_never_overwrites_existing(self):
        os.environ[la.LOCAL_ROOT_ENV] = self.tmp
        la.ensure_structure()
        keep = os.path.join(self.tmp, "assets", "golden", "keep.txt")
        with open(keep, "w", encoding="utf-8") as f:
            f.write("사용자 자료")
        la.ensure_structure()
        with open(keep, encoding="utf-8") as f:
            self.assertEqual(f.read(), "사용자 자료")

    # 5. _local/runtime 은 만들지 않는다(실제 런타임은 externals/runtime)
    def test_runtime_dir_not_created(self):
        os.environ[la.LOCAL_ROOT_ENV] = self.tmp
        la.ensure_structure()
        self.assertFalse(os.path.isdir(os.path.join(self.tmp, "runtime")),
                         "_local/runtime 을 만들면 소비 경로로 오독된다")
        self.assertNotIn("runtime", [r.split("/")[0] for r, _ in la.STRUCTURE])

    # 6. managed / read-only 구분
    def test_managed_classification(self):
        self.assertTrue(la.is_managed("artifacts/diagnostics"))
        self.assertTrue(la.is_managed("artifacts/generated"))
        for rel in ("assets/originals", "assets/references", "assets/golden",
                    "artifacts/drafts", "artifacts/recovery", "manifests"):
            self.assertFalse(la.is_managed(rel), "%s 는 앱 자동정리 대상이 아니다" % rel)

    # 7. 진단은 사용자 출력 폴더가 아니라 _local 로 간다
    def test_diagnostics_go_to_local_not_user_output(self):
        os.environ[la.LOCAL_ROOT_ENV] = self.tmp
        user_out = os.path.join(self.tmp, "user-output")
        os.makedirs(user_out)
        root = icl_diagnostics.diagnostics_root(user_out)
        self.assertIsNotNone(root)
        self.assertTrue(os.path.normcase(root).startswith(os.path.normcase(self.tmp)))
        self.assertNotIn(os.path.normcase("user-output"), os.path.normcase(root))
        self.assertIn("diagnostics", root.replace("\\", "/"))

    # 8. 다른 host 의 기록(실재하지 않는 경로)은 조용히 쓰이지 않는다
    def test_stale_recorded_root_is_ignored(self):
        os.environ.pop(la.LOCAL_ROOT_ENV, None)
        cfg = app_runtime.config_path()
        os.makedirs(os.path.dirname(cfg), exist_ok=True)
        backup = None
        if os.path.isfile(cfg):
            with open(cfg, encoding="utf-8") as f:
                backup = f.read()
        try:
            stale = os.path.join(self.tmp, "다른-host-에만-있는-경로")   # 만들지 않는다
            base = json.loads(backup) if backup else {}
            base["local_root"] = stale
            with open(cfg, "w", encoding="utf-8") as f:
                json.dump(base, f, ensure_ascii=False)
            self.assertIsNone(la._recorded_root(), "실재하지 않는 기록을 채택했다")
            self.assertEqual(la.resolve_source(), "main_repo")
            self.assertNotEqual(os.path.normcase(la.local_root()), os.path.normcase(stale))
        finally:
            if backup is None:
                os.remove(cfg)
            else:
                with open(cfg, "w", encoding="utf-8") as f:
                    f.write(backup)


class TestNoAbsolutePathsInSource(unittest.TestCase):
    """production source 에 특정 사용자/드라이브 절대경로가 남아 있지 않은지."""

    def test_zero_absolute_paths(self):
        import re
        here = os.path.dirname(os.path.abspath(__file__))
        root = os.path.dirname(here)
        pat = re.compile(r"[A-Za-z]:[\\/](?:Users|AI|ProgramData)\b")
        bad = []
        for base, sub in ((os.path.join(root, "python"), ".py"),
                          (os.path.join(root, "src"), (".ts", ".tsx"))):
            for dp, dns, fns in os.walk(base):
                dns[:] = [d for d in dns if d not in ("__pycache__", "node_modules")]
                for fn in fns:
                    if not fn.endswith(sub) or fn.startswith("test_") or ".test." in fn:
                        continue
                    fp = os.path.join(dp, fn)
                    with open(fp, encoding="utf-8", errors="replace") as f:
                        for i, line in enumerate(f, 1):
                            if pat.search(line):
                                bad.append("%s:%d" % (os.path.relpath(fp, root), i))
        self.assertEqual(bad, [], "production source 절대경로: %s" % bad)


if __name__ == "__main__":
    unittest.main(verbosity=2)
