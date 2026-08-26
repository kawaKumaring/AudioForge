# -*- coding: utf-8 -*-
"""표현형 운율 v3 계약 테스트 (Python, stdlib only).

검증 축(TS src/shared/expressiveTimeline.test.ts 와 동형):
  A. v2 불변식 — parse_tts_script 출력/해시가 오늘과 완전히 동일(내용 기반 자동 승격 없음)
  B. 모드 선택 — 플래그 부재=legacy_v2, 명시 v3 만 v3
  C. 어휘/lexing — longest-token-first, 대괄호 밖 웃음은 리터럴
  D. 이벤트 계약 — 감정 전이/국소 운율/웃음/쉼/경계 우선순위
  E. 원문 무손실 round-trip
  F. parity — 권위 픽스처(test/fixtures/expressive-timeline-v3.json) 고정 해시/구조 재현
  G. 드리프트 가드 — TS 소스(expressiveTimeline.ts)를 직접 읽어 enum/상수/거울표 대조
  H. 모드 플래그 영속(session/config/metadata 3중 일치)

⚠️ 실패 보고는 case id·필드명만(대사 전문 로그 금지).
"""
import io
import json
import os
import re
import unittest

import expressive_timeline as ex
import tts_grammar as tg

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(REPO_ROOT, "test", "fixtures", "expressive-timeline-v3.json")
V2_PINNED = os.path.join(REPO_ROOT, "src", "shared", "ttsGrammar.parity-hashes.json")
TS_SOURCE = os.path.join(REPO_ROOT, "src", "shared", "expressiveTimeline.ts")

V3 = "expressive_v3"
L2 = "legacy_v2"

# 표현형 토큰을 모두 담은 입력(내용 기반 승격이 없음을 증명하는 데 쓴다).
ALL_TOKEN_INPUT = "다 끝났다!? 정말...... 그렇구나~ [ㅋㅋ] 마지막."
ALL_TOKEN_NO_LAUGH = "다 끝났다!? 정말...... 그렇구나~ 마지막."


def _load(path):
    with io.open(path, encoding="utf-8") as f:
        return json.load(f)


def _ts_source():
    with io.open(TS_SOURCE, encoding="utf-8") as f:
        return f.read()


def _strip_line_comments(block):
    """줄 주석(//...)을 떼어낸다 — 주석 안의 따옴표가 리터럴 추출을 오염시키지 않도록."""
    out = []
    for line in block.split("\n"):
        idx = line.find("//")
        out.append(line if idx < 0 else line[:idx])
    return "\n".join(out)


def _ts_string_array(src, name):
    """`export const NAME = [ 'a', 'b', ] as const` → ['a','b']"""
    m = re.search(r"export const " + name + r"\s*=\s*\[(.*?)\]\s*as const", src, re.S)
    if m is None:
        raise AssertionError("TS 소스에서 %s 배열을 찾지 못함" % name)
    return re.findall(r"'([^']*)'", _strip_line_comments(m.group(1)))


def _ts_number_array(src, name):
    """`export const NAME: readonly number[] = Object.freeze([0, 1, 2])` → [0,1,2]"""
    m = re.search(r"export const " + name + r"[^=]*=\s*Object\.freeze\(\[(.*?)\]\)", src, re.S)
    if m is None:
        raise AssertionError("TS 소스에서 %s 숫자 배열을 찾지 못함" % name)
    return [int(x) for x in re.findall(r"-?\d+", m.group(1))]


def _ts_number(src, name):
    m = re.search(r"export const " + name + r"\s*=\s*(-?\d+)", src)
    if m is None:
        raise AssertionError("TS 소스에서 %s 숫자 상수를 찾지 못함" % name)
    return int(m.group(1))


def _ts_single_quoted(src, name):
    m = re.search(r"export const " + name + r"\s*=\s*'((?:[^'\\]|\\.)*)'", src)
    if m is None:
        raise AssertionError("TS 소스에서 %s 문자열 상수를 찾지 못함" % name)
    return _decode_ts_escapes(m.group(1))


def _decode_ts_escapes(s):
    out = []
    i = 0
    simple = {"t": "\t", "n": "\n", "r": "\r", "f": "\f", "v": "\v", "\\": "\\", "'": "'", '"': '"', "0": "\0"}
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            nxt = s[i + 1]
            if nxt == "u" and i + 2 < len(s) and s[i + 2] == "{":
                end = s.index("}", i + 3)
                out.append(chr(int(s[i + 3:end], 16)))
                i = end + 1
                continue
            if nxt == "u":
                out.append(chr(int(s[i + 2:i + 6], 16)))
                i += 6
                continue
            if nxt == "x":
                out.append(chr(int(s[i + 2:i + 4], 16)))
                i += 4
                continue
            if nxt in simple:
                out.append(simple[nxt])
                i += 2
                continue
        out.append(c)
        i += 1
    return "".join(out)


class ExpressiveV2InvariantTest(unittest.TestCase):
    """A. v2 불변식 — 오늘 합성되는 스크립트의 계획/해시가 바뀌지 않는다."""

    @classmethod
    def setUpClass(cls):
        cls.fx = _load(FIXTURE)
        cls.legacy = cls.fx["legacy_no_migration"]
        cls.pinned = _load(V2_PINNED)

    def test_a1_v2_pinned_hashes_unchanged(self):
        for src, expected in self.pinned.items():
            r = tg.parse_tts_script(src)
            self.assertTrue(r["ok"], "v2 pinned 입력은 성공 파싱")
            self.assertEqual(r["plan"]["full_sha256"], expected)
            self.assertEqual(r["plan"]["parser_version"], 2)

    def test_a2_v2_corpus_hashes_unchanged(self):
        self.assertGreaterEqual(len(self.legacy), 20)
        for row in self.legacy:
            r = tg.parse_tts_script(row["input"])
            self.assertTrue(r["ok"])
            self.assertEqual(r["plan"]["full_sha256"], row["v2_full_sha256"])
            self.assertEqual(r["plan"]["parser_version"], row["v2_parser_version"])
            self.assertEqual(r["plan"]["parser_version"], tg.TTS_PARSER_VERSION)

    def test_a3_expressive_tokens_do_not_change_v2(self):
        # [ㅋㅋ] 는 v2 에서 오늘도 UNKNOWN_TTS_TAG 로 차단된다 → 회귀 없음.
        with_laugh = tg.parse_tts_script(ALL_TOKEN_INPUT)
        self.assertFalse(with_laugh["ok"])
        self.assertIn("UNKNOWN_TTS_TAG", [e["code"] for e in with_laugh["errors"]])
        # 나머지 표현형 토큰은 v2 에서 리터럴 텍스트로 남는다(오늘과 동일).
        r = tg.parse_tts_script(ALL_TOKEN_NO_LAUGH)
        self.assertTrue(r["ok"])
        self.assertEqual(r["plan"]["parser_version"], 2)
        self.assertEqual(len(r["plan"]["segments"]), 1)
        self.assertEqual(r["plan"]["segments"][0]["spoken_text"], ALL_TOKEN_NO_LAUGH)

    def test_a4_expressive_layer_does_not_touch_v2(self):
        for row in self.legacy:
            before = tg.parse_tts_script(row["input"])
            ex.parse_expressive_timeline(row["input"])                  # 기본 legacy_v2
            ex.parse_expressive_timeline(row["input"], mode=V3)
            after = tg.parse_tts_script(row["input"])
            self.assertTrue(before["ok"] and after["ok"])
            self.assertEqual(after["plan"]["full_sha256"], row["v2_full_sha256"])
            self.assertEqual(before["plan"]["full_sha256"], after["plan"]["full_sha256"])


