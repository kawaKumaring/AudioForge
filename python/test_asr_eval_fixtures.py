# -*- coding: utf-8 -*-
"""asr_eval_fixtures 단위 테스트 — 실제 ASR·음성·GPU 없음(합성 mock 문자열만).

검증: fixture 구조 불변식 / 세 카테고리를 **각각 독립적으로** 평가하고 기본값으로는
절대 합치지 않는다는 것 / 선언된 정규화 규칙의 결과(띄어쓰기·대소문자) / 표현 언어
계약(expressive_timeline v3) 문법으로 쓴 이벤트 probe / 계약 버전·지문·타임라인 해시
각인 / provenance 각인 / 금지 이름 스캔 / 결과 레코드 위생.
"""

import json
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import korean_cer as kc
import expressive_timeline as et
import asr_eval_fixtures as fx


PROV = fx.MOCK_ASR_PROVENANCE


def _score(item, label):
    return kc.score_item(item.item_id, item.category, item.reference_text,
                         item.hypothesis(label).text, PROV)


def _probe(item_id):
    for it in fx.EXPRESSION_EVENT_PROBES:
        if it.item_id == item_id:
            return it
    raise AssertionError("probe 없음: " + item_id)


def _find(category, item_id):
    for it in fx.items_for(category):
        if it.item_id == item_id:
            return it
    raise AssertionError("fixture 없음: " + item_id)


# ────────────────────────── fixture 구조 ──────────────────────────
class FixtureStructureTest(unittest.TestCase):

    def test_validate_fixtures_passes(self):
        fx.validate_fixtures()   # 불변식 위반 시 예외

    def test_exactly_three_cer_categories(self):
        self.assertEqual(fx.CATEGORIES,
                         ("numbers", "latin_in_korean", "proper_nouns"))
        self.assertEqual(sorted(fx.FIXTURE_SETS), sorted(fx.CATEGORIES))

    def test_probe_group_is_not_a_cer_category(self):
        self.assertNotIn(fx.PROBE_GROUP_EXPRESSION_EVENTS, fx.CATEGORIES)
        self.assertNotIn(fx.PROBE_GROUP_EXPRESSION_EVENTS, fx.FIXTURE_SETS)

    def test_each_set_is_non_empty_and_self_consistent(self):
        for category in fx.CATEGORIES:
            items = fx.items_for(category)
            self.assertTrue(items, msg=category)
            for it in items:
                self.assertEqual(it.category, category, msg=it.item_id)
                self.assertTrue(it.reference_text.strip(), msg=it.item_id)
                self.assertTrue(it.note.strip(), msg=it.item_id)

    def test_item_ids_are_globally_unique(self):
        ids = [it.item_id for c in fx.CATEGORIES for it in fx.items_for(c)]
        ids += [it.item_id for it in fx.EXPRESSION_EVENT_PROBES]
        self.assertEqual(len(ids), len(set(ids)))

    def test_every_item_has_perfect_and_degraded(self):
        groups = [fx.items_for(c) for c in fx.CATEGORIES] + [fx.EXPRESSION_EVENT_PROBES]
        for items in groups:
            for it in items:
                self.assertIn(fx.PERFECT_LABEL, it.labels(), msg=it.item_id)
                self.assertIn(fx.DEGRADED_LABEL, it.labels(), msg=it.item_id)

    def test_unknown_category_raises(self):
        with self.assertRaises(KeyError):
            fx.items_for("naturalness_is_not_a_category")

    def test_fixture_set_version_declared(self):
        self.assertTrue(fx.FIXTURE_SET_VERSION.strip())

    def test_no_all_items_helper_exists(self):
        """전체를 한 덩어리로 내주는 API 는 일부러 없다 — 조용한 pooling 의 입구."""
        self.assertFalse(hasattr(fx, "all_items"))
        self.assertFalse(hasattr(fx, "ALL_ITEMS"))


