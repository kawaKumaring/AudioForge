# -*- coding: utf-8 -*-
"""Supertonic 3 기본 목소리 검사 — 받아 둔 모델만 쓰고, 없으면 사유를 말하는가.

왜 있는가(2026-09-30): 기본 목소리를 여러 개 연결하라는 지시로 Supertonic 3(목소리 열 개 · CPU)을 붙였다.
  ★인터넷에 닿지 않아야 한다 — 공식 패키지의 자동 내려받기 대신 받아 둔 파일만 연다.
  ★'폴더가 있으니 된다' 고 하지 않는다 — 파일이 빠지면 목록에 넣지 않고 사유를 남긴다.
  모델이 받아져 있으면 한 문장을 실제로 만들어 본다(CPU · 몇 초).

실행: python -X utf8 python/test_supertonic_tts.py
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import json
import shutil
import tempfile
import unittest

import supertonic_tts as st
import builtin_voices as bv

HERE = os.path.dirname(os.path.abspath(__file__))


class Rules(unittest.TestCase):
    def test_이름표(self):
        self.assertEqual(st.voice_label("F1"), "여성 1")
        self.assertEqual(st.voice_label("M5"), "남성 5")
        self.assertEqual(st.voice_label("custom"), "custom")

    def test_글_다듬기_언어표와_끝맺음(self):
        t = st.preprocess("안녕 하세요")
        self.assertTrue(t.startswith("<ko>") and t.endswith("</ko>"))
        self.assertTrue(t[:-5].endswith("."), "끝맺음 부호가 없으면 마침표를 붙인다")
        # 한글은 자모로 풀린다(모델의 글자표가 자모 단위)
        self.assertNotIn("안", t)

    def test_덩이_나누기_120자_안쪽(self):
        long = " ".join(["그는 문을 열었다."] * 40)
        parts = st.chunk_text(long)
        self.assertGreater(len(parts), 1)
        self.assertTrue(all(len(p) <= 120 for p in parts), [len(p) for p in parts])
        self.assertEqual(" ".join(parts).split(), long.split(), "글자를 잃거나 더하지 않는다")

    def test_인터넷에_닿는_코드가_없다(self):
        with open(os.path.join(HERE, "supertonic_tts.py"), encoding="utf-8") as f:
            src = "\n".join(l for l in f.read().splitlines() if not l.lstrip().startswith("#"))
        code = src.split('"""', 2)[2]          # 머리 설명문(출처 주소를 적어 둔 곳) 밖만 본다
        for bad in ("http://", "https://", "hf_hub_download", "snapshot_download", "urllib", "requests", "auto_download"):
            self.assertNotIn(bad, code, bad)


class Missing(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="afst-")
        self.old = os.environ.get(st.ROOT_ENV)

    def tearDown(self):
        if self.old is None:
            os.environ.pop(st.ROOT_ENV, None)
        else:
            os.environ[st.ROOT_ENV] = self.old
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_없으면_사유를_말하고_목록에_넣지_않는다(self):
        os.environ[st.ROOT_ENV] = os.path.join(self.dir, "없음")
        styles, why = st.scan()
        self.assertEqual(styles, [])
        self.assertIn("없습니다", why)
        voices, skipped = bv.supertonic_voices_list()
        self.assertEqual(voices, [])
        self.assertTrue(any(s.get("engineId") == "supertonic" for s in skipped))

    def test_파일이_빠지면_빠진_이름을_말한다(self):
        os.makedirs(os.path.join(self.dir, "onnx"))
        os.makedirs(os.path.join(self.dir, "voice_styles"))
        for f in st.ONNX_FILES[:3] + st.CONFIG_FILES:
            open(os.path.join(self.dir, "onnx", f), "w").close()
        open(os.path.join(self.dir, "voice_styles", "F1.json"), "w").close()
        os.environ[st.ROOT_ENV] = self.dir
        styles, why = st.scan()
        self.assertEqual(styles, [])
        self.assertIn("vocoder.onnx", why)


@unittest.skipUnless(os.path.isdir(st.root()) and not st.missing_files(st.root()), "Supertonic 모델을 받아 두지 않았다")
class RealModel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tts = st.Supertonic()
        cls.styles, _ = st.scan()

    def test_목소리_열_개가_목록에_오른다(self):
        voices, skipped = bv.supertonic_voices_list()
        self.assertEqual(sorted(v["modelId"] for v in voices), ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"])
        self.assertTrue(all(v["engineId"] == "supertonic" and v["language"] == "ko" and v["sampleRate"] == 44100 for v in voices))
        self.assertEqual(skipped, [])

    def test_한_문장을_실제로_만든다(self):
        import numpy as np
        text = "그는 천천히 문을 열고 어두운 복도를 내다보았다."
        w = self.tts.synthesize(text, self.styles[0][1])
        sec = len(w) / self.tts.sample_rate
        self.assertTrue(1.5 < sec < 12, sec)
        self.assertFalse(bool(np.isnan(w).any()))
        self.assertGreater(float(np.abs(w).max()), 0.05, "소리가 거의 없다")
        # 같은 글·같은 목소리·같은 씨앗이면 같은 소리 — 쌓아 둔 조각과 새로 만든 것이 갈리지 않는다.
        self.assertTrue(np.array_equal(w, self.tts.synthesize(text, self.styles[0][1])))

    def test_속도를_쓴다(self):
        text = "그는 천천히 문을 열고 어두운 복도를 내다보았다."
        slow = len(self.tts.synthesize(text, self.styles[5][1], speed=0.8))
        fast = len(self.tts.synthesize(text, self.styles[5][1], speed=1.3))
        self.assertGreater(slow, fast * 1.3)

    def test_엔진이_고른_목소리로_소리_파일을_쓴다(self):
        import wave
        import tts_worker as tw
        eng = tw.ENGINES["supertonic"]()
        eng.model_path = self.styles[1][1]
        out = os.path.join(tempfile.gettempdir(), "st-seg.wav")
        eng.synthesize_segment("안녕하세요. 이 목소리로 읽습니다.", None, None, 1.0, out)
        with wave.open(out, "rb") as w:
            self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate()), (1, 2, 44100))
            self.assertGreater(w.getnframes(), 44100)
        # 기호만 있는 줄(장면 구분)은 짧게 쉰다 — 덩이가 죽지 않는다.
        eng.synthesize_segment("◆◇◆", None, None, 1.0, out)
        with wave.open(out, "rb") as w:
            self.assertGreater(w.getnframes(), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
