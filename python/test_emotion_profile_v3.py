# -*- coding: utf-8 -*-
"""시간축 감정 프로필 v3 — GPU 없이 고정하는 불변식.

이 프로필의 쓸모는 **다른 화자·다른 대사에 옮길 수 있는가**에 달려 있다. 그래서 검증도
그 성질을 직접 찌른다.

  · 파일 gain 만 바꾸면 상대 F0·상대 에너지가 실질적으로 같아야 한다
  · 음역을 통째로 옮겨도 상대 F0 곡선이 같아야 한다
  · 시간축을 늘려도 정규화 trajectory 의 anchor 가 보존돼야 한다
  · 무음과 호흡을 같은 것으로 판정하지 않아야 한다
  · 유성 자료가 모자라면 숫자를 지어내지 않아야 한다
  · 같은 입력이면 같은 프로필(결정성)이고 provenance 가 붙어야 한다
  · gain·공간 자동화 명령이 프로필에서 나오면 안 된다
  · 원문·절대경로가 새면 안 된다

모델·GPU·파일 I/O 없음. 신호는 numpy 로 만든다.
"""
import json
import math
import os
import unittest

import numpy as np

import emotion_acoustic as ea

SR = 24000


def tone(duration_sec, f0_hz, amp=0.3, sr=SR, vibrato=0.0):
    """유성 구간 하나. vibrato 를 주면 F0 가 시간에 따라 움직인다(곡선을 만들기 위해)."""
    t = np.arange(int(sr * duration_sec)) / float(sr)
    f = f0_hz * (1.0 + vibrato * np.sin(2.0 * np.pi * t / max(1e-9, duration_sec)))
    phase = 2.0 * np.pi * np.cumsum(f) / float(sr)
    return (amp * np.sin(phase)).astype(np.float64)


def utterance(scale=1.0, f0_scale=1.0, amp=0.3, sr=SR):
    """말 두 덩어리와 그 사이 쉼. `scale` 로 시간축을, `f0_scale` 로 음역을 바꾼다."""
    a = tone(1.0 * scale, 180.0 * f0_scale, amp=amp, sr=sr, vibrato=0.06)
    gap = np.zeros(int(sr * 0.4 * scale))
    b = tone(1.2 * scale, 200.0 * f0_scale, amp=amp, sr=sr, vibrato=-0.05)
    return np.concatenate([a, gap, b])


def anchors_of(profile, axis="relative_f0", key="semitone_anchors"):
    return [v for _t, v in (profile[axis].get(key) or [])]


class GainInvarianceTest(unittest.TestCase):
    """파일 gain 은 연기가 아니다 — 프로필이 gain 을 따라가면 안 된다."""

    def test_relative_f0_and_energy_survive_a_gain_change(self):
        base = utterance()
        louder = base * 4.0            # +12 dB
        quieter = base * 0.25          # −12 dB
        p0 = ea.analyze_profile_v3(base, SR)
        p1 = ea.analyze_profile_v3(louder, SR)
        p2 = ea.analyze_profile_v3(quieter, SR)
        for p in (p1, p2):
            self.assertEqual(anchors_of(p), anchors_of(p0), "gain 이 상대 F0 를 바꿨다")
            self.assertEqual(anchors_of(p, "relative_energy", "relative_db_anchors"),
                             anchors_of(p0, "relative_energy", "relative_db_anchors"),
                             "gain 이 상대 에너지를 바꿨다")

    def test_dc_offset_does_not_move_the_energy_curve(self):
        base = utterance()
        with_dc = base + 0.05
        a = anchors_of(ea.analyze_profile_v3(base, SR), "relative_energy", "relative_db_anchors")
        b = anchors_of(ea.analyze_profile_v3(with_dc, SR), "relative_energy",
                       "relative_db_anchors")
        for x, y in zip(a, b):
            self.assertLess(abs(x - y), 0.5, "DC 오프셋이 상대 에너지를 흔들었다")


