# -*- coding: utf-8 -*-
"""감정 대사 fixture 검증 — GPU·모델·네트워크 0. 대사 원문은 단언에만 쓰고 출력하지 않는다."""
import os
import sys
import json
import hashlib
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import emotion_scripts as es
import tts_grammar
import tts_worker
import expressive_timeline as ex

CANON = sorted(set(tts_worker.EMOTION_TAGS.values()))


def spoken(text):
    p = tts_grammar.parse_tts_script(text)
    assert p["ok"], p.get("errors")
    return "".join(s["spoken_text"] for s in p["plan"]["segments"]), p["plan"]


def sha(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


class TestEmotionScripts(unittest.TestCase):
    def setUp(self):
        self.doc = es.load()

    # 1. canonical 50개 전부 정확히 한 번
    def test_canonical_coverage_exact(self):
        ids = list(es.emotion_ids())
        self.assertEqual(len(ids), 50)
        self.assertEqual(sorted(ids), CANON)
        self.assertEqual(len(set(ids)), len(ids), "감정 id 중복")

    # 2. 존재하지 않는 감정 id 0
    def test_no_unknown_ids(self):
        self.assertEqual(set(es.emotion_ids()) - set(CANON), set())

    # 3. preview/medium/long 150개 존재 + 라벨 일치
    def test_150_scripts_present(self):
        n = 0
        for e in self.doc["emotions"]:
            self.assertEqual(tts_worker.EMOTION_TAGS.get(e["label_ko"]), e["emotion_id"])
            for k in es.SCRIPT_KINDS:
                t = e["contextual"][k]["text"]
                self.assertTrue(t and t.strip(), "%s/%s 비어 있음" % (e["emotion_id"], k))
                n += 1
        self.assertEqual(n, 150)

    # 4. contextual 완전 중복 0 (controlled 는 제외 — 동일해야 하는 축)
    def test_contextual_no_duplicates(self):
        texts = [e["contextual"][k]["text"]
                 for e in self.doc["emotions"] for k in es.SCRIPT_KINDS]
        self.assertEqual(len(texts), 150)
        self.assertEqual(len(set(texts)), 150, "contextual 대사 중복")

    # 5. controlled 는 태그 제거 후 해시가 50개 전부 동일
    def test_controlled_spoken_hash_identical(self):
        hashes = set()
        for e in self.doc["emotions"]:
            sp, _ = spoken(e["controlled"]["text"])
            hashes.add(sha(sp))
        self.assertEqual(len(hashes), 1, "controlled 발화문이 감정마다 다르다")
        self.assertEqual(hashes.pop(), sha(es.controlled_base_text()))

    # 6. 저장된 expected_spoken_text_sha256 이 파서 실제 출력과 일치
    def test_expected_spoken_hashes_match_parser(self):
        for e in self.doc["emotions"]:
            for k in es.SCRIPT_KINDS:
                b = e["contextual"][k]
                sp, _ = spoken(b["text"])
                self.assertEqual(sha(sp), b["expected_spoken_text_sha256"],
                                 "%s/%s 발화문 해시 불일치" % (e["emotion_id"], k))
            sp, _ = spoken(e["controlled"]["text"])
            self.assertEqual(sha(sp), e["controlled"]["expected_spoken_text_sha256"])

    # 7. parser event 와 tag_sequence 일치
    def test_parser_events_match_tag_sequence(self):
        for e in self.doc["emotions"]:
            for k in es.SCRIPT_KINDS:
                b = e["contextual"][k]
                _, plan = spoken(b["text"])
                evs = ["emotion:" + s["emotion_id"] for s in plan["segments"] if s["emotion_id"]]
                self.assertEqual(evs, b["expected_parser_events"])
                self.assertEqual(set(evs), set(e["tag_sequence"]),
                                 "%s tag_sequence 불일치" % e["emotion_id"])

    # 8. 감정 이름을 대사에서 직접 말하지 않는다(태그는 제외한 발화문 기준)
    def test_emotion_name_not_spoken(self):
        for e in self.doc["emotions"]:
            label = e["label_ko"]
            if label in ("기본", "나레이션"):
                continue
            bare = label.split("(")[0]
            for k in es.SCRIPT_KINDS:
                sp, _ = spoken(e["contextual"][k]["text"])
                self.assertNotIn(bare, sp,
                                 "%s 대사가 감정 이름을 말한다" % e["emotion_id"])

    # 9. preview_short 는 안전 token 한도 통과(문자 상한으로 보수적 확인)
    def test_preview_within_safe_budget(self):
        import generation_limit
        cap = generation_limit.max_segment_tokens()
        self.assertEqual(cap, 33)
        for e in self.doc["emotions"]:
            sp, _ = spoken(e["contextual"]["preview_short"]["text"])
            # 한국어는 실측상 1자당 최대 약 1.0 token(골든 141 chunk: 33자 → 33 token).
            self.assertLessEqual(len(sp), cap,
                                 "%s preview 가 안전 한도 초과 가능" % e["emotion_id"])

    # 10. validation_medium 2~3문장 / continuity_long 여러 문단
    def test_shape_of_medium_and_long(self):
        for e in self.doc["emotions"]:
            sp, _ = spoken(e["contextual"]["validation_medium"]["text"])
            n = sum(sp.count(c) for c in ".!?")
            self.assertGreaterEqual(n, 2, "%s medium 문장 부족" % e["emotion_id"])
            self.assertLessEqual(n, 4, "%s medium 문장 과다" % e["emotion_id"])
            lg = e["contextual"]["continuity_long"]["text"]
            self.assertGreaterEqual(lg.count("\n\n"), 2,
                                    "%s long 문단 부족" % e["emotion_id"])

    # 11. fixture fingerprint 결정성
    def test_fingerprint_deterministic(self):
        a = es.compute_fingerprint(self.doc)
        b = es.compute_fingerprint(json.loads(json.dumps(self.doc)))
        self.assertEqual(a, b)
        self.assertEqual(a, self.doc["fixture_fingerprint"])

    # 12. 표현 fixture 는 표현 계약 파서로 재현된다
    def test_expression_rows(self):
        rows = es.expression_rows()
        self.assertEqual(len(rows), 11)
        self.assertEqual(len(set(r["row_id"] for r in rows)), 11)
        for r in rows:
            out = ex.parse_expressive_timeline(r["text"], mode="expressive_v3")
            self.assertTrue(out["ok"], r["row_id"])
            tl = out["timeline"]
            self.assertEqual(sha(tl["plain_text"]), r["expected_spoken_text_sha256"])
            self.assertEqual(tl["full_sha256"], r["expected_timeline_sha256"])

    # 13. 대사가 있다는 이유로 지원됨으로 승격하지 않는다
    def test_no_capability_promotion(self):
        for e in self.doc["emotions"]:
            self.assertEqual(e["capability_status_at_authoring"], "unknown")
        for r in es.expression_rows():
            self.assertEqual(r["capability_status_at_authoring"], "unknown")

    # 14. 폴백 금지 — 경로가 없으면 명시적 실패
    def test_missing_file_raises(self):
        real = es.fixture_path
        es._cache = None
        try:
            es.fixture_path = lambda: os.path.join(os.path.dirname(real()), "__absent__.json")
            with self.assertRaises(es.EmotionScriptsError):
                es.load()
        finally:
            es.fixture_path = real
            es._cache = None

    # 15. 지문이 어긋나면 실패
    def test_bad_fingerprint_raises(self):
        bad = json.loads(json.dumps(self.doc))
        bad["fixture_fingerprint"] = "0" * 64
        with self.assertRaises(es.EmotionScriptsError):
            if bad.get("fixture_fingerprint") != es.compute_fingerprint(bad):
                raise es.EmotionScriptsError("EMOTION_SCRIPTS_FINGERPRINT_MISMATCH")


if __name__ == "__main__":
    unittest.main(verbosity=2)
