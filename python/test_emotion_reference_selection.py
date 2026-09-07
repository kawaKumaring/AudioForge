# -*- coding: utf-8 -*-
"""감정 프로필로 참조를 고르는 계층 — GPU 없이 고정하는 성질.

이 계층이 위험해지는 지점은 하나다: **다른 사람 목소리를 골라 놓고 감정을 맞췄다고
적는 것**. 그래서 검증도 거기를 먼저 찌른다.

  · 후보는 같은 화자의 것뿐이다(다른 화자가 더 잘 맞아도 목록에 없다)
  · 파일 gain 이 바뀌어도 고르는 결과가 같다
  · 음역이 달라도 같은 억양 곡선이면 가깝게 본다
  · 못 잰 축은 점수에서 빠진다(0 점이 아니다)
  · 후보 0·1·복수에서 각각 다르게 말한다
  · 요청/분석/선택/적용 상태가 섞이지 않는다 — model_applied 는 항상 거짓이다
  · 화자 표기가 없는 기존 대본의 결과가 그대로다

모델·GPU 없음. 신호는 numpy 로 만들고 파일 존재 여부는 주입한다.
"""
import json
import unittest

import numpy as np

import emotion_acoustic as ea
import speaker_refs as sr

SR = 24000


def tone(duration_sec, f0_hz, amp=0.3, sample_rate=SR, vibrato=0.0):
    t = np.arange(int(sample_rate * duration_sec)) / float(sample_rate)
    f = f0_hz * (1.0 + vibrato * np.sin(2.0 * np.pi * t / max(1e-9, duration_sec)))
    phase = 2.0 * np.pi * np.cumsum(f) / float(sample_rate)
    return (amp * np.sin(phase)).astype(np.float64)


def utterance(f0_scale=1.0, amp=0.3, vibrato=0.06, gap=0.4):
    """말 두 덩어리와 그 사이 쉼. f0_scale 로 음역을, vibrato 로 억양 모양을 바꾼다."""
    a = tone(1.0, 180.0 * f0_scale, amp=amp, vibrato=vibrato)
    silence = np.zeros(int(SR * gap))
    b = tone(1.2, 200.0 * f0_scale, amp=amp, vibrato=-vibrato)
    return np.concatenate([a, silence, b])


def table(profiles=None, targets=None, **kwargs):
    """디스크 없이 도는 참조 표. 경로 문자열은 그냥 키다."""
    kwargs.setdefault("exists", lambda p: True)
    kwargs.setdefault("sha256_of", lambda p: "%064x" % (abs(hash(p)) % (1 << 256)))
    if profiles is not None:
        kwargs["profile_of"] = lambda p: profiles.get(p)
    if targets is not None:
        kwargs["target_profiles"] = targets
    return sr.ReferenceTable(**kwargs)


# ─────────────────────────────────────────────────────────────────────────────


class CandidateOwnershipTest(unittest.TestCase):
    """후보는 그 화자의 것뿐이다 — 걸러내는 것이 아니라 애초에 담기지 않는다."""

    def setUp(self):
        self.t = table(default_ref="/g.wav",
                       speaker_refs={"minsu": "/m.wav", "jieun": "/j.wav"},
                       speaker_emotion_refs={
                           sr.emotion_key("minsu", "sad"): "/m_sad.wav",
                           sr.emotion_key("jieun", "sad"): "/j_sad.wav",
                           sr.emotion_key("jieun", "angry"): "/j_angry.wav",
                       })

    def test_candidates_are_only_that_speakers_clips(self):
        paths = {c["path"] for c in self.t.speaker_candidates("minsu")}
        self.assertEqual(paths, {"/m.wav", "/m_sad.wav"})
        self.assertEqual({c["path"] for c in self.t.speaker_candidates("jieun")},
                         {"/j.wav", "/j_sad.wav", "/j_angry.wav"})

    def test_candidate_order_is_deterministic(self):
        a = [c["reference_id"] for c in self.t.speaker_candidates("jieun")]
        b = [c["reference_id"] for c in self.t.speaker_candidates("jieun")]
        self.assertEqual(a, b)
        self.assertEqual(a, sorted(a))

    def test_unusable_clips_are_not_candidates(self):
        t = table(default_ref="/g.wav", speaker_refs={"minsu": "/m.wav"},
                  speaker_emotion_refs={sr.emotion_key("minsu", "sad"): "/gone.wav"},
                  exists=lambda p: p != "/gone.wav")
        self.assertEqual([c["path"] for c in t.speaker_candidates("minsu")], ["/m.wav"])

    def test_a_better_matching_other_speaker_is_never_chosen(self):
        """지은의 클립이 요청한 감정에 완벽히 맞아도 민수의 말에 쓰이지 않는다."""
        target = ea.analyze_profile_v3(utterance(vibrato=0.20), SR)
        profiles = {
            # 지은의 클립이 기준과 사실상 동일하다 — 점수로만 보면 압도적 1위다.
            "/j.wav": target,
            "/j_sad.wav": target,
            # 민수의 클립은 둘 다 기준과 다르다.
            "/m.wav": ea.analyze_profile_v3(utterance(vibrato=0.02), SR),
            "/m_sad.wav": ea.analyze_profile_v3(utterance(vibrato=0.05, gap=1.0), SR),
        }
        t = table(default_ref="/g.wav",
                  speaker_refs={"minsu": "/m.wav", "jieun": "/j.wav"},
                  speaker_emotion_refs={sr.emotion_key("minsu", "cheer"): "/m_sad.wav",
                                        sr.emotion_key("jieun", "cheer"): "/j_sad.wav"},
                  profiles=profiles, targets={"joy": target})
        # 민수에게 joy 전용 참조는 없다 → 프로필 선택이 도는 자리다.
        row = t.resolve_with_emotion("minsu", "joy")
        self.assertIn(row["path"], ("/m.wav", "/m_sad.wav"))
        self.assertNotIn("j", row["path"].lstrip("/")[:1])
        self.assertEqual(row["emotion_match"]["candidates_considered"], 2)


