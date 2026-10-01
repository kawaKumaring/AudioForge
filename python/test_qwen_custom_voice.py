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
    def test_한국어_원어민은_소희_하나(self):
        self.assertEqual(list(tw.QWEN_CUSTOM_KOREAN), ["sohee"])
        self.assertEqual([k for k, v in tw.QWEN_CUSTOM_SPEAKERS.items() if v["native"]], ["sohee"])

    def test_받아_적기로_고른_화자만_싣는다_딜런은_뺀다(self):
        # 2026-10-01 — 한국어 받아 적기 오류율 0% 인 일곱만. 딜런은 12.5% 가 나와 뺐다. 억양은 이름표에 적는다.
        self.assertEqual(sorted(tw.QWEN_CUSTOM_SPEAKERS), sorted(["sohee", "vivian", "serena", "ono_anna", "uncle_fu", "eric", "ryan", "aiden"]))
        for k, v in tw.QWEN_CUSTOM_SPEAKERS.items():
            if not v["native"]:
                self.assertIn("억양", v["desc"], k)
                self.assertTrue(os.path.isfile(os.path.join(tw.QWEN_VOICE_DIR, k + ".json")), k)

    def test_목소리_자리를_화자로_푼다(self):
        cfg, sp = tw.qwen_voice_of(os.path.join("어딘가", "config.json"))
        self.assertEqual(sp, "sohee", "예전 자리(모델 설정 파일)는 소희 — 저장된 선택이 산다")
        _, sp = tw.qwen_voice_of(os.path.join(tw.QWEN_VOICE_DIR, "vivian.json"))
        self.assertEqual(sp, "vivian")
        self.assertEqual(tw.qwen_voice_of(os.path.join(tw.QWEN_VOICE_DIR, "없는.json")), (None, None))
        self.assertEqual(tw.qwen_voice_of(""), (None, None))

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
    def test_목록에_여덟이_오르고_이름표에_느림을_적는다(self):
        voices, skipped = bv.qwen_custom_voices_list()
        self.assertEqual(sorted(v["modelId"] for v in voices), sorted(tw.QWEN_CUSTOM_SPEAKERS))
        self.assertTrue(all("시작 느림" in v["label"] for v in voices))
        sohee = next(v for v in voices if v["modelId"] == "sohee")
        self.assertTrue(sohee["path"].endswith("config.json") and os.path.isfile(sohee["path"]) and sohee["native"])
        self.assertEqual(len({v["path"] for v in voices}), len(voices), "목소리마다 자리가 달라야 고르기·쌓아 두기가 갈린다")
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
