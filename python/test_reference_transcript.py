# -*- coding: utf-8 -*-
"""참조 전사 구조화(2C-1) 테스트 — 실제 Whisper/GPT 모델 없이 unittest+mock.

- transcribe_reference/build_gpt_prompt 단위 검증(언어 보존·일본어 zh 오판 금지·ref-free 강등·
  None/비-Mapping 반환도 구조화된 실패).
- GPTSoVITSEngine 통합: load/bridge subprocess를 mock하고 전달될 JSON payload를 캡처해
  prompt_text/prompt_lang 검증. 캐시·경고 1회·성공메시지 1회·invalid 차단·모델 미로딩 확인.
- 각 patch는 patcher를 보존해 addCleanup(patcher.stop)으로 개별 복원(전역 stopall 사용 안 함).
- 전역 캐시(reference_audio._analysis_cache)는 스냅샷 후 복원.

실행:
  python python/test_reference_transcript.py
  python -m unittest discover -s python -p "test_reference_transcript.py"
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
import runtime_paths                # noqa: E402


def _configure_test_roots():
    """GPT-SoVITS 합성 payload(venv/GPT-SoVITS dir 주입)가 root를 요구 — 테스트 root를 심는다."""
    runtime_paths.reset()
    runtime_paths.set_path_resolver(None)
    runtime_paths.configure({
        "schemaVersion": 2,
        "runtimeRoot": {"path": "C:/af_test/rt", "ownership": "audioforge-managed"},
        "modelRoot": {"path": "C:/af_test/md", "ownership": "audioforge-managed"},
        "cacheRoot": {"path": "C:/af_test/ch", "ownership": "audioforge-managed"},
    })


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


class _PatchMixin:
    def _start(self, patcher):
        """patcher를 시작하고, 이 테스트 종료 시에만 개별 stop(전역 stopall 금지)."""
        patcher.start()
        self.addCleanup(patcher.stop)
        return patcher

    def _whisper(self, result=None, exc=None, counter=None):
        self._start(mock.patch.object(transcribe_worker, "_get_whisper_model",
                                      lambda name: ("model", name)))

        def ft(model, path, lang):
            if counter is not None:
                counter.append(1)
            if exc is not None:
                raise exc
            return result
        self._start(mock.patch.object(transcribe_worker, "run_transcribe", side_effect=ft))


class TranscribeReferenceUnitTest(_PatchMixin, unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_rt_unit_")
        self.f = os.path.join(self.tmp, "ref.wav")
        with open(self.f, "wb") as fh:
            fh.write(b"dummy")  # _stat용(실제 오디오는 Whisper mock이라 불필요)
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def test_korean_success(self):
        self._whisper(result={"text": "안녕하세요", "language": "ko"})
        t = rt.transcribe_reference(self.f, "small")
        self.assertEqual(t.status, rt.STATUS_OK)
        self.assertEqual(t.text, "안녕하세요")
        self.assertEqual(t.language, "ko")
        p = rt.build_gpt_prompt(t, "ko")
        self.assertEqual(p.mode, rt.MODE_TRANSCRIBED)
        self.assertEqual(p.prompt_text, "안녕하세요")
        self.assertEqual(p.prompt_language, "ko")

    def test_japanese_kanji_not_misdetected_as_zh(self):
        self._whisper(result={"text": "今日は東京駅で会議があります", "language": "ja"})
        t = rt.transcribe_reference(self.f)
        p = rt.build_gpt_prompt(t, "ja")
        self.assertEqual(t.language, "ja")
        self.assertEqual(p.prompt_language, "ja")  # 한자 비율로 zh 오판 금지
        self.assertEqual(p.mode, rt.MODE_TRANSCRIBED)

    def test_english_success(self):
        self._whisper(result={"text": "hello world", "language": "en"})
        p = rt.build_gpt_prompt(rt.transcribe_reference(self.f), "en")
        self.assertEqual(p.mode, rt.MODE_TRANSCRIBED)
        self.assertEqual(p.prompt_language, "en")

    def test_chinese_zhcn_normalized(self):
        self._whisper(result={"text": "你好世界", "language": "zh-CN"})
        t = rt.transcribe_reference(self.f)
        self.assertEqual(t.language, "zh")  # 정규화
        p = rt.build_gpt_prompt(t, "zh")
        self.assertEqual(p.mode, rt.MODE_TRANSCRIBED)
        self.assertEqual(p.prompt_language, "zh")

    def test_empty_transcript_ref_free(self):
        self._whisper(result={"text": "   ", "language": "ko"})
        t = rt.transcribe_reference(self.f)
        self.assertEqual(t.status, rt.STATUS_EMPTY)
        self.assertEqual(t.error_code, rt.EMPTY_TRANSCRIPT)
        p = rt.build_gpt_prompt(t, "ko")
        self.assertEqual(p.mode, rt.MODE_REF_FREE)
        self.assertEqual(p.prompt_text, "")
        codes = [w.code for w in p.warnings]
        self.assertIn(rt.EMPTY_TRANSCRIPT, codes)
        self.assertIn(rt.REF_FREE_FALLBACK, codes)

    def test_whisper_exception_ref_free(self):
        self._whisper(exc=RuntimeError("whisper boom"))
        t = rt.transcribe_reference(self.f)
        self.assertEqual(t.status, rt.STATUS_FAILED)
        self.assertEqual(t.error_code, rt.TRANSCRIPTION_FAILED)
        self.assertIn("boom", t.error_message)
        p = rt.build_gpt_prompt(t, "ko")
        self.assertEqual(p.mode, rt.MODE_REF_FREE)
        self.assertIn(rt.TRANSCRIPTION_FAILED, [w.code for w in p.warnings])

    def test_none_result_is_failed(self):
        # run_transcribe가 예외 없이 None 반환 → AttributeError로 터지지 않고 구조화된 실패
        self._whisper(result=None)
        t = rt.transcribe_reference(self.f)
        self.assertEqual(t.status, rt.STATUS_FAILED)
        self.assertEqual(t.error_code, rt.TRANSCRIPTION_FAILED)
        p = rt.build_gpt_prompt(t, "ko")
        self.assertEqual(p.mode, rt.MODE_REF_FREE)

    def test_non_mapping_result_is_failed(self):
        # dict/Mapping이 아닌 반환값(list 등)도 구조화된 실패
        self._whisper(result=["not", "a", "dict"])
        t = rt.transcribe_reference(self.f)
        self.assertEqual(t.status, rt.STATUS_FAILED)
        self.assertEqual(t.error_code, rt.TRANSCRIPTION_FAILED)

    def test_bad_text_type_is_failed(self):
        # text 타입 이상(int)도 구조화된 실패
        self._whisper(result={"text": 123, "language": "ko"})
        t = rt.transcribe_reference(self.f)
        self.assertEqual(t.status, rt.STATUS_FAILED)
        self.assertEqual(t.error_code, rt.TRANSCRIPTION_FAILED)

    def test_language_missing_ref_free(self):
        self._whisper(result={"text": "some text", "language": "unknown"})
        t = rt.transcribe_reference(self.f)
        self.assertIsNone(t.language)
        p = rt.build_gpt_prompt(t, "en")
        self.assertEqual(p.mode, rt.MODE_REF_FREE)
        self.assertIn(rt.LANGUAGE_MISSING, [w.code for w in p.warnings])

    def test_unsupported_language_ref_free(self):
        self._whisper(result={"text": "bonjour le monde", "language": "fr"})
        t = rt.transcribe_reference(self.f)
        self.assertEqual(t.status, rt.STATUS_OK)
        self.assertEqual(t.language, "fr")
        p = rt.build_gpt_prompt(t, "fr")
        self.assertEqual(p.mode, rt.MODE_REF_FREE)
        self.assertIn(rt.UNSUPPORTED_PROMPT_LANGUAGE, [w.code for w in p.warnings])

    def test_ref_free_uses_target_language(self):
        self._whisper(result={"text": "", "language": "ko"})
        t = rt.transcribe_reference(self.f)
        p = rt.build_gpt_prompt(t, "ja")
        self.assertEqual(p.prompt_language, "ja")  # 목표 텍스트 언어 사용

    def test_json_serializable(self):
        self._whisper(result={"text": "hi", "language": "en"})
        t = rt.transcribe_reference(self.f)
        p = rt.build_gpt_prompt(t, "en")
        json.loads(json.dumps(t.to_dict(), ensure_ascii=False))
        d = json.loads(json.dumps(p.to_dict(), ensure_ascii=False))
        self.assertEqual(d["mode"], "transcribed")
        self.assertIn("transcript", d)


class GptPromptIntegrationTest(_PatchMixin, unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_rt_int_")
        self.ref5 = os.path.join(self.tmp, "ref5.wav")
        self.ref2 = os.path.join(self.tmp, "ref2.wav")
        _write(self.ref5, 5.0)   # 유효(3~10s)
        _write(self.ref2, 2.0)   # TOO_SHORT
        self.out = os.path.join(self.tmp, "out.wav")
        _configure_test_roots()
        self.addCleanup(runtime_paths.reset)
        # 전역 분석 캐시 스냅샷 후 복원(전역 stopall 사용 안 함)
        self._orig_cache = dict(ra._analysis_cache)
        ra._analysis_cache.clear()
        self.addCleanup(self._restore_cache)
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def _restore_cache(self):
        ra._analysis_cache.clear()
        ra._analysis_cache.update(self._orig_cache)

    def _engine(self):
        eng = tts_worker.GPTSoVITSEngine()
        eng.load = lambda: None
        eng._venv_python = "python"
        eng._bridge_script = "bridge.py"
        return eng

    def _capture(self, store):
        def fake_run(cmd, input=None, capture_output=False, text=False,
                     encoding=None, errors=None, timeout=None):
            store.append(json.loads(input))
            return FakeCompleted(0, '{"type": "progress", "percent": 50}\n', "")
        return fake_run

    def _silence_emit(self, store=None):
        def fake_emit(mtype, **kw):
            if store is not None:
                store.append(kw.get("message", ""))
        self._start(mock.patch.object(tts_worker, "emit", fake_emit))

    def test_success_payload_prompt_text_and_lang(self):
        captured = []
        self._whisper(result={"text": "안녕하세요", "language": "ko"})
        self._silence_emit()
        self._start(mock.patch.object(subprocess, "run", side_effect=self._capture(captured)))
        eng = self._engine()
        eng.synthesize_segment("한국어 문장입니다.", self.ref5, "default", 1.0, self.out)
        self.assertEqual(len(captured), 1)
        cfg = captured[0]
        self.assertEqual(cfg["prompt_text"], "안녕하세요")
        self.assertEqual(cfg["prompt_lang"], "ko")   # Whisper 언어(재추정 아님)
        self.assertEqual(cfg["language"], "ko")       # 목표 텍스트 언어

    def test_ref_free_payload_empty_text_target_lang(self):
        captured = []
        self._whisper(result={"text": "", "language": "ko"})  # 빈 결과 → ref_free
        self._silence_emit()
        self._start(mock.patch.object(subprocess, "run", side_effect=self._capture(captured)))
        eng = self._engine()
        eng.synthesize_segment("this is english.", self.ref5, "default", 1.0, self.out)
        cfg = captured[0]
        self.assertEqual(cfg["prompt_text"], "")
        self.assertEqual(cfg["prompt_lang"], "en")    # 목표 텍스트 언어
        self.assertEqual(cfg["language"], "en")

    def test_transcribe_cached_once_across_sentences(self):
        captured, counter = [], []
        self._whisper(result={"text": "안녕", "language": "ko"}, counter=counter)
        self._silence_emit()
        self._start(mock.patch.object(subprocess, "run", side_effect=self._capture(captured)))
        eng = self._engine()
        eng.synthesize_segment("문장 하나.", self.ref5, "default", 1.0, self.out)
        eng.synthesize_segment("문장 둘.", self.ref5, "default", 1.0, self.out)
        self.assertEqual(len(counter), 1, "같은 파일 재사용 시 전사 1회")

    def test_success_message_once_per_key(self):
        captured, msgs = [], []
        self._whisper(result={"text": "안녕", "language": "ko"})
        self._silence_emit(msgs)
        self._start(mock.patch.object(subprocess, "run", side_effect=self._capture(captured)))
        eng = self._engine()
        eng.synthesize_segment("문장 하나.", self.ref5, "default", 1.0, self.out)
        eng.synthesize_segment("문장 둘.", self.ref5, "default", 1.0, self.out)
        done = [m for m in msgs if "전사 완료" in m]
        self.assertEqual(len(done), 1, "성공 메시지는 전사 키당 1회")

    def test_retranscribe_on_mtime_change(self):
        counter = []
        self._whisper(result={"text": "안녕", "language": "ko"}, counter=counter)
        self._silence_emit()
        eng = self._engine()
        eng._get_ref_prompt(self.ref5, "ko")
        st = os.stat(self.ref5)
        os.utime(self.ref5, (st.st_atime + 100, st.st_mtime + 100))
        eng._get_ref_prompt(self.ref5, "ko")
        self.assertEqual(len(counter), 2, "파일 변경 시 재전사")

    def test_retranscribe_on_model_change(self):
        counter = []
        self._whisper(result={"text": "안녕", "language": "ko"}, counter=counter)
        self._silence_emit()
        eng = self._engine()
        eng._get_ref_prompt(self.ref5, "ko", model_name="small")
        eng._get_ref_prompt(self.ref5, "ko", model_name="medium")
        self.assertEqual(len(counter), 2, "모델명 변경 시 재전사")

    def test_warning_once_per_ref_and_cause(self):
        self._whisper(result={"text": "", "language": "ko"})  # ref_free → 2 경고 코드
        emits = []
        self._silence_emit(emits)
        eng = self._engine()
        eng._get_ref_prompt(self.ref5, "ko")
        eng._get_ref_prompt(self.ref5, "ko")
        warn_msgs = [m for m in emits if "경고" in m]
        self.assertEqual(len(warn_msgs), 2, "원인 2개 × 1회 = 2 (반복 호출에도 중복 없음)")

    def test_invalid_ref_blocks_transcription(self):
        counter = []
        self._whisper(result={"text": "x", "language": "ko"}, counter=counter)
        eng = self._engine()
        self._start(mock.patch.object(subprocess, "run",
                                      side_effect=AssertionError("subprocess 호출됨")))
        with self.assertRaises(RuntimeError):
            eng.synthesize_segment("문장.", self.ref2, "default", 1.0, self.out)
        self.assertEqual(counter, [], "invalid 참조는 전사 진입 전 차단")
        self.assertFalse(os.path.exists(self.out))


if __name__ == "__main__":
    unittest.main(verbosity=2)