class GainAndRegisterInvarianceTest(unittest.TestCase):
    """gain 과 음역은 연기가 아니다 — 선택 결과를 바꾸면 안 된다."""

    def _pick(self, amp=0.3, f0_scale=1.0):
        """같은 후보 셋을 gain·음역만 바꿔 놓고 무엇이 뽑히는지 본다."""
        target = ea.analyze_profile_v3(utterance(vibrato=0.20), SR)
        near = utterance(vibrato=0.18, amp=amp, f0_scale=f0_scale)
        far = utterance(vibrato=0.01, amp=amp, f0_scale=f0_scale)
        profiles = {"/near.wav": ea.analyze_profile_v3(near, SR),
                    "/far.wav": ea.analyze_profile_v3(far, SR)}
        t = table(default_ref="/g.wav", speaker_refs={"minsu": "/far.wav"},
                  speaker_emotion_refs={sr.emotion_key("minsu", "calm"): "/near.wav"},
                  profiles=profiles, targets={"joy": target})
        return t.resolve_with_emotion("minsu", "joy")

    def test_overall_gain_does_not_change_the_choice(self):
        base = self._pick(amp=0.3)
        louder = self._pick(amp=0.3 * 4.0)      # +12 dB
        quieter = self._pick(amp=0.3 * 0.25)    # −12 dB
        self.assertEqual(base["path"], "/near.wav")
        self.assertEqual(louder["path"], base["path"])
        self.assertEqual(quieter["path"], base["path"])

    def test_register_shift_does_not_change_the_choice(self):
        """음역을 통째로 올려도 상대 곡선이 같으면 같은 후보가 뽑힌다."""
        base = self._pick(f0_scale=1.0)
        higher = self._pick(f0_scale=1.5)       # 약 +7 반음
        self.assertEqual(base["path"], "/near.wav")
        self.assertEqual(higher["path"], base["path"])

    def test_same_contour_in_another_register_scores_close(self):
        a = ea.analyze_profile_v3(utterance(vibrato=0.15, f0_scale=1.0), SR)
        b = ea.analyze_profile_v3(utterance(vibrato=0.15, f0_scale=1.5), SR)
        c = ea.analyze_profile_v3(utterance(vibrato=0.01, f0_scale=1.0), SR)
        same_contour = ea.compare_profiles_v3(a, b)["score"]
        other_contour = ea.compare_profiles_v3(a, c)["score"]
        self.assertGreater(same_contour, other_contour,
                           "음역만 다른 같은 억양이 더 멀게 평가됐다")


