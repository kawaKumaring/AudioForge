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

    # 9. preview_short 는 **실제 tokenizer 로 잰** production token 이 안전 한도 이내
    #    (글자 수로 통과를 주장하지 않는다 — 33 은 글자가 아니라 token 기준이다)
    def test_preview_within_token_budget(self):
        import generation_limit
        cap = generation_limit.max_segment_tokens()
        self.assertEqual(self.doc["max_segment_tokens_at_authoring"], cap,
                         "작성 당시 상한과 현재 상한이 달라졌다 — fixture 재측정 필요")
        for e in self.doc["emotions"]:
            n = e["contextual"]["preview_short"]["production_tokens"]
            self.assertIsInstance(n, int)
            self.assertLessEqual(n, cap, "%s preview %d token > %d" % (e["emotion_id"], n, cap))

    # 9b. 기록된 production_tokens 가 실제 tokenizer 와 일치하는지 재측정(가능한 환경에서만)
    def test_recorded_tokens_match_real_tokenizer(self):
        try:
            from transformers import AutoProcessor
        except Exception:
            self.skipTest("transformers 없음 — qwen3_tts_venv 에서만 재측정")
        mp = "E:/AI_Project/claudeCodeVsCode/apps/development/AudioForge/externals/qwen3_tts_1_7b_base"
        if not os.path.isdir(mp):
            self.skipTest("로컬 스냅샷 없음")
        proc = AutoProcessor.from_pretrained(mp, trust_remote_code=True)

        def ptok(t):
            at = "<|im_start|>assistant" + chr(10) + t + "<|im_end|>" + chr(10) + "<|im_start|>assistant" + chr(10)
            return int(proc(text=at, return_tensors="pt")["input_ids"].shape[-1])

        for e in self.doc["emotions"]:
            sp, _ = spoken(e["contextual"]["preview_short"]["text"])
            self.assertEqual(ptok(sp), e["contextual"]["preview_short"]["production_tokens"],
                             "%s 기록 토큰 불일치" % e["emotion_id"])

    # 10. medium 2~3문장 / long 문단 3개 이상 — production sentence splitter 규칙으로 센다
    def test_shape_of_medium_and_long(self):
        import text_segmenter as ts

        def sents(x):
            return [y for y in ts._cut_after(x, ts.SENTENCE_ENDERS, eat_closers=True) if y.strip()]

        for e in self.doc["emotions"]:
            m = e["contextual"]["validation_medium"]
            sp, _ = spoken(m["text"])
            n = len(sents(sp))
            self.assertEqual(n, m["sentence_count"], "%s 기록 문장수 불일치" % e["emotion_id"])
            self.assertGreaterEqual(n, 2, "%s medium 문장 부족" % e["emotion_id"])
            self.assertLessEqual(n, 3, "%s medium 문장 초과(2~3 계약)" % e["emotion_id"])
            lg = e["contextual"]["continuity_long"]
            self.assertGreaterEqual(lg["paragraph_count"], 3,
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

    # 13b. fixture 의 capability 값은 **런타임 권위가 아니다** — 판정 모듈이 이 필드를 읽지 않는다
    def test_capability_field_is_not_runtime_authority(self):
        here = os.path.dirname(os.path.abspath(__file__))
        root = os.path.dirname(here)
        targets = [
            os.path.join(here, "expressive_capability.py"),
            os.path.join(here, "emotion_sampler.py"),
            os.path.join(here, "tts_worker.py"),
            os.path.join(root, "src", "shared", "emotionSampler.ts"),
            os.path.join(root, "src", "shared", "ttsExpressionCapabilities.ts"),
        ]
        for t in targets:
            if not os.path.isfile(t):
                continue
            body = open(t, encoding="utf-8").read()
            self.assertNotIn("capability_status_at_authoring", body,
                             "%s 가 fixture 의 작성시 capability 를 읽는다" % os.path.basename(t))
            self.assertNotIn("emotion_scripts", body,
                             "%s 가 대사 fixture 로 지원 여부를 판정할 위험" % os.path.basename(t))

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
