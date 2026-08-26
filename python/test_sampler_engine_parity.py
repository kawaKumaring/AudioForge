# -*- coding: utf-8 -*-
"""ENGINE ↔ SAMPLER PARITY 권위 테스트 (Python, stdlib only). GPU·합성·모델 없음.

왜 있는가
─────────
표현형 운율 ENGINE(expressive_capability.py + expressive_planner.py)과 감정 샘플러
(emotion_sampler.py + src/shared/emotionSampler.ts)는 서로 다른 브랜치에서 자랐고 이제야
한 트리에 있다. 둘은 이미 어긋나 있으며, 지금까지 그 합의를 강제하는 것이 아무것도 없었다.
이 테스트가 그 권위다.

무엇을 하는가
─────────────
  1) Python 쪽 권위 튜플/집합을 **이 파일 안의 리터럴**과 대조한다(소스가 바뀌면 여기서 깨진다).
  2) 같은 리터럴을 공유 픽스처(test/fixtures/sampler-engine-parity.json)와 대조한다.
  3) TS 쪽 대응물을 **src/shared/*.ts 소스를 파싱**해 같은 픽스처와 대조한다
     (레포의 parity-by-parsing 선례: test_emotion_sampler.py, test_expressive_timeline.py).
  4) 픽스처의 canonical sha256 을 이 파일의 리터럴과 대조한다 — 픽스처를 고쳐 실패를
     무마하면 Python·TS 양쪽 해시 핀이 동시에 깨진다(coupling).
  5) 기록된 divergence(D1~D9)가 **여전히 그대로인지** 확인한다. 누가 production 을 고쳐
     일치시키면 이 테스트가 깨지고, 그때 divergence 표를 갱신하게 된다.

무엇을 하지 않는가
──────────────────
production 어휘를 바꿔서 parity 를 통과시키지 않는다. 진짜로 어긋나는 곳은
픽스처의 known_divergences 에 사유와 함께 '기록' 한다. 식별자 rename 은 이 테스트의 권한이 아니다.

실행:
  python -m unittest discover -s python -p "test_sampler_engine_parity.py"
"""
import hashlib
import io
import json
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import emotion_sampler as es           # noqa: E402  샘플러(Python 쪽)
import expressive_capability as cap    # noqa: E402  엔진 capability
import expressive_planner as pl        # noqa: E402  엔진 planner
import expressive_timeline as ex       # noqa: E402  언어 계약

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(REPO_ROOT, "test", "fixtures", "sampler-engine-parity.json")
TIMELINE_FIXTURE = os.path.join(REPO_ROOT, "test", "fixtures", "expressive-timeline-v3.json")
TS_SAMPLER = os.path.join(REPO_ROOT, "src", "shared", "emotionSampler.ts")
TS_TIMELINE = os.path.join(REPO_ROOT, "src", "shared", "expressiveTimeline.ts")
SRC_DIR = os.path.join(REPO_ROOT, "src")

# 픽스처의 canonical sha256(키 정렬 · 공백 없음 · UTF-8). 같은 리터럴이
# src/shared/samplerEngineParity.test.ts 에도 박혀 있다 — 그것이 두 언어를 묶는 고리다.
FIXTURE_CANONICAL_SHA256 = "c41615291b6f34413745d7dd69dfb09a3433875d909a2eb3d1e98155acccbbc8"


def _read(path):
    """⚠️ core.autocrlf=true 인 레포다. 소스를 '파싱' 하므로 개행을 LF 로 정규화한다."""
    with io.open(path, encoding="utf-8") as f:
        return f.read().replace("\r\n", "\n")


def _load(path):
    with io.open(path, encoding="utf-8") as f:
        return json.load(f)


FX = _load(FIXTURE)
TL_FX = _load(TIMELINE_FIXTURE)
TS_SAMPLER_SRC = _read(TS_SAMPLER)
TS_TIMELINE_SRC = _read(TS_TIMELINE)


def _strip_ts_line_comments(block):
    """줄 주석(//)을 떼어낸다 — 주석 안의 따옴표가 원소 추출을 오염시키지 않도록."""
    return "\n".join(l if l.find("//") < 0 else l[:l.find("//")] for l in block.split("\n"))


def ts_string_array(src, name):
    """`export const NAME[...] = ['a','b'] as const` / `= Object.freeze(['a','b'])` → ['a','b']"""
    m = re.search(r"export const " + re.escape(name) + r"\b[^=]*=\s*(?:Object\.freeze\()?\[([\s\S]*?)\]",
                  src)
    if m is None:
        raise AssertionError("TS 소스에서 %s 배열을 찾지 못함" % name)
    return re.findall(r"'([^']*)'", _strip_ts_line_comments(m.group(1)))


def ts_state_reasons(src):
    """EMOTION_SAMPLE_STATE_REASONS 의 상태별 사유 배열을 뽑는다."""
    m = re.search(r"export const EMOTION_SAMPLE_STATE_REASONS[\s\S]*?=\s*\n?\s*Object\.freeze\(\{([\s\S]*?)\n\s*\}\)",
                  src)
    if m is None:
        raise AssertionError("TS 소스에서 EMOTION_SAMPLE_STATE_REASONS 를 찾지 못함")
    body = _strip_ts_line_comments(m.group(1))
    out = {}
    for key, arr in re.findall(r"(\w+):\s*Object\.freeze\(\[([\s\S]*?)\]\)", body):
        out[key] = re.findall(r"'([^']*)'", arr)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 이 파일이 들고 있는 '기대 리터럴'. 픽스처와도, production 과도, TS 와도 대조된다.
