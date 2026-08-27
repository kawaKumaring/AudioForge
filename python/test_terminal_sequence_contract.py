# -*- coding: utf-8 -*-
"""두 브랜치가 같은 emit 지점을 각자 고쳐 생긴 충돌 — 그 해결을 실행으로 고정한다.

충돌한 두 의미(어느 쪽도 버리지 않았다):
  A) cross-mode-quality-next : audio_utils 가 프로세스 단위로 _error_emitted 를 세우고,
     호출부는 error_already_emitted() 로 확인해 '첫 구조화 오류'를 종결 권위로 남긴다.
  B) tts-runtime-onset-tail  : separate.py 가 audio_utils.emit 을 자기 래퍼로 '교체'하고
     (지연 import 되는 워커까지 같은 래퍼를 보게), 실행당 한 줄의 final 봉투를 낸다.

왜 별도 파일인가 — test_cli_final_envelope.py 는 봉투 시퀀스(result/error/double/none 등)를
이미 충분히 덮지만, 그 파일은 검증 목적상 _emit_upstream 을 람다로 대체하고 import 직후
audio_utils.emit 을 원본으로 되돌린다. 즉 '래퍼를 통과한 뒤 원본이 플래그를 세우는가' 라는
바로 그 교차 경로는 어느 브랜치의 테스트에서도 한 번도 실행되지 않았다. 이 파일이 그것을 덮는다.

여기서 stdout 은 실제로 audio_utils.emit 을 통과시키되 버린다 — 플래그가 '진짜로' 서는지
보려면 원본을 우회하면 안 되기 때문이다.

GPU·실모델·사용자 미디어·네트워크 미사용.
실행: cd python && python -m unittest discover -s . -p "test_terminal_sequence_contract.py"
"""
import contextlib
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import audio_utils  # noqa: E402
import separate  # noqa: E402  (import 부작용: audio_utils.emit 을 래퍼로 교체한다)


