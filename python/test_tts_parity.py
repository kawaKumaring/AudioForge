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

    # ── I1 보강 2c: 한 글자/개행 하나 차이 → 모델 로딩 전 PARSER_PARITY_MISMATCH ──
    def test_one_char_diff_blocks_before_model(self):
        # renderer가 hash한 원문과 Python이 받은 원문이 한 글자라도 다르면 차단(합성 권위=Python).
        errs = tts_parity.verify_parity("[기쁨] 안녕하세요!", self._hash("[기쁨] 안녕하세요."))
        self.assertEqual([e["code"] for e in errs], ["PARSER_PARITY_MISMATCH"])

    def test_newline_diff_blocks_before_model(self):
        # 중간 계층이 CRLF→LF로 조용히 뭉개면 renderer(CRLF) 해시 ≠ Python(LF) 재파싱 → 차단.
        crlf_hash = self._hash("[기쁨] 첫째 줄.\r\n[슬픔] 둘째 줄.")
        errs = tts_parity.verify_parity("[기쁨] 첫째 줄.\n[슬픔] 둘째 줄.", crlf_hash)
        self.assertEqual([e["code"] for e in errs], ["PARSER_PARITY_MISMATCH"])

    # ── I1 보강 3: 구조화 code가 문자열로 뭉개지지 않고 전달 + 대사 전문/경로 미포함 ──
    def test_empty_emotion_segment_propagates(self):
        errs = tts_parity.verify_parity("[기쁨]\n[슬픔] 안녕", "")
        self.assertTrue(errs)
        self.assertEqual(errs[0]["code"], "EMPTY_EMOTION_SEGMENT")

    def test_structured_codes_and_no_sensitive_keys(self):
        # 각 오류 경로가 shared 집합의 정식 code를 담고, payload에 대사 전문·전사·경로 키가 없어야 한다.
        shared = {"UNKNOWN_TTS_TAG", "INVALID_PAUSE_TAG", "EMPTY_EMOTION_SEGMENT",
                  "PARSER_PARITY_MISMATCH", "INVALID_TTS_CONFIG"}
        sensitive = {"spoken_text", "text", "path", "abspath", "transcript", "message"}
        cases = [
            ("[명란] 문장", ""),                                   # UNKNOWN_TTS_TAG
            ("A [쉼 9.0] B", ""),                                  # INVALID_PAUSE_TAG(범위)
            ("[기쁨]\n[슬픔] 안녕", ""),                            # EMPTY_EMOTION_SEGMENT
            ("[기쁨] 안녕하세요!", self._hash("[기쁨] 안녕하세요.")),  # PARSER_PARITY_MISMATCH
        ]
        for raw, expected in cases:
            errs = tts_parity.verify_parity(raw, expected)
            self.assertTrue(errs, "오류 기대")
            for e in errs:
                self.assertIn("code", e)
                self.assertIsInstance(e["code"], str)
                self.assertIn(e["code"], shared, "shared 집합의 정식 code")
                for k in sensitive:
                    self.assertNotIn(k, e, "비민감 payload(전사/경로/전문 금지)")


if __name__ == "__main__":
    unittest.main()
