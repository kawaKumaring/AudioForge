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
