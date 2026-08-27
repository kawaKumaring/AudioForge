# -*- coding: utf-8 -*-
"""emotion_acoustic.py 단위 테스트 — 모델/GPU 없음. 합성 신호와 순수 계약만.

핵심 축:
  A. 같은 참조를 쓰면 절대 supported 가 되지 않는다(가짜 감정 차단선)
  B. accepted 와 honored 가 분리되어 있다 — honored 는 측정 레코드 없이 True 가 될 수 없다
  C. 상태는 언제나 ProbeEvidence 에서 파생된다(규칙표 이중화 없음)
  D. 판정 축은 반음뿐이고 문턱은 계약 상수를 그대로 쓴다(지어낸 숫자 없음)
  E. 추종도는 방향까지 본다 — 반대 방향으로 커진 것은 따라간 것이 아니다
  F. instruct_ids 는 production 에서 켜지지 않고, accepted 가 honored 로 승격되지 않는다
  G. 실측 데이터(20260827-A2-emotion3) 재현 — 오늘의 정직한 답이 degraded 임을 고정
"""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import emotion_acoustic as ea
import expressive_capability as cap


def profile(**over):
    """최소 유효 프로필. 축을 하나씩만 흔들어 보기 위한 기준선."""
    base = {
        "sample_rate": 24000, "analysis_samples": 120000,
        "f0_q50_hz": 200.0, "f0_range_semitones": 10.0, "f0_iqr_semitones": 6.0,
        "f0_std_semitones": 4.0, "voiced_ratio": 0.8,
        "rms_q50": 0.1, "rms_range_db": 14.0,
        "speech_ms": 4000, "pause_count": 2, "pause_total_ms": 300, "pause_longest_ms": 200,
        "spectral_tilt_db": -12.0,
        "speech_rate_cps": 0.0, "speech_rate_available": 0,
    }
    base.update(over)
    return base


class TestReferenceRole(unittest.TestCase):
    def test_role_is_a_fact_not_a_verdict(self):
        self.assertEqual(ea.classify_reference_role("aaa", "bbb"), ea.REFERENCE_DISTINCT)
        self.assertEqual(ea.classify_reference_role("aaa", "aaa"), ea.REFERENCE_SHARED_DEFAULT)
        self.assertEqual(ea.classify_reference_role(None, "aaa"), ea.REFERENCE_ABSENT)
        self.assertEqual(ea.classify_reference_role("", "aaa"), ea.REFERENCE_ABSENT)

    def test_no_default_means_no_comparison(self):
        # 기본 참조가 없으면 '다르다' 고 말할 근거가 없다 — distinct 로 승격하지 않는다.
        self.assertEqual(ea.classify_reference_role("aaa", None), ea.REFERENCE_ABSENT)


class TestFakeEmotionBlocked(unittest.TestCase):
    """A. 같은 참조 하나로 여러 감정을 supported 라고 말할 수 있는 길이 없어야 한다."""

    def test_shared_default_is_degraded_never_supported(self):
        rec = ea.resolve_emotion_acoustic("happy", ea.REFERENCE_SHARED_DEFAULT)
        self.assertEqual(rec["state"], "degraded")
        self.assertEqual(rec["reason"], ea.EMOTION_REF_SHARED_DEFAULT)
        self.assertFalse(rec["usable"])

    def test_absent_is_degraded(self):
        rec = ea.resolve_emotion_acoustic("sad", ea.REFERENCE_ABSENT)
        self.assertEqual(rec["state"], "degraded")
        self.assertEqual(rec["reason"], ea.EMOTION_REF_ABSENT)

    def test_three_emotions_on_one_reference_are_all_degraded(self):
        keys = {"happy": "REF", "angry": "REF", "sad": "REF"}
        recs = ea.resolve_emotion_set("REF", keys)
        self.assertEqual([r["state"] for r in recs], ["degraded", "degraded", "degraded"])
        summary = ea.emotion_set_summary(recs)
        self.assertEqual(summary["supported"], 0)
        self.assertFalse(summary["any_supported"])

    def test_supported_reachable_only_through_followed_reason(self):
        # 모든 role×separation×follow 조합을 훑어 supported 로 새는 다른 길이 있는지 본다.
        seps = [None, {"separated": 0, "max_axis_index": 0}, {"separated": 1, "max_axis_index": 0}]
        follows = [None, {"followed": 0}, {"followed": 1}]
        supported = []
        for role in ea.EMOTION_REFERENCE_ROLES:
            for s in seps:
                for f in follows:
                    rec = ea.resolve_emotion_acoustic("x", role, s, f)
                    self.assertIn(rec["reason"], ea.EMOTION_ACOUSTIC_REASONS)
                    if rec["state"] == "supported":
                        supported.append((role, s, f, rec["reason"]))
        self.assertTrue(supported, "supported 로 가는 길이 아예 없으면 계약이 죽은 것이다")
        for role, _s, _f, reason in supported:
            self.assertEqual(role, ea.REFERENCE_DISTINCT)
            self.assertEqual(reason, ea.EMOTION_ACOUSTIC_SUPPORTED_REASON)