class ExpressiveModeSelectionTest(unittest.TestCase):
    """B. 모드는 호출자가 고른다 — 내용은 절대 고르지 않는다."""

    def test_b1_absent_flag_is_legacy_even_with_every_token(self):
        r = ex.parse_expressive_timeline(ALL_TOKEN_INPUT)
        self.assertEqual(r["mode"], L2)
        self.assertEqual(r["effective_version"], 2)
        self.assertEqual(ex.EXPRESSIVE_DEFAULT_MODE, L2)

        r2 = ex.parse_expressive_timeline(ALL_TOKEN_NO_LAUGH)
        self.assertTrue(r2["ok"])
        tl = r2["timeline"]
        self.assertEqual(tl["mode"], L2)
        self.assertEqual(tl["effective_version"], 2)
        self.assertFalse(tl["expressive_enabled"])
        self.assertFalse(tl["has_expressive_events"])
        self.assertEqual(len(tl["local_prosody"]), 0)
        self.assertEqual(len(tl["laughs"]), 0)
        self.assertEqual(tl["plain_text"], ALL_TOKEN_NO_LAUGH)

    def test_b2_explicit_v3(self):
        r = ex.parse_expressive_timeline(ALL_TOKEN_INPUT, mode=V3)
        self.assertTrue(r["ok"])
        tl = r["timeline"]
        self.assertEqual(tl["mode"], V3)
        self.assertEqual(tl["effective_version"], 3)
        self.assertTrue(tl["expressive_enabled"])
        self.assertGreater(len(tl["local_prosody"]), 0)
        self.assertGreater(len(tl["laughs"]), 0)

    def test_b3_restored_v2_session_stays_v2(self):
        session = {"ttsText": ALL_TOKEN_INPUT}  # 플래그 없음(레거시 세션)
        restored = json.loads(json.dumps(session))
        res = ex.read_expressive_mode(restored)
        self.assertEqual(res["mode"], L2)
        self.assertEqual(res["source"], "absent")
        r = ex.parse_expressive_timeline(restored["ttsText"], mode=res["mode"])
        self.assertEqual(r["effective_version"], 2)
        v2 = tg.parse_tts_script("[기쁨] 안녕하세요.")
        self.assertTrue(v2["ok"])
        self.assertEqual(v2["plan"]["parser_version"], 2)

    def test_b4_mode_version_table(self):
        self.assertEqual(list(ex.EXPRESSIVE_MODES), [L2, V3])
        self.assertEqual(ex.EXPRESSIVE_MODE_TO_VERSION[L2], 2)
        self.assertEqual(ex.EXPRESSIVE_MODE_TO_VERSION[V3], 3)
        self.assertEqual(ex.EXPRESSIVE_CONTRACT_VERSION, 3)
        self.assertEqual(ex.EXPRESSIVE_LEGACY_PLAN_VERSION, 2)


class ExpressiveLexingTest(unittest.TestCase):
    """C. longest-token-first lexing."""

    def _tl(self, src, mode=V3):
        r = ex.parse_expressive_timeline(src, mode=mode)
        self.assertTrue(r["ok"], "parse ok 기대")
        return r["timeline"]

    def test_c1_shock_is_one_token(self):
        for src in ("뭐라고!?", "뭐라고?!"):
            tl = self._tl(src)
            self.assertEqual(len(tl["local_prosody"]), 1)
            self.assertEqual(tl["local_prosody"][0]["kind"], "shock_rise")
            self.assertEqual(tl["local_prosody"][0]["raw_count"], 2)

    def test_c1b_qbang_is_alias_of_bangq(self):
        """'?!' 는 '!?' 의 별칭 — 같은 kind, rawToken 은 원문 그대로 구분."""
        a = self._tl("정말 몰랐어!?")
        b = self._tl("정말 몰랐어?!")
        self.assertEqual(len(a["local_prosody"]), 1)
        self.assertEqual(len(b["local_prosody"]), 1)
        ea, eb = a["local_prosody"][0], b["local_prosody"][0]
        self.assertEqual(ea["kind"], "shock_rise")
        self.assertEqual(eb["kind"], "shock_rise")
        self.assertEqual(ea["kind"], eb["kind"])
        for k in ("strength", "duration_hint", "scope_kind", "raw_count"):
            self.assertEqual(ea[k], eb[k], k)
        self.assertEqual(ea["raw_token"], "!?")
        self.assertEqual(eb["raw_token"], "?!")
        self.assertNotEqual(ea["raw_token"], eb["raw_token"])
        self.assertEqual(ex.reconstruct_source(a), "정말 몰랐어!?")
        self.assertEqual(ex.reconstruct_source(b), "정말 몰랐어?!")

    def test_c2_dot_run_is_one_token(self):
        tl = self._tl("글쎄......")
        self.assertEqual(len(tl["local_prosody"]), 1)
        self.assertEqual(tl["local_prosody"][0]["kind"], "fade_end")
        self.assertEqual(tl["local_prosody"][0]["raw_count"], 6)
        self.assertFalse(tl["local_prosody"][0]["capped"])

    def test_c3_laugh_rule_beats_generic_emotion_tag(self):
        def resolver(n):
            if n == "ㅋㅋ":
                return "happy"
            return tg.TTS_EMOTION_LABEL_TO_ID.get(n)
        r = ex.parse_expressive_timeline("[ㅋㅋ]", mode=V3, resolve_emotion=resolver)
        self.assertTrue(r["ok"])
        tl = r["timeline"]
        self.assertEqual(len(tl["laughs"]), 1)
        self.assertEqual(len(tl["emotion_transitions"]), 0)
        self.assertEqual(tl["laughs"][0]["style"], "chuckle")

    def test_c4_outside_bracket_laugh_is_literal(self):
        src = "웃겨 ㅋㅋㅋㅋ 진짜"
        for mode in ex.EXPRESSIVE_MODES:
            tl = self._tl(src, mode)
            self.assertEqual(len(tl["laughs"]), 0)
            self.assertEqual(tl["plain_text"], src)

    def test_c5_invalid_and_ambiguous_are_structured_errors(self):
        cases = [
            ("[ㅋㅎ]", "AMBIGUOUS_LAUGH_TOKEN"),
            ("[기쁨|살짝] 안녕", "INVALID_EMOTION_MODIFIER"),
            ("[명란] 오타", "UNKNOWN_EXPRESSIVE_TAG"),
            ("[쉼 abc] 안녕", "INVALID_EXPRESSIVE_PAUSE"),
        ]
        for src, code in cases:
            r = ex.parse_expressive_timeline(src, mode=V3)
            self.assertFalse(r["ok"], "case %s 실패 기대" % code)
            self.assertEqual(r["errors"][0]["code"], code)
            for e in r["errors"]:
                self.assertNotIn("spoken_text", e)
                self.assertNotIn("text", e)

    def test_c6_non_control_bracket_is_literalized(self):
        for src in ("[기쁨 안녕하세요]", "[]", "[미종료 태그"):
            for mode in ex.EXPRESSIVE_MODES:
                tl = self._tl(src, mode)
                self.assertEqual(len(tl["emotion_transitions"]), 0)
                self.assertEqual(len(tl["explicit_pauses"]), 0)


