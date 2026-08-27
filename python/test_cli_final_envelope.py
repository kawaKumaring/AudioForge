# -*- coding: utf-8 -*-
"""C3 — CLI 성공 판정(구조화 종결 봉투) 테스트.

배경: separate.py의 TTS 모드는 error 이벤트를 낸 뒤 main()에서 return 했다 —
파서 parity 불일치, 참조 override 만료, INVALID_TTS_CONFIG(감정 경계/말끝), 그리고
synthesize가 던지는 모든 RuntimeError(모델 로딩 실패·생성 상한 도달 포함)까지 전부.
main()에서 return 하면 종료 코드는 0이므로, 종료 코드만 읽는 자동화 호출자는 실패를 성공으로 읽는다.

채택한 해법(Option B): 종료 코드는 그대로 두고, 실행당 정확히 한 줄의 구조화 봉투를 낸다.
  종료 코드를 0이 아니게 만들면 python-runner가 stderr 기반 '문자열' error를 한 번 더 emit 하고
  그것이 구조화 error({message, code})를 덮어써서 code가 사라진다(GENERATION_LIMIT_EXCEEDED /
  INVALID_TTS_CONFIG 분기 UX가 조용히 깨진다). 그 보정은 src/ 소유라 여기서 건드리지 않는다.

성공 조건은 단 하나: terminal=="result" 이면서 선언된 산출물이 실제로 존재하고 0바이트가 아닐 것.
한 실행이 result와 error를 함께 내면 성공이 아니다(DOUBLE_TERMINAL).

GPU·모델 없음. 대부분 in-process이며 서브프로세스는 2건(실제 stdout 도달 증명)만 쓴다.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# separate.py는 import 시점에 audio_utils.emit 을 자기 래퍼로 교체한다(지연 import 되는
# 하위 모듈까지 같은 래퍼를 보게 하려는 의도적 설계). 테스트 프로세스 전역에 그 부작용을
# 남기지 않도록 import 직후 되돌린다 — separate.emit 은 그대로 직접 호출해 검증한다.
import audio_utils  # noqa: E402
_ORIG_EMIT = audio_utils.emit
import separate  # noqa: E402
audio_utils.emit = _ORIG_EMIT

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable

# python-runner.ts(handleLine)가 실제로 분기하는 type 집합. 'final'이 여기 없다는 것이
# 'Electron 영향 0'의 근거다 — 파싱은 되지만 어떤 분기에도 걸리지 않고 버려진다.
RUNNER_HANDLED_TYPES = {"progress", "status", "result", "error"}


class _EnvelopeBase(unittest.TestCase):
    """separate.emit / _emit_final 을 in-process로 구동하고 봉투만 관찰한다."""

    def setUp(self):
        self.lines = []
        self._snap = dict(separate._RUN)
        separate._RUN.update({"mode": "tts", "result": 0, "error": 0, "error_code": None,
                              "outputs": [], "mismatch": False, "final_emitted": False})
        self.addCleanup(lambda: separate._RUN.update(self._snap))
        self._orig = separate._emit_upstream
        separate._emit_upstream = lambda mt, **kw: self.lines.append((mt, kw))
        self.addCleanup(lambda: setattr(separate, "_emit_upstream", self._orig))
        self.tmp = tempfile.mkdtemp(prefix="af_final_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def _wav(self, name="synthesized.wav", size=64):
        p = os.path.join(self.tmp, name)
        with open(p, "wb") as f:
            f.write(b"\0" * size)
        return p

    def _final(self):
        finals = [kw for mt, kw in self.lines if mt == "final"]
        self.assertEqual(len(finals), 1, f"봉투는 실행당 정확히 1줄: {len(finals)}줄")
        return finals[0]


class SuccessConditionTest(_EnvelopeBase):
    def test_result_with_real_file_is_ok(self):
        p = self._wav()
        separate.emit("result", tracks=[{"name": "synthesized", "path": p}], outputDir=self.tmp)
        separate._emit_final(0)
        f = self._final()
        self.assertTrue(f["ok"])
        self.assertEqual(f["terminal"], "result")
        self.assertTrue(f["output_verified"])
        self.assertEqual(f["outputs"], 1)
        self.assertIsNone(f["code"])

    def test_result_with_missing_file_is_not_ok(self):
        """result 도달만으로는 성공이 아니다 — 실제 산출물 검증이 함께여야 한다."""
        ghost = os.path.join(self.tmp, "does_not_exist.wav")
        separate.emit("result", tracks=[{"name": "synthesized", "path": ghost}])
        separate._emit_final(0)
        f = self._final()
        self.assertFalse(f["ok"])
        self.assertEqual(f["terminal"], "result")
        self.assertEqual(f["code"], "OUTPUT_MISSING")
        self.assertFalse(f["output_verified"])

    def test_result_with_zero_byte_file_is_not_ok(self):
        p = self._wav(size=0)
        separate.emit("result", tracks=[{"name": "synthesized", "path": p}])
        separate._emit_final(0)
        f = self._final()
        self.assertFalse(f["ok"])
        self.assertEqual(f["code"], "OUTPUT_MISSING")

    def test_result_with_one_missing_among_many_is_not_ok(self):
        ok_p = self._wav("a.wav")
        separate.emit("result", tracks=[{"path": ok_p},
                                        {"path": os.path.join(self.tmp, "b.wav")}])
        separate._emit_final(0)
        f = self._final()
        self.assertFalse(f["ok"])
        self.assertEqual(f["outputs"], 2)

    def test_result_without_declared_outputs_is_ok(self):
        """preflight/ref-analyze 같은 조회성 모드는 산출물 선언이 0개다 — 공허참으로 성공."""
        separate._RUN["mode"] = "pitch-preflight"
        separate.emit("result", available=True, reason="rubberband")
        separate._emit_final(0)
        f = self._final()
        self.assertTrue(f["ok"])
        self.assertEqual(f["outputs"], 0)
        self.assertEqual(f["mode"], "pitch-preflight")

    def test_path_mismatch_is_not_ok(self):
        """synthesize가 돌려준 경로가 result가 선언한 tracks에 없으면 성공이 아니다."""
        p = self._wav()
        separate.emit("result", tracks=[{"path": p}])
        separate._RUN["mismatch"] = True
        separate._emit_final(0)
        f = self._final()
        self.assertFalse(f["ok"])
        self.assertEqual(f["code"], "OUTPUT_PATH_MISMATCH")


class ErrorTerminalTest(_EnvelopeBase):
    def test_error_terminal_is_not_ok(self):
        separate.emit("error", message="모델 로딩 실패", code="QWEN_LOAD_TIMEOUT")
        separate._emit_final(0)
        f = self._final()
        self.assertFalse(f["ok"])
        self.assertEqual(f["terminal"], "error")
        self.assertEqual(f["code"], "QWEN_LOAD_TIMEOUT",
                         "구조화 code는 봉투까지 보존돼야 한다")
        self.assertFalse(f["output_verified"])
        self.assertEqual(f["exit_code"], 0, "종료 코드는 바꾸지 않는다 — 봉투가 판정을 담는다")

    def test_error_without_code_still_not_ok(self):
        separate.emit("error", message="분리 결과가 없습니다.")
        separate._emit_final(1)
        f = self._final()
        self.assertFalse(f["ok"])
        self.assertEqual(f["terminal"], "error")
        self.assertIsNone(f["code"])
        self.assertEqual(f["exit_code"], 1)

    def test_no_terminal_is_not_ok(self):
        """외부 kill·조용한 return 등 종결 신호가 아예 없는 실행."""
        separate._emit_final(0)
        f = self._final()
        self.assertFalse(f["ok"])
        self.assertEqual(f["terminal"], "none")
        self.assertEqual(f["code"], "NO_TERMINAL_SIGNAL")

    def test_never_both_result_and_error(self):
        """한 실행이 result와 error를 함께 내면 어느 쪽도 신뢰하지 않는다."""
        p = self._wav()
        separate.emit("result", tracks=[{"path": p}])
        separate.emit("error", message="뒤늦은 오류", code="SOMETHING")
        separate._emit_final(0)
        f = self._final()
        self.assertFalse(f["ok"], "result가 있어도 error가 함께면 성공이 아니다")
        self.assertEqual(f["code"], "DOUBLE_TERMINAL")
        self.assertEqual(f["terminal"], "error")

    def test_error_then_result_also_double(self):
        p = self._wav()
        separate.emit("error", message="먼저 난 오류")
        separate.emit("result", tracks=[{"path": p}])
        separate._emit_final(0)
        self.assertEqual(self._final()["code"], "DOUBLE_TERMINAL")


class EnvelopeShapeTest(_EnvelopeBase):
    def test_final_emitted_exactly_once(self):
        separate.emit("error", message="x")
        separate._emit_final(0)
        separate._emit_final(1)
        separate._emit_final(0)
        self._final()   # 1줄 단언이 내장돼 있다

    def test_envelope_keys_are_stable(self):
        separate.emit("error", message="x", code="C")
        separate._emit_final(3)
        f = self._final()
        self.assertEqual(set(f), {"ok", "terminal", "mode", "code",
                                  "output_verified", "outputs", "exit_code"})
        self.assertIsInstance(f["ok"], bool)
        self.assertIsInstance(f["output_verified"], bool)
        self.assertIsInstance(f["outputs"], int)
        self.assertIn(f["terminal"], ("result", "error", "none"))

    def test_envelope_is_json_serializable(self):
        separate.emit("error", message="x", code="C")
        separate._emit_final(1)
        json.dumps(self._final(), ensure_ascii=False)

    def test_final_type_is_inert_for_electron(self):
        """'final'은 python-runner가 분기하는 type 집합에 없다 → 파싱만 되고 버려진다."""
        self.assertNotIn("final", RUNNER_HANDLED_TYPES)

    def test_emit_wrapper_passes_through_unchanged(self):
        """래퍼는 기록만 한다 — 상위로 넘기는 payload를 바꾸지 않는다."""
        separate.emit("progress", percent=42, message="진행")
        self.assertEqual(self.lines[0], ("progress", {"percent": 42, "message": "진행"}))


class CliIntegrationTest(unittest.TestCase):
    """실제 프로세스로 봉투가 stdout 마지막 줄에 도달하는지 + 종료 코드가 그대로인지."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_final_cli_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def _run(self, args):
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
        p = subprocess.run([PY, "-X", "utf8", "-u", os.path.join(HERE, "separate.py")] + args,
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", env=env, cwd=self.tmp, timeout=120)
        lines = [json.loads(ln) for ln in p.stdout.splitlines()
                 if ln.strip().startswith("{")]
        return p.returncode, lines

    def test_tts_config_error_exits_zero_but_envelope_not_ok(self):
        """C3가 고치는 바로 그 경우: error를 내고도 종료 코드 0으로 끝난다.
        종료 코드는 여전히 0이고(계약 불변), 봉투가 실패를 말한다."""
        cfg = os.path.join(self.tmp, "cfg.json")
        with open(cfg, "w", encoding="utf-8") as f:
            json.dump({"mode": "tts", "input": os.path.join(self.tmp, "nope.wav"),
                       "output": os.path.join(self.tmp, "out"),
                       "ttsText": "안녕하세요",
                       "ttsEmotionBoundaryMode": "garbage",
                       "ttsEmotionBoundaryPauseMs": 200}, f, ensure_ascii=False)
        rc, lines = self._run(["--config", cfg])
        self.assertEqual(rc, 0, "종료 코드는 바꾸지 않는다 — 기존 Electron 계약 보존")
        self.assertEqual(lines[-1]["type"], "final", "봉투는 stdout 마지막 줄")
        self.assertFalse(lines[-1]["ok"])
        self.assertEqual(lines[-1]["terminal"], "error")
        self.assertEqual(lines[-1]["code"], "INVALID_TTS_CONFIG")
        self.assertEqual(lines[-1]["mode"], "tts")
        self.assertEqual(sum(1 for m in lines if m["type"] == "final"), 1)
        # 구조화 error 라인 자체도 그대로 남아 있어야 한다(봉투가 대체하는 게 아니라 덧붙는다)
        errs = [m for m in lines if m["type"] == "error"]
        self.assertEqual(len(errs), 1)
        self.assertEqual(errs[0]["code"], "INVALID_TTS_CONFIG")

    def test_missing_input_keeps_exit_one_and_reports_it(self):
        """원래부터 sys.exit(1)이던 경로는 그대로 1로 끝나고, 봉투가 그 코드를 담는다."""
        rc, lines = self._run(["--mode", "music"])
        self.assertEqual(rc, 1)
        self.assertEqual(lines[-1]["type"], "final")
        self.assertFalse(lines[-1]["ok"])
        self.assertEqual(lines[-1]["terminal"], "error")
        self.assertEqual(lines[-1]["exit_code"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
