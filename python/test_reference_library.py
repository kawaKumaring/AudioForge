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
# 9) 내용 기반 지문이 단일 권위 — 경로/크기/mtime은 캐시 권위가 아니다
# ─────────────────────────────────────────────────────────────────────────────
class ContentAuthorityTest(unittest.TestCase):
    def test_same_file_moved_to_different_path_is_still_reusable(self):
        # 같은 바이트를 서로 다른 '경로'에서 읽어도 내용 해시가 같으므로 재사용된다.
        content = b"the same audio bytes"
        old = rl.sha256_hex_of_source("C:/old/place/voice.wav", reader=lambda p: [content])
        new = rl.sha256_hex_of_source("E:/totally/other/renamed.wav", reader=lambda p: [content])
        self.assertEqual(old, new)
        stored = {"source_sha256": old, "region": {"start": 1.25, "duration": 7.0}, "transcript": TRANSCRIPT}
        moved = {"source_sha256": new, "region": {"start": 1.25, "duration": 7.0}, "transcript": TRANSCRIPT}
        v = rl.evaluate_reuse(stored, moved)
        self.assertTrue(v["reusable"])
        self.assertEqual(v["reasons"], [])

    def test_changed_content_same_name_and_size_invalidates(self):
        # 이름·크기가 같아도 내용이 다르면 무효화된다(경로|크기|mtime 캐시가 놓치는 바로 그 경우).
        a = b"AAAAAAAAAAAAAAAA"
        b = b"BBBBBBBBBBBBBBBB"
        self.assertEqual(len(a), len(b))
        path = "C:/same/name.wav"
        sha_a = rl.sha256_hex_of_source(path, reader=lambda p: [a])
        sha_b = rl.sha256_hex_of_source(path, reader=lambda p: [b])
        self.assertNotEqual(sha_a, sha_b)
        v = rl.evaluate_reuse(
            {"source_sha256": sha_a, "region": {"start": 0, "duration": 5}, "transcript": ""},
            {"source_sha256": sha_b, "region": {"start": 0, "duration": 5}, "transcript": ""})
        self.assertEqual(v["reasons"], [rl.REF_SOURCE_CHANGED])
        self.assertFalse(v["reusable"])

    def test_cache_key_rejects_path_size_mtime_tuple(self):
        # 구형 fingerprintReference(path|size|mtimeMs)는 캐시 권위로 받아들이지 않는다.
        for bad in ("C:/ref/a.wav|1234|1699999999999", "a.wav|10|20", "", "not-a-hash", SRC_A[:63]):
            with self.assertRaises(rl.ReferenceLibraryError) as cm:
                rl.reference_cache_key(bad)
            self.assertEqual(cm.exception.code, rl.INVALID_FINGERPRINT_INPUT)
        self.assertEqual(rl.reference_cache_key(PINNED_FINGERPRINT), PINNED_FINGERPRINT)

    def test_sampler_consumes_exported_identity(self):
        # 샘플러가 스스로 지문을 만들지 않도록, 소비할 값을 그대로 내보낸다.
        e = entry_with_3()
        ref = rl.build_synthesis_reference(e, [e["default_candidate_id"]])
        self.assertEqual(ref["cache_key"], e["fingerprint"])
        self.assertEqual(ref["source_sha256"], SRC_A)
        ident = rl.reference_identity(e)
        self.assertEqual(ident, {"fingerprint": e["fingerprint"], "cache_key": e["fingerprint"],
                                 "source_sha256": SRC_A, "analysis_version": rl.REFERENCE_ANALYSIS_VERSION})
        # 경로/크기/mtime 흔적 없음
        self.assertEqual(rl.find_sensitive_strings(ref), [])
        self.assertEqual(rl.find_sensitive_strings(ident), [])

    def test_module_never_uses_stat_based_fingerprint(self):
        """실행 코드에 stat 기반 지문(경로/크기/mtime)의 흔적이 없어야 한다.

        주석·docstring은 '그것을 쓰지 않는다'고 설명하므로 문자열 검색이 아니라 ast로 식별자만 본다."""
        import ast
        with open(rl.__file__, encoding="utf-8") as f:
            tree = ast.parse(f.read(), filename=rl.__file__)
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                names.add(node.id)
            elif isinstance(node, ast.Attribute):
                names.add(node.attr)
            elif isinstance(node, ast.arg):
                names.add(node.arg)
            elif isinstance(node, (ast.FunctionDef, ast.ClassDef)):
                names.add(node.name)
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                # dict 키/필드명 같은 '식별자형' 리터럴만 본다(공백 있는 진단 메시지는 산문이므로 제외).
                if node.value and not any(ch.isspace() for ch in node.value):
                    names.add(node.value)
        for banned in ("mtime", "st_size", "getsize", "getmtime", "sourcefingerprint", "fingerprintreference"):
            for n in names:
                self.assertNotIn(banned, str(n).lower(), "stat 기반 지문 흔적: %s in %r" % (banned, n))


