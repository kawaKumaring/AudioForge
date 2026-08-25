# -*- coding: utf-8 -*-
"""provision.cli 얇은 어댑터 계약 — synthetic(부작용 0). Agent Q 소유.

검증:
  - plan/dry-run/verify가 P core를 소비해 renderer-safe 봉투를 emit(전체 절대경로 0, canonical 키).
  - minimal-qwen profile이 exact selection이고 wildcard는 fail-closed.
  - 알 수 없는 mode / config 아님 → APPLY_DISABLED 오류 봉투.
  - roots 무효(있는데 깨짐) → NO_RUNTIME_ROOT / roots 정상 managed → plan 정상(roots 없이도 정상).
  - dry-run fingerprint == plan fingerprint(같은 engineIds).

실행: python python/test_provision_cli.py  또는 unittest discover.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from provision import cli, reason_codes as rc


def _find_absolute(value):
    """객체 그래프의 문자열 중 절대경로(POSIX / 드라이브레터 / UNC) 형태를 찾으면 반환(없으면 None).
    provisionContract.ts findAbsolutePath와 동일 취지의 검사(Python 측 독립 확인)."""
    import re
    drive = re.compile(r"^[A-Za-z]:[\\/]")
    if isinstance(value, str):
        if value.startswith("/") or value.startswith("\\\\") or drive.match(value):
            return value
        return None
    if isinstance(value, list):
        for v in value:
            hit = _find_absolute(v)
            if hit:
                return hit
        return None
    if isinstance(value, dict):
        for v in value.values():
            hit = _find_absolute(v)
            if hit:
                return hit
    return None


def _managed_roots(base):
    b = base.replace("\\", "/")
    return {
        "schemaVersion": 2,
        "runtimeRoot": {"path": b + "/rt", "ownership": "audioforge-managed"},
        "modelRoot": {"path": b + "/md", "ownership": "audioforge-managed"},
        "cacheRoot": {"path": b + "/ch", "ownership": "audioforge-managed"},
    }


class TestProvisionCli(unittest.TestCase):
    def test_plan_is_renderer_safe(self):
        resp = cli.build_response({"mode": "provision-plan", "profile": "minimal-qwen"})
        self.assertTrue(resp["ok"], resp)
        self.assertEqual(resp["type"], "provision-result")
        result = resp["result"]
        self.assertEqual(result["schemaVersion"], 2)
        self.assertEqual(result["profile"], "minimal-qwen")
        self.assertEqual(result["mode"], "plan")
        self.assertGreater(len(result["components"]), 0)
        self.assertIsInstance(result["planFingerprint"], str)
        self.assertGreater(len(result["planFingerprint"]), 0)
        # 전체 절대경로 0(renderer 안전 계약 §11).
        hit = _find_absolute(result)
        self.assertIsNone(hit, f"절대경로 노출: {hit}")

    def test_profile_exact_and_star_blocked(self):
        full = cli.build_response({"mode": "provision-plan"})["result"]
        ids = {c["id"] for c in full["components"]}
        self.assertIn("qwen-venv", ids)
        self.assertIn("models.qwen3", ids)
        self.assertNotIn("models.separator", ids)
        blocked = cli.build_response({"mode": "provision-plan", "engineIds": ["*"]})
        self.assertFalse(blocked["ok"])
        self.assertEqual(blocked["error"]["code"], rc.UNRESOLVED_COMPONENT)

    def test_verify_synthetic_not_present(self):
        resp = cli.build_response({"mode": "provision-verify"})
        self.assertTrue(resp["ok"], resp)
        result = resp["result"]
        self.assertEqual(result["mode"], "verify")
        # 설치 이력 0(synthetic) → 전부 미설치. bootstrap은 항상 unresolved.
        for c in result["components"]:
            self.assertFalse(c["present"], c)
        self.assertIsNone(_find_absolute(result))

    def test_dry_run_matches_plan_fingerprint(self):
        p = cli.build_response({"mode": "provision-plan"})["result"]
        d = cli.build_response({"mode": "provision-dry-run"})["result"]
        self.assertEqual(p["planFingerprint"], d["planFingerprint"])
        self.assertEqual(d["mode"], "dry-run")

    def test_unknown_mode_blocked(self):
        resp = cli.build_response({"mode": "nope"})
        self.assertFalse(resp["ok"])
        self.assertEqual(resp["error"]["code"], rc.APPLY_DISABLED)

    def test_non_dict_config_blocked(self):
        resp = cli.build_response(["not", "a", "dict"])
        self.assertFalse(resp["ok"])
        self.assertEqual(resp["error"]["code"], rc.APPLY_DISABLED)

    def test_invalid_roots_surface_no_runtime_root(self):
        import runtime_paths as rp
        rp.reset()
        try:
            # roots가 실렸는데 무효(schemaVersion 불일치) → NO_RUNTIME_ROOT로 표면화(조용한 폴백 금지).
            resp = cli.build_response({"mode": "provision-plan", "roots": {"schemaVersion": 999}})
            self.assertFalse(resp["ok"])
            self.assertEqual(resp["error"]["code"], rp.NO_RUNTIME_ROOT)
        finally:
            rp.reset()

    def test_valid_roots_plan_ok(self):
        import runtime_paths as rp
        rp.reset()
        try:
            resp = cli.build_response({"mode": "provision-plan", "roots": _managed_roots("C:/tmp/afprov")})
            self.assertTrue(resp["ok"], resp)
            self.assertIsNone(_find_absolute(resp["result"]))
        finally:
            rp.reset()

    def test_plan_without_roots_ok(self):
        # roots 미주입에서도 plan은 순수하게 동작(§7 — plan/verify는 roots 불요).
        import runtime_paths as rp
        rp.reset()
        resp = cli.build_response({"mode": "provision-plan"})
        self.assertTrue(resp["ok"], resp)


if __name__ == "__main__":
    unittest.main()
