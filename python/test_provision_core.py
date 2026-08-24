# -*- coding: utf-8 -*-
"""provision 순수 코어 단위 계약 — synthetic (실다운로드·pip·네트워크·GPU·실모델 0).

부작용 테스트는 전부 tempfile.mkdtemp 격리 경로에서만. 공유/실제 root 무접촉.

검증 매트릭스(PROVISIONER-PLAN GPU-free 매트릭스 중 P 항목):
  - plan/dry-run: 파일·네트워크 변경 0(roots 미주입에서도 동작)
  - manifest 검증 / DAG 위상정렬·순환·누락 의존
  - unresolved(URL·checksum·license·bootstrap) → apply 차단
  - plan fingerprint 변경 시 승인 무효 / dry-run==plan fingerprint
  - immutable 설치 후 pointer만 교체 / 기존 active 보존(disk full) / staging만 제거
  - multi-file 모델 checksum 일부 실패
  - lock 중복(HELD)·crash orphan(STALE, 자동 탈취 금지)
  - cacheRoot만 managed 생성 / borrowed read-only / runtimeRoot·modelRoot 승인 전 생성 0

실행: python python/test_provision_core.py
"""
import json
import os
import sys
import tempfile
import shutil
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import runtime_paths as rp
import model_manifest
from provision import (
    dag, default_manifest, fingerprint as fp, layout, lock, manifest as mf,
    ownership, reason_codes as rc, staging, state,
)


def _managed_roots(base):
    b = base.replace("\\", "/")
    return {
        "schemaVersion": 2,
        "runtimeRoot": {"path": b + "/rt", "ownership": "audioforge-managed"},
        "modelRoot": {"path": b + "/md", "ownership": "audioforge-managed"},
        "cacheRoot": {"path": b + "/ch", "ownership": "audioforge-managed"},
    }


def _resolved_manifest():
    """전 component가 resolved인 소형 합성 manifest(fingerprint/apply 게이트 검증용)."""
    lic = {"code": "MIT", "weights": "OpenRAIL", "data": "n/a", "output": "n/a"}
    return {
        "schemaVersion": mf.MANIFEST_SCHEMA_VERSION,
        "components": [
            {"id": "cache-area", "kind": "cache", "version": "1", "required": True,
             "dependsOn": [], "installPath": "staging", "displayLabel": "캐시", "license": lic},
            {"id": "models.demo", "kind": "model", "version": "1", "required": True,
             "dependsOn": [], "installPath": "demo", "displayLabel": "데모 모델",
             "repoId": "org/demo", "pinnedRevision": "abc123", "totalSize": 1024,
             "requiredFiles": [{"path": "a.bin", "sha256": "d0"}], "license": lic},
        ],
    }


# ── plan / dry-run: 부작용 0 ──────────────────────────────────────────────────
class PlanNoSideEffects(unittest.TestCase):
    def setUp(self):
        rp.reset()

    def tearDown(self):
        rp.reset()

    def test_plan_runs_without_roots(self):
        # plan은 레이아웃 상대경로만 쓰므로 roots 미주입에서도 동작(파일/네트워크 0).
        self.assertFalse(rp.is_configured())
        p = state.plan(default_manifest.build())
        self.assertEqual(p["mode"], "plan")
        self.assertTrue(len(p["components"]) >= 4)
        self.assertIn("planFingerprint", p)

    def test_plan_no_absolute_paths(self):
        p = state.plan(default_manifest.build())
        blob = json.dumps(p, ensure_ascii=False)
        # 렌더러 노출 금지: 드라이브/POSIX 절대경로 문자열이 없어야 한다.
        self.assertNotIn(":\\", blob)
        self.assertNotIn(":/", blob)
        self.assertFalseAbs(blob)

    def assertFalseAbs(self, blob):
        import re
        self.assertIsNone(re.search(r'"[A-Za-z]:[\\/]', blob), "절대경로 문자열 노출")

    def test_dry_run_same_fingerprint_as_plan(self):
        m = default_manifest.build()
        self.assertEqual(state.plan(m)["planFingerprint"], state.dry_run(m)["planFingerprint"])
        self.assertEqual(state.dry_run(m)["mode"], "dry-run")