# ─────────────────────────────────────────────────────────────────────────────
# 10) 재탐색(rescan) — 기존 후보를 명시적으로 제외
# ─────────────────────────────────────────────────────────────────────────────
class RescanTest(unittest.TestCase):
    def _scored(self):
        return [iv(0, 5000, 0.9, "a"), iv(3000, 5000, 0.85, "b"), iv(5000, 5000, 0.7, "c"),
                iv(10000, 5000, 0.6, "d"), iv(16000, 5000, 0.5, "e")]

    def test_rescan_excludes_existing_intervals(self):
        first = rl.rescan_candidates(self._scored(), [], max_count=1)
        self.assertEqual(first["status"], rl.REFERENCE_CANDIDATES_FOUND)
        self.assertEqual([c["id"] for c in first["added"]], ["a"])
        # a를 가진 채 재탐색 → a와 겹치는 b는 제외되고 끝점이 맞닿는 c가 나온다
        second = rl.rescan_candidates(self._scored(), first["candidates"], max_count=2)
        self.assertEqual([c["id"] for c in second["added"]], ["c"])
        self.assertEqual([c["id"] for c in second["candidates"]], ["a", "c"])

    def test_rescan_never_replaces_reorders_or_deletes_existing(self):
        existing = [iv(16000, 5000, 0.5, "e"), iv(10000, 5000, 0.6, "d")]   # 일부러 점수 역순
        r = rl.rescan_candidates(self._scored(), existing, max_count=3)
        self.assertEqual([c["id"] for c in r["candidates"][:2]], ["e", "d"], "기존 순서 그대로 보존")
        self.assertEqual(r["candidates"][0], existing[0])
        self.assertEqual(r["candidates"][1], existing[1])
        self.assertEqual(len(r["candidates"]), 3)
        self.assertEqual(r["excluded_count"], 2)

    def test_rescan_exhaustion_returns_structured_state(self):
        # 후보 전 구간(0~21000ms)을 덮는 구간을 이미 가지고 있으면 남는 게 없다 → 빈 배열을 조용히 주지 않는다
        r = rl.rescan_candidates(self._scored(), [iv(0, 21000)], max_count=3)
        self.assertEqual(r["status"], rl.NO_MORE_REFERENCE_CANDIDATES)
        self.assertEqual(r["added"], [])
        self.assertIn(r["status"], rl.REFERENCE_SCAN_STATUSES)
        # 자리가 이미 다 찼을 때도 같은 상태
        full = rl.rescan_candidates(self._scored(), [iv(0, 5000), iv(5000, 5000), iv(10000, 5000)], max_count=3)
        self.assertEqual(full["status"], rl.NO_MORE_REFERENCE_CANDIDATES)
        self.assertEqual(full["room"], 0)

    def test_rescan_never_fabricates_overlapping_candidate(self):
        r = rl.rescan_candidates(self._scored(), [iv(0, 5000, 0.9, "a")], max_count=3)
        for added in r["added"]:
            self.assertFalse(rl.intervals_overlap(added, iv(0, 5000)))

    def test_rescan_is_deterministic_for_fixed_exclusion_set(self):
        excl = [iv(0, 5000, 0.9, "a")]
        runs = [tuple(c["id"] for c in rl.rescan_candidates(self._scored(), excl, max_count=3)["added"])
                for _ in range(5)]
        self.assertEqual(len(set(runs)), 1, "같은 입력+같은 제외 집합 → 항상 같은 결과")


