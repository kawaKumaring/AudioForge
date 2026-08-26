# -*- coding: utf-8 -*-
"""표현형 v3 production 배선 계약 테스트 (Python, stdlib only).

tts_parity.py / separate.py 의 주석이 이름으로 지목하는 드리프트 가드가 바로 이 파일이다.
계약(expressive_timeline)·글루(tts_parity)·진입점(separate.py) 세 층이 같은 말을 하는지 고정한다.

검증 축:
  A. 키 단일 정본 — separate.py 가 읽는 리터럴 키 == EXPRESSIVE_MODE_FIELD (소스를 직접 읽어 대조)
  B. 모드 선택은 '명시 플래그'만 — 본문 내용은 절대 파서 버전을 고르지 않는다
  C. v2 하위호환 — 2-인자 verify_parity 는 오늘과 바이트 동일
  D. 불량 플래그는 크게 실패 — 조용한 v2 강등 금지
  E. v3 parity 는 우회가 아님 — expressive full_sha256 이 권위, 불일치는 전용 code
  F. 합성 경계 — v3 는 명확한 code 로 멈춘다(파서만 통과시키고 뒤에서 죽지 않는다)
  G. 강제 chunk boundary 금지 — 감정 태그/문장부호는 분할점이 아니다
  H. 비민감 payload — 오류에 대사 전문·경로가 실리지 않는다

⚠️ 실패 보고는 case id·필드명·code 만(대사 전문 로그 금지).
"""
import io
import os
import re
import unittest

import expressive_timeline as ex
import tts_grammar as tg
import tts_parity

HERE = os.path.dirname(os.path.abspath(__file__))
SEPARATE_SOURCE = os.path.join(HERE, "separate.py")

V3 = "expressive_v3"
L2 = "legacy_v2"

# 표현형 토큰을 모두 담은 입력 — '내용 기반 자동 승격이 없음'을 증명하는 데 쓴다.
# (v2 파서에도 유효해야 하므로 v2 가 모르는 [ㅋㅋ] 는 넣지 않는다.)
V3_LOOKING_TEXT = "다 끝났다!? 정말...... 그렇구나~ 마지막."


def _read_source(path):
    with io.open(path, encoding="utf-8") as f:
        return f.read()


class KeyDriftTest(unittest.TestCase):
    """A. 진입점이 읽는 키가 계약 필드에서 흘러가지 않았는가."""

    def test_a1_separate_reads_contract_field_literal(self):
        src = _read_source(SEPARATE_SOURCE)
        keys = re.findall(r'config\.get\(\s*"(ttsExpressive[A-Za-z0-9_]*)"', src)
        self.assertEqual(keys, [ex.EXPRESSIVE_MODE_FIELD],
                         "separate.py 는 계약 필드 하나만 읽어야 한다(별칭·오타 금지)")

    def test_a2_no_snake_case_alias_anywhere(self):
        # 계약 §10: snake_case 별칭(tts_expressive_mode)을 '저장 키'로 쓰지 않는다.
        # args 속성 이름은 argparse 관례라 허용 — config.get 의 문자열 키만 본다.
        src = _read_source(SEPARATE_SOURCE)
        self.assertNotIn('config.get("tts_expressive_mode"', src)
        self.assertNotIn("config.get('tts_expressive_mode'", src)

    def test_a3_parity_mode_constants_are_contract_members(self):
        # tts_parity 가 계약 집합 밖의 모드 문자열을 새로 만들어내지 않는지.
        self.assertIn(tts_parity.EXPRESSIVE_MODE_LEGACY_V2, ex.EXPRESSIVE_MODES)
        self.assertIn(tts_parity.EXPRESSIVE_MODE_V3, ex.EXPRESSIVE_MODES)
        self.assertEqual(tts_parity.EXPRESSIVE_MODE_LEGACY_V2, ex.EXPRESSIVE_DEFAULT_MODE)
        self.assertEqual(
            sorted({tts_parity.EXPRESSIVE_MODE_LEGACY_V2, tts_parity.EXPRESSIVE_MODE_V3}),
            sorted(ex.EXPRESSIVE_MODES),
            "모드가 계약에 추가되면 글루도 같이 갱신되어야 한다")

    def test_a4_wiring_boundary_code_is_not_in_contract_enum(self):
        # 배선 경계 코드는 계약 v3 enum 을 늘리지 않는다(CONTRACT_VERSION 의미 보존).
        self.assertNotIn(tts_parity.EXPRESSIVE_V3_SYNTHESIS_UNSUPPORTED, ex.EXPRESSIVE_ERROR_CODES)
        # 반대로 재사용하는 코드들은 계약 enum 안에 이미 있어야 한다(새로 만들지 않았음).
        self.assertIn(tts_parity.EXPRESSIVE_PARITY_MISMATCH, ex.EXPRESSIVE_ERROR_CODES)
        self.assertIn(tts_parity.EXPRESSIVE_MODE_INVALID, ex.EXPRESSIVE_ERROR_CODES)


