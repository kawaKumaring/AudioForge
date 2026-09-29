# -*- coding: utf-8 -*-
"""소리로 내지 않는 기호 — 파이썬 짝이 화면 쪽과 **같은 답**을 내는가, 그리고 엔진 바로 앞에서 쓰이는가.

왜 있는가(2026-09-30 사용자 신고): 따옴표·별표, 그리고 "............. ///// !!!!! ******* ------ (((((( ))))))" 같은
  기호 뭉치를 모델이 억지로 소리 내려 했다. 규칙의 원본은 src/shared/speechSymbols.ts, 사례는 한 벌(cases.json)을 같이 쓴다.

실행: python -X utf8 python/test_speech_symbols.py
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import json
import unittest

import speech_symbols as ss

HERE = os.path.dirname(os.path.abspath(__file__))
CASES = os.path.join(os.path.dirname(HERE), "src", "shared", "speechSymbols.cases.json")


class SameAsScreen(unittest.TestCase):
    def test_화면_쪽과_같은_사례를_같은_답으로(self):
        with open(CASES, encoding="utf-8") as f:
            cases = json.load(f)["cases"]
        self.assertGreaterEqual(len(cases), 30)
        bad = []
        for inp, want in cases:
            got = ss.strip_spoken_symbols(inp)
            if got != want:
                bad.append((inp, want, got))
        self.assertEqual(bad, [])


class WiredBeforeEngine(unittest.TestCase):
    def test_기본_목소리_엔진_바로_앞에서_쓴다(self):
        with open(os.path.join(HERE, "tts_worker.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("strip_spoken_symbols", src)
        # 문장 단위 엔진 호출 직전 — 파서가 낸 글(line_text)은 그대로 두고 소리로 보낼 글만 바꾼다.
        i = src.index("engine.synthesize_segment(say_text")
        self.assertIn("say_text = strip_spoken_symbols(line_text)", src[i - 1500:i])

    def test_기호만_남은_줄은_짧게_쉰다(self):
        import tempfile
        import wave
        import tts_worker as tw
        styles_ok = False
        try:
            import supertonic_tts as st
            styles, why = st.scan()
            styles_ok = not why
        except Exception:
            styles_ok = False
        if not styles_ok:
            self.skipTest("Supertonic 모델을 받아 두지 않았다")
        eng = tw.ENGINES["supertonic"]()
        eng.model_path = styles[0][1]
        out = os.path.join(tempfile.gettempdir(), "sym-seg.wav")
        eng.synthesize_segment(ss.strip_spoken_symbols("!!!!! ******* ------"), None, None, 1.0, out)
        with wave.open(out, "rb") as w:
            sec = w.getnframes() / float(w.getframerate())
        self.assertLess(sec, 0.5, "기호 뭉치를 소리로 만들었다(%.2f초)" % sec)


if __name__ == "__main__":
    unittest.main(verbosity=2)