class ExpressiveEventContractTest(unittest.TestCase):
    """D. 이벤트 계약."""

    def _tl(self, src, mode=V3):
        r = ex.parse_expressive_timeline(src, mode=mode)
        self.assertTrue(r["ok"], "parse ok 기대")
        return r["timeline"]

    def test_d1_emotion_tag_is_transition_not_boundary(self):
        tl = self._tl("[기쁨] 안녕 [슬픔] 잘가")
        self.assertEqual(len(tl["emotion_transitions"]), 2)
        for e in tl["emotion_transitions"]:
            self.assertEqual(e["transition_mode"], "blend")
            self.assertFalse(e["explicit_mode"])
            self.assertEqual(e["extra_pause_ms"], 0)
            self.assertEqual(e["extra_pause_ms"], ex.EMOTION_TRANSITION_EXTRA_PAUSE_MS)
            self.assertFalse(e["is_chunk_boundary"])
            self.assertGreater(e["transition_duration_hint"], 0)
        self.assertFalse(any(b["kind"] == "emotionTransition" for b in tl["boundaries"]))
        self.assertFalse(ex.SENTENCE_GAP_AND_EMOTION_PAUSE_MAY_SUM)

    def test_d2_immediate_only_when_requested(self):
        self.assertEqual(self._tl("[기쁨] 안녕")["emotion_transitions"][0]["transition_mode"], "blend")
        imm = self._tl("[기쁨|즉시] 안녕")["emotion_transitions"][0]
        self.assertEqual(imm["transition_mode"], "immediate")
        self.assertTrue(imm["explicit_mode"])
        self.assertEqual(imm["transition_duration_hint"], 0)
        self.assertEqual(imm["extra_pause_ms"], 0)
        self.assertEqual(
            self._tl("[happy|immediate] hi")["emotion_transitions"][0]["transition_mode"], "immediate")

    def test_d3_emotion_offset_dual(self):
        tl = self._tl("\U0001F389[기쁨] 안녕")
        e = tl["emotion_transitions"][0]
        self.assertEqual(e["source_offset"]["codepoint"], 1)
        self.assertEqual(e["source_offset"]["utf16"], 2)
        self.assertNotEqual(e["source_offset"]["utf16"], e["source_offset"]["codepoint"])

    def test_d4_single_dot_is_weakest(self):
        one = self._tl("안녕하세요.")["local_prosody"][0]
        three = self._tl("안녕하세요...")["local_prosody"][0]
        bang = self._tl("안녕하세요!")["local_prosody"][0]
        self.assertEqual(one["kind"], "firm_end")
        self.assertEqual(one["strength"], ex.FIRM_END_STRENGTH)
        self.assertLess(one["strength"], three["strength"])
        self.assertLess(one["strength"], bang["strength"])
        self.assertLess(one["duration_hint"], three["duration_hint"])
        self.assertNotEqual(one["kind"], "emphasis")

    def test_d5_dot_run_scale_and_cap_without_text_change(self):
        cases = [("글쎄.", 1, False), ("글쎄..", 2, False), ("글쎄...", 3, False),
                 ("글쎄......", ex.DOT_RUN_MAX_COUNT, False), ("글쎄..........", 10, True)]
        for src, raw_count, capped in cases:
            e = self._tl(src)["local_prosody"][0]
            self.assertEqual(e["raw_count"], raw_count)
            self.assertEqual(e["capped"], capped)
            self.assertEqual(e["effective_count"], min(raw_count, ex.DOT_RUN_MAX_COUNT))
            self.assertEqual(e["raw_token"], src[2:], "텍스트는 원문 그대로")
        mx = self._tl("글쎄......")["local_prosody"][0]
        over = self._tl("글쎄..........")["local_prosody"][0]
        self.assertEqual(over["strength"], mx["strength"])
        self.assertEqual(over["duration_hint"], mx["duration_hint"])
        self.assertEqual(len(over["raw_token"]), 10)

    def test_d6_bang_latter_half_question_final_word(self):
        bang = self._tl("오늘 날씨 좋다!")["local_prosody"][0]
        self.assertEqual(bang["kind"], "emphasis")
        self.assertEqual(bang["scope_kind"], "latter_half")
        self.assertGreater(bang["scope_range"]["start_codepoint"], bang["host_range"]["start_codepoint"])
        q = self._tl("오늘 날씨 좋다?")["local_prosody"][0]
        self.assertEqual(q["kind"], "question_rise")
        self.assertEqual(q["scope_kind"], "final_word")
        self.assertEqual(q["scope_range"]["end_codepoint"] - q["scope_range"]["start_codepoint"], 2)

    def test_d7_local_prosody_is_not_a_chunk_boundary(self):
        tl = self._tl("안녕하세요 반갑습니다.")
        e = tl["local_prosody"][0]
        self.assertEqual(e["scope_kind"], "final_syllables")
        self.assertEqual(e["scope_range"]["end_codepoint"] - e["scope_range"]["start_codepoint"],
                         ex.LOCAL_PROSODY_TAIL_SYLLABLES)
        self.assertFalse(e["is_chunk_boundary"])
        self.assertEqual(e["extra_pause_ms"], 0)
        self.assertEqual([b["kind"] for b in tl["boundaries"]], ["finalTail"])

    def test_d8_emotion_tag_does_not_break_prosody_host(self):
        e = self._tl("안녕[기쁨]하세요.")["local_prosody"][0]
        self.assertEqual(e["host_range"]["start_codepoint"], 0)

    def test_d9_vowel_extend_three_way_classification(self):
        # 1) 종성 없음 → open_vowel
        e = self._tl("그래도~")["local_prosody"][0]
        self.assertEqual(e["kind"], "vowel_extend")
        self.assertEqual(e["scope_kind"], "final_vowel")
        self.assertEqual(e["vowel_extend"]["classification"], "open_vowel")
        self.assertEqual(e["vowel_extend"]["target_vowel"], "ㅗ")
        self.assertIsNone(e["vowel_extend"]["final_consonant"])
        self.assertIsNone(e["vowel_extend"]["undeterminable_reason"])

        # 2) 종성 ㅇ/ㄴ/ㅁ/ㄹ → sustainable_final (경고 없음)
        for src, jamo in (("안녕~", "ㅇ"), ("그런~", "ㄴ"), ("사랑함~", "ㅁ"), ("그럴~", "ㄹ")):
            tl = self._tl(src)
            ve = tl["local_prosody"][0]["vowel_extend"]
            self.assertEqual(ve["classification"], "sustainable_final", src)
            self.assertEqual(ve["final_consonant"], jamo, src)
            self.assertIn(jamo, ex.SUSTAINABLE_FINAL_JAMO)
            self.assertEqual(len(tl["diagnostics"]), 0, "%s: sustainable_final 은 경고하지 않는다" % src)

        # 3) 그 밖의 종성 → non_sustainable_final + 경고
        tl = self._tl("밥~")
        ve = tl["local_prosody"][0]["vowel_extend"]
        self.assertEqual(ve["classification"], "non_sustainable_final")
        self.assertEqual(ve["final_consonant"], "ㅂ")
        self.assertTrue(any(d["code"] == "VOWEL_EXTEND_NON_SUSTAINABLE_FINAL" and d["severity"] == "warning"
                            for d in tl["diagnostics"]))

        # 겹받침은 자모 표기 그대로 분류(음운 규칙 미적용 — 알려진 한계)
        ve = self._tl("삶~")["local_prosody"][0]["vowel_extend"]
        self.assertEqual(ve["classification"], "non_sustainable_final")
        self.assertEqual(ve["final_consonant"], "ㄻ")

        # 4) 확정 불가
        ve = self._tl("你好~")["local_prosody"][0]["vowel_extend"]
        self.assertEqual(ve["classification"], "undeterminable")
        self.assertEqual(ve["undeterminable_reason"], "unsupported_script")
        ve = self._tl("~시작")["local_prosody"][0]["vowel_extend"]
        self.assertEqual(ve["classification"], "undeterminable")
        self.assertEqual(ve["undeterminable_reason"], "no_preceding_text")

        # 라틴
        self.assertEqual(self._tl("hello~")["local_prosody"][0]["vowel_extend"]["classification"], "open_vowel")
        self.assertEqual(self._tl("listen~")["local_prosody"][0]["vowel_extend"]["classification"], "sustainable_final")
        self.assertEqual(self._tl("cat~")["local_prosody"][0]["vowel_extend"]["classification"], "non_sustainable_final")

        # 문법적으로는 모두 수용된다
        for src in ("그래도~", "안녕~", "밥~", "你好~", "~시작", "cat~"):
            r = ex.parse_expressive_timeline(src, mode=V3)
            self.assertTrue(r["ok"], "%s: 문법적으로 수용" % src)
            self.assertEqual(len(r["timeline"]["local_prosody"]), 1, src)

    def test_d9b_language_layer_does_not_assert_acoustic_quality(self):
        self.assertFalse(ex.LANGUAGE_LAYER_ASSERTS_ACOUSTIC_QUALITY)
        self.assertFalse(ex.SUSTAINABLE_FINAL_IS_ACOUSTICALLY_VERIFIED)
        for src in ("그래도~", "안녕~", "밥~", "你好~", "~시작"):
            ve = self._tl(src)["local_prosody"][0]["vowel_extend"]
            self.assertIsNotNone(ve)
            self.assertNotIn("supported", ve, src)
            self.assertNotIn("degraded", ve, src)
            self.assertNotIn("degraded_reason", ve, src)
            self.assertEqual(sorted(ve.keys()),
                             ["classification", "final_consonant", "target_vowel", "undeterminable_reason"])
            self.assertIn(ve["classification"], ex.VOWEL_EXTEND_CLASSES)
        self.assertEqual(list(ex.VOWEL_EXTEND_FORBIDDEN_TECHNIQUES),
                         ["duplicate_final_consonant", "repeat_final_consonant"])
        self.assertEqual(list(ex.VOWEL_EXTEND_CLASSES),
                         ["open_vowel", "sustainable_final", "non_sustainable_final", "undeterminable"])
        self.assertEqual(list(ex.VOWEL_EXTEND_UNDETERMINABLE_REASONS),
                         ["unsupported_script", "no_preceding_text", "no_preceding_vowel"])
        self.assertEqual(ex.SUSTAINABLE_FINAL_JAMO, "ㅇㄴㅁㄹ")
        self.assertEqual(ex.SUSTAINABLE_FINAL_LATIN, "nmlr")

    def test_d10_laugh_styles_repeat_cap_position(self):
        styles = [("[ㅋ]", "chuckle", 1), ("[ㅋㅋ]", "chuckle", 2), ("[ㅋㅋㅋㅋ]", "chuckle", 4),
                  ("[ㅎ]", "breathy", 1), ("[ㅎㅎㅎㅎ]", "breathy", 4),
                  ("[헤헤]", "bashful", 2), ("[헤헷]", "bashful", 2),
                  ("[호호]", "open", 2), ("[호홋]", "open", 2),
                  ("[히히]", "high_giggle", 2), ("[히히히]", "high_giggle", 3)]
        for src, style, repeat in styles:
            tl = self._tl(src)
            self.assertEqual(len(tl["laughs"]), 1, src)
            self.assertEqual(tl["laughs"][0]["style"], style, src)
            self.assertEqual(tl["laughs"][0]["raw_repeat_count"], repeat, src)
            self.assertFalse(tl["laughs"][0]["is_chunk_boundary"])
        l2 = self._tl("[ㅋㅋ]")["laughs"][0]
        l4 = self._tl("[ㅋㅋㅋㅋ]")["laughs"][0]
        self.assertGreater(l4["intensity"], l2["intensity"])
        self.assertGreater(l4["brightness"], l2["brightness"])
        self.assertGreater(l4["duration_hint"], l2["duration_hint"])
        long_src = "[" + ("ㅋ" * 12) + "]"
        lg = self._tl(long_src)["laughs"][0]
        self.assertEqual(lg["raw_repeat_count"], 12)
        self.assertEqual(lg["effective_repeat_count"], ex.LAUGH_REPEAT_MAX_COUNT)
        self.assertTrue(lg["capped"])
        self.assertEqual(lg["raw_token"], long_src)
        self.assertEqual(self._tl("안녕 [ㅋㅋ] 반가워")["laughs"][0]["position"], "inline")
        self.assertEqual(self._tl("그래 [ㅋㅋ]")["laughs"][0]["position"], "trailing")
        self.assertEqual(self._tl("[ㅋㅋ] 그래")["laughs"][0]["position"], "leading")
        self.assertEqual(self._tl("[ㅋㅋ]")["laughs"][0]["position"], "standalone")

    def test_d11_boundary_priority_and_single_final_tail(self):
        tl = self._tl("첫 줄.[쉼 0.8]\n둘째 줄.")
        non_tail = [b for b in tl["boundaries"] if b["kind"] != "finalTail"]
        self.assertEqual(len(non_tail), 1)
        self.assertEqual(non_tail[0]["kind"], "explicitPause")
        self.assertEqual(non_tail[0]["suppressed"], ["sentenceGap"])
        self.assertEqual(non_tail[0]["pause_ms"], 800)
        self.assertTrue(ex.SENTENCE_GAP_SUPPRESSED_BY_EXPLICIT_PAUSE)
        tails = [b for b in tl["boundaries"] if b["kind"] == "finalTail"]
        self.assertEqual(len(tails), 1)
        self.assertEqual(tl["boundaries"][-1]["kind"], "finalTail")
        self.assertTrue(ex.FINAL_TAIL_APPLIES_ONCE_AT_FILE_END)

        tl2 = self._tl("첫 줄.\n둘째 줄.")
        self.assertEqual([b["kind"] for b in tl2["boundaries"]], ["sentenceGap", "finalTail"])
        self.assertIsNone(tl2["boundaries"][0]["pause_ms"])

    def test_d12_priority_list(self):
        self.assertEqual(list(ex.EXPRESSIVE_EVENT_PRIORITY), [
            "emotionTransition", "localProsody", "nonverbalLaugh",
            "explicitPause", "sentenceGap", "finalTail",
        ])


