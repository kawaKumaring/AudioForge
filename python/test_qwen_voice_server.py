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


class FakeModels:
    def __init__(self, model, loaded_now):
        self.m, self.now = model, loaded_now

    def get(self, _dir):
        return self.m, self.now


class CloneModel(FakeModel):
    def __init__(self):
        super().__init__()
        self.prompts = 0

    def create_voice_clone_prompt(self, ref_audio, ref_text):
        self.prompts += 1
        return {"ref": ref_audio, "text": ref_text}

    def generate_voice_clone(self, text, language, voice_clone_prompt):
        self.calls.append((text, "clone:" + voice_clone_prompt["text"], None))
        return [np.full(2400, 0.1, dtype="float32")], 24000


class Clone(unittest.TestCase):
    def test_고정_참조로_읽고_참조_특징은_한_번만_만든다(self):
        ref = os.path.join(tempfile.mkdtemp(), "r.wav")
        open(ref, "wb").write(b"x")
        m, models = CloneModel(), qvs.Models()
        models.loaded["B"] = m
        req = {"model": "B", "clone": {"ref": ref, "text": "참조 글"}, "language": "korean", "seed": 0}
        out = tempfile.mkdtemp()
        r1 = qvs.handle(models, dict(req, text="첫째.", out=os.path.join(out, "a.wav")))
        r2 = qvs.handle(models, dict(req, text="둘째.", out=os.path.join(out, "b.wav")))
        self.assertTrue(r1["ok"] and r2["ok"])
        self.assertEqual([c[:2] for c in m.calls], [("첫째.", "clone:참조 글"), ("둘째.", "clone:참조 글")], "지정 목소리 화자 없이 참조로")
        self.assertEqual(m.prompts, 1, "같은 참조는 한 번만 계산")

    def test_감정_덩어리가_와도_지시를_버리고_참조로_읽는다(self):
        ref = os.path.join(tempfile.mkdtemp(), "r.wav")
        open(ref, "wb").write(b"x")
        m, models = CloneModel(), qvs.Models()
        models.loaded["B"] = m
        out = os.path.join(tempfile.mkdtemp(), "o.wav")
        r = qvs.handle(models, {"model": "B", "clone": {"ref": ref, "text": "g"}, "out": out,
                                "segments": [{"text": "안녕.", "emotion": "happy"}, {"text": "반가워.", "emotion": ""}]})
        self.assertTrue(r["ok"] and r["segments"] == 2)
        self.assertEqual([c[2] for c in m.calls], [None, None])


class Warm(unittest.TestCase):
    def test_막_연_모델은_짧은_글을_한번_만들어_준비를_치른다(self):
        m = FakeModel()
        r = qvs.handle(FakeModels(m, True), {"model": "x", "warm": True, "speaker": "sohee"})
        self.assertTrue(r["ok"])
        self.assertEqual([c[0] for c in m.calls], [qvs.PRIME_TEXT])
        self.assertEqual(r["seconds"], 0, "미리 열기는 소리를 돌려주지 않는다")

    def test_이미_열린_모델이나_화자가_없으면_만들지_않는다(self):
        m = FakeModel()
        qvs.handle(FakeModels(m, False), {"model": "x", "warm": True, "speaker": "sohee"})
        qvs.handle(FakeModels(m, True), {"model": "x", "warm": True})
        self.assertEqual(m.calls, [])


