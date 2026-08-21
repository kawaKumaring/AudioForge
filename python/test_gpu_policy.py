# -*- coding: utf-8 -*-
"""GPU 정책(1단계) 테스트 — 실제 CUDA 없이 torch.cuda를 mock으로 재현.

- select_device: Auto→CPU(ComfyUI 점유 mock), 강제 GPU, 강제 CPU, 미가용/조회실패/타임아웃.
- run_with_oom_retry: CUDA OOM→CPU 1회 재시도, 비-OOM 예외는 전파(원인 불명 숨기지 않음).
- is_cuda_oom: 메시지 기반 판별.

실행:
  python python/test_gpu_policy.py
  python -m unittest discover -s python -p "test_gpu_policy.py"
"""
import os
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gpu_policy as gp   # noqa: E402
import torch              # noqa: E402  (mock 대상; 실제 CUDA는 사용하지 않음)

MB = 1024 * 1024


class SelectDeviceTest(unittest.TestCase):
    def setUp(self):
        # 이 클래스의 auto 테스트는 torch.mem_get_info 경로(비-Windows) 의미를 검증한다.
        # Windows 분기는 WindowsAutoSourceTest에서 별도 검증.
        p = mock.patch.object(gp, "_is_windows", return_value=False)
        p.start(); self.addCleanup(p.stop)

    def test_cpu_policy_forced(self):
        dev, reason = gp.select_device("cpu")
        self.assertEqual(dev, "cpu")
        self.assertIn("CPU", reason)

    def test_gpu_policy_available(self):
        with mock.patch.object(torch.cuda, "is_available", return_value=True):
            dev, reason = gp.select_device("gpu")
        self.assertEqual(dev, "cuda")

    def test_gpu_policy_unavailable_raises(self):
        # 강제 GPU인데 CUDA 없음 → 조용히 CPU로 낮추지 않고 예외
        with mock.patch.object(torch.cuda, "is_available", return_value=False):
            with self.assertRaises(RuntimeError):
                gp.select_device("gpu")

    def test_auto_cuda_unavailable_cpu(self):
        with mock.patch.object(torch.cuda, "is_available", return_value=False):
            dev, reason = gp.select_device("auto")
        self.assertEqual(dev, "cpu")

    def test_auto_high_free_gpu(self):
        with mock.patch.object(torch.cuda, "is_available", return_value=True), \
             mock.patch.object(torch.cuda, "mem_get_info",
                               return_value=(8000 * MB, 12000 * MB)):
            dev, reason = gp.select_device("auto", min_free_mb=1500)
        self.assertEqual(dev, "cuda")

    def test_auto_low_free_comfyui_busy_cpu(self):
        # ComfyUI가 VRAM 대부분을 점유 → free 300MB → CPU 선택
        with mock.patch.object(torch.cuda, "is_available", return_value=True), \
             mock.patch.object(torch.cuda, "mem_get_info",
                               return_value=(300 * MB, 12000 * MB)):
            dev, reason = gp.select_device("auto", min_free_mb=1500)
        self.assertEqual(dev, "cpu")
        self.assertIn("VRAM", reason)

    def test_auto_mem_query_error_cpu(self):
        with mock.patch.object(torch.cuda, "is_available", return_value=True), \
             mock.patch.object(torch.cuda, "mem_get_info",
                               side_effect=RuntimeError("driver error")):
            dev, reason = gp.select_device("auto")
        self.assertEqual(dev, "cpu")

    def test_auto_mem_query_timeout_cpu(self):
        def _slow(*a, **k):
            time.sleep(1.0)
            return (8000 * MB, 12000 * MB)
        with mock.patch.object(torch.cuda, "is_available", return_value=True), \
             mock.patch.object(torch.cuda, "mem_get_info", side_effect=_slow):
            dev, reason = gp.select_device("auto", timeout_sec=0.2)
        self.assertEqual(dev, "cpu")  # 응답 없음 → busy 추정 → CPU

    def test_scalar_alloc_not_used_as_evidence(self):
        # zeros 프로브가 성공해도 free VRAM이 낮으면 CPU여야 한다(스칼라 할당을 근거로 쓰지 않음)
        with mock.patch.object(torch.cuda, "is_available", return_value=True), \
             mock.patch.object(torch.cuda, "mem_get_info",
                               return_value=(100 * MB, 12000 * MB)):
            dev, _ = gp.select_device("auto", min_free_mb=1500)
        self.assertEqual(dev, "cpu")