class TestAcceptedHonoredSeparation(unittest.TestCase):
    """B/C. accepted 와 honored 는 서로 다른 사실이고, 상태는 증거에서만 파생된다."""

    def test_shared_default_is_accepted_but_not_honored(self):
        ev = ea.emotion_acoustic_evidence(ea.REFERENCE_SHARED_DEFAULT)
        self.assertTrue(ev.accepted)
        self.assertFalse(ev.honored)
        self.assertEqual(cap.evidence_state(ev), "degraded")

    def test_measuring_reference_only_is_unknown_not_success(self):
        sep = {"separated": 1, "max_axis_index": 0}
        ev = ea.emotion_acoustic_evidence(ea.REFERENCE_DISTINCT, sep, None)
        self.assertTrue(ev.accepted)      # 입력은 실제로 달라졌다
        self.assertFalse(ev.attempted)    # 그러나 프로브를 끝내지 않았다
        self.assertEqual(cap.evidence_state(ev), "unknown")
        rec = ea.resolve_emotion_acoustic("x", ea.REFERENCE_DISTINCT, sep, None)
        self.assertEqual(rec["reason"], ea.EMOTION_RESULT_NOT_MEASURED)

    def test_state_always_equals_evidence_state(self):
        # 규칙표를 따로 두지 않았음을 고정한다 — 두 소스가 갈라지면 여기서 깨진다.
        for role in ea.EMOTION_REFERENCE_ROLES:
            for s in (None, {"separated": 0, "max_axis_index": 0}, {"separated": 1, "max_axis_index": 0}):
                for f in (None, {"followed": 0}, {"followed": 1}):
                    rec = ea.resolve_emotion_acoustic("x", role, s, f)
                    ev = ea.emotion_acoustic_evidence(role, s, f)
                    self.assertEqual(rec["state"], cap.evidence_state(ev))

    def test_honored_cannot_be_claimed_by_argument(self):
        # honored 를 직접 넣을 인자가 없다. 측정 레코드만이 통로다.
        import inspect
        params = set(inspect.signature(ea.emotion_acoustic_evidence).parameters)
        self.assertNotIn("honored", params)
        self.assertNotIn("honored", set(inspect.signature(ea.resolve_emotion_acoustic).parameters))