# ────────────────────────── 카테고리별 독립 평가 ──────────────────────────
class PerCategoryEvaluationTest(unittest.TestCase):

    def _agg(self, category, label):
        return fx.evaluate_category(category, fx.mock_asr(label), PROV)

    def test_numbers_perfect_then_degraded(self):
        self.assertEqual(self._agg("numbers", fx.PERFECT_LABEL).syllable_cer, 0.0)
        self.assertGreater(self._agg("numbers", fx.DEGRADED_LABEL).syllable_cer, 0.0)

    def test_latin_perfect_then_degraded(self):
        self.assertEqual(self._agg("latin_in_korean", fx.PERFECT_LABEL).syllable_cer, 0.0)
        self.assertGreater(self._agg("latin_in_korean", fx.DEGRADED_LABEL).syllable_cer, 0.0)

    def test_proper_nouns_perfect_then_degraded(self):
        self.assertEqual(self._agg("proper_nouns", fx.PERFECT_LABEL).syllable_cer, 0.0)
        self.assertGreater(self._agg("proper_nouns", fx.DEGRADED_LABEL).syllable_cer, 0.0)

    def test_proper_nouns_degraded_is_hand_checked(self):
        """손검산: 지명1 + 인명1 + 조직명 삽입1 + 외국인명1 + 작품명 수사1 = 5 / N=61."""
        agg = self._agg("proper_nouns", fx.DEGRADED_LABEL)
        self.assertEqual(agg.ref_length, 61)
        self.assertEqual(agg.total_errors, 5)
        self.assertAlmostEqual(agg.syllable_cer, 5 / 61)

    def test_place_name_single_substitution(self):
        r = _score(_find("proper_nouns", "noun_place_name"), fx.DEGRADED_LABEL)
        self.assertEqual(r.syllable.substitutions, 1)
        self.assertEqual(r.syllable.deletions, 0)
        self.assertEqual(r.syllable.insertions, 0)
        self.assertEqual(r.syllable.ref_length, 12)
        self.assertAlmostEqual(r.syllable_cer, 1 / 12)

    def test_org_name_single_insertion(self):
        r = _score(_find("proper_nouns", "noun_org_name"), fx.DEGRADED_LABEL)
        self.assertEqual(r.syllable.insertions, 1)
        self.assertEqual(r.syllable.substitutions, 0)

    def test_aggregate_keeps_its_own_category_only(self):
        for category in fx.CATEGORIES:
            agg = self._agg(category, fx.DEGRADED_LABEL)
            self.assertEqual(agg.category, category)
            self.assertEqual(agg.label, category)
            self.assertEqual({r.category for r in agg.items}, {category})
            self.assertEqual(agg.pooled_from, ())

    def test_categories_have_different_failure_profiles(self):
        """세 층을 따로 봐야 하는 이유 — 같은 mock 라벨에서도 CER 이 서로 다르다."""
        rates = {c: self._agg(c, fx.DEGRADED_LABEL).syllable_cer for c in fx.CATEGORIES}
        self.assertEqual(len(set(rates.values())), len(fx.CATEGORIES))


