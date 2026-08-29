# -*- coding: utf-8 -*-
"""expressive_capability.py 단위 테스트 — 모델/GPU/오디오 없음, 순수 계약.

핵심 축:
  A. 선언(claim)만으로는 절대 supported 가 되지 않는다(가짜 성공 차단선)
  B. 프로브 증거 → 상태 매핑(미시도=unknown / 거부=unsupported / 무시=degraded / 확인=supported)
  C. 선언은 상한으로만 작동한다
  D. 구두점 상위 스위치가 개별 종류를 덮는다
  E. '~' 3분류 소비 + 최종 판정은 여기(ENGINE) 소유
  F. 직렬화 레코드는 짧은 토큰만
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import expressive_capability as cap
import expressive_timeline as ex


def probe(feature, attempted=True, accepted=True, honored=True):
    return cap.ProbeEvidence(feature, attempted, accepted, honored)


def full_profile(engine_id="full", features=None, prosody=True):
    features = features or cap.CAPABILITY_FEATURES
    return cap.build_profile(
        engine_id,
        claims={f: "supported" for f in features},
        evidence={f: probe(f) for f in features},
        prosody_claims=({k: "supported" for k in ex.LOCAL_PROSODY_KINDS} if prosody else None),
        prosody_evidence=({k: probe(k) for k in ex.LOCAL_PROSODY_KINDS} if prosody else None))


# ────────────────────────── A. 가짜 성공 차단 ──────────────────────────

class TestNoFalseSuccess(unittest.TestCase):

    def test_unknown_profile_reports_everything_unverified(self):
        p = cap.unknown_profile("no_engine")
        self.assertEqual(set(p.unverified_features()), set(cap.CAPABILITY_FEATURES))
        for f in cap.CAPABILITY_FEATURES:
            self.assertEqual(p.state_of(f), cap.UNVERIFIED_STATE, f)
            self.assertFalse(p.is_supported(f), f)

    def test_claim_alone_never_becomes_supported(self):
        p = cap.build_profile("claimy", claims={f: "supported" for f in cap.CAPABILITY_FEATURES})
        for f in cap.CAPABILITY_FEATURES:
            self.assertEqual(p.state_of(f), cap.UNVERIFIED_STATE, f)
            self.assertFalse(p.features[f]["verified"], f)
            self.assertEqual(p.features[f]["reason"], "probe_absent", f)

    def test_reporting_unverified_capability_as_success_raises(self):
        p = cap.unknown_profile("e")
        with self.assertRaises(cap.CapabilityHonestyError):
            cap.assert_no_false_success(p, ["continuous_emotion_weights"])

    def test_reporting_degraded_or_unsupported_as_success_raises(self):
        deg = cap.build_profile("d", evidence={"emotion_instruction_text":
                                               probe("emotion_instruction_text", honored=False)})
        with self.assertRaises(cap.CapabilityHonestyError):
            cap.assert_no_false_success(deg, ["emotion_instruction_text"])
        uns = cap.build_profile("u", evidence={"emotion_instruction_text":
                                               probe("emotion_instruction_text", accepted=False)})
        with self.assertRaises(cap.CapabilityHonestyError):
            cap.assert_no_false_success(uns, ["emotion_instruction_text"])

    def test_actual_supported_passes_the_honesty_gate(self):
        p = full_profile()
        cap.assert_no_false_success(p, list(cap.CAPABILITY_FEATURES))

    def test_is_usable_is_true_only_for_supported(self):
        self.assertTrue(cap.is_usable("supported"))
        for state in ("degraded", "unsupported", cap.UNVERIFIED_STATE):
            self.assertFalse(cap.is_usable(state), state)


# ────────────────────────── B. 프로브 → 상태 ──────────────────────────

class TestProbeMapping(unittest.TestCase):

    def test_not_attempted_is_unknown(self):
        self.assertEqual(cap.evidence_state(None), cap.UNVERIFIED_STATE)
        self.assertEqual(cap.evidence_state(probe("deterministic_seed", attempted=False)),
                         cap.UNVERIFIED_STATE)

    def test_rejected_is_unsupported(self):
        self.assertEqual(cap.evidence_state(probe("deterministic_seed", accepted=False)),
                         "unsupported")

    def test_accepted_but_ignored_is_degraded_not_success(self):
        st = cap.evidence_state(probe("continuous_emotion_weights", accepted=True, honored=False))
        self.assertEqual(st, "degraded")
        self.assertNotEqual(st, "supported")

    def test_confirmed_is_supported(self):
        self.assertEqual(cap.evidence_state(probe("continuous_emotion_weights")), "supported")

    def test_probe_target_must_be_known(self):
        with self.assertRaises(cap.CapabilityContractError):
            cap.ProbeEvidence("no_such_feature", True, True, True)

    def test_prosody_kind_is_a_valid_probe_target(self):
        for kind in ex.LOCAL_PROSODY_KINDS:
            self.assertEqual(cap.evidence_state(probe(kind)), "supported")


# ────────────────────────── C. 선언은 상한 ──────────────────────────

class TestClaimIsUpperBound(unittest.TestCase):

    def test_declared_unsupported_wins_over_positive_evidence(self):
        rec = cap.resolve_feature("deterministic_seed", "unsupported", probe("deterministic_seed"))
        self.assertEqual(rec["state"], "unsupported")
        self.assertEqual(rec["reason"], "engine_declared_unsupported")

    def test_claim_lower_than_evidence_caps_the_result(self):
        rec = cap.resolve_feature("continuous_emotion_weights", "degraded",
                                  probe("continuous_emotion_weights"))
        self.assertEqual(rec["state"], "degraded")
        self.assertEqual(rec["reason"], "claim_caps_evidence")

    def test_claim_higher_than_evidence_does_not_raise_the_result(self):
        rec = cap.resolve_feature("continuous_emotion_weights", "supported",
                                  probe("continuous_emotion_weights", honored=False))
        self.assertEqual(rec["state"], "degraded")
        self.assertEqual(rec["reason"], "probe_not_honored")

    def test_unknown_state_value_is_rejected(self):
        with self.assertRaises(cap.CapabilityContractError):
            cap.resolve_feature("deterministic_seed", "probably", None)

    def test_unknown_feature_name_is_rejected(self):
        with self.assertRaises(cap.CapabilityContractError):
            cap.build_profile("e", claims={"teleportation": "supported"})


# ────────────────────────── D. 구두점 상위 스위치 ──────────────────────────

class TestPunctuationUmbrella(unittest.TestCase):

    def test_prosody_kind_cannot_exceed_umbrella_state(self):
        p = cap.build_profile(
            "e",
            prosody_claims={k: "supported" for k in ex.LOCAL_PROSODY_KINDS},
            prosody_evidence={k: probe(k) for k in ex.LOCAL_PROSODY_KINDS})
        # punctuation_native_instruction 은 프로브가 없어 unknown → 개별 종류도 올라갈 수 없다.
        self.assertEqual(p.state_of("punctuation_native_instruction"), cap.UNVERIFIED_STATE)
        for kind in ex.LOCAL_PROSODY_KINDS:
            self.assertEqual(p.prosody_state(kind), cap.UNVERIFIED_STATE, kind)
            self.assertFalse(p.prosody_is_native(kind), kind)

    def test_umbrella_supported_lets_probed_kinds_be_native(self):
        p = full_profile()
        for kind in ex.LOCAL_PROSODY_KINDS:
            self.assertTrue(p.prosody_is_native(kind), kind)

    def test_unprobed_kind_stays_unverified_even_under_supported_umbrella(self):
        p = cap.build_profile(
            "e",
            claims={"punctuation_native_instruction": "supported"},
            evidence={"punctuation_native_instruction": probe("punctuation_native_instruction")},
            prosody_evidence={"emphasis": probe("emphasis")})
        self.assertTrue(p.prosody_is_native("emphasis"))
        self.assertEqual(p.prosody_state("firm_end"), cap.UNVERIFIED_STATE)
        self.assertIn("firm_end", p.unverified_prosody_kinds())


# ────────────────────────── E. '~' 3분류 소비 + 엔진 판정 ──────────────────────────

class TestVowelExtendVerdict(unittest.TestCase):

    def test_contract_classification_is_consumed_verbatim(self):
        for cls in cap.VOWEL_EXTEND_CLASSES:
            got = cap.classify_vowel_extend({"classification": cls})
            self.assertEqual(got["classification"], cls)
            self.assertEqual(got["source"], "contract_classification")

    def test_legacy_contract_fields_are_transferred_not_rederived(self):
        # 구 계약이 supported=True 라고 결론냈으면 그것이 곧 열린 모음이다.
        got = cap.classify_vowel_extend({"supported": True, "target_vowel": "ㅗ",
                                         "degraded_reason": None})
        self.assertEqual(got["classification"], "open_vowel")
        self.assertEqual(got["source"], "contract_legacy_supported")

        # 구 계약은 ㅇ/ㄴ/ㅁ/ㄹ 과 그 외 받침을 구분하지 않는다 → 추측 금지.
        got = cap.classify_vowel_extend({"supported": False, "degraded_reason": "final_consonant"})
        self.assertEqual(got["classification"], "final_consonant_unclassified")

        for reason in ("no_preceding_text", "no_preceding_vowel", "unsupported_script"):
            got = cap.classify_vowel_extend({"supported": False, "degraded_reason": reason})
            self.assertEqual(got["classification"], "no_target", reason)

    def test_missing_record_is_no_target(self):
        self.assertEqual(cap.classify_vowel_extend(None)["classification"], "no_target")

    def test_open_vowel_follows_engine_state(self):
        native = full_profile()
        v = cap.resolve_vowel_extend_capability({"classification": "open_vowel"}, native)
        self.assertEqual(v["state"], "supported")
        self.assertFalse(v["allowed_post_process"])   # 네이티브면 후처리가 필요 없다

        blind = cap.unknown_profile("e")
        v = cap.resolve_vowel_extend_capability({"classification": "open_vowel"}, blind)
        self.assertEqual(v["state"], cap.UNVERIFIED_STATE)
        self.assertTrue(v["allowed_post_process"])    # 모음 한정 늘임만 허용

    def test_sustainable_final_never_claims_natural_extension(self):
        native = full_profile()   # vowel_extend_sustainable_final 까지 프로브된 프로필
        v = cap.resolve_vowel_extend_capability({"classification": "sustainable_final"}, native)
        self.assertEqual(v["reason"], "SUSTAINABLE_FINAL_UNVERIFIED")
        self.assertFalse(v["natural_extension_claimed"])
        self.assertFalse(v["allowed_post_process"])   # 받침은 어떤 후처리도 열지 않는다
        self.assertFalse(v["final_consonant_repeat_allowed"])

    def test_sustainable_final_without_its_own_probe_stays_unverified(self):
        # 구두점 전반은 지원되지만 받침 늘임 전용 프로브가 없는 엔진.
        feats = tuple(f for f in cap.CAPABILITY_FEATURES if f != "vowel_extend_sustainable_final")
        p = full_profile("partial", features=feats)
        self.assertEqual(p.state_of("vowel_extend_sustainable_final"), cap.UNVERIFIED_STATE)
        v = cap.resolve_vowel_extend_capability({"classification": "sustainable_final"}, p)
        self.assertEqual(v["state"], cap.UNVERIFIED_STATE)

    def test_non_sustainable_final_is_degraded(self):
        p = full_profile()
        v = cap.resolve_vowel_extend_capability({"classification": "non_sustainable_final"}, p)
        self.assertEqual(v["state"], "degraded")
        self.assertEqual(v["reason"], "NON_SUSTAINABLE_FINAL_DEGRADED")
        self.assertFalse(v["allowed_post_process"])

    def test_unclassified_final_consonant_is_unverified_not_guessed(self):
        p = full_profile()
        v = cap.resolve_vowel_extend_capability(
            {"supported": False, "degraded_reason": "final_consonant"}, p)
        self.assertEqual(v["state"], cap.UNVERIFIED_STATE)
        self.assertEqual(v["reason"], "CLASSIFICATION_UNAVAILABLE")
        self.assertFalse(v["allowed_post_process"])

    def test_no_target_is_unsupported(self):
        p = full_profile()
        v = cap.resolve_vowel_extend_capability(
            {"supported": False, "degraded_reason": "no_preceding_text"}, p)
        self.assertEqual(v["state"], "unsupported")
        self.assertEqual(v["reason"], "NO_TARGET")

    def test_final_consonant_repeat_is_never_allowed_in_any_verdict(self):
        p = full_profile()
        for record in ({"classification": "open_vowel"},
                       {"classification": "sustainable_final"},
                       {"classification": "non_sustainable_final"},
                       {"supported": False, "degraded_reason": "final_consonant"},
                       None):
            v = cap.resolve_vowel_extend_capability(record, p)
            self.assertFalse(v["final_consonant_repeat_allowed"], str(record))
            self.assertFalse(v["natural_extension_claimed"], str(record))


# ────────────────────────── F. 직렬화 ──────────────────────────

class TestSerialization(unittest.TestCase):

    def test_record_contains_only_contract_tokens(self):
        rec = cap.profile_to_record(cap.unknown_profile("e1"))
        self.assertEqual(rec["engine_id"], "e1")
        self.assertEqual(set(rec["features"].keys()), set(cap.CAPABILITY_FEATURES))
        for state in rec["features"].values():
            self.assertIn(state, cap.CAPABILITY_STATES)
        for reason in rec["feature_reasons"].values():
            self.assertIn(reason, cap.CAPABILITY_RESOLUTION_REASONS)
        for state in rec["prosody_kinds"].values():
            self.assertIn(state, cap.CAPABILITY_STATES)

    def test_record_lists_unverified_capabilities_explicitly(self):
        rec = cap.profile_to_record(cap.unknown_profile("e"))
        self.assertEqual(set(rec["unverified_features"]), set(cap.CAPABILITY_FEATURES))
        self.assertEqual(set(rec["unverified_prosody_kinds"]), set(ex.LOCAL_PROSODY_KINDS))
        self.assertFalse(any(rec["feature_verified"].values()))

    def test_prosody_kinds_mirror_the_contract_enum(self):
        # 계약의 enum 을 복사하지 않고 import 해 쓰는지 확인(드리프트 가드).
        self.assertEqual(tuple(cap.profile_to_record(cap.unknown_profile("e"))["prosody_kinds"].keys()),
                         ex.LOCAL_PROSODY_KINDS)


if __name__ == "__main__":
    unittest.main()
