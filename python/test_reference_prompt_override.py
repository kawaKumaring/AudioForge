# -*- coding: utf-8 -*-
"""수동 참조 전사 override(2C-2) 테스트 — 실제 Whisper/GPT 없이 unittest+mock.

우선순위: 명시적 ref-free > 수동 전사문(비어있지 않음) > 자동 전사.
빈 수동 입력을 자동 전사 성공으로 오인하지 않음. 사용자 프롬프트 언어가 자동 감지 언어를 override.
전달 경로: synthesize(reference_prompts) → 식별자→경로 매핑 → GPT subprocess payload.

실행:
  python python/test_reference_prompt_override.py
  python -m unittest discover -s python -p "test_reference_prompt_override.py"
"""
import os
import sys
import json
import subprocess
import tempfile
import shutil
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reference_transcript as rt   # noqa: E402
import reference_audio as ra        # noqa: E402
import transcribe_worker            # noqa: E402
import tts_worker                   # noqa: E402


def _write(path, seconds, sr=24000, amp=0.3):
    import numpy as np
    import soundfile as sf
    n = int(round(seconds * sr))
    t = np.arange(n) / sr
    sf.write(path, (amp * np.sin(2 * np.pi * 220.0 * t)).astype("float32"), sr)


class FakeCompleted:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class _Mixin:
    def _start(self, patcher):
        patcher.start()
        self.addCleanup(patcher.stop)

    def _whisper(self, result=None, counter=None):
        self._start(mock.patch.object(transcribe_worker, "_get_whisper_model",
                                      lambda name: ("model", name)))

        def ft(model, path, lang):
            if counter is not None:
                counter.append(1)
            return result
        self._start(mock.patch.object(transcribe_worker, "run_transcribe", side_effect=ft))
        self._start(mock.patch.object(tts_worker, "emit", lambda *a, **k: None))


