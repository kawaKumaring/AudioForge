"""문법 fixture '계약/shape' 테스트 (S1, 순수 stdlib). Agent B/A 이전의 계약 검증만.

⚠️ 실제 Python parser parity 통과가 아니다(그건 Agent A/Python parser 구현 단계).
같은 권위 fixture(test/fixtures/tts-grammar-conformance-v2.json)를 TS 계약 테스트와 공유해,
parser_version=2·case id 유일·valid/error 구조·dual offset 선언·integer pause_ms·full/sha8 구분·
error code 공용 집합 포함·필수 case 존재를 검증한다. 실패 보고는 case id·필드명만(대사 전문 미출력).
"""
import json
import os
import unittest

# 공용 오류 코드 집합 — 권위는 src/shared/ttsGrammar.ts TTS_GRAMMAR_ERROR_CODES. Python parser 구현이 이를 미러링한다.
SHARED_ERROR_CODES = {
    "UNKNOWN_TTS_TAG",
    "INVALID_PAUSE_TAG",
    "EMPTY_EMOTION_SEGMENT",
    "PARSER_PARITY_MISMATCH",
    "INVALID_TTS_CONFIG",
}

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(REPO_ROOT, "test", "fixtures", "tts-grammar-conformance-v2.json")


class TtsGrammarContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(FIXTURE, encoding="utf-8") as f:
            cls.fx = json.load(f)
        cls.meta = cls.fx.get("_meta", {})
        cls.valid = cls.fx.get("valid", [])
        cls.errors = cls.fx.get("error", [])

    def test_parser_version_2(self):
        self.assertEqual(self.meta.get("parser_version"), 2)
        self.assertEqual(self.meta.get("schema_version"), 2)

    def test_case_ids_unique(self):
        ids = [c.get("id") for c in self.valid] + [c.get("id") for c in self.errors]
        self.assertTrue(all(isinstance(i, str) and i for i in ids), "every case has string id")
        self.assertEqual(len(ids), len(set(ids)), "ids unique")

    def test_valid_error_structure(self):
        self.assertGreaterEqual(len(self.valid), 8)
        self.assertGreaterEqual(len(self.errors), 5)
        for c in self.valid:
            self.assertIn("input", c)
        for c in self.errors:
            self.assertIn("error", c)
            self.assertIsInstance(c["error"].get("code"), str)

    def test_dual_offset_fields_declared(self):
        off = self.meta.get("offset_fields", [])
        for f in ("ui_start_utf16", "ui_end_utf16", "text_start_codepoint", "text_end_codepoint"):
            self.assertIn(f, off)

    def test_integer_pause_ms_policy(self):
        self.assertTrue(self.meta.get("pause_ms_integer") is True)
        self.assertTrue(any("pause_ms" in h for h in self.meta.get("hash_inputs", [])))

    def test_full_vs_sha8_distinction(self):
        hi = self.meta.get("hash_inputs", [])
        self.assertIn("spoken_text_full_sha256", hi)
        self.assertIn("spoken_text_utf8_byte_length", hi)

    def test_error_codes_in_shared_set(self):
        for c in self.errors:
            self.assertIn(c["error"]["code"], SHARED_ERROR_CODES)
        for code in self.meta.get("error_codes", []):
            self.assertIn(code, SHARED_ERROR_CODES)

    def test_required_cases_present(self):
        names = " | ".join(str(c.get("name", "")) for c in (self.valid + self.errors)).lower()
        codes = {c["error"]["code"] for c in self.errors}
        self.assertIn("escape", names)
        self.assertIn("UNKNOWN_TTS_TAG", codes)
        self.assertIn("EMPTY_EMOTION_SEGMENT", codes)
        self.assertIn("INVALID_PAUSE_TAG", codes)
        self.assertTrue("boundary priority" in names or "경계 우선순위" in names)


if __name__ == "__main__":
    unittest.main()