class ExpressiveRoundTripTest(unittest.TestCase):
    """E. 원문 무손실."""

    @classmethod
    def setUpClass(cls):
        cls.fx = _load(FIXTURE)

    def test_e1_all_vectors_round_trip(self):
        for v in self.fx["vectors"]:
            r = ex.parse_expressive_timeline(v["input"], mode=v["mode"])
            self.assertTrue(r["ok"], "id=%s" % v["id"])
            rt = ex.verify_round_trip(v["input"], r["timeline"])
            self.assertTrue(rt["ok"], "id=%s round-trip" % v["id"])
            self.assertTrue(rt["contiguous"], "id=%s range 연속성" % v["id"])
            self.assertEqual(ex.reconstruct_source(r["timeline"]), v["input"], "id=%s" % v["id"])

    def test_e2_every_codepoint_is_covered(self):
        src = "[기쁨] 안녕하세요!? [쉼 0.5] 반가워요... [ㅋㅋ]\n[슬픔] 잘가~"
        r = ex.parse_expressive_timeline(src, mode=V3)
        self.assertTrue(r["ok"])
        tl = r["timeline"]
        self.assertEqual("".join(nd["raw_token"] for nd in tl["nodes"]), src)
        covered = set()
        for nd in tl["nodes"]:
            for i in range(nd["range"]["start_codepoint"], nd["range"]["end_codepoint"]):
                covered.add(i)
        self.assertEqual(len(covered), len(list(src)))

    def test_e3_verbatim_vs_plain(self):
        r = ex.parse_expressive_timeline("안녕하세요!", mode=V3)
        self.assertTrue(r["ok"])
        self.assertEqual(r["timeline"]["verbatim_text"], "안녕하세요!")
        self.assertEqual(r["timeline"]["plain_text"], "안녕하세요")

    def test_e4_text_conserved_against_v2_layer(self):
        """v2 발화 텍스트와 표현형 verbatim_text 가 (공백 제외) 일치 — 레이어 간 텍스트 누락 없음."""
        def no_ws(x):
            return "".join(c for c in x if c not in ex.EXPRESSIVE_WHITESPACE_CHARS)
        for row in self.fx["legacy_no_migration"]:
            v2 = tg.parse_tts_script(row["input"])
            self.assertTrue(v2["ok"])
            v2_text = no_ws("".join(s["spoken_text"] for s in v2["plan"]["segments"]))
            for mode in ex.EXPRESSIVE_MODES:
                r = ex.parse_expressive_timeline(row["input"], mode=mode)
                self.assertTrue(r["ok"], "mode=%s" % mode)
                self.assertEqual(no_ws(r["timeline"]["verbatim_text"]), v2_text,
                                 "mode=%s 텍스트 보존" % mode)


