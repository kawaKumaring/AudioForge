# -*- coding: utf-8 -*-
"""낭독 참조 목소리의 서수 보정 — Qwen 으로 가지 않으면 '바꾸지 않은 글' 을 엔진에 보낸다(2026-10-09).

separate.py 의 실제 설정 읽기·호출 길을 그대로 돌리고, **엔진 선택 결과**와 synthesize(엔진 호출 직전)만 바꿔 끼운다.
모델·GPU 를 쓰지 않는다. 참조는 이 검사가 만든 합성 사인파(사용자 자료 아님).

실행: python -X utf8 python/test_spoken_fallback_separate.py
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로
import io
import json
import math
import shutil
import struct
import tempfile
import unittest
import wave
from contextlib import redirect_stdout
from unittest import mock

import separate
import tts_worker

SPOKEN = "그는 일곱 번째 문을 열었다."
PLAIN = "그는 7번째 문을 열었다."


class _Stop(Exception):
    pass


class FallbackText(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_spfb_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.ref = os.path.join(self.tmp, "tone.wav")
        with wave.open(self.ref, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)  # noqa: E702
            w.writeframes(b"".join(struct.pack("<h", int(3000 * math.sin(i * 0.05))) for i in range(16000 * 6)))
        self.seen = {}

    def _run(self, route, cfg_extra):
        cfg = {"mode": "tts", "input": self.ref, "output": self.tmp, "ttsText": SPOKEN,
               "ttsReferenceOverride": self.ref, "ttsSpeed": 1.0, "ttsSilenceGap": 0.35, "ttsPitch": 0.0,
               "ttsTailMode": "auto", "ttsTailPaddingMs": 120, "ttsTailFadeMs": 8, "ttsSpeakerMode": "single", **cfg_extra}
        path = os.path.join(self.tmp, "config.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False)

        def fake_synth(ref, text, out, **kw):
            self.seen.update(text=text, spoken_prepared=kw.get("spoken_prepared"))
            raise _Stop()
        buf = io.StringIO()
        with mock.patch.object(tts_worker, "_select_job_engine", lambda *_a, **_k: route), \
                mock.patch.object(tts_worker, "synthesize", fake_synth), \
                mock.patch.object(sys, "argv", ["separate.py", "--config", path]), redirect_stdout(buf):
            try:
                separate.main()
            except (_Stop, SystemExit):
                pass
        return buf.getvalue()

    def test_Qwen_으로_가면_바꾼_글과_다시_바꾸지_말라는_표시(self):
        self._run("qwen3", {"ttsSpokenPrepared": "ordinal-ko-v1", "ttsTextNonQwen": PLAIN})
        self.assertEqual(self.seen.get("text"), SPOKEN)
        self.assertEqual(self.seen.get("spoken_prepared"), "ordinal-ko-v1")

    def test_Qwen_이_아니면_바꾸지_않은_글_표시_없음(self):
        out = self._run(None, {"ttsSpokenPrepared": "ordinal-ko-v1", "ttsTextNonQwen": PLAIN})
        self.assertEqual(self.seen.get("text"), PLAIN)
        self.assertIsNone(self.seen.get("spoken_prepared"))
        self.assertIn("spoken_text_fallback", out)

    def test_설정이_없으면_예전_그대로(self):
        self._run(None, {})
        self.assertEqual(self.seen.get("text"), SPOKEN)
        self.assertIsNone(self.seen.get("spoken_prepared"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
