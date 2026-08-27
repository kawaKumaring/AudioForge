# -*- coding: utf-8 -*-
"""separate.py 오류 보존 계약 — 가짜 워커만(실제 모델·GPU·미디어·네트워크 없음).

버그: music_worker 의 P0 무결성 게이트가 code 를 담은 구조화 오류(예:
MUSIC_ENSEMBLE_SHAPE_MISMATCH + 샘플레이트/채널)를 emit 한 뒤 return [] 하면,
separate.main() 의  가 code 없는 일반 오류를 한 번 더 emit 했다.
메인 프로세스는 pending error 를 나중 것으로 덮어쓰므로 사용자에게는 가장
쓸모없는 마지막 메시지만 남고 code·진단 필드가 사라졌다.

계약: 한 실행에서 이미 오류가 나갔다면 뒤따르는 일반 오류로 그것을 덮지 않는다.
      오류가 하나도 없이 결과만 비었을 때는 여전히 원인을 보고한다.

separate.main() 을 argv 로 직접 구동한다(spawn 없음). music_worker 는 sys.modules
에 가짜 모듈을 꽂아 대체하므로 torch/audio-separator 를 import 하지 않는다.
"""

import io
import json
import os
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import audio_utils
import separate


SHAPE_ERROR = {
    "code": "MUSIC_ENSEMBLE_SHAPE_MISMATCH",
    "message": "앙상블 모델 출력 규격이 일치하지 않습니다.",
    "sample_rate_a": 44100,
    "sample_rate_b": 48000,
    "channels_a": 2,
    "channels_b": 1,
}


class _FakeMusicWorker(object):
    """sys.modules 에 꽂는 가짜 music_worker (무거운 의존 없음)."""

    def __init__(self, behaviour):
        self._behaviour = behaviour
        self.module = types.ModuleType("music_worker")
        self.module._MELBAND_ENSEMBLE_MODEL = "fake-melband"
        self.module.run_roformer_ensemble = self._run
        self.module.run_roformer_separation = self._run
        self.module.run_music_separation = self._run

    def _run(self, *a, **kw):
        return self._behaviour()

    def __enter__(self):
        self._saved = sys.modules.get("music_worker")
        sys.modules["music_worker"] = self.module
        return self

    def __exit__(self, *exc):
        if self._saved is None:
            sys.modules.pop("music_worker", None)
        else:
            sys.modules["music_worker"] = self._saved
        return False


def _drive_music(behaviour):
    """가짜 워커로 separate.main() 을 music/roformer_ensemble 경로에 구동.

    반환 (SystemExit code, [events]). stdout JSON 라인을 파싱한다."""
    buf = io.StringIO()
    audio_utils.reset_error_state()
    saved_argv = sys.argv
    exit_code = None
    with tempfile.TemporaryDirectory() as outdir:
        sys.argv = ["separate.py", "--mode", "music", "--model", "roformer_ensemble",
                    "--input", os.path.join(outdir, "song.wav"), "--output", outdir]
        try:
            with _FakeMusicWorker(behaviour):
                with redirect_stdout(buf):
                    try:
                        separate.main()
                    except SystemExit as e:
                        exit_code = e.code
        finally:
            sys.argv = saved_argv
            audio_utils.reset_error_state()
    events = []
    for line in buf.getvalue().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return exit_code, events


class FirstStructuredErrorWins(unittest.TestCase):

    def test_generic_error_does_not_replace_structured_one(self):
        def behaviour():
            audio_utils.emit("error", **SHAPE_ERROR)
            return []

        code, events = _drive_music(behaviour)
        errors = [e for e in events if e.get("type") == "error"]

        # 오류는 정확히 하나 — 일반 오류가 뒤따라 붙지 않는다.
        self.assertEqual(len(errors), 1, errors)
        err = errors[0]
        # 근본 원인(code + 진단 필드)이 그대로 살아 있다.
        self.assertEqual(err["code"], "MUSIC_ENSEMBLE_SHAPE_MISMATCH")
        self.assertEqual(err["sample_rate_a"], 44100)
        self.assertEqual(err["sample_rate_b"], 48000)
        self.assertEqual(err["channels_a"], 2)
        self.assertEqual(err["channels_b"], 1)
        self.assertEqual(err["message"], SHAPE_ERROR["message"])
        # 덮어쓰던 일반 메시지는 어디에도 없다.
        self.assertNotIn("분리 결과가 없습니다.",
                         [e.get("message") for e in errors])
        self.assertEqual(code, 1)

    def test_multiple_worker_errors_keep_the_first_as_terminal(self):
        # 워커가 오류를 두 번 내도 separate 는 세 번째를 덧붙이지 않는다.
        def behaviour():
            audio_utils.emit("error", **SHAPE_ERROR)
            audio_utils.emit("error", code="MUSIC_ENSEMBLE_NON_FINITE",
                             message="비유한값")
            return []

        code, events = _drive_music(behaviour)
        errors = [e for e in events if e.get("type") == "error"]
        self.assertEqual(len(errors), 2, errors)
        self.assertEqual(errors[0]["code"], "MUSIC_ENSEMBLE_SHAPE_MISMATCH")
        self.assertEqual(code, 1)

    def test_empty_result_without_prior_error_still_reports(self):
        # 아무도 오류를 내지 않고 결과만 비었으면 원인 없는 빈 결과를 여전히 보고한다.
        code, events = _drive_music(lambda: [])
        errors = [e for e in events if e.get("type") == "error"]
        self.assertEqual(len(errors), 1, errors)
        self.assertEqual(errors[0]["message"], "분리 결과가 없습니다.")
        self.assertNotIn("code", errors[0])
        self.assertEqual(code, 1)

    def test_success_path_emits_no_error(self):
        # 트랙이 있으면 오류 경로 자체를 타지 않는다(가드가 성공을 막지 않는지).
        def behaviour():
            return [{"name": "vocals", "label": "보컬", "path": "vocals.wav"}]

        code, events = _drive_music(behaviour)
        self.assertEqual([e for e in events if e.get("type") == "error"], [])
        results = [e for e in events if e.get("type") == "result"]
        self.assertEqual(len(results), 1, results)
        self.assertIsNone(code)


class EmitErrorFlag(unittest.TestCase):
    """audio_utils 의 실행 단위 error 플래그 자체."""

    def setUp(self):
        audio_utils.reset_error_state()

    def tearDown(self):
        audio_utils.reset_error_state()

    def test_flag_starts_false_and_only_error_sets_it(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertFalse(audio_utils.error_already_emitted())
            audio_utils.emit("progress", percent=10)
            audio_utils.emit("result", tracks=[])
            self.assertFalse(audio_utils.error_already_emitted())
            audio_utils.emit("error", message="x")
            self.assertTrue(audio_utils.error_already_emitted())

    def test_reset_clears_flag(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            audio_utils.emit("error", message="x")
        self.assertTrue(audio_utils.error_already_emitted())
        audio_utils.reset_error_state()
        self.assertFalse(audio_utils.error_already_emitted())

    def test_emit_payload_unchanged(self):
        # 플래그 추적이 stdout JSON 라인 형태를 바꾸지 않는다.
        buf = io.StringIO()
        with redirect_stdout(buf):
            audio_utils.emit("error", code="X", message="메시지")
        self.assertEqual(json.loads(buf.getvalue().strip()),
                         {"type": "error", "code": "X", "message": "메시지"})


if __name__ == "__main__":
    unittest.main()
