# -*- coding: utf-8 -*-
"""후보 목록과 사용자 선택 — 잠정 추천이 정답처럼 행세하지 못하게 하는 계약.

이 계층이 위험해지는 지점.
  · 사람이 골랐는데 자동 추천이 덮는다
  · 고른 후보가 사라졌을 때 조용히 다른 파일로 간다
  · 음악에서 뜯어낸 보컬이 추천으로 올라간다
  · 후보가 하나뿐인데 "가장 적합"이라고 적힌다
  · 화면용 파일 이름이 기록으로 새어 나간다
  · 선택을 바꾸는 것이 원본 파일을 건드린다

모델·GPU 없음. 신호는 numpy 로 만들고 파일 존재 여부는 주입한다(§원본 불변 검사만 실파일).
"""
import hashlib
import io as _io
import json
import os
import shutil
import tempfile
import unittest

import numpy as np

import emotion_acoustic as ea
import speaker_refs as sr

SR = 24000


def tone(f0, vib, dur=1.2):
    n = np.arange(int(SR * dur)) / float(SR)
    f = f0 * (1.0 + vib * np.sin(2.0 * np.pi * n / dur))
    return (0.3 * np.sin(2.0 * np.pi * np.cumsum(f) / float(SR))).astype(np.float64)


def profile(vib, **kw):
    return ea.analyze_profile_v3(tone(180.0, vib), SR, **kw)


class Fixture(unittest.TestCase):
    """민수에게 후보 셋, 지은에게 하나. 기준 감정은 `joy`."""

    def setUp(self):
        self.target = profile(0.20)
        self.paths = {
            "near": "/refs/민수_밝게.wav",
            "mid": "/refs/민수_보통.wav",
            "far": "/refs/민수_담담.wav",
            "other": "/refs/지은_기본.wav",
        }
        self.profiles = {
            self.paths["near"]: profile(0.19),
            self.paths["mid"]: profile(0.10),
            self.paths["far"]: profile(0.01),
            self.paths["other"]: self.target,      # 점수만 보면 압도적 1위
        }

    def table(self, **kw):
        kw.setdefault("default_ref", "/refs/global.wav")
        kw.setdefault("speaker_refs", {"minsu": self.paths["far"],
                                       "jieun": self.paths["other"]})
        kw.setdefault("speaker_emotion_refs", {
            sr.emotion_key("minsu", "calm"): self.paths["near"],
            sr.emotion_key("minsu", "flat"): self.paths["mid"],
        })
        kw.setdefault("exists", lambda p: True)
        kw.setdefault("sha256_of", lambda p: hashlib.sha256(p.encode()).hexdigest())
        kw.setdefault("profile_of", self.profiles.get)
        kw.setdefault("target_profiles", {"joy": self.target})
        return sr.ReferenceTable(**kw)

    def ref_id(self, table, key):
        return table.reference_id(self.paths[key])


class UserChoiceWinsTest(Fixture):
    """사람이 고른 것이 잠정 추천보다 위다."""

    def test_auto_recommends_the_closest_candidate(self):
        t = self.table()
        rec = t.recommended_candidate("minsu", "joy")
        self.assertIsNotNone(rec)
        self.assertEqual(rec["reference_id"], self.ref_id(t, "near"))

    def test_user_choice_overrides_the_recommendation(self):
        t = self.table()
        far = self.ref_id(t, "far")
        t.user_selections[sr.emotion_key("minsu", "joy")] = far
        row = t.resolve_with_emotion("minsu", "joy")
        self.assertEqual(row["path"], self.paths["far"])
        m = row["emotion_match"]
        self.assertEqual(m["state"], sr.MATCH_USER_SELECTED)
        self.assertEqual(m["selection_method"], sr.SELECTION_USER)
        self.assertEqual(m["selection_reason"], sr.REASON_USER_CHANGED_CANDIDATE)
        self.assertEqual(m["user_selected_reference"], far)
        self.assertEqual(m["recommended_reference"], self.ref_id(t, "near"))
        self.assertEqual(m["resolved_reference"], far)

    def test_keeping_the_recommendation_is_recorded_as_such(self):
        t = self.table()
        near = self.ref_id(t, "near")
        t.user_selections[sr.emotion_key("minsu", "joy")] = near
        m = t.resolve_with_emotion("minsu", "joy")["emotion_match"]
        self.assertEqual(m["selection_reason"], sr.REASON_USER_KEPT_RECOMMENDATION)
        self.assertEqual(m["recommended_reference"], near)
        self.assertEqual(m["user_selected_reference"], near)

    def test_user_choice_marks_reference_matched(self):
        """사람이 듣고 고른 것은 잠정 추천보다 강한 근거다."""
        t = self.table()
        t.user_selections[sr.emotion_key("minsu", "joy")] = self.ref_id(t, "mid")
        states = t.resolve_with_emotion("minsu", "joy")["emotion_match"]["application_states"]
        self.assertTrue(states["reference_matched"])
        for never in sr.NEVER_APPLIED_STATES:
            self.assertFalse(states[never])


