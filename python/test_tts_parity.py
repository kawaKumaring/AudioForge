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

    def test_crlf_and_lf_are_the_same_script(self):
        """줄 끝 표기는 대본의 내용이 아니다.

        예전에는 CRLF→LF 를 '조용히 뭉개는 것' 으로 보고 차단했지만, CR 이 spoken text 에
        남으면 tokenizer 결과·chunk 계획·실제 발화·시간 예측이 LF 입력과 갈라진다(실측).
        그래서 **공용 parser 입력 경계**에서 정규화하기로 했고, 두 표기는 같은 계획이 된다.
        """
        crlf_hash = self._hash("[기쁨] 첫째 줄.\r\n[슬픔] 둘째 줄.")
        lf_hash = self._hash("[기쁨] 첫째 줄.\n[슬픔] 둘째 줄.")
        cr_hash = self._hash("[기쁨] 첫째 줄.\r[슬픔] 둘째 줄.")
        self.assertEqual(crlf_hash, lf_hash, "CRLF 와 LF 가 다른 계획을 만든다")
        self.assertEqual(cr_hash, lf_hash, "단독 CR 이 다른 계획을 만든다")
        self.assertEqual(tts_parity.verify_parity("[기쁨] 첫째 줄.\n[슬픔] 둘째 줄.", crlf_hash), [])

    def test_real_script_difference_still_blocks_before_model(self):
        """정규화는 줄 끝만 건드린다 — 내용이 다르면 그대로 차단해야 한다."""
        base = self._hash("[기쁨] 첫째 줄.\n[슬픔] 둘째 줄.")
        for other in ("[기쁨] 첫째 줄.\n\n[슬픔] 둘째 줄.",      # 빈 줄이 하나 늘었다
                      "[기쁨] 첫째 줄.\n[기쁨] 둘째 줄.",         # 감정이 바뀌었다
                      "[기쁨] 첫째 줄!\n[슬픔] 둘째 줄."):        # 문장부호가 바뀌었다
            errs = tts_parity.verify_parity(other, base)
            self.assertEqual([e["code"] for e in errs], ["PARSER_PARITY_MISMATCH"],
                             "내용이 다른데 통과했다")

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


class ExpressiveModeArgTest(unittest.TestCase):
    """v3 배선 — verify_parity 3번째 인자의 API 계약.

    (모드 선택·경계·payload 의 전체 계약 스윕은 test_expressive_v3_wiring 에 있다.
     여기서는 '이 모듈의 함수 시그니처와 분기'만 고정한다.)
    """

    def test_third_arg_is_optional_and_defaults_to_legacy(self):
        raw = "[기쁨] 안녕하세요."
        h = tts_grammar.parse_tts_script(raw)["plan"]["full_sha256"]
        self.assertEqual(tts_parity.verify_parity(raw, h), [])
        self.assertEqual(tts_parity.verify_parity(raw, h, None), [])
        self.assertEqual(tts_parity.verify_parity(raw, h, "legacy_v2"), [])

    def test_v3_flag_switches_hash_authority(self):
        import expressive_timeline
        raw = "[기쁨] 안녕하세요."
        v2h = tts_grammar.parse_tts_script(raw)["plan"]["full_sha256"]
        v3h = expressive_timeline.parse_expressive_timeline(
            raw, "expressive_v3")["timeline"]["full_sha256"]
        self.assertNotEqual(v2h, v3h)
        # v3 플래그면 v3 해시만 통과하고, v2 해시는 v3 전용 코드로 막힌다.
        self.assertEqual(tts_parity.verify_parity(raw, v3h, "expressive_v3"), [])
        errs = tts_parity.verify_parity(raw, v2h, "expressive_v3")
        self.assertEqual([e["code"] for e in errs], ["EXPRESSIVE_PARITY_MISMATCH"])

    def test_invalid_flag_is_loud_not_silent_v2(self):
        raw = "[기쁨] 안녕하세요."
        h = tts_grammar.parse_tts_script(raw)["plan"]["full_sha256"]
        # 오타난 플래그는 v2로 조용히 강등되지 않는다(그랬다면 [] 가 나왔을 것).
        errs = tts_parity.verify_parity(raw, h, "expressive_V3")
        self.assertEqual([e["code"] for e in errs], ["EXPRESSIVE_MODE_INVALID"])
        self.assertEqual(errs[0]["raw_type"], "string")

    def test_mode_helpers_agree(self):
        self.assertEqual(tts_parity.parity_mode(None), "legacy_v2")
        self.assertEqual(tts_parity.parity_mode("expressive_v3"), "expressive_v3")
        self.assertTrue(tts_parity.uses_expressive_v3("expressive_v3"))
        for bad in (None, "", "v3", 3, True, {}):
            self.assertFalse(tts_parity.uses_expressive_v3(bad))


if __name__ == "__main__":
    unittest.main()
