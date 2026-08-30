# -*- coding: utf-8 -*-
"""macro gain drift 보정 계약 회귀.

지키는 것:
  1. 안정적인 트랙(구절 단위로 내려갔다 회복)은 **바이트 단위 no-op** 이다
  2. 끝까지 회복하지 않는 느린 감쇠만 보정한다
  3. boost-only — 어떤 샘플도 작아지지 않는다
  4. 짧은 강약·웃음·호흡은 보존된다(곡선이 수십 초 규모라 구조적으로 통과한다)
  5. 길이·표본율·채널 불변, 비유한·클리핑 없음
  6. 같은 계획을 두 번 걸 수 없고, 보정 결과는 다시 걸리지 않는다(멱등)
  7. 명시적 공간 연출(spatial_automation) 구간은 보정에서 제외된다
  8. metadata 에 대사·전사·절대경로가 들어가지 않는다

신호는 전부 SYNTHETIC 이다 — 사용자 미디어를 읽지 않는다. 실제 승인 표본에 대한 계측값은
`macro_gain.ACTIVATION_PROVENANCE` 에 청취 라벨과 함께 기록돼 있고, 그 자산이 로컬에 있을 때만
도는 확인 테스트를 따로 둔다.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:                                     # pragma: no cover
    HAS_NUMPY = False

_DEFER = "numpy 부재 — 공유 qwen venv 에서 실행"

SR = 8000                # 계약은 표본율 무관이다. 테스트 속도를 위해 낮게 잡는다.
WORD_SEC, GAP_SEC = 0.30, 0.14


def _words(duration_sec, seed=17):
    """말 같은 재료 — 단어 버스트 + 사이 여백 + 단어마다 다른 세기(짧은 강약)."""
    rng = np.random.default_rng(seed)
    n = int(duration_sec * SR)
    x = np.zeros(n, dtype="float64")
    starts = []
    t = 0.0
    while t + WORD_SEC < duration_sec:
        s = int(t * SR)
        e = s + int(WORD_SEC * SR)
        k = e - s
        env = np.hanning(k)
        amp = 0.25 * float(10 ** (rng.uniform(-6.0, 0.0) / 20.0))   # 단어마다 최대 6 dB 차이
        x[s:e] = amp * env * rng.standard_normal(k)
        starts.append((s, e))
        t += WORD_SEC + GAP_SEC
    return x, starts


def _shape(x, curve_db):
    """샘플 축 macro 곡선(dB)을 곱한다 — '모델이 gain 으로 표현한' 상태를 만든다."""
    return (x * 10.0 ** (curve_db / 20.0)).astype("float32")


def _stable(duration=45.0):
    """구절 단위로 3 dB 내려갔다 **회복하는** 트랙. 보정 대상이 아니다."""
    x, w = _words(duration)
    t = np.arange(len(x)) / float(SR)
    dip = -3.0 * np.exp(-((t - duration * 0.55) ** 2) / (2 * (duration * 0.10) ** 2))
    return _shape(x, dip), w


def _drifting(duration=45.0, depth_db=9.0):
    """후반부가 끝까지 회복하지 않고 내려가는 트랙. 보정 대상이다."""
    x, w = _words(duration)
    t = np.arange(len(x)) / float(SR)
    start = duration * 0.40
    curve = np.where(t < start, 0.0, -depth_db * (t - start) / (duration - start))
    return _shape(x, curve), w


def _level_db(a, spans):
    return np.array([20 * np.log10(max(float(np.sqrt(np.mean(a[s:e] ** 2))), 1e-12))
                     for s, e in spans])


@unittest.skipUnless(HAS_NUMPY, _DEFER)
class ActivationTest(unittest.TestCase):
    def test_stable_track_is_byte_exact_noop(self):
        import macro_gain as mg
        a, _ = _stable()
        plan = mg.compute_macro_gain_plan(a, SR)
        self.assertFalse(plan.applied)
        self.assertEqual(plan.reason, mg.REASON_BELOW_GATE)
        out = mg.apply_macro_gain(a, SR, plan)
        self.assertTrue(np.array_equal(out, a), "안정 트랙은 파형이 그대로여야 한다")

    def test_sustained_drift_is_corrected(self):
        import macro_gain as mg
        a, _ = _drifting()
        plan = mg.compute_macro_gain_plan(a, SR)
        self.assertTrue(plan.applied, "끝까지 회복하지 않는 감쇠는 보정 대상이다")
        self.assertGreater(plan.statistic_db, plan.gate_db)
        self.assertGreater(plan.max_boost_db, 1.0)

    def test_recovering_dip_is_not_a_sustained_deficit(self):
        """잠깐 내려갔다 돌아오는 구절 강약은 통계가 거의 0 이다."""
        import macro_gain as mg
        stable, _ = _stable()
        drift, _ = _drifting()
        self.assertLess(mg.compute_macro_gain_plan(stable, SR).statistic_db,
                        mg.compute_macro_gain_plan(drift, SR).statistic_db)

    def test_gate_sits_inside_the_observed_listening_gap(self):
        import macro_gain as mg
        p = mg.ACTIVATION_PROVENANCE
        self.assertGreater(mg.ACTIVATION_GATE_DB, p["gap"]["max_pass_db"],
                           "청취 PASS 표본이 다시 보정되면 안 된다")
        self.assertLess(mg.ACTIVATION_GATE_DB, p["gap"]["min_fail_db"],
                        "청취 FAIL 표본을 놓치면 안 된다")
        passes = [r["statistic_db"] for r in p["listening_labels"] if r["verdict"] == "PASS"]
        fails = [r["statistic_db"] for r in p["listening_labels"] if r["verdict"] == "FAIL"]
        self.assertGreaterEqual(len(passes), 2, "라벨 없이 게이트를 두지 않는다")
        self.assertTrue(fails)
        self.assertEqual(p["gap"]["max_pass_db"], max(passes))
        self.assertEqual(p["gap"]["min_fail_db"], min(fails))
        self.assertTrue(any(r["corrected"] for r in p["listening_labels"] if r["verdict"] == "PASS"),
                        "보정 결과의 청취 라벨이 있어야 재적용을 막을 수 있다")


@unittest.skipUnless(HAS_NUMPY, _DEFER)
class InvariantTest(unittest.TestCase):
    def _corrected(self, dur=45.0):
        import macro_gain as mg
        a, w = _drifting(dur)
        plan = mg.compute_macro_gain_plan(a, SR)
        return a, mg.apply_macro_gain(a, SR, plan), plan, w

    def test_length_rate_dtype_invariant(self):
        a, out, plan, _ = self._corrected()
        self.assertEqual(len(out), len(a))
        self.assertEqual(out.dtype, np.float32)
        self.assertEqual(plan.sample_rate, SR)

    def test_boost_only_never_attenuates(self):
        a, out, _, _ = self._corrected()
        self.assertTrue(np.all(np.abs(out) >= np.abs(a) - 1e-6),
                        "어떤 샘플도 작아지면 안 된다(boost-only)")

    def test_finite_and_no_clipping(self):
        a, out, _, _ = self._corrected()
        self.assertTrue(np.all(np.isfinite(out)))
        self.assertLess(float(np.abs(out).max()), 1.0)

    def test_near_clipping_input_caps_the_curve_instead_of_clipping(self):
        """boost 구간에 full-scale 근처 피크가 있으면 곡선에 상한을 건다.

        곡선 전체를 낮추지 않는다 — 그러면 boost 0 이던 구간이 **감쇠**로 바뀐다."""
        import macro_gain as mg
        a, _ = _drifting()
        # 보정이 걸리는 꼬리 구간에 2 ms 짜리 full-scale 근처 트랜지언트를 심는다.
        # 짧아서 레벨 추세는 거의 건드리지 않지만 boost 를 그대로 곱하면 반드시 클리핑한다.
        s = len(a) - int(2.0 * SR)
        a = a.copy()
        a[s:s + int(0.002 * SR)] = 0.98
        plan = mg.compute_macro_gain_plan(a, SR)
        self.assertTrue(plan.applied)
        self.assertIsNotNone(plan.headroom_cap_db, "클리핑이 예상되면 상한이 있어야 한다")
        self.assertLessEqual(plan.max_boost_db, plan.headroom_cap_db + 1e-6,
                             "상한이 곡선을 실제로 눌러야 한다")
        out = mg.apply_macro_gain(a, SR, plan)
        self.assertLess(float(np.abs(out).max()), 1.0)
        self.assertTrue(np.all(np.abs(out) >= np.abs(a) - 1e-6), "상한을 걸어도 boost-only 다")

    def test_stereo_shape_and_channel_count_preserved(self):
        import macro_gain as mg
        mono, _ = _drifting()
        st = np.stack([mono, mono * 0.8], axis=1).astype("float32")
        plan = mg.compute_macro_gain_plan(st, SR)
        out = mg.apply_macro_gain(st, SR, plan)
        self.assertEqual(out.shape, st.shape)
        self.assertTrue(np.all(np.isfinite(out)))

    def test_silence_only_is_a_safe_noop(self):
        import macro_gain as mg
        a = np.zeros(int(45 * SR), dtype="float32")
        plan = mg.compute_macro_gain_plan(a, SR)
        self.assertFalse(plan.applied)
        self.assertTrue(np.array_equal(mg.apply_macro_gain(a, SR, plan), a))

    def test_too_short_track_is_a_noop(self):
        import macro_gain as mg
        a, _ = _drifting(duration=mg.MIN_ANALYSIS_SEC - 1.0)
        plan = mg.compute_macro_gain_plan(a, SR)
        self.assertFalse(plan.applied)
        self.assertEqual(plan.reason, mg.REASON_TOO_SHORT)
        self.assertTrue(np.array_equal(mg.apply_macro_gain(a, SR, plan), a))

    def test_invalid_rate_and_shape_raise(self):
        import macro_gain as mg
        a, _ = _drifting()
        with self.assertRaises(mg.MacroGainError):
            mg.compute_macro_gain_plan(a, 0)
        with self.assertRaises(mg.MacroGainError):
            mg.compute_macro_gain_plan(np.zeros((4, 4, 2), dtype="float32"), SR)


@unittest.skipUnless(HAS_NUMPY, _DEFER)
class DynamicsPreservedTest(unittest.TestCase):
    """짧은 강약·웃음·호흡은 남는다 — 곡선이 느리다는 사실로 보장한다."""

    def test_implied_gain_moves_slowly(self):
        import macro_gain as mg
        a, _ = _drifting()
        plan = mg.compute_macro_gain_plan(a, SR)
        out = mg.apply_macro_gain(a, SR, plan)
        ok = np.abs(a) > 1e-4
        g = 20 * np.log10(np.abs(out[ok]) / np.abs(a[ok]))
        idx = np.nonzero(ok)[0]
        # 1초 간격으로 표집한 곡선의 변화율. 실측된 최대는 0.45 dB/s 였다.
        step = SR
        pick = [g[np.argmin(np.abs(idx - k))] for k in range(0, len(a), step)]
        rate = np.abs(np.diff(pick))
        self.assertLess(float(rate.max()), 1.0, "보정 곡선이 초당 1 dB 넘게 움직이면 강약을 먹는다")

    def test_word_to_word_contrast_is_preserved(self):
        import macro_gain as mg
        a, spans = _drifting()
        plan = mg.compute_macro_gain_plan(a, SR)
        out = mg.apply_macro_gain(a, SR, plan)
        before, after = _level_db(a.astype("float64"), spans), _level_db(out.astype("float64"), spans)
        # 이웃한 두 단어의 세기 **차이** 가 유지되는가(절대 레벨이 아니라 대비).
        drift = np.abs(np.diff(after) - np.diff(before))
        self.assertLess(float(drift.max()), 1.0,
                        "이웃 단어 대비가 1 dB 넘게 흔들리면 강약을 평탄화한 것이다")


@unittest.skipUnless(HAS_NUMPY, _DEFER)
class IdempotencyTest(unittest.TestCase):
    def test_same_plan_cannot_be_applied_twice(self):
        import macro_gain as mg
        a, _ = _drifting()
        plan = mg.compute_macro_gain_plan(a, SR)
        mg.apply_macro_gain(a, SR, plan)
        with self.assertRaises(mg.MacroGainError) as cm:
            mg.apply_macro_gain(a, SR, plan)
        self.assertEqual(cm.exception.code, "MACRO_GAIN_DOUBLE_APPLY")

    def test_corrected_output_does_not_trigger_again(self):
        import macro_gain as mg
        a, _ = _drifting()
        out = mg.apply_macro_gain(a, SR, mg.compute_macro_gain_plan(a, SR))
        again = mg.compute_macro_gain_plan(out, SR)
        self.assertFalse(again.applied, "보정 결과에 또 boost 를 얹으면 안 된다")


@unittest.skipUnless(HAS_NUMPY, _DEFER)
class ProtectedSpanTest(unittest.TestCase):
    """`[멀어짐]` 같은 공간 연출은 spatial_automation 의 몫이라 보정 대상이 아니다."""

    def test_gain_is_frozen_inside_a_protected_span(self):
        import macro_gain as mg
        a, _ = _drifting()
        s, e = int(30 * SR), int(40 * SR)
        plan = mg.compute_macro_gain_plan(a, SR, protected_spans=[(s, e)])
        out = mg.apply_macro_gain(a, SR, plan)
        if not plan.applied:
            self.skipTest("이 신호에서는 게이트가 열리지 않는다")
        ok = np.abs(a[s:e]) > 1e-4
        g = 20 * np.log10(np.abs(out[s:e][ok]) / np.abs(a[s:e][ok]))
        self.assertLess(float(g.max() - g.min()), 0.01, "보호 구간 안에서 곡선이 움직이면 안 된다")

    def test_fully_protected_track_is_a_noop(self):
        import macro_gain as mg
        a, _ = _drifting()
        plan = mg.compute_macro_gain_plan(a, SR, protected_spans=[(0, len(a))])
        self.assertFalse(plan.applied)
        self.assertEqual(plan.reason, mg.REASON_FULLY_PROTECTED)
        self.assertTrue(np.array_equal(mg.apply_macro_gain(a, SR, plan), a))

    def test_malformed_spans_raise(self):
        import macro_gain as mg
        a, _ = _drifting()
        with self.assertRaises(mg.MacroGainError):
            mg.compute_macro_gain_plan(a, SR, protected_spans=[("a", "b")])


@unittest.skipUnless(HAS_NUMPY, _DEFER)
class MetadataTest(unittest.TestCase):
    KEYS = ("macro_gain_applied", "macro_gain_reason", "macro_gain_statistic_db",
            "macro_gain_gate_db", "macro_gain_max_boost_db", "macro_gain_curve_sha8",
            "macro_gain_headroom_cap_db", "macro_gain_protected_span_count",
            "macro_gain_trend_window_sec", "macro_gain_level_window_sec")

    def test_keys_and_types(self):
        import macro_gain as mg
        a, _ = _drifting()
        meta = mg.plan_metadata(mg.compute_macro_gain_plan(a, SR))
        for k in self.KEYS:
            self.assertIn(k, meta)
        self.assertIsInstance(meta["macro_gain_applied"], bool)
        self.assertIn(meta["macro_gain_reason"],
                      (mg.REASON_APPLIED, mg.REASON_BELOW_GATE, mg.REASON_TOO_SHORT,
                       mg.REASON_NO_ACTIVE_SPEECH, mg.REASON_FULLY_PROTECTED))

    def test_no_text_or_path_leaks(self):
        import macro_gain as mg
        a, _ = _drifting()
        meta = mg.plan_metadata(mg.compute_macro_gain_plan(a, SR))
        for k, v in meta.items():
            if isinstance(v, str):
                self.assertNotIn(":", v, "경로가 새어 들어갔다: %s" % k)
                self.assertNotIn("\\", v)
                self.assertNotIn("/", v)

    def test_curve_fingerprint_is_deterministic(self):
        import macro_gain as mg
        a, _ = _drifting()
        p1 = mg.compute_macro_gain_plan(a, SR)
        p2 = mg.compute_macro_gain_plan(a, SR)
        self.assertEqual(p1.curve_sha8, p2.curve_sha8)
        self.assertIsNotNone(p1.curve_sha8)

    def test_none_plan_metadata_is_unavailable_not_a_lie(self):
        import macro_gain as mg
        meta = mg.plan_metadata(None)
        self.assertFalse(meta["macro_gain_applied"])
        self.assertEqual(meta["macro_gain_reason"], "UNAVAILABLE")

    def test_metadata_keys_are_whitelisted_in_worker(self):
        import tts_worker
        for k in self.KEYS:
            self.assertIn(k, tts_worker._METADATA_KEYS,
                          "metadata 화이트리스트에 없으면 재현값이 밖으로 나가지 않는다: %s" % k)


@unittest.skipUnless(HAS_NUMPY, _DEFER)
class ApprovedAssetTest(unittest.TestCase):
    """청취 승인 자산이 로컬에 있을 때만 도는 확인 — provenance 수치가 실제와 맞는지 본다."""

    ROOT = os.path.join("E:", os.sep, "AI_Project", "claudeCodeVsCode", "apps", "development",
                        "AudioForge", "_local", "artifacts")

    def _read(self, *parts):
        p = os.path.join(self.ROOT, *parts)
        if not os.path.isfile(p):
            self.skipTest("승인 자산 없음(다른 환경)")
        import soundfile as sf
        a, sr = sf.read(p, dtype="float32")
        return (a if a.ndim == 1 else a.mean(axis=1)), sr

    def test_labels_match_measurement(self):
        import macro_gain as mg
        cases = {"envelope-goback-384": ("generated", "envelope-goback-384", "synthesized.wav"),
                 "envelope-sample4-576": ("generated", "envelope-sample4-576", "synthesized.wav"),
                 "goback-split-production-1": ("diagnostics", "goback-split-listening",
                                               "FULL-goback-3chunk.wav"),
                 "macro-gain-drift-ab/B-FULL": ("diagnostics", "macro-gain-drift-ab",
                                                "B-FULL-macro-corrected.wav")}
        for label in mg.ACTIVATION_PROVENANCE["listening_labels"]:
            a, sr = self._read(*cases[label["run"]])
            plan = mg.compute_macro_gain_plan(a, sr)
            self.assertAlmostEqual(plan.statistic_db, label["statistic_db"], places=1,
                                   msg="provenance 수치가 실제 계측과 다르다: %s" % label["run"])
            self.assertEqual(plan.applied, label["verdict"] == "FAIL",
                             "청취 FAIL 만 보정 대상이어야 한다: %s" % label["run"])


if __name__ == "__main__":
    unittest.main()