class TestSeparation(unittest.TestCase):
    """D. 판정 축은 반음뿐이고 문턱은 계약 상수를 그대로 쓴다."""

    def test_resolution_comes_from_contract_not_invented(self):
        import onset_continuity_metrics as ocm
        self.assertEqual(ea.separation_resolution_semitones(), ocm.PROSODY_FLAT_SEMITONES)

    def test_identical_profiles_are_not_separated(self):
        sep = ea.emotion_reference_separation(profile(), profile())
        self.assertEqual(sep["separated"], 0)
        self.assertEqual(sep["max_axis_semitones"], 0.0)

    def test_below_resolution_is_not_separated(self):
        res = ea.separation_resolution_semitones()
        sep = ea.emotion_reference_separation(
            profile(), profile(f0_std_semitones=4.0 + res * 0.5))
        self.assertEqual(sep["separated"], 0)

    def test_at_or_above_resolution_is_separated(self):
        res = ea.separation_resolution_semitones()
        sep = ea.emotion_reference_separation(
            profile(), profile(f0_std_semitones=4.0 + res))
        self.assertEqual(sep["separated"], 1)
        self.assertEqual(ea.SEPARATION_JUDGED_AXES[sep["max_axis_index"]], "f0_std_delta_semitones")

    def test_non_semitone_axes_never_drive_the_verdict(self):
        # dB·ms·자/초 축만 크게 흔들어도 '구별됨' 이 되지 않는다(그 단위엔 계약 해상도가 없다).
        sep = ea.emotion_reference_separation(profile(), profile(
            rms_range_db=40.0, spectral_tilt_db=20.0, pause_count=99, pause_total_ms=9999))
        self.assertEqual(sep["separated"], 0)
        self.assertNotEqual(sep["rms_range_delta_db"], 0.0)   # 기록은 된다
        self.assertEqual(sep["pause_count_delta"], 97)

    def test_speech_rate_marked_incomparable_when_missing(self):
        sep = ea.emotion_reference_separation(profile(), profile())
        self.assertEqual(sep["speech_rate_comparable"], 0)
        self.assertEqual(sep["speech_rate_delta_cps"], 0.0)   # 없는 값을 지어내지 않는다
        both = ea.emotion_reference_separation(
            profile(speech_rate_cps=4.0, speech_rate_available=1),
            profile(speech_rate_cps=5.0, speech_rate_available=1))
        self.assertEqual(both["speech_rate_comparable"], 1)
        self.assertAlmostEqual(both["speech_rate_delta_cps"], 1.0)

    def test_median_axis_uses_semitones_not_hz(self):
        # 한 옥타브 = 12 반음. Hz 차가 아니라 반음으로 잰다.
        sep = ea.emotion_reference_separation(profile(), profile(f0_q50_hz=400.0))
        self.assertAlmostEqual(sep["f0_median_offset_semitones"], 12.0, places=6)


class TestFollow(unittest.TestCase):
    """E. 추종도는 방향까지 본다."""

    def setUp(self):
        self.default = profile()
        self.emotion = profile(f0_q50_hz=250.0)      # 위로 갈라진 감정 참조
        self.sep = ea.emotion_reference_separation(self.default, self.emotion)
        self.assertEqual(self.sep["separated"], 1)

    def test_result_moving_toward_reference_is_followed(self):
        result = profile(f0_q50_hz=230.0)
        f = ea.emotion_result_follow(self.default, self.emotion, result, self.sep)
        self.assertEqual(f["followed"], 1)
        self.assertGreater(f["follow_ratio"], 0.0)

    def test_result_moving_opposite_is_not_followed(self):
        # 오늘 실측의 '기쁨이 가장 낮게 나왔다' 가 정확히 이 경우다.
        result = profile(f0_q50_hz=170.0)
        f = ea.emotion_result_follow(self.default, self.emotion, result, self.sep)
        self.assertEqual(f["followed"], 0)
        self.assertLess(f["result_gap_semitones"], 0.0)

    def test_movement_below_resolution_is_not_followed(self):
        res = ea.separation_resolution_semitones()
        nudge = self.default["f0_q50_hz"] * (2.0 ** ((res * 0.5) / 12.0))
        f = ea.emotion_result_follow(self.default, self.emotion, profile(f0_q50_hz=nudge), self.sep)
        self.assertEqual(f["followed"], 0)

    def test_follow_drives_supported(self):
        result = profile(f0_q50_hz=230.0)
        f = ea.emotion_result_follow(self.default, self.emotion, result, self.sep)
        rec = ea.resolve_emotion_acoustic("happy", ea.REFERENCE_DISTINCT, self.sep, f)
        self.assertEqual(rec["state"], "supported")
        self.assertTrue(rec["honored"])
        self.assertTrue(rec["usable"])


