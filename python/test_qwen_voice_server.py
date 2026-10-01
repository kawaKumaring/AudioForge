# -*- coding: utf-8 -*-
"""Qwen 상주 실행기 — 낭독 감정 덩어리(segments) · 표준 입력 읽기 규칙. 가짜 모델로(그래픽카드 없이) 본다.

왜 있는가(2026-10-01): 낭독 감정은 덩어리마다 다른 지시로 만들어 한 파일로 잇는다. 덩어리별 지시·이어 붙이기·빈 덩어리를
  모델 없이 고정한다. ★표준 입력은 막히지 않게 읽는다 — 막힌 읽기가 있으면 윈도우에서 모델 열기가 멈췄다(실측 200초).

실행: python -X utf8 python/test_qwen_voice_server.py
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로
import tempfile
import unittest

import numpy as np
import soundfile as sf

import qwen_voice_server as qvs
import qwen_emotions as qe


class FakeModel:
    def __init__(self):
        self.calls = []

    def generate_custom_voice(self, text, speaker, language, instruct=None):
        self.calls.append((text, speaker, instruct))
        return [np.full(2400, 0.1, dtype="float32")], 24000      # 0.1초짜리 소리


class Segments(unittest.TestCase):
    def test_덩어리마다_지시를_붙여_만들고_쉼을_두고_잇는다(self):
        m = FakeModel()
        out = os.path.join(tempfile.mkdtemp(), "o.wav")
        r = qvs._segments(m, False, {"speaker": "sohee", "out": out, "segments": [
            {"text": "그가 말했다.", "emotion": ""}, {"text": "  ", "emotion": "sad"},
            {"text": "미안해요.", "emotion": "sad"}, {"text": "좋아!", "emotion": "moaning"}]})
        self.assertTrue(r["ok"])
        self.assertEqual([c[0] for c in m.calls], ["그가 말했다.", "미안해요.", "좋아!"], "빈 덩어리는 건너뛴다")
        self.assertEqual([c[2] for c in m.calls], [None, qe.QWEN_EMOTION_INSTRUCTS["sad"], None],
                         "감정 없음·옮기지 않는 감정은 지시 없이")
        y, sr = sf.read(out)
        gap = int(qvs.SEGMENT_GAP_SEC * 24000)
        self.assertEqual(len(y), 3 * 2400 + 2 * gap, "덩어리 셋 + 쉼 둘")
        self.assertEqual(r["segments"], 3)

    def test_읽을_덩어리가_없으면_실패를_말한다(self):
        with self.assertRaises(RuntimeError):
            qvs._segments(FakeModel(), False, {"speaker": "sohee", "out": "x.wav", "segments": [{"text": " "}]})


class StdinRule(unittest.TestCase):
    def test_표준_입력을_다른_스레드에서_막힌_채_읽지_않는다(self):
        src = open(qvs.__file__, encoding="utf-8").read()
        self.assertIn("PeekNamedPipe", src)
        self.assertNotIn("for line in sys.stdin", src, "막힌 읽기(sys.stdin 반복)가 돌아왔다 — 윈도우에서 모델 열기가 멈춘다")


if __name__ == "__main__":
    unittest.main(verbosity=2)
