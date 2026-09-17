"""Community-1 경로의 **계약** — 준비 안 됐을 때 조용히 다른 길로 가지 않는가.

여기서 보는 것 넷.
  1) 격리 환경·모델이 없으면 사유를 들고 실패한다
  2) 몰래 CPU 나 기존 엔진으로 바꾸지 않는다
  3) 겹침 정보를 구간 목록과 **따로** 낸다
  4) 밖으로 나가는 길을 막는다(텔레메트리 off·오프라인)
"""
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import conversation_worker as cw   # noqa: E402


class FakeProc:
    def __init__(self, rc=0, out="", err=""):
        self.returncode, self.stdout, self.stderr = rc, out, err


def _payload():
    return {
        "segments": [{"start": 0.0, "end": 5.0, "speaker": "SPEAKER_00"},
                     {"start": 5.0, "end": 9.0, "speaker": "SPEAKER_01"}],
        "exclusiveAvailable": True,
        "overlaps": [{"start": 4.5, "end": 5.2}],
        "speakers": ["SPEAKER_00", "SPEAKER_01"],
        "_run": {"engine": "pyannote-community-1", "device": "cuda", "gpuName": "RTX",
                 "loadSec": 2.0, "diarizeSec": 3.0, "peakGpuMemoryMB": 1234.5,
                 "generalSegmentCount": 3, "exclusiveSegmentCount": 2,
                 "overlapSpanCount": 1, "telemetry": "false", "hubOffline": "1"},
    }


class NotReady(unittest.TestCase):
    def test_missing_venv_says_so(self):
        with mock.patch("os.path.isfile", return_value=False):
            with self.assertRaises(cw.Community1Unavailable) as cm:
                cw._community1_paths()
        self.assertIn("DIARIZE_VENV_MISSING", str(cm.exception))

    def test_missing_model_says_so(self):
        with mock.patch("os.path.isfile", side_effect=lambda p: p.endswith("python.exe")), \
             mock.patch("os.path.isdir", return_value=False):
            with self.assertRaises(cw.Community1Unavailable) as cm:
                cw._community1_paths()
        msg = str(cm.exception)
        self.assertIn("DIARIZE_MODEL_MISSING", msg)
        self.assertIn("이용 조건", msg, "무엇을 해야 하는지 알려야 한다")
        self.assertIn("자동 다운로드는 하지 않습니다", msg)

    def test_bridge_failure_raises_with_reason(self):
        with mock.patch.object(cw, "_community1_paths", return_value=("py.exe", "d")), \
             mock.patch("subprocess.run", return_value=FakeProc(1, "", "CUDA out of memory")), \
             mock.patch.object(cw, "emit"):
            with self.assertRaises(RuntimeError) as cm:
                cw.run_community1_diarization("a.wav", "out", 2)
        m = str(cm.exception)
        self.assertIn("DIARIZE_FAILED", m)
        self.assertIn("CUDA", m, "왜 실패했는지가 사유에 남아야 한다")