class TestInstructProbe(unittest.TestCase):
    """F. instruct_ids 는 실험이고, accepted 가 honored 로 승격되지 않는다."""

    def test_production_never_enables_probe(self):
        self.assertFalse(ea.instruct_probe_allowed("production", True))
        self.assertFalse(ea.instruct_probe_allowed("production", False))
        self.assertTrue(ea.instruct_probe_allowed("experiment", True))
        self.assertFalse(ea.instruct_probe_allowed("experiment", False))

    def test_vendor_declares_unsupported_for_our_model_size(self):
        self.assertEqual(ea.instruct_claim_for_model_size("0b6"), "unsupported")

    def test_accepted_without_measurement_is_never_honored(self):
        ev = ea.instruct_probe_evidence(attempted=True, accepted=True, follow=None)
        self.assertTrue(ev.accepted)
        self.assertFalse(ev.honored)
        self.assertEqual(cap.evidence_state(ev), "degraded")

    def test_claim_caps_evidence_on_our_model(self):
        # 관측이 완벽해도 vendor 선언이 상한이라 최종 상태는 올라가지 않는다.
        rec = ea.instruct_probe_record("0b6", attempted=True, accepted=True, follow={"followed": 1})
        self.assertTrue(rec["probe_honored"])          # 관측은 그대로 남는다
        self.assertEqual(rec["state"], "unsupported")  # 그러나 상태는 올라가지 않는다
        self.assertEqual(rec["reason"], "engine_declared_unsupported")

    def test_probe_record_has_no_honored_shortcut(self):
        import inspect
        params = set(inspect.signature(ea.instruct_probe_evidence).parameters)
        self.assertIn("follow", params)
        self.assertNotIn("honored", params)

    def test_bridge_probe_is_inert_in_production(self):
        import qwen_bridge
        seg = {"instruct_probe_text": "기쁘게 말해줘"}
        kwargs, rec = qwen_bridge._instruct_probe_kwargs(object(), seg, "production")
        self.assertEqual(kwargs, {})
        self.assertIsNone(rec)

    def test_bridge_probe_needs_explicit_text_even_in_experiment(self):
        import qwen_bridge
        kwargs, rec = qwen_bridge._instruct_probe_kwargs(object(), {}, "experiment")
        self.assertEqual(kwargs, {})
        self.assertIsNone(rec)

    def test_bridge_probe_never_reports_honored(self):
        import qwen_bridge

        class _Model:
            def _build_instruct_text(self, s):
                return "<im>%s</im>" % s

            def _tokenize_texts(self, texts):
                return [[1, 2, 3] for _ in texts]

        kwargs, rec = qwen_bridge._instruct_probe_kwargs(
            _Model(), {"instruct_probe_text": "기쁘게"}, "experiment")
        self.assertIn("instruct_ids", kwargs)
        self.assertNotIn("honored", rec)   # 브리지는 honored 를 만들 수 없다


class TestMeasurement(unittest.TestCase):
    """측정 — 합성 신호로 서술이 말이 되는지만 본다(판정 아님)."""

    @staticmethod
    def tone(freq, sr=24000, dur=1.0, amp=0.3):
        import numpy as np
        n = int(sr * dur)
        t = np.arange(n, dtype=np.float64) / sr
        return (amp * np.sin(2.0 * math.pi * freq * t)).astype(np.float64)

    def test_profile_has_exact_schema(self):
        rec = ea.measure_emotion_acoustic_profile(self.tone(200.0), 24000)
        self.assertEqual(tuple(rec.keys()), ea.EMOTION_ACOUSTIC_PROFILE_FIELDS)
        ea.serialize_emotion_profile(rec)   # 숫자만 — 예외 없이 통과해야 한다

    def test_pitch_difference_shows_up_in_median(self):
        import numpy as np
        low = ea.measure_emotion_acoustic_profile(self.tone(150.0), 24000)
        high = ea.measure_emotion_acoustic_profile(self.tone(300.0), 24000)
        self.assertGreater(high["f0_q50_hz"], low["f0_q50_hz"])
        sep = ea.emotion_reference_separation(low, high)
        self.assertEqual(sep["separated"], 1)
        self.assertGreater(sep["f0_median_offset_semitones"], 0.0)
        del np

    def test_interior_silence_is_counted_as_pause(self):
        import numpy as np
        sr = 24000
        speech = self.tone(200.0, sr, 0.5)
        gap = np.zeros(int(sr * 0.3), dtype=np.float64)
        sig = np.concatenate([speech, gap, speech])
        rec = ea.measure_emotion_acoustic_profile(sig, sr)
        self.assertEqual(rec["pause_count"], 1)
        self.assertGreater(rec["pause_total_ms"], 100)

    def test_leading_trailing_silence_is_not_a_pause(self):
        import numpy as np
        sr = 24000
        pad = np.zeros(int(sr * 0.3), dtype=np.float64)
        sig = np.concatenate([pad, self.tone(200.0, sr, 0.5), pad])
        rec = ea.measure_emotion_acoustic_profile(sig, sr)
        self.assertEqual(rec["pause_count"], 0)

    def test_speech_rate_absent_without_transcript_length(self):
        rec = ea.measure_emotion_acoustic_profile(self.tone(200.0), 24000)
        self.assertEqual(rec["speech_rate_available"], 0)
        self.assertEqual(rec["speech_rate_cps"], 0.0)
        withc = ea.measure_emotion_acoustic_profile(self.tone(200.0), 24000, transcript_chars=10)
        self.assertEqual(withc["speech_rate_available"], 1)
        self.assertGreater(withc["speech_rate_cps"], 0.0)

    def test_brighter_signal_has_higher_tilt(self):
        import numpy as np
        dark = self.tone(200.0, 24000, 1.0)
        bright = dark + self.tone(4000.0, 24000, 1.0, amp=0.3)
        self.assertGreater(ea.measure_spectral_tilt(bright, 24000),
                           ea.measure_spectral_tilt(dark, 24000))
        del np


