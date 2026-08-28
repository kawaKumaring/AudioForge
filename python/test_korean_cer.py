# -*- coding: utf-8 -*-
"""korean_cer 단위 테스트 — 실제 ASR·음성·GPU 없음(합성 문자열만).

검증: 편집거리 분해(손으로 검산) / 정규화 파이프라인 단계·버전 / provenance 필수 /
표현 언어 계약(expressive_timeline v3) 소비 — 토큰 정체·별칭·상한·지문이 계약에서 오는지 /
표현 이벤트 분리(문자 CER 불변 + 이벤트 누락·유령 탐지) / identity 결정(크기 제외, 모드 포함) /
AST 소스 스팬 기반 위치 / 음절 vs 자모 이름 분리 / 집계와 pooling 금지 /
**금지 이름 스캔** / 결과 레코드 위생(경로·오디오 없음).
"""

import json
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import korean_cer as kc
import expressive_timeline as et


PROV = kc.AsrProvenance.for_current_pipeline(
    asr_model_name="mock-asr",
    asr_model_version="0.0.0-synthetic",
    asr_model_fingerprint="sha256:deadbeef",
)


def _syll(text):
    return kc.syllable_units(text)


# ────────────────────────── 편집거리 분해 ──────────────────────────
class EditDecompositionTest(unittest.TestCase):
    """손으로 검산한 사례. 비율만이 아니라 S/D/I/N 이 모두 맞아야 한다."""

    def test_identical_strings(self):
        c = kc.edit_counts(_syll("가나다"), _syll("가나다"))
        self.assertEqual((c.substitutions, c.deletions, c.insertions), (0, 0, 0))
        self.assertEqual(c.ref_length, 3)
        self.assertEqual(c.error_rate, 0.0)

    def test_single_substitution(self):
        c = kc.edit_counts(_syll("가나다"), _syll("가라다"))
        self.assertEqual((c.substitutions, c.deletions, c.insertions), (1, 0, 0))
        self.assertAlmostEqual(c.error_rate, 1 / 3)

    def test_single_deletion(self):
        c = kc.edit_counts(_syll("가나다"), _syll("가다"))
        self.assertEqual((c.substitutions, c.deletions, c.insertions), (0, 1, 0))
        self.assertEqual(c.hyp_length, 2)
        self.assertAlmostEqual(c.error_rate, 1 / 3)

    def test_single_insertion(self):
        c = kc.edit_counts(_syll("가나다"), _syll("가나다라"))
        self.assertEqual((c.substitutions, c.deletions, c.insertions), (0, 0, 1))
        self.assertAlmostEqual(c.error_rate, 1 / 3)

    def test_mixed_hand_checked(self):
        # ref 가나다라마 (5) / hyp 가X다라   → 나→X 치환 1, 마 삭제 1
        c = kc.edit_counts(_syll("가나다라마"), _syll("가하다라"))
        self.assertEqual((c.substitutions, c.deletions, c.insertions), (1, 1, 0))
        self.assertEqual(c.ref_length, 5)
        self.assertEqual(c.total_errors, 2)
        self.assertAlmostEqual(c.error_rate, 0.4)

    def test_both_empty_is_zero(self):
        c = kc.edit_counts((), ())
        self.assertEqual(c.total_errors, 0)
        self.assertEqual(c.ref_length, 0)
        self.assertEqual(c.error_rate, 0.0)

    def test_empty_reference_with_hypothesis_is_undefined(self):
        """N==0 인데 hyp 가 있으면 비율은 정의되지 않는다 — 0 이나 inf 로 속이지 않는다."""
        c = kc.edit_counts((), _syll("가나"))
        self.assertEqual((c.substitutions, c.deletions, c.insertions), (0, 0, 2))
        self.assertEqual(c.ref_length, 0)
        self.assertIsNone(c.error_rate)

    def test_empty_hypothesis_is_total_deletion(self):
        c = kc.edit_counts(_syll("가나"), ())
        self.assertEqual((c.substitutions, c.deletions, c.insertions), (0, 2, 0))
        self.assertEqual(c.error_rate, 1.0)

    def test_total_equals_sum_invariant(self):
        pairs = [("", ""), ("가", ""), ("", "가"), ("안녕하세요", "안뇽하세오"),
                 ("abc123", "abd124"), ("서울특별시", "서울시")]
        for ref, hyp in pairs:
            c = kc.edit_counts(_syll(ref), _syll(hyp))
            self.assertEqual(c.total_errors,
                             c.substitutions + c.deletions + c.insertions,
                             msg="{0}/{1}".format(ref, hyp))

    def test_tie_break_is_deterministic(self):
        """같은 비용의 경로가 여러 개여도 S>D>I 고정 tie-break 로 항상 같은 분해."""
        first = kc.edit_counts(_syll("가나"), _syll("다라"))
        for _ in range(5):
            again = kc.edit_counts(_syll("가나"), _syll("다라"))
            self.assertEqual(first, again)
        self.assertEqual(first.substitutions, 2)