class ExpressiveFixtureParityTest(unittest.TestCase):
    """F. 권위 픽스처 재현(= TS 동형)."""

    @classmethod
    def setUpClass(cls):
        cls.fx = _load(FIXTURE)
        cls.meta = cls.fx["_meta"]

    def test_f_vectors(self):
        for v in self.fx["vectors"]:
            r = ex.parse_expressive_timeline(v["input"], mode=v["mode"])
            self.assertTrue(r["ok"], "id=%s parse ok" % v["id"])
            tl = r["timeline"]
            self.assertEqual(tl["full_sha256"], v["full_sha256"], "id=%s full sha256" % v["id"])
            self.assertEqual(tl["summary"]["sha8"], v["sha8"], "id=%s sha8" % v["id"])
            exp = v["expect"]
            for k, want in exp["summary"].items():
                self.assertEqual(tl["summary"][k], want, "id=%s summary.%s" % (v["id"], k))
            self.assertEqual(tl["expressive_enabled"], exp["expressive_enabled"], "id=%s" % v["id"])
            self.assertEqual(tl["has_expressive_events"], exp["has_expressive_events"], "id=%s" % v["id"])
            self.assertEqual(tl["plain_text"], exp["plain_text"], "id=%s plain_text" % v["id"])
            self.assertEqual(tl["verbatim_text"], exp["verbatim_text"], "id=%s verbatim_text" % v["id"])

            self.assertEqual(len(tl["emotion_transitions"]), len(exp["emotion_transitions"]), v["id"])
            for i, e in enumerate(exp["emotion_transitions"]):
                g = tl["emotion_transitions"][i]
                for k in ("target_emotion", "transition_mode", "transition_strength",
                          "transition_duration_hint", "extra_pause_ms", "is_chunk_boundary",
                          "explicit_mode", "source_offset"):
                    self.assertEqual(g[k], e[k], "id=%s emotion#%d %s" % (v["id"], i, k))

            self.assertEqual(len(tl["local_prosody"]), len(exp["local_prosody"]), v["id"])
            for i, e in enumerate(exp["local_prosody"]):
                g = tl["local_prosody"][i]
                for k in ("kind", "raw_count", "effective_count", "capped", "strength", "duration_hint",
                          "scope_kind", "scope_range", "host_range", "is_chunk_boundary",
                          "extra_pause_ms", "raw_token", "vowel_extend"):
                    self.assertEqual(g[k], e[k], "id=%s prosody#%d %s" % (v["id"], i, k))

            self.assertEqual(len(tl["laughs"]), len(exp["laughs"]), v["id"])
            for i, e in enumerate(exp["laughs"]):
                g = tl["laughs"][i]
                for k in ("style", "intensity", "brightness", "duration_hint", "position",
                          "raw_repeat_count", "effective_repeat_count", "capped",
                          "is_chunk_boundary", "raw_token"):
                    self.assertEqual(g[k], e[k], "id=%s laugh#%d %s" % (v["id"], i, k))

            self.assertEqual([p["pause_ms"] for p in tl["explicit_pauses"]],
                             [p["pause_ms"] for p in exp["explicit_pauses"]], v["id"])
            self.assertEqual(
                [{"kind": b["kind"], "candidates": b["candidates"],
                  "suppressed": b["suppressed"], "pause_ms": b["pause_ms"]} for b in tl["boundaries"]],
                exp["boundaries"], "id=%s boundaries" % v["id"])
            self.assertEqual(
                [{"code": d["code"], "severity": d["severity"], "reason": d.get("reason")}
                 for d in tl["diagnostics"]],
                [{"code": d["code"], "severity": d["severity"], "reason": d.get("reason")}
                 for d in exp["diagnostics"]], "id=%s diagnostics" % v["id"])

            # 결정성
            r2 = ex.parse_expressive_timeline(v["input"], mode=v["mode"])
            self.assertEqual(r2["timeline"]["full_sha256"], v["full_sha256"])

    def test_f_errors(self):
        for c in self.fx["errors"]:
            r = ex.parse_expressive_timeline(c["input"], mode=c["mode"])
            self.assertFalse(r["ok"], "id=%s 실패 기대" % c["id"])
            self.assertEqual([e["code"] for e in r["errors"]], c["codes"], "id=%s codes" % c["id"])
            self.assertEqual(r["effective_version"], c["effective_version"], "id=%s" % c["id"])
            self.assertEqual(r["mode"], c["mode"])

    def test_f_meta_matches_python_contract(self):
        m = self.meta
        self.assertEqual(m["contract_version"], ex.EXPRESSIVE_CONTRACT_VERSION)
        self.assertEqual(m["legacy_plan_version"], ex.EXPRESSIVE_LEGACY_PLAN_VERSION)
        self.assertEqual(m["modes"], list(ex.EXPRESSIVE_MODES))
        self.assertEqual(m["default_mode"], ex.EXPRESSIVE_DEFAULT_MODE)
        self.assertEqual(m["mode_to_version"], ex.EXPRESSIVE_MODE_TO_VERSION)
        self.assertEqual(m["mode_field"], ex.EXPRESSIVE_MODE_FIELD)
        self.assertEqual(m["node_kinds"], list(ex.EXPRESSIVE_NODE_KINDS))
        self.assertEqual(m["local_prosody_kinds"], list(ex.LOCAL_PROSODY_KINDS))
        self.assertEqual(m["laugh_styles"], list(ex.LAUGH_STYLES))
        self.assertEqual(m["error_codes"], list(ex.EXPRESSIVE_ERROR_CODES))
        self.assertEqual(m["event_priority"], list(ex.EXPRESSIVE_EVENT_PRIORITY))
        self.assertEqual(m["counts"]["dot_run"], [ex.DOT_RUN_MIN_COUNT, ex.DOT_RUN_MAX_COUNT])
        self.assertEqual(m["counts"]["laugh_repeat"],
                         [ex.LAUGH_REPEAT_MIN_COUNT, ex.LAUGH_REPEAT_MAX_COUNT])


