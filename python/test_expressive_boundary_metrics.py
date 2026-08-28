# -*- coding: utf-8 -*-
"""expressive_boundary_metrics.py 단위 테스트 — SYNTHETIC 신호만. 모델/GPU/사용자 오디오 미사용.

이 레이어의 계약은 '얇음' 이다:
  A. 신호 처리 수식을 스스로 갖지 않고 onset_continuity_metrics 에 위임한다(중복 금지의 정적 확인)
  B. 계획서 청크 순서 + 실측 샘플 수 → 구간 환산이 정확하다
  C. 계획 주석은 '숫자만' 이다(문자열 필드 없음)
  D. 임베딩 함수는 주입될 때만 쓰이고, 없으면 미가용으로 표기된다
"""
import ast
import io
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np

import expressive_boundary_metrics as ebm
import expressive_capability as cap
import expressive_planner as pl
import onset_continuity_metrics as ocm

SR = 24000


def tone(n, f0, amp=0.2):
    t = np.arange(n, dtype=np.float64) / float(SR)
    return (amp * np.sin(2.0 * np.pi * f0 * t)).astype(np.float32)


def settings(**kw):
    base = dict(settings_id="s", speaker_id="sp", language="ko",
                reference_clip_id="r", reference_transcript_id="t",
                max_tokens=400, token_counter_id="test_char_counter")
    base.update(kw)
    return pl.GenerationSettings(**base)


def make_plan(raw="가 하나. [기쁨] 둘 문장. 셋 문장 [ㅋㅋ] 넷.", profile=None):
    res = pl.plan_from_raw(raw, settings(), profile or cap.unknown_profile("e"),
                           pl.approximate_count_tokens)
    return res["plan"]


def signal_for(plan, gap_sec=0.1, chunk_sec=1.0):
    """계획 청크 수만큼 톤을 이어 붙인 합성 신호와 (샘플 수, 앞 무음) 목록."""
    n = len(plan["chunks"])
    counts, gaps, parts = [], [], []
    for i in range(n):
        g = 0 if i == 0 else int(gap_sec * SR)
        c = int(chunk_sec * SR)
        if g:
            parts.append(np.zeros(g, dtype=np.float32))
        parts.append(tone(c, 120.0 + 40.0 * i, 0.2 + 0.05 * i))
        counts.append(c)
        gaps.append(g)
    return np.concatenate(parts), counts, gaps


# ────────────────────────── A. 얇음(수식 중복 없음) ──────────────────────────

class TestThinLayer(unittest.TestCase):

    SOURCE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "expressive_boundary_metrics.py")

    def source_tree(self):
        with io.open(self.SOURCE, "r", encoding="utf-8") as fh:
            return ast.parse(fh.read())

    def test_module_defines_no_signal_math_of_its_own(self):
        defined = {n.name for n in ast.walk(self.source_tree()) if isinstance(n, ast.FunctionDef)}
        for banned in ("f0_hz", "window_stats", "rms_of", "peak_of", "mel_distance",
                       "mel_spectrum", "mel_filterbank", "cosine_distance", "speaker_distance",
                       "onset_slope", "sample_jump", "trailing_low_energy_len",
                       "leading_low_energy_len", "ms_to_samples", "stable_region"):
            self.assertNotIn(banned, defined, banned)

    def test_module_does_not_import_numpy_or_any_audio_library(self):
        imported = set()
        for node in ast.walk(self.source_tree()):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imported.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        self.assertEqual(imported, {"typing", "expressive_planner", "onset_continuity_metrics"})

    def test_expressive_layer_defines_no_general_continuity_thresholds(self):
        """일반 연속성 임계는 권위 모듈의 상수다 — 여기서 표현형 전용으로 복제하지 않는다."""
        with io.open(self.SOURCE, "r", encoding="utf-8") as fh:
            src = fh.read()
        for banned in ("ONSET_WINDOW_MS", "STABLE_MARGIN_MS", "STABLE_MIN_MS",
                       "F0_MIN_HZ", "F0_MAX_HZ", "SILENCE_REL_THRESHOLD",
                       "TRAILING_REL_THRESHOLD", "MEL_N_MELS"):
            self.assertNotIn(banned, src, banned)

    def test_errors_are_the_authority_modules_errors(self):
        self.assertIs(ebm.MetricsError, ocm.MetricsError)
        self.assertIs(ebm.PrivacyViolation, ocm.PrivacyViolation)


