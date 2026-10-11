# -*- coding: utf-8 -*-
"""F5-TTS·Kokoro 가중치는 앱 모델 폴더에서만 — 없으면 받지 않고 무엇이 없는지 말한다(2026-10-11 흡수).

모델은 불러오지 않는다(파일 존재·경로만). 실제 합성 확인은 changelog 의 실측 기록.
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import shutil
import tempfile
import unittest

import tts_worker as tw

ENV = "AUDIOFORGE_ASSETS_ROOT"


class TestTtsLocalAssets(unittest.TestCase):
    def setUp(self):
        self._env = os.environ.get(ENV)
        self.tmp = tempfile.mkdtemp(prefix="af-tts-assets-")
        os.environ[ENV] = self.tmp

    def tearDown(self):
        if self._env is None:
            os.environ.pop(ENV, None)
        else:
            os.environ[ENV] = self._env
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _touch(self, *parts):
        p = os.path.join(self.tmp, *parts)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "wb").close()
        return p

    def test_f5_없으면_받지_않고_빠진_파일을_말한다(self):
        with self.assertRaises(RuntimeError) as cm:
            tw.f5_asset_paths()
        self.assertIn("model_1250000.safetensors", str(cm.exception))
        self.assertIn("자동으로 받지 않습니다", str(cm.exception))

    def test_f5_있으면_앱_폴더_경로(self):
        ckpt = self._touch("f5_tts_models", "F5-TTS", "F5TTS_v1_Base", "model_1250000.safetensors")
        self._touch("f5_tts_models", "vocos-mel-24khz", "config.yaml")
        self._touch("f5_tts_models", "vocos-mel-24khz", "pytorch_model.bin")
        got_ckpt, vocos = tw.f5_asset_paths()
        self.assertEqual(os.path.normcase(got_ckpt), os.path.normcase(ckpt))
        self.assertTrue(os.path.normcase(vocos).startswith(os.path.normcase(self.tmp)))

    def test_kokoro_없으면_받지_않는다(self):
        with self.assertRaises(RuntimeError):
            tw.kokoro_asset_paths()

    def test_kokoro_목소리는_앱_폴더_파일로(self):
        self._touch("kokoro_models", "Kokoro-82M", "config.json")
        self._touch("kokoro_models", "Kokoro-82M", "kokoro-v1_0.pth")
        v = self._touch("kokoro_models", "Kokoro-82M", "voices", "af_heart.pt")
        self.assertEqual(os.path.normcase(tw.kokoro_voice_path("af_heart")), os.path.normcase(v))
        with self.assertRaises(RuntimeError):
            tw.kokoro_voice_path("zz_missing")

    def test_엔진이_이름만으로_부르지_않는다(self):
        """★인자 없이 부르면 HF 기본 캐시(C)를 뒤지고 없으면 받는다 — 그 호출이 다시 들어오지 않게."""
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "tts_worker.py"),
                   encoding="utf-8").read()
        self.assertNotIn("F5TTS(device=device)", src)
        self.assertNotIn("KPipeline(lang_code=new_lang)", src)
        self.assertNotIn("voice=voice, speed=speed", src)


class TestTestTempDisablesTorchKernelCache(unittest.TestCase):
    def test_검사에서는_torch_부품_캐시를_끈다(self):
        # 테스트 폴더 경로의 한글 때문에 캐시 만들기 경고가 깨져 GPU 계산이 죽는다(2026-10-11).
        self.assertEqual(os.environ.get("USE_PYTORCH_KERNEL_CACHE"), "0")


if __name__ == "__main__":
    unittest.main(verbosity=2)
