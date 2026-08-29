# -*- coding: utf-8 -*-
"""의미 기반 장문 분할(C2) 단위 테스트 — synthetic 전용.

모델/GPU/오디오/파일 I/O 없음. count_tokens 는 주입한 가짜(문자 길이)를 쓴다.
분할 규칙 1~9 를 각각 한 개 이상의 단언으로 고정한다.
대사 전문은 단언 입력에만 쓰고 실패 메시지로 내보내지 않는다(라벨/인덱스/숫자만).
"""
import ast
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import expressive_timeline as ex          # noqa: E402
import semantic_chunk_planner as scp      # noqa: E402
import text_segmenter as ts               # noqa: E402
import tts_grammar as g                   # noqa: E402
import tts_worker as w                    # noqa: E402

SG = 0.3       # silence_gap(줄 경계 전역 기본)
EPMS = 200     # emotion_boundary_pause_ms


def plan_of(raw):
    r = g.parse_tts_script(raw)
    assert r["ok"], "테스트 입력이 파서를 통과하지 못함"
    return r["plan"]


def kinds(raw):
    return [e["kind"] for e in scp.classify_plan_boundaries(plan_of(raw))]


def by_len(t):
    """주입 토큰 계수기 — 문자 길이. 실제 토크나이저가 아니다(테스트 전용)."""
    return len(t)


def _planner_ast():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "semantic_chunk_planner.py")
    with open(path, encoding="utf-8") as f:
        return ast.parse(f.read())


def planner_imports():
    """planner 가 실제로 import 하는 최상위 모듈명 집합(주석/docstring 무시)."""
    names = set()
    for node in ast.walk(_planner_ast()):
        if isinstance(node, ast.Import):
            names.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".")[0])
    return names


def planner_defined_names():
    """planner 가 실제로 정의하는 이름(모듈 레벨 변수/함수/클래스)."""
    names = set()
    for node in _planner_ast().body:
        if isinstance(node, ast.Assign):
            names.update(t.id for t in node.targets if isinstance(t, ast.Name))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
        elif isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            names.add(node.name)
    return names


# ─────────────────────────────────────────────────────────────────────────────
# 규칙 1 — 빈 줄/문단 경계가 가장 강하다
# ─────────────────────────────────────────────────────────────────────────────

class Rule1ParagraphTest(unittest.TestCase):
    def test_blank_line_becomes_paragraph(self):
        self.assertEqual(kinds("첫 줄.\n\n둘째 줄."), ["internal", "paragraph"])

    def test_plain_line_break_stays_line(self):
        self.assertEqual(kinds("첫 줄.\n둘째 줄."), ["internal", "line"])

    def test_multiple_blank_lines_still_one_paragraph(self):
        e = scp.classify_plan_boundaries(plan_of("첫 줄.\n\n\n둘째 줄."))[1]
        self.assertEqual(e["kind"], "paragraph")
        self.assertEqual(e["blank_lines_before"], 2)     # 사실은 그대로 기록
        self.assertEqual(e["paragraph_index"], 1)        # 경계는 하나(합산 아님)

    def test_paragraph_is_strongest_structural_boundary(self):
        for weaker in ("internal", "emotion", "sentence", "line"):
            self.assertGreater(scp.boundary_strength("paragraph"),
                               scp.boundary_strength(weaker), weaker)

    def test_paragraph_index_counts_only_paragraphs(self):
        es = scp.classify_plan_boundaries(plan_of("A.\nB.\n\nC.\nD.\n\nE."))
        self.assertEqual([e["kind"] for e in es],
                         ["internal", "line", "paragraph", "line", "paragraph"])
        self.assertEqual([e["paragraph_index"] for e in es], [0, 0, 1, 1, 2])


# ─────────────────────────────────────────────────────────────────────────────
# 규칙 2 — '.', '!', '?' 종결 부호가 선호 경계
# ─────────────────────────────────────────────────────────────────────────────