# ────────────────────────── 기본값은 절대 합치지 않는다 ──────────────────────────
class NoSilentPoolingTest(unittest.TestCase):

    def _reports(self, label=fx.DEGRADED_LABEL):
        return fx.evaluate_all(fx.mock_asr(label), PROV)

    def test_evaluate_all_returns_three_separate_reports(self):
        reports = self._reports()
        self.assertEqual(tuple(reports), fx.CATEGORIES)
        self.assertEqual(len(reports), 3)
        for category, agg in reports.items():
            self.assertIsInstance(agg, kc.CerAggregate)
            self.assertEqual(agg.category, category)

    def test_evaluate_all_produces_no_aggregate_key(self):
        """대표 숫자(total/overall/pooled)를 만들지 않는다."""
        reports = self._reports()
        for forbidden in ("total", "overall", "all", "pooled", "__pooled__", "mean"):
            self.assertNotIn(forbidden, reports)

    def test_reports_are_not_the_same_object(self):
        reports = self._reports()
        lengths = {c: reports[c].ref_length for c in fx.CATEGORIES}
        self.assertEqual(len(set(lengths.values())), 3)

    def test_pooling_requires_explicit_acknowledgement(self):
        reports = self._reports()
        with self.assertRaises(kc.PoolingError):
            kc.pool_aggregates("all_categories", list(reports.values()))

    def test_acknowledged_pooling_is_marked_and_loses_detail(self):
        reports = self._reports()
        pooled = kc.pool_aggregates("all_categories", list(reports.values()),
                                    acknowledge_pooling=True)
        self.assertEqual(pooled.category, kc.POOLED_CATEGORY)
        self.assertEqual(pooled.pooled_from, tuple(sorted(fx.CATEGORIES)))
        self.assertEqual(pooled.ref_length,
                         sum(reports[c].ref_length for c in fx.CATEGORIES))
        self.assertEqual(pooled.total_errors,
                         sum(reports[c].total_errors for c in fx.CATEGORIES))
        # 합친 숫자는 어느 카테고리의 숫자와도 같지 않다 — 정보가 사라졌다는 증거.
        for c in fx.CATEGORIES:
            self.assertNotAlmostEqual(pooled.syllable_cer, reports[c].syllable_cer)

    def test_cross_category_results_cannot_be_aggregated_directly(self):
        results = []
        for c in fx.CATEGORIES:
            results.append(_score(fx.items_for(c)[0], fx.DEGRADED_LABEL))
        with self.assertRaises(kc.PoolingError):
            kc.aggregate_results("mixed", results)


# ────────────────────────── 선언된 정규화 규칙의 결과 ──────────────────────────
class DeclaredNormalizationConsequenceTest(unittest.TestCase):
    """규칙이 무엇을 오류로 세지 *않는지* 를 fixture 로 명시한다."""

    def test_spacing_only_is_not_an_error(self):
        r = _score(_find("numbers", "num_sino_amount"), "spacing_only")
        self.assertEqual(r.syllable_cer, 0.0)

    def test_proper_noun_spacing_variants_are_not_errors(self):
        self.assertEqual(_score(_find("proper_nouns", "noun_person_name"),
                                "spacing_only").syllable_cer, 0.0)
        self.assertEqual(_score(_find("proper_nouns", "noun_org_name"),
                                "spacing_split").syllable_cer, 0.0)

    def test_case_only_is_not_an_error(self):
        self.assertEqual(_score(_find("latin_in_korean", "latin_brand_name"),
                                "case_only").syllable_cer, 0.0)
        self.assertEqual(_score(_find("latin_in_korean", "latin_file_format"),
                                "case_only").syllable_cer, 0.0)

    def test_known_cost_latin_word_boundary_disappears(self):
        """remove_whitespace 의 선언된 대가: 영문 단어 경계가 사라진다."""
        r = _score(_find("latin_in_korean", "latin_two_words"), "joined")
        self.assertEqual(r.syllable_cer, 0.0)

    def test_hyphen_is_punctuation_not_content(self):
        item = _find("numbers", "num_phone_reading")
        self.assertEqual(kc.normalize_text(item.hypothesis("hyphenated_digits").text),
                         kc.normalize_text(item.hypothesis(fx.DEGRADED_LABEL).text))

    def test_percent_is_kept_as_content(self):
        item = _find("numbers", "num_percent_symbol")
        self.assertIn("%", kc.normalize_text(item.reference_text))
        self.assertGreater(_score(item, fx.DEGRADED_LABEL).syllable_cer, 0.0)