class AxisAccountingTest(unittest.TestCase):
    """못 잰 축은 점수에서 빠진다 — 0 점으로 계산하면 순위가 자료 부족에 좌우된다."""

    def setUp(self):
        self.a = ea.analyze_profile_v3(utterance(vibrato=0.15), SR)
        self.b = ea.analyze_profile_v3(utterance(vibrato=0.05), SR)

    def test_unsupported_axis_is_excluded_not_zero_scored(self):
        m = ea.compare_profiles_v3(self.a, self.b)
        # 리듬은 ASR 타이밍이 없어 unsupported 다 — 배점에 들어가면 안 된다.
        self.assertNotIn("rhythm", m["axes_used"])
        self.assertIn({"axis": "rhythm", "reason": "AXIS_UNSUPPORTED"}, m["axes_excluded"])
        self.assertAlmostEqual(m["weight_total"],
                               sum(ea.PROFILE_MATCH_WEIGHTS[a] for a in m["axes_used"]), 4)

    def test_excluding_an_axis_changes_only_the_denominator(self):
        """축을 하나 빼도 남은 축의 유사도는 그대로다(0 으로 눌리지 않는다)."""
        m = ea.compare_profiles_v3(self.a, self.b)
        manual = sum(ea.PROFILE_MATCH_WEIGHTS[a] * m["axes"][a]["similarity"]
                     for a in m["axes_used"])
        self.assertAlmostEqual(m["score"], round(manual / m["weight_total"], 4), 3)

    def test_approximate_axis_is_downweighted_with_a_reason(self):
        words = [{"start": 0.0, "end": 0.4}, {"start": 0.5, "end": 0.9},
                 {"start": 1.4, "end": 2.0}]
        a = ea.analyze_profile_v3(utterance(vibrato=0.15), SR, word_timings=words)
        b = ea.analyze_profile_v3(utterance(vibrato=0.05), SR, word_timings=words)
        m = ea.compare_profiles_v3(a, b)
        self.assertIn("rhythm", m["axes_used"])
        axis = m["axes"]["rhythm"]
        self.assertEqual(axis["state"], "approximate")
        self.assertIn("why_downweighted", axis)
        self.assertAlmostEqual(axis["weight"],
                               ea.PROFILE_MATCH_WEIGHTS["rhythm"]
                               * ea.APPROXIMATE_WEIGHT_FACTOR, 6)

    def test_no_comparable_axis_yields_none_not_zero(self):
        empty = {"relative_f0": {"state": "insufficient"},
                 "relative_energy": {"state": "insufficient"},
                 "rhythm": {"state": "unsupported"},
                 "pause_tail": {"state": "insufficient"},
                 "trajectory": {"state": "insufficient"}}
        m = ea.compare_profiles_v3(self.a, empty)
        self.assertIsNone(m["score"], "모른다를 0 점으로 적으면 안 된다")
        self.assertEqual(m["axes_used"], [])


class CandidateCountTest(unittest.TestCase):
    """후보 0·1·복수에서 서로 다른 말을 한다."""

    def _table(self, candidates, target=True):
        profiles = {p: ea.analyze_profile_v3(utterance(vibrato=v), SR)
                    for p, v in candidates.items()}
        pair = {sr.emotion_key("minsu", "calm_%d" % i): p
                for i, p in enumerate(list(candidates)[1:])}
        return table(default_ref="/g.wav",
                     speaker_refs=({"minsu": list(candidates)[0]} if candidates else {}),
                     registered_speakers={"minsu"},
                     speaker_emotion_refs=pair, profiles=profiles,
                     targets={"joy": ea.analyze_profile_v3(utterance(vibrato=0.20), SR)}
                     if target else {})

    def test_zero_candidates_fails_closed(self):
        t = self._table({})
        with self.assertRaises(sr.SpeakerReferenceError) as ctx:
            t.resolve_with_emotion("minsu", "joy")
        self.assertEqual(ctx.exception.code, sr.SPEAKER_REFERENCE_NOT_READY)

    def test_one_candidate_is_not_called_optimal(self):
        t = self._table({"/m.wav": 0.18})
        row = t.resolve_with_emotion("minsu", "joy")
        m = row["emotion_match"]
        self.assertEqual(m["state"], sr.MATCH_INSUFFICIENT)
        self.assertEqual(m["reason"], "ONLY_ONE_CANDIDATE")
        self.assertFalse(m["application_states"]["reference_matched"])
        self.assertEqual(row["path"], "/m.wav")   # 목소리는 여전히 그 화자의 것이다

    def test_several_candidates_produce_a_match(self):
        t = self._table({"/m.wav": 0.01, "/m2.wav": 0.19})
        row = t.resolve_with_emotion("minsu", "joy")
        m = row["emotion_match"]
        self.assertEqual(m["state"], sr.MATCH_MATCHED)
        self.assertEqual(m["selection_method"], sr.SELECTION_PROFILE_MATCH)
        self.assertEqual(row["path"], "/m2.wav")
        self.assertIsNotNone(m["runner_up_score"])

    def test_no_target_profile_falls_back_without_claiming_success(self):
        t = self._table({"/m.wav": 0.01, "/m2.wav": 0.19}, target=False)
        m = t.resolve_with_emotion("minsu", "joy")["emotion_match"]
        self.assertEqual(m["state"], sr.MATCH_NO_TARGET)
        self.assertFalse(m["application_states"]["reference_matched"])

    def test_below_threshold_falls_back_to_the_speaker_default(self):
        t = self._table({"/m.wav": 0.01, "/m2.wav": 0.02})
        t.match_min_score = 0.99          # 어떤 후보도 넘지 못하는 문턱
        row = t.resolve_with_emotion("minsu", "joy")
        m = row["emotion_match"]
        self.assertEqual(m["state"], sr.MATCH_NO_RELIABLE)
        self.assertEqual(m["reason"], "BELOW_MIN_SCORE")
        self.assertEqual(row["path"], "/m.wav")   # 화자 기본 참조
        self.assertFalse(m["application_states"]["reference_matched"])

    def test_candidates_without_a_profile_are_counted_not_guessed(self):
        t = table(default_ref="/g.wav", speaker_refs={"minsu": "/m.wav"},
                  speaker_emotion_refs={sr.emotion_key("minsu", "calm"): "/m2.wav"},
                  profiles={}, targets={"joy": ea.analyze_profile_v3(utterance(), SR)})
        m = t.resolve_with_emotion("minsu", "joy")["emotion_match"]
        self.assertEqual(m["state"], sr.MATCH_NO_RELIABLE)
        self.assertEqual(m["reason"], "NO_CANDIDATE_PROFILE")
        self.assertEqual(m["candidates_without_profile"], 2)