class Rule2SentencePreferredTest(unittest.TestCase):
    def test_sentence_outranks_emotion_and_internal(self):
        self.assertGreater(scp.boundary_strength("sentence"), scp.boundary_strength("emotion"))
        self.assertGreater(scp.boundary_strength("sentence"), scp.boundary_strength("internal"))

    def test_sentence_is_split_eligible(self):
        self.assertTrue(scp.is_split_eligible("sentence"))

    def test_oversize_splits_at_terminators_not_mid_sentence(self):
        # 상한을 넘는 3 문장 → 종결 부호 뒤에서만 잘린다(문장 중간 절단 없음).
        text = "가나다라마바사아자차. 카타파하가나다라마바!"
        chunks = ts.split_for_generation(text, by_len, 14)
        self.assertGreater(len(chunks), 1)
        self.assertEqual("".join(chunks), text)
        for c in chunks[:-1]:
            self.assertIn(c.rstrip()[-1], ".!?", "종결 부호가 아닌 곳에서 잘림")

    def test_terminators_dot_bang_question_all_used(self):
        for term in (".", "!", "?"):
            text = "가나다라마바사아자차%s 카타파하가나다라마바%s" % (term, term)
            chunks = ts.split_for_generation(text, by_len, 14)
            self.assertGreater(len(chunks), 1, term)
            self.assertEqual(chunks[0].rstrip()[-1], term)


# ─────────────────────────────────────────────────────────────────────────────
# 규칙 3 — 같은 감정·스타일의 인접 문장은 안전 한도 안에서 묶는다
# ─────────────────────────────────────────────────────────────────────────────

class Rule3GroupingTest(unittest.TestCase):
    def test_adjacent_sentences_merge_when_they_fit(self):
        text = "짧다. 이것도. 저것도."
        self.assertLessEqual(by_len(text), 40)
        self.assertEqual(ts.split_for_generation(text, by_len, 40), [text])   # 한 덩어리

    def test_grouping_packs_up_to_limit_not_one_per_sentence(self):
        # 문장 6 자 × 6 개. 상한 20 → 문장마다 자르면 6 청크, 묶으면 그보다 적어야 한다.
        text = "가나다라. " * 6
        chunks = ts.split_for_generation(text, by_len, 20)
        self.assertEqual("".join(chunks), text)
        self.assertLess(len(chunks), 6, "인접 문장이 묶이지 않았다")
        for c in chunks:
            self.assertLessEqual(by_len(c), 20)

    def test_zero_gap_boundary_is_marked_mergeable(self):
        # 같은 줄·같은 감정 → boundary internal(무음 0) → 앞과 이어 붙여도 안전한 자리.
        es = scp.classify_plan_boundaries(plan_of("[기쁨] 안녕 [기쁨] 반가워"))
        self.assertEqual([e["kind"] for e in es], ["internal", "internal"])
        self.assertTrue(es[1]["mergeable_with_prev"])

    def test_paragraph_boundary_is_not_mergeable(self):
        es = scp.classify_plan_boundaries(plan_of("첫 줄.\n\n둘째 줄."))
        self.assertFalse(es[1]["mergeable_with_prev"])

    def test_emotion_boundary_is_not_mergeable_despite_not_splitting(self):
        # 규칙 4 로 '분할 사유' 는 아니지만, pause 모드에서 무음이 있으므로 합치면 그 쉼이 사라진다.
        es = scp.classify_plan_boundaries(plan_of("[기쁨] 안녕 [명랑] 반가워"))
        self.assertEqual(es[1]["kind"], "emotion")
        self.assertFalse(es[1]["split_eligible"])
        self.assertFalse(es[1]["mergeable_with_prev"])


# ─────────────────────────────────────────────────────────────────────────────
# 규칙 4 — 쉼표와 감정 태그만으로는 강제 분할하지 않는다
# ─────────────────────────────────────────────────────────────────────────────