# ────────────────────────── 정규화 파이프라인 ──────────────────────────
class NormalizationPipelineTest(unittest.TestCase):

    def test_declared_step_order(self):
        self.assertEqual(
            kc.pipeline_step_names(),
            ("unicode_nfc", "strip_expression_events", "strip_punctuation",
             "lower_latin", "remove_whitespace"))

    def test_event_strip_runs_before_punctuation_strip(self):
        """!, ?, dot-run 은 그 자체가 문장부호다 — 먼저 지우면 이벤트를 영영 못 본다."""
        names = kc.pipeline_step_names()
        self.assertLess(names.index("strip_expression_events"),
                        names.index("strip_punctuation"))

    def test_version_constant_is_declared(self):
        self.assertTrue(kc.NORMALIZATION_VERSION.strip())
        self.assertIn("2.0.0", kc.NORMALIZATION_VERSION)

    def test_result_carries_version(self):
        self.assertEqual(kc.normalize("가").version, kc.NORMALIZATION_VERSION)

    def test_describe_pipeline_is_inspectable(self):
        described = kc.describe_pipeline()
        self.assertEqual(len(described), len(kc.NORMALIZATION_PIPELINE))
        for i, row in enumerate(described):
            self.assertEqual(row["order"], i)
            self.assertTrue(row["description"].strip())

    def test_trace_is_step_by_step_and_chained(self):
        r = kc.normalize("안녕하세요! WAV 파일 ㅋㅋ")
        self.assertEqual(r.step_names(), kc.pipeline_step_names())
        self.assertEqual(r.traces[0].before, "안녕하세요! WAV 파일 ㅋㅋ")
        for prev, nxt in zip(r.traces, r.traces[1:]):
            self.assertEqual(prev.after, nxt.before)   # 단계가 실제로 이어져야 한다
        self.assertEqual(r.traces[-1].after, r.text)

    def test_step_nfc_composes_decomposed_hangul(self):
        import unicodedata
        composed = "한국어"
        decomposed = unicodedata.normalize("NFD", composed)
        self.assertNotEqual(composed, decomposed)
        self.assertEqual(kc.normalize_text(decomposed), kc.normalize_text(composed))
        c = kc.edit_counts(_syll(kc.normalize_text(decomposed)),
                           _syll(kc.normalize_text(composed)))
        self.assertEqual(c.total_errors, 0)

    def test_step_strip_punctuation_keeps_content_bearing(self):
        self.assertEqual(kc.normalize_text("가, 나. 다;"), "가나다")
        self.assertEqual(kc.normalize_text("50 %"), "50%")       # % 는 예외로 남김
        self.assertEqual(kc.normalize_text("25 ℃"), "25℃")       # S* 는 애초에 안 지움
        self.assertIn("%", kc.CONTENT_PUNCTUATION_KEPT)

    def test_step_lower_latin(self):
        self.assertEqual(kc.normalize_text("WAV 파일"), kc.normalize_text("wav 파일"))

    def test_step_remove_whitespace(self):
        self.assertEqual(kc.normalize_text("김하늘 씨가"), kc.normalize_text("김하늘씨가"))
        self.assertEqual(kc.normalize_text("가​나\t다\n"), "가나다")

    def test_changed_step_names_reports_only_effective_steps(self):
        r = kc.normalize("가나다")            # 아무 단계도 바꿀 게 없는 입력
        self.assertEqual(r.changed_step_names(), ())
        r2 = kc.normalize("가 나!")
        self.assertIn("strip_expression_events", r2.changed_step_names())
        self.assertIn("remove_whitespace", r2.changed_step_names())

    def test_post_event_steps_are_character_local(self):
        """이벤트 position 이 '정규화 완료 기준' 일 수 있게 하는 불변식.

        이벤트 제거 이후 단계는 모두 문자 국소 연산이어야 한다:
        f(a + b) == f(a) + f(b). 하나라도 깨지면 position 이 거짓말을 한다.
        """
        samples = ["안녕", " 하세요", "WAV", ". ", "50 %", "가나다", ""]
        for step in kc._POST_EVENT_STEPS:
            for a in samples:
                for b in samples:
                    self.assertEqual(step.fn(a + b), step.fn(a) + step.fn(b),
                                     msg="{0} 가 문자 국소가 아니다: {1!r}+{2!r}".format(
                                         step.name, a, b))

    def test_normalize_rejects_non_string(self):
        with self.assertRaises(kc.KoreanCerError):
            kc.normalize(123)

    def test_normalize_none_is_empty(self):
        self.assertEqual(kc.normalize(None).text, "")


# ────────────────────────── 음절(1차) vs 자모(보조) ──────────────────────────
class GranularityTest(unittest.TestCase):

    def test_syllable_is_one_unit_per_block(self):
        self.assertEqual(len(kc.syllable_units("한국어")), 3)

    def test_jamo_expands_denominator(self):
        self.assertGreater(len(kc.jamo_units("한국어")), len(kc.syllable_units("한국어")))

    def test_jamo_rate_is_named_differently(self):
        r = kc.score_item("g1", "sample", "한국어", "한국오", PROV)
        d = r.to_dict()
        self.assertIn("syllable_cer", d)
        self.assertIn("jamo_jer", d)
        self.assertNotIn("cer", d)           # 맨 'cer' 이름은 어디에도 없다
        self.assertNotIn("jamo_cer", d)
        self.assertEqual(d["primary_metric"], "syllable_cer")

    def test_jamo_rate_is_lower_for_same_error(self):
        """자모 분모가 커지므로 같은 오류가 더 낮은 비율로 보인다 — 그래서 1차는 음절."""
        r = kc.score_item("g2", "sample", "한국어", "한국오", PROV)
        self.assertAlmostEqual(r.syllable_cer, 1 / 3)
        self.assertLess(r.jamo_jer, r.syllable_cer)

    def test_include_jamo_can_be_disabled(self):
        r = kc.score_item("g3", "sample", "한국어", "한국오", PROV, include_jamo=False)
        self.assertIsNone(r.jamo)
        self.assertIsNone(r.jamo_jer)
        self.assertIsNone(r.to_dict()["jamo_counts"])

    def test_rationale_is_documented(self):
        self.assertIn("음절", kc.SYLLABLE_PRIMARY_RATIONALE)
        self.assertIn("jamo_jer", kc.SYLLABLE_PRIMARY_RATIONALE)