class StdinRule(unittest.TestCase):
    def test_준비_신호_뒤에_라이브러리를_미리_불러온다(self):
        src = open(qvs.__file__, encoding="utf-8").read()
        main = src[src.index("def main"):]
        self.assertLess(main.index("ready=True"), main.index("target=_preimport"), "준비 신호보다 먼저 불러오면 띄우는 쪽이 그만큼 기다린다")

    def test_미리_읽기는_모델을_열지_않고_곧바로_답한다(self):
        class NoModels:
            def get(self, _d):
                raise AssertionError("미리 읽기가 모델을 열었다")
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "model.safetensors"), "wb") as f:
            f.write(b"x" * 1024)
        r = qvs.handle(NoModels(), {"prefetch": [d]})
        self.assertTrue(r["ok"])
        qvs._prefetch([d, os.path.join(d, "없는폴더")])     # 없는 폴더도 조용히 지나간다

    def test_표준_입력을_다른_스레드에서_막힌_채_읽지_않는다(self):
        src = open(qvs.__file__, encoding="utf-8").read()
        self.assertIn("PeekNamedPipe", src)
        self.assertNotIn("for line in sys.stdin", src, "막힌 읽기(sys.stdin 반복)가 돌아왔다 — 윈도우에서 모델 열기가 멈춘다")



class TestRefPromptCache(unittest.TestCase):
    """2026-10-03 — 참조 목소리 작업의 참조 특징은 **소리 내용·전사·방식**이 같을 때만 다시 쓴다(경로만으로 판정하지 않는다)."""

    def _setup(self):
        calls = []

        class M:
            def create_voice_clone_prompt(self, ref_audio=None, ref_text=None, x_vector_only_mode=False, **kw):
                calls.append((ref_audio, ref_text, x_vector_only_mode))
                return ("prompt", len(calls))
        models = qvs.Models()
        m = M()
        qvs._ref_prompt_cache(models, m, "MODEL")
        return models, m, calls

    def test_같은_내용은_한_번만_다른_경로여도(self):
        models, m, calls = self._setup()
        d = tempfile.mkdtemp()
        a, b = os.path.join(d, "a.wav"), os.path.join(d, "b.wav")
        for p in (a, b):
            with open(p, "wb") as fh:
                fh.write(b"SAME")
        p1 = m.create_voice_clone_prompt(ref_audio=a, x_vector_only_mode=True)
        p2 = m.create_voice_clone_prompt(ref_audio=b, x_vector_only_mode=True)
        self.assertEqual(p1, p2)
        self.assertEqual(len(calls), 1)
        self.assertEqual((models.ref_made, models.ref_hits), (1, 1))

    def test_내용이_바뀌거나_방식·전사가_다르면_다시_만든다(self):
        models, m, calls = self._setup()
        d = tempfile.mkdtemp()
        a = os.path.join(d, "a.wav")
        with open(a, "wb") as fh:
            fh.write(b"ONE")
        m.create_voice_clone_prompt(ref_audio=a, x_vector_only_mode=True)
        with open(a, "wb") as fh:
            fh.write(b"TWO")                     # 같은 자리, 다른 소리(다른 화자일 수 있다)
        m.create_voice_clone_prompt(ref_audio=a, x_vector_only_mode=True)
        m.create_voice_clone_prompt(ref_audio=a, x_vector_only_mode=False, ref_text="전사")
        m.create_voice_clone_prompt(ref_audio=a, x_vector_only_mode=False, ref_text="다른 전사")
        self.assertEqual(len(calls), 4)

    def test_모델을_내리면_그_모델의_참조_특징도_버린다(self):
        models = qvs.Models()
        models.ref_prompts[("GONE", "sha", "", True, "[]")] = 1
        models.ref_prompts[("KEEP", "sha", "", True, "[]")] = 2
        models.loaded["GONE"] = object()
        models.loaded["KEEP"] = object()
        import collections
        orig_max = qvs.MAX_MODELS
        try:
            qvs.MAX_MODELS = 2
            # 자리가 꽉 찼다 — 새 모델을 열면 가장 오래된 GONE 이 내려간다(모델 열기는 가짜로)
            import qwen_custom_voice as qcv
            real = qcv.load
            qcv.load = lambda d: object()
            try:
                models.get("NEW")
            finally:
                qcv.load = real
        finally:
            qvs.MAX_MODELS = orig_max
        self.assertEqual([k[0] for k in models.ref_prompts], ["KEEP"])

if __name__ == "__main__":
    unittest.main(verbosity=2)