class Rule4NoForcedSplitTest(unittest.TestCase):
    def test_commas_alone_do_not_split(self):
        text = "가, 나, 다, 라, 마"
        self.assertEqual(ts.split_for_generation(text, by_len, 40), [text])

    def test_emotion_boundary_is_not_split_eligible(self):
        self.assertFalse(scp.is_split_eligible("emotion"))
        self.assertFalse(scp.is_split_eligible("internal"))
        for k in scp.NON_SPLITTING_BOUNDARY_KINDS:
            self.assertNotIn(k, scp.SPLIT_ELIGIBLE_KINDS)

    def test_split_eligible_set_covers_every_other_kind(self):
        # 종류가 늘어나도 두 목록이 어긋나지 않는다(한쪽에서 유도되므로).
        self.assertEqual(sorted(scp.SPLIT_ELIGIBLE_KINDS),
                         sorted(k for k in scp.SEMANTIC_BOUNDARY_ORDER
                                if k not in scp.NON_SPLITTING_BOUNDARY_KINDS))
        self.assertEqual(scp.SPLIT_ELIGIBLE_KINDS[0], "explicitPause")   # 강한 것부터

    def test_inline_emotion_change_classified_as_emotion_not_line(self):
        es = scp.classify_plan_boundaries(plan_of("[기쁨] 안녕 [명랑] 반가워"))
        self.assertEqual([e["kind"] for e in es], ["internal", "emotion"])
        self.assertFalse(es[1]["split_eligible"])

    def test_consumed_contract_says_tags_are_not_boundaries(self):
        # 이 모듈의 규칙 4 근거는 표현 계약이 이미 못 박은 값이다(재정의 아님).
        self.assertFalse(ex.EMOTION_TRANSITION_IS_CHUNK_BOUNDARY)
        self.assertFalse(ex.LOCAL_PROSODY_IS_CHUNK_BOUNDARY)


# ─────────────────────────────────────────────────────────────────────────────
# 규칙 5 — 한 문장이 한도를 넘을 때만 절·단어 경계로 최후 분할
# ─────────────────────────────────────────────────────────────────────────────

class Rule5LastResortTest(unittest.TestCase):
    def test_single_oversize_sentence_falls_back_to_clause(self):
        text = "가나다라마바사아자차, 카타파하가나다라마바."
        chunks = ts.split_for_generation(text, by_len, 14)
        self.assertGreater(len(chunks), 1)
        self.assertEqual("".join(chunks), text)
        self.assertTrue(chunks[0].rstrip().endswith(","), "절 경계에서 자르지 않음")
        for c in chunks:
            self.assertLessEqual(by_len(c), 14)

    def test_falls_back_to_whitespace_when_no_clause_mark(self):
        text = "가나다라마바사아자차 카타파하가나다라마바"
        chunks = ts.split_for_generation(text, by_len, 12)
        self.assertGreater(len(chunks), 1)
        self.assertEqual("".join(chunks), text)
        self.assertTrue(chunks[0].endswith(" "))

    def test_undersize_sentence_never_reaches_clause_level(self):
        # 상한 이내면 쉼표가 있어도 원문 그대로(최후 수단이 조기 발동하지 않는다).
        text = "가, 나, 다."
        self.assertEqual(ts.split_for_generation(text, by_len, 30), [text])

    def test_content_is_preserved_exactly(self):
        text = "가나다, 라마바. 사아자, 차카타! 파하가나다라마바사?"
        for limit in (8, 11, 17, 23):
            chunks = ts.split_for_generation(text, by_len, limit)
            self.assertEqual("".join(chunks), text, limit)


# ─────────────────────────────────────────────────────────────────────────────
# 규칙 6 — 줄바꿈·문장부호·감정 pause 가 겹쳐도 중복 합산하지 않는다
# ─────────────────────────────────────────────────────────────────────────────

