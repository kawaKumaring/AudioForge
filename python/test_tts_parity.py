"""공용 마감 I1 — tts_parity.verify_parity 단위테스트(순수, stdlib). 대사 전문 미출력."""
import unittest
import tts_parity
import tts_grammar


class VerifyParityTest(unittest.TestCase):
    def _hash(self, raw):
        res = tts_grammar.parse_tts_script(raw)
        self.assertTrue(res["ok"], raw)
        return res["plan"]["full_sha256"]

    def test_matching_hash_passes(self):
        raw = "[기쁨] 안녕하세요. [명랑] 오늘 날씨가 좋아요."
        self.assertEqual(tts_parity.verify_parity(raw, self._hash(raw)), [])

    def test_mismatch_hash_blocks(self):
        raw = "[기쁨] 안녕하세요."
        errs = tts_parity.verify_parity(raw, "deadbeef" * 8)  # 64 hex, 틀린 값
        self.assertEqual(len(errs), 1)
        self.assertEqual(errs[0]["code"], "PARSER_PARITY_MISMATCH")

    def test_parse_error_unknown_tag(self):
        errs = tts_parity.verify_parity("[명란] 오늘 날씨가 좋네요.", "whatever")
        self.assertTrue(errs)
        self.assertEqual(errs[0]["code"], "UNKNOWN_TTS_TAG")

    def test_parse_error_invalid_pause(self):
        errs = tts_parity.verify_parity("A [쉼 9.0] B", "whatever")
        self.assertTrue(errs)
        self.assertEqual(errs[0]["code"], "INVALID_PAUSE_TAG")

    def test_empty_expected_skips_parity_but_validates_parse(self):
        # expected 미제공 → parity 강제 안 함(유효 파싱은 통과)
        self.assertEqual(tts_parity.verify_parity("[기쁨] 안녕", ""), [])
        # expected 미제공이어도 파싱 오류는 여전히 차단
        errs = tts_parity.verify_parity("[없는태그] 문장", "")
        self.assertTrue(errs)
        self.assertEqual(errs[0]["code"], "UNKNOWN_TTS_TAG")

    def test_plain_text_no_tags_passes(self):
        self.assertEqual(tts_parity.verify_parity("그냥 대사입니다.", ""), [])


if __name__ == "__main__":
    unittest.main()