# ────────────────────────── 표현 이벤트 probe ──────────────────────────
class ExpressionEventProbeTest(unittest.TestCase):

    def test_probes_are_scored_outside_cer_categories(self):
        results = fx.evaluate_expression_probes(fx.mock_asr(fx.PERFECT_LABEL), PROV)
        self.assertEqual(len(results), len(fx.EXPRESSION_EVENT_PROBES))
        for r in results:
            self.assertEqual(r.category, fx.PROBE_GROUP_EXPRESSION_EVENTS)
            self.assertNotIn(r.category, fx.CATEGORIES)

    def test_perfect_probes_match_every_event(self):
        for r in fx.evaluate_expression_probes(fx.mock_asr(fx.PERFECT_LABEL), PROV):
            self.assertEqual(r.syllable_cer, 0.0, msg=r.item_id)
            self.assertEqual(r.events.missing_count, 0, msg=r.item_id)
            self.assertEqual(r.events.spurious_count, 0, msg=r.item_id)
            self.assertEqual(r.events.matched_count, r.events.expected_count,
                             msg=r.item_id)
            self.assertEqual(r.events.magnitude_mismatch_count, 0, msg=r.item_id)

    def test_missing_laugh_does_not_move_character_cer(self):
        r = _score(_probe("probe_laugh_missing"), fx.DEGRADED_LABEL)
        self.assertEqual(r.syllable_cer, 0.0)
        self.assertEqual(r.events.expected_count, 1)
        self.assertEqual(r.events.missing_count, 1)
        self.assertEqual(r.events.spurious_count, 0)

    def test_extra_laugh_is_reported_as_spurious(self):
        r = _score(_probe("probe_laugh_missing"), "spurious_laugh")
        self.assertEqual(r.syllable_cer, 0.0)
        self.assertEqual(r.events.matched_count, 1)
        self.assertEqual(r.events.spurious_count, 1)
        self.assertEqual(r.events.missing_count, 0)

    def test_missing_emotion_tag(self):
        r = _score(_probe("probe_emotion_tag"), fx.DEGRADED_LABEL)
        self.assertEqual(r.syllable_cer, 0.0)
        self.assertEqual(r.events.missing_count, 1)

    def test_wrong_emotion_is_missing_plus_spurious(self):
        r = _score(_probe("probe_emotion_tag"), "wrong_emotion")
        self.assertEqual(r.syllable_cer, 0.0)
        self.assertEqual(r.events.missing_count, 1)
        self.assertEqual(r.events.spurious_count, 1)
        self.assertEqual(r.events.matched_count, 0)

    def test_transition_mode_change_is_not_a_magnitude_change(self):
        """[기쁨] → [기쁨|즉시] 는 범주적 차이라 identity 가 달라진다."""
        r = _score(_probe("probe_emotion_tag"), "immediate_mode")
        self.assertEqual(r.syllable_cer, 0.0)
        self.assertEqual(r.events.matched_count, 0)
        self.assertEqual(r.events.missing_count, 1)
        self.assertEqual(r.events.spurious_count, 1)

    def test_missing_prosody_tokens(self):
        r = _score(_probe("probe_prosody_punct"), fx.DEGRADED_LABEL)
        self.assertEqual(r.syllable_cer, 0.0)
        self.assertEqual(r.events.expected_count, 2)
        self.assertEqual(r.events.missing_count, 2)

    def test_flattened_punctuation_substitutes_a_different_prosody(self):
        """마침표 1개는 계약상 firm_end — '사라짐'이 아니라 '다른 운율로 바뀜'이다."""
        r = _score(_probe("probe_prosody_punct"), "flattened_punct")
        self.assertEqual(r.syllable_cer, 0.0)
        self.assertEqual(r.events.missing_count, 2)
        self.assertEqual(r.events.spurious_count, 2)
        self.assertEqual(r.events.matched_count, 0)

    def test_alias_form_matches_completely(self):
        """'?!'↔'!?' 별칭과 '...'↔'…' 개수 동치는 계약이 확정한 것이다."""
        r = _score(_probe("probe_prosody_punct"), "alias_form")
        self.assertEqual(r.syllable_cer, 0.0)
        self.assertEqual(r.events.matched_count, 2)
        self.assertEqual(r.events.missing_count, 0)
        self.assertEqual(r.events.spurious_count, 0)
        self.assertEqual(r.events.magnitude_mismatch_count, 0)

    def test_content_error_with_intact_events(self):
        r = _score(_probe("probe_content_error_with_event"), fx.DEGRADED_LABEL)
        self.assertGreater(r.syllable_cer, 0.0)
        self.assertEqual(r.events.missing_count, 0)
        self.assertEqual(r.events.spurious_count, 0)

    def test_attenuated_event_is_matched_with_magnitude_mismatch(self):
        r = _score(_probe("probe_magnitude_attenuated"), fx.DEGRADED_LABEL)
        self.assertEqual(r.syllable_cer, 0.0)
        self.assertEqual(r.events.matched_count, 1)
        self.assertEqual(r.events.missing_count, 0)
        self.assertEqual(r.events.spurious_count, 0)
        self.assertEqual(r.events.magnitude_mismatch_count, 1)

    def test_difference_beyond_the_contract_cap_is_already_gone(self):
        r = _score(_probe("probe_magnitude_attenuated"), "capped_run")
        self.assertEqual(r.events.matched_count, 1)
        self.assertEqual(r.events.magnitude_mismatch_count, 0)

    def test_vowel_extend_token_is_not_content(self):
        item = _probe("probe_vowel_extend")
        self.assertEqual(kc.normalize_text(item.reference_text),
                         kc.normalize_text(item.hypothesis(fx.DEGRADED_LABEL).text))
        r = _score(item, fx.DEGRADED_LABEL)
        self.assertEqual(r.syllable_cer, 0.0)
        self.assertEqual(r.events.missing_count, 1)

    def test_explicit_pause_missing_and_length_only(self):
        missing = _score(_probe("probe_explicit_pause"), fx.DEGRADED_LABEL)
        self.assertEqual(missing.syllable_cer, 0.0)
        self.assertEqual(missing.events.missing_count, 1)
        longer = _score(_probe("probe_explicit_pause"), "longer_pause")
        self.assertEqual(longer.events.matched_count, 1)   # 길이는 identity 가 아니다
        self.assertEqual(longer.events.magnitude_mismatch_count, 1)

    def test_contract_parse_failure_is_visible_and_cer_survives(self):
        r = _score(_probe("probe_contract_parse_failure"), fx.DEGRADED_LABEL)
        self.assertFalse(r.events.contract_ok)
        self.assertFalse(r.events.hypothesis_contract_ok)
        self.assertTrue(r.events.reference_contract_ok)
        self.assertIn("UNKNOWN_EXPRESSIVE_TAG", r.events.contract_diagnostic_codes)
        self.assertGreater(r.syllable_cer, 0.0)

    def test_probes_use_contract_syntax_only(self):
        """probe 표기는 계약 문법이어야 한다 — 본문의 맨 ㅋㅋ 는 이벤트가 아니다."""
        for it in fx.EXPRESSION_EVENT_PROBES:
            if it.item_id == "probe_contract_parse_failure":
                continue
            parse = kc.extract_expression_events(it.reference_text)
            self.assertTrue(parse.contract_ok, msg=it.item_id)
            self.assertGreaterEqual(len(parse.events), 1, msg=it.item_id)


