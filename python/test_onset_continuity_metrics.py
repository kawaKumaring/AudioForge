# -*- coding: utf-8 -*-
"""onset_continuity_metrics.py 단위 테스트 — SYNTHETIC 신호만(사용자 음성/실제 오디오 미사용).

전 신호는 numpy 로 생성하고 난수는 고정 seed 만 쓴다(벽시계·환경 의존 없음 → 반복 실행 동일 결과).
모델을 로드하지 않는다 — 화자 임베딩은 테스트가 주입한 순수 함수뿐이다.

축:
  A. 1차 함수(창 통계/이음매 단차/zero-cross/저에너지 꼬리)가 boundary_metrics 와 '같은 한 벌' 인가
  B. F0 / mel 거리 / 화자 거리 / 온셋 기울기 / 무음 길이가 합성 신호에서 기대대로 움직이는가
  C. 레코드는 '숫자만' 담는가(하드 프라이버시 요건)
  D. 모듈이 파일/네트워크/로그/서브프로세스에 손댈 수 없는가(AST 정적 보증)
  E. 결정성
"""
import ast
import io
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np

import boundary_metrics as bm
import onset_continuity_metrics as ocm

SR = 24000


def tone(n, f0, amp=0.2, phase=0.0):
    t = np.arange(n, dtype=np.float64) / float(SR)
    return (amp * np.sin(2.0 * np.pi * f0 * t + phase)).astype(np.float32)


def noise(n, amp, seed):
    rng = np.random.RandomState(seed)
    return (amp * rng.standard_normal(n)).astype(np.float32)


def ramped(n, f0, amp):
    """진폭이 0 에서 amp 까지 선형 증가하는 톤(온셋 기울기 양수 케이스)."""
    env = np.linspace(0.0, 1.0, n, dtype=np.float64)
    return (tone(n, f0, amp).astype(np.float64) * env).astype(np.float32)


def span(idx, start, end, gap=0):
    return ocm.ChunkSpan(chunk_index=idx, start_sample=start, end_sample=end,
                         gap_before_samples=gap)


# ────────────────────────── A. 단일 권위(중복 구현 없음) ──────────────────────────