class PromptOverrideResolutionTest(_Mixin, unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_ovr_")
        self.ref = os.path.join(self.tmp, "ref.wav")
        with open(self.ref, "wb") as f:
            f.write(b"dummy")  # _transcript_key stat용(자동 경로는 Whisper mock)
        self.abspath = os.path.abspath(self.ref)
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def test_manual_overrides_auto_no_whisper(self):
        counter = []
        self._whisper(result={"text": "자동전사", "language": "ko"}, counter=counter)
        eng = tts_worker.GPTSoVITSEngine()
        eng.set_prompt_overrides({self.abspath: {"manual_text": "수동 전사문", "prompt_lang": "ko"}})
        p = eng._get_ref_prompt(self.ref, "ko")
        self.assertEqual(p.mode, rt.MODE_MANUAL)
        self.assertEqual(p.prompt_text, "수동 전사문")
        self.assertEqual(p.prompt_language, "ko")
        self.assertEqual(counter, [], "수동 전사문이 있으면 Whisper를 호출하지 않음")

    def test_manual_language_defaults_to_target(self):
        self._whisper(result={"text": "x", "language": "ko"})
        eng = tts_worker.GPTSoVITSEngine()
        eng.set_prompt_overrides({self.abspath: {"manual_text": "hello", "prompt_lang": ""}})
        p = eng._get_ref_prompt(self.ref, "en")  # 목표 텍스트 언어 en
        self.assertEqual(p.mode, rt.MODE_MANUAL)
        self.assertEqual(p.prompt_language, "en")

    def test_empty_manual_ref_free_mode(self):
        counter = []
        self._whisper(result={"text": "auto", "language": "ko"}, counter=counter)
        eng = tts_worker.GPTSoVITSEngine()
        eng.set_prompt_overrides({self.abspath: {"manual_text": "", "mode": "ref_free"}})
        p = eng._get_ref_prompt(self.ref, "ja")
        self.assertEqual(p.mode, rt.MODE_REF_FREE)
        self.assertEqual(p.prompt_text, "")
        self.assertEqual(p.prompt_language, "ja")
        self.assertIn(rt.REF_FREE_USER, [w.code for w in p.warnings])
        self.assertEqual(counter, [], "ref-free는 Whisper 호출 안 함")

    def test_empty_manual_auto_falls_through(self):
        counter = []
        self._whisper(result={"text": "자동전사", "language": "ko"}, counter=counter)
        eng = tts_worker.GPTSoVITSEngine()
        eng.set_prompt_overrides({self.abspath: {"manual_text": "   ", "mode": "auto"}})
        p = eng._get_ref_prompt(self.ref, "ko")
        # 빈 수동을 성공으로 오인하지 않고 자동 경로로 → Whisper 호출됨
        self.assertEqual(p.mode, rt.MODE_TRANSCRIBED)
        self.assertEqual(p.prompt_text, "자동전사")
        self.assertEqual(counter, [1])

    def test_ref_free_beats_leftover_manual_text(self):
        # 수동문이 남아 있어도 mode=ref_free면 ref-free 우선(수동 무시, Whisper 미호출)
        counter = []
        self._whisper(result={"text": "auto", "language": "ko"}, counter=counter)
        eng = tts_worker.GPTSoVITSEngine()
        eng.set_prompt_overrides({self.abspath: {"manual_text": "남은 수동문", "mode": "ref_free", "prompt_lang": "ko"}})
        p = eng._get_ref_prompt(self.ref, "ko")
        self.assertEqual(p.mode, rt.MODE_REF_FREE)
        self.assertEqual(p.prompt_text, "")
        self.assertEqual(counter, [], "ref-free 우선 시 Whisper 미호출")

    def test_user_language_overrides_auto_detection(self):
        self._whisper(result={"text": "今日は", "language": "ja"})
        eng = tts_worker.GPTSoVITSEngine()
        eng.set_prompt_overrides({self.abspath: {"manual_text": "", "prompt_lang": "zh", "mode": "auto"}})
        p = eng._get_ref_prompt(self.ref, "ja")
        self.assertEqual(p.mode, rt.MODE_TRANSCRIBED)
        self.assertEqual(p.prompt_text, "今日は")     # 전사문은 자동 유지
        self.assertEqual(p.prompt_language, "zh")     # 언어는 사용자 지정으로 override

    def test_no_override_is_plain_auto(self):
        counter = []
        self._whisper(result={"text": "auto", "language": "ko"}, counter=counter)
        eng = tts_worker.GPTSoVITSEngine()
        p = eng._get_ref_prompt(self.ref, "ko")
        self.assertEqual(p.mode, rt.MODE_TRANSCRIBED)
        self.assertEqual(counter, [1])

    def test_manual_prompt_json_serializable(self):
        p = rt.build_manual_prompt("안녕", "ko", "ko")
        json.loads(json.dumps(p.to_dict(), ensure_ascii=False))
        p2 = rt.build_user_ref_free_prompt("en", None)
        d = json.loads(json.dumps(p2.to_dict(), ensure_ascii=False))
        self.assertEqual(d["mode"], "ref_free")
        self.assertIsNone(d["transcript"])


class DeliveryPathTest(_Mixin, unittest.TestCase):
    """synthesize(reference_prompts) → 식별자→경로 매핑 → subprocess payload 검증(모델 없음)."""
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_ovr_int_")
        self.ref5 = os.path.join(self.tmp, "ref5.wav")
        _write(self.ref5, 5.0)  # 유효(3~10s, 품질 게이트 통과)
        self.out = os.path.join(self.tmp, "out.wav")
        self._orig_cache = dict(ra._analysis_cache)
        ra._analysis_cache.clear()
        self.addCleanup(self._restore_cache)
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def _restore_cache(self):
        ra._analysis_cache.clear()
        ra._analysis_cache.update(self._orig_cache)

    def _capture(self, store):
        def fake_run(cmd, input=None, capture_output=False, text=False,
                     encoding=None, errors=None, timeout=None):
            cfg = json.loads(input)
            store.append(cfg)
            op = cfg.get("output_path")
            if op:
                _write(op, 0.2)  # 브리지가 쓸 출력 세그먼트를 mock이 생성(concat/rename 통과용)
            return FakeCompleted(0, '{"type":"progress","percent":50}\n', "")
        return fake_run

    def test_manual_override_reaches_subprocess_payload(self):
        captured, counter = [], []
        self._whisper(result={"text": "자동", "language": "ko"}, counter=counter)
        self._start(mock.patch.object(subprocess, "run", side_effect=self._capture(captured)))
        # GPT 엔진 강제 + load/venv mock
        eng = tts_worker._get_engine("gptsovits")
        self._start(mock.patch.object(eng, "load", lambda: None))
        eng._venv_python = "python"
        eng._bridge_script = "bridge.py"

        tts_worker.synthesize(
            self.ref5, "한국어 문장입니다.", self.tmp,
            emotion_refs={}, preferred_engine="gptsovits",
            reference_prompts={"default": {"manual_text": "직접 입력한 전사", "prompt_lang": "ko"}})

        self.assertEqual(len(captured), 1)
        cfg = captured[0]
        self.assertEqual(cfg["prompt_text"], "직접 입력한 전사")
        self.assertEqual(cfg["prompt_lang"], "ko")
        self.assertEqual(counter, [], "수동 전사문 전달 시 Whisper 미호출")

    def test_no_reference_prompts_clears_stale_overrides(self):
        # 이전 작업의 override가 남지 않아야 함(항상 set_prompt_overrides 호출)
        captured, counter = [], []
        self._whisper(result={"text": "자동전사문", "language": "ko"}, counter=counter)
        self._start(mock.patch.object(subprocess, "run", side_effect=self._capture(captured)))
        eng = tts_worker._get_engine("gptsovits")
        eng.set_prompt_overrides({os.path.abspath(self.ref5): {"manual_text": "STALE"}})  # 이전 잔재
        self._start(mock.patch.object(eng, "load", lambda: None))
        eng._venv_python = "python"
        eng._bridge_script = "bridge.py"

        tts_worker.synthesize(
            self.ref5, "문장입니다.", self.tmp,
            emotion_refs={}, preferred_engine="gptsovits", reference_prompts=None)

        cfg = captured[0]
        self.assertEqual(cfg["prompt_text"], "자동전사문", "override 없으면 자동 전사 사용(잔재 무시)")
        self.assertNotEqual(cfg["prompt_text"], "STALE")


if __name__ == "__main__":
    unittest.main(verbosity=2)