# ────────────────────────── provenance 필수 ──────────────────────────
class ProvenanceRequiredTest(unittest.TestCase):

    def test_missing_argument_raises_type_error(self):
        with self.assertRaises(TypeError):
            kc.AsrProvenance(asr_model_name="m", asr_model_version="1")

    def test_blank_fingerprint_raises(self):
        with self.assertRaises(kc.ProvenanceError):
            kc.AsrProvenance("m", "1", "   ", kc.NORMALIZATION_VERSION)

    def test_blank_normalization_version_raises(self):
        with self.assertRaises(kc.ProvenanceError):
            kc.AsrProvenance("m", "1", "sha256:x", "")

    def test_none_field_raises(self):
        with self.assertRaises(kc.ProvenanceError):
            kc.AsrProvenance("m", "1", None, kc.NORMALIZATION_VERSION)

    def test_for_current_pipeline_stamps_version(self):
        p = kc.AsrProvenance.for_current_pipeline("m", "1", "sha256:x")
        self.assertEqual(p.normalization_version, kc.NORMALIZATION_VERSION)

    def test_result_cannot_be_built_without_provenance_argument(self):
        with self.assertRaises(TypeError):
            kc.CerResult(item_id="x", category="c",
                         syllable=kc.edit_counts((), ()), jamo=None, events=None)

    def test_result_with_none_provenance_raises(self):
        with self.assertRaises(kc.ProvenanceError):
            kc.CerResult(item_id="x", category="c", provenance=None,
                         syllable=kc.edit_counts((), ()), jamo=None, events=None)

    def test_result_with_non_provenance_object_raises(self):
        with self.assertRaises(kc.ProvenanceError):
            kc.CerResult(item_id="x", category="c",
                         provenance={"asr_model_name": "m"},
                         syllable=kc.edit_counts((), ()), jamo=None, events=None)

    def test_event_report_requires_provenance(self):
        with self.assertRaises(kc.ProvenanceError):
            kc.compare_expression_events("x", (), (), None)

    def test_score_item_rejects_stale_normalization_version(self):
        stale = kc.AsrProvenance("m", "1", "sha256:x", "audioforge/ko-cer-normalization 0.9.0")
        with self.assertRaises(kc.ProvenanceError):
            kc.score_item("x", "c", "가", "가", stale)

    def test_result_dict_carries_all_four_provenance_fields(self):
        d = kc.score_item("x", "c", "가", "가", PROV).to_dict()["provenance"]
        self.assertEqual(sorted(d), ["asr_model_fingerprint", "asr_model_name",
                                     "asr_model_version", "normalization_version"])
        for v in d.values():
            self.assertTrue(str(v).strip())

    def test_result_requires_item_id_and_category(self):
        with self.assertRaises(kc.KoreanCerError):
            kc.score_item("", "c", "가", "가", PROV)
        with self.assertRaises(kc.KoreanCerError):
            kc.score_item("x", "", "가", "가", PROV)


# ────────────────────────── 표현 언어 계약 소비 ──────────────────────────
class ExpressiveContractConsumptionTest(unittest.TestCase):
    """토큰 정체는 이 모듈이 정하지 않는다 — 계약에서 온다."""

    def test_event_kinds_are_contract_node_kinds(self):
        for kind in kc.EventKind:
            self.assertIn(kind.value, et.EXPRESSIVE_NODE_KINDS, msg=kind.value)

    def test_eval_mode_is_the_contract_v3_mode(self):
        self.assertIn(kc.EXPRESSIVE_EVAL_MODE, et.EXPRESSIVE_MODES)
        self.assertEqual(et.EXPRESSIVE_MODE_TO_VERSION[kc.EXPRESSIVE_EVAL_MODE],
                         et.EXPRESSIVE_CONTRACT_VERSION)
        # 계약 기본 모드(legacy_v2)에서는 이 이벤트들이 아예 생기지 않는다 — 명시 고정.
        self.assertNotEqual(kc.EXPRESSIVE_EVAL_MODE, et.EXPRESSIVE_DEFAULT_MODE)

    def test_spec_version_is_no_longer_provisional(self):
        self.assertNotIn("provisional", kc.EXPRESSION_TOKEN_SPEC_VERSION)
        self.assertIn("expressive-contract-v{0}".format(et.EXPRESSIVE_CONTRACT_VERSION),
                      kc.EXPRESSION_TOKEN_SPEC_VERSION)

    def test_contract_version_mirrors_the_contract(self):
        self.assertEqual(kc.EXPRESSIVE_CONTRACT_VERSION, et.EXPRESSIVE_CONTRACT_VERSION)

    def test_fingerprint_is_stable_and_moves_with_the_contract(self):
        self.assertEqual(kc.expressive_contract_fingerprint(),
                         kc.EXPRESSIVE_CONTRACT_FINGERPRINT)
        self.assertEqual(len(kc.EXPRESSIVE_CONTRACT_FINGERPRINT), 64)
        # 계약 enum 이 하나라도 바뀌면 지문이 달라져야 한다.
        original = et.LOCAL_PROSODY_KINDS
        try:
            et.LOCAL_PROSODY_KINDS = original + ("invented_kind",)
            self.assertNotEqual(kc.expressive_contract_fingerprint(),
                                kc.EXPRESSIVE_CONTRACT_FINGERPRINT)
        finally:
            et.LOCAL_PROSODY_KINDS = original
        self.assertEqual(kc.expressive_contract_fingerprint(),
                         kc.EXPRESSIVE_CONTRACT_FINGERPRINT)

    def test_token_spec_rows_are_derived_from_contract_enums(self):
        joined = " ".join(row[2] for row in kc.EXPRESSION_TOKEN_SPEC)
        for kind in et.LOCAL_PROSODY_KINDS:
            self.assertIn(kind, joined)
        for style in et.LAUGH_STYLES:
            self.assertIn(style, joined)
        for mode in et.EMOTION_TRANSITION_MODES:
            self.assertIn(mode, joined)

    def test_module_has_no_private_token_regex(self):
        """자체 토크나이저를 남겨 두면 계약과 조용히 갈라진다."""
        self.assertFalse(hasattr(kc, "_EVENT_PATTERN"))
        self.assertFalse(hasattr(kc, "_classify_event_match"))

    def test_stripping_matches_contract_plain_text(self):
        for raw in ["정말요?! 없어요...", "[기쁨] 오늘 [ㅋㅋ]", "안녕~", "그냥 텍스트"]:
            parsed = et.parse_expressive_timeline(raw, mode=kc.EXPRESSIVE_EVAL_MODE)
            self.assertTrue(parsed["ok"], msg=raw)
            self.assertEqual(kc.extract_expression_events(raw).text,
                             parsed["timeline"]["plain_text"], msg=raw)

    def test_timeline_sha256_is_recorded(self):
        parse = kc.extract_expression_events("정말요?!")
        expected = et.parse_expressive_timeline(
            "정말요?!", mode=kc.EXPRESSIVE_EVAL_MODE)["timeline"]["full_sha256"]
        self.assertEqual(parse.timeline_sha256, expected)
        self.assertEqual(len(parse.timeline_sha256), 64)

    def test_parse_failure_is_recorded_not_swallowed(self):
        parse = kc.extract_expression_events("[웃음] 안녕하세요")
        self.assertFalse(parse.contract_ok)
        self.assertIn("UNKNOWN_EXPRESSIVE_TAG", parse.diagnostic_codes)
        self.assertEqual(parse.events, ())
        self.assertEqual(parse.text, "[웃음] 안녕하세요")   # 본문은 그대로 둔다

    def test_parse_failure_surfaces_in_the_result_record(self):
        r = kc.score_item("pf", "probe", "안녕하세요", "[웃음] 안녕하세요", PROV)
        d = r.to_dict()["expression_events"]
        self.assertFalse(d["contract_ok"])
        self.assertFalse(d["hypothesis_contract_ok"])
        self.assertTrue(d["reference_contract_ok"])
        self.assertIn("UNKNOWN_EXPRESSIVE_TAG", d["contract_diagnostic_codes"])
        self.assertIsNotNone(r.syllable_cer)   # 문자 CER 은 계속 계산된다


