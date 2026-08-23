# -*- coding: utf-8 -*-
"""R3-B 배선 계약 — separate.py의 roots 소비·게이트·evidence + 워커 소유권. synthetic.

실모델·GPU·미디어 0. audio-separator 미설치 환경을 전제(roformer 경로는 경로 해석 후 ImportError로 bail).

검증:
  - roots 미주입 + tts → NO_RUNTIME_ROOT 구조화 오류(워크트리 externals 경로 문자열 0회 노출)
  - roots 미주입 + music(roformer) → NO_RUNTIME_ROOT
  - roots 미주입 + qwen-preflight → degrade(available=false, reason=NO_RUNTIME_ROOT, 크래시 없음)
  - roots 미주입 + model-evidence → degrade
  - roots 주입 + model-evidence → 계약 키(qwen3/separator_bs/separator_melband/gptsovits) evidence
  - borrowed modelRoot: _separator_model_dir()가 makedirs 안 함(읽기 전용)
  - managed modelRoot: makedirs 함
  - 3워커+bridge 소스에 ComfyUI 리터럴 0, 워크트리 externals 추측(dirname(dirname(__file__))+externals) 0

실행: python python/test_runtime_injection_wiring.py
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import shutil
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

SEPARATE = os.path.join(HERE, "separate.py")


def _managed_roots(base):
    b = base.replace("\\", "/")
    return {
        "schemaVersion": 2,
        "runtimeRoot": {"path": b + "/rt", "ownership": "audioforge-managed"},
        "modelRoot": {"path": b + "/md", "ownership": "audioforge-managed"},
        "cacheRoot": {"path": b + "/ch", "ownership": "audioforge-managed"},
    }


def _run_separate(config):
    """separate.py를 config JSON으로 실행하고 stdout의 JSON emit 라인 리스트를 반환."""
    tmp = tempfile.mkdtemp(prefix="af_wire_")
    try:
        cfg_path = os.path.join(tmp, "cfg.json")
        with open(cfg_path, "w", encoding="utf-8") as f:
            json.dump(config, f)
        proc = subprocess.run(
            [sys.executable, SEPARATE, "--config", cfg_path],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
        lines = []
        for ln in proc.stdout.splitlines():
            ln = ln.strip()
            if not ln:
                continue
            try:
                lines.append(json.loads(ln))
            except ValueError:
                pass
        return lines, proc.stdout, proc.stderr, proc.returncode
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class Gates(unittest.TestCase):
    def _out_dir(self):
        d = tempfile.mkdtemp(prefix="af_out_")
        self.addCleanup(lambda: shutil.rmtree(d, ignore_errors=True))
        return d

    def test_tts_without_roots_no_runtime_root(self):
        out = self._out_dir()
        cfg = {"mode": "tts", "input": os.path.join(out, "in.wav"),
               "output": out, "ttsText": "안녕"}
        lines, stdout, stderr, rc = _run_separate(cfg)
        errs = [l for l in lines if l.get("type") == "error"]
        self.assertTrue(errs, f"error emit 없음. stdout={stdout} stderr={stderr[-400:]}")
        self.assertEqual(errs[0].get("code"), "NO_RUNTIME_ROOT")
        # 워크트리 externals 경로가 emit 문자열로 새어나오지 않았는가(폴백 흔적 0)
        self.assertNotIn("externals", stdout)

    def test_music_roformer_without_roots_no_runtime_root(self):
        out = self._out_dir()
        cfg = {"mode": "music", "model": "roformer",
               "input": os.path.join(out, "in.wav"), "output": out}
        lines, stdout, stderr, rc = _run_separate(cfg)
        errs = [l for l in lines if l.get("type") == "error"]
        self.assertTrue(errs, f"error emit 없음. stdout={stdout} stderr={stderr[-400:]}")
        self.assertEqual(errs[0].get("code"), "NO_RUNTIME_ROOT")

    def test_qwen_preflight_without_roots_degrades(self):
        lines, stdout, stderr, rc = _run_separate({"mode": "qwen-preflight"})
        res = [l for l in lines if l.get("type") == "result"]
        self.assertTrue(res, f"result 없음. stderr={stderr[-400:]}")
        self.assertFalse(res[0].get("available"))
        self.assertEqual(res[0].get("reason"), "NO_RUNTIME_ROOT")
        self.assertEqual(rc, 0)  # 크래시 아님

    def test_model_evidence_without_roots_degrades(self):
        lines, stdout, stderr, rc = _run_separate({"mode": "model-evidence"})
        res = [l for l in lines if l.get("type") == "result"]
        self.assertTrue(res, f"result 없음. stderr={stderr[-400:]}")
        self.assertFalse(res[0].get("available"))
        self.assertEqual(res[0].get("reason"), "NO_RUNTIME_ROOT")


class ModelEvidenceWithRoots(unittest.TestCase):
    def test_evidence_keys_and_shape(self):
        base = tempfile.mkdtemp(prefix="af_ev_")
        self.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
        # gptsovits venv python 파일을 만들어 present=true 를 유도(나머지는 부재)
        venv_py = os.path.join(base, "rt", "gptsovits_venv", "Scripts", "python.exe")
        os.makedirs(os.path.dirname(venv_py), exist_ok=True)
        with open(venv_py, "wb") as f:
            f.write(b"x")
        cfg = {"mode": "model-evidence", "roots": _managed_roots(base)}
        lines, stdout, stderr, rc = _run_separate(cfg)
        res = [l for l in lines if l.get("type") == "result"]
        self.assertTrue(res, f"result 없음. stderr={stderr[-400:]}")
        self.assertTrue(res[0].get("available"))
        models = res[0].get("models") or {}
        self.assertEqual(set(models.keys()),
                         {"qwen3", "separator_bs", "separator_melband", "gptsovits"})
        for v in models.values():
            self.assertEqual(set(v.keys()),
                             {"present", "expectedChecksum", "actualChecksum", "reasonCode"})
        self.assertTrue(models["gptsovits"]["present"])
        self.assertFalse(models["separator_bs"]["present"])


class SeparatorOwnership(unittest.TestCase):
    """borrowed root 읽기 전용(makedirs 금지) vs managed 생성 — in-process."""

    def setUp(self):
        import runtime_paths as rp
        rp.reset()
        rp.set_path_resolver(None)
        self.rp = rp

    def tearDown(self):
        self.rp.reset()
        self.rp.set_path_resolver(None)

    def _base(self):
        d = tempfile.mkdtemp(prefix="af_own_")
        self.addCleanup(lambda: shutil.rmtree(d, ignore_errors=True))
        return d

    def test_borrowed_does_not_makedirs(self):
        import music_worker
        base = self._base()
        roots = _managed_roots(base)
        roots["modelRoot"]["ownership"] = "external-borrowed"
        self.rp.configure(roots)
        model_dir = music_worker._separator_model_dir()
        self.assertFalse(os.path.exists(model_dir), "borrowed root에 makedirs 발생(금지)")

    def test_managed_makedirs(self):
        import music_worker
        base = self._base()
        self.rp.configure(_managed_roots(base))
        model_dir = music_worker._separator_model_dir()
        self.assertTrue(os.path.isdir(model_dir), "managed root에 separator_models 미생성")


class SourceHygiene(unittest.TestCase):
    """소스 수준 계약: ComfyUI 리터럴 0, 워크트리 externals 추측 0."""

    FILES = ["separate.py", "tts_worker.py", "music_worker.py", "gptsovits_bridge.py"]

    def test_no_comfyui_literal(self):
        for name in self.FILES:
            with open(os.path.join(HERE, name), encoding="utf-8") as f:
                src = f.read()
            self.assertNotIn("ComfyUI", src, f"{name} 에 ComfyUI 리터럴 잔존")

    def test_no_worktree_externals_guess(self):
        # dirname(dirname(__file__)) 조합 + "externals" 로 경로를 만드는 안티패턴이 코드에 없어야 한다.
        pat = re.compile(r"dirname\s*\(\s*os\.path\.dirname\s*\(\s*os\.path\.abspath\s*\(\s*__file__")
        for name in self.FILES:
            with open(os.path.join(HERE, name), encoding="utf-8") as f:
                src = f.read()
            for m in pat.finditer(src):
                tail = src[m.start():m.start() + 400]
                self.assertNotIn("externals", tail,
                                 f"{name} 에 워크트리-relative externals 추측 잔존")


if __name__ == "__main__":
    unittest.main(verbosity=2)