class ExplicitAssignmentTest(unittest.TestCase):
    """사용자가 직접 지정한 것을 점수로 뒤집지 않는다."""

    def test_explicit_pair_reference_wins_without_comparison(self):
        called = []

        def spy(target, candidate):
            called.append(1)
            return {"score": 1.0, "axes_used": [], "axes_excluded": []}

        t = table(default_ref="/g.wav", speaker_refs={"minsu": "/m.wav"},
                  speaker_emotion_refs={sr.emotion_key("minsu", "joy"): "/m_joy.wav"},
                  profiles={}, targets={"joy": {"profile_id": "ep3_x"}}, compare=spy)
        row = t.resolve_with_emotion("minsu", "joy")
        self.assertEqual(row["path"], "/m_joy.wav")
        self.assertEqual(row["source"], sr.SOURCE_SPEAKER_EMOTION)
        self.assertEqual(row["emotion_match"]["selection_method"], sr.SELECTION_EXPLICIT)
        self.assertEqual(called, [], "직접 지정한 참조를 점수와 겨루게 하면 안 된다")


class ApplicationStateTest(unittest.TestCase):
    """요청·분석·선택·적용은 서로 다른 축이다. 앞 단계를 뒤 단계로 올려 적지 않는다."""

    def _record(self):
        target = ea.analyze_profile_v3(utterance(vibrato=0.20), SR)
        profiles = {"/m.wav": ea.analyze_profile_v3(utterance(vibrato=0.01), SR),
                    "/m2.wav": ea.analyze_profile_v3(utterance(vibrato=0.19), SR)}
        t = table(default_ref="/g.wav", speaker_refs={"minsu": "/m.wav"},
                  speaker_emotion_refs={sr.emotion_key("minsu", "calm"): "/m2.wav"},
                  profiles=profiles, targets={"joy": target})
        return t.resolve_with_emotion("minsu", "joy")["emotion_match"]

    def test_model_and_post_are_always_false_in_this_phase(self):
        m = self._record()
        for state in sr.NEVER_APPLIED_STATES:
            self.assertFalse(m["application_states"][state],
                             "참조를 골랐을 뿐인데 %s 로 적혔다" % state)

    def test_matched_record_says_reference_matched_only(self):
        m = self._record()
        states = m["application_states"]
        self.assertTrue(states["requested"])
        self.assertTrue(states["analyzed"])
        self.assertTrue(states["reference_matched"])
        self.assertFalse(states["unsupported"])

    def test_state_vocabularies_do_not_bleed_into_each_other(self):
        m = self._record()
        # 선택 상태(MATCH_*)와 적용 상태(EMOTION_APPLICATION_STATES)는 다른 어휘다.
        self.assertIn(m["state"], sr.MATCH_STATES)
        self.assertEqual(set(m["application_states"]),
                         set(ea.EMOTION_APPLICATION_STATES))
        self.assertIn(m["selection_method"], sr.SELECTION_METHODS)

    def test_score_is_declared_as_not_a_model_control(self):
        a = ea.analyze_profile_v3(utterance(vibrato=0.15), SR)
        b = ea.analyze_profile_v3(utterance(vibrato=0.05), SR)
        self.assertTrue(ea.compare_profiles_v3(a, b)["not_a_model_control"])