class ContractTokenIdentityTest(unittest.TestCase):
    """계약이 이미 확정한 토큰 정체를 이 모듈이 다시 정하지 않는다."""

    def _events(self, text):
        return kc.extract_expression_events(text).events

    def test_question_bang_alias_is_one_shock_rise(self):
        for raw in ("정말요!?", "정말요?!"):
            events = self._events(raw)
            self.assertEqual(len(events), 1, msg=raw)          # 2개가 아니다
            self.assertEqual(events[0].token, "prosody:shock_rise", msg=raw)
            self.assertEqual(events[0].kind, kc.EventKind.LOCAL_PROSODY, msg=raw)

    def test_alias_pair_matches_perfectly(self):
        r = kc.score_item("a", "probe", "정말요?!", "정말요!?", PROV)
        self.assertEqual(r.events.matched_count, 1)
        self.assertEqual(r.events.missing_count, 0)
        self.assertEqual(r.events.spurious_count, 0)
        self.assertEqual(r.events.magnitude_mismatch_count, 0)

    def test_bang_run_is_emphasis_not_shock(self):
        self.assertEqual(self._events("정말!!")[0].token, "prosody:emphasis")
        self.assertEqual(self._events("정말!")[0].token, "prosody:emphasis")
        self.assertEqual(self._events("정말?")[0].token, "prosody:question_rise")

    def test_single_dot_is_firm_end_not_ordinary_punctuation(self):
        """계약에서 마침표 1개는 firm_end 토큰이다 — 이전 임시 서술과 다르다."""
        events = self._events("끝났어요.")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].token, "prosody:firm_end")

    def test_dot_run_is_one_token_and_fade_end(self):
        events = self._events("정말...")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].token, "prosody:fade_end")
        self.assertEqual(events[0].magnitude, 3)

    def test_ellipsis_char_carries_contract_weight(self):
        """… 는 계약상 가중치 3 — '...' 과 같은 개수로 취급된다."""
        self.assertEqual(et.DOT_CHAR_WEIGHTS["…"], 3)
        self.assertEqual(self._events("정말…")[0].magnitude,
                         self._events("정말...")[0].magnitude)

    def test_dot_run_count_is_capped_by_contract(self):
        events = self._events("정말" + "." * 9)
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0].capped)
        self.assertEqual(events[0].magnitude, et.DOT_RUN_MAX_COUNT)

    def test_bang_run_cap_is_the_contract_cap(self):
        events = self._events("정말" + "!" * 9)
        self.assertEqual(events[0].magnitude, et.BANG_RUN_MAX_COUNT)
        self.assertTrue(events[0].capped)

    def test_laugh_is_only_an_event_inside_brackets(self):
        self.assertEqual(self._events("정말 웃겼어요 ㅋㅋ"), ())   # 본문의 ㅋㅋ 는 텍스트
        events = self._events("정말 웃겼어요 [ㅋㅋ]")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].token, "laugh:chuckle")
        self.assertEqual(events[0].kind, kc.EventKind.NONVERBAL_LAUGH)

    def test_laugh_styles_come_from_the_contract(self):
        self.assertEqual(self._events("[ㅎㅎ]")[0].token, "laugh:breathy")
        for token in (self._events("[ㅋㅋ]")[0].token, self._events("[ㅎㅎ]")[0].token):
            self.assertIn(token.split(":", 1)[1], et.LAUGH_STYLES)

    def test_tilde_is_a_vowel_extend_token_not_content(self):
        events = self._events("안녕~~")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].token, "prosody:vowel_extend")
        self.assertEqual(kc.normalize_text("안녕~~"), "안녕")

    def test_emotion_identity_uses_resolved_id(self):
        events = self._events("[기쁨] 오늘")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].token, "emotion:happy:blend")
        self.assertEqual(events[0].kind, kc.EventKind.EMOTION_TRANSITION)

    def test_explicit_pause_is_tracked(self):
        events = self._events("잠깐 [쉼 0.5] 갈게요")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].token, "pause")
        self.assertEqual(events[0].kind, kc.EventKind.EXPLICIT_PAUSE)