class ExpressiveTsSourceDriftTest(unittest.TestCase):
    """G. TS 소스를 직접 읽어 enum/상수/거울표를 대조(repo 의 기존 parity 방식과 동일)."""

    @classmethod
    def setUpClass(cls):
        cls.src = _ts_source()

    def test_g1_enum_sets_match(self):
        pairs = [
            ("EXPRESSIVE_MODES", ex.EXPRESSIVE_MODES),
            ("EXPRESSIVE_NODE_KINDS", ex.EXPRESSIVE_NODE_KINDS),
            ("EMOTION_TRANSITION_MODES", ex.EMOTION_TRANSITION_MODES),
            ("LOCAL_PROSODY_KINDS", ex.LOCAL_PROSODY_KINDS),
            ("PROSODY_SCOPE_KINDS", ex.PROSODY_SCOPE_KINDS),
            ("LAUGH_STYLES", ex.LAUGH_STYLES),
            ("LAUGH_POSITIONS", ex.LAUGH_POSITIONS),
            ("VOWEL_EXTEND_CLASSES", ex.VOWEL_EXTEND_CLASSES),
            ("VOWEL_EXTEND_UNDETERMINABLE_REASONS", ex.VOWEL_EXTEND_UNDETERMINABLE_REASONS),
            ("VOWEL_EXTEND_FORBIDDEN_TECHNIQUES", ex.VOWEL_EXTEND_FORBIDDEN_TECHNIQUES),
            ("EXPRESSIVE_BOUNDARY_KINDS", ex.EXPRESSIVE_BOUNDARY_KINDS),
            ("EXPRESSIVE_EVENT_PRIORITY", ex.EXPRESSIVE_EVENT_PRIORITY),
            ("EXPRESSIVE_ERROR_CODES", ex.EXPRESSIVE_ERROR_CODES),
            ("EXPRESSIVE_DIAGNOSTIC_SEVERITIES", ex.EXPRESSIVE_DIAGNOSTIC_SEVERITIES),
            ("EXPRESSIVE_MODE_CARRIERS", ex.EXPRESSIVE_MODE_CARRIERS),
            ("EXPRESSIVE_MODE_CARRIER_PAIRS", ex.EXPRESSIVE_MODE_CARRIER_PAIRS),
            ("EXPRESSIVE_MODE_SOURCES", ex.EXPRESSIVE_MODE_SOURCES),
        ]
        for name, py_val in pairs:
            self.assertEqual(_ts_string_array(self.src, name), list(py_val), "enum drift: %s" % name)

    def test_g2_numeric_constants_match(self):
        names = [
            "EXPRESSIVE_CONTRACT_VERSION", "EXPRESSIVE_LEGACY_PLAN_VERSION",
            "DOT_RUN_MIN_COUNT", "DOT_RUN_MAX_COUNT",
            "BANG_RUN_MIN_COUNT", "BANG_RUN_MAX_COUNT",
            "QUESTION_RUN_MIN_COUNT", "QUESTION_RUN_MAX_COUNT",
            "SHOCK_RUN_MIN_COUNT", "SHOCK_RUN_MAX_COUNT",
            "TILDE_RUN_MIN_COUNT", "TILDE_RUN_MAX_COUNT",
            "LAUGH_REPEAT_MIN_COUNT", "LAUGH_REPEAT_MAX_COUNT",
            "LOCAL_PROSODY_TAIL_SYLLABLES",
            "FIRM_END_STRENGTH", "FIRM_END_DURATION_MS",
            "EMOTION_TRANSITION_DEFAULT_STRENGTH", "EMOTION_BLEND_DURATION_MS",
            "EMOTION_IMMEDIATE_DURATION_MS", "EMOTION_TRANSITION_EXTRA_PAUSE_MS",
        ]
        for name in names:
            self.assertEqual(_ts_number(self.src, name), getattr(ex, name), "const drift: %s" % name)

    def test_g3_numeric_tables_match(self):
        names = [
            "FADE_END_STRENGTH_BY_COUNT", "FADE_END_DURATION_MS_BY_COUNT",
            "EMPHASIS_STRENGTH_BY_COUNT", "EMPHASIS_DURATION_MS_BY_COUNT",
            "QUESTION_RISE_STRENGTH_BY_COUNT", "QUESTION_RISE_DURATION_MS_BY_COUNT",
            "SHOCK_RISE_STRENGTH_BY_COUNT", "SHOCK_RISE_DURATION_MS_BY_COUNT",
            "VOWEL_EXTEND_STRENGTH_BY_COUNT", "VOWEL_EXTEND_DURATION_MS_BY_COUNT",
            "LAUGH_INTENSITY_BY_REPEAT", "LAUGH_BRIGHTNESS_BY_REPEAT", "LAUGH_DURATION_MS_BY_REPEAT",
        ]
        for name in names:
            self.assertEqual(_ts_number_array(self.src, name), list(getattr(ex, name)),
                             "table drift: %s" % name)

    def test_g4_token_char_sets_match(self):
        for name in ("DOT_RUN_CHARS", "BANG_RUN_CHARS", "QUESTION_RUN_CHARS",
                     "TILDE_RUN_CHARS", "LAUGH_TOKEN_CHARS", "EMOTION_MODIFIER_SEPARATOR",
                     "SUSTAINABLE_FINAL_JAMO", "SUSTAINABLE_FINAL_LATIN"):
            self.assertEqual(_ts_single_quoted(self.src, name), getattr(ex, name),
                             "char set drift: %s" % name)

    def test_g5_whitespace_set_matches(self):
        m = re.search(r"export const EXPRESSIVE_WHITESPACE_CHARS\s*=\s*\n?\s*'((?:[^'\\]|\\.)*)'",
                      self.src, re.S)
        self.assertIsNotNone(m, "TS 소스에서 EXPRESSIVE_WHITESPACE_CHARS 를 찾지 못함")
        ts_ws = _decode_ts_escapes(m.group(1))
        self.assertEqual([ord(c) for c in ts_ws], [ord(c) for c in ex.EXPRESSIVE_WHITESPACE_CHARS])

    def test_g6_emotion_mirror_matches_tts_grammar(self):
        """TS 의 거울표(자립 모듈이라 값 복사)가 tts_grammar 원본과 일치해야 한다."""
        m = re.search(r"export const EXPRESSIVE_EMOTION_LABEL_TO_ID[^=]*=\s*Object\.freeze\(\{(.*?)\n\}\)",
                      self.src, re.S)
        self.assertIsNotNone(m, "TS 소스에서 EXPRESSIVE_EMOTION_LABEL_TO_ID 를 찾지 못함")
        pairs = re.findall(r"'([^']*)'\s*:\s*'([^']*)'", m.group(1))
        ts_table = dict(pairs)
        self.assertEqual(len(pairs), len(ts_table), "TS 거울표에 중복 key 없음")
        self.assertEqual(ts_table, tg.TTS_EMOTION_LABEL_TO_ID, "감정표 드리프트(TS 거울 vs tts_grammar)")
        self.assertEqual(ts_table, ex.EXPRESSIVE_EMOTION_LABEL_TO_ID)

    def test_g7_pause_names_mirror(self):
        m = re.search(r"export const EXPRESSIVE_PAUSE_NAMES[^=]*=\s*new Set\(\[(.*?)\]\)", self.src, re.S)
        self.assertIsNotNone(m)
        names = set(re.findall(r"'([^']*)'", m.group(1)))
        self.assertEqual(names, set(tg.TTS_PAUSE_NAMES))
        self.assertEqual(names, set(ex.EXPRESSIVE_PAUSE_NAMES))

    def test_g8_mode_field_and_default(self):
        self.assertEqual(_ts_single_quoted(self.src, "EXPRESSIVE_MODE_FIELD"), ex.EXPRESSIVE_MODE_FIELD)
        m = re.search(r"export const EXPRESSIVE_DEFAULT_MODE[^=]*=\s*'([^']*)'", self.src)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), ex.EXPRESSIVE_DEFAULT_MODE)
        self.assertEqual(m.group(1), "legacy_v2")

    def test_g9_legacy_version_matches_tts_grammar(self):
        self.assertEqual(ex.EXPRESSIVE_LEGACY_PLAN_VERSION, tg.TTS_PARSER_VERSION)

    def test_g10_ts_module_has_no_runtime_cross_import(self):
        """자립 모듈 불변식 — 런타임 import 가 들어오면 node --test 가 해석하지 못한다."""
        self.assertNotRegex(self.src, r"(?m)^import\s+\{[^}]*\}\s+from")

    def test_g11_classify_vowel_extend_units(self):
        def c(ch):
            return ex.classify_vowel_extend(ch)
        self.assertEqual(c("가"), {"classification": "open_vowel", "target_vowel": "ㅏ",
                                  "final_consonant": None, "undeterminable_reason": None})
        self.assertEqual(c("강"), {"classification": "sustainable_final", "target_vowel": "ㅏ",
                                  "final_consonant": "ㅇ", "undeterminable_reason": None})
        self.assertEqual(c("간"), {"classification": "sustainable_final", "target_vowel": "ㅏ",
                                  "final_consonant": "ㄴ", "undeterminable_reason": None})
        self.assertEqual(c("감"), {"classification": "sustainable_final", "target_vowel": "ㅏ",
                                  "final_consonant": "ㅁ", "undeterminable_reason": None})
        self.assertEqual(c("갈"), {"classification": "sustainable_final", "target_vowel": "ㅏ",
                                  "final_consonant": "ㄹ", "undeterminable_reason": None})
        self.assertEqual(c("갑"), {"classification": "non_sustainable_final", "target_vowel": "ㅏ",
                                  "final_consonant": "ㅂ", "undeterminable_reason": None})
        self.assertEqual(c("a"), {"classification": "open_vowel", "target_vowel": "a",
                                  "final_consonant": None, "undeterminable_reason": None})
        self.assertEqual(c("n"), {"classification": "sustainable_final", "target_vowel": None,
                                  "final_consonant": "n", "undeterminable_reason": None})
        self.assertEqual(c("b"), {"classification": "non_sustainable_final", "target_vowel": None,
                                  "final_consonant": "b", "undeterminable_reason": None})
        self.assertEqual(c("い"), {"classification": "open_vowel", "target_vowel": "i",
                                  "final_consonant": None, "undeterminable_reason": None})
        self.assertEqual(c("好"), {"classification": "undeterminable", "target_vowel": None,
                                  "final_consonant": None, "undeterminable_reason": "unsupported_script"})
        self.assertEqual(c("1"), {"classification": "undeterminable", "target_vowel": None,
                                  "final_consonant": None, "undeterminable_reason": "no_preceding_vowel"})

    def test_g12_sha256_known_vectors(self):
        self.assertEqual(ex.sha256_hex_of_string("abc"),
                         "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        self.assertEqual(ex.sha256_hex_of_string(""),
                         "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")