class _MergeBase(unittest.TestCase):
    """래퍼가 설치된 '프로덕션 상태' 그대로 구동한다.

    주의 — test_cli_final_envelope.py 는 모듈 최상단에서 audio_utils.emit 을 원본으로
    되돌린다(자기 검증에 필요한 조치). 그 부작용은 테스트 프로세스 전역에 남으므로,
    discover 순서에 따라 이 파일이 프로덕션과 다른 상태를 물려받을 수 있다. 여기서는
    setUp 이 프로덕션 상태를 명시적으로 세우고 tearDown 이 원래대로 돌려놓아
    실행 순서와 무관하게 같은 결과가 나오게 한다.
    """

    def setUp(self):
        self.seen = []
        self._emit_snap = audio_utils.emit
        audio_utils.emit = separate.emit      # 프로덕션 상태(=separate import 직후)
        self.addCleanup(lambda: setattr(audio_utils, "emit", self._emit_snap))
        self._snap = dict(separate._RUN)
        separate._RUN.update({"mode": "tts", "result": 0, "error": 0, "error_code": None,
                              "outputs": [], "mismatch": False, "final_emitted": False})
        self.addCleanup(lambda: separate._RUN.update(self._snap))

        # 원본으로 '실제로' 위임하되 stdout 만 삼킨다. 위임을 끊으면 _error_emitted 가
        # 서지 않아 검증하려던 교차 동작 자체가 사라진다.
        real_upstream = separate._emit_upstream

        def observing(msg_type, **kw):
            self.seen.append((msg_type, kw))
            with contextlib.redirect_stdout(io.StringIO()):
                return real_upstream(msg_type, **kw)

        separate._emit_upstream = observing
        self.addCleanup(lambda: setattr(separate, "_emit_upstream", real_upstream))

        audio_utils.reset_error_state()
        self.addCleanup(audio_utils.reset_error_state)

        self.tmp = tempfile.mkdtemp(prefix="af_merge_terminal_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def _wav(self, name="synthesized.wav", size=64):
        p = os.path.join(self.tmp, name)
        with open(p, "wb") as f:
            f.write(b"RIFF" + b"\0" * size)
        return p

    def _final(self):
        separate._emit_final(0)
        envelopes = [kw for k, kw in self.seen if k == "final"]
        self.assertEqual(len(envelopes), 1, "final 봉투는 실행당 정확히 1회")
        return envelopes[0]

    def kinds(self):
        return [k for k, _ in self.seen]


class WrapperPreservesErrorFlag(_MergeBase):
    """B의 래퍼가 설치된 상태에서도 A의 플래그가 선다 — 병합의 핵심 단언."""

    def test_wrapper_delegates_and_sets_flag(self):
        self.assertFalse(audio_utils.error_already_emitted())
        separate.emit("error", code="MUSIC_ENSEMBLE_SHAPE_MISMATCH", message="형식 불일치")
        self.assertTrue(audio_utils.error_already_emitted(),
                        "래퍼가 원본으로 패스스루하므로 _error_emitted 가 선다")

    def test_module_attribute_is_the_wrapper(self):
        """지연 import 되는 워커가 `from audio_utils import emit` 할 때 집는 것이 래퍼여야
        한 실행의 모든 터미널 신호가 _RUN 한 곳에 모인다.

        이 단언만은 '깨끗한 프로세스'에서 확인한다. 같은 프로세스에서는 다른 테스트 파일이
        이미 audio_utils.emit 을 원복했을 수 있어(위 클래스 주석 참조) 그 상태를 검사하면
        프로덕션 사실이 아니라 테스트 실행 순서를 재는 셈이 된다."""
        probe = (
            "import sys; sys.path.insert(0, %r)\n"
            "import audio_utils, separate\n"
            "assert audio_utils.emit is separate.emit, 'wrapper not installed on import'\n"
            "print('OK')\n" % HERE
        )
        env = dict(os.environ, PYTHONIOENCODING="utf-8")
        proc = subprocess.run([sys.executable, "-c", probe], capture_output=True,
                              text=True, timeout=180, env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr[-800:])
        self.assertIn("OK", proc.stdout)

    def test_worker_style_lazy_import_path(self):
        """워커가 하는 것과 동일하게 audio_utils 를 통해 얻은 emit 으로 오류를 낸다.
        → _RUN 기록(B)과 _error_emitted(A)가 '동시에' 갱신되어야 한다."""
        from audio_utils import emit as worker_emit
        worker_emit("error", code="QWEN_LOAD_TIMEOUT", message="로딩 시간 초과")
        self.assertTrue(audio_utils.error_already_emitted(), "A: 플래그")
        self.assertEqual(separate._RUN["error"], 1, "B: 터미널 계수")
        self.assertEqual(separate._RUN["error_code"], "QWEN_LOAD_TIMEOUT", "B: 근본 code")

    def test_first_error_is_authority_in_both_mechanisms(self):
        """두 기제가 '첫 오류가 권위' 라는 같은 결론에 도달한다(서로 모순되지 않는다)."""
        separate.emit("error", code="PARSER_PARITY_MISMATCH", message="첫 오류")
        separate.emit("error", message="뒤이은 일반 오류")     # code 없음
        self.assertEqual(separate._RUN["error_code"], "PARSER_PARITY_MISMATCH",
                         "나중 일반 오류가 근본 code 를 지우지 않는다")
        env = self._final()
        self.assertEqual(env["code"], "PARSER_PARITY_MISMATCH")
        self.assertFalse(env["ok"])

    def test_guard_suppresses_the_second_generic_error(self):
        """호출부 계약 재현 — error_already_emitted() 로 막으면 일반 오류가 아예 안 나간다."""
        separate.emit("error", code="SPLIT_MARKERS_INVALID", message="마커 형식 오류")
        if not audio_utils.error_already_emitted():
            separate.emit("error", message="분리 결과가 없습니다.")   # 실행되면 안 됨
        self.assertEqual(len([k for k in self.kinds() if k == "error"]), 1)
        self.assertEqual(self._final()["code"], "SPLIT_MARKERS_INVALID")

    def test_flag_untouched_by_non_error_events(self):
        for kind in ("status", "progress", "result", "dialogueSidecar"):
            separate.emit(kind, message="x")
        self.assertFalse(audio_utils.error_already_emitted(),
                         "error 이외의 어떤 이벤트도 플래그를 세우지 않는다")


class WrapperIsTransparent(_MergeBase):
    """래퍼 삽입이 기존 이벤트 계약을 바꾸지 않았음을 확인한다."""

    def test_order_and_payload_unchanged(self):
        p = self._wav()
        separate.emit("status", message="시작")
        separate.emit("progress", percent=50, message="진행")
        separate.emit("result", tracks=[{"name": "synthesized", "path": p}], outputDir=self.tmp)
        self.assertEqual(self.kinds(), ["status", "progress", "result"])
        payload = [kw for k, kw in self.seen if k == "progress"][0]
        self.assertEqual(payload["percent"], 50)
        res = [kw for k, kw in self.seen if k == "result"][0]
        self.assertEqual(res["outputDir"], self.tmp)
        self.assertEqual(res["tracks"][0]["path"], p)

    def test_return_value_passthrough(self):
        """래퍼는 원본의 반환값을 그대로 돌려준다(원본은 None 을 반환한다)."""
        self.assertIsNone(separate.emit("status", message="x"))

    def test_sidecar_events_reach_upstream_unmodified(self):
        """sidecar 3종은 terminal 판정에 관여하지 않고 그대로 통과한다."""
        for kind in ("music_p1_shadow", "dialogueSidecar", "asrTranscriptSidecar"):
            separate.emit(kind, schemaVersion="1.0.0")
        self.assertEqual(separate._RUN["result"], 0)
        self.assertEqual(separate._RUN["error"], 0)
        p = self._wav()
        separate.emit("result", tracks=[{"path": p}])
        env = self._final()
        self.assertTrue(env["ok"], "sidecar 가 성공 판정을 흐리지 않는다")


class SplitMarkerAuthorityCoexists(_MergeBase):
    """cross-mode 가 들여온 split_markers 단일 권위가 병합 후에도 살아 있다."""

    def test_split_markers_module_is_imported(self):
        self.assertTrue(hasattr(separate, "_sm"))
        for fn in ("parse_marker_csv", "validate_markers"):
            self.assertTrue(callable(getattr(separate._sm, fn, None)), fn)

    def test_invalid_marker_error_flows_through_wrapper(self):
        """마커 검증 실패가 구조화 code 로 나가고, 그 code 가 final 봉투까지 도달한다."""
        separate.emit("error", code="SPLIT_MARKERS_INVALID", message="마커 형식 오류")
        env = self._final()
        self.assertEqual(env["terminal"], "error")
        self.assertEqual(env["code"], "SPLIT_MARKERS_INVALID")
        self.assertTrue(audio_utils.error_already_emitted())

    def test_split_tmp_prefix_helper_survived(self):
        self.assertTrue(callable(getattr(separate, "_split_tmp_prefix", None)),
                        "runToken 기반 임시 접두사 헬퍼(P0.4)가 병합에서 유실되지 않았다")


if __name__ == "__main__":
    unittest.main(verbosity=2)
