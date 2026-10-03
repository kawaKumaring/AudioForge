# -*- coding: utf-8 -*-
"""참조 전사 디스크 캐시(2026-10-03) — 같은 소리 내용·같은 전사 모델일 때만 다시 쓴다. 성공한 자동 전사만 쌓는다.

왜: 참조 목소리 카드는 생성마다 새 프로세스라 프로세스 안 캐시가 늘 비어, 같은 참조로 다시 만들 때마다 Whisper 전사(실측 20~31초)를 되풀이했다.
Whisper 없이 전사 함수를 가짜로 바꿔 본다.

실행: python -X utf8 python/test_ref_transcript_cache.py
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로
import shutil
import tempfile
import unittest
from unittest import mock

import tts_worker as tw
import reference_transcript as rt


class RefTranscriptCacheTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_rtc_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.cache = os.path.join(self.tmp, "refTranscripts")
        self.env = mock.patch.dict(os.environ, {"AF_REF_TRANSCRIPT_CACHE_DIR": self.cache})
        self.env.start()
        self.addCleanup(self.env.stop)
        tw._qwen_ref_text_cache.clear()
        self.calls = []

        def fake(path, model_name="small"):
            self.calls.append(path)
            with open(path, "rb") as fh:
                body = fh.read()
            if body == b"FAIL":
                return rt.ReferenceTranscript(source_path=path, status=rt.STATUS_FAILED, text="", language=None,
                                              model_name=model_name, error_code="TRANSCRIPTION_FAILED")
            return rt.ReferenceTranscript(source_path=path, status=rt.STATUS_OK, text="전사:" + body.decode(), language="ko",
                                          model_name=model_name)
        self.patch = mock.patch.object(rt, "transcribe_reference", side_effect=fake)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def _wav(self, name, body):
        p = os.path.join(self.tmp, name)
        with open(p, "wb") as fh:
            fh.write(body)
        return p

    def _resolve(self, p):
        tw._qwen_ref_text_cache.clear()          # 새 프로세스와 같다(프로세스 안 캐시 없음)
        return tw._resolve_qwen_ref_text(p, {}, set())

    def test_같은_소리는_새_프로세스에서도_전사를_되풀이하지_않는다(self):
        a = self._wav("a.wav", b"AAA")
        self.assertEqual(self._resolve(a), ("전사:AAA", False))
        self.assertEqual(self._resolve(a), ("전사:AAA", False))
        self.assertEqual(len(self.calls), 1, "같은 참조인데 다시 전사했다")
        b = self._wav("다른 자리.wav", b"AAA")        # 경로가 달라도 내용이 같으면 같은 참조
        self.assertEqual(self._resolve(b), ("전사:AAA", False))
        self.assertEqual(len(self.calls), 1)

    def test_내용이_바뀌면_다시_전사한다_구간을_바꾼_것과_같다(self):
        a = self._wav("a.wav", b"AAA")
        self._resolve(a)
        with open(a, "wb") as fh:
            fh.write(b"BBB")                          # 같은 자리, 다른 소리(다른 구간·다른 화자)
        self.assertEqual(self._resolve(a), ("전사:BBB", False))
        self.assertEqual(len(self.calls), 2)

    def test_실패는_쌓지_않는다_전사_모델이_다르면_다른_열쇠(self):
        f = self._wav("f.wav", b"FAIL")
        self.assertEqual(self._resolve(f), ("", True))
        self._resolve(f)
        self.assertEqual(len(self.calls), 2, "실패를 쌓아 다음에도 전사하지 않았다")
        a = self._wav("a.wav", b"AAA")
        self._resolve(a)
        with mock.patch.object(tw, "_QWEN_REF_TRANSCRIBE_MODEL", "medium"):
            self._resolve(a)
        self.assertEqual(len(self.calls), 4, "전사 모델이 다른데 같은 기록을 썼다")

    def test_캐시_자리가_없으면_예전처럼(self):
        with mock.patch.dict(os.environ, {"AF_REF_TRANSCRIPT_CACHE_DIR": ""}):
            a = self._wav("a.wav", b"AAA")
            self._resolve(a)
            self._resolve(a)
        self.assertEqual(len(self.calls), 2)
        self.assertFalse(os.path.isdir(self.cache))


if __name__ == "__main__":
    unittest.main(verbosity=2)