# ── manifest / DAG ────────────────────────────────────────────────────────────
class ManifestAndDag(unittest.TestCase):
    def test_default_manifest_validates(self):
        comps = mf.validate_manifest(default_manifest.build())
        self.assertTrue(any(c["id"] == "bootstrap-python" for c in comps))

    def test_bootstrap_always_unresolved(self):
        comps = mf.component_index(mf.validate_manifest(default_manifest.build()))
        self.assertFalse(mf.is_resolved(comps["bootstrap-python"]))
        self.assertEqual(mf.unresolved_reason(comps["bootstrap-python"]),
                         rc.BOOTSTRAP_PYTHON_UNRESOLVED)

    def test_models_unresolved_when_sha_or_license_missing(self):
        comps = mf.component_index(mf.validate_manifest(default_manifest.build()))
        self.assertFalse(mf.is_resolved(comps["models.qwen3"]))  # sha256/license 미상
        self.assertEqual(mf.unresolved_reason(comps["models.qwen3"]), rc.UNRESOLVED_COMPONENT)

    def test_resolved_manifest_all_resolved(self):
        comps = mf.validate_manifest(_resolved_manifest())
        self.assertTrue(all(mf.is_resolved(c) for c in comps))

    def test_topo_sort_orders_deps_first(self):
        comps = mf.validate_manifest(default_manifest.build())
        ordered = dag.topo_sort(comps)
        ids = [c["id"] for c in ordered]
        self.assertLess(ids.index("bootstrap-python"), ids.index("parent-runtime"))
        self.assertLess(ids.index("qwen-venv"), ids.index("models.qwen3"))

    def test_cycle_detected(self):
        m = {"schemaVersion": 1, "components": [
            {"id": "a", "kind": "tool", "version": "1", "required": True, "dependsOn": ["b"],
             "installPath": "a", "displayLabel": "a", "license": None},
            {"id": "b", "kind": "tool", "version": "1", "required": True, "dependsOn": ["a"],
             "installPath": "b", "displayLabel": "b", "license": None},
        ]}
        comps = mf.validate_manifest(m)
        with self.assertRaises(rc.ProvisionError) as cm:
            dag.topo_sort(comps)
        self.assertEqual(cm.exception.code, rc.DAG_CYCLE)

    def test_missing_dependency(self):
        m = {"schemaVersion": 1, "components": [
            {"id": "a", "kind": "tool", "version": "1", "required": True, "dependsOn": ["ghost"],
             "installPath": "a", "displayLabel": "a", "license": None},
        ]}
        comps = mf.validate_manifest(m)
        with self.assertRaises(rc.ProvisionError) as cm:
            dag.topo_sort(comps)
        self.assertEqual(cm.exception.code, rc.DEPENDENCY_MISSING)

    def test_select_components_pulls_engine_closure(self):
        comps = mf.validate_manifest(default_manifest.build())
        sel = dag.select_components(comps, engine_ids=("models.qwen3",))
        ids = {c["id"] for c in sel}
        # 필수 전부 + qwen 폐포(qwen-venv, bootstrap-python) 포함, gptsovits는 제외.
        self.assertIn("models.qwen3", ids)
        self.assertIn("qwen-venv", ids)
        self.assertIn("bootstrap-python", ids)
        self.assertNotIn("models.gptsovits", ids)


