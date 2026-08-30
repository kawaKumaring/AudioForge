# -*- coding: utf-8 -*-
"""분석 worker 프로토콜 계약 (GPU·모델 로딩 없음).

여기서 고정하는 것:
  · 요청 하나에 응답 한 줄, `request_id` 와 `source_sha256` 을 그대로 돌려준다
  · 본문과 SHA 가 어긋나면 계산하지 않고 SOURCE_SHA_MISMATCH 로 답한다
  · **아직 시작하지 않은** 낡은 대기 요청(`drop_before` 이전)은 계산을 생략하고 SUPERSEDED
    로 답한다. 이미 계산 중인 요청은 끝까지 가고, 그 결과는 호출부가 SHA 로 버린다
  · 응답에 대사 원문·chunk 텍스트가 들어가지 않는다(좌표만)
  · tokenizer 를 못 얻어도 실패하지 않고 근사로 답하되 그 사실을 드러낸다
  · 세 축(source_paragraphs / segments / chunks)이 응답에 그대로 있다
  · stdout 은 JSON 줄만, 로그는 stderr 로만 나간다

실제 tokenizer 로드는 여기서 하지 않는다 — `_count_tokens` 를 근사로 고정해 CPU 경량으로만 돈다.
"""
import hashlib
import io
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import analysis_worker as aw                                   # noqa: E402

NL = chr(10)
LF_ = NL
CR = chr(13)


def _approx(text):
    return max(1, len(text or ""))


class _WorkerBase(unittest.TestCase):
    def setUp(self):
        # tokenizer 를 건드리지 않는다 — 이 테스트는 프로토콜 계약만 본다.
        p = mock.patch.object(aw, "_count_tokens", side_effect=_approx)
        p.start()
        self.addCleanup(p.stop)
        self._kind = aw._STATE.get("kind")
        aw._STATE["kind"] = aw.TOKENIZER_PRODUCTION
        self.addCleanup(lambda: aw._STATE.__setitem__("kind", self._kind))

    def _req(self, text, rid="r1", **kw):
        d = {"type": "analyze", "request_id": rid, "text": text}
        d.update(kw)
        return aw.handle(d)


class ProtocolTest(_WorkerBase):
    def test_response_echoes_request_id_and_source_sha(self):
        t = "짧은 문장입니다."
        r = self._req(t)
        self.assertTrue(r["ok"])
        self.assertEqual(r["request_id"], "r1")
        self.assertEqual(r["source_sha256"], hashlib.sha256(t.encode("utf-8")).hexdigest())
        self.assertEqual(r["protocol_version"], aw.PROTOCOL_VERSION)

    def test_sha_mismatch_is_refused_without_analysing(self):
        r = self._req("가나다", source_sha256="0" * 64)
        self.assertFalse(r["ok"])
        self.assertEqual(r["code"], "SOURCE_SHA_MISMATCH")
        self.assertNotIn("chunks", r, "거부한 요청을 분석하면 안 된다")

    def test_analysis_failure_becomes_a_response_not_an_exception(self):
        with mock.patch.object(aw.input_analysis, "analyze", side_effect=RuntimeError("x")):
            r = self._req("가나다")
        self.assertFalse(r["ok"])
        self.assertEqual(r["code"], "RuntimeError")

    def test_three_axes_survive_the_protocol(self):
        t = "첫 줄입니다." + NL + "[기쁨] 둘째 줄. [슬픔] 셋째 문장."
        r = self._req(t)
        for k in ("source_paragraphs", "segments", "chunks",
                  "source_paragraph_count", "segment_count", "planned_calls"):
            self.assertIn(k, r)
        self.assertEqual(r["source_paragraph_count"], 2)
        self.assertGreater(r["segment_count"], 2, "감정 태그가 구간을 늘린다")
        self.assertEqual(len(r["chunks"]), r["planned_calls"])
        for c in r["chunks"]:
            self.assertIsNotNone(c["source_paragraph_index"])

    def test_response_carries_offsets_not_script_text(self):
        t = "비밀 대사입니다. 두 번째 문장입니다."
        r = self._req(t)
        blob = json.dumps(r, ensure_ascii=False)
        self.assertNotIn("비밀 대사", blob, "대사 원문이 응답으로 새어 나갔다")
        for c in r["chunks"]:
            self.assertNotIn("text", c)
            self.assertEqual(t[c["source_start"]:c["source_end"]].strip() != "", True)

    def test_crlf_offsets_are_source_coordinates(self):
        t = "첫 줄입니다." + CR + LF_ + "둘째 줄입니다."
        r = self._req(t)
        for c in r["chunks"]:
            got = t[c["source_start"]:c["source_end"]]
            self.assertNotIn(CR, got, "정규화 좌표가 원문 좌표로 새어 나왔다")
        lf = self._req("첫 줄입니다." + LF_ + "둘째 줄입니다.")
        self.assertEqual(r["normalized_sha256"], lf["normalized_sha256"])
        self.assertNotEqual(r["source_sha256"], lf["source_sha256"])
        self.assertEqual(r["planned_calls"], lf["planned_calls"])