class BackToDefaultTest(Fixture):
    """기본 목소리로 돌아가기와 감정 참조 안 쓰기는 다른 뜻이다."""

    def test_speaker_default_choice(self):
        t = self.table()
        t.user_selections[sr.emotion_key("minsu", "joy")] = sr.USER_CHOICE_SPEAKER_DEFAULT
        row = t.resolve_with_emotion("minsu", "joy")
        self.assertEqual(row["path"], self.paths["far"])   # 민수의 기본 참조
        m = row["emotion_match"]
        self.assertEqual(m["state"], sr.MATCH_USER_DEFAULT)
        self.assertEqual(m["selection_reason"], sr.REASON_USER_CHOSE_SPEAKER_DEFAULT)
        self.assertFalse(m["application_states"]["reference_matched"])

    def test_declining_emotion_reference_is_a_distinct_reason(self):
        t = self.table()
        t.user_selections[sr.emotion_key("minsu", "joy")] = sr.USER_CHOICE_NO_EMOTION_REF
        m = t.resolve_with_emotion("minsu", "joy")["emotion_match"]
        self.assertEqual(m["selection_reason"], sr.REASON_USER_DECLINED_EMOTION_REFERENCE)
        self.assertNotEqual(m["selection_reason"], sr.REASON_USER_CHOSE_SPEAKER_DEFAULT)
        self.assertFalse(m["application_states"]["reference_matched"])

    def test_both_choices_keep_the_speakers_own_voice(self):
        for choice in sr.USER_CHOICES:
            t = self.table()
            t.user_selections[sr.emotion_key("minsu", "joy")] = choice
            row = t.resolve_with_emotion("minsu", "joy")
            self.assertIn(row["path"], (self.paths["far"], self.paths["near"],
                                        self.paths["mid"]), choice)
            self.assertNotEqual(row["path"], self.paths["other"], choice)


class StaleAndForeignChoiceTest(Fixture):
    """고른 후보가 사라졌거나 남의 것이면 조용히 넘어가지 않는다."""

    def test_missing_choice_falls_back_and_says_so(self):
        t = self.table()
        t.user_selections[sr.emotion_key("minsu", "joy")] = "ref_doesnotexist"
        m = t.resolve_with_emotion("minsu", "joy")["emotion_match"]
        self.assertTrue(m["user_selection_stale"])
        self.assertEqual(m["selection_reason"],
                         sr.REASON_USER_SELECTION_NOT_A_CANDIDATE)

    def test_another_speakers_reference_id_is_ignored(self):
        """지은의 참조 id 를 민수에게 지정해도 지은의 파일로 가지 않는다."""
        t = self.table()
        row = t.resolve_with_emotion("jieun", "joy")   # 지은 후보를 먼저 만들어 둔다
        jieun_id = row["reference_id"]
        t.user_selections[sr.emotion_key("minsu", "joy")] = jieun_id
        got = t.resolve_with_emotion("minsu", "joy")
        self.assertNotEqual(got["path"], self.paths["other"])
        self.assertTrue(got["emotion_match"]["user_selection_stale"])

    def test_choice_for_one_emotion_does_not_leak_to_another(self):
        t = self.table()
        t.user_selections[sr.emotion_key("minsu", "joy")] = self.ref_id(t, "far")
        t.target_profiles["worry"] = self.target
        m = t.resolve_with_emotion("minsu", "worry")["emotion_match"]
        self.assertIsNone(m["user_selected_reference"])