# ── apply 게이트: unresolved/bootstrap/fingerprint ──────────────────────────
class ApplyGate(unittest.TestCase):
    def test_apply_blocked_by_bootstrap_unresolved(self):
        p = state.plan(default_manifest.build())
        with self.assertRaises(rc.ProvisionError) as cm:
            state.apply(p, p["planFingerprint"])  # 토큰은 맞지만 bootstrap unresolved
        self.assertEqual(cm.exception.code, rc.BOOTSTRAP_PYTHON_UNRESOLVED)

    def test_apply_wrong_token_mismatch(self):
        p = state.plan(default_manifest.build())
        with self.assertRaises(rc.ProvisionError) as cm:
            state.apply(p, "deadbeef")
        self.assertEqual(cm.exception.code, rc.PLAN_FINGERPRINT_MISMATCH)

    def test_fingerprint_invalidated_by_version_change(self):
        m = _resolved_manifest()
        p1 = state.plan(m)
        old_token = p1["planFingerprint"]
        # 버전 변경 → 새 plan fingerprint → 과거 토큰 무효
        m["components"][1]["version"] = "2"
        p2 = state.plan(m)
        self.assertNotEqual(p1["planFingerprint"], p2["planFingerprint"])
        with self.assertRaises(rc.ProvisionError) as cm:
            state.apply(p2, old_token)
        self.assertEqual(cm.exception.code, rc.PLAN_FINGERPRINT_MISMATCH)

    def test_resolved_manifest_apply_disabled(self):
        # 전 component resolved + 올바른 토큰이어도 설치 로직 미구현 → APPLY_DISABLED
        p = state.plan(_resolved_manifest())
        self.assertTrue(p["resolvedAll"])
        with self.assertRaises(rc.ProvisionError) as cm:
            state.apply(p, p["planFingerprint"])
        self.assertEqual(cm.exception.code, rc.APPLY_DISABLED)


# ── fingerprint 순수 규칙 ────────────────────────────────────────────────────
class Fingerprint(unittest.TestCase):
    def test_canonical_key_order_stable(self):
        a = fp.canonical_json({"b": 1, "a": 2})
        b = fp.canonical_json({"a": 2, "b": 1})
        self.assertEqual(a, b)
        self.assertEqual(a, '{"a":2,"b":1}')

    def test_matches_token(self):
        obj = {"x": [1, 2, 3]}
        self.assertTrue(fp.matches(obj, fp.fingerprint(obj)))
        self.assertFalse(fp.matches(obj, "nope"))
        self.assertFalse(fp.matches_token("", "x"))