class EventIdentityScopeTest(unittest.TestCase):
    """identity 에 무엇이 들어가고 무엇이 빠지는지 — 결정을 테스트로 못 박는다."""

    def test_rationale_is_documented(self):
        self.assertIn("magnitude_mismatch", kc.EVENT_IDENTITY_RATIONALE)
        self.assertIn("transition_mode", kc.EVENT_IDENTITY_RATIONALE)

    def test_magnitude_is_excluded_from_identity(self):
        """'!!!' 이 '!' 로 약해진 것은 '사라진 것'이 아니다 — 일치 + 크기 차이."""
        r = kc.score_item("m", "probe", "정말 대단해요!!!", "정말 대단해요!", PROV)
        self.assertEqual(r.events.matched_count, 1)
        self.assertEqual(r.events.missing_count, 0)
        self.assertEqual(r.events.spurious_count, 0)
        self.assertEqual(r.events.magnitude_mismatch_count, 1)
        self.assertEqual(r.events.max_magnitude_delta, 2)

    def test_matching_magnitude_reports_no_mismatch(self):
        r = kc.score_item("m2", "probe", "정말 대단해요!!", "정말 대단해요!!", PROV)
        self.assertEqual(r.events.magnitude_mismatch_count, 0)
        self.assertIsNone(r.events.max_magnitude_delta)

    def test_contract_cap_absorbs_magnitude_beyond_the_cap(self):
        """계약 상한을 넘은 차이는 계약이 이미 지운 것 — 지표가 되살리지 않는다."""
        r = kc.score_item("m3", "probe", "정말!!!!!", "정말!!!", PROV)
        self.assertEqual(r.events.matched_count, 1)
        self.assertEqual(r.events.magnitude_mismatch_count, 0)

    def test_transition_mode_is_part_of_identity(self):
        """[기쁨] 과 [기쁨|즉시] 는 크기가 아니라 범주적으로 다른 지시다."""
        r = kc.score_item("t", "probe", "[기쁨] 오늘", "[기쁨|즉시] 오늘", PROV)
        self.assertEqual(r.events.matched_count, 0)
        self.assertEqual(r.events.missing_count, 1)
        self.assertEqual(r.events.spurious_count, 1)

    def test_emotion_id_is_part_of_identity(self):
        r = kc.score_item("t2", "probe", "[기쁨] 오늘", "[슬픔] 오늘", PROV)
        self.assertEqual(r.events.missing_count, 1)
        self.assertEqual(r.events.spurious_count, 1)

    def test_scope_kind_is_a_function_of_prosody_kind(self):
        """scope 를 identity 에서 뺀 근거 — kind 가 정하면 중복이다.

        계약이 이 함수 관계를 끊으면 이 테스트가 실패하고 결정을 재검토하게 된다.
        """
        seen = {}
        for raw in ("가.", "가...", "가!", "가?", "가?!", "가~"):
            tl = et.parse_expressive_timeline(raw, mode=kc.EXPRESSIVE_EVAL_MODE)["timeline"]
            for lp in tl["local_prosody"]:
                if lp["kind"] in seen:
                    self.assertEqual(seen[lp["kind"]], lp["scope_kind"], msg=lp["kind"])
                seen[lp["kind"]] = lp["scope_kind"]
        self.assertEqual(len(seen), len(et.LOCAL_PROSODY_KINDS))

    def test_laugh_position_is_not_part_of_identity(self):
        leading = kc.extract_expression_events("[ㅋㅋ] 웃겨요").events[0]
        trailing = kc.extract_expression_events("웃겨요 [ㅋㅋ]").events[0]
        self.assertNotEqual(leading.detail, trailing.detail)   # 계약 position 은 다르고
        self.assertEqual(leading.token, trailing.token)        # identity 는 같다


