# -*- coding: utf-8 -*-
"""expressive_planner.py 단위 테스트 — 모델/GPU/오디오/합성 없음. 순수 계획 계약.

검증 축:
  A. 청킹    — 쉼표 분할 금지, 감정 태그가 분할점이 아님, 같은 감정 2~3문장 묶기, 사유 코드 도달성
  B. 전략    — A/B/C 선택과 사유, degraded 표기, 미검증은 위로 못 올라감, 목표 궤적
  C. 연속성  — 검증기가 각 필드를 '독립적으로' 잡아내고 처음 어긋난 필드를 지목
  D. 구두점  — 네이티브 vs 후처리 분리, 후처리는 의미 달성 주장 금지, 미지원은 표기(삭제 금지)
  E. 웃음    — 글자 렌더링 금지, 위치별 동작, ASR 단어 비교 제외, 하드 조인 금지
  F. 금지항목 — 금지 목록 1개당 최소 1개 테스트로 '계획이 지시하지 않음' 을 증명

⚠️ 실패 보고는 필드명/코드만(대사 전문 로그 금지).
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import expressive_capability as cap
import expressive_planner as pl
import expressive_timeline as ex

# ────────────────────────── 공용 픽스처 ──────────────────────────


def probe(f):
    return cap.ProbeEvidence(f, True, True, True)


def profile_with(engine_id, supported=(), prosody_native=False, **kw):
    feats = tuple(supported)
    prosody = ex.LOCAL_PROSODY_KINDS if prosody_native else ()
    return cap.build_profile(
        engine_id,
        claims={f: "supported" for f in feats},
        evidence={f: probe(f) for f in feats},
        prosody_claims={k: "supported" for k in prosody},
        prosody_evidence={k: probe(k) for k in prosody},
        **kw)


PROFILE_A_WEIGHTS = profile_with("A_weights",
                                 ("single_call_long_form", "continuous_emotion_weights",
                                  "emotion_instruction_text", "punctuation_native_instruction",
                                  "nonverbal_laugh_instruction", "vowel_extend_sustainable_final"),
                                 prosody_native=True)
PROFILE_A_INLINE = profile_with("A_inline",
                                ("single_call_long_form", "emotion_instruction_text"))
PROFILE_B_OVERLAP = profile_with("B_overlap", ("context_overlap_conditioning",))
PROFILE_C_BLIND = cap.unknown_profile("C_blind")


def profile_declared_no_inline_with_overlap():
    """인라인이 '명시적으로' 불가능하다고 선언된 엔진 + 겹침 지원."""
    return cap.build_profile(
        "B_declared",
        claims={"continuous_emotion_weights": "unsupported",
                "emotion_instruction_text": "unsupported",
                "single_call_long_form": "unsupported",
                "context_overlap_conditioning": "supported"},
        evidence={"context_overlap_conditioning": probe("context_overlap_conditioning")})


def profile_declared_nothing():
    """겹침까지 명시적으로 불가능하다고 선언된 엔진 → 마지막 수단."""
    return cap.build_profile(
        "C_declared",
        claims={"continuous_emotion_weights": "unsupported",
                "emotion_instruction_text": "unsupported",
                "single_call_long_form": "unsupported",
                "context_overlap_conditioning": "unsupported"})


def settings(**kw):
    base = dict(settings_id="set1", speaker_id="spk1", language="ko",
                reference_clip_id="ref1", reference_transcript_id="tr1",
                max_tokens=400, token_counter_id="test_char_counter")
    base.update(kw)
    return pl.GenerationSettings(**base)


def word_tokens(text):
    """테스트용 토큰 계수기 — 공백 단위. 실제 토크나이저가 아니다(주입 지점 검증용)."""
    return len([t for t in (text or "").split() if t])


def plan_for(raw, profile=None, count_tokens=None, **setting_kw):
    res = pl.plan_from_raw(raw, settings(**setting_kw), profile or PROFILE_A_WEIGHTS,
                           count_tokens or pl.approximate_count_tokens)
    return res["plan"]


# 대사(내용은 검증 대상이 아니라 구조를 만들기 위한 최소 재료)
S1 = "첫 문장"          # 첫 문장
S2 = "둘 문장"          # 둘 문장
S3 = "셋 문장"          # 셋 문장
S4 = "넷 문장"          # 넷 문장
HAPPY = "[기쁨]"
SAD = "[슬픔]"
LAUGH = "[ㅋㅋㅋ]"
PAUSE = "[쉼 1.0]"
COMMA_LINE = ("사과, 배, 포도, 바나나, 수박, "
              "딸기, 참외, 멜론.")


# ────────────────────────── A. 청킹 ──────────────────────────

class TestChunking(unittest.TestCase):

    def test_never_splits_at_a_comma(self):
        plan = plan_for(COMMA_LINE)
        self.assertEqual(len(plan["chunks"]), 1)
        self.assertNotIn(",", [c["generation_text"][-1:] for c in plan["chunks"][:-1]])

    def test_comma_line_over_budget_is_reported_not_comma_split(self):
        """상한을 못 맞춰도 쉼표로 쪼개지 않는다 — 초과 사실을 차단 이슈로 보고한다."""
        plan = plan_for(COMMA_LINE, count_tokens=word_tokens, max_tokens=2)
        self.assertEqual(len(plan["chunks"]), 1)
        self.assertTrue(plan["chunks"][0]["oversized"])
        self.assertFalse(plan["ok"])
        codes = [u["code"] for u in plan["blocking_issues"]]
        self.assertEqual(codes, ["UNIT_EXCEEDS_GENERATION_LIMIT"])
        self.assertFalse(plan["blocking_issues"][0]["detail"]["comma_split_used"])
        self.assertFalse(plan["blocking_issues"][0]["detail"]["limit_raised"])

    def test_emotion_tag_is_not_a_forced_split_point(self):
        raw = "%s. %s %s. %s." % (S1, HAPPY, S2, S3)
        plan = plan_for(raw, PROFILE_A_WEIGHTS)
        self.assertEqual(len(plan["chunks"]), 1)
        self.assertEqual(plan["chunks"][0]["sentence_count"], 3)
        # 계약값을 그대로 소비했는지(재유도 금지)
        for t in plan["chunks"][0]["emotion_transitions"]:
            self.assertFalse(t["is_chunk_boundary"])
            self.assertEqual(t["is_chunk_boundary"], ex.EMOTION_TRANSITION_IS_CHUNK_BOUNDARY)

    def test_two_or_three_same_emotion_sentences_are_grouped(self):
        plan = plan_for("%s. %s. %s." % (S1, S2, S3))
        self.assertEqual(len(plan["chunks"]), 1)
        self.assertEqual(plan["chunks"][0]["sentence_count"], 3)
        self.assertGreaterEqual(plan["chunks"][0]["sentence_count"],
                                pl.SENTENCE_GROUP_PREFERRED_MIN)

    def test_group_cap_applies_beyond_three_sentences(self):
        plan = plan_for("%s. %s. %s. %s." % (S1, S2, S3, S4))
        self.assertEqual(len(plan["chunks"]), 2)
        self.assertEqual(plan["chunks"][0]["end_reason"], "SENTENCE_GROUP_MAX")
        self.assertEqual(plan["chunks"][0]["end_reason_detail"]["sentence_group_max"],
                         pl.SENTENCE_GROUP_MAX_DEFAULT)

    def test_single_line_break_does_not_split(self):
        plan = plan_for("%s.\n%s." % (S1, S2))
        self.assertEqual(len(plan["chunks"]), 1)
        self.assertEqual(plan["chunks"][0]["internal_line_breaks"], 1)
        self.assertEqual(plan["chunks"][0]["sentence_gap_realization"], "in_call_natural")

    def test_blank_line_splits_as_paragraph_break(self):
        plan = plan_for("%s.\n\n%s." % (S1, S2))
        self.assertEqual(len(plan["chunks"]), 2)
        self.assertEqual(plan["chunks"][0]["end_reason"], "PARAGRAPH_BREAK")
        self.assertNotEqual(plan["chunks"][0]["paragraph_index"], plan["chunks"][1]["paragraph_index"])

    def test_long_terminal_splits_but_short_one_does_not(self):
        short = plan_for("%s... %s." % (S1, S2))
        self.assertEqual(len(short["chunks"]), 1, "3점 말줄임은 긴 종결이 아니다")
        long_ = plan_for("%s.... %s." % (S1, S2))
        self.assertEqual(long_["chunks"][0]["end_reason"], "LONG_TERMINAL")
        detail = long_["chunks"][0]["end_reason_detail"]
        self.assertGreaterEqual(detail["duration_hint_ms"], pl.LONG_TERMINAL_MIN_DURATION_MS)

    def test_explicit_pause_is_a_long_terminal_with_exact_gap(self):
        plan = plan_for("%s. %s %s." % (S1, PAUSE, S2))
        self.assertEqual(plan["chunks"][0]["end_reason"], "LONG_TERMINAL")
        self.assertEqual(plan["chunks"][0]["trailing_gap_ms"], 1000)
        self.assertEqual(plan["chunks"][0]["trailing_gap_source"], "explicit_pause")
        self.assertEqual(plan["chunks"][1]["leading_gap_ms"], 1000)

    def test_generation_limit_splits_and_never_raises_the_limit(self):
        plan = plan_for("%s. %s. %s." % (S1, S2, S3), count_tokens=word_tokens, max_tokens=4)
        self.assertGreater(len(plan["chunks"]), 1)
        self.assertEqual(plan["chunks"][0]["end_reason"], "GENERATION_LIMIT")
        self.assertFalse(plan["generation_limit_raise_allowed"])
        for c in plan["chunks"]:
            self.assertFalse(c["generation_limit_raised"])
            self.assertLessEqual(c["prod_tokens"], c["max_tokens"])
        self.assertFalse(plan["chunks"][0]["end_reason_detail"]["limit_raised"])

    def test_every_split_reason_code_is_reachable(self):
        seen = set()
        cases = (
            plan_for("%s.\n\n%s." % (S1, S2)),                                   # PARAGRAPH_BREAK
            plan_for("%s.... %s." % (S1, S2)),                                   # LONG_TERMINAL
            plan_for("%s. %s. %s." % (S1, S2, S3), count_tokens=word_tokens,
                     max_tokens=4),                                              # GENERATION_LIMIT
            plan_for("%s. %s. %s. %s." % (S1, S2, S3, S4)),                      # SENTENCE_GROUP_MAX
            plan_for("%s. %s %s." % (S1, HAPPY, S2),
                     profile_declared_no_inline_with_overlap()),                 # EMOTION_STRATEGY_OVERLAP
            plan_for("%s. %s %s." % (S1, HAPPY, S2), PROFILE_C_BLIND),           # EMOTION_STRATEGY_HARD_JOIN
        )
        for plan in cases:
            for c in plan["chunks"]:
                seen.add(c["end_reason"])
        self.assertEqual(seen, set(pl.SPLIT_REASON_CODES))   # END_OF_INPUT 포함

    def test_last_chunk_always_ends_with_end_of_input(self):
        for raw in ("%s." % S1, "%s.\n\n%s." % (S1, S2), COMMA_LINE):
            plan = plan_for(raw)
            self.assertEqual(plan["chunks"][-1]["end_reason"], "END_OF_INPUT")

    def test_punctuation_does_not_create_one_chunk_per_mark(self):
        raw = "가! 나? 다!? 라... 마~"
        plan = plan_for(raw)
        self.assertLess(len(plan["chunks"]), len(plan["punctuation_plan"]))
        for c in plan["chunks"]:
            self.assertNotIn(c["end_reason"], pl.FORBIDDEN_SPLIT_REASONS)

    def test_question_bang_alias_is_one_shock_rise_with_provenance(self):
        """'?!' 는 '!?' 의 별칭 — 하나의 shock_rise 이며 원문 순서가 보존된다(계약 소비)."""
        for token in ("!?", "?!"):
            plan = plan_for("%s%s %s." % (S1, token, S2))
            shocks = [p for p in plan["punctuation_plan"] if p["kind"] == "shock_rise"]
            self.assertEqual(len(shocks), 1, token)
            self.assertEqual(shocks[0]["raw_token"], token)
            self.assertEqual(len(plan["chunks"]), 1, token)
            self.assertIn(token, plan["chunks"][0]["generation_text"])

    def test_generation_text_keeps_punctuation_even_when_not_native(self):
        plan = plan_for("%s! %s?" % (S1, S2), PROFILE_C_BLIND)
        self.assertIn("!", plan["chunks"][0]["generation_text"])
        self.assertIn("?", plan["chunks"][0]["generation_text"])


# ────────────────────────── B. 감정 블렌딩 전략 ──────────────────────────

class TestEmotionStrategy(unittest.TestCase):

    def test_strategy_a_with_continuous_weights(self):
        plan = plan_for("%s. %s %s." % (S1, HAPPY, S2), PROFILE_A_WEIGHTS)
        st = plan["emotion_strategy"]
        self.assertEqual(st["strategy"], "single_call_continuous")
        self.assertEqual(st["reason"], "CONTINUOUS_WEIGHTS_SUPPORTED")
        self.assertTrue(st["weights_emitted"])
        self.assertFalse(st["degraded"])
        self.assertEqual(len(plan["chunks"]), 1)

    def test_strategy_a_target_trajectory_matches_the_brief(self):
        plan = plan_for("%s. %s %s." % (S1, HAPPY, S2), PROFILE_A_WEIGHTS)
        self.assertEqual(plan["emotion_strategy"]["target_trajectory"],
                         [[100, 0], [70, 30], [30, 70], [0, 100]])
        tr = plan["chunks"][0]["emotion_transitions"][0]
        self.assertEqual([w["prev_pct"] for w in tr["weights"]], [100, 70, 30, 0])
        self.assertEqual([w["new_pct"] for w in tr["weights"]], [0, 30, 70, 100])
        self.assertEqual(sum(w["duration_ms"] for w in tr["weights"]),
                         ex.EMOTION_BLEND_DURATION_MS)

    def test_strategy_a_inline_only_does_not_emit_weights(self):
        plan = plan_for("%s. %s %s." % (S1, HAPPY, S2), PROFILE_A_INLINE)
        st = plan["emotion_strategy"]
        self.assertEqual(st["strategy"], "single_call_continuous")
        self.assertEqual(st["reason"], "INLINE_INSTRUCTION_SUPPORTED")
        self.assertFalse(st["weights_emitted"])
        self.assertEqual(st["trajectory_realization"], "single_call_implicit")
        self.assertIsNone(plan["chunks"][0]["emotion_transitions"][0]["weights"])

    def test_strategy_b_overlap_is_experimental_and_planned(self):
        plan = plan_for("%s. %s %s." % (S1, HAPPY, S2),
                        profile_declared_no_inline_with_overlap())
        st = plan["emotion_strategy"]
        self.assertEqual(st["strategy"], "overlap_context")
        self.assertEqual(st["reason"], "NO_INLINE_SUPPORT_FALLBACK_OVERLAP")
        self.assertTrue(st["experimental"])
        self.assertFalse(st["weights_emitted"])
        self.assertEqual(plan["chunks"][0]["end_reason"], "EMOTION_STRATEGY_OVERLAP")
        ctx = plan["chunks"][1]["preceding_context"]
        self.assertEqual(ctx["overlap_source_chunk"], 0)
        self.assertGreater(ctx["overlap_ms"], 0)
        self.assertTrue(ctx["experimental"])
        self.assertIn("EMOTION_OVERLAP_EXPERIMENTAL", [d["code"] for d in plan["degradations"]])

    def test_strategy_c_hard_join_marks_result_degraded(self):
        plan = plan_for("%s. %s %s." % (S1, HAPPY, S2), profile_declared_nothing())
        st = plan["emotion_strategy"]
        self.assertEqual(st["strategy"], "hard_join")
        self.assertEqual(st["reason"], "NO_CONTEXT_SUPPORT_LAST_RESORT")
        self.assertTrue(st["degraded"])
        self.assertTrue(plan["degraded"])
        self.assertTrue(plan["chunks"][1]["degraded"])
        self.assertIn("EMOTION_HARD_JOIN", [d["code"] for d in plan["degradations"]])

    def test_unverified_capability_never_selects_a_higher_strategy(self):
        plan = plan_for("%s. %s %s." % (S1, HAPPY, S2), PROFILE_C_BLIND)
        st = plan["emotion_strategy"]
        self.assertEqual(st["strategy"], "hard_join")
        self.assertEqual(st["reason"], "CAPABILITY_UNVERIFIED_FALLBACK")
        self.assertIn("CAPABILITY_UNVERIFIED", [d["code"] for d in plan["degradations"]])

    def test_weights_are_never_emitted_to_an_engine_that_ignores_them(self):
        ignoring = cap.build_profile(
            "ignores",
            claims={"single_call_long_form": "supported",
                    "continuous_emotion_weights": "supported",
                    "emotion_instruction_text": "supported"},
            evidence={"single_call_long_form": probe("single_call_long_form"),
                      "emotion_instruction_text": probe("emotion_instruction_text"),
                      "continuous_emotion_weights": cap.ProbeEvidence(
                          "continuous_emotion_weights", True, True, False)})
        self.assertEqual(ignoring.state_of("continuous_emotion_weights"), "degraded")
        plan = plan_for("%s. %s %s." % (S1, HAPPY, S2), ignoring)
        self.assertFalse(plan["emotion_strategy"]["weights_emitted"])
        for c in plan["chunks"]:
            for t in c["emotion_transitions"]:
                self.assertIsNone(t["weights"])

    def test_immediate_transition_has_no_blend_trajectory(self):
        raw = "%s. [기쁨|즉시] %s." % (S1, S2)
        plan = plan_for(raw, PROFILE_A_WEIGHTS)
        tr = plan["chunks"][0]["emotion_transitions"][0]
        self.assertEqual(tr["transition_mode"], "immediate")
        self.assertEqual(tr["trajectory_realization"], "immediate")
        self.assertEqual(tr["target_trajectory"], [[0, 100]])
        self.assertEqual(tr["transition_duration_ms"], ex.EMOTION_IMMEDIATE_DURATION_MS)

    def test_mid_sentence_transition_is_deferred_not_split_when_strategy_is_low(self):
        raw = "가 %s 나. %s." % (HAPPY, S2)
        plan = plan_for(raw, PROFILE_C_BLIND)
        codes = [d["code"] for d in plan["degradations"]]
        self.assertIn("MID_UNIT_EMOTION_TRANSITION_DEFERRED", codes)
        for c in plan["chunks"]:
            for t in c["emotion_transitions"]:
                self.assertTrue(t["deferred"])


# ────────────────────────── C. 청크 연속성 ──────────────────────────

class TestContinuity(unittest.TestCase):

    def base_plan(self, **kw):
        return plan_for("%s. %s. %s. %s." % (S1, S2, S3, S4), **kw)

    def test_valid_plan_is_continuity_consistent(self):
        report = pl.validate_plan_continuity(self.base_plan())
        self.assertTrue(report["ok"], report["divergences"][:1])
        self.assertIsNone(report["first_divergent_field"])

    def test_all_chunks_carry_the_identical_fields(self):
        plan = self.base_plan()
        first = plan["chunks"][0]["continuity"]
        for c in plan["chunks"]:
            for f in pl.CONTINUITY_IDENTICAL_FIELDS:
                self.assertEqual(c["continuity"][f], first[f], f)

    def test_validator_names_each_divergent_identical_field_independently(self):
        for field in pl.CONTINUITY_IDENTICAL_FIELDS:
            plan = self.base_plan()
            self.assertGreater(len(plan["chunks"]), 1)
            plan["chunks"][1]["continuity"][field] = "TAMPERED"
            report = pl.validate_plan_continuity(plan)
            self.assertFalse(report["ok"], field)
            self.assertEqual(report["first_divergent_field"], field)
            self.assertEqual(report["first_divergent_chunk_index"], 1)

    def test_validator_catches_a_broken_context_chain(self):
        plan = self.base_plan()
        plan["chunks"][1]["continuity"]["preceding_context_id"] = "wrong"
        report = pl.validate_plan_continuity(plan)
        self.assertEqual(report["first_divergent_field"], "preceding_context_id")
        self.assertEqual(report["divergences"][0]["code"], "CONTEXT_CHAIN_BROKEN")

    def test_validator_catches_a_missing_emotion_state(self):
        plan = self.base_plan()
        plan["chunks"][1]["continuity"]["entry_emotion_id"] = ""
        report = pl.validate_plan_continuity(plan)
        self.assertEqual(report["first_divergent_field"], "entry_emotion_id")
        self.assertEqual(report["divergences"][0]["code"], "EMOTION_STATE_MISSING")

    def test_validator_catches_a_broken_emotion_chain(self):
        plan = self.base_plan()
        plan["chunks"][1]["continuity"]["entry_emotion_id"] = "angry"
        report = pl.validate_plan_continuity(plan)
        self.assertEqual(report["first_divergent_field"], "entry_emotion_id")
        self.assertEqual(report["divergences"][0]["code"], "EMOTION_STATE_BROKEN")

    def test_validator_catches_a_seed_policy_violation(self):
        plan = self.base_plan()
        plan["chunks"][1]["continuity"]["seed_value"] = 999999
        report = pl.validate_plan_continuity(plan)
        self.assertEqual(report["first_divergent_field"], "seed_value")
        self.assertEqual(report["divergences"][0]["code"], "SEED_POLICY_VIOLATED")

    def test_every_continuity_field_is_covered_by_the_validator(self):
        report = pl.validate_plan_continuity(self.base_plan())
        self.assertEqual(tuple(report["checked_fields"]), pl.CONTINUITY_FIELD_ORDER)

    def test_emotion_transition_at_a_boundary_is_not_a_continuity_break(self):
        plan = plan_for("%s. %s. %s. %s %s." % (S1, S2, S3, HAPPY, S4), PROFILE_A_WEIGHTS)
        self.assertGreater(len(plan["chunks"]), 1)
        self.assertTrue(pl.validate_plan_continuity(plan)["ok"])
        self.assertTrue(plan["chunks"][1]["entry_transitions"])

    def test_seed_policies_are_deterministic_and_recorded(self):
        fixed = self.base_plan(seed_policy="fixed", seed_value=11)
        self.assertEqual([c["continuity"]["seed_value"] for c in fixed["chunks"]],
                         [11] * len(fixed["chunks"]))
        derived = self.base_plan(seed_policy="per_chunk_derived", seed_value=100)
        self.assertEqual([c["continuity"]["seed_value"] for c in derived["chunks"]],
                         [100 + i for i in range(len(derived["chunks"]))])
        self.assertTrue(pl.validate_plan_continuity(derived)["ok"])

    def test_random_seed_is_reported_as_a_degradation_not_silently(self):
        plan = self.base_plan(seed_policy="random")
        self.assertIn("NON_DETERMINISTIC_SEED", [d["code"] for d in plan["degradations"]])
        self.assertTrue(pl.validate_plan_continuity(plan)["ok"])

    def test_x_vector_only_degradation_is_explicit_never_silent(self):
        plan = self.base_plan(reference_mode="x_vector_only")
        self.assertIn("REFERENCE_X_VECTOR_ONLY", [d["code"] for d in plan["degradations"]])
        self.assertTrue(plan["continuity"]["reference_degraded"])
        self.assertTrue(pl.validate_plan_continuity(plan)["reference_degraded"])
        for c in plan["chunks"]:
            self.assertEqual(c["continuity"]["reference_mode"], "x_vector_only")

    def test_icl_reference_is_not_marked_degraded(self):
        plan = self.base_plan(reference_mode="icl")
        self.assertNotIn("REFERENCE_X_VECTOR_ONLY", [d["code"] for d in plan["degradations"]])
        self.assertFalse(plan["continuity"]["reference_degraded"])

    def test_unknown_reference_mode_or_seed_policy_is_rejected(self):
        with self.assertRaises(pl.PlanError):
            settings(reference_mode="guess")
        with self.assertRaises(pl.PlanError):
            settings(seed_policy="vibes")


# ────────────────────────── D. 구두점 실현 ──────────────────────────

class TestPunctuationRendering(unittest.TestCase):

    RAW = "가. 나! 다? 라!? 마... 바~"

    def test_native_and_post_process_are_never_mixed_in_one_record(self):
        for profile in (PROFILE_A_WEIGHTS, PROFILE_C_BLIND):
            plan = plan_for(self.RAW, profile)
            for p in plan["punctuation_plan"]:
                self.assertIn(p["realization"], pl.PUNCTUATION_REALIZATIONS)
                if p["realization"] == "model_native":
                    self.assertIsNotNone(p["native_instruction"])
                    self.assertIsNone(p["post_process"])
                elif p["realization"] == "post_process":
                    self.assertIsNone(p["native_instruction"])
                    self.assertIsNotNone(p["post_process"])
                else:
                    self.assertIsNone(p["native_instruction"])
                    self.assertIsNone(p["post_process"])
                    self.assertIsNotNone(p["unsupported_reason"])

    def test_post_process_never_claims_the_semantic_meaning(self):
        plan = plan_for(self.RAW, PROFILE_C_BLIND)
        post = [p for p in plan["punctuation_plan"] if p["realization"] == "post_process"]
        self.assertTrue(post)
        for p in post:
            self.assertFalse(p["semantic_claim"])
            self.assertFalse(p["post_process"]["applies_globally"])

    def test_model_native_is_the_only_realization_that_claims_meaning(self):
        plan = plan_for(self.RAW, PROFILE_A_WEIGHTS)
        for p in plan["punctuation_plan"]:
            self.assertEqual(p["semantic_claim"], p["realization"] == "model_native")

    def test_unsupported_punctuation_is_marked_not_dropped(self):
        plan = plan_for(self.RAW, PROFILE_C_BLIND)
        unsupported = [p for p in plan["punctuation_plan"] if p["realization"] == "unsupported"]
        self.assertTrue(unsupported)
        for p in unsupported:
            self.assertIn(p["unsupported_reason"], pl.UNSUPPORTED_PROSODY_REASONS)
            # 이벤트가 사라지지 않았고, 원문 글자도 텍스트에 남아 있다.
            self.assertIsNotNone(p["raw_token"])
            self.assertIn(p["raw_token"], plan["chunks"][p["chunk_index"]]["generation_text"])
        self.assertEqual(len(plan["punctuation_plan"]), len(ex.parse_expressive_timeline(
            self.RAW, mode="expressive_v3")["timeline"]["local_prosody"]))

    def test_every_event_is_assigned_to_a_chunk(self):
        for profile in (PROFILE_A_WEIGHTS, PROFILE_C_BLIND):
            plan = plan_for(self.RAW, profile)
            for p in plan["punctuation_plan"]:
                self.assertIsNotNone(p["chunk_index"])
                self.assertLess(p["chunk_index"], len(plan["chunks"]))

    def test_prosody_event_is_never_a_chunk_boundary_per_contract(self):
        plan = plan_for(self.RAW, PROFILE_A_WEIGHTS)
        for p in plan["punctuation_plan"]:
            self.assertFalse(p["is_chunk_boundary"])
            self.assertEqual(p["is_chunk_boundary"], ex.LOCAL_PROSODY_IS_CHUNK_BOUNDARY)

    def test_vowel_extend_uses_the_capability_verdict_not_a_local_rule(self):
        plan = plan_for("좋아~", PROFILE_C_BLIND)
        rec = [p for p in plan["punctuation_plan"] if p["kind"] == "vowel_extend"][0]
        self.assertIn("vowel_extend", rec)
        self.assertIn(rec["vowel_extend"]["classification"], cap.VOWEL_EXTEND_ALL_CLASSES)
        self.assertFalse(rec["vowel_extend"]["natural_extension_claimed"])

    def test_final_consonant_never_gets_a_stretch_or_repeat_op(self):
        # '산~' 은 받침이 있다 → 구 계약은 final_consonant, 새 계약은 (non_)sustainable_final.
        plan = plan_for("산~", PROFILE_C_BLIND)
        rec = [p for p in plan["punctuation_plan"] if p["kind"] == "vowel_extend"][0]
        self.assertEqual(rec["realization"], "unsupported")
        self.assertIsNone(rec["post_process"])
        self.assertTrue(any(u["code"].startswith("VOWEL_EXTEND") for u in plan["unsupported"]))

    def test_open_vowel_gets_a_vowel_only_stretch(self):
        plan = plan_for("좋아~", PROFILE_C_BLIND)
        rec = [p for p in plan["punctuation_plan"] if p["kind"] == "vowel_extend"][0]
        self.assertEqual(rec["realization"], "post_process")
        self.assertEqual(rec["post_process"]["op"], "final_vowel_time_stretch")
        self.assertIsNotNone(rec["post_process"]["target_vowel"])

    def test_summary_counts_the_three_realizations(self):
        plan = plan_for(self.RAW, PROFILE_C_BLIND)
        s = plan["summary"]
        self.assertEqual(s["native_punctuation_count"] + s["post_process_punctuation_count"]
                         + s["unsupported_punctuation_count"], len(plan["punctuation_plan"]))


# ────────────────────────── E. 웃음 ──────────────────────────

class TestLaughter(unittest.TestCase):

    def test_laughter_never_becomes_literal_text(self):
        for raw in ("%s %s." % (LAUGH, S1), "%s %s %s." % (S1, LAUGH, S2), "%s. %s" % (S1, LAUGH)):
            plan = plan_for(raw, PROFILE_A_WEIGHTS)
            self.assertTrue(plan["laugh_manifest"])
            for c in plan["chunks"]:
                self.assertNotIn("ㅋ", c["generation_text"])
                self.assertNotIn(LAUGH, c["generation_text"])
            for m in plan["laugh_manifest"]:
                self.assertTrue(m["never_literal_text"])

    def test_laugh_is_never_a_chunk_boundary(self):
        plan = plan_for("%s %s %s." % (S1, LAUGH, S2), PROFILE_A_WEIGHTS)
        self.assertEqual(len(plan["chunks"]), 1)

    def test_manifest_fields_are_exactly_the_contract(self):
        plan = plan_for("%s %s." % (LAUGH, S1), PROFILE_A_WEIGHTS)
        for m in plan["laugh_manifest"]:
            self.assertEqual(tuple(m.keys()), pl.LAUGH_MANIFEST_FIELDS)
            self.assertEqual(m["event_kind"], pl.LAUGH_EVENT_KIND)

    def test_leading_laugh_stays_in_one_breath_with_the_following_speech(self):
        plan = plan_for("%s %s." % (LAUGH, S1), PROFILE_A_WEIGHTS)
        m = plan["laugh_manifest"][0]
        self.assertEqual(m["position"], "leading")
        self.assertEqual(m["position_behaviour"], "laugh_then_speech_one_breath")
        self.assertEqual(m["gap_ms"], 0)
        self.assertEqual(len(plan["chunks"]), 1)

    def test_inline_laugh_is_short_and_keeps_the_same_state(self):
        raw = "%s %s %s %s." % (HAPPY, S1, LAUGH, S2)
        plan = plan_for(raw, PROFILE_A_WEIGHTS)
        m = plan["laugh_manifest"][0]
        self.assertEqual(m["position"], "inline")
        self.assertEqual(m["position_behaviour"], "short_laugh_continue_same_state")
        self.assertLessEqual(m["duration_hint"], pl.LAUGH_INLINE_MAX_MS)
        self.assertEqual(m["carried_emotion_id"], "happy")

    def test_trailing_laugh_connects_to_the_sentence_final_emotion(self):
        raw = "%s %s. %s" % (SAD, S1, LAUGH)
        plan = plan_for(raw, PROFILE_A_WEIGHTS)
        m = plan["laugh_manifest"][0]
        self.assertEqual(m["position"], "trailing")
        self.assertEqual(m["position_behaviour"],
                         "connect_sentence_final_emotion_natural_decay")
        self.assertEqual(m["carried_emotion_id"], "sad")

    def test_laugh_never_uses_a_hard_join_and_requires_checks(self):
        plan = plan_for("%s %s %s." % (S1, LAUGH, S2), PROFILE_A_WEIGHTS)
        m = plan["laugh_manifest"][0]
        self.assertEqual(m["join_policy"], "no_hard_join")
        self.assertEqual(tuple(m["required_checks"]), pl.LAUGH_REQUIRED_CHECKS)
        self.assertGreater(m["optional_overlap_blend_ms"], 0)

    def test_asr_parity_excludes_laughter_as_words_but_keeps_it_verifiable(self):
        plan = plan_for("%s %s %s." % (S1, LAUGH, S2), PROFILE_A_WEIGHTS)
        parity = plan["asr_parity"]
        self.assertFalse(parity["compare_laughter_as_words"])
        self.assertTrue(parity["verify_laugh_position"])
        self.assertTrue(parity["verify_laugh_presence"])
        self.assertEqual(len(parity["excluded_ranges"]), len(plan["laugh_manifest"]))
        for r in parity["excluded_ranges"]:
            self.assertIsInstance(r["start_cp"], int)
            self.assertIsInstance(r["end_cp"], int)
        for m in plan["laugh_manifest"]:
            self.assertFalse(m["asr_compare_as_words"])
            self.assertTrue(m["verify_position"])
            self.assertTrue(m["verify_presence"])

    def test_laugh_strategy_preference_order_a_to_d(self):
        native = profile_with("l_a", ("nonverbal_laugh_instruction",))
        self.assertEqual(pl.select_laugh_strategy(native)["strategy"], "model_native_instruction")
        same = profile_with("l_b", ("laugh_same_speaker_conditioning",))
        self.assertEqual(pl.select_laugh_strategy(same)["strategy"], "same_conditioning_candidate")
        cached = profile_with("l_c", ("cached_laugh_sample",))
        sel = pl.select_laugh_strategy(cached)
        self.assertEqual(sel["strategy"], "cached_sample")
        self.assertTrue(sel["degraded"])
        transform = profile_with("l_d", ("voice_conditioned_laugh_transform",))
        sel = pl.select_laugh_strategy(transform)
        self.assertEqual(sel["strategy"], "voice_conditioned_transform")
        self.assertTrue(sel["experimental"])

    def test_no_available_laugh_strategy_is_reported_not_dropped(self):
        plan = plan_for("%s %s." % (LAUGH, S1), PROFILE_C_BLIND)
        self.assertEqual(len(plan["laugh_manifest"]), 1)
        self.assertIsNone(plan["laugh_manifest"][0]["strategy"])
        self.assertEqual(plan["laugh_manifest"][0]["strategy_reason"], "NO_STRATEGY_AVAILABLE")
        self.assertIn("LAUGH_NO_STRATEGY", [u["code"] for u in plan["unsupported"]])

    def test_cached_and_transform_strategies_are_recorded_as_degradations(self):
        cached = plan_for("%s %s." % (LAUGH, S1), profile_with("l_c", ("cached_laugh_sample",)))
        self.assertIn("LAUGH_CACHED_SAMPLE", [d["code"] for d in cached["degradations"]])
        transform = plan_for("%s %s." % (LAUGH, S1),
                             profile_with("l_d", ("voice_conditioned_laugh_transform",)))
        self.assertIn("LAUGH_VOICE_TRANSFORM_EXPERIMENTAL",
                      [d["code"] for d in transform["degradations"]])


# ────────────────────────── F. 금지 항목 ──────────────────────────

class TestForbiddenOperations(unittest.TestCase):
    """금지 목록 1개당 최소 1개 — 계획이 그것을 '지시하지 않음' 을 증명한다."""

    CORPUS = (
        "%s. %s. %s. %s." % (S1, S2, S3, S4),
        "%s.\n\n%s." % (S1, S2),
        "가. 나! 다? 라!? 마... 바~ 산~",
        "%s %s %s %s." % (HAPPY, S1, LAUGH, S2),
        "%s. %s %s." % (S1, PAUSE, S2),
        COMMA_LINE,
    )
    PROFILES = (PROFILE_A_WEIGHTS, PROFILE_A_INLINE, PROFILE_B_OVERLAP, PROFILE_C_BLIND)

    def all_plans(self):
        for raw in self.CORPUS:
            for profile in self.PROFILES:
                yield raw, profile, plan_for(raw, profile)

    def test_audit_passes_for_the_whole_corpus(self):
        for raw, profile, plan in self.all_plans():
            report = pl.audit_forbidden(plan)
            self.assertTrue(report["ok"], (profile.engine_id, report["violations"][:1]))

    def test_no_blanket_fade_in_at_every_chunk_start(self):
        for _raw, _p, plan in self.all_plans():
            for c in plan["chunks"]:
                self.assertNotIn("fade_in", str(c.get("end_reason_detail")))
            ops = self._ops(plan)
            self.assertNotIn("chunk_start_fade_in", ops)

    def test_no_blanket_first_syllable_trim(self):
        for _raw, _p, plan in self.all_plans():
            self.assertNotIn("first_syllable_trim", self._ops(plan))

    def test_no_global_denoise_or_noise_gate(self):
        for _raw, _p, plan in self.all_plans():
            ops = self._ops(plan)
            self.assertNotIn("global_denoise", ops)
            self.assertNotIn("noise_gate", ops)

    def test_no_global_pitch_or_formant_normalisation(self):
        for _raw, _p, plan in self.all_plans():
            ops = self._ops(plan)
            self.assertNotIn("global_pitch_normalize", ops)
            self.assertNotIn("global_formant_normalize", ops)
            for p in plan["punctuation_plan"]:
                if p["post_process"]:
                    self.assertFalse(p["post_process"]["applies_globally"])

    def test_no_consonant_time_stretching_of_any_kind(self):
        for _raw, _p, plan in self.all_plans():
            ops = self._ops(plan)
            self.assertNotIn("consonant_time_stretch", ops)
            self.assertNotIn("final_consonant_time_stretch", ops)
            self.assertNotIn("final_consonant_repeat", ops)

    def test_no_new_chunk_per_punctuation_mark(self):
        raw = "가! 나? 다!? 라... 마~"
        for profile in self.PROFILES:
            plan = plan_for(raw, profile)
            self.assertLess(len(plan["chunks"]), len(plan["punctuation_plan"]), profile.engine_id)

    def test_unsupported_capability_is_never_reported_as_success(self):
        plan = plan_for("%s. %s %s." % (S1, HAPPY, S2), PROFILE_C_BLIND)
        record = plan["capability"]
        self.assertEqual(set(record["unverified_features"]), set(cap.CAPABILITY_FEATURES))
        for state in record["features"].values():
            self.assertNotEqual(state, "supported")
        self.assertTrue(plan["degraded"])
        self.assertFalse(plan["multi_sentence_grouping_verified"])

    def test_no_automatic_retry_anywhere_in_the_plan(self):
        for _raw, _p, plan in self.all_plans():
            self.assertEqual(plan["retry_policy"], "none")
            for c in plan["chunks"]:
                self.assertEqual(c["retry_policy"], "none")

    def test_generation_limit_is_never_raised_to_make_something_fit(self):
        plan = plan_for(COMMA_LINE, count_tokens=word_tokens, max_tokens=2)
        self.assertFalse(plan["generation_limit_raise_allowed"])
        for c in plan["chunks"]:
            self.assertFalse(c["generation_limit_raised"])
            self.assertEqual(c["max_tokens"], 2)

    def test_forbidden_split_reasons_never_appear(self):
        for _raw, _p, plan in self.all_plans():
            for c in plan["chunks"]:
                self.assertIn(c["end_reason"], pl.SPLIT_REASON_CODES)
                self.assertNotIn(c["end_reason"], pl.FORBIDDEN_SPLIT_REASONS)

    def test_audit_detects_an_injected_forbidden_op(self):
        """감사기가 실제로 잡아내는지(테스트가 무의미하지 않은지) 역검증."""
        plan = plan_for("나!", PROFILE_C_BLIND)
        target = [p for p in plan["punctuation_plan"] if p["post_process"]][0]
        target["post_process"]["op"] = "global_denoise"
        report = pl.audit_forbidden(plan)
        self.assertFalse(report["ok"])
        self.assertEqual(report["violations"][0]["kind"], "post_process_op")

    def test_audit_detects_a_mixed_native_and_post_process_record(self):
        plan = plan_for("나!", PROFILE_C_BLIND)
        target = [p for p in plan["punctuation_plan"] if p["post_process"]][0]
        target["native_instruction"] = {"kind": "emphasis"}
        kinds = [v["kind"] for v in pl.audit_forbidden(plan)["violations"]]
        self.assertIn("native_and_post_process_mixed", kinds)

    def _ops(self, plan):
        ops = set()
        for p in plan["punctuation_plan"]:
            if p["post_process"]:
                ops.add(p["post_process"]["op"])
        return ops


# ────────────────────────── G. 계약 소비 / 입력 검증 ──────────────────────────

class TestContractConsumption(unittest.TestCase):

    def test_generation_limit_authority_is_imported_not_copied(self):
        import generation_limit
        s = settings(max_tokens=None)
        self.assertEqual(s.effective_max_tokens(), generation_limit.max_segment_tokens())

    def test_long_terminal_threshold_comes_from_the_contract_table(self):
        self.assertEqual(pl.LONG_TERMINAL_MIN_DURATION_MS, ex.FADE_END_DURATION_MS_BY_COUNT[4])

    def test_terminal_prosody_kinds_are_a_subset_of_the_contract_enum(self):
        self.assertTrue(set(pl.TERMINAL_PROSODY_KINDS) <= set(ex.LOCAL_PROSODY_KINDS))

    def test_parser_errors_produce_no_plan(self):
        res = pl.plan_from_raw("[없는태그]", settings(), PROFILE_A_WEIGHTS,
                               pl.approximate_count_tokens)
        self.assertFalse(res["ok"])
        self.assertIsNone(res["plan"])
        self.assertTrue(res["errors"])

    def test_legacy_mode_produces_no_expressive_events(self):
        res = pl.plan_from_raw("가... 나~", settings(), PROFILE_A_WEIGHTS,
                               pl.approximate_count_tokens, mode="legacy_v2")
        self.assertTrue(res["ok"])
        self.assertEqual(res["plan"]["punctuation_plan"], [])
        self.assertEqual(res["mode"], "legacy_v2")

    def test_count_tokens_must_be_injected(self):
        parsed = ex.parse_expressive_timeline("가.", mode="expressive_v3")
        with self.assertRaises(pl.PlanError):
            pl.build_plan(parsed["timeline"], settings(), PROFILE_A_WEIGHTS, None)

    def test_token_counter_identity_is_recorded_in_the_plan(self):
        plan = plan_for("%s." % S1)
        self.assertEqual(plan["continuity"]["token_counter_id"], "test_char_counter")

    def test_plan_is_deterministic(self):
        raw = "%s. %s %s. %s %s." % (S1, HAPPY, S2, LAUGH, S3)
        a = plan_for(raw, PROFILE_A_WEIGHTS)
        b = plan_for(raw, PROFILE_A_WEIGHTS)
        self.assertEqual([c["generation_text"] for c in a["chunks"]],
                         [c["generation_text"] for c in b["chunks"]])
        self.assertEqual([c["continuity"] for c in a["chunks"]],
                         [c["continuity"] for c in b["chunks"]])

    def test_empty_input_produces_an_empty_but_valid_plan(self):
        plan = plan_for("")
        self.assertEqual(plan["chunks"], [])
        self.assertTrue(plan["ok"])
        self.assertTrue(pl.validate_plan_continuity(plan)["ok"])


# ------------- E-2. 웃음: '전략 없음' 은 절대 '지원됨' 이 되지 않는다 -------------

LAUGH_FEATURES = ("nonverbal_laugh_instruction", "laugh_same_speaker_conditioning",
                  "cached_laugh_sample", "voice_conditioned_laugh_transform")


def profile_laugh_probe_not_honored():
    """네 전략 전부 '입력은 받았지만 효과 없음'(accepted=True, honored=False) -> degraded."""
    return cap.build_profile(
        "laugh_ignored",
        claims={f: "supported" for f in LAUGH_FEATURES},
        evidence={f: cap.ProbeEvidence(f, True, True, False) for f in LAUGH_FEATURES})


def profile_laugh_declared_unsupported():
    """엔진이 네 전략 전부 못 한다고 스스로 선언."""
    return cap.build_profile(
        "laugh_declared_no",
        claims={f: "unsupported" for f in LAUGH_FEATURES})


class TestLaughNoStrategyIsNeverSupported(unittest.TestCase):
    """LAUGH_NO_STRATEGY 가 '지원됨' 으로 새는 통로가 없음을 고정한다.

    ⚠️ 현재 동작이 이미 정직하다 — 이 클래스는 고치는 것이 아니라 '고정' 한다.
    """

    def _profiles(self):
        return (PROFILE_C_BLIND, profile_laugh_probe_not_honored(),
                profile_laugh_declared_unsupported())

    def test_probe_accepted_but_ignored_is_not_a_strategy(self):
        """'입력을 받아줬다' 는 성공이 아니다 — degraded 는 전략으로 쓰이지 않는다."""
        prof = profile_laugh_probe_not_honored()
        for f in LAUGH_FEATURES:
            self.assertEqual(prof.state_of(f), "degraded", f)
            self.assertFalse(prof.is_supported(f), f)
        sel = pl.select_laugh_strategy(prof)
        self.assertIsNone(sel["strategy"])
        self.assertEqual(sel["reason"], "NO_STRATEGY_AVAILABLE")
        # 캐시 샘플이 '있다' 고 알려줘도 기능이 supported 가 아니면 전략이 되지 않는다.
        self.assertIsNone(pl.select_laugh_strategy(prof, cached_sample_available=True)["strategy"])

    def test_declared_unsupported_is_not_a_strategy(self):
        prof = profile_laugh_declared_unsupported()
        for f in LAUGH_FEATURES:
            self.assertEqual(prof.state_of(f), "unsupported", f)
        sel = pl.select_laugh_strategy(prof)
        self.assertIsNone(sel["strategy"])
        self.assertEqual(sel["reason"], "NO_STRATEGY_AVAILABLE")
        self.assertIsNone(pl.select_laugh_strategy(prof, cached_sample_available=True)["strategy"])

    def test_no_strategy_is_never_reportable_as_supported(self):
        """전략이 없을 때 어떤 웃음 기능도 '지원됨' 으로 보고할 수 없다(정직성 검사가 막는다)."""
        for prof in self._profiles():
            self.assertIsNone(pl.select_laugh_strategy(prof)["strategy"], prof.engine_id)
            for f in LAUGH_FEATURES:
                self.assertFalse(cap.is_usable(prof.state_of(f)), "%s/%s" % (prof.engine_id, f))
                with self.assertRaises(cap.CapabilityHonestyError):
                    cap.assert_no_false_success(prof, [f])

    def test_no_strategy_reaches_the_consumer_as_unsupported_code(self):
        """사유 코드가 소비자에게 닿는다 — unsupported 목록 + 매니페스트 양쪽."""
        for prof in self._profiles():
            plan = plan_for("%s %s." % (LAUGH, S1), prof)
            self.assertEqual(len(plan["laugh_manifest"]), 1, prof.engine_id)
            m = plan["laugh_manifest"][0]
            self.assertIsNone(m["strategy"], prof.engine_id)
            self.assertEqual(m["strategy_reason"], "NO_STRATEGY_AVAILABLE")
            self.assertFalse(m["experimental"])
            codes = [u["code"] for u in plan["unsupported"]]
            self.assertIn("LAUGH_NO_STRATEGY", codes, prof.engine_id)
            self.assertIn("LAUGH_NO_STRATEGY", pl.UNSUPPORTED_CODES)
            # '되긴 된다' 는 뜻의 강등 목록으로 새지 않는다.
            deg = [d["code"] for d in plan["degradations"]]
            self.assertNotIn("LAUGH_CACHED_SAMPLE", deg, prof.engine_id)
            self.assertNotIn("LAUGH_VOICE_TRANSFORM_EXPERIMENTAL", deg, prof.engine_id)
            # 차단 이슈는 아니므로 계획 자체는 만들어진다(조용히 사라지지 않는다).
            self.assertNotIn("LAUGH_NO_STRATEGY", pl.BLOCKING_UNSUPPORTED_CODES)

    def test_no_strategy_laughter_still_never_renders_as_letters(self):
        """전략이 없어도 웃음이 글자로 새지 않는다 — 생성 텍스트에 음절이 들어가지 않는다."""
        for prof in self._profiles():
            for raw in ("%s %s." % (LAUGH, S1), "%s %s %s." % (S1, LAUGH, S2),
                        "%s. %s" % (S1, LAUGH)):
                plan = plan_for(raw, prof)
                self.assertTrue(plan["laugh_manifest"], prof.engine_id)
                for m in plan["laugh_manifest"]:
                    self.assertTrue(m["never_literal_text"], prof.engine_id)
                    self.assertFalse(m["asr_compare_as_words"])
                    self.assertTrue(m["verify_presence"])
                for c in plan["chunks"]:
                    self.assertNotIn("ㅋ", c["generation_text"])
                    self.assertNotIn(LAUGH, c["generation_text"])
                self.assertFalse(plan["asr_parity"]["compare_laughter_as_words"])

    def test_sampler_mirrors_the_engine_verdict_for_laughter(self):
        """엔진이 '전략 없음' 인 동안 샘플러 웃음 행은 unsupported/LAUGH_NO_STRATEGY 다."""
        import emotion_sampler as es
        for prof in self._profiles():
            self.assertIsNone(pl.select_laugh_strategy(prof)["strategy"])
        for r in [x for x in es.EMOTION_SAMPLE_ROWS if x["family"] == "laugh"]:
            c = es.capability_for_row(r["row_id"])
            self.assertEqual(c["state"], "unsupported", r["row_id"])
            self.assertEqual(c["reason"], "LAUGH_NO_STRATEGY", r["row_id"])
            self.assertFalse(es.is_capability_usable(c["state"]), r["row_id"])
        self.assertIn("LAUGH_NO_STRATEGY", es.EMOTION_SAMPLE_STATE_REASONS["unsupported"])


if __name__ == "__main__":
    unittest.main()