class NoSilentFallback(unittest.TestCase):
    def test_always_asks_for_cuda(self):
        sent = {}

        def capture(cmd, **kw):
            sent["cmd"] = cmd
            sent["env"] = kw.get("env") or {}
            out = cmd[cmd.index("--out") + 1]
            with open(out, "w", encoding="utf-8") as f:
                json.dump(_payload(), f)
            return FakeProc(0)

        with mock.patch.object(cw, "_community1_paths", return_value=("py.exe", "d")), \
             mock.patch("subprocess.run", side_effect=capture), \
             mock.patch.object(cw, "emit"), \
             mock.patch("audio_utils.load_audio", side_effect=RuntimeError("stop-here")):
            with self.assertRaises(RuntimeError):
                cw.run_community1_diarization("a.wav", "out", 2)
        cmd = sent["cmd"]
        self.assertIn("cuda", cmd)
        self.assertNotIn("cpu", cmd)
        self.assertIn("--num-speakers", cmd, "화자 수 설정을 전달해야 한다")
        self.assertEqual(cmd[cmd.index("--num-speakers") + 1], "2")

    def test_outbound_paths_are_closed(self):
        sent = {}

        def capture(cmd, **kw):
            sent["env"] = kw.get("env") or {}
            out = cmd[cmd.index("--out") + 1]
            with open(out, "w", encoding="utf-8") as f:
                json.dump(_payload(), f)
            return FakeProc(0)

        with mock.patch.object(cw, "_community1_paths", return_value=("py.exe", "d")), \
             mock.patch("subprocess.run", side_effect=capture), \
             mock.patch.object(cw, "emit"), \
             mock.patch("audio_utils.load_audio", side_effect=RuntimeError("stop-here")):
            with self.assertRaises(RuntimeError):
                cw.run_community1_diarization("a.wav", "out", 2)
        env = sent["env"]
        self.assertEqual(env.get("PYANNOTE_METRICS_ENABLED"), "false", "텔레메트리를 꺼야 한다")
        self.assertEqual(env.get("HF_HUB_OFFLINE"), "1", "실행 중 다운로드를 막아야 한다")
        self.assertEqual(env.get("HF_HUB_DISABLE_TELEMETRY"), "1")


class OverlapIsSeparate(unittest.TestCase):
    def test_overlaps_kept_apart_from_segments(self):
        made = {}

        def capture(cmd, **kw):
            out = cmd[cmd.index("--out") + 1]
            with open(out, "w", encoding="utf-8") as f:
                json.dump(_payload(), f)
            return FakeProc(0)

        def fake_rebuild(wav, sr, segments, output_dir, prefix="speaker"):
            made["segments"] = segments
            return [{"name": "speaker_a", "label": "SPEAKER_00", "path": "p", "segments": 1}], []

        import dialogue_rebuild as dr
        with mock.patch.object(cw, "_community1_paths", return_value=("py.exe", "d")), \
             mock.patch("subprocess.run", side_effect=capture), \
             mock.patch.object(cw, "emit"), \
             mock.patch("audio_utils.load_audio", return_value=(mock.MagicMock(shape=(1, 100)), 16000)), \
             mock.patch.object(dr, "rebuild_speaker_tracks", side_effect=fake_rebuild):
            tracks = cw.run_community1_diarization("a.wav", "out", 2)
        self.assertTrue(tracks)
        # 트랙 배정에 쓰인 것은 exclusive 구간이고, 겹침은 섞이지 않았다.
        self.assertEqual(len(made["segments"]), 2)
        self.assertNotIn("overlap", json.dumps(made["segments"]))
        self.assertEqual(cw.LAST_OVERLAPS, [{"start": 4.5, "end": 5.2}])
        self.assertEqual(len(cw.LAST_SEGMENTS), 2)




class OverlapMath(unittest.TestCase):
    """겹침 구간 계산 — 다리의 순수 함수."""

    def setUp(self):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import importlib.util as u
        spec = u.spec_from_file_location(
            "dz_bridge", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                      "diarize_pyannote_bridge.py"))
        self.m = u.module_from_spec(spec)
        spec.loader.exec_module(self.m)

    def test_no_overlap(self):
        segs = [{"start": 0, "end": 5, "speaker": "A"}, {"start": 5, "end": 9, "speaker": "B"}]
        self.assertEqual(self.m._overlap_spans(segs), [])

    def test_two_speakers_at_once(self):
        segs = [{"start": 0, "end": 5, "speaker": "A"}, {"start": 4, "end": 7, "speaker": "B"}]
        self.assertEqual(self.m._overlap_spans(segs), [{"start": 4.0, "end": 5.0}])

    def test_three_speakers_counts_once(self):
        segs = [{"start": 0, "end": 6, "speaker": "A"}, {"start": 1, "end": 5, "speaker": "B"},
                {"start": 2, "end": 4, "speaker": "C"}]
        spans = self.m._overlap_spans(segs)
        self.assertEqual(spans, [{"start": 1.0, "end": 5.0}], "겹친 자리를 하나로 묶는다")


if __name__ == "__main__":
    unittest.main(verbosity=2)
