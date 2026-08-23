# -*- coding: utf-8 -*-
"""runtime_paths 단위 계약 — synthetic (실모델·GPU·미디어·junction 0).

검증:
  - canonical-absolute 규칙이 공유 계약(runtimeContract.ts isCanonicalAbsolutePath)과 동형(parity)
  - configure 정상/무효(schema·상대경로·ownership) → NO_RUNTIME_ROOT
  - *_subdir 해석이 join과 동일(출력 불변: runtimeRoot==과거 base 면 과거 경로와 동일)
  - containment 위반(`..` 탈출) → PATH_OUTSIDE_ROOT
  - dangling(realpath null, 훅 주입) → DANGLING_JUNCTION
  - symlink escape(realpath가 root 밖, 훅 주입) → PATH_OUTSIDE_ROOT
  - 미주입 상태 subdir 호출 → NO_RUNTIME_ROOT (워크트리 폴백 없음)
  - can_write: managed True / borrowed False

실행: python python/test_runtime_paths.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import runtime_paths as rp


def _roots(runtime="C:/af/rt", model="C:/af/md", cache="C:/af/ch",
           rt_own="audioforge-managed", md_own="audioforge-managed", ch_own="audioforge-managed"):
    return {
        "schemaVersion": 2,
        "runtimeRoot": {"path": runtime, "ownership": rt_own},
        "modelRoot": {"path": model, "ownership": md_own},
        "cacheRoot": {"path": cache, "ownership": ch_own},
    }


class CanonicalAbsParity(unittest.TestCase):
    """공유 계약 runtimeContract.test.ts:258-263 과 동일 케이스로 규칙 동형 고정."""

    def test_absolute(self):
        self.assertTrue(rp.is_absolute_path("/usr/bin/python3"))
        self.assertTrue(rp.is_absolute_path("C:\\Python312\\python.exe"))
        self.assertTrue(rp.is_absolute_path("\\\\host\\share\\p"))
        self.assertFalse(rp.is_absolute_path("venv/bin/python"))

    def test_canonical(self):
        self.assertTrue(rp.is_canonical_absolute_path("C:/Python312/python.exe"))
        self.assertFalse(rp.is_canonical_absolute_path("C:/a/../b/python.exe"))
        # 상대경로는 canonical-abs 아님
        self.assertFalse(rp.is_canonical_absolute_path("venv/bin/python"))
        self.assertFalse(rp.is_canonical_absolute_path(""))
        self.assertFalse(rp.is_canonical_absolute_path(None))


class Configure(unittest.TestCase):
    def setUp(self):
        rp.reset()
        rp.set_path_resolver(None)

    def tearDown(self):
        rp.reset()
        rp.set_path_resolver(None)

    def test_valid(self):
        rp.configure(_roots())
        self.assertTrue(rp.is_configured())

    def test_schema_mismatch(self):
        r = _roots(); r["schemaVersion"] = 1
        with self.assertRaises(rp.RuntimeRootError) as cm:
            rp.configure(r)
        self.assertEqual(cm.exception.code, rp.NO_RUNTIME_ROOT)
        self.assertFalse(rp.is_configured())

    def test_relative_path_rejected(self):
        with self.assertRaises(rp.RuntimeRootError) as cm:
            rp.configure(_roots(model="externals/models"))
        self.assertEqual(cm.exception.code, rp.NO_RUNTIME_ROOT)

    def test_dotdot_path_rejected(self):
        with self.assertRaises(rp.RuntimeRootError) as cm:
            rp.configure(_roots(runtime="C:/af/../escape"))
        self.assertEqual(cm.exception.code, rp.NO_RUNTIME_ROOT)

    def test_bad_ownership_rejected(self):
        with self.assertRaises(rp.RuntimeRootError) as cm:
            rp.configure(_roots(md_own="borrowed"))
        self.assertEqual(cm.exception.code, rp.NO_RUNTIME_ROOT)

    def test_missing_root_rejected(self):
        r = _roots(); del r["cacheRoot"]
        with self.assertRaises(rp.RuntimeRootError):
            rp.configure(r)


class SubdirResolution(unittest.TestCase):
    def setUp(self):
        rp.reset()
        rp.set_path_resolver(None)
        rp.configure(_roots())

    def tearDown(self):
        rp.reset()
        rp.set_path_resolver(None)

    def test_runtime_subdir_equals_join(self):
        got = rp.runtime_subdir("gptsovits_venv", "Scripts", "python.exe")
        self.assertEqual(got, os.path.normpath("C:/af/rt/gptsovits_venv/Scripts/python.exe"))

    def test_model_subdir_equals_join(self):
        got = rp.model_subdir("separator_models")
        self.assertEqual(got, os.path.normpath("C:/af/md/separator_models"))

    def test_output_invariance_matches_legacy_base(self):
        # runtimeRoot/modelRoot를 과거 base(dirname(dirname(__file__))/externals) 로 두면
        # 최종 경로가 과거 os.path.join(base, "externals", ...) 과 동일해야 한다(경로 해석만 변경).
        rp.reset()
        legacy_base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        externals = os.path.normpath(os.path.join(legacy_base, "externals"))
        # 절대경로가 canonical 형태여야 configure가 받으므로 normpath 후 슬래시 정규화
        rp.configure(_roots(runtime=externals.replace("\\", "/"),
                            model=externals.replace("\\", "/"),
                            cache=externals.replace("\\", "/")))
        legacy = os.path.join(legacy_base, "externals", "separator_models")
        self.assertEqual(rp.model_subdir("separator_models"), os.path.normpath(legacy))

    def test_containment_dotdot_rejected(self):
        with self.assertRaises(rp.RuntimeRootError) as cm:
            rp.model_subdir("..", "escape")
        self.assertEqual(cm.exception.code, rp.PATH_OUTSIDE_ROOT)

    def test_can_write_managed_vs_borrowed(self):
        self.assertTrue(rp.can_write("modelRoot"))
        rp.reset()
        rp.configure(_roots(md_own="external-borrowed"))
        self.assertFalse(rp.can_write("modelRoot"))
        self.assertTrue(rp.can_write("runtimeRoot"))


class ResolverHook(unittest.TestCase):
    """realpath 훅으로 dangling/escape 를 실제 junction 없이 합성 검증."""

    def setUp(self):
        rp.reset()
        rp.configure(_roots())

    def tearDown(self):
        rp.reset()
        rp.set_path_resolver(None)

    def test_dangling_junction(self):
        rp.set_path_resolver(lambda p: None)  # 모든 해석 실패(dangling)
        with self.assertRaises(rp.RuntimeRootError) as cm:
            rp.model_subdir("separator_models")
        self.assertEqual(cm.exception.code, rp.DANGLING_JUNCTION)

    def test_symlink_escape(self):
        # 후보는 root 밖으로 해석되고 root 자신은 정상 해석 → PATH_OUTSIDE_ROOT
        def hook(p):
            n = os.path.normcase(os.path.normpath(p))
            if n.endswith(os.path.normcase("separator_models")):
                return os.path.normcase(os.path.normpath("C:/elsewhere/evil"))
            return n
        rp.set_path_resolver(hook)
        with self.assertRaises(rp.RuntimeRootError) as cm:
            rp.model_subdir("separator_models")
        self.assertEqual(cm.exception.code, rp.PATH_OUTSIDE_ROOT)


class Unconfigured(unittest.TestCase):
    def setUp(self):
        rp.reset()
        rp.set_path_resolver(None)

    def test_subdir_raises_no_runtime_root(self):
        self.assertFalse(rp.is_configured())
        with self.assertRaises(rp.RuntimeRootError) as cm:
            rp.runtime_subdir("gptsovits_venv")
        self.assertEqual(cm.exception.code, rp.NO_RUNTIME_ROOT)

    def test_error_payload_carries_code(self):
        try:
            rp.model_subdir("x")
        except rp.RuntimeRootError as e:
            self.assertEqual(e.error_payload, {"code": rp.NO_RUNTIME_ROOT})
        else:
            self.fail("expected RuntimeRootError")


if __name__ == "__main__":
    unittest.main(verbosity=2)