class ExpressiveModePersistenceTest(unittest.TestCase):
    """H. 모드 플래그 영속(session/config/metadata 3중 일치)."""

    def test_h1_same_field_name_and_type(self):
        self.assertEqual(ex.EXPRESSIVE_MODE_FIELD, "ttsExpressiveMode")
        self.assertEqual(list(ex.EXPRESSIVE_MODE_CARRIERS), ["session", "config", "metadata"])
        for carrier in (ex.write_expressive_mode({}, V3) for _ in range(3)):
            self.assertIn(ex.EXPRESSIVE_MODE_FIELD, carrier)
            self.assertIsInstance(carrier[ex.EXPRESSIVE_MODE_FIELD], str)

    def test_h2_absent_field_is_legacy(self):
        for carrier in (None, {}, {"other": 1}):
            r = ex.read_expressive_mode(carrier)
            self.assertEqual(r["mode"], L2)
            self.assertEqual(r["source"], "absent")
            self.assertTrue(r["valid"])
            self.assertIsNone(r["error_code"])

    def test_h3_invalid_values_are_loud(self):
        for bad in ("", "v3", "expressive", True, False, 3, {}, []):
            r = ex.resolve_expressive_mode(bad)
            self.assertFalse(r["valid"], "%r 는 invalid" % (bad,))
            self.assertEqual(r["source"], "invalid")
            self.assertEqual(r["error_code"], "EXPRESSIVE_MODE_INVALID")
            self.assertEqual(r["mode"], L2, "안전한 폴백은 legacy")
        for good in (L2, V3):
            r = ex.resolve_expressive_mode(good)
            self.assertTrue(r["valid"])
            self.assertEqual(r["source"], "explicit")
            self.assertEqual(r["mode"], good)

    def test_h4_session_round_trip(self):
        for mode in ex.EXPRESSIVE_MODES:
            session = ex.write_expressive_mode({"ttsText": "안녕", "ttsSpeed": 1}, mode)
            restored = json.loads(json.dumps(session))
            r = ex.read_expressive_mode(restored)
            self.assertEqual(r["mode"], mode)
            self.assertEqual(r["source"], "explicit")
            retried = dict(restored)
            retried.update({"ttsText": "다시", "ttsSpeed": 1.2})
            self.assertEqual(ex.read_expressive_mode(retried)["mode"], mode)

    def test_h5_preset_cannot_change_flag(self):
        self.assertFalse(ex.EXPRESSIVE_MODE_PRESET_MAY_CHANGE)
        base = ex.write_expressive_mode({"ttsSpeed": 1}, V3)
        preset = {"ttsSpeed": 1.4, ex.EXPRESSIVE_MODE_FIELD: L2}
        merged = ex.apply_preset_preserving_expressive_mode(base, preset)
        self.assertEqual(merged[ex.EXPRESSIVE_MODE_FIELD], V3)
        self.assertEqual(merged["ttsSpeed"], 1.4)
        merged2 = ex.apply_preset_preserving_expressive_mode({"ttsSpeed": 1}, preset)
        self.assertNotIn(ex.EXPRESSIVE_MODE_FIELD, merged2)
        self.assertEqual(ex.read_expressive_mode(merged2)["mode"], L2)

    def test_h6_carrier_agreement(self):
        v3 = ex.write_expressive_mode({}, V3)
        v2 = ex.write_expressive_mode({}, L2)

        ok_all = ex.assert_expressive_mode_carriers(v3, v3, v3)
        self.assertTrue(ok_all["ok"])
        self.assertEqual(ok_all["mode"], V3)
        self.assertEqual(ok_all["mismatches"], [])
        self.assertIsNone(ok_all["error_code"])

        ok_absent = ex.assert_expressive_mode_carriers({}, {}, {})
        self.assertTrue(ok_absent["ok"])
        self.assertEqual(ok_absent["mode"], L2)

        m1 = ex.assert_expressive_mode_carriers(v3, v2, v2)
        self.assertFalse(m1["ok"])
        self.assertEqual(m1["error_code"], "EXPRESSIVE_MODE_CARRIER_MISMATCH")
        self.assertEqual(sorted(x["pair"] for x in m1["mismatches"]),
                         ["session_vs_config", "session_vs_metadata"])

        m2 = ex.assert_expressive_mode_carriers(v3, v3, v2)
        self.assertEqual(sorted(x["pair"] for x in m2["mismatches"]),
                         ["config_vs_metadata", "session_vs_metadata"])

        m3 = ex.assert_expressive_mode_carriers(v2, v3, v2)
        self.assertEqual(sorted(x["pair"] for x in m3["mismatches"]),
                         ["config_vs_metadata", "session_vs_config"])

        bad = ex.assert_expressive_mode_carriers({ex.EXPRESSIVE_MODE_FIELD: "v3"}, v3, v3)
        self.assertFalse(bad["ok"])
        self.assertEqual(bad["error_code"], "EXPRESSIVE_MODE_INVALID")
        self.assertEqual(bad["invalid_carriers"], ["session"])
        self.assertIsNone(bad["mode"])

    def test_h7_mode_is_readable_on_parse_result(self):
        r = ex.parse_expressive_timeline("안녕하세요.", mode=V3)
        self.assertEqual(r["mode"], V3)
        self.assertEqual(r["effective_version"], 3)
        self.assertTrue(r["ok"])
        self.assertEqual(r["timeline"]["mode"], V3)
        self.assertTrue(r["timeline"]["expressive_enabled"])
        self.assertEqual(r["timeline"]["summary"]["mode"], V3)
        self.assertEqual(r["timeline"]["summary"]["effective_version"], 3)
        bad = ex.parse_expressive_timeline("[명란] 오타", mode=V3)
        self.assertFalse(bad["ok"])
        self.assertEqual(bad["mode"], V3)
        self.assertEqual(bad["effective_version"], 3)


if __name__ == "__main__":
    unittest.main()