# 세 곳(여기 · 픽스처 · TS 테스트) 중 하나만 고치면 반드시 어딘가 깨진다.
# ─────────────────────────────────────────────────────────────────────────────

EXPECT_ENGINE_CAPABILITY_STATES = ["supported", "degraded", "unsupported", "unknown"]
EXPECT_ENGINE_UNVERIFIED_STATE = "unknown"
EXPECT_ENGINE_STATE_RANK = {"unsupported": 0, "degraded": 1, "supported": 2}
EXPECT_PUNCTUATION_REALIZATIONS = ["model_native", "post_process", "unsupported"]
EXPECT_ENGINE_CAP_VOWEL_CLASSES = ["open_vowel", "sustainable_final", "non_sustainable_final"]
EXPECT_ENGINE_CAP_VOWEL_ADAPTERS = ["final_consonant_unclassified", "no_target"]
EXPECT_ENGINE_UNSUPPORTED_CODES = [
    "PROSODY_NO_REALIZATION", "VOWEL_EXTEND_NO_TARGET", "VOWEL_EXTEND_NOT_REALIZABLE",
    "LAUGH_NO_STRATEGY", "UNIT_EXCEEDS_GENERATION_LIMIT",
]
EXPECT_ENGINE_DEGRADATION_CODES = [
    "REFERENCE_X_VECTOR_ONLY", "EMOTION_HARD_JOIN", "EMOTION_OVERLAP_EXPERIMENTAL",
    "MID_UNIT_EMOTION_TRANSITION_DEFERRED", "NON_DETERMINISTIC_SEED",
    "PUNCTUATION_POST_PROCESS_ONLY", "LAUGH_CACHED_SAMPLE",
    "LAUGH_VOICE_TRANSFORM_EXPERIMENTAL", "VOWEL_EXTEND_NON_SUSTAINABLE_FINAL",
    "CAPABILITY_UNVERIFIED",
]
EXPECT_ENGINE_STRATEGY_REASONS = [
    "CONTINUOUS_WEIGHTS_SUPPORTED", "INLINE_INSTRUCTION_SUPPORTED",
    "NO_INLINE_SUPPORT_FALLBACK_OVERLAP", "NO_CONTEXT_SUPPORT_LAST_RESORT",
    "CAPABILITY_UNVERIFIED_FALLBACK",
]

EXPECT_SAMPLER_CAPABILITY_MIRROR = ["supported", "degraded", "unsupported", "unknown"]
EXPECT_SAMPLER_OUTCOME_STATES = [
    "idle", "generating", "ready", "degraded", "limitExceeded", "failed",
    "unsupported", "unverified",
]
EXPECT_SAMPLER_REASON_CODES = [
    "SAMPLER_XVECTOR_ONLY", "SAMPLER_GENERATION_LIMIT", "SAMPLER_ENGINE_ERROR",
    "SAMPLER_REFERENCE_MISSING", "SAMPLER_CANCELLED", "SAMPLER_UNKNOWN",
    "LAUGH_NO_STRATEGY", "VOWEL_EXTEND_NOT_REALIZABLE", "CAPABILITY_UNVERIFIED",
]
EXPECT_SHARED_REASON_CODES = [
    "LAUGH_NO_STRATEGY", "VOWEL_EXTEND_NOT_REALIZABLE", "CAPABILITY_UNVERIFIED",
]
EXPECT_STATE_AXIS_MAPPING = {
    "supported": "idle", "degraded": "unverified",
    "unsupported": "unsupported", "unknown": "unverified",
}

EXPECT_LOCAL_PROSODY_KINDS = [
    "firm_end", "fade_end", "emphasis", "question_rise", "shock_rise", "vowel_extend",
]
EXPECT_LAUGH_STYLES = ["chuckle", "breathy", "bashful", "open", "high_giggle"]
EXPECT_LAUGH_POSITIONS = ["leading", "inline", "trailing", "standalone"]
EXPECT_LANGUAGE_VOWEL_CLASSES = [
    "open_vowel", "sustainable_final", "non_sustainable_final", "undeterminable",
]

# 엔진 전용 — src/ 어디에도 나타나면 안 된다(TS 쪽에 몰래 병렬 어휘가 생기는 것을 막는다).
EXPECT_ENGINE_ONLY_SYMBOLS = [
    "CAPABILITY_UNVERIFIED_FALLBACK", "PUNCTUATION_REALIZATIONS",
    "PROSODY_NO_REALIZATION", "VOWEL_EXTEND_NO_TARGET", "UNIT_EXCEEDS_GENERATION_LIMIT",
]


