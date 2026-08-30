# -*- coding: utf-8 -*-
"""작업 전체 벽시계 천장 회귀.

progress watchdog(무응답)·generation limit(생성량)과 **별개 축**이다.
둘 다 정상인데도 작업이 끝없이 길어질 수 있다 — chunk 가 많고 각각은 정상 종료하는 장문.
"""
import unittest
from unittest import mock

import tts_worker as tw


class JobWallClockTest(unittest.TestCase):
    def test_default_limit_is_one_hour(self):
        self.assertEqual(tw.MAX_JOB_WALL_TIME_SEC, 3600)

    def test_start_time_is_fixed_once(self):
        t = iter([0.0, 100.0, 200.0])
        c = tw.JobWallClock(clock=lambda: next(t))
        self.assertAlmostEqual(c.elapsed(), 100.0)
        self.assertAlmostEqual(c.elapsed(), 200.0)

    def test_within_limit_passes_silently(self):
        t = iter([0.0, 10.0])
        self.assertAlmostEqual(tw.JobWallClock(clock=lambda: next(t)).check(), 10.0)

    def test_exceeded_raises_structured_error(self):
        t = iter([0.0, 3601.0])
        c = tw.JobWallClock(clock=lambda: next(t))
        with self.assertRaises(tw.JobWallTimeExceeded) as cm:
            c.check(completed_chunks=7)
        p = cm.exception.error_payload
        self.assertEqual(p["code"], tw.JOB_WALL_TIME_EXCEEDED)
        self.assertEqual(p["limit_sec"], 3600)
        self.assertEqual(p["completed_chunks"], 7)
        self.assertGreater(p["elapsed_sec"], 3600)

    def test_boundary_is_strict_greater(self):
        t = iter([0.0, 3600.0])
        tw.JobWallClock(clock=lambda: next(t)).check()      # 정확히 상한은 통과

    def test_custom_limit_is_honoured(self):
        t = iter([0.0, 11.0])
        with self.assertRaises(tw.JobWallTimeExceeded):
            tw.JobWallClock(limit_sec=10, clock=lambda: next(t)).check()

    def test_is_separate_from_progress_and_generation_axes(self):
        """세 축이 서로 다른 code 를 쓴다 — 하나로 뭉뚱그리지 않는다."""
        self.assertNotEqual(tw.JOB_WALL_TIME_EXCEEDED, "QWEN_NO_RESPONSE")
        self.assertNotEqual(tw.JOB_WALL_TIME_EXCEEDED, "GENERATION_LIMIT_EXCEEDED")
        self.assertEqual(tw._QWEN_INACTIVITY_SEC, 280, "무응답 예산은 그대로다")

    def test_wired_after_generation_before_publish(self):
        src = open("tts_worker.py", encoding="utf-8").read()
        i = src.index("_job_clock = JobWallClock()")
        j = src.index("_job_clock.check(", i)
        k = src.index("seg_out = qwen.run_job(segments, device)", i)
        self.assertLess(i, k, "시계는 생성 전에 시작한다")
        self.assertLess(k, j, "확인은 생성 직후에 한다")


if __name__ == "__main__":
    unittest.main()