class PerJobThresholdBoundaryTest(unittest.TestCase):
    """작업별 required_free_vram 경계 — 같은 free VRAM이라도 임계값에 따라 장치가 갈린다.
    Qwen(4000)과 대화 분리(1500)가 분리돼 있음을 free≈3000MiB 상황으로 대비.
    (torch 경로 의미 검증 — 비-Windows 고정)"""
    def setUp(self):
        p = mock.patch.object(gp, "_is_windows", return_value=False)
        p.start(); self.addCleanup(p.stop)

    def _dev(self, free_mb, min_free_mb):
        with mock.patch.object(torch.cuda, "is_available", return_value=True), \
             mock.patch.object(torch.cuda, "mem_get_info",
                               return_value=(int(free_mb * MB), 16000 * MB)):
            return gp.select_device("auto", min_free_mb=min_free_mb)[0]

    def test_qwen_boundary_exact(self):
        # 정확히 임계값이면 GPU(>=), 1MiB 부족이면 CPU
        self.assertEqual(self._dev(4000, 4000), "cuda")
        self.assertEqual(self._dev(3999, 4000), "cpu")

    def test_same_free_different_job_thresholds(self):
        # free≈3000MiB: 대화(1500)는 GPU, Qwen(4000)은 CPU로 갈린다
        self.assertEqual(self._dev(3000, gp.DEFAULT_MIN_FREE_MB), "cuda")
        self.assertEqual(self._dev(3000, 4000), "cpu")

    def test_qwen_ample_free_gpu(self):
        self.assertEqual(self._dev(8000, 4000), "cuda")


class NvidiaSmiParseTest(unittest.TestCase):
    """_nvidia_smi_free_total_mb: 대상 index 행 선택 / 파싱 실패·비정상 종료·부재·timeout → None."""
    def _proc(self, stdout, returncode=0):
        class P:
            pass
        p = P(); p.stdout = stdout; p.returncode = returncode
        return p

    def test_selects_target_index_row(self):
        out = "0, 16302, 11400, 4896\n1, 24576, 1000, 23000\n"
        with mock.patch("subprocess.run", return_value=self._proc(out)):
            self.assertEqual(gp._nvidia_smi_free_total_mb(0, 10), (4896.0, 16302.0))
            self.assertEqual(gp._nvidia_smi_free_total_mb(1, 10), (23000.0, 24576.0))

    def test_missing_index_returns_none(self):
        with mock.patch("subprocess.run", return_value=self._proc("0, 16302, 11400, 4896\n")):
            self.assertIsNone(gp._nvidia_smi_free_total_mb(3, 10))

    def test_garbage_lines_skipped(self):
        out = "header junk\n0, 16302, 11400, 4896\n"
        with mock.patch("subprocess.run", return_value=self._proc(out)):
            self.assertEqual(gp._nvidia_smi_free_total_mb(0, 10), (4896.0, 16302.0))

    def test_nonzero_returncode_none(self):
        with mock.patch("subprocess.run", return_value=self._proc("", returncode=9)):
            self.assertIsNone(gp._nvidia_smi_free_total_mb(0, 10))

    def test_command_absent_none(self):
        with mock.patch("subprocess.run", side_effect=FileNotFoundError("no nvidia-smi")):
            self.assertIsNone(gp._nvidia_smi_free_total_mb(0, 10))

    def test_timeout_none(self):
        import subprocess
        with mock.patch("subprocess.run", side_effect=subprocess.TimeoutExpired("nvidia-smi", 10)):
            self.assertIsNone(gp._nvidia_smi_free_total_mb(0, 10))


class WindowsAutoSourceTest(unittest.TestCase):
    """Windows Auto: nvidia-smi가 1차 근거. 측정 실패 시 보수적 CPU. 사유에 free·threshold·source 포함."""
    def setUp(self):
        p = mock.patch.object(gp, "_is_windows", return_value=True)
        p.start(); self.addCleanup(p.stop)
        pa = mock.patch.object(torch.cuda, "is_available", return_value=True)
        pa.start(); self.addCleanup(pa.stop)
        pd = mock.patch.object(torch.cuda, "current_device", return_value=0)
        pd.start(); self.addCleanup(pd.stop)

    def test_free_9508_conversation_1500_gpu(self):
        with mock.patch.object(gp, "_nvidia_smi_free_total_mb", return_value=(9508.0, 16302.0)):
            dev, reason = gp.select_device("auto", min_free_mb=1500)
        self.assertEqual(dev, "cuda")
        self.assertIn("9508", reason)
        self.assertIn("1500", reason)
        self.assertIn("nvidia-smi", reason)

    def test_free_2121_qwen_4000_cpu(self):
        with mock.patch.object(gp, "_nvidia_smi_free_total_mb", return_value=(2121.0, 16302.0)):
            dev, reason = gp.select_device("auto", min_free_mb=4000)
        self.assertEqual(dev, "cpu")
        self.assertIn("2121", reason)
        self.assertIn("4000", reason)
        self.assertIn("nvidia-smi", reason)

    def test_windows_prefers_nvidia_smi_over_torch(self):
        # 충돌: nvidia-smi 2121 vs torch 14148. Windows는 nvidia-smi 우선 → 4000 기준 CPU.
        with mock.patch.object(gp, "_nvidia_smi_free_total_mb", return_value=(2121.0, 16302.0)), \
             mock.patch.object(torch.cuda, "mem_get_info", return_value=(14148 * MB, 16302 * MB)):
            dev, reason = gp.select_device("auto", min_free_mb=4000)
        self.assertEqual(dev, "cpu")
        self.assertIn("source=nvidia-smi", reason)
        self.assertNotIn("14148", reason)  # torch 값은 쓰이지 않음

    def test_nvidia_smi_failure_conservative_cpu(self):
        # 부재/timeout/파싱 실패 → None → 보수적 CPU (torch로 폴백하지 않음)
        with mock.patch.object(gp, "_nvidia_smi_free_total_mb", return_value=None):
            dev, reason = gp.select_device("auto", min_free_mb=4000)
        self.assertEqual(dev, "cpu")
        self.assertIn("측정 실패", reason)
        self.assertIn("nvidia-smi", reason)