# ────────────────────────── B. 구간 환산 ──────────────────────────

class TestSpanDerivation(unittest.TestCase):

    def test_spans_follow_the_plan_order_with_exact_offsets(self):
        plan = make_plan()
        sig, counts, gaps = signal_for(plan)
        spans = ebm.chunk_spans_from_plan(plan, counts, gaps)
        self.assertEqual(len(spans), len(plan["chunks"]))
        cursor = 0
        for i, sp in enumerate(spans):
            cursor += gaps[i]
            self.assertEqual(sp.start_sample, cursor)
            self.assertEqual(sp.end_sample, cursor + counts[i])
            self.assertEqual(sp.gap_before_samples, gaps[i])
            self.assertEqual(sp.chunk_index, plan["chunks"][i]["index"])
            cursor += counts[i]
        self.assertEqual(cursor, sig.size)

    def test_gaps_default_to_zero_when_not_supplied(self):
        plan = make_plan()
        counts = [SR] * len(plan["chunks"])
        spans = ebm.chunk_spans_from_plan(plan, counts)
        self.assertTrue(all(sp.gap_before_samples == 0 for sp in spans))

    def test_mismatched_counts_are_rejected(self):
        plan = make_plan()
        with self.assertRaises(ebm.MetricsError):
            ebm.chunk_spans_from_plan(plan, [SR] * (len(plan["chunks"]) + 1))
        with self.assertRaises(ebm.MetricsError):
            ebm.chunk_spans_from_plan(plan, [SR] * len(plan["chunks"]), [0])

    def test_non_positive_or_negative_values_are_rejected(self):
        plan = make_plan()
        n = len(plan["chunks"])
        with self.assertRaises(ebm.MetricsError):
            ebm.chunk_spans_from_plan(plan, [0] * n)
        with self.assertRaises(ebm.MetricsError):
            ebm.chunk_spans_from_plan(plan, [SR] * n, [-1] * n)


# ────────────────────────── C. 계획 주석(숫자만) ──────────────────────────

class TestAnnotations(unittest.TestCase):

    def test_annotation_fields_are_exactly_the_contract(self):
        plan = make_plan()
        for a in ebm.build_annotations(plan):
            self.assertEqual(tuple(a.keys()), ebm.ANNOTATION_FIELDS)

    def test_annotations_contain_integers_only(self):
        plan = make_plan()
        for a in ebm.build_annotations(plan):
            ser = ebm.serialize_annotation(a)
            for key, value in ser.items():
                self.assertIsInstance(value, int, key)
                self.assertNotIsInstance(value, bool, key)

    def test_split_reason_is_stored_as_a_contract_index_not_text(self):
        plan = make_plan()
        for a, c in zip(ebm.build_annotations(plan), plan["chunks"]):
            self.assertEqual(pl.SPLIT_REASON_CODES[a["split_reason_index"]], c["end_reason"])

    def test_strategy_is_stored_as_a_contract_index(self):
        plan = make_plan()
        idx = ebm.build_annotations(plan)[0]["emotion_strategy_index"]
        self.assertEqual(pl.EMOTION_STRATEGIES[idx], plan["emotion_strategy"]["strategy"])

    def test_missing_gap_is_encoded_as_minus_one_not_none(self):
        plan = make_plan("한 문장.")
        a = ebm.build_annotations(plan)[0]
        self.assertEqual(a["leading_gap_ms"], -1)
        self.assertEqual(a["trailing_gap_ms"], -1)

    def test_explicit_pause_gap_is_carried_as_a_number(self):
        plan = make_plan("가 하나. [쉼 1.0] 둘 문장.")
        anns = ebm.build_annotations(plan)
        self.assertEqual(anns[0]["trailing_gap_ms"], 1000)
        self.assertEqual(anns[1]["leading_gap_ms"], 1000)

    def test_laugh_position_and_strategy_are_indices(self):
        plan = make_plan("가 하나 [ㅋㅋ] 둘.",
                         profile=cap.build_profile(
                             "l", claims={"nonverbal_laugh_instruction": "supported"},
                             evidence={"nonverbal_laugh_instruction": cap.ProbeEvidence(
                                 "nonverbal_laugh_instruction", True, True, True)}))
        a = [x for x in ebm.build_annotations(plan) if x["laugh_count"] > 0][0]
        self.assertGreaterEqual(a["laugh_position_index"], 0)
        self.assertEqual(pl.LAUGH_STRATEGIES[a["laugh_strategy_index"]],
                         "model_native_instruction")
        self.assertEqual(a["laugh_checks_required"], len(pl.LAUGH_REQUIRED_CHECKS))

    def test_unavailable_laugh_strategy_is_encoded_as_minus_one(self):
        plan = make_plan("가 하나 [ㅋㅋ] 둘.")     # unknown_profile → 전략 없음
        a = [x for x in ebm.build_annotations(plan) if x["laugh_count"] > 0][0]
        self.assertEqual(a["laugh_strategy_index"], -1)

    def test_serializer_rejects_text_or_extra_fields(self):
        plan = make_plan()
        base = ebm.build_annotations(plan)[0]
        poisoned = dict(base)
        poisoned["source_path"] = "C:/tmp/x.wav"
        with self.assertRaises(ebm.PrivacyViolation):
            ebm.serialize_annotation(poisoned)
        poisoned = dict(base)
        poisoned["sentence_count"] = "두 문장"
        with self.assertRaises(ebm.PrivacyViolation):
            ebm.serialize_annotation(poisoned)
        poisoned = dict(base)
        poisoned.pop("chunk_index")
        with self.assertRaises(ebm.PrivacyViolation):
            ebm.serialize_annotation(poisoned)