class ExplicitFlagOnlyTest(unittest.TestCase):
    """B. 모드는 플래그만이 고른다 — 본문은 절대 아니다."""

    def test_b1_v3_looking_text_without_flag_uses_v2(self):
        # 플래그 없이 v3 토큰이 가득한 본문을 줘도 parity 권위는 v2 해시다.
        v2_hash = tg.parse_tts_script(V3_LOOKING_TEXT)["plan"]["full_sha256"]
        self.assertEqual(tts_parity.verify_parity(V3_LOOKING_TEXT, v2_hash), [])
        self.assertFalse(tts_parity.uses_expressive_v3(None))
        self.assertEqual(tts_parity.parity_mode(None), L2)

    def test_b2_v3_looking_text_without_flag_rejects_v3_hash(self):
        # 같은 본문의 v3 해시를 들이밀어도 플래그가 없으면 통과하지 못한다(승격 없음).
        v3_hash = ex.parse_expressive_timeline(V3_LOOKING_TEXT, V3)["timeline"]["full_sha256"]
        errs = tts_parity.verify_parity(V3_LOOKING_TEXT, v3_hash)
        self.assertEqual([e["code"] for e in errs], [tts_parity.PARSER_PARITY_MISMATCH])

    def test_b3_explicit_legacy_v2_is_identical_to_absent(self):
        v2_hash = tg.parse_tts_script(V3_LOOKING_TEXT)["plan"]["full_sha256"]
        self.assertEqual(tts_parity.verify_parity(V3_LOOKING_TEXT, v2_hash, L2), [])
        self.assertFalse(tts_parity.uses_expressive_v3(L2))

    def test_b4_explicit_v3_switches_authority(self):
        self.assertTrue(tts_parity.uses_expressive_v3(V3))
        self.assertEqual(tts_parity.parity_mode(V3), V3)
        v3_hash = ex.parse_expressive_timeline(V3_LOOKING_TEXT, V3)["timeline"]["full_sha256"]
        self.assertEqual(tts_parity.verify_parity(V3_LOOKING_TEXT, v3_hash, V3), [])

    def test_b5_two_authorities_are_actually_different(self):
        # 위 두 테스트가 '같은 해시라서' 우연히 통과하는 게 아님을 보증한다.
        v2_hash = tg.parse_tts_script(V3_LOOKING_TEXT)["plan"]["full_sha256"]
        v3_hash = ex.parse_expressive_timeline(V3_LOOKING_TEXT, V3)["timeline"]["full_sha256"]
        self.assertNotEqual(v2_hash, v3_hash)


class LegacyCompatTest(unittest.TestCase):
    """C. 기존 2-인자 호출자는 오늘과 완전히 동일해야 한다."""

    def test_c1_two_arg_call_signature_still_works(self):
        raw = "[기쁨] 안녕하세요. [명랑] 오늘 날씨가 좋아요."
        h = tg.parse_tts_script(raw)["plan"]["full_sha256"]
        self.assertEqual(tts_parity.verify_parity(raw, h), [])
        self.assertEqual(tts_parity.verify_parity(raw, h, None), [])

    def test_c2_v2_parse_errors_unchanged(self):
        for raw, code in (
            ("[명란] 문장", "UNKNOWN_TTS_TAG"),
            ("A [쉼 9.0] B", "INVALID_PAUSE_TAG"),
            ("[기쁨]\n[슬픔] 안녕", "EMPTY_EMOTION_SEGMENT"),
        ):
            errs = tts_parity.verify_parity(raw, "")
            self.assertTrue(errs, code)
            self.assertEqual(errs[0]["code"], code)

    def test_c3_v3_layer_does_not_touch_v2_plan_version(self):
        # 계약 불변식: v3 레이어는 v2 plan 버전을 건드리지 않는다.
        self.assertEqual(ex.EXPRESSIVE_LEGACY_PLAN_VERSION, 2)
        self.assertEqual(tg.TTS_PARSER_VERSION, 2)
        self.assertEqual(ex.EXPRESSIVE_MODE_TO_VERSION[L2], 2)
        self.assertEqual(ex.EXPRESSIVE_MODE_TO_VERSION[V3], 3)