class RegisterInvarianceTest(unittest.TestCase):
    """음역이 다른 화자에게 옮기려면 절대 Hz 가 아니라 상대 곡선이어야 한다."""

    def test_shifting_the_whole_register_keeps_the_contour(self):
        low = utterance(f0_scale=1.0)
        high = utterance(f0_scale=1.5)      # 통째로 약 7 반음 위
        p_low = ea.analyze_profile_v3(low, SR)
        p_high = ea.analyze_profile_v3(high, SR)
        a, b = anchors_of(p_low), anchors_of(p_high)
        self.assertEqual(len(a), len(b))
        for x, y in zip(a, b):
            self.assertLess(abs(x - y), 0.35, "음역을 옮기자 상대 곡선이 달라졌다")
        # 기준 Hz 는 달라야 한다(그 값이 곧 '어느 음역이었나' 다).
        self.assertGreater(p_high["relative_f0"]["reference_median_hz"],
                           p_low["relative_f0"]["reference_median_hz"] * 1.3)

    def test_reference_median_can_be_injected_for_a_target_speaker(self):
        """대상 화자 기준으로 상대화할 수 있어야 한다(연기를 옮기는 방향)."""
        sig = utterance()
        own = ea.analyze_profile_v3(sig, SR)
        target = ea.analyze_profile_v3(sig, SR, reference_median_hz=300.0)
        self.assertNotEqual(target["relative_f0"]["reference_median_hz"],
                            own["relative_f0"]["reference_median_hz"])
        # 기준이 위로 가면 곡선 전체가 아래로 평행 이동한다(모양은 그대로).
        d = [x - y for x, y in zip(anchors_of(target), anchors_of(own))]
        self.assertLess(max(d) - min(d), 0.05, "평행 이동이 아니라 모양이 바뀌었다")


class TimeAxisTest(unittest.TestCase):
    """길이가 다른 대사에 붙이려면 정규화 좌표가 보존돼야 한다."""

    def test_stretching_time_preserves_normalized_anchors(self):
        short = utterance(scale=1.0)
        long = utterance(scale=2.0)        # 같은 F0, 시간만 두 배
        p_s = ea.analyze_profile_v3(short, SR)
        p_l = ea.analyze_profile_v3(long, SR)
        ts = [t for t, _v in p_s["relative_f0"]["semitone_anchors"]]
        tl = [t for t, _v in p_l["relative_f0"]["semitone_anchors"]]
        self.assertEqual(ts, tl, "정규화 시간 좌표가 길이에 따라 달라졌다")
        for x, y in zip(anchors_of(p_s), anchors_of(p_l)):
            self.assertLess(abs(x - y), 0.5, "시간축을 늘리자 곡선 값이 달라졌다")
        # 쉼의 상대 위치도 보존돼야 한다.
        ps = p_s["pause_tail"]["pauses"]
        pl = p_l["pause_tail"]["pauses"]
        if ps and pl:
            self.assertLess(abs(ps[0]["start_norm"] - pl[0]["start_norm"]), 0.05)

    def test_trajectory_is_a_plan_not_an_execution(self):
        p = ea.analyze_profile_v3(utterance(), SR)
        self.assertEqual(p["trajectory"]["state"], "analyzed")
        self.assertFalse(p["trajectory"]["time_warp_plan"]["executed"],
                         "E1 에서 time-warp 를 실행하면 안 된다")
        self.assertTrue(p["trajectory"]["normalized_time"])
        self.assertTrue(p["trajectory"]["target_anchors"])