# ────────────────────────── 계약 각인 ──────────────────────────
class ContractStampTest(unittest.TestCase):

    def _all_reports(self):
        out = []
        for label in (fx.PERFECT_LABEL, fx.DEGRADED_LABEL):
            for agg in fx.evaluate_all(fx.mock_asr(label), PROV).values():
                out.extend(r.events for r in agg.items)
            out.extend(r.events for r
                       in fx.evaluate_expression_probes(fx.mock_asr(label), PROV))
        return out

    def test_token_spec_version_is_stamped_and_not_provisional(self):
        for rep in self._all_reports():
            self.assertEqual(rep.token_spec_version, kc.EXPRESSION_TOKEN_SPEC_VERSION)
            self.assertNotIn("provisional", rep.token_spec_version)

    def test_contract_version_and_fingerprint_are_stamped(self):
        for rep in self._all_reports():
            self.assertEqual(rep.expressive_contract_version,
                             et.EXPRESSIVE_CONTRACT_VERSION)
            self.assertEqual(rep.expressive_contract_fingerprint,
                             kc.EXPRESSIVE_CONTRACT_FINGERPRINT)
            self.assertEqual(rep.expressive_mode, kc.EXPRESSIVE_EVAL_MODE)

    def test_timeline_sha256_is_recorded_when_the_contract_parses(self):
        for rep in self._all_reports():
            if not rep.contract_ok:
                continue
            self.assertEqual(len(rep.reference_timeline_sha256), 64, msg=rep.item_id)
            self.assertEqual(len(rep.hypothesis_timeline_sha256), 64, msg=rep.item_id)

    def test_timeline_sha256_differs_when_the_text_differs(self):
        rep = _score(_probe("probe_prosody_punct"), fx.DEGRADED_LABEL).events
        self.assertNotEqual(rep.reference_timeline_sha256,
                            rep.hypothesis_timeline_sha256)

    def test_timeline_sha256_matches_for_the_perfect_mock(self):
        rep = _score(_probe("probe_prosody_punct"), fx.PERFECT_LABEL).events
        self.assertEqual(rep.reference_timeline_sha256,
                         rep.hypothesis_timeline_sha256)

    def test_fixture_set_version_tracks_the_token_rewrite(self):
        self.assertIn("2.0.0", fx.FIXTURE_SET_VERSION)