class LegacyInvarianceTest(unittest.TestCase):
    """화자 표기가 없는 기존 대본과 기존 단일 화자 결과가 그대로여야 한다."""

    def test_scripts_without_speakers_take_the_v130_path(self):
        t = table(default_ref="/g.wav", emotion_refs={"joy": "/e_joy.wav"},
                  profiles={"/e_joy.wav": {"profile_id": "x"}},
                  targets={"joy": {"profile_id": "y"}})
        plain = t.resolve(None, "joy")
        row = t.resolve_with_emotion(None, "joy")
        self.assertEqual(row["path"], plain["path"])
        self.assertEqual(row["source"], sr.SOURCE_EMOTION)
        self.assertEqual(row["emotion_match"]["state"], sr.MATCH_UNSUPPORTED)
        self.assertEqual(row["emotion_match"]["reason"], "NO_SPEAKER_NOTATION")

    def test_resolve_is_untouched_by_the_selection_layer(self):
        """선택 재료를 잔뜩 줘도 resolve() 의 결과가 달라지지 않는다."""
        kwargs = dict(default_ref="/g.wav", emotion_refs={"joy": "/e.wav"},
                      speaker_refs={"minsu": "/m.wav"},
                      speaker_emotion_refs={sr.emotion_key("minsu", "sad"): "/m_sad.wav"},
                      exists=lambda p: True, sha256_of=lambda p: "0" * 64)
        bare = sr.ReferenceTable(**kwargs)
        loaded = sr.ReferenceTable(target_profiles={"joy": {"profile_id": "y"}},
                                   profile_of=lambda p: {"profile_id": "z"}, **kwargs)
        for speaker, emotion in ((None, "joy"), (None, "default"),
                                 ("minsu", "sad"), ("minsu", "joy")):
            self.assertEqual(bare.resolve(speaker, emotion),
                             loaded.resolve(speaker, emotion),
                             "resolve(%r, %r) 가 달라졌다" % (speaker, emotion))

    def test_unregistered_speaker_still_fails_closed(self):
        t = table(default_ref="/g.wav", speaker_refs={"minsu": "/m.wav"},
                  profiles={}, targets={})
        with self.assertRaises(sr.SpeakerReferenceError) as ctx:
            t.resolve_with_emotion("nobody", "joy")
        self.assertEqual(ctx.exception.code, sr.SPEAKER_NOT_REGISTERED)


class RecordLeakageTest(unittest.TestCase):
    """기록에 표시 이름·경로·대사가 들어갈 자리가 없어야 한다."""

    def test_match_record_carries_no_names_or_paths(self):
        target = ea.analyze_profile_v3(utterance(vibrato=0.20), SR)
        profiles = {"/사용자/민수 목소리.wav": ea.analyze_profile_v3(utterance(vibrato=0.19), SR),
                    "E:/절대경로/other.wav": ea.analyze_profile_v3(utterance(vibrato=0.01), SR)}
        t = table(default_ref="/g.wav", speaker_refs={"민수": "/사용자/민수 목소리.wav"},
                  speaker_emotion_refs={sr.emotion_key("민수", "calm"): "E:/절대경로/other.wav"},
                  profiles=profiles, targets={"joy": target})
        m = t.resolve_with_emotion("민수", "joy")["emotion_match"]
        blob = json.dumps(m, ensure_ascii=False)
        for leak in ("민수", "절대경로", ".wav", "E:", "\\"):
            self.assertNotIn(leak, blob, "기록에 %s 가 샜다" % leak)
        # 경로 구분자는 스키마 이름(af-emotion-selection/1) 말고 어디에도 없어야 한다.
        without_schema = json.dumps({k: v for k, v in m.items() if k != "schema"},
                                    ensure_ascii=False)
        self.assertNotIn("/", without_schema, "값 어딘가에 경로가 샜다")
        self.assertTrue(m["speaker_ref"].startswith("spk_"))
        self.assertTrue(m["reference_id"].startswith("ref"))


if __name__ == "__main__":
    unittest.main()