# ── staging / pointer(synthetic tmp) ─────────────────────────────────────────
class Staging(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="af_prov_stg_")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _write(self, path, data=b"hello"):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def _stage(self, versioned, job_id, component_id, data=b"DATA"):
        staged = staging.target_local_staging_dir(
            versioned, job_id, component_id)
        self._write(os.path.join(staged, "a.bin"), data)
        staging.create_job_marker(
            staged, self.d, job_id, "plan-fingerprint", "nonce-" + job_id)
        return staged

    def test_multi_file_checksum_partial_failure(self):
        base = os.path.join(self.d, "staged")
        self._write(os.path.join(base, "a.bin"), b"AAA")
        self._write(os.path.join(base, "b.bin"), b"BBB")
        sha_a = model_manifest.sha256_file(os.path.join(base, "a.bin"))
        required = [{"path": "a.bin", "sha256": sha_a},
                    {"path": "b.bin", "sha256": "wrong"}]
        results = staging.check_required_files(base, required)
        self.assertIsNone(results[0]["reasonCode"])
        self.assertEqual(results[1]["reasonCode"], rc.MODEL_CHECKSUM_MISMATCH)
        with self.assertRaises(rc.ProvisionError) as cm:
            staging.verify_required_files(base, required)
        self.assertEqual(cm.exception.code, rc.MODEL_CHECKSUM_MISMATCH)

    def test_missing_file_reason(self):
        base = os.path.join(self.d, "staged2")
        os.makedirs(base, exist_ok=True)
        results = staging.check_required_files(base, [{"path": "gone.bin", "sha256": "x"}])
        self.assertEqual(results[0]["reasonCode"], rc.MODEL_MISSING)

    def test_immutable_install_then_pointer_swap(self):
        versioned = os.path.join(self.d, "versions", "models.demo@1")
        staged = self._stage(versioned, "job1", "models.demo")
        pointer = os.path.join(self.d, "active.json")
        # 기존 active(이전 버전)를 심어 보존 검증
        with open(pointer, "w", encoding="utf-8") as f:
            f.write(json.dumps({"componentId": "models.demo", "version": "0"}))
        active = {"componentId": "models.demo", "version": "1"}
        staging.promote(staged, versioned, pointer, active,
                        self.d, "job1", "nonce-job1")
        self.assertTrue(os.path.isfile(os.path.join(versioned, "a.bin")))
        self.assertFalse(os.path.isdir(staged), "staging이 immutable 위치로 이동돼야 함")
        self.assertEqual(staging.read_pointer(pointer), active)

    def test_pointer_swap_diskfull_preserves_active(self):
        versioned = os.path.join(self.d, "versions2", "models.demo@1")
        staged = self._stage(versioned, "job2", "models.demo")
        pointer = os.path.join(self.d, "active2.json")
        prev = {"componentId": "models.demo", "version": "0"}
        with open(pointer, "w", encoding="utf-8") as f:
            f.write(json.dumps(prev))

        def _boom(_src, _dst):
            raise OSError(28, "No space left on device")
        # dir 이동은 성공, pointer 교체만 실패 → 기존 active pointer 불변.
        with self.assertRaises(OSError):
            staging.promote(staged, versioned, pointer, {"componentId": "models.demo", "version": "1"},
                            self.d, "job2", "nonce-job2",
                            replace_pointer_fn=_boom)
        self.assertEqual(staging.read_pointer(pointer), prev, "기존 active pointer가 보존돼야 함")

    def test_dir_move_diskfull_cleans_staging_keeps_active(self):
        versioned = os.path.join(self.d, "versions3", "models.demo@1")
        staged = self._stage(versioned, "job3", "models.demo")
        pointer = os.path.join(self.d, "active3.json")
        prev = {"componentId": "models.demo", "version": "0"}
        with open(pointer, "w", encoding="utf-8") as f:
            f.write(json.dumps(prev))

        def _boom(_src, _dst):
            raise OSError(28, "No space left on device")
        with self.assertRaises(rc.ProvisionError) as cm:
            staging.promote(staged, versioned, pointer, {"componentId": "models.demo", "version": "1"},
                            self.d, "job3", "nonce-job3",
                            replace_dir_fn=_boom)
        self.assertEqual(cm.exception.code, rc.APPLY_DISABLED)
        self.assertFalse(os.path.isdir(staged), "이동 실패 시 staging은 제거돼야 함")
        self.assertFalse(os.path.isdir(versioned), "이동 실패 시 versioned 미생성")
        self.assertEqual(staging.read_pointer(pointer), prev, "기존 active 보존")

    def test_immutable_no_overwrite_existing_version(self):
        versioned = os.path.join(self.d, "versions4", "c@1")
        staged = self._stage(versioned, "job4", "c", b"X")
        os.makedirs(versioned, exist_ok=True)  # 이미 존재하는 버전
        pointer = os.path.join(self.d, "active4.json")
        with self.assertRaises(rc.ProvisionError) as cm:
            staging.promote(staged, versioned, pointer, {"componentId": "c", "version": "1"},
                            self.d, "job4", "nonce-job4")
        self.assertEqual(cm.exception.code, rc.APPLY_DISABLED)  # 덮어쓰기 금지


