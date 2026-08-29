# -*- coding: utf-8 -*-
"""Whisper 가중치 해석 계약 — 조용한 탐색·다운로드 금지. 모델 로딩은 하지 않는다(파일 존재만)."""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcribe_worker as tw
import tts_worker


class TestWhisperResolution(unittest.TestCase):
    def setUp(self):
        self._env = os.environ.get(tw.WHISPER_ROOT_ENV)
        self.tmp = tempfile.mkdtemp(prefix="af-wh-")

    def tearDown(self):
        if self._env is None:
            os.environ.pop(tw.WHISPER_ROOT_ENV, None)
        else:
            os.environ[tw.WHISPER_ROOT_ENV] = self._env
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_production_critical_model_is_small(self):
        # ICL 정렬과 참조 전사가 같은 모델을 쓴다는 계약을 고정한다.
        self.assertEqual(tts_worker._QWEN_REF_TRANSCRIBE_MODEL, "small")

    def test_small_resolves_internally(self):
        root, source = tw.resolve_whisper_root("small")
        self.assertEqual(source, "internal", "production 필수 모델이 외부 캐시에 의존한다")
        self.assertTrue(os.path.isfile(os.path.join(root, "small.pt")))

    def test_env_override_wins(self):
        os.environ[tw.WHISPER_ROOT_ENV] = self.tmp
        self.assertEqual(os.path.normcase(tw.whisper_model_root()), os.path.normcase(self.tmp))

    def test_missing_model_raises_instead_of_downloading(self):
        os.environ[tw.WHISPER_ROOT_ENV] = self.tmp          # 비어 있는 내부 위치
        with self.assertRaises(tw.WhisperModelMissing) as cm:
            tw.resolve_whisper_root("__nonexistent_model__")
        self.assertIn("WHISPER_MODEL_MISSING", str(cm.exception))

    def test_internal_beats_external_cache(self):
        os.environ[tw.WHISPER_ROOT_ENV] = self.tmp
        with open(os.path.join(self.tmp, "small.pt"), "wb") as f:
            f.write(b"x")
        root, source = tw.resolve_whisper_root("small")
        self.assertEqual(source, "internal")
        self.assertEqual(os.path.normcase(root), os.path.normcase(self.tmp))

    def test_loader_passes_explicit_download_root(self):
        # whisper.load_model 에 download_root 가 반드시 전달되는지(조용한 ~/.cache 탐색 차단).
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "transcribe_worker.py"), encoding="utf-8").read()
        self.assertIn("download_root=root", src)
        self.assertNotIn("whisper.load_model(model_name, device=device)", src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