# ─────────────────────────────────────────────────────────────────────────────
# 11) 영속 저장소 — manifest / 재시작 / 삭제 / 승격 순서·실패 불변식
# ─────────────────────────────────────────────────────────────────────────────
CLIP_SHA = "c" * 64
RUN_ID = "deadbeef"


def durable_entry():
    return rl.build_library_entry(SRC_A, {"start": 1.25, "duration": 7.0}, TRANSCRIPT)


class DurableManifestTest(unittest.TestCase):
    def test_record_holds_only_the_allowed_fields(self):
        rec = rl.build_manifest_record(durable_entry(), CLIP_SHA)
        self.assertEqual(sorted(rec.keys()), sorted(rl.MANIFEST_RECORD_FIELDS))
        self.assertEqual(rec["clip_id"], PINNED_CLIP_ID)
        self.assertEqual(rec["fingerprint"], PINNED_FINGERPRINT)
        self.assertEqual(rec["clip_sha256"], CLIP_SHA)
        self.assertEqual(rl.find_sensitive_strings(rec, (TRANSCRIPT.strip(), "안녕하세요")), [])

    def test_manifest_rejects_any_path_field(self):
        rec = rl.build_manifest_record(durable_entry(), CLIP_SHA)
        leaky = dict(rec, clip_path="C:/userData/reference-library/x.wav")
        with self.assertRaises(rl.ReferenceLibraryError) as cm:
            rl.assert_manifest_record_valid(leaky)
        self.assertEqual(cm.exception.code, rl.MANIFEST_CONTAINS_PATH)

    def test_file_name_is_clip_id_only(self):
        self.assertEqual(rl.clip_file_name(PINNED_CLIP_ID), PINNED_CLIP_ID + rl.CLIP_FILE_EXTENSION)
        self.assertFalse(rl.is_path_like(rl.clip_file_name(PINNED_CLIP_ID)))
        with self.assertRaises(rl.ReferenceLibraryError):
            rl.clip_file_name("../escape")

    def test_same_volume_requirement_for_atomic_promote(self):
        rl.assert_promotion_same_volume(r"E:\ud\reference-library\staging\run-deadbeef", r"E:\ud\reference-library")
        rl.assert_promotion_same_volume("E:/ud/x", r"e:\ud\y")           # 대소문자/구분자 무관
        with self.assertRaises(rl.ReferenceLibraryError) as cm:
            rl.assert_promotion_same_volume(r"C:\Temp\run-deadbeef", r"E:\ud\reference-library")
        self.assertEqual(cm.exception.code, rl.CROSS_DEVICE_PROMOTION)
        self.assertEqual(rl.path_volume(r"\\server\share\ud"), r"\\server\share")

    def test_deletion_removes_only_recorded_assets(self):
        m = rl.upsert_manifest_record(rl.empty_manifest(), rl.build_manifest_record(durable_entry(), CLIP_SHA))
        plan = rl.plan_asset_deletion(m, PINNED_CLIP_ID)
        self.assertEqual(plan["file_names"], [PINNED_CLIP_ID + ".wav"])
        m2, plan2 = rl.remove_manifest_record(m, PINNED_CLIP_ID)
        self.assertEqual(m2["records"], [])
        self.assertEqual(plan2["clip_id"], PINNED_CLIP_ID)
        # 기록에 없는 것은 계획조차 만들지 않는다(광역/접두사 청소 금지)
        with self.assertRaises(rl.ReferenceLibraryError) as cm:
            rl.plan_asset_deletion(m2, "0123456789abcdef")
        self.assertEqual(cm.exception.code, rl.UNKNOWN_REFERENCE_ASSET)

    def test_checksum_mismatch_is_detected(self):
        rec = rl.build_manifest_record(durable_entry(), CLIP_SHA)
        self.assertEqual(rl.verify_stored_clip(rec, CLIP_SHA)["clip_id"], PINNED_CLIP_ID)
        with self.assertRaises(rl.ReferenceLibraryError) as cm:
            rl.verify_stored_clip(rec, "d" * 64)
        self.assertEqual(cm.exception.code, rl.CLIP_CHECKSUM_MISMATCH)

    def test_restart_equivalent_manifest_reread_resolves_same_fingerprint(self):
        """재시작 등가: manifest를 디스크에 쓰고, 새 상태로 다시 읽어 같은 지문이 클립을 찾는지."""
        import json
        import tempfile
        m = rl.upsert_manifest_record(rl.empty_manifest(), rl.build_manifest_record(durable_entry(), CLIP_SHA))
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, rl.MANIFEST_FILE_NAME)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(m, f)
            del m                                    # 프로세스 내 상태를 버린다(재시작 등가)
            with open(path, encoding="utf-8") as f:
                reloaded = rl.assert_manifest_valid(json.load(f))
        # 대본/속도/감정이 전부 달라진 새 세션의 요청
        req = base(script="완전히 다른 대본", speed=1.9, emotion_id="angry")
        got = rl.resolve_reusable_clip(reloaded, req)
        self.assertTrue(got["reusable"])
        self.assertEqual(got["clip_id"], PINNED_CLIP_ID)
        self.assertEqual(got["file_name"], PINNED_CLIP_ID + ".wav")
        self.assertEqual(got["fingerprint"], PINNED_FINGERPRINT)
        # 그 클립이 실제로 쓸 수 있는(체크섬 일치) 자산인지까지 확인
        self.assertEqual(rl.verify_stored_clip(got["record"], CLIP_SHA)["clip_sha256"], CLIP_SHA)

    def test_restart_reread_reports_invalidation_when_source_changed(self):
        m = rl.upsert_manifest_record(rl.empty_manifest(), rl.build_manifest_record(durable_entry(), CLIP_SHA))
        got = rl.resolve_reusable_clip(m, base(source_sha256=SRC_B))
        self.assertFalse(got["reusable"])
        self.assertIsNone(got["clip_id"])
        self.assertEqual(got["reasons"], [])           # 지문 자체가 달라 라이브러리에 없음(무효화가 아니라 부재)
        # 레코드를 직접 대조하면 사유가 나온다
        rec = rl.find_manifest_record(m, PINNED_FINGERPRINT)
        self.assertEqual(rl.evaluate_reuse_against_record(rec, base(source_sha256=SRC_B))["reasons"],
                         [rl.REF_SOURCE_CHANGED])