class ExclusionTest(Fixture):
    """추천에서 빼는 것과 목록에서 지우는 것은 다르다."""

    def meta(self, **over):
        base = {p: {"duration_sec": 4.0, "source_kind": "unknown",
                    "quality_state": sr.QUALITY_OK, "quality_codes": []}
                for p in self.paths.values()}
        for path_key, patch in over.items():
            base[self.paths[path_key]].update(patch)
        return base

    def test_music_stem_is_not_recommended_but_stays_selectable(self):
        t = self.table(candidate_meta=self.meta(near={"source_kind": "separated_stem"}))
        rec = t.recommended_candidate("minsu", "joy")
        # 가장 가까운 후보였지만 stem 이라 추천되지 않는다.
        self.assertNotEqual(rec["reference_id"], self.ref_id(t, "near"))
        view = t.candidate_view("minsu", "joy")
        rows = {c["reference_id"]: c for c in view["candidates"]}
        stem = rows[self.ref_id(t, "near")]
        self.assertEqual(stem["excluded_reason"], sr.EXCLUDED_SEPARATED_STEM)
        self.assertFalse(stem["recommended"])
        self.assertEqual(stem["source_kind"], "separated_stem")
        # 목록에서 사라지지 않고, 사용자가 직접 고를 수 있다.
        t.user_selections[sr.emotion_key("minsu", "joy")] = self.ref_id(t, "near")
        self.assertEqual(t.resolve_with_emotion("minsu", "joy")["path"],
                         self.paths["near"])

    def test_invalid_quality_is_excluded_from_recommendation(self):
        t = self.table(candidate_meta=self.meta(
            near={"quality_state": sr.QUALITY_INVALID, "quality_codes": ["TOO_SHORT"]}))
        rec = t.recommended_candidate("minsu", "joy")
        self.assertNotEqual(rec["reference_id"], self.ref_id(t, "near"))
        rows = {c["reference_id"]: c for c in
                t.candidate_view("minsu", "joy")["candidates"]}
        bad = rows[self.ref_id(t, "near")]
        self.assertEqual(bad["excluded_reason"], sr.EXCLUDED_QUALITY_INVALID)
        self.assertEqual(bad["quality_codes"], ["TOO_SHORT"])

    def test_unmeasurable_candidate_is_excluded_with_its_own_reason(self):
        t = self.table(profile_of=lambda p: None if p == self.paths["near"]
                       else self.profiles.get(p))
        rows = {c["reference_id"]: c for c in
                t.candidate_view("minsu", "joy")["candidates"]}
        row = rows[self.ref_id(t, "near")]
        self.assertEqual(row["excluded_reason"], sr.EXCLUDED_NO_PROFILE)
        self.assertFalse(row["analyzable"])

    def test_every_exclusion_reason_is_a_known_token(self):
        t = self.table(candidate_meta=self.meta(
            near={"source_kind": "separated_stem"},
            mid={"quality_state": sr.QUALITY_INVALID}))
        for c in t.candidate_view("minsu", "joy")["candidates"]:
            if c["excluded_reason"] is not None:
                self.assertIn(c["excluded_reason"], sr.CANDIDATE_EXCLUSIONS)
            self.assertIn(c["quality_state"], sr.CANDIDATE_QUALITY_STATES)
            self.assertIn(c["source_kind"], ea.SOURCE_KINDS)


class SingleCandidateTest(Fixture):
    """후보가 하나뿐이면 최적이라 말하지 않는다."""

    def test_one_candidate_has_no_recommendation(self):
        t = self.table(speaker_refs={"minsu": self.paths["far"], "jieun": self.paths["other"]},
                       speaker_emotion_refs={})
        self.assertIsNone(t.recommended_candidate("minsu", "joy"))
        view = t.candidate_view("minsu", "joy")
        self.assertTrue(view["insufficient_candidates"])
        self.assertEqual(view["candidate_count"], 1)
        self.assertFalse(any(c["recommended"] for c in view["candidates"]))

    def test_several_candidates_are_not_flagged_insufficient(self):
        view = self.table().candidate_view("minsu", "joy")
        self.assertFalse(view["insufficient_candidates"])
        self.assertEqual(view["candidate_count"], 3)


