# -*- coding: utf-8 -*-
"""공용 Script Plan — Python 쪽 계약과 TS 와의 parity.

parity 는 hash 로 고정한다. `src/shared/scriptPlan.parity-hashes.json` 을 양쪽이 같이 읽고,
Python 은 자기가 그 값을 재현하는지(= fixture 가 굳었는지), TS 는 같은 값을 내는지 본다.
한쪽만 고치면 두 테스트 중 하나가 깨진다 — 그게 목적이다.

새 의존성 0(stdlib unittest). 모델·GPU 를 부르지 않는다.
"""
import json
import os
import unittest

import chunk_budget as cb
import input_analysis as ia
import script_plan as sp
import tts_grammar as tg

LF = chr(10)
CR = chr(13)
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PINNED = os.path.join(REPO_ROOT, "src", "shared", "scriptPlan.parity-hashes.json")


def _count(s):
    """테스트용 토크나이저. production tokenizer 를 부르지 않는다(모델 로딩 금지)."""
    return max(1, len(s or "") // 2)


class ParityFixtureTest(unittest.TestCase):
    def setUp(self):
        with open(PINNED, encoding="utf-8") as f:
            self.pinned = json.load(f)

    def test_fixture_is_not_trivially_small(self):
        self.assertGreaterEqual(len(self.pinned), 30, "fixture 가 너무 작으면 헛돈다")

    def test_python_reproduces_every_pinned_hash(self):
        """fixture 가 굳어 있는지 — 구현이 바뀌면 여기서 먼저 걸린다."""
        bad = []
        for text, sha in self.pinned.items():
            got = sp.build_structure(text)["structure_sha256"]
            if got != sha:
                # 대본 원문을 메시지에 넣지 않는다. 길이와 hash 앞자리로 충분하다.
                bad.append("len=%d pinned=%s got=%s" % (len(text), sha[:8], got[:8]))
        self.assertEqual(bad, [], LF.join(bad))

    def test_fixture_covers_every_warning_code(self):
        """경고 코드마다 최소 한 case 가 있어야 parity 가 그 경로를 지난다."""
        seen = set()
        for text in self.pinned:
            for w in sp.build_structure(text)["warnings"]:
                seen.add(w["code"])
        self.assertEqual(seen, set(sp.PLAN_WARNING_CODES))

    def test_fixture_covers_both_authority_paths(self):
        auth = set(sp.build_structure(t)["parser_authority"] for t in self.pinned)
        self.assertEqual(auth, {True, False}, "성공·실패 두 경로가 모두 있어야 한다")


class AxisSeparationTest(unittest.TestCase):
    """문단 != 발화 != 묶음. 같은 이름으로 부르지 않는다."""

    def test_emotion_change_adds_utterances_not_paragraphs(self):
        st = sp.build_structure("[기쁨] 첫 문장. [슬픔] 둘째 문장.")
        self.assertEqual(len(st["source_paragraphs"]), 1)
        self.assertEqual(len(st["utterances"]), 2)
        self.assertEqual([u["source_paragraph_index"] for u in st["utterances"]], [0, 0])

    def test_same_emotion_in_a_row_is_one_span(self):
        st = sp.build_structure("[기쁨] 첫 줄." + LF + "[기쁨] 둘째 줄.")
        self.assertEqual(len(st["utterances"]), 2)
        self.assertEqual(len(st["emotions"]), 1)
        self.assertEqual(st["emotions"][0]["utterance_start"], 0)
        self.assertEqual(st["emotions"][0]["utterance_end"], 1)
        self.assertIsNone(st["emotions"][0]["intensity"], "세기는 아직 문법에 없다")

    def test_blank_lines_are_not_paragraphs_but_are_remembered(self):
        st = sp.build_structure("첫 문단." + LF + LF + LF + "둘째 문단.")
        self.assertEqual(len(st["source_paragraphs"]), 2)
        self.assertEqual(st["source_paragraphs"][1]["blank_lines_before"], 2)

    def test_reserved_axes_are_declared_and_empty(self):
        st = sp.build_structure("[기쁨] 안녕하세요.")
        for axis in sp.RESERVED_AXES:
            self.assertIn(axis, st, "축 이름은 지금 정해 둔다")
            self.assertEqual(st[axis], [], "없는 축을 채우지 않는다")
        self.assertIsNone(st["utterances"][0]["speaker_id"])
        self.assertEqual(st["prosody"], [])


class SourceCoordinateTest(unittest.TestCase):
    def test_utterance_span_points_at_the_script(self):
        # 발화 구간은 자기 지시를 포함한다(파서 계약).
        src = "[기쁨] 안녕하세요."
        u = sp.build_structure(src)["utterances"][0]
        self.assertEqual(src[u["source_start"]:u["source_end"]], src)
        self.assertTrue(u["source_offsets_exact"])

    def test_line_endings_do_not_change_the_meaning(self):
        def meaning(st):
            return json.dumps({
                "u": [[u["line_index"], u["emotion_id"], u["boundary_kind"], u["chars"]]
                      for u in st["utterances"]],
                "e": [[e["emotion_id"], e["utterance_start"], e["utterance_end"]]
                      for e in st["emotions"]],
                "p": [p["pause_ms"] for p in st["pauses"]],
                "w": [w["code"] for w in st["warnings"]],
            }, ensure_ascii=False)

        base = "[기쁨] 첫 줄.%s[슬픔] 둘째 줄."
        lf = sp.build_structure(base % LF)
        crlf = sp.build_structure(base % (CR + LF))
        cr = sp.build_structure(base % CR)
        self.assertEqual(lf["normalized_sha256"], crlf["normalized_sha256"])
        self.assertEqual(lf["normalized_sha256"], cr["normalized_sha256"])
        self.assertNotEqual(lf["source_sha256"], crlf["source_sha256"],
                            "원문 신원은 입력 그대로여야 한다")
        self.assertEqual(meaning(lf), meaning(crlf))
        self.assertEqual(meaning(lf), meaning(cr))
        # 좌표는 원문 기준이라 CRLF 쪽 둘째 발화가 한 칸 뒤에 있다.
        self.assertEqual(crlf["utterances"][1]["source_start"],
                         lf["utterances"][1]["source_start"] + 1)

    def test_non_bmp_characters_do_not_shift_paragraph_offsets(self):
        """이모지는 UTF-16 두 칸, code point 한 칸이다.

        두 map 은 서로 다른 좌표계로 색인되므로 한쪽 커서로 둘 다 조회하면 여기서 밀린다.
        """
        src = "\U0001F389 첫 줄." + LF + "둘째 줄."
        p = sp.build_structure(src)["source_paragraphs"][1]
        # Python str 은 code point 단위라 UTF-16 좌표로 직접 자를 수 없다 — 두 좌표를 각각 본다.
        self.assertEqual(src[p["text_start"]:p["text_end"]], "둘째 줄.")
        self.assertEqual(p["source_start"], p["text_start"] + 1, "이모지 하나가 UTF-16 한 칸 더")

    def test_warning_offsets_are_source_coordinates_even_with_crlf(self):
        """실패 경로의 좌표도 원문 기준이어야 한다(전에는 정규화 좌표로 나갔다)."""
        src = "첫 줄입니다." + CR + LF + "[없는감정] 안녕"
        w = [x for x in sp.build_structure(src)["warnings"]
             if x["code"] == sp.WARN_UNKNOWN_DIRECTIVE]
        self.assertEqual(len(w), 1)
        self.assertEqual(src[w[0]["source_start"]], "[", "경고가 가리키는 자리가 그 표기여야 한다")


class WarningTest(unittest.TestCase):
    def _codes(self, text):
        return [w["code"] for w in sp.build_structure(text)["warnings"]]

    def test_unclosed_tag_is_a_warning_not_a_block(self):
        st = sp.build_structure("[기쁨 안녕하세요 반갑습니다")
        self.assertTrue(st["parser_authority"], "파서는 리터럴로 지나간다")
        self.assertEqual([w["code"] for w in st["warnings"]], [sp.WARN_UNCLOSED_TAG])
        self.assertEqual(st["warnings"][0]["source_start"], 0)

    def test_each_kind_gets_its_own_code(self):
        self.assertEqual(self._codes("[없는감정] 안녕"), [sp.WARN_UNKNOWN_DIRECTIVE])
        self.assertEqual(self._codes("[홍길동] 안녕하세요"), [sp.WARN_UNKNOWN_DIRECTIVE])
        self.assertEqual(self._codes("[기쁨]"), [sp.WARN_EMPTY_UTTERANCE])
        self.assertEqual(self._codes("안녕. [쉼 1.0][쉼 1.0] 또 안녕."),
                         [sp.WARN_CONFLICTING_DIRECTIVES])
        self.assertEqual(self._codes("[쉼 1.0]" + LF + "[기쁨] 안녕."),
                         [sp.WARN_DIRECTIVE_ONLY_PARAGRAPH])

    def test_malformed_pause_keeps_its_reason(self):
        for text, reason in (("[쉼 abc] 안녕", "format"), ("[쉼 9.0] 안녕", "range"),
                             ("[쉼] 안녕", "missing_arg")):
            w = sp.build_structure(text)["warnings"]
            self.assertEqual([x["code"] for x in w], [sp.WARN_UNKNOWN_DIRECTIVE], text)
            self.assertEqual(w[0]["reason"], reason, "사유를 지우지 않는다")

    def test_clean_scripts_stay_silent(self):
        for text in ("[기쁨] 안녕하세요.",
                     "[기쁨] 첫 문장. [쉼 0.5] 둘째 문장.",
                     "첫 문단." + LF + LF + "둘째 문단.",
                     "[기쁨] 은 감정 태그입니다.",
                     "그냥 대사입니다."):
            self.assertEqual(sp.build_structure(text)["warnings"], [], text)

    def test_warnings_are_ordered_by_position(self):
        st = sp.build_structure("[기쁨 안녕" + LF + "[쉼 1.0]")
        starts = [w["source_start"] for w in st["warnings"]]
        self.assertEqual(starts, sorted(starts))

    def test_fallback_path_still_produces_a_plan(self):
        st = sp.build_structure("[없는감정] 안녕" + LF + "둘째 줄.")
        self.assertFalse(st["parser_authority"])
        self.assertEqual(len(st["utterances"]), 2, "원문 줄로 물러난다")
        self.assertTrue(all(not u["source_offsets_exact"] for u in st["utterances"]),
                        "근사를 정확하다고 말하지 않는다")

    def test_warnings_never_carry_the_script_text(self):
        secret = "이것은 대사 원문입니다"
        blob = json.dumps(sp.build_structure("[없는감정] " + secret), ensure_ascii=False)
        self.assertNotIn(secret, blob, "plan 은 좌표만 들고 다닌다")


class SinglePassTest(unittest.TestCase):
    """대본을 한 번만 읽는다 — 소비자가 각자 파싱하지 않는다."""

    def test_analysis_parses_the_script_exactly_once(self):
        calls = []
        real = tg.parse_tts_script

        def counting(raw, resolve_emotion=None):
            calls.append(len(raw or ""))
            return real(raw, resolve_emotion)

        tg.parse_tts_script = counting
        try:
            ia.analyze("[기쁨] 안녕하세요." + LF + LF + "[슬픔] 둘째 문단.", _count)
        finally:
            tg.parse_tts_script = real
        self.assertEqual(len(calls), 1, "파싱이 두 번 일어나면 해석이 갈라질 수 있다")

    def test_paragraph_helper_has_one_implementation(self):
        text = "첫 문단." + LF + LF + "둘째 문단."
        self.assertEqual(ia.source_paragraphs_of(text), sp.source_paragraphs(text))


class AnalysisPlanTest(unittest.TestCase):
    """분석 응답에 실린 plan — 구조 층 + Python 권위 층(문장 경계·생성 묶음)."""

    def setUp(self):
        self.text = "[기쁨] 안녕하세요. [쉼 0.5] 둘째 문장입니다." + LF + LF + "[슬픔] 둘째 문단."
        self.res = ia.analyze(self.text, _count)
        self.plan = self.res["plan"]

    def test_schema_version_moved_together(self):
        self.assertEqual(self.res["schema_version"], 5)
        self.assertEqual(self.plan["plan_schema_version"], sp.PLAN_SCHEMA_VERSION)
        self.assertEqual(self.plan["parser_version"], tg.TTS_PARSER_VERSION)

    def test_plan_holds_every_axis_in_one_place(self):
        for key in ("source_paragraphs", "utterances", "emotions", "pauses",
                    "sentences", "chunks", "warnings"):
            self.assertIn(key, self.plan, key)
        self.assertEqual(len(self.plan["source_paragraphs"]), 2)
        self.assertGreater(len(self.plan["utterances"]), len(self.plan["source_paragraphs"]),
                           "감정·쉼이 발화를 더 나눈다")
        self.assertEqual(len(self.plan["pauses"]), 1)

    def test_utterances_line_up_with_the_legacy_segment_rows(self):
        """`plan.utterances[i]` 와 `segments[i]` 는 같은 행이다(구조 대 추정치)."""
        self.assertEqual(len(self.plan["utterances"]), len(self.res["segments"]))
        for u, s in zip(self.plan["utterances"], self.res["segments"]):
            self.assertEqual(u["index"], s["index"])
            self.assertEqual(u["source_start"], s["source_start"])
            self.assertEqual(u["emotion_id"], s["emotion_id"])
            self.assertEqual(u["boundary_kind"], s["boundary_kind"])

    def test_chunks_are_the_planner_rows_not_a_second_split(self):
        self.assertEqual(self.plan["chunks"], self.res["chunks"])
        self.assertEqual(len(self.plan["chunks"]), self.res["planned_calls"])

    def test_sentence_boundaries_point_at_the_script(self):
        rows = self.plan["sentences"]
        self.assertGreaterEqual(len(rows), 3)
        for r in rows:
            self.assertIn(r["utterance_index"],
                          [u["index"] for u in self.plan["utterances"]])
            if r["source_offsets_exact"]:
                self.assertEqual(len(self.text[r["source_start"]:r["source_end"]]), r["chars"])
        # 문장 수는 기존 집계와 어긋나지 않는다.
        self.assertEqual(len(rows), sum(s["sentence_count"] for s in self.res["segments"]))

    def test_structure_hash_is_reproducible_from_the_payload(self):
        self.assertEqual(sp.structure_sha256(self.plan), self.plan["structure_sha256"],
                         "권위 층을 얹어도 구조 hash 는 구조만 본다")

    def test_planned_calls_still_match_the_real_splitter(self):
        """plan 을 얹었다고 계획이 달라지면 안 된다."""
        cap = cb.max_production_tokens()
        import text_segmenter as ts
        total = 0
        for u in ia.paragraphs_of(self.text):
            tok = _count(u["text"])
            total += 1 if tok <= cap else len(ts.split_for_generation(u["text"], _count, cap))
        self.assertEqual(self.res["planned_calls"], total)

    def test_response_carries_no_script_text(self):
        blob = json.dumps(self.res, ensure_ascii=False)
        for fragment in ("안녕하세요", "둘째 문단"):
            self.assertNotIn(fragment, blob, "응답은 좌표만 들고 다닌다")


if __name__ == "__main__":
    unittest.main()