class PromotionTest(unittest.TestCase):
    """가짜 fs로 승격 순서·실패 불변식을 검증한다(실제 오디오/파일 없음)."""

    def _effects(self, calls, fail_at=None, staging="E:/ud/reference-library/staging/run-deadbeef"):
        measured = {"decodable": True, "all_samples_finite": True, "sample_rate": 24000,
                    "channel_count": 1, "duration_ms": 7000, "clip_sha256": CLIP_SHA}

        def step(name, ret):
            def f(*args):
                if name == fail_at:
                    raise RuntimeError("injected failure at %s" % name)
                calls.append(name)
                return ret
            return f

        return {
            "create_staging_dir": step("CREATE_STAGING_DIR", staging),
            "write_staging_clip": step("WRITE_STAGING_CLIP", staging + "/" + PINNED_CLIP_ID + ".wav"),
            "verify_staging_clip": step("VERIFY_STAGING_CLIP", measured),
            "promote_clip": step("PROMOTE_CLIP", "E:/ud/reference-library/" + PINNED_CLIP_ID + ".wav"),
            "write_manifest_temp": step("WRITE_MANIFEST_TEMP", "E:/ud/reference-library/manifest.json.deadbeef.tmp"),
            "replace_manifest": step("REPLACE_MANIFEST", None),
        }

    def _request(self, manifest=None):
        return {"run_id": RUN_ID, "entry": durable_entry(), "durable_dir": "E:/ud/reference-library",
                "manifest": manifest if manifest is not None else rl.empty_manifest(),
                "expected": {"sample_rate": 24000, "channel_count": 1, "duration_ms": 7000}}

    def test_promote_order_is_observed(self):
        calls = []
        r = rl.promote_reference_clip(self._effects(calls), self._request())
        self.assertEqual(r["status"], rl.REFERENCE_PROMOTED)
        self.assertEqual(calls, list(rl.PROMOTE_STEPS))
        self.assertEqual(r["steps"], list(rl.PROMOTE_STEPS))
        rl.assert_promote_order(calls)
        self.assertEqual(len(r["manifest"]["records"]), 1)
        self.assertEqual(r["record"]["clip_sha256"], CLIP_SHA)
        self.assertEqual(r["orphan_clip_ids"], [])

    def test_out_of_order_sequence_is_rejected(self):
        for bad in (["WRITE_STAGING_CLIP"], ["CREATE_STAGING_DIR", "PROMOTE_CLIP"],
                    list(reversed(rl.PROMOTE_STEPS))):
            with self.assertRaises(rl.ReferenceLibraryError) as cm:
                rl.assert_promote_order(bad)
            self.assertEqual(cm.exception.code, rl.PROMOTE_ORDER_VIOLATION)

    def test_failure_at_each_step_leaves_previous_manifest_and_clips_intact(self):
        # 이전 상태: 다른 참조 하나가 이미 등재돼 있다
        prev_entry = rl.build_library_entry(SRC_B, {"start": 0.0, "duration": 4.0}, "이전 참조")
        prev = rl.upsert_manifest_record(rl.empty_manifest(), rl.build_manifest_record(prev_entry, "e" * 64))
        prev_snapshot = json_copy(prev)

        for idx, step in enumerate(rl.PROMOTE_STEPS[1:], start=1):   # 2~6단계에 각각 실패 주입
            calls = []
            r = rl.promote_reference_clip(self._effects(calls, fail_at=step), self._request(prev))
            self.assertEqual(r["status"], rl.REFERENCE_PROMOTE_FAILED, step)
            self.assertEqual(r["failed_step"], step)
            self.assertEqual(calls, list(rl.PROMOTE_STEPS[:idx]), "실패 지점까지만 실행 %s" % step)
            self.assertNotIn("REPLACE_MANIFEST", calls, "manifest 교체는 마지막 단계에서만 %s" % step)
            # 반환된 manifest는 이전 그대로 — 부분 manifest가 노출되지 않는다
            self.assertEqual(json_copy(r["manifest"]), prev_snapshot, step)
            self.assertEqual(json_copy(prev), prev_snapshot, "입력 manifest 원본 불변 %s" % step)
            # 기존 참조는 계속 쓸 수 있다
            still = rl.resolve_reusable_clip(r["manifest"],
                                             {"source_sha256": SRC_B, "region": {"start": 0.0, "duration": 4.0},
                                              "transcript": "이전 참조"})
            self.assertTrue(still["reusable"], "기존 참조 계속 사용 가능 %s" % step)

    def test_replace_manifest_reached_only_after_all_previous_steps(self):
        calls = []
        rl.promote_reference_clip(self._effects(calls), self._request())
        self.assertEqual(calls.index("REPLACE_MANIFEST"), len(rl.PROMOTE_STEPS) - 1)
        self.assertLess(calls.index("PROMOTE_CLIP"), calls.index("WRITE_MANIFEST_TEMP"))
        self.assertLess(calls.index("VERIFY_STAGING_CLIP"), calls.index("PROMOTE_CLIP"))

    def test_clip_promoted_but_manifest_failed_leaves_orphan_and_keeps_existing_usable(self):
        prev_entry = rl.build_library_entry(SRC_B, {"start": 0.0, "duration": 4.0}, "이전 참조")
        prev = rl.upsert_manifest_record(rl.empty_manifest(), rl.build_manifest_record(prev_entry, "e" * 64))
        calls = []
        r = rl.promote_reference_clip(self._effects(calls, fail_at="REPLACE_MANIFEST"), self._request(prev))
        self.assertEqual(r["status"], rl.REFERENCE_PROMOTE_FAILED)
        self.assertEqual(r["orphan_clip_ids"], [PINNED_CLIP_ID])       # 고아 허용 — 단, 기존은 멀쩡
        self.assertEqual(len(r["manifest"]["records"]), 1)
        still = rl.resolve_reusable_clip(r["manifest"],
                                         {"source_sha256": SRC_B, "region": {"start": 0.0, "duration": 4.0},
                                          "transcript": "이전 참조"})
        self.assertTrue(still["reusable"], "고아가 생겨도 기존 참조는 깨지지 않는다")
        # 고아는 이 run 저널로만 정리 가능
        self.assertTrue(rl.is_orphan_owned_by_run(PINNED_CLIP_ID + ".wav", r["journal"], r["manifest"]))

    def test_cross_volume_staging_blocked_before_any_write(self):
        calls = []
        r = rl.promote_reference_clip(self._effects(calls, staging="C:/Temp/run-deadbeef"), self._request())
        self.assertEqual(r["status"], rl.REFERENCE_PROMOTE_FAILED)
        self.assertEqual(r["error_code"], rl.CROSS_DEVICE_PROMOTION)
        self.assertEqual(r["steps"], [], "볼륨이 다르면 아무것도 쓰지 않는다")
        self.assertEqual(r["orphan_clip_ids"], [])

    def test_verification_failure_blocks_promotion(self):
        for broken in ({"decodable": False}, {"all_samples_finite": False}, {"sample_rate": 16000},
                       {"channel_count": 2}, {"duration_ms": 9000}, {"clip_sha256": "nope"}):
            calls = []
            fx = self._effects(calls)
            base_measured = {"decodable": True, "all_samples_finite": True, "sample_rate": 24000,
                             "channel_count": 1, "duration_ms": 7000, "clip_sha256": CLIP_SHA}
            fx["verify_staging_clip"] = (lambda m: (lambda *a: (calls.append("VERIFY_STAGING_CLIP"), m)[1]))(
                dict(base_measured, **broken))
            r = rl.promote_reference_clip(fx, self._request())
            self.assertEqual(r["status"], rl.REFERENCE_PROMOTE_FAILED, broken)
            self.assertEqual(r["error_code"], rl.CLIP_VERIFICATION_FAILED, broken)
            self.assertNotIn("PROMOTE_CLIP", calls, "검증 실패면 승격하지 않는다 %s" % broken)
            self.assertEqual(r["orphan_clip_ids"], [])

    def test_verification_check_list_is_the_contract(self):
        failed = rl.evaluate_clip_verification(
            {"decodable": False, "all_samples_finite": False, "sample_rate": 1, "channel_count": 2,
             "duration_ms": 3, "clip_sha256": "x"},
            {"sample_rate": 24000, "channel_count": 1, "duration_ms": 7000})
        self.assertEqual(sorted(failed), sorted(rl.CLIP_VERIFICATION_CHECKS))
        self.assertEqual(rl.evaluate_clip_verification(
            {"decodable": True, "all_samples_finite": True, "sample_rate": 24000, "channel_count": 1,
             "duration_ms": 7000, "clip_sha256": CLIP_SHA},
            {"sample_rate": 24000, "channel_count": 1, "duration_ms": 7000}), [])

    def test_run_scoped_naming_and_orphan_ownership(self):
        self.assertEqual(rl.run_scoped_staging_dir_name(RUN_ID), "run-deadbeef")
        self.assertEqual(rl.run_journal_file_name(RUN_ID), "run-deadbeef.journal.json")
        self.assertEqual(rl.manifest_temp_file_name(RUN_ID), "manifest.json.deadbeef.tmp")
        self.assertTrue(rl.is_run_scoped_name("run-deadbeef", RUN_ID))
        self.assertFalse(rl.is_run_scoped_name("run-deadbeefX", RUN_ID), "접두사 일치만으로는 소유가 아니다")
        self.assertFalse(rl.is_run_scoped_name("run-cafebabe", RUN_ID))
        with self.assertRaises(rl.ReferenceLibraryError):
            rl.run_scoped_staging_dir_name("nope")

        journal = rl.build_run_journal(RUN_ID, [PINNED_CLIP_ID])
        empty = rl.empty_manifest()
        self.assertTrue(rl.is_orphan_owned_by_run(PINNED_CLIP_ID + ".wav", journal, empty))
        # 남의 파일 / 접두사만 같은 파일 / 저널에 없는 파일은 전부 거부(광역 삭제 금지)
        for foreign in ("somebody-else.wav", PINNED_CLIP_ID + "_old.wav", PINNED_CLIP_ID[:8] + ".wav",
                        "0123456789abcdef.wav", "manifest.json", ""):
            self.assertFalse(rl.is_orphan_owned_by_run(foreign, journal, empty), foreign)
        # manifest에 등재된 것은 고아가 아니다 → 절대 삭제 대상이 아니다
        listed = rl.upsert_manifest_record(empty, rl.build_manifest_record(durable_entry(), CLIP_SHA))
        self.assertFalse(rl.is_orphan_owned_by_run(PINNED_CLIP_ID + ".wav", journal, listed))
        self.assertFalse(rl.is_orphan_owned_by_run(PINNED_CLIP_ID + ".wav", {"clip_ids": []}, empty))