class CandidateViewTest(Fixture):
    """화면이 그릴 값과 기록으로 나갈 값을 나눈다."""

    def test_view_shows_only_this_speakers_candidates(self):
        view = self.table().candidate_view("minsu", "joy")
        labels = {c["file_label"] for c in view["candidates"]}
        # 민수의 후보는 셋이다 — 기본 참조 + `calm` 전용 + `flat` 전용.
        self.assertEqual(labels, {"민수_밝게.wav", "민수_보통.wav", "민수_담담.wav"})
        self.assertNotIn("지은_기본.wav", labels)

    def test_file_label_has_no_folder(self):
        for c in self.table().candidate_view("minsu", "joy")["candidates"]:
            self.assertNotIn("/", c["file_label"])
            self.assertNotIn("\\", c["file_label"])

    def test_view_carries_the_display_facts_the_user_needs(self):
        t = self.table(candidate_meta={
            self.paths["near"]: {"duration_sec": 5.5, "source_kind": "clean_speech",
                                 "quality_state": sr.QUALITY_OK, "quality_codes": []},
        })
        rows = {c["reference_id"]: c for c in
                t.candidate_view("minsu", "joy")["candidates"]}
        near = rows[self.ref_id(t, "near")]
        self.assertEqual(near["duration_sec"], 5.5)
        self.assertEqual(near["source_kind"], "clean_speech")
        self.assertEqual(near["quality_state"], sr.QUALITY_OK)
        self.assertTrue(near["analyzable"])
        self.assertTrue(near["recommended"])
        self.assertTrue(near["selected"])
        # 미분석 후보는 unknown 으로 남는다 — 값을 지어내지 않는다.
        far = rows[self.ref_id(t, "far")]
        self.assertIsNone(far["duration_sec"])
        self.assertEqual(far["source_kind"], "unknown")
        self.assertEqual(far["quality_state"], sr.QUALITY_UNKNOWN)

    def test_internal_numbers_live_in_detail_only(self):
        rows = self.table().candidate_view("minsu", "joy")["candidates"]
        for c in rows:
            # 기본 칸에 점수·유사도가 없다.
            self.assertNotIn("score", c)
            self.assertNotIn("axis_scores", c)
            if c["analyzable"]:
                self.assertIsNotNone(c["detail"]["score"])
                self.assertTrue(c["detail"]["axis_scores"])

    def test_threshold_is_marked_provisional(self):
        view = self.table().candidate_view("minsu", "joy")
        self.assertTrue(view["threshold_provisional"])
        self.assertEqual(view["provisional_threshold"], sr.EMOTION_MATCH_MIN_SCORE)

    def test_selection_record_has_the_six_states(self):
        view = self.table().candidate_view("minsu", "joy")
        m = view["selection"]
        for key in ("recommended_reference", "user_selected_reference",
                    "resolved_reference", "selection_reason",
                    "provisional_threshold", "insufficient_candidates"):
            self.assertIn(key, m, key)
        self.assertEqual(m["selection_reason"], sr.REASON_AUTO_PROVISIONAL)
        self.assertIsNone(m["user_selected_reference"])

    def test_record_never_carries_file_names(self):
        """화면용 목록에는 파일 이름이 있지만 기록에는 없어야 한다."""
        view = self.table().candidate_view("minsu", "joy")
        blob = json.dumps(view["selection"], ensure_ascii=False)
        for leak in ("민수", "지은", ".wav", "/refs", "\\"):
            self.assertNotIn(leak, blob, "기록에 %s 가 샜다" % leak)

    def test_blocked_speaker_is_reported_not_crashed(self):
        t = self.table()
        view = t.candidate_view("nobody", "joy")
        self.assertEqual(view["blocked"], sr.SPEAKER_NOT_REGISTERED)
        self.assertIsNone(view["selection"])


class OriginalFilesUntouchedTest(unittest.TestCase):
    """선택을 바꾸는 것은 파일을 건드리는 일이 아니다 — 실파일로 확인한다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.files = []
        for name in ("a.wav", "b.wav"):
            p = os.path.join(self.tmp, name)
            with open(p, "wb") as f:
                f.write(b"RIFF" + os.urandom(4096))
            self.files.append(p)

    def _snapshot(self):
        out = {}
        for name in sorted(os.listdir(self.tmp)):
            p = os.path.join(self.tmp, name)
            with open(p, "rb") as f:
                out[name] = (os.path.getsize(p), hashlib.sha256(f.read()).hexdigest())
        return out

    def test_changing_the_selection_creates_and_modifies_nothing(self):
        before = self._snapshot()
        target = profile(0.20)
        profiles = {self.files[0]: profile(0.19), self.files[1]: profile(0.01)}
        t = sr.ReferenceTable(default_ref=self.files[0],
                              speaker_refs={"minsu": self.files[1]},
                              speaker_emotion_refs={
                                  sr.emotion_key("minsu", "calm"): self.files[0]},
                              profile_of=profiles.get,
                              target_profiles={"joy": target})
        first = t.resolve_with_emotion("minsu", "joy")["reference_id"]
        t.user_selections[sr.emotion_key("minsu", "joy")] = t.reference_id(self.files[1])
        second = t.resolve_with_emotion("minsu", "joy")["reference_id"]
        t.candidate_view("minsu", "joy")
        self.assertNotEqual(first, second, "선택이 실제로 바뀌어야 검사가 뜻이 있다")
        self.assertEqual(self._snapshot(), before,
                         "선택을 바꾸는 것이 원본을 수정·복사했다")

    def test_selection_keeps_only_ids_and_shas(self):
        target = profile(0.20)
        profiles = {self.files[0]: profile(0.19), self.files[1]: profile(0.01)}
        t = sr.ReferenceTable(default_ref=self.files[0],
                              speaker_refs={"minsu": self.files[1]},
                              speaker_emotion_refs={
                                  sr.emotion_key("minsu", "calm"): self.files[0]},
                              profile_of=profiles.get,
                              target_profiles={"joy": target})
        t.user_selections[sr.emotion_key("minsu", "joy")] = t.reference_id(self.files[0])
        row = t.resolve_with_emotion("minsu", "joy")
        self.assertEqual(len(row["reference_sha256"]), 64)
        blob = json.dumps(row["emotion_match"], ensure_ascii=False)
        self.assertNotIn(self.tmp.replace(os.sep, "/"), blob)
        self.assertNotIn(".wav", blob)


if __name__ == "__main__":
    unittest.main()