class Rule6NoSummationTest(unittest.TestCase):
    def test_single_winner_per_boundary(self):
        for raw in ("A [쉼 0.5] B", "[기쁨] 가.\n[슬픔] 나.", "가.\n\n[슬픔] 나."):
            for e in scp.classify_plan_boundaries(plan_of(raw)):
                self.assertIn(e["kind"], scp.SEMANTIC_BOUNDARY_ORDER)
                self.assertNotIn(e["kind"], e["suppressed"])

    def test_explicit_pause_suppresses_line_and_emotion(self):
        e = scp.classify_plan_boundaries(plan_of("[기쁨] 가.\n[쉼 0.5] [슬픔] 나."))[1]
        self.assertEqual(e["kind"], "explicitPause")
        self.assertIn("line", e["suppressed"])
        self.assertIn("emotion", e["suppressed"])

    def test_explicit_pause_suppresses_paragraph(self):
        e = scp.classify_plan_boundaries(plan_of("가.\n\n[쉼 1.2] [슬픔] 나."))[1]
        self.assertEqual(e["kind"], "explicitPause")
        self.assertIn("paragraph", e["suppressed"])
        self.assertEqual(e["blank_lines_before"], 1)   # 문단이었다는 사실은 남기되 값은 더하지 않는다

    def test_line_break_suppresses_emotion_change(self):
        e = scp.classify_plan_boundaries(plan_of("[기쁨] 가.\n[슬픔] 나."))[1]
        self.assertEqual(e["kind"], "line")
        self.assertIn("emotion", e["suppressed"])
        self.assertNotIn("line", e["suppressed"])

    def test_paragraph_suppresses_emotion_change(self):
        e = scp.classify_plan_boundaries(plan_of("[기쁨] 가.\n\n[슬픔] 나."))[1]
        self.assertEqual(e["kind"], "paragraph")
        self.assertIn("emotion", e["suppressed"])

    def test_gap_equals_one_source_never_the_sum(self):
        # 줄바꿈(0.3) + 감정전환(0.2) 이 겹친 자리 — 값은 0.3 이고 0.5 가 아니다.
        es = scp.resolve_boundary_gaps(plan_of("[기쁨] 가.\n[슬픔] 나."), SG, "pause", EPMS)
        self.assertEqual(es[1]["gap_sec"], SG)
        self.assertNotEqual(es[1]["gap_sec"], SG + EPMS / 1000.0)

    def test_explicit_pause_overrides_and_does_not_sum(self):
        es = scp.resolve_boundary_gaps(plan_of("[기쁨] 가.\n[쉼 0.5] [슬픔] 나."), SG, "pause", EPMS)
        self.assertEqual(es[1]["gap_sec"], 0.5)                       # 0.3 도 0.2 도 그 합도 아니다

    def test_consumed_contract_forbids_summation(self):
        self.assertFalse(ex.SENTENCE_GAP_AND_EMOTION_PAUSE_MAY_SUM)
        self.assertTrue(ex.SENTENCE_GAP_SUPPRESSED_BY_EXPLICIT_PAUSE)


# ─────────────────────────────────────────────────────────────────────────────
# 규칙 7 — 모델 말미 무음 + 앱 gap 의 합이 목표 pause 가 된다
# ─────────────────────────────────────────────────────────────────────────────

