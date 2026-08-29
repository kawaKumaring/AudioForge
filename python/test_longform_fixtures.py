# -*- coding: utf-8 -*-
"""장문(longform) 한국어 TTS 픽스처 검증 — GPU/합성/네트워크 없이 stdlib 만 사용한다.

검증 대상 (같은 디렉터리):
  longform-ko-neutral-v1.txt                              평서 나레이션
  longform-ko-seductive-performance-v1.txt                태그 없는 연기 대본
  longform-ko-seductive-performance-expressive-v1.txt     같은 본문 + 계약 태그
  longform-ko-manifest-v1.json                            해시·개수·의도 라벨 매니페스트

검증 축:
  A. 규격      — 각 파일 3,000~5,000자 / 12문단 이상 / CRLF 없음
  B. 파싱      — expressive_v3 에서 error 진단 0건, 원문 무손실 round-trip
  C. 계약 준수 — 사용한 모든 구성물이 계약이 정의한 종류(enum)·범위 안에 있다
  D. 매니페스트— 기록된 SHA-256 과 이벤트 개수가 실제 파싱과 일치한다
  E. 의미 동치 — expressive 의 plain_text == performance 의 plain_text (문서화된 공백 정규화)
  F. neutral   — expressive_v3 로 파싱해도 표현형 구성물이 없다
  G. 웃음 2종  — 대괄호 비언어 웃음과 읽을 수 있는 의성어가 분리되어 있다

⚠️ 실패 보고는 파일명·필드명·개수만 쓴다(대사 전문을 로그로 뽑지 않는다).

이 파일을 python/ 이 아니라 픽스처 옆에 둔 이유:
  픽스처와 그 검증 규칙(문장 세기·공백 정규화)이 한자리에 있어야 유지보수가 쉽고,
  python/ 의 `unittest discover` 기본 스위트(계약/parity 게이트)의 개수를 건드리지 않는다.
  실행: PYTHONIOENCODING=utf-8 <py> -m unittest discover -s test/fixtures/tts -p "test_*.py"
"""
import hashlib
import io
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)   # python/ → 리포지토리 루트
# fixture 본밍은 test/fixtures/tts 에 그대로 남긴다 — 이 파일만 python/ 에 둔 이유는
# 표준 게이트(python -m unittest discover -s python)에 잡히게 하려는 것이다.
FIXTURE_DIR = os.path.join(REPO_ROOT, "test", "fixtures", "tts")
if os.path.join(REPO_ROOT, "python") not in sys.path:
    sys.path.insert(0, os.path.join(REPO_ROOT, "python"))

import expressive_timeline as ex  # noqa: E402

MODE = "expressive_v3"
MIN_CHARS = 3000
MAX_CHARS = 5000
MIN_PARAGRAPHS = 12
LATIN_RATIO_BOUND_PCT = 5.0
LAUGH_BAND = (6, 10)

NEUTRAL = "longform-ko-neutral-v1.txt"
PERFORMANCE = "longform-ko-seductive-performance-v1.txt"
EXPRESSIVE = "longform-ko-seductive-performance-expressive-v1.txt"
MANIFEST = "longform-ko-manifest-v1.json"
TEXT_FILES = (NEUTRAL, PERFORMANCE, EXPRESSIVE)
ROLE_TO_FILE = {"neutral": NEUTRAL, "performance": PERFORMANCE, "expressive": EXPRESSIVE}

SENTENCE_TERMINATORS = ".!?。！？…"
_TERMINATOR_RE = re.compile("[%s]+" % re.escape(SENTENCE_TERMINATORS))
_PARAGRAPH_SPLIT_RE = re.compile(r"\n\s*\n")
_LATIN_RE = re.compile(r"[A-Za-z]")

# 매니페스트가 쓸 수 있는 문단 의도 라벨(계약이 아니라 이 픽스처군의 어휘).
INTENT_LABELS = frozenset((
    "baseline_cute", "attempted_seductive", "confident_seductive", "embarrassed_break",
    "nonverbal_laugh", "recovery", "multilingual_stress", "calm_closure",
))

# 세 파일 어디에도 빠지면 안 되는 필수 대사/수치. performance 와 expressive 에서 축자 확인한다.
REQUIRED_LINES = (
    "어서 오세요. 오늘 밤은 조금 특별하답니다.",
    "왜 그렇게 긴장하세요?",
    "정말 저를 만나러 온 거예요?",
    "설마...... 지금 도망가려는 건 아니죠?",
    "이쪽으로 와 봐요~",
    "어머, 그렇게 놀랄 줄은 몰랐는데!?",
    "Bonsoir, monsieur.",
    "Welcome. 오늘의 special guest는 바로 당신이에요.",
    "오후 11시 30분",
    "테이블 7번",
    "장미 세 송이",
)

