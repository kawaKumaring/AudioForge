# -*- coding: utf-8 -*-
"""Qwen watchdog 신호 계약 회귀.

장문 단일 호출은 vendor blocking 구간에서 정상적으로 아무 메시지도 내지 않는다.
그래서 "메시지 없음" 만으로 hang 을 단정하면 정상 실행을 죽인다(실측: goback 1464자가
280s watchdog 에 걸려 QWEN_NO_RESPONSE 로 종료됐다).

여기서 고정하는 것:
  · 시간 초과 단독으로 종료하지 않는다 — GPU 활동을 함께 본다
  · util=0 은 hang 근거가 아니다(CPU 후처리·동기화·커널 사이 공백)
  · GPU 조회 실패는 '모른다' 이므로 종료 근거가 아니다
  · 연속 관측에서 활동이 없을 때만 hang 으로 판정한다
  · 프로세스가 죽었으면 그 자체가 실패 확정이다
"""
import unittest
from unittest import mock

import tts_worker as tw


class GpuBusySignalTest(unittest.TestCase):
    def _run(self, returncode=0, stdout="0, 5600"):
        r = mock.Mock(returncode=returncode, stdout=stdout)
        with mock.patch("subprocess.run", return_value=r):
            return tw._gpu_busy()

    def test_util_zero_with_memory_is_busy(self):
        """util=0 이어도 메모리를 물고 있으면 작업 중으로 본다."""
        self.assertTrue(self._run(stdout="0, 5600"))

    def test_util_positive_is_busy(self):
        self.assertTrue(self._run(stdout="37, 900"))

    def test_idle_gpu_is_not_busy(self):
        self.assertFalse(self._run(stdout="0, 900"))

    def test_query_failure_is_treated_as_unknown_not_idle(self):
        """조회가 실패하면 '모른다' 다 — 종료 근거로 쓰지 않는다."""
        self.assertTrue(self._run(returncode=1, stdout=""))

    def test_exception_is_treated_as_unknown(self):
        with mock.patch("subprocess.run", side_effect=OSError("nvidia-smi 없음")):
            self.assertTrue(tw._gpu_busy())

    def test_malformed_output_is_unknown(self):
        self.assertTrue(self._run(stdout="이상한 출력"))


class WatchdogContractTest(unittest.TestCase):
    def test_probe_rounds_are_defined_and_greater_than_one(self):
        """한 번 조용하다고 죽이지 않는다."""
        self.assertGreater(tw._QWEN_PROGRESS_PROBE_ROUNDS, 1)

    def test_inactivity_budget_unchanged(self):
        """production 무응답 예산 자체는 그대로다 — 바뀐 것은 판정 신호다."""
        self.assertEqual(tw._QWEN_INACTIVITY_SEC, 280)

    def test_no_response_helper_can_defer(self):
        """_no_response 는 즉시 종료가 아니라 '더 기다림' 을 돌려줄 수 있어야 한다."""
        import inspect
        src = inspect.getsource(tw._run_qwen_bridge) if hasattr(tw, "_run_qwen_bridge") else ""
        if not src:
            src = open("tts_worker.py", encoding="utf-8").read()
        self.assertIn("_e = _no_response()", src)
        self.assertIn("if _e is not None:", src)
        self.assertIn("continue", src)

    def test_gpu_signal_is_consulted_before_killing(self):
        src = open("tts_worker.py", encoding="utf-8").read()
        i = src.index("def _no_response():")
        j = src.index("_kill_proc_tree(proc)", i)
        body = src[i:j]
        self.assertIn("_gpu_busy()", body, "종료 전에 GPU 활동을 확인해야 한다")
        self.assertIn("proc.poll()", body, "프로세스 생존을 확인해야 한다")


if __name__ == "__main__":
    unittest.main()