class EventPositionTest(unittest.TestCase):
    """위치의 권위는 AST 노드 순서이고, 단위는 정규화 음절이다."""

    def test_position_unit_is_declared(self):
        self.assertEqual(kc.EVENT_POSITION_UNIT, "normalized_syllable")
        parse = kc.extract_expression_events("안녕하세요!")
        self.assertEqual(parse.events[0].to_dict()["position_unit"],
                         "normalized_syllable")

    def test_position_counts_normalized_syllables_before_the_event(self):
        parse = kc.extract_expression_events("안녕하세요! 반가워요")
        self.assertEqual(parse.events[0].position, 5)

    def test_position_is_stable_across_spacing_differences(self):
        """계약 원시 오프셋은 띄어쓰기로 흔들리지만 정규화 좌표는 흔들리지 않는다."""
        a = kc.extract_expression_events("안녕하세요! 반가워요").events[0]
        b = kc.extract_expression_events("안 녕 하 세 요! 반가워요").events[0]
        self.assertNotEqual(a.source_start_codepoint, b.source_start_codepoint)
        self.assertEqual(a.position, b.position)

    def test_contract_dual_offsets_are_recorded(self):
        e = kc.extract_expression_events("안녕하세요!").events[0]
        d = e.to_dict()
        for key in ("source_start_utf16", "source_end_utf16",
                    "source_start_codepoint", "source_end_codepoint"):
            self.assertIn(key, d)
        self.assertEqual(e.source_end_codepoint, e.source_start_codepoint + 1)

    def test_recorded_span_matches_the_contract_range(self):
        raw = "안녕하세요! 반가워요"
        tl = et.parse_expressive_timeline(raw, mode=kc.EXPRESSIVE_EVAL_MODE)["timeline"]
        contract_range = tl["local_prosody"][0]["source_range"]
        e = kc.extract_expression_events(raw).events[0]
        self.assertEqual(e.source_start_utf16, contract_range["start_utf16"])
        self.assertEqual(e.source_end_utf16, contract_range["end_utf16"])
        self.assertEqual(e.source_start_codepoint, contract_range["start_codepoint"])
        self.assertEqual(e.source_end_codepoint, contract_range["end_codepoint"])

    def test_tolerance_is_meaningful_in_syllables(self):
        """허용 오차 2 = 정규화 음절 2개. 그 밖이면 대응하지 않는다."""
        r_near = kc.score_item("p1", "probe", "안녕하세요! 반가워요",
                               "안녕하! 세요반가워요", PROV)
        self.assertEqual(r_near.events.matched_count, 1)
        r_far = kc.score_item("p2", "probe", "안녕하세요 반가워요!",
                              "안! 녕하세요반가워요", PROV)
        self.assertEqual(r_far.events.matched_count, 0)
        self.assertEqual(r_far.events.missing_count, 1)
        self.assertEqual(r_far.events.spurious_count, 1)


class ExpressionEventSeparationTest(unittest.TestCase):
    """표현 이벤트는 문자 CER 에 **전혀** 기여하지 않아야 한다."""

    def test_laugh_is_never_compared_as_words(self):
        r = kc.score_item("e1", "probe", "정말 웃겼어요 [ㅋㅋㅋ]", "정말 웃겼어요", PROV)
        self.assertEqual(r.syllable_cer, 0.0)          # 문자 오류 0
        self.assertEqual(r.events.expected_count, 1)
        self.assertEqual(r.events.missing_count, 1)    # 이벤트로는 누락이 잡힌다

    def test_emotion_tag_does_not_affect_character_cer(self):
        r = kc.score_item("e2", "probe", "[기쁨] 오늘 좋아요", "오늘 좋아요", PROV)
        self.assertEqual(r.syllable_cer, 0.0)
        self.assertEqual(r.events.missing_count, 1)

    def test_prosody_punct_does_not_affect_character_cer(self):
        r = kc.score_item("e3", "probe", "정말요?! 믿을 수 없어요...",
                          "정말요 믿을 수 없어요", PROV)
        self.assertEqual(r.syllable_cer, 0.0)
        self.assertEqual(r.events.expected_count, 2)
        self.assertEqual(r.events.missing_count, 2)

    def test_events_on_both_sides_cancel_out(self):
        r = kc.score_item("e4", "probe", "안녕하세요! [ㅋㅋ]", "안녕하세요! [ㅋㅋ]", PROV)
        self.assertEqual(r.syllable_cer, 0.0)
        self.assertEqual(r.events.matched_count, 2)
        self.assertEqual(r.events.missing_count, 0)
        self.assertEqual(r.events.spurious_count, 0)

    def test_spurious_event_detected(self):
        r = kc.score_item("e5", "probe", "그래요", "그래요 [ㅋㅋ]", PROV)
        self.assertEqual(r.syllable_cer, 0.0)
        self.assertEqual(r.events.expected_count, 0)
        self.assertEqual(r.events.spurious_count, 1)
        self.assertIsNone(r.events.miss_rate)          # 기대 0 → 비율 정의 안 됨

    def test_wrong_token_is_missing_plus_spurious(self):
        r = kc.score_item("e6", "probe", "[기쁨] 오늘", "[슬픔] 오늘", PROV)
        self.assertEqual(r.syllable_cer, 0.0)
        self.assertEqual(r.events.missing_count, 1)
        self.assertEqual(r.events.spurious_count, 1)
        self.assertEqual(r.events.matched_count, 0)

    def test_content_error_leaves_events_matched(self):
        r = kc.score_item("e7", "probe", "안녕하세요! 반갑습니다",
                          "안녕하세요! 반값습니다", PROV)
        self.assertGreater(r.syllable_cer, 0.0)
        self.assertEqual(r.events.missing_count, 0)
        self.assertEqual(r.events.spurious_count, 0)

    def test_miss_rate(self):
        r = kc.score_item("e8", "probe", "와! 대박? 진짜...", "와 대박? 진짜", PROV)
        self.assertEqual(r.events.expected_count, 3)
        self.assertEqual(r.events.missing_count, 2)
        self.assertAlmostEqual(r.events.miss_rate, 2 / 3)


