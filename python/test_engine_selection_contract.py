# -*- coding: utf-8 -*-
"""엔진 선택 계약 — 명시 요청은 조용히 대체되지 않는다.

이 계약이 없던 동안 실제로 일어난 일: 사용자가 Qwen 을 지목했는데 런타임 자산이 없어
qwen.available()==False 였고, 코드는 progress 한 줄만 남기고 문장별 폴백(kokoro)으로 넘어갔다.
결과는 '요청하지 않은 엔진으로 합성' 또는 그 엔진의 환경 오류였고, 어느 쪽이든 사용자는
무엇으로 합성됐는지 알 수 없었다. 자동 선택(auto/None)과 명시 선택은 다른 계약이다.
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import tts_worker as tw


class _FakeQwen:
    def __init__(self, ok):
        self._ok = ok

    def available(self):
        return self._ok


class SelectJobEngineContractTest(unittest.TestCase):
    """배치형 Qwen 라우팅(_select_job_engine)."""

    def test_explicit_qwen3_available_routes_to_qwen3(self):
        with mock.patch.object(tw, "_get_qwen_engine", return_value=_FakeQwen(True)):
            self.assertEqual(tw._select_job_engine("안녕하세요", "qwen3"), "qwen3")

    def test_explicit_qwen3_unavailable_raises_instead_of_silent_fallback(self):
        with mock.patch.object(tw, "_get_qwen_engine", return_value=_FakeQwen(False)):
            with self.assertRaises(RuntimeError) as ctx:
                tw._select_job_engine("안녕하세요", "qwen3")
        payload = getattr(ctx.exception, "error_payload", {})
        self.assertEqual(payload.get("code"), tw.ENGINE_UNAVAILABLE)
        self.assertEqual(payload.get("requested_engine"), "qwen3")
        # 대사·경로가 오류에 실리지 않는다.
        self.assertNotIn("안녕하세요", str(ctx.exception))

    def test_unknown_engine_name_is_validation_error(self):
        # 'qwen' 은 실제로 있었던 오기다 — 기본 엔진으로 흘리면 안 된다.
        with mock.patch.object(tw, "_get_qwen_engine", return_value=_FakeQwen(True)):
            with self.assertRaises(RuntimeError) as ctx:
                tw._select_job_engine("안녕하세요", "qwen")
        self.assertEqual(getattr(ctx.exception, "error_payload", {}).get("code"),
                         tw.ENGINE_NAME_INVALID)

    def test_auto_and_none_keep_language_based_selection(self):
        # 자동 선택은 기존 동작 그대로(한국어 + Qwen 가용 → qwen3).
        # 'auto' 는 separate.py 가 None 으로 정규화해서 넘긴다(여기서는 그 정규화된 형태를 검증).
        # 'auto' 문자열이 그대로 들어와도 검증 오류가 되지 않는다는 것만 별도로 확인한다.
        with mock.patch.object(tw, "_get_qwen_engine", return_value=_FakeQwen(True)):
            self.assertEqual(tw._select_job_engine("안녕하세요", None), "qwen3")
            self.assertIsNone(tw._select_job_engine("안녕하세요", "auto"))  # 검증 오류 아님

    def test_auto_with_qwen_unavailable_falls_back_quietly_by_design(self):
        # 자동 선택에서는 폴백이 계약이다(명시 선택과 구분되는 지점).
        with mock.patch.object(tw, "_get_qwen_engine", return_value=_FakeQwen(False)):
            self.assertIsNone(tw._select_job_engine("안녕하세요", None))

    def test_other_explicit_engine_still_uses_per_sentence_path(self):
        with mock.patch.object(tw, "_get_qwen_engine", return_value=_FakeQwen(True)):
            self.assertIsNone(tw._select_job_engine("hello", "kokoro"))


class SelectEngineContractTest(unittest.TestCase):
    """문장별 엔진 선택(_select_engine)."""

    def test_known_engine_is_honored(self):
        with mock.patch.object(tw, "_get_engine", side_effect=lambda n: ("engine", n)):
            self.assertEqual(tw._select_engine("hello", "kokoro"), ("engine", "kokoro"))

    def test_unknown_engine_name_raises(self):
        with self.assertRaises(RuntimeError) as ctx:
            tw._select_engine("hello", "not-an-engine")
        self.assertEqual(getattr(ctx.exception, "error_payload", {}).get("code"),
                         tw.ENGINE_NAME_INVALID)

    def test_auto_keeps_language_routing(self):
        with mock.patch.object(tw, "_get_engine", side_effect=lambda n: ("engine", n)):
            self.assertEqual(tw._select_engine("hello", "auto"), ("engine", "f5tts"))
            self.assertEqual(tw._select_engine("hello", None), ("engine", "f5tts"))


class ValidEngineNamesTest(unittest.TestCase):
    def test_registry_plus_qwen3(self):
        self.assertIn("qwen3", tw._VALID_ENGINE_NAMES)
        for name in tw.ENGINES:
            self.assertIn(name, tw._VALID_ENGINE_NAMES)


if __name__ == "__main__":
    unittest.main()
