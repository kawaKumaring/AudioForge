# -*- coding: utf-8 -*-
"""숫자 서수 읽기 보정 — 파이썬 짝이 화면 쪽과 같은 답을 내는가, 그리고 **Qwen 경로에만** 붙었는가(2026-10-09).

실행: python -X utf8 python/test_spoken_ordinals.py
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로
import json
import unittest

import spoken_ordinals as so

HERE = os.path.dirname(os.path.abspath(__file__))
CASES = os.path.join(os.path.dirname(HERE), "src", "shared", "spokenOrdinals.cases.json")


class SameAsScreen(unittest.TestCase):
    def test_화면_쪽과_같은_사례를_같은_답으로(self):
        with open(CASES, encoding="utf-8") as f:
            cases = json.load(f)["cases"]
        self.assertGreaterEqual(len(cases), 50)
        bad = [(i, w, so.spoken_ordinals(i)[0]) for i, w in cases if so.spoken_ordinals(i)[0] != w]
        self.assertEqual(bad, [])

    def test_1부터_99까지_읽기가_있고_20은_스무(self):
        for n in range(1, 100):
            self.assertTrue(so.ordinal_word(n), n)
        self.assertIsNone(so.ordinal_word(100))
        self.assertEqual(so.ordinal_word(20), "스무")
        self.assertEqual(so.ordinal_word(21), "스물한")

    def test_바꾼_자리는_원문_좌표(self):
        t = "앞 1번째와 21번째"
        for c in so.find_ordinals(t):
            self.assertEqual(t[c["start"]:c["end"]], c["original"])


class WiredOnlyToQwen(unittest.TestCase):
    """연결 자리 — 다른 엔진에는 자동으로 켜지 않는다. 원문(line_text)은 기록 기준으로 그대로."""
    def setUp(self):
        with open(os.path.join(HERE, "tts_worker.py"), encoding="utf-8") as f:
            self.src = f.read()

    def test_문장별_엔진은_QwenCustom_일_때만(self):
        i = self.src.index("engine.synthesize_segment(say_text")
        near = self.src[i - 2500:i]
        self.assertIn("if isinstance(engine, QwenCustomEngine):", near)
        self.assertIn("_spoken_for_qwen(line_text)", near)
        self.assertIn("say_text = strip_spoken_symbols(", near)

    def test_배치_Qwen_은_엔진에_보낼_글과_원문을_따로(self):
        i = self.src.index('seg = {"index": i, "text": qwen_text')
        self.assertIn("qwen_text, _ord_n = _spoken_for_qwen(line_text)", self.src[i - 600:i])
        self.assertIn('"source_text": line_text', self.src[i:i + 900])

    def test_기록에_규칙과_바꾼_수(self):
        self.assertIn("spoken_rule=", self.src)
        self.assertIn("spoken_ordinal_changes=", self.src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