class ExpressionEventMatchingTest(unittest.TestCase):

    def _ev(self, token, pos, kind=kc.EventKind.LOCAL_PROSODY, magnitude=1):
        return kc.ExpressionEvent(
            kind=kind, token=token, position=pos, raw="!", magnitude=magnitude,
            source_start_utf16=pos, source_end_utf16=pos + 1,
            source_start_codepoint=pos, source_end_codepoint=pos + 1)

    def test_within_tolerance_matches(self):
        rep = kc.compare_expression_events(
            "m1", [self._ev("prosody:emphasis", 10)],
            [self._ev("prosody:emphasis", 12)], PROV, position_tolerance=2)
        self.assertEqual(rep.matched_count, 1)
        self.assertEqual(rep.max_position_delta, 2)

    def test_outside_tolerance_splits_into_missing_and_spurious(self):
        rep = kc.compare_expression_events(
            "m2", [self._ev("prosody:emphasis", 10)],
            [self._ev("prosody:emphasis", 20)], PROV, position_tolerance=2)
        self.assertEqual(rep.matched_count, 0)
        self.assertEqual(rep.missing_count, 1)
        self.assertEqual(rep.spurious_count, 1)

    def test_different_kinds_never_match(self):
        rep = kc.compare_expression_events(
            "m3", [self._ev("laugh:chuckle", 5, kc.EventKind.NONVERBAL_LAUGH)],
            [self._ev("prosody:emphasis", 5)], PROV)
        self.assertEqual(rep.matched_count, 0)
        self.assertEqual(rep.missing_count, 1)
        self.assertEqual(rep.spurious_count, 1)

    def test_counts_by_kind(self):
        rep = kc.compare_expression_events(
            "m4",
            [self._ev("prosody:emphasis", 1),
             self._ev("laugh:chuckle", 2, kc.EventKind.NONVERBAL_LAUGH)],
            [self._ev("prosody:emphasis", 1)], PROV)
        self.assertEqual(rep.expected_by_kind,
                         {"localProsody": 1, "nonverbalLaugh": 1})
        self.assertEqual(rep.observed_by_kind, {"localProsody": 1})

    def test_negative_tolerance_rejected(self):
        with self.assertRaises(kc.KoreanCerError):
            kc.compare_expression_events("m5", (), (), PROV, position_tolerance=-1)

    def test_comparison_is_deterministic(self):
        exp = [self._ev("prosody:emphasis", 1), self._ev("prosody:emphasis", 9)]
        obs = [self._ev("prosody:emphasis", 2), self._ev("prosody:emphasis", 30)]
        first = kc.compare_expression_events("m6", exp, obs, PROV).to_dict()
        for _ in range(3):
            self.assertEqual(
                kc.compare_expression_events("m6", exp, obs, PROV).to_dict(), first)

    def test_contract_stamp_defaults_are_safe(self):
        rep = kc.compare_expression_events("m7", (), (), PROV)
        self.assertTrue(rep.contract_ok)
        self.assertEqual(rep.contract_diagnostic_codes, ())
        self.assertEqual(rep.expressive_mode, kc.EXPRESSIVE_EVAL_MODE)

# ────────────────────────── 집계 · pooling ──────────────────────────
class AggregationTest(unittest.TestCase):

    def _results(self, category="numbers"):
        return [
            kc.score_item("a", category, "가나다", "가라다", PROV),    # S1 / N3
            kc.score_item("b", category, "라마", "라마", PROV),        # 0 / N2
        ]

    def test_micro_average(self):
        agg = kc.aggregate_results("numbers", self._results())
        self.assertEqual(agg.ref_length, 5)
        self.assertEqual(agg.total_errors, 1)
        self.assertAlmostEqual(agg.syllable_cer, 1 / 5)
        self.assertEqual(agg.item_count, 2)
        self.assertEqual(agg.to_dict()["aggregation"], "micro_average")

    def test_mixed_categories_raise(self):
        mixed = [kc.score_item("a", "numbers", "가", "가", PROV),
                 kc.score_item("b", "proper_nouns", "나", "나", PROV)]
        with self.assertRaises(kc.PoolingError):
            kc.aggregate_results("mixed", mixed)

    def test_mixed_provenance_raises(self):
        other = kc.AsrProvenance.for_current_pipeline("other-asr", "9", "sha256:zz")
        mixed = [kc.score_item("a", "numbers", "가", "가", PROV),
                 kc.score_item("b", "numbers", "나", "나", other)]
        with self.assertRaises(kc.ProvenanceError):
            kc.aggregate_results("numbers", mixed)

    def test_declared_category_mismatch_raises(self):
        with self.assertRaises(kc.PoolingError):
            kc.aggregate_results("numbers", self._results(), category="latin_in_korean")

    def test_empty_results_raise(self):
        with self.assertRaises(kc.KoreanCerError):
            kc.aggregate_results("numbers", [])

    def test_pooling_requires_explicit_acknowledgement(self):
        a = kc.aggregate_results("numbers", self._results("numbers"))
        b = kc.aggregate_results("proper_nouns", self._results("proper_nouns"))
        with self.assertRaises(kc.PoolingError):
            kc.pool_aggregates("all", [a, b])

    def test_acknowledged_pooling_marks_itself(self):
        a = kc.aggregate_results("numbers", self._results("numbers"))
        b = kc.aggregate_results("proper_nouns", self._results("proper_nouns"))
        pooled = kc.pool_aggregates("all", [a, b], acknowledge_pooling=True)
        self.assertEqual(pooled.category, kc.POOLED_CATEGORY)
        self.assertEqual(pooled.pooled_from, ("numbers", "proper_nouns"))
        self.assertEqual(pooled.item_count, 4)
        self.assertAlmostEqual(pooled.syllable_cer, 2 / 10)

    def test_event_counts_aggregate(self):
        results = [kc.score_item("a", "probe", "와! 하하", "와 하하", PROV),
                   kc.score_item("b", "probe", "응", "응 [ㅋㅋ]", PROV)]
        agg = kc.aggregate_results("probe", results)
        self.assertEqual(agg.event_expected_count, 1)
        self.assertEqual(agg.event_missing_count, 1)
        self.assertEqual(agg.event_spurious_count, 1)


