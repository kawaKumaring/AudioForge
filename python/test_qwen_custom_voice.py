# -*- coding: utf-8 -*-
"""Qwen3-TTS 지정 목소리(한국어 소희) 검사 — 목록에 오르는 조건, 없을 때의 사유, 실제 한 문장.

왜 있는가(2026-09-30 지시: "Qwen 기본 목소리에서 한국어가 있다면 받아 본다"):
  0.6B CustomVoice 를 받아 기본 목소리로 붙였다. GPU 로 느리다(10초 분량에 약 41초 실측).
  ★실제로 만들어 보는 검사는 GPU 로 40초가 넘게 걸려 **AF_TEST_GPU=1 일 때만** 돈다 — 파이썬 시험 전량을 무겁게 하지 않는다.

실행: python -X utf8 python/test_qwen_custom_voice.py      (AF_TEST_GPU=1 이면 실제 한 문장까지)
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import tempfile
import unittest
import wave

import tts_worker as tw
import builtin_voices as bv

HAVE_MODEL = bool(tw.qwen_custom_voice_models())


class Rules(unittest.TestCase):
    def test_한국어_목소리만_싣는다(self):
        self.assertEqual(list(tw.QWEN_CUSTOM_KOREAN), ["sohee"])

    def test_엔진이_등록되고_고른_모델을_받는다(self):
        self.assertIs(tw.ENGINES["qwen-custom"], tw.QwenCustomEngine)
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "tts_worker.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("isinstance(engine, (PiperEngine, SupertonicEngine, QwenCustomEngine))", src)

    def test_모델이_없으면_사유를_말한다(self):
        eng = tw.QwenCustomEngine()
        eng.model_path = os.path.join(tempfile.gettempdir(), "없는모델", "config.json")
        with self.assertRaises(RuntimeError) as c:
            eng.synthesize_segment("안녕하세요.", None, None, 1.0, os.path.join(tempfile.gettempdir(), "x.wav"))
        self.assertIn("찾지 못했습니다", str(c.exception))

    def test_복제용으로는_쓰지_않는다(self):
        # 지정 목소리 모델은 목소리 복제(참조 흉내)를 못 한다 — 모델 목록에 남되 '쓸 수 없음' 사유가 붙는다.
        for v in tw.qwen_model_variants():
            if v["model_type"] == "custom_voice":
                self.assertFalse(v["voice_clone"])
                self.assertTrue(v["unusable_reason"])


@unittest.skipUnless(HAVE_MODEL, "Qwen 지정 목소리 모델을 받아 두지 않았다")
class Installed(unittest.TestCase):
    def test_목록에_소희가_오르고_이름표에_느림을_적는다(self):
        voices, skipped = bv.qwen_custom_voices_list()
        self.assertEqual([v["modelId"] for v in voices], ["sohee"])
        self.assertIn("느림", voices[0]["label"])
        self.assertTrue(voices[0]["path"].endswith("config.json") and os.path.isfile(voices[0]["path"]))
        self.assertEqual(skipped, [])

    def test_기호만_남은_조각은_모델을_부르지_않고_쉰다(self):
        eng = tw.QwenCustomEngine()
        eng.model_path = os.path.join(tw.qwen_custom_voice_models()[0], "config.json")
        out = os.path.join(tempfile.gettempdir(), "qcv-empty.wav")
        eng.synthesize_segment("", None, None, 1.0, out)
        with wave.open(out, "rb") as w:
            self.assertEqual(w.getframerate(), 24000)
            self.assertLess(w.getnframes() / 24000.0, 0.5)

    @unittest.skipUnless(os.environ.get("AF_TEST_GPU") == "1", "GPU 로 40초 남짓 — AF_TEST_GPU=1 일 때만")
    def test_실제로_한_문장을_만든다(self):
        eng = tw.QwenCustomEngine()
        eng.model_path = os.path.join(tw.qwen_custom_voice_models()[0], "config.json")
        out = os.path.join(tempfile.gettempdir(), "qcv-real.wav")
        eng.synthesize_segment("안녕하세요. 이 목소리로 읽습니다.", None, None, 1.0, out)
        with wave.open(out, "rb") as w:
            sec = w.getnframes() / float(w.getframerate())
            self.assertEqual((w.getnchannels(), w.getframerate()), (1, 24000))
        self.assertTrue(1.0 < sec < 8.0, sec)


if __name__ == "__main__":
    unittest.main(verbosity=2)