class TokenizerFallbackTest(_WorkerBase):
    def test_missing_tokenizer_still_answers_but_says_so(self):
        aw._STATE["kind"] = aw.TOKENIZER_APPROXIMATE
        r = self._req("문장입니다. " * 20)
        self.assertTrue(r["ok"], "tokenizer 가 없다고 편집을 막으면 안 된다")
        self.assertEqual(r["tokenizer"], aw.TOKENIZER_APPROXIMATE)
        self.assertIn("TOKENIZER_UNAVAILABLE", r["warnings"])
        self.assertEqual(r["confidence"], aw.input_analysis.CONFIDENCE_INSUFFICIENT)
        self.assertIsNone(r["estimated_wall_seconds"],
                          "근사 토큰으로 시간을 만들어 내면 안 된다")

    def test_production_tokenizer_is_reported(self):
        r = self._req("문장입니다.")
        self.assertEqual(r["tokenizer"], aw.TOKENIZER_PRODUCTION)
        self.assertNotIn("TOKENIZER_UNAVAILABLE", r["warnings"])


class ReplayFramesTest(unittest.TestCase):
    def test_vendor_native_does_not_replay_the_reference(self):
        prev = os.environ.pop("AUDIOFORGE_LEGACY_CONTROLLED_PREFIX", None)
        try:
            self.assertEqual(aw._replay_frames("high_quality_icl"), 0)
            self.assertEqual(aw._replay_frames("safe_xvector"), 0)
        finally:
            if prev is not None:
                os.environ["AUDIOFORGE_LEGACY_CONTROLLED_PREFIX"] = prev

    def test_legacy_controlled_prefix_replays(self):
        prev = os.environ.get("AUDIOFORGE_LEGACY_CONTROLLED_PREFIX")
        os.environ["AUDIOFORGE_LEGACY_CONTROLLED_PREFIX"] = "1"
        try:
            self.assertEqual(aw._replay_frames("high_quality_icl"), 83)
            self.assertEqual(aw._replay_frames("safe_xvector"), 0)
        finally:
            if prev is None:
                os.environ.pop("AUDIOFORGE_LEGACY_CONTROLLED_PREFIX", None)
            else:
                os.environ["AUDIOFORGE_LEGACY_CONTROLLED_PREFIX"] = prev


class NoGpuTest(unittest.TestCase):
    """분석 경로가 GPU·TTS 모델을 건드리지 않는다는 것을 소스로 고정한다."""

    def test_worker_does_not_import_torch_or_load_the_model(self):
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "analysis_worker.py"), encoding="utf-8").read()
        self.assertNotIn("import torch", src)
        self.assertNotIn("AutoModel", src)
        self.assertNotIn("cuda", src.lower())
        self.assertIn("AutoProcessor", src, "tokenizer 는 써야 production parity 가 성립한다")

    def test_stdout_is_json_lines_only(self):
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "analysis_worker.py"), encoding="utf-8").read()
        self.assertNotIn("print(", src, "stdout 은 프로토콜 전용이다")
        self.assertIn("sys.stderr.write", src, "로그는 stderr 로만 나간다")


