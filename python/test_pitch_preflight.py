# -*- coding: utf-8 -*-
"""pitch capability preflight(계약 G-A) 단위 테스트 — pitch_available 4경로 + separate.py mode 무미디어.

pitch_available: rubberband 지원 / 미지원 / ffmpeg 없음 / subprocess 오류. 캐시.
separate.py pitch-preflight: 미디어 입력·모델 로딩 없이 available/reason 결과만 emit(경로/민감정보 미포함).
"""
import os
import sys
import json
import subprocess
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pitch_shift


class _Proc:
    def __init__(self, stdout):
        self.stdout = stdout
        self.returncode = 0


FILTERS_WITH_RB = b" T.. afftdn            Denoise\n T.. rubberband        Apply time-stretch/pitch\n T.. atempo             Tempo\n"
FILTERS_NO_RB = b" T.. afftdn            Denoise\n T.. atempo             Tempo\n"


class PitchAvailableTest(unittest.TestCase):
    def setUp(self):
        pitch_shift._pitch_support_cache.clear()
        self._p = mock.patch.object(pitch_shift, "_resolve_ffmpeg", new=lambda ff=None: "C:/fake/ffmpeg.exe")
        self._p.start(); self.addCleanup(self._p.stop)

    def test_rubberband_supported(self):
        with mock.patch.object(subprocess, "run", return_value=_Proc(FILTERS_WITH_RB)):
            self.assertEqual(pitch_shift.pitch_available(), (True, "rubberband"))

    def test_rubberband_unsupported(self):
        with mock.patch.object(subprocess, "run", return_value=_Proc(FILTERS_NO_RB)):
            self.assertEqual(pitch_shift.pitch_available(), (False, "rubberband-unsupported"))

    def test_ffmpeg_missing(self):
        with mock.patch.object(pitch_shift, "_resolve_ffmpeg", new=lambda ff=None: None):
            self.assertEqual(pitch_shift.pitch_available(), (False, "ffmpeg-not-found"))

    def test_subprocess_error(self):
        with mock.patch.object(subprocess, "run", side_effect=OSError("boom")):
            self.assertEqual(pitch_shift.pitch_available(), (False, "ffmpeg-filters-query-failed"))

    def test_subprocess_timeout(self):
        with mock.patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired("ffmpeg", 30)):
            self.assertEqual(pitch_shift.pitch_available(), (False, "ffmpeg-filters-query-failed"))

    def test_cache_reuse(self):
        calls = []

        def fake_run(*a, **k):
            calls.append(1)
            return _Proc(FILTERS_WITH_RB)
        with mock.patch.object(subprocess, "run", side_effect=fake_run):
            pitch_shift.pitch_available()
            pitch_shift.pitch_available()
        self.assertEqual(len(calls), 1, "동일 ffmpeg 경로는 -filters 1회만 조회(캐시)")

    def test_reason_has_no_path(self):
        # 사유 코드에 경로/민감정보가 없어야 함
        for reason in ("rubberband", "rubberband-unsupported", "ffmpeg-not-found", "ffmpeg-filters-query-failed"):
            self.assertNotIn("/", reason)
            self.assertNotIn("\\", reason)


class SeparatePitchPreflightModeTest(unittest.TestCase):
    """separate.py를 pitch-preflight 모드로 subprocess 실행 — 미디어/모델 없이 available/reason emit."""
    def test_mode_emits_result_without_media(self):
        here = os.path.dirname(os.path.abspath(__file__))
        cfg = os.path.join(here, "_pp_cfg_test.json")
        with open(cfg, "w", encoding="utf-8") as f:
            json.dump({"mode": "pitch-preflight"}, f)
        try:
            proc = subprocess.run([sys.executable, "-X", "utf8", os.path.join(here, "separate.py"),
                                   "--config", cfg], capture_output=True, text=True, timeout=60)
        finally:
            try:
                os.remove(cfg)
            except OSError:
                pass
        # 마지막 result 라인 파싱
        result = None
        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                m = json.loads(line)
            except Exception:
                continue
            if m.get("type") == "result":
                result = m
        self.assertIsNotNone(result, f"result 없음. stdout tail={proc.stdout[-200:]}")
        self.assertIn("available", result)
        self.assertIn("reason", result)
        self.assertIsInstance(result["available"], bool)
        # 입력/출력 경로 없이도 정상 종료(미디어 불필요)
        self.assertEqual(proc.returncode, 0, f"exit={proc.returncode} stderr={proc.stderr[-200:]}")
        # torch/모델 로딩 흔적이 stdout에 없어야(가벼운 probe) — 최소한 result가 나왔으면 OK
        self.assertNotIn("모델 로딩", proc.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