# ─────────────────────────────────────────────────────────────────────────────
class FixtureCouplingTest(unittest.TestCase):
    """coupling — 픽스처를 조용히 고쳐 실패를 무마할 수 없게 만든다."""

    def test_canonical_digest_pinned(self):
        s = json.dumps(FX, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        got = hashlib.sha256(s.encode("utf-8")).hexdigest()
        self.assertEqual(got, FIXTURE_CANONICAL_SHA256,
                         "픽스처가 바뀌었다. 의도한 변경이면 Python·TS 두 테스트의 해시 핀을 함께 갱신할 것.")

    def test_versions_pinned(self):
        m = FX["_meta"]
        self.assertEqual(m["capability_contract_version"], cap.CAPABILITY_CONTRACT_VERSION)
        self.assertEqual(m["plan_version"], pl.PLAN_VERSION)
        self.assertEqual(m["expressive_contract_version"], ex.EXPRESSIVE_CONTRACT_VERSION)
        self.assertEqual(m["expressive_contract_version"], 3, "EXPRESSIVE_CONTRACT_VERSION 은 3 으로 남는다")
        self.assertEqual(m["sampler_key_version"], es.EMOTION_SAMPLER_KEY_VERSION)
        self.assertEqual(m["sampler_phrase_version"], es.EMOTION_SAMPLER_PHRASE_VERSION)

    def test_ts_counterpart_declaration_is_true(self):
        """ENGINE 에는 TS 모듈이 없다. 픽스처의 그 선언이 사실인지 파일 존재로 확인한다."""
        self.assertFalse(FX["_meta"]["engine_has_typescript_counterpart"])
        for name in ("expressiveCapability.ts", "expressivePlanner.ts"):
            self.assertFalse(os.path.exists(os.path.join(REPO_ROOT, "src", "shared", name)),
                             "%s 가 생겼다면 픽스처 선언을 갱신해야 한다" % name)
        # 혼동 금지 대상은 실제로 존재하고, 4상태 어휘를 갖지 않는다.
        not_cp = os.path.join(REPO_ROOT, FX["_meta"]["not_the_counterpart"].replace("/", os.sep))
        self.assertTrue(os.path.exists(not_cp))
        src = _read(not_cp)
        for token in ("'supported'", "'degraded'", "'unsupported'", "'unknown'"):
            self.assertNotIn(token, src,
                             "ttsExpressionCapabilities.ts 에 capability 4상태 어휘가 생겼다 — 계약 재검토 필요")


# ─────────────────────────────────────────────────────────────────────────────
class Item1CapabilityStateAxisTest(unittest.TestCase):
    """항목 1 — capability 상태 이름. 두 축이 다르므로 집합 동일성이 아니라 MAPPING 을 고정한다."""

    def test_engine_capability_states(self):
        self.assertEqual(list(cap.CAPABILITY_STATES), EXPECT_ENGINE_CAPABILITY_STATES)
        self.assertEqual(FX["engine"]["capability_states"], EXPECT_ENGINE_CAPABILITY_STATES)
        self.assertEqual(cap.UNVERIFIED_STATE, EXPECT_ENGINE_UNVERIFIED_STATE)
        self.assertEqual(FX["engine"]["unverified_state"], EXPECT_ENGINE_UNVERIFIED_STATE)
        self.assertEqual(cap.CAPABILITY_STATE_RANK, EXPECT_ENGINE_STATE_RANK)
        self.assertEqual(FX["engine"]["capability_state_rank"], EXPECT_ENGINE_STATE_RANK)
        # 'unknown' 은 순위가 없다 — 미검증이 강등보다 낫다고 비교당하지 않게.
        self.assertNotIn(cap.UNVERIFIED_STATE, cap.CAPABILITY_STATE_RANK)
        self.assertEqual(list(cap.CAPABILITY_RESOLUTION_REASONS),
                         FX["engine"]["capability_resolution_reasons"])

    def test_sampler_mirrors_engine_capability_vocabulary_byte_identical(self):
        """샘플러는 엔진 4상태를 '별도 상수' 로 미러링한다. 그 미러는 엔진과 바이트 동일해야 한다."""
        self.assertEqual(list(es.EMOTION_SAMPLER_CAPABILITY_STATES), EXPECT_SAMPLER_CAPABILITY_MIRROR)
        self.assertEqual(list(es.EMOTION_SAMPLER_CAPABILITY_STATES), list(cap.CAPABILITY_STATES))
        self.assertEqual(FX["sampler"]["capability_states_mirror"], EXPECT_SAMPLER_CAPABILITY_MIRROR)
        self.assertEqual(ts_string_array(TS_SAMPLER_SRC, "EMOTION_SAMPLER_CAPABILITY_STATES"),
                         EXPECT_SAMPLER_CAPABILITY_MIRROR)
        self.assertEqual(FX["sampler"]["capability_states_mirror_symbol"],
                         "EMOTION_SAMPLER_CAPABILITY_STATES")

    def test_sampler_outcome_states_are_a_different_axis(self):
        self.assertEqual(list(es.EMOTION_SAMPLE_STATES), EXPECT_SAMPLER_OUTCOME_STATES)
        self.assertEqual(FX["sampler"]["outcome_states"], EXPECT_SAMPLER_OUTCOME_STATES)
        self.assertEqual(ts_string_array(TS_SAMPLER_SRC, "EMOTION_SAMPLE_STATES"),
                         EXPECT_SAMPLER_OUTCOME_STATES)
        # 두 축은 집합이 다르다. 같아지길 요구하지 않는다 — 다르다는 사실을 고정한다.
        self.assertNotEqual(set(es.EMOTION_SAMPLE_STATES), set(cap.CAPABILITY_STATES))
        # 샘플러에는 'supported' 라는 이름의 결과 상태가 없다(capability 축의 값이다).
        self.assertNotIn("supported", es.EMOTION_SAMPLE_STATES)
        self.assertTrue(FX["state_axis_mapping"]["sampler_has_no_outcome_state_named_supported"])
        # 반대로 엔진 capability 축에는 'unverified' 라는 이름이 없다.
        self.assertNotIn("unverified", cap.CAPABILITY_STATES)
        self.assertTrue(FX["state_axis_mapping"]["engine_unknown_is_named_unverified_in_sampler"])

    def test_mapping_engine_state_to_sampler_outcome(self):
        """항목 1의 핵심: 주석에만 적혀 있던 대응을 실행 가능한 단언으로 바꾼다."""
        self.assertEqual(FX["state_axis_mapping"]["capability_state_to_outcome_state"],
                         EXPECT_STATE_AXIS_MAPPING)
        for st in cap.CAPABILITY_STATES:
            self.assertEqual(es.state_for_capability({"state": st, "reason": None}),
                             EXPECT_STATE_AXIS_MAPPING[st], "capability %s 의 매핑" % st)
        # 'unverified' 가 곧 엔진 'unknown' 이다(주석이 아니라 코드로 확인).
        self.assertEqual(es.state_for_capability({"state": cap.UNVERIFIED_STATE, "reason": None}),
                         "unverified")
        # usable 은 'supported' 하나뿐 — 양쪽 모두.
        for st in cap.CAPABILITY_STATES:
            self.assertEqual(cap.is_usable(st), es.is_capability_usable(st), "is_usable(%s)" % st)
            self.assertEqual(cap.is_usable(st), st == "supported")
        self.assertEqual(FX["state_axis_mapping"]["usable_capability_states"], ["supported"])
        self.assertEqual(FX["state_axis_mapping"]["supported_maps_to_outcome"], "idle")

    def test_outcome_states_unreachable_from_capability(self):
        reachable = {EXPECT_STATE_AXIS_MAPPING[s] for s in cap.CAPABILITY_STATES}
        unreachable = [s for s in es.EMOTION_SAMPLE_STATES if s not in reachable]
        self.assertEqual(unreachable, FX["state_axis_mapping"]["outcome_states_unreachable_from_capability"])
        # D4: 샘플러 'degraded' 는 capability 강등으로는 절대 도달하지 않는다.
        self.assertIn("degraded", unreachable)


# ─────────────────────────────────────────────────────────────────────────────
class Item2And3SharedReasonCodesTest(unittest.TestCase):
    """항목 2·3 — 공유 사유 코드는 바이트 동일해야 한다."""

    def test_shared_codes_are_byte_identical(self):
        shared = [r["code"] for r in FX["shared_reason_codes"]]
        self.assertEqual(shared, EXPECT_SHARED_REASON_CODES)
        ts_codes = ts_string_array(TS_SAMPLER_SRC, "EMOTION_SAMPLE_REASON_CODES")
        self.assertEqual(ts_codes, EXPECT_SAMPLER_REASON_CODES)
        self.assertEqual(list(es.EMOTION_SAMPLE_REASON_CODES), EXPECT_SAMPLER_REASON_CODES)
        engine_all = set(pl.UNSUPPORTED_CODES) | set(pl.DEGRADATION_CODES)
        for row in FX["shared_reason_codes"]:
            code = row["code"]
            self.assertIn(code, engine_all, "%s 가 엔진 코드 집합에 없다" % code)
            self.assertIn(code, es.EMOTION_SAMPLE_REASON_CODES, "%s 가 샘플러 코드 집합에 없다" % code)
            self.assertIn(code, ts_codes, "%s 가 TS 샘플러 코드 집합에 없다" % code)
            home = pl.UNSUPPORTED_CODES if row["engine_home"] == "UNSUPPORTED_CODES" else pl.DEGRADATION_CODES
            self.assertIn(code, home, "%s 의 엔진 소속 튜플" % code)
            self.assertIn(code, es.EMOTION_SAMPLE_STATE_REASONS[row["sampler_outcome_state"]],
                          "%s 가 샘플러 상태 %s 의 사유여야 한다" % (code, row["sampler_outcome_state"]))

    def test_laugh_no_strategy_is_reachable_on_both_sides(self):
        """항목 2 — 미검증 프로필에서 웃음은 양쪽 다 unsupported/LAUGH_NO_STRATEGY 다."""
        v = FX["laugh_verdict"]
        sel = pl.select_laugh_strategy(cap.unknown_profile())
        self.assertIsNone(sel["strategy"])
        self.assertEqual(sel["reason"], v["engine_strategy_reason"])
        self.assertIn(v["engine_unsupported_code"], pl.UNSUPPORTED_CODES)
        laugh_rows = [r for r in es.EMOTION_SAMPLE_ROWS if r["family"] == "laugh"]
        self.assertGreater(len(laugh_rows), 0)
        for r in laugh_rows:
            c = es.capability_for_row(r["row_id"])
            self.assertEqual(c["state"], v["sampler_capability_state"], r["row_id"])
            self.assertEqual(c["reason"], v["sampler_capability_reason"], r["row_id"])
            self.assertEqual(es.state_for_capability(c), v["sampler_outcome_state"], r["row_id"])
        self.assertTrue(v["agrees"])

    def test_vowel_extend_not_realizable_exists_on_both_sides(self):
        """항목 3 — Python 에도 존재한다(planner UNSUPPORTED_CODES). 이름이 같다."""
        self.assertIn("VOWEL_EXTEND_NOT_REALIZABLE", pl.UNSUPPORTED_CODES)
        self.assertIn("VOWEL_EXTEND_NOT_REALIZABLE", es.EMOTION_SAMPLE_REASON_CODES)
        self.assertIn("VOWEL_EXTEND_NOT_REALIZABLE",
                      ts_string_array(TS_SAMPLER_SRC, "EMOTION_SAMPLE_REASON_CODES"))
        # 엔진 쪽에는 '지속 불가 받침' 강등 코드가 따로 또 있다(같은 상황의 다른 축).
        self.assertIn("VOWEL_EXTEND_NON_SUSTAINABLE_FINAL", pl.DEGRADATION_CODES)
        self.assertNotIn("VOWEL_EXTEND_NON_SUSTAINABLE_FINAL", es.EMOTION_SAMPLE_REASON_CODES)

    def test_engine_only_vocabulary_has_no_typescript_twin(self):
        """항목 2 후반 + 항목 7 — 엔진 전용 어휘가 TS 에 병렬로 생기지 않았는지."""
        symbols = [row["symbol"] for row in FX["engine_only_vocabulary"]]
        self.assertEqual(symbols, EXPECT_ENGINE_ONLY_SYMBOLS)
        self.assertIn("CAPABILITY_UNVERIFIED_FALLBACK", pl.STRATEGY_REASON_CODES)
        scanned = 0
        for root, _dirs, files in os.walk(SRC_DIR):
            if "node_modules" in root:
                continue
            for fn in files:
                # 테스트 파일은 제외한다 — parity 테스트 자신이 이 이름들을 문자열로 들고 있다.
                if not fn.endswith((".ts", ".tsx")) or ".test." in fn:
                    continue
                scanned += 1
                body = _read(os.path.join(root, fn))
                for sym in EXPECT_ENGINE_ONLY_SYMBOLS:
                    self.assertNotIn(sym, body,
                                     "엔진 전용 %s 가 %s 에 나타났다 — 병렬 어휘 금지" % (sym, fn))
        # 스캔이 조용히 0개가 되어 통과하는 일이 없게(경로가 틀리면 여기서 깨진다).
        self.assertGreater(scanned, 5, "src 트리를 실제로 훑지 못했다 — 경로 확인")
        # 픽스처가 '왜 대응물이 없는지' 를 비워 두지 않았는지.
        for row in FX["engine_only_vocabulary"]:
            self.assertIsNone(row["sampler_counterpart"])
            self.assertTrue(row["why"].strip(), "%s 의 사유가 비어 있다" % row["symbol"])

    def test_capability_unverified_fallback_is_projected_to_the_shared_code(self):
        """D8 — FALLBACK 은 샘플러 대응물이 없는 대신, 엔진이 공유 코드로 투영한다."""
        prof = cap.unknown_profile()
        sel = pl.select_emotion_strategy(prof)
        self.assertEqual(sel["reason"], "CAPABILITY_UNVERIFIED_FALLBACK")
        self.assertNotIn("CAPABILITY_UNVERIFIED_FALLBACK", es.EMOTION_SAMPLE_REASON_CODES)
        # 투영 지점: FALLBACK → 공유 코드 CAPABILITY_UNVERIFIED(강등).
        src = _read(os.path.join(REPO_ROOT, "python", "expressive_planner.py"))
        self.assertRegex(
            src,
            r'selection\["reason"\]\s*==\s*"CAPABILITY_UNVERIFIED_FALLBACK"[\s\S]{0,200}?'
            r'"code":\s*"CAPABILITY_UNVERIFIED"',
            "FALLBACK → CAPABILITY_UNVERIFIED 투영이 사라졌다")


# ─────────────────────────────────────────────────────────────────────────────
class Item4And5And6LanguageContractTest(unittest.TestCase):
    """항목 4·5·6 — 언어 계약 어휘와 그 실제 파싱 결과를 두 언어에 고정한다."""

    def test_laugh_style_and_position_ids(self):
        lc = FX["language_contract"]
        self.assertEqual(list(ex.LAUGH_STYLES), EXPECT_LAUGH_STYLES)
        self.assertEqual(list(ex.LAUGH_POSITIONS), EXPECT_LAUGH_POSITIONS)
        self.assertEqual(lc["laugh_styles"], EXPECT_LAUGH_STYLES)
        self.assertEqual(lc["laugh_positions"], EXPECT_LAUGH_POSITIONS)
        self.assertEqual(ts_string_array(TS_TIMELINE_SRC, "LAUGH_STYLES"), EXPECT_LAUGH_STYLES)
        self.assertEqual(ts_string_array(TS_TIMELINE_SRC, "LAUGH_POSITIONS"), EXPECT_LAUGH_POSITIONS)
        # 집합 동일 + 순서 동일(순서 차이는 드리프트의 첫 징후다).
        self.assertEqual(set(ex.LAUGH_STYLES), set(EXPECT_LAUGH_STYLES))
        self.assertEqual(len(set(ex.LAUGH_STYLES)), len(ex.LAUGH_STYLES))
        self.assertEqual(len(set(ex.LAUGH_POSITIONS)), len(ex.LAUGH_POSITIONS))

    def test_punctuation_kind_ids(self):
        lc = FX["language_contract"]
        self.assertEqual(list(ex.LOCAL_PROSODY_KINDS), EXPECT_LOCAL_PROSODY_KINDS)
        self.assertEqual(lc["local_prosody_kinds"], EXPECT_LOCAL_PROSODY_KINDS)
        self.assertEqual(ts_string_array(TS_TIMELINE_SRC, "LOCAL_PROSODY_KINDS"),
                         EXPECT_LOCAL_PROSODY_KINDS)

    def test_punctuation_vectors_parse_to_the_pinned_kind(self):
        """항목 5 — 실제 파서를 돌려 종류 id 를 고정한다(픽스처가 TS 쪽에도 같은 기대를 준다)."""
        seen = set()
        for v in FX["punctuation_kind_vectors"]:
            r = ex.parse_expressive_timeline(v["input"], mode="expressive_v3")
            self.assertTrue(r["ok"], v["id"])
            lp = r["timeline"]["local_prosody"]
            self.assertEqual(len(lp), v["event_count"], "%s 이벤트 수" % v["id"])
            self.assertEqual(lp[0]["kind"], v["kind"], "%s kind" % v["id"])
            seen.add(v["kind"])
        self.assertEqual(sorted(seen), sorted(EXPECT_LOCAL_PROSODY_KINDS),
                         "구두점 종류 전부를 벡터가 덮어야 한다")

    def test_qbang_is_an_alias_never_two_events(self):
        """항목 5 — '?!' 는 '!?' 의 별칭. shock_rise 하나이고 절대 둘이 아니다."""
        for pair in FX["punctuation_alias_pairs"]:
            a = ex.parse_expressive_timeline(pair["canonical_input"], mode="expressive_v3")
            b = ex.parse_expressive_timeline(pair["alias_input"], mode="expressive_v3")
            for res, label in ((a, "canonical"), (b, "alias")):
                self.assertTrue(res["ok"], "%s/%s" % (pair["id"], label))
                lp = res["timeline"]["local_prosody"]
                self.assertEqual(len(lp), pair["event_count"], "%s/%s 이벤트 수" % (pair["id"], label))
                self.assertEqual(lp[0]["kind"], pair["kind"], "%s/%s kind" % (pair["id"], label))
            ta = a["timeline"]["local_prosody"][0]["raw_token"]
            tb = b["timeline"]["local_prosody"][0]["raw_token"]
            if pair["raw_token_differs"]:
                self.assertNotEqual(ta, tb, "원문 토큰은 구분되어야 한다(round-trip)")
            # emphasis/question_rise 로 쪼개지지 않았다.
            self.assertNotIn("emphasis", [e["kind"] for e in a["timeline"]["local_prosody"]])
            self.assertNotIn("question_rise", [e["kind"] for e in b["timeline"]["local_prosody"]])

    def test_dot_run_rule(self):
        """항목 5 — 홑점 1개는 firm_end, 2개 이상은 fade_end."""
        rule = FX["dot_run_rule"]
        self.assertEqual(rule["firm_end_max_count"], 1)
        self.assertEqual(rule["fade_end_min_count"], 2)
        for n in range(1, ex.DOT_RUN_MAX_COUNT + 1):
            r = ex.parse_expressive_timeline("끝" + ("." * n), mode="expressive_v3")
            self.assertTrue(r["ok"], "dot x%d" % n)
            lp = r["timeline"]["local_prosody"]
            self.assertEqual(len(lp), 1, "점 런은 항상 토큰 하나 (n=%d)" % n)
            expected = "firm_end" if n <= rule["firm_end_max_count"] else "fade_end"
            self.assertEqual(lp[0]["kind"], expected, "dot x%d" % n)

    def test_vowel_extend_classes_and_language_layer_silence(self):
        """항목 6 — 3분류(+undeterminable)가 두 언어에서 같고, 언어층은 음향 품질을 단언하지 않는다."""
        lc = FX["language_contract"]
        self.assertEqual(list(ex.VOWEL_EXTEND_CLASSES), EXPECT_LANGUAGE_VOWEL_CLASSES)
        self.assertEqual(lc["vowel_extend_classes"], EXPECT_LANGUAGE_VOWEL_CLASSES)
        self.assertEqual(ts_string_array(TS_TIMELINE_SRC, "VOWEL_EXTEND_CLASSES"),
                         EXPECT_LANGUAGE_VOWEL_CLASSES)
        self.assertFalse(lc["language_layer_asserts_acoustic_quality"])
        self.assertFalse(lc["sustainable_final_is_acoustically_verified"])
        self.assertEqual(ex.LANGUAGE_LAYER_ASSERTS_ACOUSTIC_QUALITY,
                         lc["language_layer_asserts_acoustic_quality"])
        self.assertEqual(ex.SUSTAINABLE_FINAL_IS_ACOUSTICALLY_VERIFIED,
                         lc["sustainable_final_is_acoustically_verified"])

    def test_vowel_extend_class_vectors(self):
        seen = set()
        for v in FX["vowel_extend_class_vectors"]:
            r = ex.parse_expressive_timeline(v["input"], mode="expressive_v3")
            self.assertTrue(r["ok"], v["id"])
            lp = r["timeline"]["local_prosody"]
            self.assertEqual(len(lp), 1, v["id"])
            self.assertEqual(lp[0]["kind"], "vowel_extend", v["id"])
            self.assertEqual(lp[0]["vowel_extend"]["classification"], v["classification"], v["id"])
            seen.add(v["classification"])
        self.assertEqual(sorted(seen), sorted(EXPECT_LANGUAGE_VOWEL_CLASSES),
                         "4분류 전부를 벡터가 덮어야 한다")

    def test_language_contract_agrees_with_the_timeline_fixture(self):
        """권위 이중화 금지 — 새 픽스처의 언어 어휘가 기존 언어 픽스처와 같은 값인지."""
        m = TL_FX["_meta"]
        lc = FX["language_contract"]
        self.assertEqual(lc["local_prosody_kinds"], m["local_prosody_kinds"])
        self.assertEqual(lc["laugh_styles"], m["laugh_styles"])
        self.assertEqual(lc["laugh_positions"], m["laugh_positions"])
        self.assertEqual(lc["vowel_extend_classes"], m["vowel_extend_classes"])
        self.assertEqual(lc["language_layer_asserts_acoustic_quality"],
                         m["invariants"]["language_layer_asserts_acoustic_quality"])
        self.assertEqual(lc["sustainable_final_is_acoustically_verified"],
                         m["invariants"]["sustainable_final_is_acoustically_verified"])
        self.assertEqual(FX["_meta"]["expressive_contract_version"], m["contract_version"])


# ─────────────────────────────────────────────────────────────────────────────
class Item7PunctuationRealizationTest(unittest.TestCase):
    """항목 7 — PUNCTUATION_REALIZATIONS. 엔진 전용임을 고정한다."""

    def test_engine_tuple_pinned(self):
        self.assertEqual(list(pl.PUNCTUATION_REALIZATIONS), EXPECT_PUNCTUATION_REALIZATIONS)
        self.assertEqual(FX["engine"]["punctuation_realizations"], EXPECT_PUNCTUATION_REALIZATIONS)

    def test_realization_axis_is_not_the_capability_state_axis(self):
        """'unsupported' 가 두 축에 같은 글자로 있다 — 같은 것으로 취급하면 안 된다."""
        overlap = set(pl.PUNCTUATION_REALIZATIONS) & set(cap.CAPABILITY_STATES)
        self.assertEqual(overlap, {"unsupported"}, "겹치는 토큰은 'unsupported' 하나뿐이어야 한다")
        self.assertNotEqual(set(pl.PUNCTUATION_REALIZATIONS), set(cap.CAPABILITY_STATES))
        # 실현 축은 상태 축의 부분집합도 상위집합도 아니다.
        self.assertTrue(set(pl.PUNCTUATION_REALIZATIONS) - set(cap.CAPABILITY_STATES))
        self.assertTrue(set(cap.CAPABILITY_STATES) - set(pl.PUNCTUATION_REALIZATIONS))

    def test_every_prosody_kind_has_a_declared_realization_path(self):
        """조용히 버려지는 종류가 없다 — 후처리 op 가 없으면 unsupported 로 드러난다."""
        for kind in ex.LOCAL_PROSODY_KINDS:
            self.assertIn(kind, pl.PROSODY_POST_PROCESS_OP, kind)
        no_pp = sorted(k for k, v in pl.PROSODY_POST_PROCESS_OP.items() if v is None)
        self.assertEqual(no_pp, ["firm_end", "shock_rise"],
                         "후처리 등가물이 없는 종류가 바뀌었다 — 픽스처/문서를 갱신할 것")


# ─────────────────────────────────────────────────────────────────────────────
class EngineCodeTuplesTest(unittest.TestCase):
    """엔진 코드 튜플 전체를 리터럴과 픽스처에 고정(공유/전용 판정의 기반)."""

    def test_unsupported_and_degradation_and_strategy_codes(self):
        self.assertEqual(list(pl.UNSUPPORTED_CODES), EXPECT_ENGINE_UNSUPPORTED_CODES)
        self.assertEqual(FX["engine"]["unsupported_codes"], EXPECT_ENGINE_UNSUPPORTED_CODES)
        self.assertEqual(list(pl.DEGRADATION_CODES), EXPECT_ENGINE_DEGRADATION_CODES)
        self.assertEqual(FX["engine"]["degradation_codes"], EXPECT_ENGINE_DEGRADATION_CODES)
        self.assertEqual(list(pl.STRATEGY_REASON_CODES), EXPECT_ENGINE_STRATEGY_REASONS)
        self.assertEqual(FX["engine"]["strategy_reason_codes"], EXPECT_ENGINE_STRATEGY_REASONS)
        self.assertEqual(list(pl.LAUGH_STRATEGY_REASONS), FX["engine"]["laugh_strategy_reasons"])
        self.assertEqual(list(cap.VOWEL_EXTEND_VERDICT_REASONS),
                         FX["engine"]["vowel_extend_verdict_reasons"])

    def test_sampler_only_codes_never_appear_in_the_engine(self):
        engine_all = set(pl.UNSUPPORTED_CODES) | set(pl.DEGRADATION_CODES) | \
            set(pl.STRATEGY_REASON_CODES) | set(pl.LAUGH_STRATEGY_REASONS) | \
            set(pl.SPLIT_REASON_CODES)
        for code in FX["sampler"]["sampler_only_reason_codes"]:
            self.assertIn(code, es.EMOTION_SAMPLE_REASON_CODES, code)
            self.assertNotIn(code, engine_all, "%s 는 샘플러 전용이어야 한다" % code)
        derived = [c for c in es.EMOTION_SAMPLE_REASON_CODES if c not in EXPECT_SHARED_REASON_CODES]
        self.assertEqual(derived, FX["sampler"]["sampler_only_reason_codes"])

    def test_sampler_state_reasons_match_ts(self):
        ts_map = ts_state_reasons(TS_SAMPLER_SRC)
        fx_map = FX["sampler"]["state_reasons"]
        self.assertEqual(sorted(ts_map), sorted(es.EMOTION_SAMPLE_STATES))
        for st in es.EMOTION_SAMPLE_STATES:
            self.assertEqual(list(es.EMOTION_SAMPLE_STATE_REASONS[st]), fx_map[st], st)
            self.assertEqual(ts_map[st], fx_map[st], "TS 상태 %s 사유" % st)


# ─────────────────────────────────────────────────────────────────────────────
class KnownDivergenceTest(unittest.TestCase):
    """기록만 하고 고치지 않은 불일치. 여기서 '여전히 불일치인지' 를 확인한다.

    누군가 production 을 고쳐 일치시키면 이 테스트가 깨진다 — 그러면 divergence 표를
    갱신하라는 신호다. 반대로 테스트를 통과시키려고 production 을 고치는 일은 금지다.
    """

    def setUp(self):
        self.byid = {d["id"]: d for d in FX["known_divergences"]}

    def test_all_divergences_have_an_unfixable_reason(self):
        self.assertEqual(sorted(self.byid), ["D%d" % i for i in range(1, 10)])
        for d in FX["known_divergences"]:
            self.assertTrue(d["title"].strip(), d["id"])
            self.assertTrue(d["why_not_fixable_by_test"].strip(), d["id"])

    def test_vowel_extend_verdict_table_is_still_true(self):
        """D1·D2 의 실체. 엔진 판정과 샘플러 판정을 같은 입력으로 나란히 재유도한다."""
        prof = cap.unknown_profile()
        self.assertEqual(FX["vowel_extend_verdicts"]["profile"], "unknown_profile")
        for row in FX["vowel_extend_verdicts"]["rows"]:
            c = row["classification"]
            eng = cap.resolve_vowel_extend_capability({"classification": c}, prof)
            smp = es.capability_for_vowel_extend(c)
            self.assertEqual(eng["state"], row["engine_state"], "%s 엔진 상태" % c)
            self.assertEqual(eng["reason"], row["engine_reason"], "%s 엔진 사유" % c)
            self.assertEqual(smp["state"], row["sampler_state"], "%s 샘플러 상태" % c)
            self.assertEqual(smp["reason"], row["sampler_reason"], "%s 샘플러 사유" % c)
            self.assertEqual(eng["state"] == smp["state"], row["states_agree"],
                             "%s 의 일치 여부가 기록과 다르다 — divergence 표를 갱신할 것" % c)
            if row["states_agree"]:
                self.assertIsNone(row["divergence_id"], c)
            else:
                self.assertIn(row["divergence_id"], self.byid, c)
            # 어떤 경로에서도 '됨' 이라고 말하지 않는다(양쪽 공통 정직성 규칙).
            self.assertNotEqual(eng["state"], "supported", c)
            self.assertNotEqual(smp["state"], "supported", c)

    def test_d1_engine_planner_agrees_on_the_code_even_though_the_state_differs(self):
        """D1 — 상태는 다르지만 사유 코드는 planner 층에서 같은 코드로 만난다."""
        self.assertIn("D1", self.byid)
        eng = cap.resolve_vowel_extend_capability(
            {"classification": "non_sustainable_final"}, cap.unknown_profile())
        self.assertEqual(eng["state"], "degraded")
        self.assertFalse(eng["allowed_post_process"], "받침은 후처리 경로를 열지 않는다")
        smp = es.capability_for_vowel_extend("non_sustainable_final")
        self.assertEqual(smp["state"], "unsupported")
        self.assertEqual(smp["reason"], "VOWEL_EXTEND_NOT_REALIZABLE")
        self.assertIn("VOWEL_EXTEND_NOT_REALIZABLE", pl.UNSUPPORTED_CODES)
        self.assertIn("VOWEL_EXTEND_NON_SUSTAINABLE_FINAL", pl.DEGRADATION_CODES)

    def test_d2_engine_capability_vocabulary_lacks_undeterminable(self):
        """D2 — 같은 상수명(VOWEL_EXTEND_CLASSES)이 두 모듈에서 서로 다른 집합이다."""
        self.assertIn("D2", self.byid)
        self.assertEqual(list(cap.VOWEL_EXTEND_CLASSES), EXPECT_ENGINE_CAP_VOWEL_CLASSES)
        self.assertEqual(FX["engine"]["capability_vowel_extend_classes"],
                         EXPECT_ENGINE_CAP_VOWEL_CLASSES)
        self.assertEqual(list(cap.VOWEL_EXTEND_ADAPTER_CLASSES), EXPECT_ENGINE_CAP_VOWEL_ADAPTERS)
        self.assertEqual(list(cap.VOWEL_EXTEND_ALL_CLASSES),
                         FX["engine"]["capability_vowel_extend_all_classes"])
        # 언어 계약에는 있고 엔진 capability 어휘에는 없다 — 이것이 D2 다.
        self.assertIn("undeterminable", ex.VOWEL_EXTEND_CLASSES)
        self.assertNotIn("undeterminable", cap.VOWEL_EXTEND_CLASSES)
        self.assertNotIn("undeterminable", cap.VOWEL_EXTEND_ALL_CLASSES)
        self.assertNotEqual(set(cap.VOWEL_EXTEND_CLASSES), set(ex.VOWEL_EXTEND_CLASSES))
        # 그 결과 엔진은 '판정 불가' 를 '대상 없음' 으로 접는다.
        self.assertEqual(
            cap.classify_vowel_extend({"classification": "undeterminable"})["classification"],
            "no_target")

    def test_d5_xvector_code_names_differ(self):
        self.assertIn("D5", self.byid)
        self.assertIn("REFERENCE_X_VECTOR_ONLY", pl.DEGRADATION_CODES)
        self.assertIn("SAMPLER_XVECTOR_ONLY", es.EMOTION_SAMPLE_REASON_CODES)
        self.assertNotIn("REFERENCE_X_VECTOR_ONLY", es.EMOTION_SAMPLE_REASON_CODES)
        self.assertNotIn("SAMPLER_XVECTOR_ONLY", pl.DEGRADATION_CODES)

    def test_d6_capability_unverified_home_differs(self):
        self.assertIn("D6", self.byid)
        self.assertIn("CAPABILITY_UNVERIFIED", pl.DEGRADATION_CODES)
        self.assertNotIn("CAPABILITY_UNVERIFIED", pl.UNSUPPORTED_CODES)
        self.assertEqual(list(es.EMOTION_SAMPLE_STATE_REASONS["unverified"]), ["CAPABILITY_UNVERIFIED"])
        self.assertNotIn("CAPABILITY_UNVERIFIED", es.EMOTION_SAMPLE_STATE_REASONS["degraded"])

    def test_d9_engine_only_codes_have_no_sampler_twin(self):
        self.assertIn("D9", self.byid)
        engine_codes = set(pl.UNSUPPORTED_CODES) | set(pl.DEGRADATION_CODES)
        shared = set(EXPECT_SHARED_REASON_CODES)
        for code in sorted(engine_codes - shared):
            self.assertNotIn(code, es.EMOTION_SAMPLE_REASON_CODES,
                             "%s 가 샘플러에 생겼다 — 공유 코드로 승격되었다면 픽스처를 갱신할 것" % code)
        self.assertEqual(engine_codes & set(es.EMOTION_SAMPLE_REASON_CODES), shared)


if __name__ == "__main__":
    unittest.main()