# ────────────────────────── D. 통합 계측 ──────────────────────────

class TestMeasurePlan(unittest.TestCase):

    def test_measurement_records_come_from_the_authority_module(self):
        plan = make_plan()
        sig, counts, gaps = signal_for(plan)
        out = ebm.measure_plan(sig, SR, plan, counts, gaps)
        self.assertEqual(len(out["records"]), len(plan["chunks"]))
        for rec in out["records"]:
            self.assertEqual(tuple(rec.keys()), ocm.ONSET_RECORD_FIELDS)

    def test_no_embed_function_means_speaker_distance_unavailable(self):
        plan = make_plan()
        sig, counts, gaps = signal_for(plan)
        out = ebm.measure_plan(sig, SR, plan, counts, gaps)
        self.assertEqual(out["embed_available"], 0)
        for rec in out["records"]:
            self.assertEqual(rec["speaker_distance_available"], 0)

    def test_injected_embed_function_is_used(self):
        plan = make_plan()
        sig, counts, gaps = signal_for(plan)
        seen = []

        def embed(x, rate):
            seen.append(int(x.size))
            return [float(np.mean(np.abs(x))), float(np.std(x)), 1.0]

        out = ebm.measure_plan(sig, SR, plan, counts, gaps, embed_fn=embed)
        self.assertEqual(out["embed_available"], 1)
        self.assertEqual(len(seen), 2 * len(plan["chunks"]))
        for rec in out["records"]:
            self.assertEqual(rec["speaker_distance_available"], 1)

    def test_serialised_measurement_is_numbers_only(self):
        plan = make_plan()
        sig, counts, gaps = signal_for(plan)
        ser = ebm.serialize_measurement(ebm.measure_plan(sig, SR, plan, counts, gaps))
        for group in ("records", "annotations"):
            for rec in ser[group]:
                for key, value in rec.items():
                    self.assertIsInstance(value, (int, float), "%s/%s" % (group, key))
                    self.assertNotIsInstance(value, bool, "%s/%s" % (group, key))
        self.assertIsInstance(ser["span_count"], int)

    def test_measurement_is_deterministic(self):
        plan = make_plan()
        sig, counts, gaps = signal_for(plan)

        def embed(x, rate):
            return [float(np.mean(np.abs(x))), float(np.std(x)), 1.0]

        a = ebm.serialize_measurement(ebm.measure_plan(sig, SR, plan, counts, gaps, embed_fn=embed))
        b = ebm.serialize_measurement(ebm.measure_plan(sig, SR, plan, counts, gaps, embed_fn=embed))
        self.assertEqual(a, b)

    def test_no_transcript_or_path_can_reach_a_record(self):
        """계획서에는 대사가 들어 있지만 계측 산출물에는 흔적이 없다."""
        plan = make_plan("비밀 대사 하나. 비밀 대사 둘.")
        self.assertIn("비밀", plan["chunks"][0]["generation_text"])
        sig, counts, gaps = signal_for(plan)
        ser = ebm.serialize_measurement(ebm.measure_plan(sig, SR, plan, counts, gaps))
        blob = repr(ser)
        self.assertNotIn("비밀", blob)
        self.assertNotIn("대사", blob)


if __name__ == "__main__":
    unittest.main()
