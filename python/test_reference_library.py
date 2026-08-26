# -*- coding: utf-8 -*-
"""reference_library 단위 테스트(순수, stdlib only — 실제 미디어/모델/GPU 불필요).

검증 범위: 지문 결정성 / 무효화 사유 4종 독립 / 대본·속도·감정 변경 시 재사용 유지 /
겹침 규칙(끝점 맞닿음 경계 포함) / 선택은 다음 탐색에서 제외 / 단일 참조 가드 /
위생(경로·전사 원문 유출 금지) / TS 소스 파싱 parity.

고정 벡터는 src/shared/referenceLibrary.test.ts 와 같은 리터럴이다 → TS == Python transitively.
"""
import os
import re
import unittest

import reference_library as rl

SRC_A = "a" * 64
SRC_B = "b" * 64
TRANSCRIPT = "  안녕하세요 참조 전사입니다.  "

PINNED_PAYLOAD = (
    "reflib-fp/1\n"
    "analysis_version=1\n"
    "source_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
    "region_start_ms=1250\n"
    "region_duration_ms=7000\n"
    "transcript_sha256=87f80df86af86d7d0a052dfd58a942906e1fac0ce3b80b55d98e15c771cbf5ea"
)
PINNED_FINGERPRINT = "07e37b46741436efa866612ef925f853e13a44fa7994f89c21ae086b30368111"
PINNED_FINGERPRINT_EMPTY_TX = "b93c26b498a82c65852d24d3989bd792fc110ad0f53ffda56c2d0c3faa00d8c5"
PINNED_CLIP_ID = "abb0ff174ab6e56c"

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TS_MODULE = os.path.join(REPO_ROOT, "src", "shared", "referenceLibrary.ts")


def base(**over):
    req = {"source_sha256": SRC_A, "region": {"start": 1.25, "duration": 7.0}, "transcript": TRANSCRIPT}
    req.update(over)
    return req