# ────────────────────────── mock ASR · provenance ──────────────────────────
class MockAsrAndProvenanceTest(unittest.TestCase):

    def test_mock_provenance_is_valid_and_current(self):
        self.assertEqual(PROV.normalization_version, kc.NORMALIZATION_VERSION)
        self.assertIn("mock", PROV.asr_model_name)
        self.assertIn("synthetic", PROV.asr_model_version)

    def test_mock_asr_perfect_returns_reference(self):
        fn = fx.mock_asr(fx.PERFECT_LABEL)
        for c in fx.CATEGORIES:
            for it in fx.items_for(c):
                self.assertEqual(fn(it), it.reference_text, msg=it.item_id)

    def test_mock_asr_unknown_label_raises(self):
        fn = fx.mock_asr("no_such_label")
        with self.assertRaises(KeyError):
            fn(fx.items_for("numbers")[0])

    def test_every_result_carries_full_provenance(self):
        reports = fx.evaluate_all(fx.mock_asr(fx.DEGRADED_LABEL), PROV)
        for agg in reports.values():
            self.assertEqual(agg.provenance, PROV)
            for r in agg.items:
                d = r.to_dict()["provenance"]
                self.assertEqual(sorted(d),
                                 ["asr_model_fingerprint", "asr_model_name",
                                  "asr_model_version", "normalization_version"])

    def test_stale_normalization_version_is_rejected(self):
        stale = kc.AsrProvenance("mock-asr", "0.0.0-synthetic", "sha256:x",
                                 "audioforge/ko-cer-normalization 0.0.1")
        with self.assertRaises(kc.ProvenanceError):
            fx.evaluate_category("numbers", fx.mock_asr(fx.PERFECT_LABEL), stale)

    def test_evaluation_is_deterministic(self):
        first = {c: agg.to_dict() for c, agg
                 in fx.evaluate_all(fx.mock_asr(fx.DEGRADED_LABEL), PROV).items()}
        again = {c: agg.to_dict() for c, agg
                 in fx.evaluate_all(fx.mock_asr(fx.DEGRADED_LABEL), PROV).items()}
        self.assertEqual(json.dumps(first, ensure_ascii=False, sort_keys=True),
                         json.dumps(again, ensure_ascii=False, sort_keys=True))