class InvalidFlagIsLoudTest(unittest.TestCase):
    """D. 값이 있는데 계약 밖 → 조용한 v2 강등 금지."""

    BAD_VALUES = ("", "v3", "V3", "expressive", "expressive_V3", "legacy", True, False, 3, 3.0, {}, [])

    def test_d1_invalid_flag_blocks_before_model(self):
        raw = "안녕하세요."
        h = tg.parse_tts_script(raw)["plan"]["full_sha256"]
        for bad in self.BAD_VALUES:
            errs = tts_parity.verify_parity(raw, h, bad)
            self.assertEqual([e["code"] for e in errs], [tts_parity.EXPRESSIVE_MODE_INVALID],
                             "%r 는 조용히 통과하면 안 된다" % (type(bad).__name__,))

    def test_d2_invalid_flag_never_promotes_to_v3(self):
        # 폴백 '값' 은 여전히 legacy_v2 — validity 를 무시한 코드가 있어도 v3 로 새지 않는다.
        for bad in self.BAD_VALUES:
            self.assertEqual(tts_parity.parity_mode(bad), L2)
            self.assertFalse(tts_parity.uses_expressive_v3(bad))

    def test_d3_resolution_helper_exposes_validity(self):
        absent = tts_parity.resolve_parity_mode(None)
        self.assertTrue(absent["valid"])
        self.assertEqual(absent["source"], "absent")
        self.assertEqual(absent["mode"], L2)

        good = tts_parity.resolve_parity_mode(V3)
        self.assertTrue(good["valid"])
        self.assertEqual(good["source"], "explicit")
        self.assertEqual(good["mode"], V3)

        bad = tts_parity.resolve_parity_mode("expressive_V3")
        self.assertFalse(bad["valid"])
        self.assertEqual(bad["source"], "invalid")
        self.assertEqual(bad["error_code"], "EXPRESSIVE_MODE_INVALID")
        self.assertEqual(bad["mode"], L2)

    def test_d4_validity_is_checked_before_parsing(self):
        # 본문이 v2 파싱 오류를 내더라도, 플래그 불량이 먼저 보고돼야 한다
        # (v3 요청이 v2 파서의 오류 메시지로 둔갑하면 사용자가 원인을 못 찾는다).
        errs = tts_parity.verify_parity("[명란] 오타", "", "expressive_V3")
        self.assertEqual([e["code"] for e in errs], [tts_parity.EXPRESSIVE_MODE_INVALID])


class ExpressiveParityIsNotABypassTest(unittest.TestCase):
    """E. v3 도 똑같이 크게 실패한다."""

    def test_e1_v3_hash_mismatch_uses_distinct_code(self):
        errs = tts_parity.verify_parity(V3_LOOKING_TEXT, "deadbeef" * 8, V3)
        self.assertEqual([e["code"] for e in errs], [tts_parity.EXPRESSIVE_PARITY_MISMATCH])
        self.assertEqual(errs[0]["mode"], V3)
        # v2 코드와 반드시 구분된다(호출자가 어느 층이 틀렸는지 알아야 한다).
        self.assertNotEqual(tts_parity.EXPRESSIVE_PARITY_MISMATCH, tts_parity.PARSER_PARITY_MISMATCH)

    def test_e2_v3_parse_errors_propagate_structured(self):
        for raw, code in (
            ("[명란] 오타", "UNKNOWN_EXPRESSIVE_TAG"),
            ("[ㅋㅎ]", "AMBIGUOUS_LAUGH_TOKEN"),
            ("[기쁨|살짝] 안녕", "INVALID_EMOTION_MODIFIER"),
            ("A [쉼 9.0] B", "INVALID_EXPRESSIVE_PAUSE"),
        ):
            errs = tts_parity.verify_parity(raw, "", V3)
            self.assertTrue(errs, code)
            self.assertEqual(errs[0]["code"], code)
            self.assertIn(errs[0]["code"], ex.EXPRESSIVE_ERROR_CODES)

    def test_e3_empty_expected_does_not_skip_validation(self):
        # expected 미제공은 parity 미강제일 뿐, 파싱 유효성은 여전히 강제된다(우회 아님).
        self.assertEqual(tts_parity.verify_parity(V3_LOOKING_TEXT, "", V3), [])
        self.assertTrue(tts_parity.verify_parity("[명란] 오타", "", V3))

    def test_e4_one_char_diff_blocks_in_v3_too(self):
        h = ex.parse_expressive_timeline("안녕하세요.", V3)["timeline"]["full_sha256"]
        errs = tts_parity.verify_parity("안녕하세요!", h, V3)
        self.assertEqual([e["code"] for e in errs], [tts_parity.EXPRESSIVE_PARITY_MISMATCH])