# ─────────────────────────────────────────────────────────────────────────────
# 1) 지문
# ─────────────────────────────────────────────────────────────────────────────
class FingerprintTest(unittest.TestCase):
    def test_canonical_payload_pinned(self):
        self.assertEqual(rl.build_fingerprint_payload(SRC_A, 1.25, 7.0, TRANSCRIPT), PINNED_PAYLOAD)
        self.assertEqual(rl.compute_fingerprint(SRC_A, 1.25, 7.0, TRANSCRIPT), PINNED_FINGERPRINT)
        self.assertEqual(rl.compute_fingerprint(SRC_A, 0.0, 3.0, ""), PINNED_FINGERPRINT_EMPTY_TX)
        self.assertEqual(rl.derive_clip_id(SRC_A, 1.25, 7.0), PINNED_CLIP_ID)
        self.assertEqual(len(PINNED_CLIP_ID), rl.CLIP_ID_LENGTH)

    def test_deterministic_across_calls(self):
        vals = {rl.compute_fingerprint_from_request(base()) for _ in range(5)}
        self.assertEqual(vals, {PINNED_FINGERPRINT})
        self.assertRegex(PINNED_FINGERPRINT, r"^[0-9a-f]{64}$")

    def test_field_order_is_the_contract(self):
        lines = PINNED_PAYLOAD.split(rl.FINGERPRINT_FIELD_SEPARATOR)
        self.assertEqual(lines[0], rl.FINGERPRINT_PAYLOAD_HEADER)
        self.assertEqual([ln.split("=", 1)[0] for ln in lines[1:]], list(rl.FINGERPRINT_FIELD_ORDER))
        self.assertFalse(PINNED_PAYLOAD.endswith("\n"), "끝 개행 없음")

    def test_transcript_normalization(self):
        self.assertEqual(rl.normalize_transcript("\t\n\r\f\v 가운데  공백 \v\f\r\n\t"), "가운데  공백")
        self.assertEqual(rl.normalize_transcript(None), "")
        # 양끝 공백만 다른 전사는 같은 지문
        self.assertEqual(rl.compute_fingerprint(SRC_A, 1.25, 7.0, "안녕하세요 참조 전사입니다."),
                         PINNED_FINGERPRINT)

    def test_seconds_to_ms_rounding(self):
        self.assertEqual(rl.seconds_to_ms(0), 0)
        self.assertEqual(rl.seconds_to_ms(1.2345), 1235)
        self.assertEqual(rl.seconds_to_ms(1.2344), 1234)
        self.assertEqual(rl.seconds_to_ms(0.0005), 1)
        with self.assertRaises(rl.ReferenceLibraryError) as cm:
            rl.seconds_to_ms(-0.1)
        self.assertEqual(cm.exception.code, rl.INVALID_FINGERPRINT_INPUT)

    def test_source_sha_format_enforced(self):
        with self.assertRaises(rl.ReferenceLibraryError) as cm:
            rl.compute_fingerprint("nope", 1.25, 7.0, TRANSCRIPT)
        self.assertEqual(cm.exception.code, rl.INVALID_FINGERPRINT_INPUT)
        self.assertEqual(rl.compute_fingerprint(SRC_A.upper(), 1.25, 7.0, TRANSCRIPT), PINNED_FINGERPRINT)

    def test_source_hash_uses_injected_reader(self):
        # 실제 파일 없이 계산 — 테스트가 사용자 미디어를 요구하지 않는다.
        self.assertEqual(rl.sha256_hex_of_source("no/such/file", reader=lambda p: [b"ab", b"c"]),
                         "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        self.assertEqual(rl.sha256_hex_of_source("no/such/file", reader=lambda p: b""),
                         "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        with self.assertRaises(rl.ReferenceLibraryError) as cm:
            rl.sha256_hex_of_source("x", reader=lambda p: ["문자열은 안 됨"])
        self.assertEqual(cm.exception.code, rl.INVALID_FINGERPRINT_INPUT)

    def test_source_hash_matches_real_file_bytes(self):
        # 기본 reader 경로(파일 읽기 전용). 사용자 미디어가 아니라 테스트가 만든 임시 바이트다.
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "tiny.bin")
            with open(p, "wb") as f:
                f.write(b"abc")
            before = os.stat(p)
            digest = rl.sha256_hex_of_source(p)
            after = os.stat(p)
            self.assertEqual(digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
            # 원본 미변경(크기·수정시각 동일)
            self.assertEqual((before.st_size, before.st_mtime_ns), (after.st_size, after.st_mtime_ns))


# ─────────────────────────────────────────────────────────────────────────────
# 2) 재사용 / 3) 무효화
# ─────────────────────────────────────────────────────────────────────────────
class ReuseTest(unittest.TestCase):
    def test_script_speed_emotion_pitch_never_invalidate(self):
        v = rl.evaluate_reuse(base(), base(script="[기쁨] 완전히 다른 대본", speed=1.6,
                                          emotion_id="sad", pitch=-2))
        self.assertTrue(v["reusable"])
        self.assertEqual(v["reasons"], [])
        self.assertEqual(v["fingerprint"], v["stored_fingerprint"])
        self.assertEqual(v["fingerprint"], PINNED_FINGERPRINT)
        for axis in rl.VOLATILE_AXES:
            self.assertEqual(rl.compute_fingerprint_from_request(base(**{axis: "X"})),
                             PINNED_FINGERPRINT, "%s 는 지문 입력이 아니다" % axis)

    def test_source_changed(self):
        v = rl.evaluate_reuse(base(), base(source_sha256=SRC_B))
        self.assertEqual(v["reasons"], [rl.REF_SOURCE_CHANGED])
        self.assertFalse(v["reusable"])
        self.assertNotEqual(v["fingerprint"], v["stored_fingerprint"])

    def test_region_changed(self):
        self.assertEqual(rl.evaluate_reuse(base(), base(region={"start": 1.5, "duration": 7.0}))["reasons"],
                         [rl.REF_REGION_CHANGED])
        self.assertEqual(rl.evaluate_reuse(base(), base(region={"start": 1.25, "duration": 6.0}))["reasons"],
                         [rl.REF_REGION_CHANGED])
        # 1ms 미만 차이는 같은 ms 로 접혀 무효화하지 않는다
        self.assertEqual(rl.evaluate_reuse(base(), base(region={"start": 1.25004, "duration": 7.0}))["reasons"], [])

    def test_transcript_changed(self):
        v = rl.evaluate_reuse(base(), base(transcript="다른 전사문입니다."))
        self.assertEqual(v["reasons"], [rl.REF_TRANSCRIPT_CHANGED])
        self.assertFalse(v["reusable"])

    def test_analysis_version_changed(self):
        v = rl.evaluate_reuse(base(), base(analysis_version=rl.REFERENCE_ANALYSIS_VERSION + 1))
        self.assertEqual(v["reasons"], [rl.REF_ANALYSIS_VERSION_CHANGED])
        self.assertFalse(v["reusable"])

    def test_multiple_reasons_are_ordered(self):
        v = rl.evaluate_reuse(base(), base(source_sha256=SRC_B, region={"start": 2, "duration": 5},
                                           transcript="다른 전사", analysis_version=2))
        self.assertEqual(v["reasons"], list(rl.REFERENCE_INVALIDATION_REASONS))

    def test_reason_set_is_exactly_four(self):
        self.assertEqual(len(rl.REFERENCE_INVALIDATION_REASONS), 4)
        self.assertEqual(len(set(rl.REFERENCE_INVALIDATION_REASONS)), 4)


# ─────────────────────────────────────────────────────────────────────────────
# 4) 겹침 규칙 + 후보 선택
# ─────────────────────────────────────────────────────────────────────────────
def iv(start_ms, duration_ms, score=0.0, ident=""):
    return {"start_ms": start_ms, "duration_ms": duration_ms, "score": score, "id": ident}


class OverlapTest(unittest.TestCase):
    def test_touching_endpoints_do_not_overlap(self):
        a = iv(0, 3000)
        touching = iv(3000, 3000)     # a.end == b.start → 겹치지 않음(반열린 구간)
        overlap_by_1 = iv(2999, 3000)
        self.assertFalse(rl.intervals_overlap(a, touching))
        self.assertFalse(rl.intervals_overlap(touching, a))
        self.assertTrue(rl.intervals_overlap(a, overlap_by_1))
        self.assertTrue(rl.intervals_overlap(overlap_by_1, a))
        self.assertTrue(rl.intervals_overlap(a, a))

    def test_select_best_excludes_taken(self):
        scored = [iv(0, 4000, 0.9, "x"), iv(2000, 4000, 0.95, "y"), iv(9000, 4000, 0.5, "z")]
        self.assertEqual(rl.select_best_candidate(scored)["id"], "y")
        self.assertEqual(rl.select_best_candidate(scored, [scored[1]])["id"], "z")
        self.assertIsNone(rl.select_best_candidate(scored, [scored[1], scored[2]]))
        self.assertIsNone(rl.select_best_candidate([]))

    def test_touching_candidate_still_selectable(self):
        scored = [iv(3000, 3000, 0.1, "next")]
        self.assertEqual(rl.select_best_candidate(scored, [iv(0, 3000)])["id"], "next")
        self.assertIsNone(rl.select_best_candidate(scored, [iv(0, 3001)]))

    def test_duration_policy_filters(self):
        scored = [iv(0, rl.MIN_REGION_MS - 1, 99, "short"),
                  iv(20000, rl.MAX_REGION_MS + 1, 99, "long"),
                  iv(40000, 0, 99, "zero"),
                  iv(60000, rl.MIN_REGION_MS, 0.01, "ok")]
        self.assertEqual(rl.select_best_candidate(scored)["id"], "ok")

    def test_pick_auto_candidates_non_overlapping_max_three(self):
        scored = [iv(0, 5000, 0.9, "a"), iv(3000, 5000, 0.8, "b"), iv(5000, 5000, 0.7, "c"),
                  iv(10000, 5000, 0.6, "d"), iv(16000, 5000, 0.5, "e")]
        picked = rl.pick_auto_candidates(scored)
        self.assertEqual([p["id"] for p in picked], ["a", "c", "d"])
        self.assertLessEqual(len(picked), rl.MAX_AUTO_CANDIDATES)
        for i in range(len(picked)):
            for j in range(i + 1, len(picked)):
                self.assertFalse(rl.intervals_overlap(picked[i], picked[j]))
        # 입력은 변형되지 않는다(순수)
        self.assertEqual([s["id"] for s in scored], ["a", "b", "c", "d", "e"])

    def test_tie_break_is_deterministic(self):
        self.assertEqual(rl.select_best_candidate([iv(20000, 4000, 1, "later"), iv(0, 4000, 1, "earlier")])["id"],
                         "earlier")
        self.assertEqual(rl.select_best_candidate([iv(0, 4000, 1, "zz"), iv(0, 4000, 1, "aa")])["id"], "aa")


# ─────────────────────────────────────────────────────────────────────────────
# 5) 저장 구조 + 6) 단일 참조 보증
# ─────────────────────────────────────────────────────────────────────────────
def entry_with_3():
    extra = [
        rl.build_candidate(SRC_A, 12.0, 5.0,
                           {"silence_ratio": 0.1, "clipping_ratio": 0.0, "rms_dbfs": -20,
                            "peak": 0.8, "speech_ratio": 0.9}, 0.8),
        rl.build_candidate(SRC_A, 20.0, 4.0,
                           {"silence_ratio": 0.2, "clipping_ratio": 0.001, "rms_dbfs": -24,
                            "peak": 0.7, "speech_ratio": 0.85}, 0.6),
    ]
    return rl.build_library_entry(SRC_A, {"start": 1.25, "duration": 7.0}, TRANSCRIPT, extra)


class EntryTest(unittest.TestCase):
    def test_entry_shape(self):
        e = entry_with_3()
        self.assertEqual(len(e["candidates"]), 3)
        self.assertEqual(e["candidates"][0]["id"], PINNED_CLIP_ID)
        self.assertEqual(e["default_candidate_id"], PINNED_CLIP_ID)
        self.assertEqual(e["fingerprint"], PINNED_FINGERPRINT)
        self.assertEqual((e["region_start_ms"], e["region_duration_ms"]), (1250, 7000))
        for c in e["candidates"]:
            for v in c["metrics"].values():
                self.assertIsInstance(v, float)

    def test_confirmed_candidate_metrics_preserved(self):
        # 확정 구간 후보를 넘기면 그 지표가 보존된다(기본 참조 지표가 0으로 비지 않음).
        confirmed = rl.build_candidate(SRC_A, 1.25, 7.0,
                                       {"silence_ratio": 0.12, "clipping_ratio": 0.0004, "rms_dbfs": -18.4,
                                        "peak": 0.93, "speech_ratio": 0.91}, 0.884)
        e = rl.build_library_entry(SRC_A, {"start": 1.25, "duration": 7.0}, TRANSCRIPT,
                                   [confirmed, rl.build_candidate(SRC_A, 20.0, 4.0, {}, 0.6)])
        self.assertEqual(e["candidates"][0]["id"], confirmed["id"])
        self.assertEqual(e["candidates"][0]["id"], e["default_candidate_id"])
        self.assertEqual(e["candidates"][0]["metrics"], confirmed["metrics"])
        self.assertEqual(e["candidates"][0]["score"], 0.884)
        self.assertEqual(len(e["candidates"]), 2, "같은 구간이 중복 저장되지 않는다")

    def test_candidate_set_invariants(self):
        with self.assertRaises(rl.ReferenceLibraryError) as cm:
            rl.assert_candidate_set_valid([rl.build_candidate(SRC_A, 0, 5), rl.build_candidate(SRC_A, 3, 5)])
        self.assertEqual(cm.exception.code, rl.OVERLAPPING_CANDIDATES)
        with self.assertRaises(rl.ReferenceLibraryError) as cm:
            rl.assert_candidate_set_valid([rl.build_candidate(SRC_A, 0, 3), rl.build_candidate(SRC_A, 3, 3),
                                           rl.build_candidate(SRC_A, 6, 3), rl.build_candidate(SRC_A, 9, 3)])
        self.assertEqual(cm.exception.code, rl.TOO_MANY_CANDIDATES)
        # 끝점 맞닿음 3개는 정상
        self.assertEqual(len(rl.assert_candidate_set_valid(
            [rl.build_candidate(SRC_A, 0, 3), rl.build_candidate(SRC_A, 3, 3), rl.build_candidate(SRC_A, 6, 3)])), 3)

    def test_exactly_one_reference_goes_to_synthesis(self):
        e = entry_with_3()
        ids = [c["id"] for c in e["candidates"]]
        ref = rl.build_synthesis_reference(e, [ids[1]])
        self.assertEqual(ref["clip_id"], ids[1])
        self.assertIsInstance(ref["clip_id"], str)
        self.assertNotIn("clip_ids", ref)
        self.assertEqual(rl.assert_single_reference(e, ids[0])["id"], ids[0])
        self.assertEqual(rl.assert_single_reference(e, [ids[0], ids[0]])["id"], ids[0])

    def test_zero_two_unknown_selection_rejected(self):
        e = entry_with_3()
        ids = [c["id"] for c in e["candidates"]]
        for selected, code in ((), rl.NO_REFERENCE_SELECTED), ((ids[0], ids[1]), rl.MULTIPLE_REFERENCES_SELECTED), \
                              (("deadbeefdeadbeef",), rl.UNKNOWN_REFERENCE_SELECTED):
            with self.assertRaises(rl.ReferenceLibraryError) as cm:
                rl.build_synthesis_reference(e, list(selected))
            self.assertEqual(cm.exception.code, code)


# ─────────────────────────────────────────────────────────────────────────────
# 7) 위생
# ─────────────────────────────────────────────────────────────────────────────
class HygieneTest(unittest.TestCase):
    def test_no_paths_or_transcript_in_stored_or_emitted(self):
        e = entry_with_3()
        ref = rl.build_synthesis_reference(e, [e["default_candidate_id"]])
        forbidden = (TRANSCRIPT.strip(), "안녕하세요", "전사입니다")
        self.assertEqual(rl.find_sensitive_strings(e, forbidden), [])
        self.assertEqual(rl.find_sensitive_strings(ref, forbidden), [])
        for k in ("path", "source_path", "clip", "transcript", "text", "file", "url"):
            self.assertNotIn(k, e, "entry.%s 없어야 함" % k)
            self.assertNotIn(k, ref, "ref.%s 없어야 함" % k)

    def test_detector_catches_real_leaks(self):
        self.assertTrue(rl.is_path_like("C:/Users/me/audio.wav"))
        self.assertTrue(rl.is_path_like("C:\\Users\\me\\audio.wav"))
        self.assertTrue(rl.is_path_like("file:///tmp/a.wav"))
        self.assertTrue(rl.is_path_like("/home/me/a.wav"))
        self.assertFalse(rl.is_path_like(PINNED_CLIP_ID))
        self.assertFalse(rl.is_path_like(rl.REF_SOURCE_CHANGED))
        hits = rl.find_sensitive_strings({"a": {"path": "C:/x/y.wav"}, "b": ["안녕하세요 참조 전사입니다."]},
                                         ("안녕하세요",))
        self.assertEqual(sorted(h["kind"] for h in hits), ["forbidden_text", "path_like"])
        self.assertEqual(sorted(h["at"] for h in hits), ["$.a.path", "$.b[0]"])

    def test_module_writes_nothing_and_sends_nothing(self):
        with open(rl.__file__, encoding="utf-8") as f:
            src = f.read()
        for banned in ('"wb"', "'wb'", '"w"', "shutil", "urllib", "requests", "socket", "subprocess", "os.remove"):
            self.assertNotIn(banned, src, "금지 참조: %s" % banned)


# ─────────────────────────────────────────────────────────────────────────────
# 8) PARITY — src/shared/referenceLibrary.ts 소스를 파싱해 코드 집합·버전 대조
# ─────────────────────────────────────────────────────────────────────────────
class ParityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(TS_MODULE, encoding="utf-8") as f:
            cls.ts = f.read()

    def _ts_int(self, name):
        m = re.search(r"^export const %s\s*=\s*(\d+)" % name, self.ts, re.M)
        self.assertIsNotNone(m, "TS 에서 %s 를 찾지 못함" % name)
        return int(m.group(1))

    def _ts_string(self, name):
        m = re.search(r"^export const %s\s*=\s*'([^']*)'" % name, self.ts, re.M)
        self.assertIsNotNone(m, "TS 에서 %s 를 찾지 못함" % name)
        return m.group(1)

    def _ts_string_array(self, name):
        m = re.search(r"^export const %s\s*=\s*\[(.*?)\]\s*as const" % name, self.ts, re.M | re.S)
        self.assertIsNotNone(m, "TS 에서 %s 배열을 찾지 못함" % name)
        return re.findall(r"'([A-Z][A-Z0-9_]*)'", m.group(1))

    def test_analysis_version_parity(self):
        self.assertEqual(self._ts_int("REFERENCE_ANALYSIS_VERSION"), rl.REFERENCE_ANALYSIS_VERSION)

    def test_invalidation_reason_set_parity(self):
        self.assertEqual(sorted(self._ts_string_array("REFERENCE_INVALIDATION_REASONS")),
                         sorted(rl.REFERENCE_INVALIDATION_REASONS))

    def test_guard_code_set_parity(self):
        self.assertEqual(sorted(self._ts_string_array("REFERENCE_GUARD_CODES")),
                         sorted(rl.REFERENCE_GUARD_CODES))

    def test_policy_and_serialization_constants_parity(self):
        self.assertEqual(self._ts_int("MAX_AUTO_CANDIDATES"), rl.MAX_AUTO_CANDIDATES)
        self.assertEqual(self._ts_int("MIN_REGION_MS"), rl.MIN_REGION_MS)
        self.assertEqual(self._ts_int("MAX_REGION_MS"), rl.MAX_REGION_MS)
        self.assertEqual(self._ts_int("CLIP_ID_LENGTH"), rl.CLIP_ID_LENGTH)
        self.assertEqual(self._ts_string("FINGERPRINT_PAYLOAD_HEADER"), rl.FINGERPRINT_PAYLOAD_HEADER)
        self.assertEqual(self._ts_string("CLIP_ID_PAYLOAD_HEADER"), rl.CLIP_ID_PAYLOAD_HEADER)

    def test_ts_pins_the_same_vectors(self):
        # TS 테스트가 같은 고정 벡터를 검증하는지 확인 → 정규 직렬화 바이트 동일성의 교차 증거.
        ts_test = os.path.join(REPO_ROOT, "src", "shared", "referenceLibrary.test.ts")
        with open(ts_test, encoding="utf-8") as f:
            src = f.read()
        for pinned in (PINNED_FINGERPRINT, PINNED_FINGERPRINT_EMPTY_TX, PINNED_CLIP_ID,
                       "transcript_sha256=87f80df86af86d7d0a052dfd58a942906e1fac0ce3b80b55d98e15c771cbf5ea"):
            self.assertIn(pinned, src, "TS 테스트에 고정 벡터 누락: %s" % pinned[:16])

    def test_fingerprint_field_order_parity(self):
        m = re.search(r"^export const FINGERPRINT_FIELD_ORDER\s*=\s*\[(.*?)\]\s*as const", self.ts, re.M | re.S)
        self.assertIsNotNone(m)
        self.assertEqual(re.findall(r"'([a-z0-9_]+)'", m.group(1)), list(rl.FINGERPRINT_FIELD_ORDER))


if __name__ == "__main__":
    unittest.main()