class AutoSourceTagTest(unittest.TestCase):
    """비-Windows(torch 경로)에서도 사유에 source가 포함된다."""
    def test_linux_source_tag(self):
        with mock.patch.object(gp, "_is_windows", return_value=False), \
             mock.patch.object(torch.cuda, "is_available", return_value=True), \
             mock.patch.object(torch.cuda, "current_device", return_value=0), \
             mock.patch.object(torch.cuda, "mem_get_info", return_value=(8000 * MB, 16000 * MB)):
            dev, reason = gp.select_device("auto", min_free_mb=1500)
        self.assertEqual(dev, "cuda")
        self.assertIn("source=torch.mem_get_info", reason)


class OomRetryTest(unittest.TestCase):
    def test_success_no_fallback(self):
        calls = []
        cleaned = []
        fell = []
        res, used = gp.run_with_oom_retry(
            lambda dev: (calls.append(dev) or "ok"),
            "cuda", cleanup=lambda: cleaned.append(1), on_fallback=lambda e: fell.append(1))
        self.assertEqual(res, "ok")
        self.assertEqual(used, "cuda")
        self.assertEqual(calls, ["cuda"])
        self.assertEqual(cleaned, [])
        self.assertEqual(fell, [])

    def test_cuda_oom_retries_on_cpu(self):
        calls = []
        cleaned = []
        fell = []

        def fn(dev):
            calls.append(dev)
            if dev == "cuda":
                raise RuntimeError("CUDA out of memory. Tried to allocate ...")
            return "cpu-result"

        res, used = gp.run_with_oom_retry(
            fn, "cuda", cleanup=lambda: cleaned.append(1), on_fallback=lambda e: fell.append(1))
        self.assertEqual(res, "cpu-result")
        self.assertEqual(used, "cpu")
        self.assertEqual(calls, ["cuda", "cpu"])  # cuda 실패 후 cpu 재시도
        self.assertEqual(len(cleaned), 1)
        self.assertEqual(len(fell), 1)

    def test_non_oom_propagates(self):
        calls = []
        cleaned = []

        def fn(dev):
            calls.append(dev)
            raise RuntimeError("some unrelated error")

        with self.assertRaises(RuntimeError):
            gp.run_with_oom_retry(fn, "cuda", cleanup=lambda: cleaned.append(1))
        self.assertEqual(calls, ["cuda"], "OOM이 아니면 CPU 재시도 없이 전파")
        self.assertEqual(cleaned, [], "비-OOM에는 cleanup 실행 안 함")

    def test_cleanup_runs_before_cpu_retry(self):
        # 순서: cuda 호출(OOM) → cleanup → (on_fallback) → cpu 재시도
        log = []

        def fn(dev):
            log.append(f"call:{dev}")
            if dev == "cuda":
                raise RuntimeError("CUDA out of memory")
            return "ok"

        gp.run_with_oom_retry(
            fn, "cuda",
            cleanup=lambda: log.append("cleanup"),
            on_fallback=lambda info: log.append("fallback"))
        self.assertEqual(log, ["call:cuda", "cleanup", "fallback", "call:cpu"])

    def test_cpu_device_oom_not_retried(self):
        calls = []

        def fn(dev):
            calls.append(dev)
            raise RuntimeError("CUDA out of memory")

        with self.assertRaises(RuntimeError):
            gp.run_with_oom_retry(fn, "cpu")
        self.assertEqual(calls, ["cpu"], "device=cpu면 재시도하지 않음")


class IsCudaOomTest(unittest.TestCase):
    def test_oom_message(self):
        self.assertTrue(gp.is_cuda_oom(RuntimeError("CUDA out of memory. Tried ...")))

    def test_non_oom_message(self):
        self.assertFalse(gp.is_cuda_oom(RuntimeError("shape mismatch")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