class HonestyTest(unittest.TestCase):
    """못 잰 것을 잰 것처럼 적지 않는다."""

    def test_breath_is_unsupported_not_silence(self):
        p = ea.analyze_profile_v3(utterance(), SR)
        breath = p["pause_tail"]["breath"]
        self.assertEqual(breath["state"], "unsupported")
        self.assertEqual(breath["reason"], "NO_BREATH_DETECTOR")
        # 쉼은 쉼대로 세어 두고, 그것을 호흡이라고 부르지 않는다.
        self.assertIn("pause_count", p["pause_tail"])

    def test_unvoiced_input_gives_insufficient_not_numbers(self):
        noise = (np.random.default_rng(7).normal(0, 0.01, SR // 2)).astype(np.float64)
        p = ea.analyze_profile_v3(noise, SR)
        self.assertIn(p["axes"]["relative_f0"], ("insufficient", "analyzed"))
        if p["axes"]["relative_f0"] == "insufficient":
            self.assertNotIn("semitone_anchors", p["relative_f0"])
            self.assertIn("reason", p["relative_f0"])

    def test_silence_gives_no_invented_values(self):
        p = ea.analyze_profile_v3(np.zeros(SR), SR)
        self.assertEqual(p["axes"]["relative_f0"], "insufficient")
        self.assertEqual(p["axes"]["relative_energy"], "insufficient")
        self.assertEqual(p["trajectory"]["state"], "insufficient")

    def test_rhythm_without_asr_is_unsupported(self):
        p = ea.analyze_profile_v3(utterance(), SR)
        self.assertEqual(p["rhythm"]["state"], "unsupported")
        self.assertEqual(p["rhythm"]["reason"], "ASR_TIMING_ABSENT")
        self.assertIn(ea.WARN_ASR_ABSENT, p["provenance"]["warnings"])

    def test_rhythm_with_asr_is_word_level_and_says_so(self):
        """음절 분해기가 없다 — 단어 anchor 까지만 지원하고 approximate 로 밝힌다."""
        words = [{"start": 0.0, "end": 0.4}, {"start": 0.5, "end": 1.0},
                 {"start": 1.4, "end": 2.0}, {"start": 2.1, "end": 2.6}]
        p = ea.analyze_profile_v3(utterance(), SR, word_timings=words)
        r = p["rhythm"]
        self.assertEqual(r["state"], "approximate")
        self.assertEqual(r["granularity"], "word")
        self.assertEqual(r["word_count"], 4)
        self.assertEqual(len(r["duration_ratios"]), 4)
        self.assertIsNotNone(r["rate_change_ratio"])

    def test_low_voiced_ratio_is_warned(self):
        mostly_silence = np.concatenate([tone(0.4, 180.0), np.zeros(int(SR * 1.6))])
        p = ea.analyze_profile_v3(mostly_silence, SR)
        if p["axes"]["relative_f0"] == "analyzed":
            self.assertLess(p["relative_f0"]["voiced_ratio"], 0.5)
            self.assertIn(ea.WARN_LOW_VOICED_RATIO, p["provenance"]["warnings"])


class ProvenanceTest(unittest.TestCase):
    def test_profile_is_deterministic(self):
        sig = utterance()
        a = ea.analyze_profile_v3(sig, SR, source_id="fx", source_sha256="a" * 64)
        b = ea.analyze_profile_v3(sig, SR, source_id="fx", source_sha256="a" * 64)
        self.assertEqual(a["profile_id"], b["profile_id"])
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))

    def test_profile_id_follows_content(self):
        a = ea.analyze_profile_v3(utterance(), SR)
        b = ea.analyze_profile_v3(utterance(f0_scale=1.5), SR)
        self.assertNotEqual(a["profile_id"], b["profile_id"])
        self.assertTrue(a["profile_id"].startswith("ep3_"))

    def test_provenance_records_source_and_analyzer(self):
        p = ea.analyze_profile_v3(utterance(), SR, source_id="ko-speech-7s",
                                  source_sha256="b" * 64)
        prov = p["provenance"]
        self.assertEqual(prov["source_id"], "ko-speech-7s")
        self.assertEqual(prov["source_sha256"], "b" * 64)
        self.assertEqual(prov["analyzer"], "emotion_acoustic.analyze_profile_v3")
        self.assertEqual(prov["analyzer_version"], ea.EMOTION_PROFILE_V3_VERSION)
        self.assertEqual(prov["metrics_module"], "onset_continuity_metrics")
        for k in ("frame_ms", "hop_ms", "f0_min_hz", "f0_max_hz", "anchors"):
            self.assertIn(k, prov["params"], k)

    def test_axis_states_come_from_the_declared_vocabulary(self):
        p = ea.analyze_profile_v3(utterance(), SR)
        self.assertEqual(set(p["axes"]), set(ea.PROFILE_V3_AXES))
        for axis, state in p["axes"].items():
            self.assertIn(state, ea.AXIS_MEASUREMENT_STATES, axis)

    def test_application_states_are_named_and_separate(self):
        """참조 구간만 고른 것을 `model_applied` 로 적을 수 없게 어휘를 나눠 둔다."""
        self.assertEqual(ea.EMOTION_APPLICATION_STATES,
                         ("requested", "analyzed", "reference_matched",
                          "model_applied", "post_applied", "unsupported"))
        # 측정 상태 어휘와 겹쳐 쓰지 않는다.
        self.assertNotIn("reference_matched", ea.AXIS_MEASUREMENT_STATES)
        self.assertNotIn("model_applied", ea.AXIS_MEASUREMENT_STATES)


