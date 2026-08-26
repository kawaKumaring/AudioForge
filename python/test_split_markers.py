"""split_markers.py 단위테스트 + Python↔TS parity (C2-P0.3). stdlib only.

실행: PYTHONIOENCODING=utf-8 <python> python/test_split_markers.py
parity는 '파싱으로' 한다: src/shared/splitMarkers.ts 의 상수 블록을 읽어 reasonCode 집합·숫자 상수를 대조
(test_tts_grammar_parity.py 가 tts_worker.py 를 ast 로 읽어 드리프트를 막는 것과 같은 패턴).
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import split_markers
from split_markers import (
    MIN_TRACK_SECONDS, MAX_MARKER_COUNT, TRACK_LENGTH_EPSILON, LIST_LEVEL_INDEX,
    SPLIT_MARKER_REASON_CODES, fingerprint_matches, parse_marker_csv, validate_markers,
)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TS_PATH = os.path.join(REPO_ROOT, "src", "shared", "splitMarkers.ts")

with open(TS_PATH, encoding="utf-8") as _f:
    TS_SOURCE = _f.read()


def _strip_ts_comments(s):
    return "\n".join(re.sub(r"//.*$", "", line) for line in s.split("\n"))


def _ts_reason_codes():
    m = re.search(r"^export const SPLIT_MARKER_REASON_CODES = \[(.*?)^\] as const",
                  TS_SOURCE, re.S | re.M)
    assert m, "TS SPLIT_MARKER_REASON_CODES 블록을 찾지 못함"
    return re.findall(r"'([A-Z_]+)'", _strip_ts_comments(m.group(1)))


def _ts_const(name):
    m = re.search(r"^export const %s = (-?[0-9.eE+-]+)\s*$" % name, TS_SOURCE, re.M)
    assert m, "TS 상수 %s 를 찾지 못함" % name
    return float(m.group(1))


def _codes(result):
    assert result["ok"] is False, "거부(reject)를 기대했는데 통과했다"
    return [e["reasonCode"] for e in result["errors"]]


class ParityTest(unittest.TestCase):
    def test_reason_codes_identical_to_ts(self):
        self.assertEqual(_ts_reason_codes(), list(SPLIT_MARKER_REASON_CODES))

    def test_shared_constants_identical_to_ts(self):
        self.assertEqual(_ts_const("MIN_TRACK_SECONDS"), MIN_TRACK_SECONDS)
        self.assertEqual(_ts_const("MAX_MARKER_COUNT"), MAX_MARKER_COUNT)
        self.assertEqual(_ts_const("TRACK_LENGTH_EPSILON"), TRACK_LENGTH_EPSILON)
        self.assertEqual(_ts_const("LIST_LEVEL_INDEX"), LIST_LEVEL_INDEX)

    def test_module_is_stdlib_only(self):
        """무거운 의존성 없이 import 되어야 한다(separate.py split 경로는 torch를 안 부른다)."""
        for banned in ("numpy", "torch", "soundfile", "librosa", "scipy"):
            self.assertNotIn(banned, sys.modules.get("split_markers").__dict__,
                             "%s 를 참조하면 안 된다" % banned)
        src_path = os.path.join(REPO_ROOT, "python", "split_markers.py")
        with open(src_path, encoding="utf-8") as f:
            body = "\n".join(re.sub(r"#.*$", "", ln) for ln in f.read().split("\n"))
        for banned in ("numpy", "torch", "soundfile", "librosa", "scipy"):
            self.assertIsNone(re.search(r"(?:^|\n)\s*(?:import|from)\s+%s\b" % banned, body),
                              "%s import 금지" % banned)


class AcceptTest(unittest.TestCase):
    def test_valid_markers_pass_unchanged(self):
        src = [30, 60.5, 120]
        r = validate_markers(src, 200)
        self.assertTrue(r["ok"])
        self.assertEqual(r["markers"], src)
        self.assertEqual(r["trackCount"], 4)
        self.assertFalse(r["autoSilenceSplit"])
        r["markers"].append(999)
        self.assertEqual(src, [30, 60.5, 120])  # 반환은 복사본

    def test_empty_markers_means_auto_silence_split(self):
        r = validate_markers([], 200)
        self.assertTrue(r["ok"])
        self.assertEqual(r["markers"], [])
        self.assertTrue(r["autoSilenceSplit"])
        self.assertIsNone(r["trackCount"])

    def test_empty_markers_ignore_duration_and_fingerprint(self):
        r = validate_markers([], 0, fingerprint="A", expected_fingerprint="B")
        self.assertTrue(r["ok"])

    def test_tuple_input_accepted(self):
        self.assertTrue(validate_markers((30, 60), 200)["ok"])


class BoundaryTest(unittest.TestCase):
    def test_marker_exactly_zero_rejected(self):
        self.assertEqual(_codes(validate_markers([0], 200)), ["MARKER_NOT_POSITIVE"])

    def test_negative_marker_rejected(self):
        errs = validate_markers([-0.5], 200)["errors"]
        self.assertEqual(errs[0]["reasonCode"], "MARKER_NOT_POSITIVE")
        self.assertEqual(errs[0]["value"], -0.5)
        self.assertEqual(errs[0]["limit"], 0)

    def test_marker_exactly_duration_rejected(self):
        self.assertEqual(_codes(validate_markers([200], 200)), ["MARKER_BEYOND_DURATION"])

    def test_marker_beyond_duration_carries_numeric_limit(self):
        errs = validate_markers([30, 500], 200)["errors"]
        self.assertEqual([e["reasonCode"] for e in errs], ["MARKER_BEYOND_DURATION"])
        self.assertEqual(errs[0]["index"], 1)
        self.assertEqual(errs[0]["value"], 500)
        self.assertEqual(errs[0]["limit"], 200)

    def test_two_markers_1ms_apart_rejected(self):
        errs = validate_markers([10, 10.001], 200)["errors"]
        self.assertEqual([e["reasonCode"] for e in errs], ["TRACK_TOO_SHORT"])
        self.assertEqual(errs[0]["index"], 1)
        self.assertEqual(errs[0]["limit"], MIN_TRACK_SECONDS)
        self.assertLess(errs[0]["value"], MIN_TRACK_SECONDS)

    def test_exactly_min_track_length_passes(self):
        self.assertTrue(validate_markers([MIN_TRACK_SECONDS, MIN_TRACK_SECONDS * 2], 100)["ok"])

    def test_binary_rounding_does_not_false_reject(self):
        # 10.2 - 9.2 = 0.9999999999999996
        self.assertTrue(validate_markers([9.2, 10.2], 100)["ok"])

    def test_short_first_and_last_track_indexes(self):
        first = validate_markers([0.5], 200)["errors"]
        self.assertEqual([(e["index"], e["reasonCode"]) for e in first], [(0, "TRACK_TOO_SHORT")])
        last = validate_markers([30, 199.5], 200)["errors"]
        self.assertEqual([(e["index"], e["reasonCode"]) for e in last], [(1, "TRACK_TOO_SHORT")])


class OrderTest(unittest.TestCase):
    def test_unsorted_rejected_not_sorted(self):
        errs = validate_markers([60, 30], 200)["errors"]
        self.assertEqual([e["reasonCode"] for e in errs], ["MARKER_NOT_INCREASING"])
        self.assertEqual(errs[0]["index"], 1)
        self.assertEqual(errs[0]["value"], 30)
        self.assertEqual(errs[0]["limit"], 60)

    def test_non_adjacent_repeat_violates_strict_increase(self):
        self.assertEqual(_codes(validate_markers([10, 20, 10], 200)), ["MARKER_NOT_INCREASING"])

    def test_adjacent_duplicate_rejected(self):
        errs = validate_markers([30, 30], 200)["errors"]
        self.assertEqual([e["reasonCode"] for e in errs], ["MARKER_DUPLICATE"])
        self.assertEqual(errs[0]["index"], 1)


class FiniteTest(unittest.TestCase):
    def test_non_finite_and_non_number_rejected(self):
        for bad in (float("nan"), float("inf"), float("-inf"), "30", True, None, [], {}):
            errs = validate_markers([bad], 200)["errors"]
            self.assertEqual([e["reasonCode"] for e in errs], ["MARKER_NOT_FINITE"], repr(bad))
            self.assertEqual(errs[0]["index"], 0)
            self.assertNotIn("value", errs[0])

    def test_nan_does_not_poison_order_comparison(self):
        errs = validate_markers([30, float("nan"), 60], 200)["errors"]
        self.assertEqual([(e["index"], e["reasonCode"]) for e in errs], [(1, "MARKER_NOT_FINITE")])


class ListLevelTest(unittest.TestCase):
    def test_count_exceeded_is_single_list_level_error(self):
        many = [(i + 1) * 10 for i in range(MAX_MARKER_COUNT + 1)]
        errs = validate_markers(many, 1e6)["errors"]
        self.assertEqual(len(errs), 1)
        self.assertEqual(errs[0]["reasonCode"], "MARKER_COUNT_EXCEEDED")
        self.assertEqual(errs[0]["index"], LIST_LEVEL_INDEX)
        self.assertEqual(errs[0]["value"], MAX_MARKER_COUNT + 1)
        self.assertEqual(errs[0]["limit"], MAX_MARKER_COUNT)

    def test_exactly_max_count_passes(self):
        many = [(i + 1) * 10 for i in range(MAX_MARKER_COUNT)]
        self.assertTrue(validate_markers(many, 1e6)["ok"])

    def test_invalid_duration_rejected(self):
        # separate.py 의 ffprobe 실패 경로(total_dur = 0)가 정확히 이 케이스다.
        for d in (0, -1, float("nan"), float("inf"), None, "200"):
            self.assertEqual(_codes(validate_markers([30], d)), ["DURATION_INVALID"], repr(d))
        errs = validate_markers([30], 0)["errors"]
        self.assertEqual(errs[0]["index"], LIST_LEVEL_INDEX)
        self.assertEqual(errs[0]["value"], 0)


class FingerprintTest(unittest.TestCase):
    def test_match_and_mismatch(self):
        self.assertTrue(validate_markers([30], 200, fingerprint="fp-1", expected_fingerprint="fp-1")["ok"])
        errs = validate_markers([30], 200, fingerprint="fp-1", expected_fingerprint="fp-2")["errors"]
        self.assertEqual(len(errs), 1)
        self.assertEqual(errs[0]["reasonCode"], "FINGERPRINT_MISMATCH")
        self.assertEqual(errs[0]["index"], LIST_LEVEL_INDEX)
        self.assertNotIn("value", errs[0])

    def test_mismatch_short_circuits_geometry(self):
        r = validate_markers([-5, 9999], 200, fingerprint="A", expected_fingerprint="B")
        self.assertEqual(_codes(r), ["FINGERPRINT_MISMATCH"])

    def test_fingerprint_matches_helper(self):
        self.assertTrue(fingerprint_matches(None, None))
        self.assertTrue(fingerprint_matches(None, ""))
        self.assertTrue(fingerprint_matches("  ", None))
        self.assertFalse(fingerprint_matches("fp", None))
        self.assertFalse(fingerprint_matches(None, "fp"))
        self.assertTrue(fingerprint_matches("fp", "fp"))
        self.assertTrue(fingerprint_matches(" fp ", "fp"))
        self.assertFalse(fingerprint_matches("fp", "FP"))


class NoSilentRepairTest(unittest.TestCase):
    def test_rejected_input_is_never_returned_fixed(self):
        dirty = [
            [60, 30],       # 정렬 필요
            [30, 30],       # 중복 제거 필요
            [0, 30],        # clamp 필요
            [30, 250],      # clamp 필요
            [30, float("nan")],  # 제거 필요
            [10, 10.001],   # 병합 필요
        ]
        for src in dirty:
            r = validate_markers(src, 200)
            self.assertFalse(r["ok"], repr(src))
            self.assertNotIn("markers", r)
            self.assertTrue(len(r["errors"]) > 0)

    def test_non_sequence_raises(self):
        self.assertRaises(TypeError, validate_markers, None, 200)
        self.assertRaises(TypeError, validate_markers, "30,60", 200)


class PayloadHygieneTest(unittest.TestCase):
    def test_every_reason_code_is_reachable(self):
        produced = set()
        cases = [
            ([float("nan")], 200, {}),
            ([0], 200, {}),
            ([200], 200, {}),
            ([60, 30], 200, {}),
            ([30, 30], 200, {}),
            ([10, 10.001], 200, {}),
            ([(i + 1) for i in range(MAX_MARKER_COUNT + 1)], 1e6, {}),
            ([30], 200, {"fingerprint": "A", "expected_fingerprint": "B"}),
            ([30], 0, {}),
        ]
        for markers, dur, kw in cases:
            for e in validate_markers(markers, dur, **kw)["errors"]:
                produced.add(e["reasonCode"])
        self.assertEqual(sorted(produced), sorted(SPLIT_MARKER_REASON_CODES))

    def test_errors_carry_only_index_code_and_numbers(self):
        allowed = {"index", "reasonCode", "value", "limit"}
        cases = [
            ([float("nan"), 0, 250, 30], 200, {}),
            ([30], 200, {"fingerprint": "/tmp/a.wav", "expected_fingerprint": "/tmp/b.wav"}),
            ([30], 0, {}),
            ([10, 10.001], 200, {}),
        ]
        for markers, dur, kw in cases:
            for e in validate_markers(markers, dur, **kw)["errors"]:
                self.assertTrue(set(e.keys()) <= allowed, repr(e))
                self.assertIsInstance(e["index"], int)
                self.assertIn(e["reasonCode"], SPLIT_MARKER_REASON_CODES)
                for k in ("value", "limit"):
                    if k in e:
                        self.assertIsInstance(e[k], (int, float))
                        self.assertNotIsInstance(e[k], bool)
                self.assertNotIn(".wav", repr(e))
                self.assertNotIn("tmp", repr(e))


class ParseMarkerCsvTest(unittest.TestCase):
    def test_parses_numbers_and_keeps_junk_for_rejection(self):
        self.assertEqual(parse_marker_csv("30,60.5,120"), [30.0, 60.5, 120.0])
        self.assertEqual(parse_marker_csv(""), [])
        self.assertEqual(parse_marker_csv(None), [])
        self.assertEqual(parse_marker_csv("30,,60"), [30.0, 60.0])  # 구분자 잡음만 무시
        self.assertEqual(parse_marker_csv("30,abc"), [30.0, "abc"])  # 조용히 버리지 않는다

    def test_nan_inf_tokens_survive_to_be_rejected(self):
        parsed = parse_marker_csv("nan,inf,30")
        self.assertEqual(_codes(validate_markers(parsed, 200)),
                         ["MARKER_NOT_FINITE", "MARKER_NOT_FINITE"])

    def test_junk_token_is_rejected_not_dropped(self):
        self.assertEqual(_codes(validate_markers(parse_marker_csv("30,abc"), 200)),
                         ["MARKER_NOT_FINITE"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