class TestSingleAuthority(unittest.TestCase):

    def test_boundary_metrics_delegates_primitives_to_this_module(self):
        self.assertIs(bm._ms_to_samples, ocm.ms_to_samples)
        self.assertIs(bm._window_stats, ocm.window_stats)
        self.assertIs(bm._zero_cross_distance_back, ocm.zero_cross_distance_back)
        self.assertIs(bm._zero_cross_distance_fwd, ocm.zero_cross_distance_fwd)

    def test_boundary_metrics_reuses_the_same_constants_and_errors(self):
        self.assertEqual(bm.WINDOW_MS, ocm.WINDOW_MS)
        self.assertEqual(bm.TRAILING_FRAME_MS, ocm.TRAILING_FRAME_MS)
        self.assertEqual(bm.TRAILING_LOOKBACK_MS, ocm.TRAILING_LOOKBACK_MS)
        self.assertEqual(bm.TRAILING_REL_THRESHOLD, ocm.TRAILING_REL_THRESHOLD)
        self.assertIs(bm.BoundaryMetricsError, ocm.MetricsError)
        self.assertIs(bm.PrivacyViolation, ocm.PrivacyViolation)

    def test_boundary_metrics_source_defines_no_rms_or_f0_math(self):
        """중복 구현 금지의 정적 확인 — boundary_metrics 안에 1차 계산 정의가 남아있지 않다."""
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "boundary_metrics.py")
        with io.open(path, "r", encoding="utf-8") as fh:
            tree = ast.parse(fh.read())
        defined = {n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
        for banned in ("_window_stats", "_zero_cross_distance_back", "_zero_cross_distance_fwd",
                       "_ms_to_samples", "f0_hz", "mel_distance", "speaker_distance"):
            self.assertNotIn(banned, defined, banned)

    def test_window_stats_matches_direct_computation(self):
        sig = tone(1024, 200.0, 0.3)
        rms, peak, dc, hf = ocm.window_stats(sig)
        self.assertAlmostEqual(rms, float(np.sqrt(np.mean(sig.astype(np.float64) ** 2))), places=9)
        self.assertAlmostEqual(peak, float(np.max(np.abs(sig))), places=9)
        self.assertAlmostEqual(rms, ocm.rms_of(sig), places=12)
        self.assertAlmostEqual(peak, ocm.peak_of(sig), places=12)
        # 창이 주기의 정수배가 아니면 DC 는 정확히 0 이 아니다 — 작기만 하면 된다.
        self.assertLess(abs(dc), 0.05)
        self.assertGreater(hf, 0.0)

    def test_empty_window_is_all_zero(self):
        self.assertEqual(ocm.window_stats(np.zeros(0, dtype=np.float32)), (0.0, 0.0, 0.0, 0.0))

    def test_sample_jump_measures_the_actual_step(self):
        sig = np.array([0.0, 0.0, 0.5, 0.5], dtype=np.float32)
        self.assertAlmostEqual(ocm.sample_jump(sig, 2), 0.5, places=6)
        with self.assertRaises(ocm.MetricsError):
            ocm.sample_jump(sig, 0)


# ────────────────────────── B. 새 계측 ──────────────────────────

class TestF0(unittest.TestCase):

    def test_pure_tone_f0_is_recovered(self):
        for f in (100.0, 150.0, 220.0):
            got = ocm.f0_hz(tone(SR // 4, f), SR)
            self.assertLess(abs(got - f) / f, 0.02, f)

    def test_silence_and_noise_report_zero_not_a_fake_pitch(self):
        self.assertEqual(ocm.f0_hz(np.zeros(4096, dtype=np.float32), SR), 0.0)
        self.assertEqual(ocm.f0_hz(np.zeros(1, dtype=np.float32), SR), 0.0)

    def test_out_of_range_pitch_is_not_reported_inside_the_band(self):
        got = ocm.f0_hz(tone(SR // 4, 1000.0), SR, fmin=60.0, fmax=400.0)
        self.assertTrue(got == 0.0 or 60.0 <= got <= 400.0)

    def test_two_different_pitches_are_distinguished(self):
        a = ocm.f0_hz(tone(SR // 4, 120.0), SR)
        b = ocm.f0_hz(tone(SR // 4, 200.0), SR)
        self.assertGreater(abs(a - b), 50.0)


class TestMelDistance(unittest.TestCase):

    def test_identical_windows_have_zero_distance(self):
        w = tone(4096, 180.0)
        self.assertAlmostEqual(ocm.mel_distance(w, w, SR), 0.0, places=9)

    def test_different_spectra_have_positive_distance(self):
        a = tone(4096, 120.0)
        b = tone(4096, 320.0)
        self.assertGreater(ocm.mel_distance(a, b, SR), 0.5)

    def test_distance_is_symmetric(self):
        a, b = tone(4096, 120.0), tone(4096, 320.0)
        self.assertAlmostEqual(ocm.mel_distance(a, b, SR), ocm.mel_distance(b, a, SR), places=9)

    def test_filterbank_shape_and_non_negativity(self):
        fb = ocm.mel_filterbank(SR, ocm.MEL_N_FFT, ocm.MEL_N_MELS)
        self.assertEqual(fb.shape, (ocm.MEL_N_MELS, ocm.MEL_N_FFT // 2 + 1))
        self.assertTrue(bool(np.all(fb >= 0.0)))


class TestSpeakerDistance(unittest.TestCase):

    def test_cosine_distance_bounds(self):
        self.assertAlmostEqual(ocm.cosine_distance([1.0, 0.0], [1.0, 0.0]), 0.0, places=12)
        self.assertAlmostEqual(ocm.cosine_distance([1.0, 0.0], [0.0, 1.0]), 1.0, places=12)
        self.assertAlmostEqual(ocm.cosine_distance([1.0, 0.0], [-1.0, 0.0]), 2.0, places=12)

    def test_zero_vector_is_reported_as_maximum_mismatch_not_an_error(self):
        self.assertEqual(ocm.cosine_distance([0.0, 0.0], [1.0, 0.0]), 1.0)

    def test_mismatched_embedding_sizes_are_rejected(self):
        with self.assertRaises(ocm.MetricsError):
            ocm.cosine_distance([1.0, 0.0], [1.0, 0.0, 0.0])

    def test_injected_embedding_function_is_the_only_source(self):
        calls = []

        def embed(x, rate):
            calls.append((int(x.size), int(rate)))
            return [float(np.mean(np.abs(x))), float(np.std(x))]

        sig = np.concatenate([tone(SR, 120.0), tone(SR, 120.0, 0.9)])
        d = ocm.speaker_distance(sig, (0, SR), (SR, 2 * SR), SR, embed)
        self.assertEqual(len(calls), 2)
        self.assertEqual({c[1] for c in calls}, {SR})
        self.assertGreaterEqual(d, 0.0)

    def test_missing_embed_function_raises_instead_of_loading_anything(self):
        with self.assertRaises(ocm.MetricsError):
            ocm.speaker_distance(tone(1024, 120.0), (0, 512), (512, 1024), SR, None)


class TestOnsetSlopeAndSilence(unittest.TestCase):

    def test_rising_onset_has_positive_slope(self):
        self.assertGreater(ocm.onset_slope(ramped(SR // 2, 150.0, 0.4), 0, SR // 2, SR), 0.0)

    def test_steady_onset_has_near_zero_slope(self):
        self.assertLess(abs(ocm.onset_slope(tone(SR // 2, 150.0, 0.3), 0, SR // 2, SR)), 1e-3)

    def test_falling_onset_has_negative_slope(self):
        rising = ramped(SR // 2, 150.0, 0.4)
        self.assertLess(ocm.onset_slope(rising[::-1].copy(), 0, SR // 2, SR), 0.0)

    def test_too_short_region_reports_zero_not_a_guess(self):
        self.assertEqual(ocm.onset_slope(tone(8, 150.0), 0, 8, SR), 0.0)

    def test_leading_silence_is_measured(self):
        lead = int(0.1 * SR)
        sig = np.concatenate([np.zeros(lead, dtype=np.float32), tone(SR // 2, 150.0, 0.3)])
        got = ocm.leading_low_energy_len(sig, 0, sig.size, SR)
        self.assertGreater(got, lead * 0.8)
        self.assertLess(got, lead * 1.3)

    def test_no_leading_silence_when_signal_starts_hot(self):
        self.assertEqual(ocm.leading_low_energy_len(tone(SR // 2, 150.0, 0.3), 0, SR // 2, SR), 0)

    def test_trailing_low_energy_matches_boundary_metrics_behaviour(self):
        sig = np.concatenate([tone(SR // 2, 150.0, 0.3),
                              noise(int(0.05 * SR), 0.002, 11)])
        direct = ocm.trailing_low_energy_len(sig, sig.size, 0, SR)
        viabm = bm._trailing_low_energy_len(sig, sig.size, 0, SR, bm.TRAILING_FRAME_MS,
                                            bm.TRAILING_LOOKBACK_MS, bm.TRAILING_REL_THRESHOLD)
        self.assertEqual(direct, viabm)
        self.assertGreater(direct, 0)


# ────────────────────────── B2. 청크 레코드 ──────────────────────────

def two_chunk_case(second_amp=0.2, second_f0=120.0, gap_sec=0.0):
    a = tone(SR, 120.0, 0.2)
    b = tone(SR, second_f0, second_amp)
    gap = np.zeros(int(gap_sec * SR), dtype=np.float32)
    sig = np.concatenate([a, gap, b])
    spans = [span(0, 0, a.size),
             span(1, a.size + gap.size, a.size + gap.size + b.size, gap.size)]
    return sig, spans


class TestChunkRecords(unittest.TestCase):

    def test_records_have_exactly_the_contract_fields(self):
        sig, spans = two_chunk_case()
        for rec in ocm.compute_onset_continuity_metrics(sig, SR, spans):
            self.assertEqual(tuple(rec.keys()), ocm.ONSET_RECORD_FIELDS)

    def test_no_spans_yields_no_records(self):
        self.assertEqual(ocm.compute_onset_continuity_metrics(tone(1024, 120.0), SR, []), [])

    def test_onset_window_is_the_first_300ms(self):
        sig, spans = two_chunk_case()
        recs = ocm.compute_onset_continuity_metrics(sig, SR, spans)
        expected = ocm.ms_to_samples(ocm.ONSET_WINDOW_MS, SR)
        for rec in recs:
            self.assertEqual(rec["onset_window_samples"], expected)

    def test_stable_region_excludes_the_margins(self):
        sig, spans = two_chunk_case()
        rec = ocm.compute_onset_continuity_metrics(sig, SR, spans)[0]
        margin = ocm.ms_to_samples(ocm.STABLE_MARGIN_MS, SR)
        self.assertEqual(rec["stable_start_sample"], spans[0].start_sample + margin)
        self.assertEqual(rec["stable_end_sample"], spans[0].end_sample - margin)
        self.assertEqual(rec["stable_region_fallback"], 0)

    def test_short_chunk_falls_back_and_says_so(self):
        short = tone(int(0.2 * SR), 120.0)
        rec = ocm.compute_onset_continuity_metrics(short, SR, [span(0, 0, short.size)])[0]
        self.assertEqual(rec["stable_region_fallback"], 1)
        self.assertEqual(rec["stable_start_sample"], 0)

    def test_level_mismatch_shows_in_rms_delta_db(self):
        quiet = np.concatenate([tone(int(0.3 * SR), 120.0, 0.02), tone(SR, 120.0, 0.4)])
        rec = ocm.compute_onset_continuity_metrics(quiet, SR, [span(0, 0, quiet.size)])[0]
        self.assertLess(rec["rms_delta_db"], -10.0)

    def test_pitch_mismatch_shows_in_f0_delta(self):
        sig = np.concatenate([tone(int(0.3 * SR), 300.0, 0.3), tone(SR, 120.0, 0.3)])
        rec = ocm.compute_onset_continuity_metrics(sig, SR, [span(0, 0, sig.size)])[0]
        self.assertGreater(rec["f0_delta_hz"], 100.0)
        self.assertGreater(rec["f0_ratio"], 1.5)

    def test_speaker_distance_is_unavailable_without_an_embed_function(self):
        sig, spans = two_chunk_case()
        for rec in ocm.compute_onset_continuity_metrics(sig, SR, spans):
            self.assertEqual(rec["speaker_distance_available"], 0)
            self.assertEqual(rec["speaker_distance"], 0.0)

    def test_speaker_distance_is_computed_when_an_embed_function_is_injected(self):
        sig = np.concatenate([tone(int(0.3 * SR), 120.0, 0.05), tone(SR, 120.0, 0.5)])

        def embed(x, rate):
            return [float(np.mean(np.abs(x))), float(np.max(np.abs(x)) + 1e-9), 1.0]

        rec = ocm.compute_onset_continuity_metrics(sig, SR, [span(0, 0, sig.size)],
                                                   embed_fn=embed)[0]
        self.assertEqual(rec["speaker_distance_available"], 1)
        self.assertGreater(rec["speaker_distance"], 0.0)

    def test_declared_gap_is_recorded_and_boundary_jump_is_measurable(self):
        sig, spans = two_chunk_case(gap_sec=0.2)
        recs = ocm.compute_onset_continuity_metrics(sig, SR, spans)
        self.assertEqual(recs[0]["boundary_sample_jump_available"], 0)   # 신호 맨 앞
        self.assertEqual(recs[1]["boundary_sample_jump_available"], 1)
        self.assertEqual(recs[1]["gap_before_samples"], int(0.2 * SR))

    def test_bad_inputs_are_rejected_with_numeric_messages(self):
        sig = tone(SR, 120.0)
        with self.assertRaises(ocm.MetricsError):
            ocm.compute_onset_continuity_metrics(np.zeros((2, 4), dtype=np.float32), SR,
                                                 [span(0, 0, 2)])
        with self.assertRaises(ocm.MetricsError):
            ocm.compute_onset_continuity_metrics(sig, 0, [span(0, 0, 10)])
        with self.assertRaises(ocm.MetricsError):
            ocm.compute_onset_continuity_metrics(sig, SR, [span(0, 0, sig.size + 1)])
        with self.assertRaises(ocm.MetricsError):
            ocm.compute_onset_continuity_metrics(sig, SR, [span(0, 10, 10)])
        with self.assertRaises(ocm.MetricsError):
            ocm.compute_onset_continuity_metrics(sig, SR, ["not a span"])


# ────────────────────────── C. 프라이버시(숫자만) ──────────────────────────

class TestPrivacy(unittest.TestCase):

    def records(self):
        sig, spans = two_chunk_case(gap_sec=0.1)
        return ocm.compute_onset_continuity_metrics(sig, SR, spans)

    def test_serialised_records_contain_numbers_only(self):
        for rec in ocm.serialize_records(self.records()):
            self.assertEqual(set(rec.keys()), set(ocm.ONSET_RECORD_FIELDS))
            for key, value in rec.items():
                self.assertIsInstance(value, (int, float), key)
                self.assertNotIsInstance(value, bool, key)
                self.assertTrue(math.isfinite(float(value)), key)

    def test_no_string_field_exists_at_all(self):
        for rec in ocm.serialize_records(self.records()):
            self.assertFalse([k for k, v in rec.items() if isinstance(v, str)])

    def test_formatted_output_has_no_path_or_text_content(self):
        blob = ocm.format_records(self.records())
        for line in blob.splitlines()[1:]:
            for cell in line.split("\t"):
                for bad in ("/", "\\", ":", " ", ".wav", ".txt", "Users", "python"):
                    self.assertNotIn(bad, cell, cell)

    def test_serializer_rejects_extra_fields(self):
        rec = dict(self.records()[0])
        rec["source_path"] = "C:/tmp/out.wav"
        with self.assertRaises(ocm.PrivacyViolation):
            ocm.serialize_record(rec)

    def test_serializer_rejects_missing_fields(self):
        rec = dict(self.records()[0])
        rec.pop("onset_rms")
        with self.assertRaises(ocm.PrivacyViolation):
            ocm.serialize_record(rec)

    def test_serializer_rejects_text_or_audio_in_a_field(self):
        base = self.records()[0]
        for poison in ("C:/Users/x/ref.wav", "안녕하세요 이건 대사입니다", [0.1, 0.2], True):
            rec = dict(base)
            rec["onset_rms"] = poison
            with self.assertRaises(ocm.PrivacyViolation):
                ocm.serialize_record(rec)

    def test_serializer_rejects_non_finite_values(self):
        rec = dict(self.records()[0])
        rec["onset_rms"] = float("inf")
        with self.assertRaises(ocm.PrivacyViolation):
            ocm.serialize_record(rec)


# ────────────────────────── D. 정적 순수성 보증 ──────────────────────────

_ALLOWED_IMPORTS = {"math", "dataclasses", "typing", "numpy"}
_FORBIDDEN_CALLS = {"open", "print", "exec", "eval", "input", "compile", "__import__"}


class TestModulePurity(unittest.TestCase):

    def test_module_cannot_do_io_or_logging(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "onset_continuity_metrics.py")
        with io.open(path, "r", encoding="utf-8") as fh:
            tree = ast.parse(fh.read())
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imported.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    imported.add(node.module.split(".")[0])
        self.assertTrue(imported <= _ALLOWED_IMPORTS,
                        "허용되지 않은 import: %s" % sorted(imported - _ALLOWED_IMPORTS))
        called = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                called.add(node.func.id)
        self.assertEqual(called & _FORBIDDEN_CALLS, set(),
                         "금지된 builtins 호출: %s" % sorted(called & _FORBIDDEN_CALLS))

    def test_module_never_imports_a_model_or_production_worker(self):
        """주석이 아니라 실제 import 문만 본다(문서에 라이브러리 이름이 언급될 수는 있다)."""
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "onset_continuity_metrics.py")
        with io.open(path, "r", encoding="utf-8") as fh:
            tree = ast.parse(fh.read())
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imported.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        for banned in ("torch", "transformers", "librosa", "scipy", "soundfile", "os", "io",
                       "subprocess", "logging", "tts_worker", "qwen_bridge", "audio_finishing",
                       "separate", "boundary_metrics", "expressive_planner"):
            self.assertNotIn(banned, imported, banned)


# ────────────────────────── E. 결정성 ──────────────────────────

class TestDeterminism(unittest.TestCase):

    def test_repeated_runs_are_identical(self):
        sig, spans = two_chunk_case(gap_sec=0.05)

        def embed(x, rate):
            return [float(np.mean(np.abs(x))), float(np.std(x)), 1.0]

        first = ocm.serialize_records(
            ocm.compute_onset_continuity_metrics(sig, SR, spans, embed_fn=embed))
        second = ocm.serialize_records(
            ocm.compute_onset_continuity_metrics(sig, SR, spans, embed_fn=embed))
        self.assertEqual(first, second)

# ────────────────────────── F. 마지막 구간(tail) 축 ──────────────────────────

def decaying(n, f0, amp):
    """진폭이 amp 에서 0 까지 선형 감쇠하는 톤(말끝이 여운으로 사라지는 케이스)."""
    env = np.linspace(1.0, 0.0, n, dtype=np.float64)
    return (tone(n, f0, amp).astype(np.float64) * env).astype(np.float32)


def with_silence(body, lead_ms=0.0, trail_ms=0.0):
    lead = np.zeros(int(lead_ms * SR / 1000.0), dtype=np.float32)
    trail = np.zeros(int(trail_ms * SR / 1000.0), dtype=np.float32)
    return np.concatenate([lead, body, trail])


class TestTailAxis(unittest.TestCase):
    """온셋(첫 300 ms)만 재던 계측에 대칭인 '마지막 구간' 축이 실제로 붙었는가."""

    def test_tail_region_is_the_last_window_and_ends_at_the_chunk_end(self):
        sp = span(0, 1000, 1000 + SR)
        lo, hi = ocm.tail_region(sp, SR)
        self.assertEqual(hi, sp.end_sample)
        self.assertEqual(hi - lo, ocm.ms_to_samples(ocm.TAIL_WINDOW_MS, SR))

    def test_tail_region_never_leaves_the_chunk_when_the_chunk_is_short(self):
        sp = span(0, 0, int(0.1 * SR))
        lo, hi = ocm.tail_region(sp, SR)
        self.assertEqual((lo, hi), (sp.start_sample, sp.end_sample))

    def test_tail_window_samples_is_reported_per_chunk(self):
        sig, spans = two_chunk_case()
        for rec in ocm.compute_onset_continuity_metrics(sig, SR, spans):
            self.assertEqual(rec["tail_window_samples"],
                             ocm.ms_to_samples(ocm.TAIL_WINDOW_MS, SR))

    def test_a_chunk_that_fades_out_has_a_negative_tail_slope(self):
        sig = np.concatenate([tone(SR, 150.0, 0.3), decaying(int(0.3 * SR), 150.0, 0.3)])
        rec = ocm.compute_onset_continuity_metrics(sig, SR, [span(0, 0, sig.size)])[0]
        self.assertLess(rec["tail_slope"], 0.0)
        self.assertLess(rec["tail_rms_delta_db"], -3.0)

    def test_a_chunk_cut_flat_has_a_near_zero_tail_slope(self):
        """'칼로 자른 듯' 한 끝은 기울기가 0 에 가깝다 — 여운으로 사라지는 끝과 수치로 구분된다."""
        sig = tone(2 * SR, 150.0, 0.3)
        rec = ocm.compute_onset_continuity_metrics(sig, SR, [span(0, 0, sig.size)])[0]
        self.assertLess(abs(rec["tail_slope"]), 1e-2)
        self.assertLess(abs(rec["tail_rms_delta_db"]), 0.5)

    def test_tail_pitch_is_reported_next_to_the_stable_pitch(self):
        sig = np.concatenate([tone(SR, 120.0, 0.3), tone(int(0.3 * SR), 300.0, 0.3)])
        rec = ocm.compute_onset_continuity_metrics(sig, SR, [span(0, 0, sig.size)])[0]
        self.assertGreater(rec["tail_f0_delta_hz"], 100.0)
        self.assertGreater(rec["tail_f0_ratio"], 1.5)


# ────────────────────────── G. 유성 프레임 기준 F0(무음 오염 차단) ──────────────────────────

class TestVoicedF0Primitives(unittest.TestCase):

    def test_semitone_delta_is_twelve_log2_of_the_ratio(self):
        self.assertAlmostEqual(ocm.semitone_delta(100.0, 200.0), 12.0, places=9)
        self.assertAlmostEqual(ocm.semitone_delta(200.0, 100.0), -12.0, places=9)
        self.assertAlmostEqual(ocm.semitone_delta(140.0, 140.0), 0.0, places=12)

    def test_semitone_delta_reports_zero_when_it_cannot_measure(self):
        self.assertEqual(ocm.semitone_delta(0.0, 200.0), 0.0)
        self.assertEqual(ocm.semitone_delta(200.0, 0.0), 0.0)

    def test_f0_track_and_rms_track_share_one_frame_grid(self):
        sig = tone(SR, 150.0, 0.3)
        f0 = ocm.f0_track(sig, SR, 0, sig.size)
        rms = ocm.frame_rms_track(sig, SR, 0, sig.size)
        self.assertEqual(f0.size, rms.size)
        self.assertGreater(f0.size, 10)
        self.assertTrue(bool(np.all(f0 > 0.0)))

    def test_first_voiced_skips_leading_silence_instead_of_reporting_zero(self):
        sig = with_silence(tone(SR, 150.0, 0.3), lead_ms=120.0)
        hz, off, av = ocm.first_voiced_f0(sig, SR, 0, sig.size)
        self.assertEqual(av, 1)
        self.assertGreater(off, 0)
        self.assertLess(abs(hz - 150.0) / 150.0, 0.03)

    def test_last_voiced_reports_how_much_silence_follows_it(self):
        sig = with_silence(tone(SR, 150.0, 0.3), trail_ms=200.0)
        hz, rest, av = ocm.last_voiced_f0(sig, SR, 0, sig.size)
        self.assertEqual(av, 1)
        self.assertGreater(rest, 0)
        self.assertLess(abs(hz - 150.0) / 150.0, 0.03)

    def test_all_silence_is_unavailable_not_a_fake_zero_pitch(self):
        sil = np.zeros(SR, dtype=np.float32)
        self.assertEqual(ocm.first_voiced_f0(sil, SR, 0, sil.size), (0.0, -1, 0))
        self.assertEqual(ocm.last_voiced_f0(sil, SR, 0, sil.size), (0.0, -1, 0))

    def test_the_record_separates_unmeasurable_from_measured(self):
        sig = with_silence(tone(SR, 150.0, 0.3), lead_ms=120.0, trail_ms=200.0)
        rec = ocm.compute_onset_continuity_metrics(sig, SR, [span(0, 0, sig.size)])[0]
        self.assertEqual(rec["onset_first_voiced_available"], 1)
        self.assertEqual(rec["tail_last_voiced_available"], 1)
        self.assertGreater(rec["onset_first_voiced_offset_samples"], 0)
        self.assertGreater(rec["tail_last_voiced_trailing_samples"], 0)


# ────────────────────────── H. 운율 프로필 ──────────────────────────

def wobble(n, f0, amp, depth_st, rate_hz):
    """F0 가 depth_st 반음 폭으로 rate_hz 로 흔들리는 톤(억양이 살아 있는 신호)."""
    t = np.arange(n, dtype=np.float64) / float(SR)
    inst = f0 * np.power(2.0, (depth_st / 12.0) * np.sin(2.0 * np.pi * rate_hz * t))
    phase = 2.0 * np.pi * np.cumsum(inst) / float(SR)
    return (amp * np.sin(phase)).astype(np.float32)


class TestProsodyProfile(unittest.TestCase):

    def test_profile_has_exactly_the_contract_fields(self):
        rec = ocm.prosody_profile(tone(2 * SR, 150.0, 0.3), SR)
        self.assertEqual(tuple(rec.keys()), ocm.PROSODY_PROFILE_FIELDS)

    def test_a_steady_tone_is_described_as_flat(self):
        rec = ocm.prosody_profile(tone(2 * SR, 150.0, 0.3), SR)
        self.assertGreater(rec["voiced_ratio"], 0.9)
        self.assertLess(rec["f0_std_semitones"], 0.2)
        self.assertGreater(rec["flat_ratio"], 0.9)

    def test_a_wobbling_tone_is_described_as_less_flat(self):
        flat = ocm.prosody_profile(tone(2 * SR, 150.0, 0.3), SR)
        live = ocm.prosody_profile(wobble(2 * SR, 150.0, 0.3, 5.0, 1.5), SR)
        self.assertGreater(live["f0_std_semitones"], flat["f0_std_semitones"] + 0.5)
        self.assertGreater(live["f0_range_semitones"], flat["f0_range_semitones"] + 1.0)
        self.assertGreater(live["abs_delta_p90_semitones"], flat["abs_delta_p90_semitones"])

    def test_comparison_says_the_generated_side_is_narrower_with_a_negative_percent(self):
        ref = ocm.prosody_profile(wobble(2 * SR, 150.0, 0.3, 6.0, 2.0), SR)
        gen = ocm.prosody_profile(wobble(2 * SR, 150.0, 0.3, 1.0, 2.0), SR)
        cmp_rec = ocm.compare_prosody_profiles(ref, gen)
        self.assertEqual(tuple(cmp_rec.keys()), ocm.PROSODY_COMPARISON_FIELDS)
        self.assertLess(cmp_rec["f0_std_ratio"], 1.0)
        self.assertLess(cmp_rec["f0_std_delta_pct"], 0.0)

    def test_comparison_rejects_a_profile_that_is_missing_fields(self):
        ref = ocm.prosody_profile(tone(2 * SR, 150.0, 0.3), SR)
        broken = dict(ref)
        broken.pop("f0_std_semitones")
        with self.assertRaises(ocm.MetricsError):
            ocm.compare_prosody_profiles(ref, broken)

    def test_profile_and_comparison_serialize_to_numbers_only(self):
        ref = ocm.prosody_profile(wobble(2 * SR, 150.0, 0.3, 6.0, 2.0), SR)
        gen = ocm.prosody_profile(tone(2 * SR, 150.0, 0.3), SR)
        for out in (ocm.serialize_prosody_profile(ref),
                    ocm.serialize_prosody_comparison(ocm.compare_prosody_profiles(ref, gen))):
            for key, value in out.items():
                self.assertIsInstance(value, (int, float), key)
                self.assertNotIsInstance(value, bool, key)
                self.assertTrue(math.isfinite(float(value)), key)

    def test_profile_serializer_rejects_poisoned_fields(self):
        rec = dict(ocm.prosody_profile(tone(2 * SR, 150.0, 0.3), SR))
        rec["source_path"] = "C:/tmp/ref.wav"
        with self.assertRaises(ocm.PrivacyViolation):
            ocm.serialize_prosody_profile(rec)
        rec2 = dict(ocm.prosody_profile(tone(2 * SR, 150.0, 0.3), SR))
        rec2["f0_q50_hz"] = float("nan")
        with self.assertRaises(ocm.PrivacyViolation):
            ocm.serialize_prosody_profile(rec2)


# ────────────────────────── I. join 연속성(청크 '사이') ──────────────────────────

def joined(chunks, gaps_samples):
    """프로덕션 결합 규칙의 권위 미러로 신호 + span 을 만든다(계측 전용 두 번째 규칙 금지)."""
    sig = bm.concat_with_boundaries_array(chunks, gaps_samples)
    spans, cursor = [], 0
    for i, c in enumerate(chunks):
        g = gaps_samples[i] if i > 0 else 0
        cursor += g
        spans.append(span(i, cursor, cursor + c.size, g))
        cursor += c.size
    return sig, spans


def one_join(chunks, gaps_samples, embed_fn=None):
    sig, spans = joined(chunks, gaps_samples)
    recs = ocm.compute_join_continuity_metrics(sig, SR, spans, embed_fn=embed_fn)
    assert len(recs) == len(chunks) - 1
    return recs[0]


class TestJoinContinuity(unittest.TestCase):

    def test_n_chunks_produce_n_minus_one_join_records(self):
        c = tone(SR, 140.0, 0.25)
        sig, spans = joined([c, c, c], [0, 0, 0])
        self.assertEqual(len(ocm.compute_join_continuity_metrics(sig, SR, spans)), 2)

    def test_a_single_chunk_has_no_join(self):
        c = tone(SR, 140.0, 0.25)
        self.assertEqual(ocm.compute_join_continuity_metrics(c, SR, [span(0, 0, c.size)]), [])
        self.assertEqual(ocm.compute_join_continuity_metrics(c, SR, []), [])

    def test_records_have_exactly_the_contract_fields(self):
        c = tone(SR, 140.0, 0.25)
        sig, spans = joined([c, c], [0, 0])
        for rec in ocm.compute_join_continuity_metrics(sig, SR, spans):
            self.assertEqual(tuple(rec.keys()), ocm.JOIN_RECORD_FIELDS)

    def test_matched_chunks_show_no_step_on_any_axis(self):
        c = tone(SR, 140.0, 0.25)
        rec = one_join([c, c], [0, 0])
        self.assertAlmostEqual(rec["rms_step_db"], 0.0, places=2)
        self.assertAlmostEqual(rec["f0_step_semitones"], 0.0, places=3)
        self.assertEqual(rec["f0_step_available"], 1)
        self.assertLess(rec["mel_distance"], 1e-3)

    def test_a_level_step_across_the_join_is_measured_in_db(self):
        loud = tone(SR, 140.0, 0.25)
        quiet = tone(SR, 140.0, 0.0625)          # -12.04 dB
        rec = one_join([loud, quiet], [0, 0])
        self.assertLess(rec["rms_step_db"], -11.5)
        self.assertGreater(rec["rms_step_db"], -12.5)

    def test_a_pitch_step_across_the_join_is_measured_in_semitones(self):
        low = tone(SR, 140.0, 0.25)
        high = tone(SR, 210.0, 0.25)             # +7.02 반음
        rec = one_join([low, high], [0, 0])
        self.assertEqual(rec["f0_step_available"], 1)
        self.assertGreater(rec["f0_step_semitones"], 6.8)
        self.assertLess(rec["f0_step_semitones"], 7.2)

    def test_a_sample_rate_mix_shows_up_as_a_large_pitch_step(self):
        """서로 다른 sr 로 만든 조각을 첫 파일 sr 로 기록하면 경계에서 피치가 통째로 어긋난다.

        production 세그먼트 경로(_select_engine 이 세그먼트마다 엔진 선택)에서 실제로 가능한
        조건이며, 이 수치가 tts_worker 의 _assert_concat_ready 배선 근거다.
        """
        at_24k = tone(SR, 140.0, 0.25)
        # 32000 Hz 에서 만든 1.2 초 분량을 그대로 24000 Hz 로 재해석한 것과 동일한 샘플 열.
        n32 = int(1.2 * 32000)
        t32 = np.arange(n32, dtype=np.float64) / 32000.0
        at_32k = (0.25 * np.sin(2.0 * np.pi * 140.0 * t32)).astype(np.float32)
        rec = one_join([at_24k, at_32k], [0, 0])
        self.assertEqual(rec["f0_step_available"], 1)
        self.assertLess(rec["f0_step_semitones"], -4.5)      # 이론 -4.98, 측정 -4.90
        self.assertGreater(rec["f0_step_semitones"], -5.3)
        self.assertGreater(rec["mel_distance"], 1.0)

    def test_generated_silence_is_counted_separately_from_the_declared_gap(self):
        """gap=0 으로 '연속' 이라 선언해도 조각이 스스로 무음을 달고 있으면 실제 정적은 0 이 아니다."""
        c = with_silence(tone(SR, 140.0, 0.25), lead_ms=80.0, trail_ms=150.0)
        rec = one_join([c, c], [0, 0])
        self.assertEqual(rec["gap_samples"], 0)
        self.assertEqual(rec["declared_pause_ms"], 0.0)
        self.assertAlmostEqual(rec["undeclared_pause_ms"], 230.0, places=3)
        self.assertAlmostEqual(rec["effective_pause_ms"], 230.0, places=3)
        self.assertEqual(rec["left_trailing_silence_samples"], int(0.150 * SR))
        self.assertEqual(rec["right_leading_silence_samples"], int(0.080 * SR))

    def test_declared_and_generated_silence_add_up(self):
        c = with_silence(tone(SR, 140.0, 0.25), lead_ms=80.0, trail_ms=150.0)
        gap = int(0.5 * SR)
        rec = one_join([c, c], [0, gap])
        self.assertEqual(rec["gap_samples"], gap)
        self.assertAlmostEqual(rec["declared_pause_ms"], 500.0, places=6)
        self.assertAlmostEqual(rec["effective_pause_ms"], 730.0, places=3)
        self.assertEqual(rec["effective_pause_samples"],
                         rec["left_trailing_silence_samples"] + gap
                         + rec["right_leading_silence_samples"])

    def test_the_level_step_is_not_faked_by_the_silence_around_the_join(self):
        """무음을 걷어내지 않으면 여운 때문에 -40 dB 같은 가짜 계단이 나온다 — 그러면 안 된다."""
        c = with_silence(tone(SR, 140.0, 0.25), lead_ms=80.0, trail_ms=150.0)
        rec = one_join([c, c], [0, 0])
        self.assertLess(abs(rec["rms_step_db"]), 0.5)

    def test_an_out_of_phase_butt_join_shows_a_step_far_above_the_natural_one(self):
        n = SR
        k = np.arange(n)
        pos = (0.25 * np.cos(2.0 * np.pi * 140.0 * k / SR)).astype(np.float32)   # +peak 에서 끝
        neg = (-0.25 * np.cos(2.0 * np.pi * 140.0 * k / SR)).astype(np.float32)  # -peak 에서 시작
        natural = 0.25 * 2.0 * math.pi * 140.0 / SR      # 이 톤의 인접 샘플 변화 상한
        same = one_join([pos, pos], [0, 0])
        opposite = one_join([pos, neg], [0, 0])
        self.assertLess(same["sample_jump"], natural)
        self.assertGreater(opposite["sample_jump"], 20.0 * natural)
        self.assertEqual(opposite["sample_jump_available"], 1)

    def test_speaker_distance_needs_an_injected_function(self):
        c = tone(SR, 140.0, 0.25)
        self.assertEqual(one_join([c, c], [0, 0])["speaker_distance_available"], 0)

        def embed(x, rate):
            return [float(np.mean(np.abs(x))), float(np.std(x)), 1.0]

        loud = tone(SR, 140.0, 0.25)
        quiet = tone(SR, 140.0, 0.05)
        rec = one_join([loud, quiet], [0, 0], embed_fn=embed)
        self.assertEqual(rec["speaker_distance_available"], 1)
        self.assertGreater(rec["speaker_distance"], 0.0)

    def test_overlapping_or_invalid_spans_are_rejected(self):
        sig = tone(2 * SR, 140.0, 0.25)
        with self.assertRaises(ocm.MetricsError):
            ocm.compute_join_continuity_metrics(sig, SR, [span(0, 0, SR), span(1, SR // 2, 2 * SR)])
        with self.assertRaises(ocm.MetricsError):
            ocm.compute_join_continuity_metrics(sig, 0, [span(0, 0, SR), span(1, SR, 2 * SR)])
        with self.assertRaises(ocm.MetricsError):
            ocm.compute_join_continuity_metrics(sig, SR, [span(0, 0, SR), "not a span"])

    def test_join_records_serialise_to_numbers_only(self):
        c = with_silence(tone(SR, 140.0, 0.25), trail_ms=100.0)
        sig, spans = joined([c, c, c], [0, 0, int(0.2 * SR)])
        rows = ocm.serialize_join_records(ocm.compute_join_continuity_metrics(sig, SR, spans))
        self.assertEqual(len(rows), 2)
        for row in rows:
            self.assertEqual(set(row.keys()), set(ocm.JOIN_RECORD_FIELDS))
            for key, value in row.items():
                self.assertIsInstance(value, (int, float), key)
                self.assertNotIsInstance(value, bool, key)
                self.assertTrue(math.isfinite(float(value)), key)

    def test_join_serializer_rejects_extra_missing_and_poisoned_fields(self):
        c = tone(SR, 140.0, 0.25)
        base = one_join([c, c], [0, 0])
        poisoned = dict(base)
        poisoned["reference_path"] = "C:/Users/x/ref.wav"
        with self.assertRaises(ocm.PrivacyViolation):
            ocm.serialize_join_record(poisoned)
        short = dict(base)
        short.pop("rms_step_db")
        with self.assertRaises(ocm.PrivacyViolation):
            ocm.serialize_join_record(short)
        for bad in ("C:/tmp/out.wav", "대사입니다", [0.1], True, float("inf")):
            rec = dict(base)
            rec["rms_step_db"] = bad
            with self.assertRaises(ocm.PrivacyViolation):
                ocm.serialize_join_record(rec)

    def test_formatted_join_table_has_no_path_or_text_content(self):
        c = tone(SR, 140.0, 0.25)
        sig, spans = joined([c, c], [0, 0])
        blob = ocm.format_join_records(ocm.compute_join_continuity_metrics(sig, SR, spans))
        for line in blob.splitlines()[1:]:
            for cell in line.split("\t"):
                for bad in ("/", "\\", ":", " ", ".wav", ".txt", "Users", "python"):
                    self.assertNotIn(bad, cell, cell)

    def test_join_metrics_are_deterministic(self):
        c = with_silence(tone(SR, 140.0, 0.25), lead_ms=40.0, trail_ms=90.0)
        sig, spans = joined([c, c], [0, int(0.3 * SR)])

        def embed(x, rate):
            return [float(np.mean(np.abs(x))), float(np.std(x)), 1.0]

        first = ocm.serialize_join_records(
            ocm.compute_join_continuity_metrics(sig, SR, spans, embed_fn=embed))
        second = ocm.serialize_join_records(
            ocm.compute_join_continuity_metrics(sig, SR, spans, embed_fn=embed))
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