class NoCommandsTest(unittest.TestCase):
    """프로필은 서술이다 — 실행 명령이 나오면 안 된다."""

    def test_profile_has_no_gain_or_spatial_automation(self):
        p = ea.analyze_profile_v3(utterance(), SR, word_timings=[{"start": 0.0, "end": 0.5},
                                                                {"start": 0.6, "end": 1.2}])
        # 문자열 부분 일치가 아니라 **키 모양**을 본다 — `peak_normalized: false` 처럼
        # "하지 않는다" 를 적은 필드까지 잡으면 정직한 서술을 못 하게 된다.
        def keys_of(o, out):
            if isinstance(o, dict):
                for k, v in o.items():
                    out.add(k)
                    keys_of(v, out)
            elif isinstance(o, list):
                for v in o:
                    keys_of(v, out)
            return out

        keys = keys_of(p, set())
        for k in keys:
            for shape in ("gain_db", "gain_curve", "apply_", "pan_", "reverb_",
                          "spatial_", "automation"):
                self.assertNotIn(shape, k, "실행 명령처럼 보이는 필드: %s" % k)
        self.assertNotIn("macro_gain", keys)
        self.assertTrue(p["relative_energy"]["not_a_gain_command"])
        # 프로필이 스스로 "정규화하지 않았다" 고 밝히는 것은 정상이다.
        self.assertFalse(p["relative_energy"]["peak_normalized"])

    def test_profile_carries_no_script_text_or_paths(self):
        p = ea.analyze_profile_v3(utterance(), SR, source_id="fx", source_sha256="c" * 64)
        blob = json.dumps(p, ensure_ascii=False)
        for leak in (":/", ":\\\\", ".wav", "안녕", "E:"):
            self.assertNotIn(leak, blob, "원문·경로가 샜다: %s" % leak)

    def test_no_raw_frames_are_stored(self):
        """원본 프레임을 통째로 담지 않는다 — 축약 좌표만."""
        p = ea.analyze_profile_v3(utterance(scale=3.0), SR)
        self.assertEqual(len(p["relative_f0"]["semitone_anchors"]), ea.PROFILE_V3_ANCHORS)
        self.assertEqual(len(p["relative_energy"]["relative_db_anchors"]),
                         ea.PROFILE_V3_ANCHORS)
        # 3 초든 9 초든 좌표 개수가 같다(길이에 비례해 커지지 않는다).
        short = ea.analyze_profile_v3(utterance(scale=1.0), SR)
        self.assertEqual(len(short["relative_f0"]["semitone_anchors"]),
                         len(p["relative_f0"]["semitone_anchors"]))


class LegacyUnchangedTest(unittest.TestCase):
    """v2 는 그대로 둔다. v3 는 값이 있는 것처럼 v2 를 승격하지 않는다."""

    def test_v2_profile_fields_are_untouched(self):
        self.assertEqual(ea.EMOTION_ACOUSTIC_PROFILE_FIELDS[0], "sample_rate")
        rec = ea.measure_emotion_acoustic_profile(utterance(), SR)
        self.assertEqual(tuple(rec.keys()), ea.EMOTION_ACOUSTIC_PROFILE_FIELDS)

    def test_measure_pause_keeps_its_counts_and_adds_spans(self):
        rec = ea.measure_pause(utterance(), SR)
        for k in ("speech_ms", "pause_count", "pause_total_ms", "pause_longest_ms"):
            self.assertIn(k, rec)
        self.assertIn("pause_spans_ms", rec)
        self.assertEqual(len(rec["pause_spans_ms"]), rec["pause_count"])

    def test_v2_and_v3_are_different_kinds_of_record(self):
        v2 = ea.measure_emotion_acoustic_profile(utterance(), SR)
        v3 = ea.analyze_profile_v3(utterance(), SR)
        self.assertNotIn("schema", v2, "v2 는 요약 통계 레코드다")
        self.assertEqual(v3["schema"], ea.EMOTION_PROFILE_V3_SCHEMA)
        self.assertNotIn("axes", v2)


if __name__ == "__main__":
    unittest.main()