class TestObservedRun(unittest.TestCase):
    """G. 실측(20260827-A2-emotion3) 재현 — 오늘의 정직한 답이 degraded 임을 고정한다.

    숫자 출처: analysis.json 의 f0 섹션(읽기 전용 참고 자료). 파일을 읽지 않고 상수로 박아
    테스트가 외부 경로에 의존하지 않게 한다.
    """

    # 참조 + 3 감정의 실측 F0 축(반음/Hz). 같은 참조 클립 하나로 생성한 결과다.
    OBSERVED = {
        "reference": (266.6666666666667, 11.026358847295134, 6.221605067210993, 4.20657150410813),
        "happy": (226.41509433962264, 10.218213363736005, 5.380043493213324, 4.285299397060446),
        "angry": (269.6629213483146, 10.148062243304473, 5.595816050670445, 4.098479418346342),
        "sad": (250.0, 11.35152192344533, 6.728579453693747, 4.090371022460719),
    }

    def prof(self, name):
        q50, rng, iqr, std = self.OBSERVED[name]
        return profile(f0_q50_hz=q50, f0_range_semitones=rng,
                       f0_iqr_semitones=iqr, f0_std_semitones=std)

    def test_variation_width_is_effectively_identical(self):
        stds = [self.OBSERVED[k][3] for k in ("happy", "angry", "sad")]
        spread = max(stds) - min(stds)
        # 세 감정의 변동폭 차이가 분석 해상도에도 못 미친다 = 감정 차이가 아니라 생성 편차다.
        self.assertLess(spread, ea.separation_resolution_semitones())

    def test_same_reference_run_is_all_degraded(self):
        keys = {"happy": "REF", "angry": "REF", "sad": "REF"}
        recs = ea.resolve_emotion_set("REF", keys)
        for r in recs:
            self.assertEqual(r["state"], "degraded")
            self.assertEqual(r["reason"], ea.EMOTION_REF_SHARED_DEFAULT)
            self.assertTrue(r["accepted"])    # 태그는 받아들여졌고
            self.assertFalse(r["honored"])    # 소리는 따라오지 않았다

    def test_happy_moved_opposite_to_the_common_expectation(self):
        # 기쁨이 참조보다 '낮게' 나왔다 — 통념과 반대 방향임을 수치로 고정한다.
        offset = ea.emotion_reference_separation(
            self.prof("reference"), self.prof("happy"))["f0_median_offset_semitones"]
        self.assertLess(offset, 0.0)

    def test_no_supported_verdict_exists_for_this_run(self):
        recs = ea.resolve_emotion_set("REF", {"happy": "REF", "angry": "REF", "sad": "REF"})
        self.assertFalse(ea.emotion_set_summary(recs)["any_supported"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