def json_copy(v):
    import json
    return json.loads(json.dumps(v, sort_keys=True))


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

    def test_scan_and_promote_status_set_parity(self):
        self.assertEqual(sorted(self._ts_string_array("REFERENCE_SCAN_STATUSES")),
                         sorted(rl.REFERENCE_SCAN_STATUSES))
        self.assertEqual(sorted(self._ts_string_array("REFERENCE_PROMOTE_STATUSES")),
                         sorted(rl.REFERENCE_PROMOTE_STATUSES))

    def test_promote_step_order_parity(self):
        # 순서 자체가 계약이므로 정렬하지 않고 순서까지 대조한다.
        self.assertEqual(self._ts_string_array("PROMOTE_STEPS"), list(rl.PROMOTE_STEPS))

    def test_verification_check_list_parity(self):
        m = re.search(r"^export const CLIP_VERIFICATION_CHECKS\s*=\s*\[(.*?)\]\s*as const",
                      self.ts, re.M | re.S)
        self.assertIsNotNone(m)
        self.assertEqual(re.findall(r"'([a-z0-9_]+)'", m.group(1)), list(rl.CLIP_VERIFICATION_CHECKS))

    def test_manifest_record_fields_parity(self):
        m = re.search(r"^export const MANIFEST_RECORD_FIELDS\s*=\s*\[(.*?)\]\s*as const", self.ts, re.M | re.S)
        self.assertIsNotNone(m)
        self.assertEqual(re.findall(r"'([a-z0-9_]+)'", m.group(1)), list(rl.MANIFEST_RECORD_FIELDS))

    def test_durable_storage_constants_parity(self):
        self.assertEqual(self._ts_int("MANIFEST_VERSION"), rl.MANIFEST_VERSION)
        self.assertEqual(self._ts_string("REFERENCE_LIBRARY_DIR_NAME"), rl.REFERENCE_LIBRARY_DIR_NAME)
        self.assertEqual(self._ts_string("REFERENCE_STAGING_DIR_NAME"), rl.REFERENCE_STAGING_DIR_NAME)
        self.assertEqual(self._ts_string("MANIFEST_FILE_NAME"), rl.MANIFEST_FILE_NAME)
        self.assertEqual(self._ts_string("CLIP_FILE_EXTENSION"), rl.CLIP_FILE_EXTENSION)
        self.assertEqual(self._ts_string("RUN_SCOPE_PREFIX"), rl.RUN_SCOPE_PREFIX)
        self.assertEqual(self._ts_string("RUN_JOURNAL_SUFFIX"), rl.RUN_JOURNAL_SUFFIX)
        self.assertEqual(self._ts_string("MANIFEST_TEMP_SUFFIX"), rl.MANIFEST_TEMP_SUFFIX)

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