# ────────────────────────── 금지 이름 스캔 ──────────────────────────
class ForbiddenNamingTest(unittest.TestCase):
    """CER 은 자연스러움 점수가 아니다 — 이름으로도 그렇게 보이면 안 된다."""

    def test_no_result_key_is_forbidden(self):
        offenders = kc.scan_forbidden_names(kc.public_result_keys())
        self.assertEqual(offenders, (), msg="결과 키에 금지 이름: {0}".format(offenders))

    def test_no_public_api_name_is_forbidden(self):
        offenders = kc.scan_forbidden_names(kc.public_api_names())
        self.assertEqual(offenders, (), msg="공개 API 에 금지 이름: {0}".format(offenders))

    def test_scanner_catches_known_bad_names(self):
        bad = ["naturalness", "naturalness_score", "quality", "emotion_quality",
               "emotionQuality", "voice_quality", "mos", "mos_score",
               "expressiveness", "audio_quality", "자연스러움", "음질 점수"]
        for name in bad:
            self.assertTrue(kc.is_forbidden_name(name), msg=name)

    def test_scanner_does_not_flag_legitimate_names(self):
        ok = ["syllable_cer", "jamo_jer", "normalization_version", "substitutions",
              "asr_model_fingerprint", "expected_count", "spurious_count",
              "position_tolerance", "micro_average", "item_id"]
        for name in ok:
            self.assertFalse(kc.is_forbidden_name(name), msg=name)

    def test_assert_names_allowed_raises(self):
        with self.assertRaises(kc.ForbiddenNameError):
            kc.assert_names_allowed(["syllable_cer", "naturalness"])

    def test_module_docstring_states_it(self):
        doc = kc.__doc__ or ""
        for phrase in ("naturalness", "quality", "emotion_quality", "자연스러움"):
            self.assertIn(phrase, doc, msg=phrase)

    def test_no_dataclass_field_is_forbidden(self):
        import dataclasses
        for name in kc.public_api_names():
            obj = getattr(kc, name, None)
            if dataclasses.is_dataclass(obj) and isinstance(obj, type):
                fields = [f.name for f in dataclasses.fields(obj)]
                self.assertEqual(kc.scan_forbidden_names(fields), (), msg=name)


# ────────────────────────── 결과 레코드 위생 ──────────────────────────
_WINDOWS_PATH = re.compile(r"[A-Za-z]:[\\/]")
_BACKSLASH_PATH = re.compile(r"\\\\|\\[A-Za-z0-9_.]")
_POSIX_ABS_PATH = re.compile(r"^/[A-Za-z0-9_.]")
_AUDIO_EXT = re.compile(r"\.(wav|mp3|flac|m4a|ogg|opus|aac|wma|aiff?)\b", re.I)
_PATHY_KEYS = ("path", "dir", "folder", "filename", "filepath", "audio",
               "waveform", "pcm", "samples", "bytes", "blob")


def _walk(node, trail=""):
    if isinstance(node, dict):
        for k, v in node.items():
            yield ("key", trail + "/" + str(k), k)
            for x in _walk(v, trail + "/" + str(k)):
                yield x
    elif isinstance(node, (list, tuple)):
        for i, v in enumerate(node):
            for x in _walk(v, "{0}[{1}]".format(trail, i)):
                yield x
    else:
        yield ("value", trail, node)


class ResultRecordHygieneTest(unittest.TestCase):
    """결과 레코드에는 파일 경로도, 원시 오디오도 들어가지 않는다.

    (schema id 나 정규화 버전에 '/' 가 들어가므로 슬래시만으로 경로를 판정하지 않고,
     Windows 드라이브 표기·역슬래시·POSIX 절대경로·오디오 확장자로 판정한다.)
    """

    def _records(self):
        return kc.sample_result_records(PROV) + (
            kc.score_item("h1", "numbers", "세 시 삼십 분!", "3시 30분", PROV).to_dict(),
        )

    def test_no_filesystem_path_in_records(self):
        for rec in self._records():
            for kind, trail, node in _walk(rec):
                if kind != "value" or not isinstance(node, str):
                    continue
                self.assertIsNone(_WINDOWS_PATH.search(node), msg=trail + " -> " + node)
                self.assertIsNone(_BACKSLASH_PATH.search(node), msg=trail + " -> " + node)
                self.assertIsNone(_POSIX_ABS_PATH.search(node), msg=trail + " -> " + node)
                self.assertIsNone(_AUDIO_EXT.search(node), msg=trail + " -> " + node)

    def test_no_pathlike_or_audio_keys(self):
        for rec in self._records():
            for kind, trail, node in _walk(rec):
                if kind != "key":
                    continue
                lowered = str(node).lower()
                for bad in _PATHY_KEYS:
                    self.assertNotIn(bad, lowered, msg=trail)

    def test_no_raw_binary_values(self):
        for rec in self._records():
            for kind, trail, node in _walk(rec):
                if kind != "value":
                    continue
                self.assertNotIsInstance(node, (bytes, bytearray, memoryview), msg=trail)
                self.assertIsInstance(node, (str, int, float, bool, type(None)),
                                      msg="{0} -> {1}".format(trail, type(node).__name__))

    def test_records_are_json_serializable_and_deterministic(self):
        for rec in self._records():
            first = json.dumps(rec, ensure_ascii=False, sort_keys=True)
            self.assertEqual(first, json.dumps(rec, ensure_ascii=False, sort_keys=True))

    def test_records_do_not_carry_transcript_body(self):
        """결과 레코드는 body-free — 원문/가설 문자열을 통째로 담지 않는다."""
        rec = kc.score_item("h2", "numbers", "서울 성수동 카페", "서울 성수동 까페",
                            PROV).to_dict()
        blob = json.dumps(rec, ensure_ascii=False)
        self.assertNotIn("성수동", blob)
        self.assertNotIn("카페", blob)


if __name__ == "__main__":
    unittest.main()