# ────────────────────────── 금지 이름 스캔 ──────────────────────────
class FixtureForbiddenNamingTest(unittest.TestCase):

    def _fixture_names(self):
        names = [n for n in dir(fx) if not n.startswith("_")]
        names.extend(fx.CATEGORIES)
        names.append(fx.PROBE_GROUP_EXPRESSION_EVENTS)
        groups = [fx.items_for(c) for c in fx.CATEGORIES] + [fx.EXPRESSION_EVENT_PROBES]
        for items in groups:
            for it in items:
                names.append(it.item_id)
                names.extend(it.labels())
        return names

    def test_no_forbidden_name_in_fixture_module(self):
        offenders = kc.scan_forbidden_names(self._fixture_names())
        self.assertEqual(offenders, (), msg="fixture 금지 이름: {0}".format(offenders))

    def test_no_forbidden_key_in_fixture_reports(self):
        keys = []
        reports = fx.evaluate_all(fx.mock_asr(fx.DEGRADED_LABEL), PROV)
        for agg in reports.values():
            _collect_keys(agg.to_dict(), keys)
        keys.extend(reports)
        self.assertEqual(kc.scan_forbidden_names(keys), ())

    def test_fixture_docstring_states_it(self):
        doc = fx.__doc__ or ""
        self.assertIn("자연스러움 점수가 아니다", doc)


def _collect_keys(node, out):
    if isinstance(node, dict):
        for k, v in node.items():
            out.append(str(k))
            _collect_keys(v, out)
    elif isinstance(node, (list, tuple)):
        for v in node:
            _collect_keys(v, out)


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


class FixtureRecordHygieneTest(unittest.TestCase):
    """fixture 평가가 만들어 내는 레코드에도 경로·오디오·바이너리가 없어야 한다."""

    def _records(self):
        recs = []
        for label in (fx.PERFECT_LABEL, fx.DEGRADED_LABEL):
            for agg in fx.evaluate_all(fx.mock_asr(label), PROV).values():
                recs.append(agg.to_dict())
            for r in fx.evaluate_expression_probes(fx.mock_asr(label), PROV):
                recs.append(r.to_dict())
        return recs

    def test_no_filesystem_path_or_audio_reference(self):
        for rec in self._records():
            for kind, trail, node in _walk(rec):
                if kind != "value" or not isinstance(node, str):
                    continue
                self.assertIsNone(_WINDOWS_PATH.search(node), msg=trail)
                self.assertIsNone(_BACKSLASH_PATH.search(node), msg=trail)
                self.assertIsNone(_POSIX_ABS_PATH.search(node), msg=trail)
                self.assertIsNone(_AUDIO_EXT.search(node), msg=trail)

    def test_no_pathlike_keys(self):
        for rec in self._records():
            for kind, trail, node in _walk(rec):
                if kind != "key":
                    continue
                lowered = str(node).lower()
                for bad in _PATHY_KEYS:
                    self.assertNotIn(bad, lowered, msg=trail)

    def test_no_binary_values(self):
        for rec in self._records():
            for kind, trail, node in _walk(rec):
                if kind != "value":
                    continue
                self.assertIsInstance(node, (str, int, float, bool, type(None)),
                                      msg="{0} -> {1}".format(trail, type(node).__name__))

    def test_fixture_reference_text_never_reaches_result_records(self):
        """결과 레코드는 body-free — fixture 원문이 통째로 실리지 않는다."""
        blob = json.dumps(self._records(), ensure_ascii=False)
        for c in fx.CATEGORIES:
            for it in fx.items_for(c):
                self.assertNotIn(it.reference_text, blob, msg=it.item_id)

    def test_records_are_json_serializable(self):
        for rec in self._records():
            json.dumps(rec, ensure_ascii=False, sort_keys=True)


if __name__ == "__main__":
    unittest.main()