class Rule7PauseBudgetTest(unittest.TestCase):
    def test_unmeasured_is_honest_and_uncompensated(self):
        b = scp.plan_pause_budget(300)
        self.assertEqual(b["reason"], "TAIL_UNMEASURED")
        self.assertFalse(b["compensated"])
        self.assertEqual(b["app_gap_ms"], 300)
        self.assertIsNone(b["realized_pause_ms"])

    def test_measured_tail_is_subtracted_so_sum_equals_target(self):
        b = scp.plan_pause_budget(300, model_tail_ms=120)
        self.assertEqual(b["reason"], "MEASURED_COMPENSATED")
        self.assertEqual(b["app_gap_ms"], 180)
        self.assertEqual(b["model_tail_ms"] + b["app_gap_ms"] + b["model_lead_ms"],
                         b["target_pause_ms"])
        self.assertEqual(b["realized_pause_ms"], 300)

    def test_lead_silence_counts_toward_the_same_budget(self):
        b = scp.plan_pause_budget(500, model_tail_ms=120, model_lead_ms=80)
        self.assertEqual(b["app_gap_ms"], 300)
        self.assertEqual(b["realized_pause_ms"], 500)

    def test_app_gap_never_negative(self):
        b = scp.plan_pause_budget(200, model_tail_ms=300, model_lead_ms=50)
        self.assertEqual(b["reason"], "MEASURED_TAIL_EXCEEDS_TARGET")
        self.assertEqual(b["app_gap_ms"], scp.APP_GAP_FLOOR_MS)
        self.assertEqual(b["app_gap_ms"], 0)
        self.assertGreater(b["realized_pause_ms"], b["target_pause_ms"])   # 정직하게 초과 표기

    def test_zero_target_inserts_nothing(self):
        b = scp.plan_pause_budget(0, model_tail_ms=40)
        self.assertEqual(b["reason"], "TARGET_ZERO")
        self.assertEqual(b["app_gap_ms"], 0)

    def test_negative_inputs_rejected(self):
        with self.assertRaises(ValueError):
            scp.plan_pause_budget(-1)
        with self.assertRaises(ValueError):
            scp.plan_pause_budget(100, model_tail_ms=-1)

    def test_resolve_applies_budget_to_every_boundary(self):
        es = scp.resolve_boundary_gaps(plan_of("가.\n나.\n다."), SG, "pause", EPMS,
                                       model_tail_ms=100)
        self.assertEqual(es[0]["gap_sec"], 0.0)                 # 첫 segment 는 경계 아님
        for e in es[1:]:
            self.assertEqual(e["budget"]["reason"], "MEASURED_COMPENSATED")
            self.assertAlmostEqual(e["gap_sec"], 0.2, places=9)  # 300ms 목표 - 100ms 말미
            self.assertEqual(e["budget"]["realized_pause_ms"], 300)

    def test_measurement_is_injected_not_taken(self):
        # 이 모듈은 무음을 '재지' 않는다(C3 소유) — 계측/오디오 모듈을 import 하지 않는다.
        for banned in ("boundary_metrics", "onset_continuity_metrics",
                       "expressive_boundary_metrics", "numpy", "soundfile"):
            self.assertNotIn(banned, planner_imports(), banned)


# ─────────────────────────────────────────────────────────────────────────────
# 규칙 8 — 기존 v2 결과는 바뀌지 않는다
# ─────────────────────────────────────────────────────────────────────────────

# 배선 '전' 의 tts_worker._boundary_gaps_from_plan 에서 실측해 옮겨 적은 값이다.
# 리터럴이므로 배선 후에도 tautology 가 되지 않는다 — 동작이 바뀌면 여기서 깨진다.
LEGACY_GAPS = (
    ("안녕하세요.\n반갑습니다.",            "pause",     [0.0, 0.3]),
    ("안녕하세요.\n반갑습니다.",            "immediate", [0.0, 0.3]),
    ("그냥 한 문장.",                       "pause",     [0.0]),
    ("[기쁨] 안녕 [명랑] 반가워",           "pause",     [0.0, 0.2]),
    ("[기쁨] 안녕 [명랑] 반가워",           "immediate", [0.0, 0.0]),
    ("[기쁨] 안녕 [기쁨] 반가워",           "pause",     [0.0, 0.0]),
    ("A [쉼 0.5] B",                        "pause",     [0.0, 0.5]),
    ("A [쉼 0.5] B",                        "immediate", [0.0, 0.5]),
    ("[기쁨] 가.\n[슬픔] 나.",              "pause",     [0.0, 0.3]),
    ("[기쁨] 가.\n[쉼 0.5] [슬픔] 나.",     "pause",     [0.0, 0.5]),
    ("가.\n\n나.",                          "pause",     [0.0, 0.3]),   # 문단도 미지정이면 line 과 같은 값
    ("첫 줄.\n\n\n둘째 줄.",                "pause",     [0.0, 0.3]),
    ("가.\n\n[쉼 1.2] [슬픔] 나.\n다.",     "pause",     [0.0, 1.2, 0.3]),
    ("A.\nB.\n\nC.\nD.\n\nE.",              "pause",     [0.0, 0.3, 0.3, 0.3, 0.3]),
)

RAW_CASES = tuple(sorted({raw for raw, _m, _g in LEGACY_GAPS}))