# 대괄호 비언어 웃음(글자로 읽지 않는다) vs 본문에 적힌 읽을 수 있는 의성어.
PRONOUNCEABLE_LAUGHS = ("헤헷", "호호호", "히히")
NONVERBAL_ONLY_TOKENS = ("[ㅋㅋ]", "[ㅎㅎ]", "[ㅎㅎㅎㅎ]", "[헤헷]", "[헤헤헷]", "[호호]", "[히히]")

# 국소 운율 종류별 실행 길이(run) 허용 범위 — 계약 상수를 그대로 읽어 대조한다.
RUN_BOUNDS = {
    "firm_end": (ex.DOT_RUN_MIN_COUNT, ex.DOT_RUN_MAX_COUNT),
    "fade_end": (ex.DOT_RUN_MIN_COUNT, ex.DOT_RUN_MAX_COUNT),
    "emphasis": (ex.BANG_RUN_MIN_COUNT, ex.BANG_RUN_MAX_COUNT),
    "question_rise": (ex.QUESTION_RUN_MIN_COUNT, ex.QUESTION_RUN_MAX_COUNT),
    "shock_rise": (ex.SHOCK_RUN_MIN_COUNT, ex.SHOCK_RUN_MAX_COUNT),
    "vowel_extend": (ex.TILDE_RUN_MIN_COUNT, ex.TILDE_RUN_MAX_COUNT),
}


# ─────────────────────────────────────────────────────────────────────────────
# 공용 유틸 — 매니페스트에 문서화된 세기/정규화 규칙의 단일 구현
# ─────────────────────────────────────────────────────────────────────────────

def read_fixture(name):
    with io.open(os.path.join(FIXTURE_DIR, name), encoding="utf-8") as f:
        return f.read()


def sha256_of_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def paragraphs_of(raw):
    """문단 = 빈 줄로 분리한 비어 있지 않은 블록."""
    return [p for p in _PARAGRAPH_SPLIT_RE.split(raw.strip()) if p.strip()]


def sentence_count_of(verbatim_text):
    """문장 수 = verbatim_text 안 문장 종결 부호의 극대 연속 구간 개수.

    verbatim_text(태그 제거, 구두점 유지)를 쓰므로 '[쉼 0.6]' 의 '.' 은 세지 않는다.
    종결 부호 없이 끝나는 의도적 미완결 구절('하나, 둘, 셋')도 세지 않는다.
    """
    return len(_TERMINATOR_RE.findall(verbatim_text))


