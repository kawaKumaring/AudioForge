# -*- coding: utf-8 -*-
"""분할 부분 실패 재현(R6 사전조건) — staging/atomic publish를 구현하기 '전에' 현재 계약을 고정한다.

이 테스트는 고쳐야 할 동작을 주장하지 않는다. 지금 무슨 일이 일어나는지를 실행으로 못박아,
나중에 staging 구조를 넣을 때 무엇이 달라지는지 비교할 수 있게 한다.

실제 ffmpeg·GPU·사용자 미디어를 쓰지 않는다. subprocess.run만 가짜로 바꿔 k번째 트랙에서
실패를 주입하고, 그 시점에 디스크에 무엇이 남는지 관찰한다.

실행: cd python && python -m unittest discover -s . -p "test_split_partial_failure.py"
"""
import json
import os
import sys
import tempfile
import shutil
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import separate  # noqa: E402


class _Args:
    def __init__(self, output, output_format="wav"):
        self.output = output
        self.output_format = output_format
        self.input = os.path.join(output, "source.wav")


class _Proc:
    def __init__(self, rc):
        self.returncode = rc
        self.stdout = b""
        self.stderr = b"injected failure"


class SplitPartialFailureContract(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="af_split_partial_test_")
        self.args = _Args(self.dir)
        self._real_run = separate.subprocess.run
        self._emitted = []
        self._real_emit = separate.emit

        def _capture(kind, **kw):
            self._emitted.append((kind, kw))
        separate.emit = _capture

    def tearDown(self):
        separate.subprocess.run = self._real_run
        separate.emit = self._real_emit
        shutil.rmtree(self.dir, ignore_errors=True)

    def _install_fake_ffmpeg(self, fail_at_index):
        """subprocess.run을 가짜로: 성공이면 out_path(마지막 인자)를 만들고, fail_at_index면 실패."""
        calls = {"n": 0}

        def fake_run(cmd, **kwargs):
            i = calls["n"]
            calls["n"] += 1
            out_path = cmd[-1]
            if i == fail_at_index:
                return _Proc(1)
            with open(out_path, "wb") as f:
                f.write(b"RIFF----WAVEfake")
            return _Proc(0)

        separate.subprocess.run = fake_run
        return calls

    def test_partial_outputs_remain_on_failure(self):
        """두 번째 트랙에서 실패 → 첫 트랙 wav/json은 디스크에 남고 반환은 None."""
        self._install_fake_ffmpeg(fail_at_index=1)
        specs = [("track_01", "Track 01"), ("track_02", "Track 02"), ("track_03", "Track 03")]
        tracks = separate._extract_tracks_ffmpeg(
            "ffmpeg", self.args.input, [0.0, 10.0, 20.0, 30.0], specs, self.args, 10, 60)

        self.assertIsNone(tracks, "부분 실패는 None을 반환한다(현재 계약)")
        left = sorted(os.listdir(self.dir))
        # 현재 동작: 실패 이전 트랙의 산출물이 최종 위치에 그대로 남는다.
        self.assertIn("track_01.wav", left)
        self.assertIn("track_01.json", left)
        # 실패한 트랙과 그 이후 트랙은 없다.
        self.assertNotIn("track_02.wav", left)
        self.assertNotIn("track_03.wav", left)
        # 목록 파일은 만들어지지 않는다 → 아래 복원 계약 테스트의 전제.
        self.assertNotIn("_tracklist.txt", left)

    def test_no_tracklist_and_no_session_marker_after_failure(self):
        """실패 폴더에는 _tracklist.txt가 없다. session.json은 main이 성공 시에만 쓰므로 역시 없다.
        결과적으로 이 폴더는 '부분 산출물이 있지만 복원 목록에는 절대 뜨지 않는' 상태가 된다."""
        self._install_fake_ffmpeg(fail_at_index=0)
        specs = [("track_01", "Track 01"), ("track_02", "Track 02")]
        tracks = separate._extract_tracks_ffmpeg(
            "ffmpeg", self.args.input, [0.0, 10.0, 20.0], specs, self.args, 10, 60)
        self.assertIsNone(tracks)
        left = os.listdir(self.dir)
        self.assertNotIn("_tracklist.txt", left)
        self.assertNotIn("session.json", left)

    def test_success_path_writes_tracklist_inputs(self):
        """비교군 — 전부 성공하면 트랙 목록이 반환되고 파일이 모두 최종 위치에 있다."""
        self._install_fake_ffmpeg(fail_at_index=-1)
        specs = [("track_01", "Track 01"), ("track_02", "Track 02")]
        tracks = separate._extract_tracks_ffmpeg(
            "ffmpeg", self.args.input, [0.0, 10.0, 20.0], specs, self.args, 10, 60)
        self.assertIsNotNone(tracks)
        self.assertEqual(len(tracks), 2)
        for t in tracks:
            self.assertTrue(os.path.exists(t["path"]))
            self.assertTrue(os.path.exists(t["meta_path"]))
        meta = json.load(open(tracks[0]["meta_path"], encoding="utf-8"))
        self.assertIn("start_time", meta)
        self.assertIn("end_time", meta)

    def test_failure_emits_structured_error_once(self):
        """실패는 error 이벤트 1회로 표면화된다(현재 메시지에는 code가 없다는 사실도 함께 고정)."""
        self._install_fake_ffmpeg(fail_at_index=1)
        specs = [("track_01", "Track 01"), ("track_02", "Track 02")]
        separate._extract_tracks_ffmpeg(
            "ffmpeg", self.args.input, [0.0, 10.0, 20.0], specs, self.args, 10, 60)
        errors = [kw for kind, kw in self._emitted if kind == "error"]
        self.assertEqual(len(errors), 1)
        # 현재 계약: 추출 실패 error에는 구조화 code가 없다(개선 후보이며 여기서 바꾸지 않는다).
        self.assertNotIn("code", errors[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