class Rule8LegacyUnchangedTest(unittest.TestCase):
    def test_planner_reproduces_legacy_gaps_exactly(self):
        for raw, mode, expected in LEGACY_GAPS:
            got = [e["gap_sec"] for e in scp.resolve_boundary_gaps(plan_of(raw), SG, mode, EPMS)]
            self.assertEqual(got, expected, "%r/%s" % (raw[:12], mode))

    def test_production_path_reproduces_legacy_gaps_exactly(self):
        for raw, mode, expected in LEGACY_GAPS:
            _, got, _ = w._boundary_gaps_from_plan(plan_of(raw), SG, mode, EPMS)
            self.assertEqual(got, expected, "%r/%s" % (raw[:12], mode))

    def test_no_second_to_ms_round_trip(self):
        # 초→ms→초 왕복이 끼어들면 임의의 silence_gap 에서 값이 흔들린다.
        for sg in (0.29, 0.31, 0.123, 0.1234, 1.0):
            got = [e["gap_sec"] for e in scp.resolve_boundary_gaps(plan_of("가.\n나."), sg, "pause", EPMS)]
            self.assertEqual(repr(got[1]), repr(float(sg)), sg)

    def test_v2_plan_hash_untouched(self):
        for raw in RAW_CASES:
            plan = plan_of(raw)
            before = plan["full_sha256"]
            scp.resolve_boundary_gaps(plan, SG, "pause", EPMS, model_tail_ms=50, paragraph_gap=0.9)
            self.assertEqual(plan["full_sha256"], before)          # 계획을 제자리에서 훼손하지 않는다
            self.assertEqual(plan_of(raw)["full_sha256"], before)
            self.assertEqual(plan["parser_version"], g.TTS_PARSER_VERSION)

    def test_parser_version_still_two(self):
        self.assertEqual(g.TTS_PARSER_VERSION, ex.EXPRESSIVE_LEGACY_PLAN_VERSION)

    def test_paragraph_gap_opt_in_only(self):
        plan = plan_of("가.\n\n나.")
        self.assertEqual([e["gap_sec"] for e in scp.resolve_boundary_gaps(plan, SG, "pause", EPMS)],
                         [0.0, SG])                                   # 미지정 → 오늘과 동일
        opted = scp.resolve_boundary_gaps(plan, SG, "pause", EPMS, paragraph_gap=0.8)
        self.assertEqual([e["gap_sec"] for e in opted], [0.0, 0.8])   # 명시했을 때만 달라진다

    def test_winner_matches_parser_priority(self):
        # candidates 는 '사실' 에서, 승자는 파서에서 온다. 둘이 어긋나면 계약 드리프트다.
        for raw in RAW_CASES:
            for e in scp.classify_plan_boundaries(plan_of(raw)):
                if not e["candidates"]:
                    continue
                strongest = max(e["candidates"], key=scp.boundary_strength)
                self.assertEqual(e["kind"], strongest, "%r@%d" % (raw[:12], e["index"]))


# ─────────────────────────────────────────────────────────────────────────────
# 규칙 9 — 생성 한도·watchdog 상수는 이 모듈의 소유가 아니다
# ─────────────────────────────────────────────────────────────────────────────

class Rule9LimitsUntouchedTest(unittest.TestCase):
    def test_planner_does_not_import_generation_limit(self):
        self.assertNotIn("generation_limit", planner_imports())

    def test_planner_defines_no_limit_or_timeout_symbol(self):
        # 주석·docstring 이 아니라 '실제로 정의된 이름' 만 본다(ast).
        for name in planner_defined_names():
            up = name.upper()
            for banned in ("LIMIT", "TOKEN", "WATCHDOG", "TIMEOUT"):
                self.assertNotIn(banned, up, name)

    def test_generation_limit_authority_untouched(self):
        # 상한의 권위는 별도 모듈이고 이 작업은 그 값을 건드리지 않았다.
        import generation_limit as gl
        self.assertEqual((gl.SLOPE, gl.BASE, gl.MIN_LIMIT, gl.ABS_LIMIT), (2.9, 160, 200, 256))


if __name__ == "__main__":
    unittest.main(verbosity=2)