# ── lock: 중복 / crash orphan ────────────────────────────────────────────────
class Lock(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="af_prov_lock_")
        self.path = os.path.join(self.d, "provision.lock")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_duplicate_lock_held(self):
        lock.acquire(self.path, pid=111, now=1000.0, pid_alive=lambda p: True,
                     job_id="job1", plan_fingerprint="fp1", nonce="nonce1")
        with self.assertRaises(rc.ProvisionError) as cm:
            lock.acquire(self.path, pid=222, now=1001.0, pid_alive=lambda p: True,
                         job_id="job2", plan_fingerprint="fp2", nonce="nonce2")
        self.assertEqual(cm.exception.code, rc.PROVISION_LOCK_HELD)

    def test_orphan_dead_pid_stale_not_stolen(self):
        lock.acquire(self.path, pid=111, now=1000.0, pid_alive=lambda p: True,
                     job_id="job1", plan_fingerprint="fp1", nonce="nonce1")
        # 보유 pid가 죽음 → stale 판정. 하지만 자동 탈취 금지 → STALE 예외(안내), 파일 유지.
        with self.assertRaises(rc.ProvisionError) as cm:
            lock.acquire(self.path, pid=333, now=1050.0, pid_alive=lambda p: False,
                         job_id="job3", plan_fingerprint="fp3", nonce="nonce3",
                         stat_fn=lambda _p: 1000.0)
        self.assertEqual(cm.exception.code, rc.PROVISION_LOCK_STALE)
        self.assertTrue(os.path.exists(self.path), "STALE여도 자동 삭제/탈취 금지")

    def test_stale_by_mtime(self):
        info = {"pid": 111, "heartbeatAt": 0.0}
        self.assertTrue(lock.is_stale(info, mtime=0.0, now=99999.0, pid_alive=lambda p: True))
        self.assertFalse(lock.is_stale(info, mtime=99990.0, now=99999.0, pid_alive=lambda p: True))

    def test_corrupt_lock_is_stale(self):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("{not json")
        self.assertTrue(lock.is_stale(lock.decode_lock("{not json"), mtime=0, now=0,
                                      pid_alive=lambda p: True))

    def test_release_only_own_pid(self):
        lock.acquire(self.path, pid=111, now=1000.0, pid_alive=lambda p: True,
                     job_id="job1", plan_fingerprint="fp1", nonce="nonce1")
        self.assertFalse(lock.release(
            self.path, pid=111, job_id="job1", plan_fingerprint="fp1",
            nonce="wrong"), "nonce 불일치 lock 해제 금지")
        self.assertTrue(lock.release(
            self.path, pid=111, job_id="job1", plan_fingerprint="fp1",
            nonce="nonce1"))
        self.assertFalse(os.path.exists(self.path))


# ── ownership: cacheRoot만 생성 / borrowed read-only / 승인 전 생성 0 ────────
class Ownership(unittest.TestCase):
    def setUp(self):
        rp.reset()
        rp.set_path_resolver(None)
        self.base = tempfile.mkdtemp(prefix="af_prov_own_")

    def tearDown(self):
        rp.reset()
        rp.set_path_resolver(None)
        shutil.rmtree(self.base, ignore_errors=True)

    def test_managed_cache_stageable(self):
        rp.configure(_managed_roots(self.base))
        self.assertTrue(ownership.can_stage())
        staged = layout.staging_dir("job1")
        ownership.staging_makedirs(staged)
        self.assertTrue(os.path.isdir(staged))

    def test_borrowed_cache_read_only(self):
        roots = _managed_roots(self.base)
        roots["cacheRoot"]["ownership"] = "external-borrowed"
        rp.configure(roots)
        self.assertFalse(ownership.can_stage())
        with self.assertRaises(rc.ProvisionError) as cm:
            ownership.require_stageable()
        self.assertEqual(cm.exception.code, rc.BORROWED_RUNTIME_READ_ONLY)

    def test_borrowed_runtime_read_only(self):
        roots = _managed_roots(self.base)
        roots["runtimeRoot"]["ownership"] = "external-borrowed"
        rp.configure(roots)
        with self.assertRaises(rc.ProvisionError) as cm:
            ownership.require_writable("runtimeRoot")
        self.assertEqual(cm.exception.code, rc.BORROWED_RUNTIME_READ_ONLY)

    def test_plan_verify_apply_never_create_runtime_or_model_dirs(self):
        # 승인 전(=plan/verify/apply 단계) runtimeRoot·modelRoot 디렉터리는 생성되지 않아야 한다.
        rp.configure(_managed_roots(self.base))
        rt = os.path.join(self.base, "rt")
        md = os.path.join(self.base, "md")
        m = default_manifest.build()
        state.plan(m)
        state.dry_run(m)
        state.verify(m)
        try:
            state.apply(state.plan(m), state.plan(m)["planFingerprint"])
        except rc.ProvisionError:
            pass
        self.assertFalse(os.path.exists(rt), "runtimeRoot가 승인 전 생성됨(금지)")
        self.assertFalse(os.path.exists(md), "modelRoot가 승인 전 생성됨(금지)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
