# -*- coding: utf-8 -*-
"""공용 마감 I4 — 합성 결과 메타데이터 계약 테스트(순수, stdlib).

파서 plan 재현(parser_version·parsed_plan_sha8·segment/chunk 수·pause 수·total ms) + 말끝 finishing
(tail mode/pad/fade/applied) + 감정 전환 모드가 고정 메타 키로 존재하고, 대사 전문·전사·전체 경로 같은
민감 값은 담기지 않음을 고정한다. import tts_worker는 numpy 불요 → 시스템 python에서도 실행.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tts_worker as w  # noqa: E402

I4_KEYS = [
    "parser_version", "parsed_plan_sha8", "segment_count", "chunk_count",
    "explicit_pause_count", "total_pause_ms",
    "tail_mode", "tail_pad_ms", "tail_fade_ms", "tail_fade_applied", "emotion_boundary_mode",
]


class MetadataI4Test(unittest.TestCase):
    def test_keys_in_metadata_schema(self):
        for k in I4_KEYS:
            self.assertIn(k, w._METADATA_KEYS, k)

    def test_build_includes_values(self):
        meta = w._build_tts_metadata(
            parser_version=2, parsed_plan_sha8="6ecc66d8", segment_count=3, chunk_count=3,
            explicit_pause_count=1, total_pause_ms=500, tail_mode="auto", tail_pad_ms=120,
            tail_fade_ms=8, tail_fade_applied=True, emotion_boundary_mode="pause")
        self.assertEqual(meta["parser_version"], 2)
        self.assertEqual(meta["parsed_plan_sha8"], "6ecc66d8")
        self.assertEqual(len(meta["parsed_plan_sha8"]), 8)  # full sha256의 앞 8자(대사 전문 아님)
        self.assertEqual(meta["segment_count"], 3)
        self.assertEqual(meta["tail_mode"], "auto")
        self.assertEqual(meta["tail_fade_applied"], True)
        self.assertEqual(meta["emotion_boundary_mode"], "pause")

    def test_off_tail_defaults(self):
        meta = w._build_tts_metadata(tail_mode="off", tail_pad_ms=0, tail_fade_ms=0, tail_fade_applied=False)
        self.assertEqual(meta["tail_mode"], "off")
        self.assertEqual(meta["tail_pad_ms"], 0)
        self.assertFalse(meta["tail_fade_applied"])

    def test_no_sensitive_keys(self):
        # 어떤 인자를 넣어도 고정 스키마만 통과 — 대사/전사/전체경로 키는 존재하지 않는다.
        meta = w._build_tts_metadata(
            parser_version=2, parsed_plan_sha8="abcd1234",
            spoken_text="비밀 대사", tts_text="비밀 대사", transcript="비밀 전사",
            dialogue="비밀", abspath="C:/secret/path.wav")
        for bad in ("spoken_text", "tts_text", "transcript", "dialogue", "abspath", "text"):
            self.assertNotIn(bad, meta, bad)

    def test_missing_reproduction_is_none_not_crash(self):
        # 구 경로(값 미제공)는 None으로 존재(키 누락·크래시 없음).
        meta = w._build_tts_metadata(requested_engine="auto")
        for k in I4_KEYS:
            self.assertIn(k, meta)
            self.assertIsNone(meta[k])


if __name__ == "__main__":
    unittest.main()