def normalize_whitespace(text):
    """매니페스트 meaning_equivalence.whitespace_normalization 과 동일한 규칙.

    줄 단위로 [ \\t]+ 를 공백 한 칸으로 축약하고 양끝을 트림한 뒤 '\\n' 으로 잇는다.
    줄 개수와 빈 줄 위치는 보존된다.
    """
    return "\n".join(re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n"))


def parse_v3(raw):
    result = ex.parse_expressive_timeline(raw, mode=MODE)
    return result


def timeline_of(raw):
    result = parse_v3(raw)
    assert result["ok"], "parse failed"
    return result["timeline"]


def count_by(items, key):
    out = {}
    for it in items:
        k = key(it)
        out[k] = out.get(k, 0) + 1
    return out


def observed_events(raw):
    """매니페스트 files[*].expected_events 와 같은 형태로 실제 파싱 결과를 만든다."""
    tl = timeline_of(raw)
    diags = tl["diagnostics"]
    lp, lg, et, ep = tl["local_prosody"], tl["laughs"], tl["emotion_transitions"], tl["explicit_pauses"]
    return {
        "mode": tl["mode"],
        "error_diagnostic_count": len([d for d in diags if d["severity"] == "error"]),
        "warning_diagnostic_count": len([d for d in diags if d["severity"] == "warning"]),
        "node_count": tl["summary"]["node_count"],
        "line_count": tl["summary"]["line_count"],
        "emotion_transition_count": len(et),
        "emotion_transition_by_label": count_by(et, lambda e: e["target_emotion_label"]),
        "emotion_transition_by_mode": count_by(et, lambda e: e["transition_mode"]),
        "emotion_transition_explicit_mode_count": len([e for e in et if e["explicit_mode"]]),
        "used_emotion_ids": list(tl["summary"]["used_emotion_ids"]),
        "local_prosody_count": len(lp),
        "local_prosody_by_kind": count_by(lp, lambda e: e["kind"]),
        "local_prosody_by_kind_and_effective_count": count_by(
            lp, lambda e: "%s:%d" % (e["kind"], e["effective_count"])),
        "vowel_extend_classification": count_by(
            [e for e in lp if e["vowel_extend"] is not None],
            lambda e: e["vowel_extend"]["classification"]),
        "nonverbal_laugh_count": len(lg),
        "nonverbal_laugh_by_style": count_by(lg, lambda e: e["style"]),
        "nonverbal_laugh_by_position": count_by(lg, lambda e: e["position"]),
        "nonverbal_laugh_raw_tokens": [e["raw_token"] for e in lg],
        "explicit_pause_count": len(ep),
        "total_explicit_pause_ms": tl["summary"]["total_explicit_pause_ms"],
        "boundary_by_kind": count_by(tl["boundaries"], lambda b: b["kind"]),
        "capped_token_count": tl["summary"]["capped_token_count"],
        "non_open_vowel_extend_count": tl["summary"]["non_open_vowel_extend_count"],
    }


class LongformFixtureBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = {name: read_fixture(name) for name in TEXT_FILES}
        cls.timeline = {name: timeline_of(cls.raw[name]) for name in TEXT_FILES}
        cls.manifest = json.loads(read_fixture(MANIFEST))


# ─────────────────────────────────────────────────────────────────────────────
# A. 규격
# ─────────────────────────────────────────────────────────────────────────────

class TestLongformShape(LongformFixtureBase):
    def test_char_count_within_3000_5000(self):
        for name in TEXT_FILES:
            n = len(self.raw[name])
            self.assertGreaterEqual(n, MIN_CHARS, name)
            self.assertLessEqual(n, MAX_CHARS, name)

    def test_at_least_twelve_paragraphs(self):
        for name in TEXT_FILES:
            self.assertGreaterEqual(len(paragraphs_of(self.raw[name])), MIN_PARAGRAPHS, name)

    def test_paragraph_counts_are_equal_across_files(self):
        counts = set(len(paragraphs_of(self.raw[name])) for name in TEXT_FILES)
        self.assertEqual(len(counts), 1, "문단 1:1 대응이 깨졌다")

    def test_single_trailing_newline(self):
        """정규화된 텍스트에 후행 개행이 정확히 하나.

        raw 는 text 모드로 읽어 universal-newline 변환을 거친 것이므로, 디스크 상의
        줄끝 모양은 이 단언에 드러나지 않는다 — 그 사실은 아래 테스트가 따로 다룬다."""
        for name in TEXT_FILES:
            raw = self.raw[name]
            self.assertTrue(raw.endswith("\n"), name)
            self.assertFalse(raw.endswith("\n\n"), name)
            self.assertNotIn("\r", raw, name)   # 줄 중간의 단독 CR

    def test_on_disk_line_endings_do_not_affect_manifest(self):
        """리포지토리는 core.autocrlf=true 로 돌아가므로 새 상황에서 이 fixture 들은
        디스크에 CRLF 로 내려간다(실측: 7617바이트 LF → 7652바이트 CRLF). 그것은 정상이며
        manifest 값을 깨뜨리지 않는다 — sha256·char_count·byte_length_utf8 이 전부 LF
        정규화된 텍스트 기준이기 때문이다. 이 테스트는 그 불변을 직접 증명한다.

        왜 필요한가: `sha256sum <파일>` 로 직접 해싱하면 manifest 와 다른 값이 나온다.
        그것은 fixture 오염이 아니라 해싱 기준이 다른 것이라는 사실을 여기에 박아 둔다."""
        for name in TEXT_FILES:
            with io.open(os.path.join(FIXTURE_DIR, name), "rb") as f:
                data = f.read()
            normalized = data.replace(b"\r\n", b"\n").decode("utf-8")
            self.assertEqual(normalized, self.raw[name], name)

    def test_latin_ratio_under_bound(self):
        for name in TEXT_FILES:
            vt = self.timeline[name]["verbatim_text"]
            ratio = len(_LATIN_RE.findall(vt)) * 100.0 / len(vt)
            self.assertLess(ratio, LATIN_RATIO_BOUND_PCT, "%s latin=%.3f%%" % (name, ratio))

    def test_mixes_short_and_long_sentences(self):
        """길이가 한 종류로 몰리지 않는지 — 짧은 문장과 2~3절 문장이 함께 있어야 한다."""
        for name in TEXT_FILES:
            vt = self.timeline[name]["verbatim_text"]
            lens = [len(s.strip()) for s in _TERMINATOR_RE.split(vt) if len(s.strip()) > 0]
            self.assertGreater(len([n for n in lens if n <= 20]), 5, name)
            self.assertGreater(len([n for n in lens if n >= 45]), 5, name)


# ─────────────────────────────────────────────────────────────────────────────
# B. 파싱
# ─────────────────────────────────────────────────────────────────────────────

class TestLongformParses(LongformFixtureBase):
    def test_all_files_parse_in_expressive_v3(self):
        for name in TEXT_FILES:
            result = parse_v3(self.raw[name])
            self.assertTrue(result["ok"], name)
            self.assertEqual(result["mode"], MODE, name)
            self.assertEqual(result["effective_version"], ex.EXPRESSIVE_MODE_TO_VERSION[MODE], name)

    def test_zero_error_diagnostics(self):
        for name in TEXT_FILES:
            errors = [d for d in self.timeline[name]["diagnostics"] if d["severity"] == "error"]
            self.assertEqual(errors, [], "%s: %d error diagnostics" % (name, len(errors)))

    def test_no_warning_diagnostics_either(self):
        """경고도 0건이어야 한다 — 받침 없는 모음에만 '~' 를 붙였고 host 없는 운율이 없다."""
        for name in TEXT_FILES:
            codes = sorted(set(d["code"] for d in self.timeline[name]["diagnostics"]
                               if d["severity"] == "warning"))
            self.assertEqual(codes, [], "%s: %s" % (name, codes))

    def test_lossless_round_trip(self):
        for name in TEXT_FILES:
            rt = ex.verify_round_trip(self.raw[name], self.timeline[name])
            self.assertTrue(rt["ok"], name)
            self.assertTrue(rt["contiguous"], name)

    def test_no_token_is_capped(self):
        """실행 길이가 계약 상한을 넘어 잘린 토큰이 없다(의도적으로 상한 안에서만 썼다)."""
        for name in TEXT_FILES:
            self.assertEqual(self.timeline[name]["summary"]["capped_token_count"], 0, name)


# ─────────────────────────────────────────────────────────────────────────────
# C. 계약 준수 — 사용한 모든 구성물이 계약이 정의한 종류 안에 있다
# ─────────────────────────────────────────────────────────────────────────────

class TestOnlyContractSupportedConstructs(LongformFixtureBase):
    def test_node_kinds_are_contract_kinds(self):
        for name in TEXT_FILES:
            for nd in self.timeline[name]["nodes"]:
                self.assertIn(nd["kind"], ex.EXPRESSIVE_NODE_KINDS, name)

    def test_emotion_labels_resolve_and_modes_are_contract_modes(self):
        for name in TEXT_FILES:
            for e in self.timeline[name]["emotion_transitions"]:
                label = e["target_emotion_label"]
                self.assertIn(label, ex.EXPRESSIVE_EMOTION_LABEL_TO_ID, "%s: %s" % (name, label))
                self.assertEqual(e["target_emotion"], ex.EXPRESSIVE_EMOTION_LABEL_TO_ID[label])
                self.assertIn(e["transition_mode"], ex.EMOTION_TRANSITION_MODES, name)

    def test_emotion_transitions_are_neither_boundaries_nor_pauses(self):
        """감정 태그는 전이 지점이다 — chunk 경계도, 쉼도 만들지 않는다."""
        for name in TEXT_FILES:
            for e in self.timeline[name]["emotion_transitions"]:
                self.assertFalse(e["is_chunk_boundary"], name)
                self.assertEqual(e["extra_pause_ms"], 0, name)
            for p in self.timeline[name]["local_prosody"]:
                self.assertFalse(p["is_chunk_boundary"], name)
                self.assertEqual(p["extra_pause_ms"], 0, name)

    def test_local_prosody_kinds_scopes_and_run_bounds(self):
        for name in TEXT_FILES:
            for p in self.timeline[name]["local_prosody"]:
                self.assertIn(p["kind"], ex.LOCAL_PROSODY_KINDS, name)
                self.assertIn(p["scope_kind"], ex.PROSODY_SCOPE_KINDS, name)
                lo, hi = RUN_BOUNDS[p["kind"]]
                self.assertGreaterEqual(p["effective_count"], lo, name)
                self.assertLessEqual(p["effective_count"], hi, name)
                self.assertEqual(p["effective_count"], p["raw_count"], name)

    def test_laugh_styles_and_positions_are_contract_values(self):
        for name in TEXT_FILES:
            for lg in self.timeline[name]["laughs"]:
                self.assertIn(lg["style"], ex.LAUGH_STYLES, name)
                self.assertIn(lg["position"], ex.LAUGH_POSITIONS, name)
                self.assertGreaterEqual(lg["effective_repeat_count"], ex.LAUGH_REPEAT_MIN_COUNT)
                self.assertLessEqual(lg["effective_repeat_count"], ex.LAUGH_REPEAT_MAX_COUNT)

    def test_explicit_pauses_within_contract_range(self):
        lo_ms = int(round(ex.EXPRESSIVE_PAUSE_MIN_SEC * 1000))
        hi_ms = int(round(ex.EXPRESSIVE_PAUSE_MAX_SEC * 1000))
        for name in TEXT_FILES:
            for pz in self.timeline[name]["explicit_pauses"]:
                self.assertGreaterEqual(pz["pause_ms"], lo_ms, name)
                self.assertLessEqual(pz["pause_ms"], hi_ms, name)

    def test_boundary_kinds_are_contract_kinds(self):
        for name in TEXT_FILES:
            for b in self.timeline[name]["boundaries"]:
                self.assertIn(b["kind"], ex.EXPRESSIVE_BOUNDARY_KINDS, name)

    def test_vowel_extend_classifications_are_contract_classes(self):
        for name in TEXT_FILES:
            for p in self.timeline[name]["local_prosody"]:
                ve = p["vowel_extend"]
                if ve is None:
                    self.assertNotEqual(p["kind"], "vowel_extend", name)
                    continue
                self.assertIn(ve["classification"], ex.VOWEL_EXTEND_CLASSES, name)

    def test_dot_run_kind_distinction_single_vs_multi(self):
        """'.' 1개 = firm_end, 2개 이상 = fade_end — 정도가 아니라 다른 종류."""
        for name in TEXT_FILES:
            for p in self.timeline[name]["local_prosody"]:
                if p["kind"] == "firm_end":
                    self.assertEqual(p["raw_count"], 1, name)
                elif p["kind"] == "fade_end":
                    self.assertGreaterEqual(p["raw_count"], 2, name)
        expr = self.timeline[EXPRESSIVE]["local_prosody"]
        self.assertGreater(len([p for p in expr if p["kind"] == "firm_end"]), 0)
        self.assertGreater(len([p for p in expr if p["kind"] == "fade_end"]), 0)

    def test_shock_rise_alias_is_one_event_per_token(self):
        """'?!' 와 '!?' 는 서로의 별칭 — 각각 shock_rise 한 개만 만든다."""
        raw = self.raw[EXPRESSIVE]
        self.assertIn("?!", raw)
        self.assertIn("!?", raw)
        shock = [p for p in self.timeline[EXPRESSIVE]["local_prosody"] if p["kind"] == "shock_rise"]
        self.assertEqual(len(shock), raw.count("?!") + raw.count("!?"))
        for p in shock:
            self.assertEqual(p["raw_count"], 2)
            self.assertEqual(p["scope_kind"], "final_word")

    def test_expressive_uses_every_laugh_style(self):
        styles = set(lg["style"] for lg in self.timeline[EXPRESSIVE]["laughs"])
        self.assertEqual(styles, set(ex.LAUGH_STYLES))

    def test_laugh_event_count_in_expected_band(self):
        n = len(self.timeline[EXPRESSIVE]["laughs"])
        self.assertGreaterEqual(n, LAUGH_BAND[0])
        self.assertLessEqual(n, LAUGH_BAND[1])

    def test_expressive_exercises_both_emotion_modifiers(self):
        modes = set(e["transition_mode"] for e in self.timeline[EXPRESSIVE]["emotion_transitions"]
                    if e["explicit_mode"])
        self.assertEqual(modes, set(ex.EMOTION_TRANSITION_MODES))


# ─────────────────────────────────────────────────────────────────────────────
# D. 매니페스트
# ─────────────────────────────────────────────────────────────────────────────

class TestManifest(LongformFixtureBase):
    def test_sha256_matches_files(self):
        for role, name in ROLE_TO_FILE.items():
            block = self.manifest["files"][role]
            self.assertEqual(block["file"], name)
            self.assertEqual(block["sha256"], sha256_of_text(self.raw[name]), name)

    def test_scalar_counts_match_files(self):
        for role, name in ROLE_TO_FILE.items():
            block = self.manifest["files"][role]
            raw = self.raw[name]
            tl = self.timeline[name]
            vt = tl["verbatim_text"]
            self.assertEqual(block["char_count"], len(raw), name)
            self.assertEqual(block["byte_length_utf8"], len(raw.encode("utf-8")), name)
            self.assertEqual(block["paragraph_count"], len(paragraphs_of(raw)), name)
            self.assertEqual(block["sentence_count"], sentence_count_of(vt), name)
            self.assertEqual(block["verbatim_char_count"], len(vt), name)
            self.assertEqual(block["plain_char_count"], len(tl["plain_text"]), name)
            self.assertEqual(block["latin_letter_count"], len(_LATIN_RE.findall(vt)), name)
            self.assertEqual(block["paragraph_char_counts"],
                             [len(p) for p in paragraphs_of(raw)], name)

    def test_expected_event_counts_match_actual_parse(self):
        for role, name in ROLE_TO_FILE.items():
            expected = self.manifest["files"][role]["expected_events"]
            actual = observed_events(self.raw[name])
            self.assertEqual(sorted(expected.keys()), sorted(actual.keys()), name)
            for key in sorted(expected.keys()):
                self.assertEqual(expected[key], actual[key], "%s / %s" % (name, key))

    def test_declared_latin_ratio_matches_and_respects_bound(self):
        self.assertEqual(self.manifest["counting_rules"]["latin_ratio_bound_pct"],
                         LATIN_RATIO_BOUND_PCT)
        for role, name in ROLE_TO_FILE.items():
            block = self.manifest["files"][role]
            vt = self.timeline[name]["verbatim_text"]
            ratio = round(len(_LATIN_RE.findall(vt)) * 100.0 / len(vt), 4)
            self.assertEqual(block["latin_ratio_pct"], ratio, name)
            self.assertLess(block["latin_ratio_pct"], LATIN_RATIO_BOUND_PCT, name)

    def test_paragraph_intents_use_only_declared_labels(self):
        declared = self.manifest["paragraph_intent_labels"]
        self.assertEqual(set(declared), INTENT_LABELS)
        rows = self.manifest["correspondence"]["paragraphs"]
        self.assertEqual(len(rows), len(paragraphs_of(self.raw[NEUTRAL])))
        for i, row in enumerate(rows):
            self.assertEqual(row["index"], i + 1)
            self.assertIn(row["intent"], INTENT_LABELS, "row %d" % (i + 1))
            self.assertTrue(row["beat"].strip())
        self.assertEqual(set(r["intent"] for r in rows), INTENT_LABELS,
                         "여덟 개 의도 라벨이 모두 쓰여야 한다")

    def test_manifest_states_the_verification_goal(self):
        goal = self.manifest["goal"]
        for token in ("자연스러움", "연속성", "내용 보존"):
            self.assertIn(token, goal)

    def test_lexical_inventory_items_actually_appear(self):
        inv = self.manifest["lexical_inventory"]
        for row in inv["arabic_numerals"]:
            self.assertIn(row["context"], self.raw[PERFORMANCE], row["text"])
            self.assertIn(row["context"], self.raw[EXPRESSIVE], row["text"])
        for span in inv["latin_spans"]:
            for name in TEXT_FILES:
                self.assertIn(span, self.raw[name], "%s / %s" % (name, span))
        for numeral in inv["korean_numerals"]:
            self.assertTrue(any(numeral in self.raw[n] for n in TEXT_FILES), numeral)
        for noun in inv["proper_nouns"]:
            self.assertIn(noun, self.raw[NEUTRAL], noun)

    def test_declared_constructs_match_what_is_used(self):
        used = self.manifest["contract_constructs_used"]
        self.assertEqual(sorted(used["laugh_styles"]), sorted(ex.LAUGH_STYLES))
        self.assertEqual(sorted(used["local_prosody_kinds"]), sorted(ex.LOCAL_PROSODY_KINDS))
        actual_labels = sorted(set(e["target_emotion_label"]
                                   for e in self.timeline[EXPRESSIVE]["emotion_transitions"]))
        self.assertEqual(sorted(used["emotion_transition_labels"]), actual_labels)
        actual_pauses = [pz["raw_token"] for pz in self.timeline[EXPRESSIVE]["explicit_pauses"]]
        self.assertEqual(sorted(used["explicit_pause_tokens"]), sorted(actual_pauses))
        actual_prosody = set(p["kind"] for p in self.timeline[EXPRESSIVE]["local_prosody"])
        self.assertEqual(actual_prosody, set(ex.LOCAL_PROSODY_KINDS),
                         "선언한 국소 운율 여섯 종류가 모두 실제로 등장해야 한다")


# ─────────────────────────────────────────────────────────────────────────────
# E. 의미 동치 — performance ↔ expressive
# ─────────────────────────────────────────────────────────────────────────────

class TestMeaningEquivalence(LongformFixtureBase):
    def test_normalized_plain_text_is_exactly_equal(self):
        a = normalize_whitespace(self.timeline[PERFORMANCE]["plain_text"])
        b = normalize_whitespace(self.timeline[EXPRESSIVE]["plain_text"])
        self.assertEqual(len(a), len(b), "정규화 후 길이가 다르다")
        self.assertEqual(a, b, "정규화 후 plain_text 가 다르다")

    def test_manifest_declares_no_residue(self):
        me = self.manifest["meaning_equivalence"]
        self.assertIn("whitespace_normalization", me)
        self.assertIn("없음", me["residue"])

    def test_expressive_is_performance_plus_declared_insertions(self):
        """expressive 는 performance 원문에 태그만 삽입한 결과와 바이트 단위로 같다."""
        out = self.raw[PERFORMANCE]
        for row in self.manifest["insertions"]:
            anchor = row["anchor"]
            self.assertEqual(out.count(anchor), 1, "anchor not unique")
            out = out.replace(anchor, row["insert"] + anchor, 1)
        self.assertEqual(out, self.raw[EXPRESSIVE])

    def test_only_tag_tokens_differ_between_the_two_files(self):
        """차이가 태그 토큰뿐임을 반대 방향으로도 확인 — 태그를 지우면 performance 로 돌아온다."""
        stripped = re.sub(r"\[[^\[\]\n]*\] ", "", self.raw[EXPRESSIVE])
        self.assertEqual(stripped, self.raw[PERFORMANCE])

    def test_required_lines_present_in_both_performance_files(self):
        for line in REQUIRED_LINES:
            self.assertIn(line, self.raw[PERFORMANCE], line)
            self.assertIn(line, self.raw[EXPRESSIVE], line)

    def test_no_seductive_line_is_repeated(self):
        """같은 유혹 대사를 반복하지 않는다 — 12자 이상 구절이 두 번 나오면 실패."""
        vt = self.timeline[PERFORMANCE]["verbatim_text"]
        seen = {}
        for chunk in re.split(r"[.!?~\n]+", vt):
            s = chunk.strip()
            if len(s) < 12:
                continue
            seen[s] = seen.get(s, 0) + 1
        self.assertEqual([k for k, v in seen.items() if v > 1], [])


# ─────────────────────────────────────────────────────────────────────────────
# F. neutral — 표현형 구성물이 없다
# ─────────────────────────────────────────────────────────────────────────────

class TestNeutralHasNoExpressiveConstructs(LongformFixtureBase):
    def test_no_bracket_tags_at_all(self):
        raw = self.raw[NEUTRAL]
        self.assertNotIn("[", raw)
        self.assertNotIn("]", raw)
        self.assertNotIn("\\", raw)

    def test_no_tag_driven_events(self):
        tl = self.timeline[NEUTRAL]
        self.assertEqual(len(tl["emotion_transitions"]), 0)
        self.assertEqual(len(tl["laughs"]), 0)
        self.assertEqual(len(tl["explicit_pauses"]), 0)
        self.assertEqual(tl["summary"]["used_emotion_ids"], [])
        self.assertEqual(tl["summary"]["total_explicit_pause_ms"], 0)

    def test_no_expressive_punctuation_runs(self):
        """평범한 마침표만 쓴다 — '...', '!?', '~', '!!' 같은 표현형 실행이 하나도 없다.

        expressive_v3 는 어떤 한국어 문장에서든 문장 끝 마침표를 localProsody 로 토큰화한다.
        그래서 '구성물이 없다'는 것은 (1) 태그가 없고 (2) 모든 국소 운율이 길이 1 의
        firm_end 뿐이라는 뜻이다 — 이 파일에는 fade_end/emphasis/question_rise/shock_rise/
        vowel_extend 가 단 하나도 없다.
        """
        kinds = set()
        for p in self.timeline[NEUTRAL]["local_prosody"]:
            kinds.add(p["kind"])
            self.assertEqual(p["effective_count"], 1)
            self.assertEqual(p["raw_count"], 1)
        self.assertEqual(kinds, {"firm_end"})
        for token in ("...", "!?", "?!", "!!", "~", "??", "…"):
            self.assertNotIn(token, self.raw[NEUTRAL], token)

    def test_plain_text_equals_verbatim_minus_dots(self):
        """neutral 은 태그가 없으므로 verbatim 에서 마침표만 뺀 것이 plain_text 다."""
        tl = self.timeline[NEUTRAL]
        self.assertEqual(tl["verbatim_text"], self.raw[NEUTRAL])
        self.assertEqual(tl["plain_text"], self.raw[NEUTRAL].replace(".", ""))

    def test_narrates_the_same_events(self):
        for token in ("한소리", "오후 11시 30분", "테이블 7번", "장미 세 송이",
                      "Bonsoir, monsieur.", "special guest", "호호", "히히"):
            self.assertIn(token, self.raw[NEUTRAL], token)


# ─────────────────────────────────────────────────────────────────────────────
# G. 웃음 2종 분리
# ─────────────────────────────────────────────────────────────────────────────

class TestLaughKindSeparation(LongformFixtureBase):
    def test_bracket_laughs_exist_only_in_the_expressive_file(self):
        for token in NONVERBAL_ONLY_TOKENS:
            self.assertNotIn(token, self.raw[NEUTRAL], token)
            self.assertNotIn(token, self.raw[PERFORMANCE], token)
        used = set(lg["raw_token"] for lg in self.timeline[EXPRESSIVE]["laughs"])
        self.assertTrue(used.issubset(set(NONVERBAL_ONLY_TOKENS)), sorted(used))

    def test_bracket_laughs_are_never_read_as_letters(self):
        """비언어 웃음은 plain_text 에 한 글자도 남기지 않는다."""
        plain = self.timeline[EXPRESSIVE]["plain_text"]
        self.assertNotIn("[", plain)
        self.assertNotIn("]", plain)
        self.assertNotIn("ㅋ", plain)  # 'ㅋ' 는 본문에 문자로 쓰이지 않는다
        self.assertNotIn("ㅎ", plain)  # 'ㅎ' 도 마찬가지
        for lg in self.timeline[EXPRESSIVE]["laughs"]:
            self.assertEqual(lg["raw_token"][0], "[")
            self.assertEqual(lg["raw_token"][-1], "]")

    def test_pronounceable_onomatopoeia_survive_as_text(self):
        for word in PRONOUNCEABLE_LAUGHS:
            for name in (PERFORMANCE, EXPRESSIVE):
                self.assertIn(word, self.timeline[name]["plain_text"], "%s / %s" % (name, word))

    def test_both_kinds_coexist_and_are_distinguishable(self):
        """같은 파일 안에 두 종류가 함께 있고, 개수가 서로 독립적으로 셈된다."""
        tl = self.timeline[EXPRESSIVE]
        plain = tl["plain_text"]
        self.assertGreaterEqual(len(tl["laughs"]), LAUGH_BAND[0])
        self.assertGreater(plain.count("히히"), 0)
        # 본문 '히히'(읽는다) 와 이벤트 '[히히]'(읽지 않는다) 가 동시에 존재한다.
        self.assertIn("[히히]", self.raw[EXPRESSIVE])
        self.assertEqual(len([lg for lg in tl["laughs"] if lg["style"] == "high_giggle"]), 1)
        self.assertEqual(self.raw[EXPRESSIVE].count("히히"), 2)  # 본문 1 + 태그 1

    def test_manifest_documents_the_separation(self):
        sep = self.manifest["laugh_kind_separation"]
        self.assertEqual(sorted(sep["nonverbal_bracket_events_expressive_only"]),
                         sorted(lg["raw_token"] for lg in self.timeline[EXPRESSIVE]["laughs"]))
        for word in sep["pronounceable_onomatopoeia_in_all_three"]:
            self.assertIn(word, PRONOUNCEABLE_LAUGHS)


if __name__ == "__main__":
    unittest.main()