class DropBeforeTest(unittest.TestCase):
    """**대기 중인** 낡은 요청만 생략한다.

    이미 계산에 들어간 요청은 단일 프로세스 구조상 끊기지 않는다 — 그 결과를 버리는 것은
    호출부의 request_id/SHA 판정이지 drop_before 가 아니다.
    """

    def _run(self, lines):
        out = io.StringIO()
        with mock.patch.object(sys, "stdin", io.StringIO("".join(lines))), \
                mock.patch.object(sys, "stdout", out), \
                mock.patch.object(aw, "_count_tokens", side_effect=_approx):
            aw._STATE["kind"] = aw.TOKENIZER_PRODUCTION
            aw.main()
        return [json.loads(x) for x in out.getvalue().splitlines() if x.strip()]

    def test_superseded_request_is_not_analysed(self):
        msgs = self._run([
            json.dumps({"type": "drop_before", "request_seq": 5}) + NL,
            json.dumps({"type": "analyze", "request_id": "old", "request_seq": 2,
                        "text": "가나다"}, ensure_ascii=False) + NL,
            json.dumps({"type": "analyze", "request_id": "new", "request_seq": 9,
                        "text": "가나다"}, ensure_ascii=False) + NL,
            json.dumps({"type": "shutdown"}) + NL,
        ])
        ready = [m for m in msgs if m["type"] == "ready"]
        self.assertEqual(len(ready), 1, "기동 시 ready 한 줄")
        res = [m for m in msgs if m["type"] == "analysis"]
        self.assertEqual(len(res), 2)
        self.assertFalse(res[0]["ok"])
        self.assertEqual(res[0]["code"], "SUPERSEDED")
        self.assertNotIn("chunks", res[0], "낡은 요청을 계산하면 안 된다")
        self.assertTrue(res[1]["ok"])

    def test_prewarm_loads_the_tokenizer_without_user_text(self):
        """콜드 로드를 타이핑 전으로 옮긴다 — 사용자 텍스트는 관여하지 않는다."""
        calls = []

        def fake_load():
            calls.append(1)
            aw._STATE["kind"] = aw.TOKENIZER_PRODUCTION
            return aw.TOKENIZER_PRODUCTION

        with mock.patch.object(aw, "_load_tokenizer", side_effect=fake_load):
            msgs = self._run([
                json.dumps({"type": "prewarm"}) + NL,
                json.dumps({"type": "shutdown"}) + NL,
            ])
        pre = [m for m in msgs if m["type"] == "prewarm"]
        self.assertEqual(len(pre), 1)
        self.assertTrue(pre[0]["ok"])
        self.assertEqual(pre[0]["tokenizer"], aw.TOKENIZER_PRODUCTION)
        self.assertEqual(len(calls), 1, "prewarm 이 tokenizer 를 데우지 않았다")
        self.assertNotIn("chunks", pre[0], "prewarm 은 분석이 아니다")

    def test_prewarm_failure_is_reported_without_stopping_the_worker(self):
        def fake_load():
            aw._STATE["kind"] = aw.TOKENIZER_APPROXIMATE
            aw._STATE["load_error"] = "MODEL_DIR_NOT_FOUND"
            return aw.TOKENIZER_APPROXIMATE

        with mock.patch.object(aw, "_load_tokenizer", side_effect=fake_load):
            msgs = self._run([
                json.dumps({"type": "prewarm"}) + NL,
                json.dumps({"type": "analyze", "request_id": "a", "request_seq": 1,
                            "text": "가"}, ensure_ascii=False) + NL,
                json.dumps({"type": "shutdown"}) + NL,
            ])
        pre = [m for m in msgs if m["type"] == "prewarm"][0]
        self.assertFalse(pre["ok"])
        self.assertEqual(pre["reason"], "MODEL_DIR_NOT_FOUND")
        res = [m for m in msgs if m["type"] == "analysis"]
        self.assertEqual(len(res), 1, "prewarm 실패가 이후 분석을 막으면 안 된다")
        self.assertTrue(res[0]["ok"])

    def test_malformed_lines_do_not_stop_the_worker(self):
        msgs = self._run([
            "{ this is not json" + NL,
            json.dumps({"type": "unknown"}) + NL,
            json.dumps({"type": "analyze", "request_id": "a", "request_seq": 1,
                        "text": "가"}, ensure_ascii=False) + NL,
            json.dumps({"type": "shutdown"}) + NL,
        ])
        res = [m for m in msgs if m["type"] == "analysis"]
        self.assertEqual(len(res), 1)
        self.assertTrue(res[0]["ok"])


if __name__ == "__main__":
    unittest.main()