class SynthesisBoundaryTest(unittest.TestCase):
    """F. v3 는 '검증까지'만 — 합성 경로로 새지 않는다."""

    def test_f1_separate_blocks_v3_before_model_load(self):
        src = _read_source(SEPARATE_SOURCE)
        gate = src.index("EXPRESSIVE_V3_SYNTHESIS_UNSUPPORTED")
        loader = src.index("from tts_worker import synthesize")
        self.assertLess(gate, loader,
                        "v3 차단은 tts_worker(모델 로딩) import 앞에 있어야 한다")

    def test_f2_gate_compares_against_legacy_constant(self):
        # 게이트가 리터럴 'legacy_v2' 로 흘러가지 않았는지(계약 상수 참조 유지).
        src = _read_source(SEPARATE_SOURCE)
        self.assertIn("_tp.EXPRESSIVE_MODE_LEGACY_V2", src)

    def test_f3_synthesis_path_still_reparses_with_v2_grammar(self):
        # 이 사실이 f1 게이트의 존재 이유다. 여기가 바뀌면(= v3 소비 가능) 게이트를 재검토해야 한다.
        worker = _read_source(os.path.join(HERE, "tts_worker.py"))
        self.assertIn("_tg.parse_tts_script(text)", worker)
        self.assertNotIn("parse_expressive_timeline", worker)


class NoForcedChunkBoundaryTest(unittest.TestCase):
    """G. 감정 태그·문장부호는 강제 분할점이 아니다."""

    def test_g1_emotion_transition_is_not_chunk_boundary(self):
        self.assertFalse(ex.EMOTION_TRANSITION_IS_CHUNK_BOUNDARY)
        t = ex.parse_expressive_timeline("[기쁨] 안녕 [슬픔] 잘가", V3)["timeline"]
        self.assertTrue(t["emotion_transitions"], "감정 전이가 실제로 잡혀야 의미 있는 검사")
        for e in t["emotion_transitions"]:
            self.assertFalse(e["is_chunk_boundary"], "감정 태그는 강제 분할점이 아니다")

    def test_g2_punctuation_prosody_is_not_chunk_boundary(self):
        self.assertFalse(ex.LOCAL_PROSODY_IS_CHUNK_BOUNDARY)
        t = ex.parse_expressive_timeline("정말...... 그렇구나~ 끝!?", V3)["timeline"]
        self.assertTrue(t["local_prosody"], "국소 운율이 실제로 잡혀야 의미 있는 검사")
        for lp in t["local_prosody"]:
            self.assertFalse(lp["is_chunk_boundary"], "문장부호는 강제 분할점이 아니다")


class NonSensitivePayloadTest(unittest.TestCase):
    """H. 오류 payload 에 대사 전문·경로가 실리지 않는다."""

    SENSITIVE = ("spoken_text", "text", "path", "abspath", "transcript", "message",
                 "raw", "value", "script")

    def test_h1_all_wiring_error_paths_are_non_sensitive(self):
        cases = [
            (V3_LOOKING_TEXT, "deadbeef" * 8, V3),      # EXPRESSIVE_PARITY_MISMATCH
            ("[명란] 오타", "", V3),                     # UNKNOWN_EXPRESSIVE_TAG
            ("[ㅋㅎ]", "", V3),                          # AMBIGUOUS_LAUGH_TOKEN
            ("안녕하세요.", "", "expressive_V3"),         # EXPRESSIVE_MODE_INVALID
            ("안녕하세요.", "deadbeef" * 8, None),        # PARSER_PARITY_MISMATCH
        ]
        for raw, expected, mode in cases:
            errs = tts_parity.verify_parity(raw, expected, mode)
            self.assertTrue(errs, "오류 기대")
            for e in errs:
                self.assertIsInstance(e.get("code"), str)
                for k in self.SENSITIVE:
                    self.assertNotIn(k, e, "비민감 payload(전문/경로 금지): %s" % e.get("code"))

    def test_h2_invalid_flag_payload_carries_type_not_value(self):
        errs = tts_parity.verify_parity("안녕.", "", "expressive_V3")
        self.assertEqual(errs[0]["raw_type"], "string")
        self.assertNotIn("expressive_V3", repr(errs[0]), "플래그 원시값을 그대로 싣지 않는다")


if __name__ == "__main__":
    unittest.main()
