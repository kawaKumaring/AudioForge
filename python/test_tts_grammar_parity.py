"""TTS v2 parser PARITY 테스트 (Python, stdlib only).

권위 fixture(test/fixtures/tts-grammar-conformance-v2.json)를 실제로 파싱해 valid/error 동작을 검증하고,
TS(src/shared/ttsGrammar.test.ts)와 공유하는 고정 canonical-hash 벡터를 재현한다(TS==Python 증명).
드리프트 가드: tts_worker.py EMOTION_TAGS 를 ast 로 읽어 tts_grammar.py 표와 대조(무거운 import 없이).

⚠️ 실패 보고는 case id·필드명만(대사 전문 로그 금지). offset 숫자는 fixture에서 '예시'라 재계산값과 대조하지 않는다.
"""
import ast
import json
import os
import unittest

import tts_grammar
from tts_grammar import parse_tts_script, line_boundary_type, sha256_hex_of_string

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(REPO_ROOT, "test", "fixtures", "tts-grammar-conformance-v2.json")
PINNED = os.path.join(REPO_ROOT, "src", "shared", "ttsGrammar.parity-hashes.json")
TTS_WORKER = os.path.join(REPO_ROOT, "python", "tts_worker.py")


def _load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class TtsGrammarParityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = _load(FIXTURE)
        cls.valid = cls.fx.get("valid", [])
        cls.errors = cls.fx.get("error", [])
        cls.pinned = _load(PINNED)

    # ── valid: segments 비교 ──
    def test_valid_segments(self):
        for c in self.valid:
            if not isinstance(c.get("segments"), list):
                continue
            r = parse_tts_script(c["input"])
            self.assertTrue(r["ok"], "id=%s 파싱 ok 기대" % c["id"])
            segs = r["plan"]["segments"]
            self.assertEqual(len(segs), len(c["segments"]), "id=%s segment 수" % c["id"])
            for i, exp in enumerate(c["segments"]):
                got = segs[i]
                self.assertEqual(got["emotion_id"], exp.get("emotion_id"), "id=%s seg#%d emotion_id" % (c["id"], i))
                self.assertEqual(got["spoken_text"], exp["spoken_text"], "id=%s seg#%d spoken_text" % (c["id"], i))
                if exp.get("original_line_index") is not None:
                    self.assertEqual(got["original_line_index"], exp["original_line_index"],
                                     "id=%s seg#%d line_index" % (c["id"], i))
                exp_pauses = exp.get("pauses") or []
                got_explicit = [p for p in got["pauses"] if p["boundary_type"] == "explicitPause"]
                self.assertEqual(len(got_explicit), len(exp_pauses), "id=%s seg#%d pause 수" % (c["id"], i))
                for k, ep in enumerate(exp_pauses):
                    self.assertEqual(got_explicit[k]["pause_ms"], int(round(ep["seconds"] * 1000)),
                                     "id=%s seg#%d pause ms" % (c["id"], i))
            if isinstance(c.get("used_emotion_ids"), list):
                self.assertEqual(r["plan"]["summary"]["used_emotion_ids"], c["used_emotion_ids"],
                                 "id=%s used_emotion_ids" % c["id"])

    # ── valid: pauses_total_seconds 케이스 ──
    def test_valid_pause_total(self):
        c = next(x for x in self.valid if x["id"] == "pause-alias-english-boundary-min")
        r = parse_tts_script(c["input"])
        self.assertTrue(r["ok"])
        self.assertEqual(r["plan"]["summary"]["total_pause_ms"], int(round(c["pauses_total_seconds"] * 1000)))

    # ── valid: 경계 우선순위 ──
    def test_boundary_priority(self):
        c1 = next(x for x in self.valid if x["id"] == "boundary-priority-line-silence-gap-emotion-gap")
        r1 = parse_tts_script(c1["input"])
        self.assertTrue(r1["ok"])
        self.assertEqual(line_boundary_type(r1["plan"], 0, 1), "lineSilenceGap")

        c2 = next(x for x in self.valid if x["id"] == "boundary-priority-explicit-pause-line-silence-ga")
        r2 = parse_tts_script(c2["input"])
        self.assertTrue(r2["ok"])
        self.assertEqual(line_boundary_type(r2["plan"], 0, 1), "explicitPause")

    # ── error 케이스: 코드/필드 일치(대사 전문 없음) ──
    def test_error_cases(self):
        for c in self.errors:
            if c["id"] == "parser-parity-mismatch-renderer-sha256-python":
                continue  # 런타임 교차검증(텍스트 파싱 아님)
            r = parse_tts_script(c["input"])
            self.assertFalse(r["ok"], "id=%s 파싱 실패 기대" % c["id"])
            codes = [e["code"] for e in r["errors"]]
            self.assertIn(c["error"]["code"], codes, "id=%s 기대 code" % c["id"])
            match = next(e for e in r["errors"] if e["code"] == c["error"]["code"])
            if c["error"].get("tag") is not None:
                self.assertEqual(match.get("tag"), c["error"]["tag"], "id=%s tag" % c["id"])
            if c["error"].get("arg") is not None:
                self.assertEqual(match.get("arg"), c["error"]["arg"], "id=%s arg" % c["id"])
            if c["error"].get("reason") is not None:
                self.assertEqual(match.get("reason"), c["error"]["reason"], "id=%s reason" % c["id"])
            # payload 에 대사 전문 키 없음
            for e in r["errors"]:
                self.assertNotIn("spoken_text", e)
                self.assertNotIn("text", e)

    # ── sha256 self-check(hashlib 기반이므로 표준값 검증) ──
    def test_sha256_known_vector(self):
        # "abc" 표준 SHA256
        self.assertEqual(sha256_hex_of_string("abc"),
                         "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        self.assertEqual(sha256_hex_of_string(""),
                         "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")

    # ── 자체 벡터: 이모지(surrogate) dual offset 이원화 ──
    def test_emoji_dual_offset(self):
        r = parse_tts_script("\U0001F389[기쁨] 안녕")  # 🎉[기쁨] 안녕
        self.assertTrue(r["ok"])
        segs = r["plan"]["segments"]
        self.assertEqual(len(segs), 1)
        seg = segs[0]
        self.assertEqual(seg["emotion_id"], "happy")
        self.assertEqual(seg["spoken_text"], "\U0001F389안녕")
        off = seg["offset"]
        self.assertEqual(off["ui_start_utf16"], 0)
        self.assertEqual(off["text_start_codepoint"], 0)
        self.assertEqual(off["text_end_codepoint"], 8)
        self.assertEqual(off["ui_end_utf16"], 9)
        self.assertNotEqual(off["ui_end_utf16"], off["text_end_codepoint"])

    # ── canonical full hash: 고정 벡터 재현(= TS 동형, TS==Python 증명) ──
    def test_pinned_hash_parity(self):
        for inp, expected in self.pinned.items():
            r = parse_tts_script(inp)
            self.assertTrue(r["ok"], "parity 입력이 성공 파싱이어야 함")
            self.assertEqual(r["plan"]["full_sha256"], expected)
            self.assertEqual(r["plan"]["summary"]["plan_sha8"], expected[:8])
            # 결정성
            r2 = parse_tts_script(inp)
            self.assertEqual(r2["plan"]["full_sha256"], expected)

    # ── 드리프트 가드: tts_worker.EMOTION_TAGS(ast) == tts_grammar 표 ──
    def test_emotion_table_matches_tts_worker(self):
        with open(TTS_WORKER, encoding="utf-8") as f:
            tree = ast.parse(f.read(), filename=TTS_WORKER)
        worker_tags = None
        for node in tree.body:
            if isinstance(node, ast.Assign):
                for tgt in node.targets:
                    if isinstance(tgt, ast.Name) and tgt.id == "EMOTION_TAGS":
                        worker_tags = ast.literal_eval(node.value)
        self.assertIsNotNone(worker_tags, "tts_worker.py 에서 EMOTION_TAGS 를 찾지 못함")
        self.assertEqual(tts_grammar.TTS_EMOTION_LABEL_TO_ID, worker_tags,
                         "tts_grammar 감정표가 tts_worker.EMOTION_TAGS 와 불일치(드리프트)")


if __name__ == "__main__":
    unittest.main()
