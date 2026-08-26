# -*- coding: utf-8 -*-
"""표현형 운율(expressive prosody) LANGUAGE 계약 — Python 동형 구현 (stdlib only).

TS 동형: src/shared/expressiveTimeline.ts. 두 구현은 byte-identical 결과(full_sha256)를 낸다.

⚠️ 하위호환 불변식(최우선):
  이 모듈은 v2 계획(tts_grammar.parse_tts_script)의 출력·해시를 '전혀' 건드리지 않는다.
  TTS_PARSER_VERSION 은 2 로 남고, separate.py 의 PARSER_PARITY_MISMATCH 게이트는
  이 변경으로 새로 실패할 수 없다. 이 파일은 '추가(additive)' 레이어이며 합성 경로가 호출하지 않는다.

⚠️ 버전 선택 규칙:
  표현형 모드는 '명시적으로 선택'된다. 본문 내용은 절대 버전을 고르지 않는다.
  mode 를 주지 않으면 EXPRESSIVE_DEFAULT_MODE('legacy_v2') 이며, 본문에 '.', '...', '!?', '~',
  '[ㅋㅋ]' 가 들어 있어도 자동으로 v3 로 승격하지 않는다.
"""
import hashlib
import re

import tts_grammar

# ─────────────────────────────────────────────────────────────────────────────
# 0. 버전 / 모드 계약
# ─────────────────────────────────────────────────────────────────────────────

EXPRESSIVE_CONTRACT_VERSION = 3
EXPRESSIVE_LEGACY_PLAN_VERSION = 2

EXPRESSIVE_MODES = ("legacy_v2", "expressive_v3")
EXPRESSIVE_DEFAULT_MODE = "legacy_v2"
EXPRESSIVE_MODE_TO_VERSION = {"legacy_v2": 2, "expressive_v3": 3}

# 거울 원본(Python 쪽은 직접 import 가능하므로 값 복사 없음).
EXPRESSIVE_EMOTION_LABEL_TO_ID = tts_grammar.TTS_EMOTION_LABEL_TO_ID
EXPRESSIVE_PAUSE_NAMES = tts_grammar.TTS_PAUSE_NAMES

# ─────────────────────────────────────────────────────────────────────────────
# 1. enum 집합 (TS 와 동일 — parity 테스트가 서로의 소스를 읽어 대조한다)
# ─────────────────────────────────────────────────────────────────────────────

EXPRESSIVE_NODE_KINDS = (
    "text", "lineBreak", "emotionTransition", "localProsody", "nonverbalLaugh", "explicitPause",
)
EMOTION_TRANSITION_MODES = ("blend", "immediate")
LOCAL_PROSODY_KINDS = (
    "firm_end", "fade_end", "emphasis", "question_rise", "shock_rise", "vowel_extend",
)
PROSODY_SCOPE_KINDS = ("final_syllables", "final_word", "latter_half", "final_vowel")
LAUGH_STYLES = ("chuckle", "breathy", "bashful", "open", "high_giggle")
LAUGH_POSITIONS = ("leading", "inline", "trailing", "standalone")
VOWEL_EXTEND_DEGRADE_REASONS = (
    "final_consonant", "unsupported_script", "no_preceding_text", "no_preceding_vowel",
)
EXPRESSIVE_BOUNDARY_KINDS = ("explicitPause", "sentenceGap", "finalTail")
EXPRESSIVE_EVENT_PRIORITY = (
    "emotionTransition", "localProsody", "nonverbalLaugh", "explicitPause", "sentenceGap", "finalTail",
)
EXPRESSIVE_ERROR_CODES = (
    "UNKNOWN_EXPRESSIVE_TAG",
    "INVALID_EXPRESSIVE_PAUSE",
    "INVALID_EMOTION_MODIFIER",
    "AMBIGUOUS_LAUGH_TOKEN",
    "UNSUPPORTED_VOWEL_EXTEND",
    "PROSODY_WITHOUT_HOST",
    "EXPRESSIVE_PARITY_MISMATCH",
    "EXPRESSIVE_MODE_INVALID",
    "EXPRESSIVE_MODE_CARRIER_MISMATCH",
)
EXPRESSIVE_DIAGNOSTIC_SEVERITIES = ("error", "warning")

# ─────────────────────────────────────────────────────────────────────────────
# 2. 토큰 문자 집합 (v3 모드에서만 쓰인다)
# ─────────────────────────────────────────────────────────────────────────────

DOT_RUN_CHARS = ".。…"
DOT_CHAR_WEIGHTS = {".": 1, "。": 1, "…": 3}
BANG_RUN_CHARS = "!！"
QUESTION_RUN_CHARS = "?？"
TILDE_RUN_CHARS = "~～〜"

# JS String.trim / Python str.strip 차이를 배제한 '명시' 공백 집합(TS 와 문자 단위로 동일).
EXPRESSIVE_WHITESPACE_CHARS = (
    " \t\n\v\f\r          "
    "       　"
)

LAUGH_TOKEN_CHARS = "ㅋㅎ헤헷호홋히"

EMOTION_MODIFIER_SEPARATOR = "|"
EMOTION_MODIFIER_TO_MODE = {
    "즉시": "immediate", "immediate": "immediate",
    "블렌드": "blend", "blend": "blend",
}

# ─────────────────────────────────────────────────────────────────────────────
# 3. 수치 계약 (전부 정수 — canonical 해시에 float 금지)
# ─────────────────────────────────────────────────────────────────────────────

EMOTION_TRANSITION_DEFAULT_MODE = "blend"
EMOTION_TRANSITION_DEFAULT_STRENGTH = 100
EMOTION_BLEND_DURATION_MS = 300
EMOTION_IMMEDIATE_DURATION_MS = 0
EMOTION_TRANSITION_EXTRA_PAUSE_MS = 0
EMOTION_TRANSITION_IS_CHUNK_BOUNDARY = False

DOT_RUN_MIN_COUNT = 1
DOT_RUN_MAX_COUNT = 6
FIRM_END_STRENGTH = 25
FIRM_END_DURATION_MS = 120
FADE_END_STRENGTH_BY_COUNT = (0, 0, 40, 55, 70, 85, 100)
FADE_END_DURATION_MS_BY_COUNT = (0, 0, 240, 360, 480, 600, 720)

BANG_RUN_MIN_COUNT = 1
BANG_RUN_MAX_COUNT = 3
EMPHASIS_STRENGTH_BY_COUNT = (0, 60, 80, 100)
EMPHASIS_DURATION_MS_BY_COUNT = (0, 300, 400, 500)

QUESTION_RUN_MIN_COUNT = 1
QUESTION_RUN_MAX_COUNT = 3
QUESTION_RISE_STRENGTH_BY_COUNT = (0, 70, 85, 100)
QUESTION_RISE_DURATION_MS_BY_COUNT = (0, 250, 300, 350)

SHOCK_RUN_MIN_COUNT = 2
SHOCK_RUN_MAX_COUNT = 4
SHOCK_RISE_STRENGTH_BY_COUNT = (0, 0, 80, 90, 100)
SHOCK_RISE_DURATION_MS_BY_COUNT = (0, 0, 350, 400, 450)

TILDE_RUN_MIN_COUNT = 1
TILDE_RUN_MAX_COUNT = 4
VOWEL_EXTEND_STRENGTH_BY_COUNT = (0, 40, 60, 80, 100)
VOWEL_EXTEND_DURATION_MS_BY_COUNT = (0, 150, 250, 350, 450)

LAUGH_REPEAT_MIN_COUNT = 1
LAUGH_REPEAT_MAX_COUNT = 8
LAUGH_INTENSITY_BY_REPEAT = (0, 30, 45, 55, 65, 75, 85, 92, 100)
LAUGH_BRIGHTNESS_BY_REPEAT = (0, 40, 52, 62, 70, 78, 86, 93, 100)
LAUGH_DURATION_MS_BY_REPEAT = (0, 180, 300, 420, 540, 660, 780, 900, 1020)

LOCAL_PROSODY_TAIL_SYLLABLES = 3
LOCAL_PROSODY_IS_CHUNK_BOUNDARY = False
SENTENCE_GAP_SOURCE = "lineBreak"
SENTENCE_GAP_SUPPRESSED_BY_EXPLICIT_PAUSE = True
SENTENCE_GAP_AND_EMOTION_PAUSE_MAY_SUM = False
FINAL_TAIL_APPLIES_ONCE_AT_FILE_END = True

EXPRESSIVE_PAUSE_MIN_SEC = 0.05
EXPRESSIVE_PAUSE_MAX_SEC = 5.0

HANGUL_JUNGSEONG = (
    "ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ",
    "ㅙ", "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅠ", "ㅡ", "ㅢ",
    "ㅣ",
)
KANA_VOWEL_MAP = {
    "あ": "a", "い": "i", "う": "u", "え": "e", "お": "o",
    "ア": "a", "イ": "i", "ウ": "u", "エ": "e", "オ": "o",
}

# ─────────────────────────────────────────────────────────────────────────────
# 4. 내부 유틸
# ─────────────────────────────────────────────────────────────────────────────

_PAUSE_ARG_RE = re.compile(r"[0-9]+(\.[0-9]+)?")

_LAUGH_PATTERNS = (
    ("chuckle", re.compile("ㅋ+")),
    ("breathy", re.compile("ㅎ+")),
    ("bashful", re.compile("(?:헤+헷?|헷)")),
    ("open", re.compile("(?:호+홋?|홋)")),
    ("high_giggle", re.compile("히+")),
)


def default_resolve_emotion(name):
    return EXPRESSIVE_EMOTION_LABEL_TO_ID.get(name)


def _utf16_len(ch):
    """code point 한 개의 UTF-16 code unit 수(BMP=1, astral=2)."""
    return 2 if ord(ch) > 0xFFFF else 1


def _is_whitespace(ch):
    return ch in EXPRESSIVE_WHITESPACE_CHARS


def _strip_ws(s):
    a = list(s)
    lo = 0
    hi = len(a)
    while lo < hi and _is_whitespace(a[lo]):
        lo += 1
    while hi > lo and _is_whitespace(a[hi - 1]):
        hi -= 1
    return "".join(a[lo:hi])


def _split_ws(s):
    out = []
    cur = ""
    for ch in s:
        if _is_whitespace(ch):
            if cur != "":
                out.append(cur)
                cur = ""
        else:
            cur += ch
    if cur != "":
        out.append(cur)
    return out


def _clamp_count(raw_count, min_c, max_c):
    if raw_count > max_c:
        return max_c, True
    if raw_count < min_c:
        return min_c, False
    return raw_count, False


def _run_family_of(ch):
    if ch in DOT_RUN_CHARS:
        return "dot"
    if ch in BANG_RUN_CHARS or ch in QUESTION_RUN_CHARS:
        return "bangq"
    if ch in TILDE_RUN_CHARS:
        return "tilde"
    return None


def _match_laugh_style(t):
    for style, rx in _LAUGH_PATTERNS:
        if rx.fullmatch(t):
            return style
    return None


def _is_all_laugh_chars(t):
    if len(t) == 0:
        return False
    for ch in t:
        if ch not in LAUGH_TOKEN_CHARS:
            return False
    return True


# ─────────────────────────────────────────────────────────────────────────────
# 5. bracket 분류
# ─────────────────────────────────────────────────────────────────────────────

def _classify_expressive_bracket(inner, resolve_emotion, mode):
    t = _strip_ws(inner)
    if t == "":
        return {"type": "literalize"}
    v3 = mode == "expressive_v3"

    # 계약 3 — 웃음 규칙이 '일반 감정 태그'보다 더 구체적이므로 먼저 시도한다(v3 전용).
    if v3:
        style = _match_laugh_style(t)
        if style is not None:
            return {"type": "laugh", "style": style, "repeat": len(list(t))}
        if _is_all_laugh_chars(t):
            return {"type": "error", "code": "AMBIGUOUS_LAUGH_TOKEN", "tag": t}

    parts = _split_ws(t)
    if len(parts) == 1:
        name = parts[0]
        if v3 and EMOTION_MODIFIER_SEPARATOR in name:
            segs = name.split(EMOTION_MODIFIER_SEPARATOR)
            head = segs[0]
            eid = resolve_emotion(head)
            if eid is None:
                return {"type": "error", "code": "UNKNOWN_EXPRESSIVE_TAG", "tag": name}
            if len(segs) != 2:
                return {
                    "type": "error", "code": "INVALID_EMOTION_MODIFIER", "tag": name,
                    "arg": EMOTION_MODIFIER_SEPARATOR.join(segs[1:]), "reason": "arity",
                }
            mod = segs[1]
            if mod not in EMOTION_MODIFIER_TO_MODE:
                return {
                    "type": "error", "code": "INVALID_EMOTION_MODIFIER", "tag": name,
                    "arg": mod, "reason": "unknown_modifier",
                }
            return {
                "type": "emotion", "id": eid, "name": head,
                "mode": EMOTION_MODIFIER_TO_MODE[mod], "explicit_mode": True,
            }
        eid = resolve_emotion(name)
        if eid is not None:
            return {
                "type": "emotion", "id": eid, "name": name,
                "mode": EMOTION_TRANSITION_DEFAULT_MODE, "explicit_mode": False,
            }
        if name in EXPRESSIVE_PAUSE_NAMES:
            return {"type": "error", "code": "INVALID_EXPRESSIVE_PAUSE", "arg": "", "reason": "missing_arg"}
        return {"type": "error", "code": "UNKNOWN_EXPRESSIVE_TAG", "tag": name}

    if parts[0] in EXPRESSIVE_PAUSE_NAMES:
        if len(parts) != 2:
            return {
                "type": "error", "code": "INVALID_EXPRESSIVE_PAUSE",
                "arg": " ".join(parts[1:]), "reason": "format",
            }
        arg = parts[1]
        if not _PAUSE_ARG_RE.fullmatch(arg):
            return {"type": "error", "code": "INVALID_EXPRESSIVE_PAUSE", "arg": arg, "reason": "format"}
        sec = float(arg)
        if sec < EXPRESSIVE_PAUSE_MIN_SEC or sec > EXPRESSIVE_PAUSE_MAX_SEC:
            return {"type": "error", "code": "INVALID_EXPRESSIVE_PAUSE", "arg": arg, "reason": "range"}
        # v2(_validate_pause_arg)와 동일한 반올림식을 그대로 쓴다(두 레이어 간 불일치 방지).
        return {"type": "pause", "ms": int(round(sec * 1000))}

    # 첫 토큰이 쉼/pause 가 아닌데 내부 공백 존재 → control-tag 아님 → 리터럴(v2 와 동일).
    return {"type": "literalize"}


# ─────────────────────────────────────────────────────────────────────────────
# 6. '~' 최종 모음 판정
# ─────────────────────────────────────────────────────────────────────────────

def resolve_vowel_extend(last_char):
    """'~' 의 최종 모음 판정. 확정 불가면 degraded — 자음/전체 발화를 늘이는 폴백은 금지."""
    if last_char is None or last_char == "":
        return {"supported": False, "target_vowel": None, "degraded_reason": "no_preceding_text"}
    cp = ord(last_char)
    if 0xAC00 <= cp <= 0xD7A3:
        idx = cp - 0xAC00
        jong = idx % 28
        if jong != 0:
            return {"supported": False, "target_vowel": None, "degraded_reason": "final_consonant"}
        jung = (idx // 28) % 21
        return {"supported": True, "target_vowel": HANGUL_JUNGSEONG[jung], "degraded_reason": None}
    if last_char in KANA_VOWEL_MAP:
        return {"supported": True, "target_vowel": KANA_VOWEL_MAP[last_char], "degraded_reason": None}
    is_latin = (0x41 <= cp <= 0x5A) or (0x61 <= cp <= 0x7A)
    if is_latin:
        lower = last_char.lower()
        if lower in "aeiou":
            return {"supported": True, "target_vowel": lower, "degraded_reason": None}
        return {"supported": False, "target_vowel": None, "degraded_reason": "final_consonant"}
    is_kana = 0x3040 <= cp <= 0x30FF
    is_han = (0x3400 <= cp <= 0x4DBF) or (0x4E00 <= cp <= 0x9FFF) or (0xF900 <= cp <= 0xFAFF)
    is_jamo = (0x1100 <= cp <= 0x11FF) or (0x3130 <= cp <= 0x318F)
    if is_kana or is_han or is_jamo:
        return {"supported": False, "target_vowel": None, "degraded_reason": "unsupported_script"}
    return {"supported": False, "target_vowel": None, "degraded_reason": "no_preceding_vowel"}


# ─────────────────────────────────────────────────────────────────────────────
# 7. 파서
# ─────────────────────────────────────────────────────────────────────────────

def parse_expressive_timeline(raw, mode=None, resolve_emotion=None):
    """raw ttsText → 표현형 타임라인. TS parseExpressiveTimeline 와 동형.

    mode 를 주지 않으면 EXPRESSIVE_DEFAULT_MODE('legacy_v2') — 본문 내용으로 추론하지 않는다.
    반환: {"ok": True, "mode", "effective_version", "timeline"} 또는
          {"ok": False, "mode", "effective_version", "errors"}.
    """
    if mode is None:
        mode = EXPRESSIVE_DEFAULT_MODE
    effective_version = EXPRESSIVE_MODE_TO_VERSION[mode]
    v3 = mode == "expressive_v3"
    if resolve_emotion is None:
        resolve_emotion = default_resolve_emotion

    source = raw or ""
    chars = list(source)
    n = len(chars)

    u16_at = [0] * (n + 1)
    for k in range(n):
        u16_at[k + 1] = u16_at[k] + _utf16_len(chars[k])

    def range_of(a, b):
        return {
            "start_utf16": u16_at[a], "end_utf16": u16_at[b],
            "start_codepoint": a, "end_codepoint": b,
        }

    def offset_of(a):
        return {"utf16": u16_at[a], "codepoint": a}

    def slice_of(a, b):
        return "".join(chars[a:b])

    pending = []
    diagnostics = []
    errors = []

    def push_diag(d):
        diagnostics.append(d)
        if d["severity"] == "error":
            errors.append(d)

    i = 0
    line_index = 0
    lit_start = -1
    lit_text = ""
    lit_src = []

    def flush_lit(end_idx):
        nonlocal lit_start, lit_text, lit_src
        if lit_start < 0:
            return
        pending.append({
            "kind": "text", "start_idx": lit_start, "end_idx": end_idx,
            "line_index": line_index, "text": lit_text, "text_src": lit_src,
        })
        lit_start = -1
        lit_text = ""
        lit_src = []

    def append_lit(start_idx, ch, src_idx):
        nonlocal lit_start, lit_text
        if lit_start < 0:
            lit_start = start_idx
        lit_text += ch
        lit_src.append(src_idx)

    while i < n:
        c = chars[i]

        if c == "\n":
            flush_lit(i)
            pending.append({"kind": "lineBreak", "start_idx": i, "end_idx": i + 1, "line_index": line_index})
            line_index += 1
            i += 1
            continue

        if c == "\\":
            nxt = chars[i + 1] if i + 1 < n else ""
            if nxt == "\\":
                append_lit(i, "\\", i + 1)
                i += 2
                continue
            if nxt == "[" or nxt == "]":
                append_lit(i, nxt, i + 1)
                i += 2
                continue
            append_lit(i, "\\", i)
            i += 1
            continue

        if c == "[":
            # v2 _tokenize 와 동일한 bracket 스캔(중첩 '[' / 줄바꿈 / 미종료 → 리터럴 '[').
            j = i + 1
            inner = ""
            inner_src = []
            close = -1
            while j < n:
                cj = chars[j]
                nxt = chars[j + 1] if j + 1 < n else ""
                if cj == "\\" and nxt in ("[", "]", "\\"):
                    inner += nxt
                    inner_src.append(j + 1)
                    j += 2
                    continue
                if cj == "]":
                    close = j
                    break
                if cj == "[":
                    break
                if cj == "\n":
                    break
                inner += cj
                inner_src.append(j)
                j += 1
            if close == -1:
                append_lit(i, "[", i)
                i += 1
                continue

            cls = _classify_expressive_bracket(inner, resolve_emotion, mode)
            if cls["type"] == "literalize":
                flush_lit(i)
                text = "[" + inner + "]"
                text_src = [i] + inner_src + [close]
                pending.append({
                    "kind": "text", "start_idx": i, "end_idx": close + 1,
                    "line_index": line_index, "text": text, "text_src": text_src,
                })
                i = close + 1
                continue
            flush_lit(i)
            if cls["type"] == "error":
                d = {"code": cls["code"], "severity": "error", "ui_offset_utf16": u16_at[i]}
                if "tag" in cls:
                    d["tag"] = cls["tag"]
                if "arg" in cls:
                    d["arg"] = cls["arg"]
                if "reason" in cls:
                    d["reason"] = cls["reason"]
                push_diag(d)
                i = close + 1
                continue
            kind = ("nonverbalLaugh" if cls["type"] == "laugh"
                    else "emotionTransition" if cls["type"] == "emotion"
                    else "explicitPause")
            pending.append({
                "kind": kind, "start_idx": i, "end_idx": close + 1,
                "line_index": line_index, "payload": cls,
            })
            i = close + 1
            continue

        if v3:
            fam = _run_family_of(c)
            if fam is not None:
                # longest-token-first: 같은 family 문자의 '최대' 연속 구간을 한 토큰으로.
                j = i
                while j < n and _run_family_of(chars[j]) == fam:
                    j += 1
                flush_lit(i)
                pending.append({
                    "kind": "localProsody", "start_idx": i, "end_idx": j, "line_index": line_index,
                    "payload": {"run_family": fam, "run": slice_of(i, j)},
                })
                i = j
                continue

        append_lit(i, c, i)
        i += 1

    flush_lit(n)

    # ── 이벤트 조립 ──
    nodes = []
    node_text_src = []
    emotion_transitions = []
    local_prosody = []
    laughs = []
    explicit_pauses = []

    def collect_host(node_index):
        out = []
        for k in range(node_index - 1, -1, -1):
            nd = nodes[k]
            if nd["kind"] == "emotionTransition":
                continue  # 감정 태그는 발화를 끊지 않는다(계약 1)
            if nd["kind"] != "text":
                break
            src = node_text_src[k] or []
            t = list(nd["text"])
            seg = []
            for q in range(len(t)):
                s_idx = src[q] if q < len(src) else nd["range"]["start_codepoint"]
                seg.append((t[q], s_idx))
            out = seg + out
        return out

    def build_local_prosody(pay, p, node_index, rng, raw_token):
        run_chars = list(pay["run"])
        if pay["run_family"] == "dot":
            raw_count = 0
            for ch in run_chars:
                raw_count += DOT_CHAR_WEIGHTS.get(ch, 1)
            min_c, max_c = DOT_RUN_MIN_COUNT, DOT_RUN_MAX_COUNT
            kind = "firm_end" if raw_count <= 1 else "fade_end"
        elif pay["run_family"] == "tilde":
            raw_count = len(run_chars)
            min_c, max_c = TILDE_RUN_MIN_COUNT, TILDE_RUN_MAX_COUNT
            kind = "vowel_extend"
        else:
            bangs = 0
            questions = 0
            for ch in run_chars:
                if ch in BANG_RUN_CHARS:
                    bangs += 1
                else:
                    questions += 1
            raw_count = len(run_chars)
            if bangs > 0 and questions > 0:
                kind, min_c, max_c = "shock_rise", SHOCK_RUN_MIN_COUNT, SHOCK_RUN_MAX_COUNT
            elif bangs > 0:
                kind, min_c, max_c = "emphasis", BANG_RUN_MIN_COUNT, BANG_RUN_MAX_COUNT
            else:
                kind, min_c, max_c = "question_rise", QUESTION_RUN_MIN_COUNT, QUESTION_RUN_MAX_COUNT

        effective, capped = _clamp_count(raw_count, min_c, max_c)

        if kind == "firm_end":
            strength, duration_hint, scope_kind = FIRM_END_STRENGTH, FIRM_END_DURATION_MS, "final_syllables"
        elif kind == "fade_end":
            strength = FADE_END_STRENGTH_BY_COUNT[effective]
            duration_hint = FADE_END_DURATION_MS_BY_COUNT[effective]
            scope_kind = "final_syllables"
        elif kind == "emphasis":
            strength = EMPHASIS_STRENGTH_BY_COUNT[effective]
            duration_hint = EMPHASIS_DURATION_MS_BY_COUNT[effective]
            scope_kind = "latter_half"
        elif kind == "question_rise":
            strength = QUESTION_RISE_STRENGTH_BY_COUNT[effective]
            duration_hint = QUESTION_RISE_DURATION_MS_BY_COUNT[effective]
            scope_kind = "final_word"
        elif kind == "shock_rise":
            strength = SHOCK_RISE_STRENGTH_BY_COUNT[effective]
            duration_hint = SHOCK_RISE_DURATION_MS_BY_COUNT[effective]
            scope_kind = "final_word"
        else:
            strength = VOWEL_EXTEND_STRENGTH_BY_COUNT[effective]
            duration_hint = VOWEL_EXTEND_DURATION_MS_BY_COUNT[effective]
            scope_kind = "final_vowel"

        host = collect_host(node_index)
        if len(host) > 0:
            host_range = range_of(host[0][1], host[-1][1] + 1)
        else:
            host_range = range_of(p["start_idx"], p["start_idx"])

        host_end = len(host)
        while host_end > 0 and _is_whitespace(host[host_end - 1][0]):
            host_end -= 1

        vowel_extend = None
        if host_end == 0:
            scope_range = range_of(p["start_idx"], p["start_idx"])
            push_diag({
                "code": "PROSODY_WITHOUT_HOST", "severity": "warning",
                "reason": kind, "ui_offset_utf16": rng["start_utf16"],
            })
            if kind == "vowel_extend":
                vowel_extend = {"supported": False, "target_vowel": None, "degraded_reason": "no_preceding_text"}
                push_diag({
                    "code": "UNSUPPORTED_VOWEL_EXTEND", "severity": "warning",
                    "reason": "no_preceding_text", "ui_offset_utf16": rng["start_utf16"],
                })
        else:
            if scope_kind == "final_vowel":
                frm = host_end - 1
            elif scope_kind == "final_syllables":
                frm = host_end - min(LOCAL_PROSODY_TAIL_SYLLABLES, host_end)
            elif scope_kind == "latter_half":
                frm = host_end - ((host_end + 1) // 2)
            else:
                frm = host_end
                while frm > 0 and not _is_whitespace(host[frm - 1][0]):
                    frm -= 1
            scope_range = range_of(host[frm][1], host[host_end - 1][1] + 1)
            if kind == "vowel_extend":
                vowel_extend = resolve_vowel_extend(host[host_end - 1][0])
                if not vowel_extend["supported"]:
                    push_diag({
                        "code": "UNSUPPORTED_VOWEL_EXTEND", "severity": "warning",
                        "reason": vowel_extend["degraded_reason"] or "no_preceding_vowel",
                        "ui_offset_utf16": rng["start_utf16"],
                    })

        return {
            "kind": kind, "source_range": rng, "strength": strength, "duration_hint": duration_hint,
            "raw_token": raw_token, "raw_count": raw_count, "effective_count": effective, "capped": capped,
            "scope_kind": scope_kind, "scope_range": scope_range, "host_range": host_range,
            "is_chunk_boundary": LOCAL_PROSODY_IS_CHUNK_BOUNDARY, "extra_pause_ms": 0,
            "vowel_extend": vowel_extend, "node_index": node_index, "line_index": p["line_index"],
        }

    for p in pending:
        node_index = len(nodes)
        rng = range_of(p["start_idx"], p["end_idx"])
        raw_token = slice_of(p["start_idx"], p["end_idx"])
        kind = p["kind"]

        if kind == "text":
            nodes.append({
                "kind": "text", "raw_token": raw_token, "range": rng,
                "line_index": p["line_index"], "text": p.get("text", ""),
            })
            node_text_src.append(p.get("text_src", []))
            continue
        if kind == "lineBreak":
            nodes.append({"kind": "lineBreak", "raw_token": raw_token, "range": rng, "line_index": p["line_index"]})
            node_text_src.append(None)
            continue
        if kind == "emotionTransition":
            cls = p["payload"]
            event_index = len(emotion_transitions)
            emotion_transitions.append({
                "target_emotion": cls["id"],
                "target_emotion_label": cls["name"],
                "source_offset": offset_of(p["start_idx"]),
                "source_range": rng,
                "transition_mode": cls["mode"],
                "transition_strength": EMOTION_TRANSITION_DEFAULT_STRENGTH,
                "transition_duration_hint": (
                    EMOTION_IMMEDIATE_DURATION_MS if cls["mode"] == "immediate" else EMOTION_BLEND_DURATION_MS
                ),
                "extra_pause_ms": EMOTION_TRANSITION_EXTRA_PAUSE_MS,
                "is_chunk_boundary": EMOTION_TRANSITION_IS_CHUNK_BOUNDARY,
                "explicit_mode": cls["explicit_mode"],
                "raw_token": raw_token, "node_index": node_index, "line_index": p["line_index"],
            })
            nodes.append({
                "kind": "emotionTransition", "raw_token": raw_token, "range": rng,
                "line_index": p["line_index"], "event_index": event_index,
            })
            node_text_src.append(None)
            continue
        if kind == "explicitPause":
            cls = p["payload"]
            event_index = len(explicit_pauses)
            explicit_pauses.append({
                "pause_ms": cls["ms"], "raw_token": raw_token, "source_range": rng,
                "node_index": node_index, "line_index": p["line_index"],
            })
            nodes.append({
                "kind": "explicitPause", "raw_token": raw_token, "range": rng,
                "line_index": p["line_index"], "event_index": event_index,
            })
            node_text_src.append(None)
            continue
        if kind == "nonverbalLaugh":
            cls = p["payload"]
            effective, capped = _clamp_count(cls["repeat"], LAUGH_REPEAT_MIN_COUNT, LAUGH_REPEAT_MAX_COUNT)
            event_index = len(laughs)
            laughs.append({
                "style": cls["style"],
                "intensity": LAUGH_INTENSITY_BY_REPEAT[effective],
                "brightness": LAUGH_BRIGHTNESS_BY_REPEAT[effective],
                "duration_hint": LAUGH_DURATION_MS_BY_REPEAT[effective],
                "position": "standalone",  # 아래에서 확정
                "raw_token": raw_token,
                "raw_repeat_count": cls["repeat"],
                "effective_repeat_count": effective,
                "capped": capped,
                "source_range": rng,
                "is_chunk_boundary": False,
                "node_index": node_index, "line_index": p["line_index"],
            })
            nodes.append({
                "kind": "nonverbalLaugh", "raw_token": raw_token, "range": rng,
                "line_index": p["line_index"], "event_index": event_index,
            })
            node_text_src.append(None)
            continue
        # localProsody
        event_index = len(local_prosody)
        local_prosody.append(build_local_prosody(p["payload"], p, node_index, rng, raw_token))
        nodes.append({
            "kind": "localProsody", "raw_token": raw_token, "range": rng,
            "line_index": p["line_index"], "event_index": event_index,
        })
        node_text_src.append(None)

    # ── 웃음 position 확정 ──
    speech_before = [False] * len(nodes)
    speech_after = [False] * len(nodes)
    cur = False
    for k in range(len(nodes)):
        speech_before[k] = cur
        nd = nodes[k]
        if nd["kind"] == "lineBreak":
            cur = False
        elif nd["kind"] == "text":
            if _has_non_whitespace(nd["text"]):
                cur = True
        elif nd["kind"] == "localProsody":
            cur = True
    cur_a = False
    for k in range(len(nodes) - 1, -1, -1):
        speech_after[k] = cur_a
        nd = nodes[k]
        if nd["kind"] == "lineBreak":
            cur_a = False
        elif nd["kind"] == "text":
            if _has_non_whitespace(nd["text"]):
                cur_a = True
        elif nd["kind"] == "localProsody":
            cur_a = True
    for lg in laughs:
        b = speech_before[lg["node_index"]]
        a = speech_after[lg["node_index"]]
        lg["position"] = "inline" if (b and a) else "trailing" if b else "leading" if a else "standalone"

    # ── 경계 결정(우선순위 고정, 합산 금지) ──
    boundaries = []
    consumed_line_break = set()
    for pz in explicit_pauses:
        adjacent = _find_adjacent_line_break(nodes, pz["node_index"])
        candidates = ["explicitPause"]
        suppressed = []
        if adjacent >= 0:
            consumed_line_break.add(adjacent)
            candidates.append("sentenceGap")
            suppressed.append("sentenceGap")
        boundaries.append({
            "kind": "explicitPause", "candidates": candidates, "suppressed": suppressed,
            "pause_ms": pz["pause_ms"],
            "source_offset": {
                "utf16": pz["source_range"]["start_utf16"],
                "codepoint": pz["source_range"]["start_codepoint"],
            },
            "line_index": pz["line_index"],
        })
    for k in range(len(nodes)):
        nd = nodes[k]
        if nd["kind"] != "lineBreak" or k in consumed_line_break:
            continue
        boundaries.append({
            "kind": "sentenceGap", "candidates": ["sentenceGap"], "suppressed": [],
            "pause_ms": None,  # 런타임 config(ttsSilenceGap) 소관 — 파서가 정하지 않는다
            "source_offset": {
                "utf16": nd["range"]["start_utf16"], "codepoint": nd["range"]["start_codepoint"],
            },
            "line_index": nd["line_index"],
        })
    boundaries.sort(key=lambda b: b["source_offset"]["codepoint"])
    boundaries.append({
        "kind": "finalTail", "candidates": ["finalTail"], "suppressed": [], "pause_ms": None,
        "source_offset": offset_of(n), "line_index": line_index,
    })

    if len(errors) > 0:
        return {"ok": False, "mode": mode, "effective_version": effective_version, "errors": errors}

    # ── 파생 텍스트 ──
    verbatim_text = ""
    plain_text = ""
    for nd in nodes:
        if nd["kind"] == "text":
            verbatim_text += nd["text"]
            plain_text += nd["text"]
        elif nd["kind"] == "lineBreak":
            verbatim_text += "\n"
            plain_text += "\n"
        elif nd["kind"] == "localProsody":
            verbatim_text += nd["raw_token"]

    used_emotion_ids = []
    seen = set()
    for et in emotion_transitions:
        if et["target_emotion"] != "default" and et["target_emotion"] not in seen:
            seen.add(et["target_emotion"])
            used_emotion_ids.append(et["target_emotion"])

    total_explicit_pause_ms = 0
    for pz in explicit_pauses:
        total_explicit_pause_ms += pz["pause_ms"]
    degraded_vowel_extend_count = 0
    capped_token_count = 0
    for lp in local_prosody:
        if lp["vowel_extend"] is not None and not lp["vowel_extend"]["supported"]:
            degraded_vowel_extend_count += 1
        if lp["capped"]:
            capped_token_count += 1
    for lg in laughs:
        if lg["capped"]:
            capped_token_count += 1

    line_count = 0 if len(nodes) == 0 else line_index + 1

    full_sha256 = _compute_expressive_sha256(
        mode, effective_version, nodes, emotion_transitions, local_prosody, laughs,
        explicit_pauses, boundaries, diagnostics, verbatim_text, plain_text,
    )

    summary = {
        "contract_version": EXPRESSIVE_CONTRACT_VERSION,
        "mode": mode,
        "effective_version": effective_version,
        "node_count": len(nodes),
        "line_count": line_count,
        "emotion_transition_count": len(emotion_transitions),
        "local_prosody_count": len(local_prosody),
        "laugh_count": len(laughs),
        "explicit_pause_count": len(explicit_pauses),
        "total_explicit_pause_ms": total_explicit_pause_ms,
        "used_emotion_ids": used_emotion_ids,
        "degraded_vowel_extend_count": degraded_vowel_extend_count,
        "capped_token_count": capped_token_count,
        "sha8": full_sha256[:8],
    }

    timeline = {
        "contract_version": EXPRESSIVE_CONTRACT_VERSION,
        "legacy_plan_version": EXPRESSIVE_LEGACY_PLAN_VERSION,
        "mode": mode,
        "effective_version": effective_version,
        "expressive_enabled": v3,
        "has_expressive_events": len(local_prosody) > 0 or len(laughs) > 0,
        "nodes": nodes,
        "emotion_transitions": emotion_transitions,
        "local_prosody": local_prosody,
        "laughs": laughs,
        "explicit_pauses": explicit_pauses,
        "boundaries": boundaries,
        "diagnostics": diagnostics,
        "verbatim_text": verbatim_text,
        "plain_text": plain_text,
        "summary": summary,
        "full_sha256": full_sha256,
    }
    return {"ok": True, "mode": mode, "effective_version": effective_version, "timeline": timeline}


def _has_non_whitespace(s):
    for ch in s:
        if not _is_whitespace(ch):
            return True
    return False


def _find_adjacent_line_break(nodes, pause_node_index):
    """explicit pause 노드 기준, 사이에 공백 텍스트만 두고 인접한 lineBreak 노드 index(없으면 -1)."""
    for k in range(pause_node_index + 1, len(nodes)):
        nd = nodes[k]
        if nd["kind"] == "lineBreak":
            return k
        if nd["kind"] == "text" and not _has_non_whitespace(nd["text"]):
            continue
        break
    for k in range(pause_node_index - 1, -1, -1):
        nd = nodes[k]
        if nd["kind"] == "lineBreak":
            return k
        if nd["kind"] == "text" and not _has_non_whitespace(nd["text"]):
            continue
        break
    return -1


# ─────────────────────────────────────────────────────────────────────────────
# 8. 원문 무손실 round-trip
# ─────────────────────────────────────────────────────────────────────────────

def reconstruct_source(timeline):
    """노드 raw_token 을 순서대로 이어붙여 원문을 복원한다."""
    out = ""
    for nd in timeline["nodes"]:
        out += nd["raw_token"]
    return out


def verify_round_trip(raw, timeline):
    """원문 무손실 검증: 복원 문자열 일치 + range 연속성."""
    reconstructed = reconstruct_source(timeline)
    cursor_cp = 0
    cursor_u16 = 0
    contiguous = True
    for nd in timeline["nodes"]:
        r = nd["range"]
        if r["start_codepoint"] != cursor_cp or r["start_utf16"] != cursor_u16:
            contiguous = False
            break
        cursor_cp = r["end_codepoint"]
        cursor_u16 = r["end_utf16"]
    src = raw or ""
    if contiguous:
        total_u16 = sum(_utf16_len(c) for c in src)
        if cursor_cp != len(src) or cursor_u16 != total_u16:
            contiguous = False
    return {
        "ok": reconstructed == src and contiguous,
        "reconstructed": reconstructed,
        "contiguous": contiguous,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 9. canonical 직렬화 + 해시 (TS 와 동일 알고리즘, 정수만)
# ─────────────────────────────────────────────────────────────────────────────

def _json_escape(s):
    out = '"'
    for ch in s:
        code = ord(ch)
        if ch == '"':
            out += '\\"'
        elif ch == "\\":
            out += "\\\\"
        elif ch == "\n":
            out += "\\n"
        elif ch == "\r":
            out += "\\r"
        elif ch == "\t":
            out += "\\t"
        elif code < 0x20:
            out += "\\u%04x" % code
        else:
            out += ch
    return out + '"'


def _canonicalize(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        raise ValueError("canonical: float 금지")
    if isinstance(v, str):
        return _json_escape(v)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(_canonicalize(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys())
        return "{" + ",".join(_json_escape(k) + ":" + _canonicalize(v[k]) for k in keys) + "}"
    raise ValueError("canonical: 지원하지 않는 타입")


def _sha256_hex(data_bytes):
    return hashlib.sha256(data_bytes).hexdigest()


def sha256_hex_of_string(s):
    return _sha256_hex(s.encode("utf-8"))


def _text_digest(s):
    b = s.encode("utf-8")
    return {"bytes": len(b), "sha256": _sha256_hex(b)}


def _compute_expressive_sha256(mode, effective_version, nodes, emotion_transitions, local_prosody,
                               laughs, explicit_pauses, boundaries, diagnostics,
                               verbatim_text, plain_text):
    canon_nodes = []
    for i, nd in enumerate(nodes):
        d = _text_digest(nd["raw_token"])
        r = nd["range"]
        canon_nodes.append({
            "i": i, "kind": nd["kind"], "line_index": nd["line_index"],
            "start_cp": r["start_codepoint"], "end_cp": r["end_codepoint"],
            "start_u16": r["start_utf16"], "end_u16": r["end_utf16"],
            "raw_bytes": d["bytes"], "raw_sha256": d["sha256"],
        })
    canon_emotions = []
    for i, e in enumerate(emotion_transitions):
        r = e["source_range"]
        canon_emotions.append({
            "i": i, "node_index": e["node_index"], "target_emotion": e["target_emotion"],
            "mode": e["transition_mode"], "strength": e["transition_strength"],
            "duration_hint": e["transition_duration_hint"], "extra_pause_ms": e["extra_pause_ms"],
            "is_chunk_boundary": e["is_chunk_boundary"], "explicit_mode": e["explicit_mode"],
            "start_cp": r["start_codepoint"], "end_cp": r["end_codepoint"],
        })
    canon_prosody = []
    for i, e in enumerate(local_prosody):
        r = e["source_range"]
        sr = e["scope_range"]
        hr = e["host_range"]
        ve = e["vowel_extend"]
        canon_prosody.append({
            "i": i, "node_index": e["node_index"], "kind": e["kind"], "strength": e["strength"],
            "duration_hint": e["duration_hint"], "raw_count": e["raw_count"],
            "effective_count": e["effective_count"], "capped": e["capped"],
            "scope_kind": e["scope_kind"], "scope_start_cp": sr["start_codepoint"],
            "scope_end_cp": sr["end_codepoint"], "host_start_cp": hr["start_codepoint"],
            "host_end_cp": hr["end_codepoint"], "start_cp": r["start_codepoint"],
            "end_cp": r["end_codepoint"], "extra_pause_ms": e["extra_pause_ms"],
            "is_chunk_boundary": e["is_chunk_boundary"],
            "vowel_supported": None if ve is None else ve["supported"],
            "vowel_target": None if ve is None else ve["target_vowel"],
            "vowel_reason": None if ve is None else ve["degraded_reason"],
        })
    canon_laughs = []
    for i, e in enumerate(laughs):
        r = e["source_range"]
        canon_laughs.append({
            "i": i, "node_index": e["node_index"], "style": e["style"], "intensity": e["intensity"],
            "brightness": e["brightness"], "duration_hint": e["duration_hint"], "position": e["position"],
            "raw_repeat": e["raw_repeat_count"], "effective_repeat": e["effective_repeat_count"],
            "capped": e["capped"], "start_cp": r["start_codepoint"], "end_cp": r["end_codepoint"],
        })
    canon_pauses = []
    for i, e in enumerate(explicit_pauses):
        r = e["source_range"]
        canon_pauses.append({
            "i": i, "node_index": e["node_index"], "pause_ms": e["pause_ms"],
            "start_cp": r["start_codepoint"], "end_cp": r["end_codepoint"],
        })
    canon_boundaries = []
    for i, b in enumerate(boundaries):
        canon_boundaries.append({
            "i": i, "kind": b["kind"], "candidates": list(b["candidates"]),
            "suppressed": list(b["suppressed"]), "pause_ms": b["pause_ms"],
            "offset_cp": b["source_offset"]["codepoint"], "line_index": b["line_index"],
        })
    canon_diags = []
    for i, d in enumerate(diagnostics):
        canon_diags.append({
            "i": i, "code": d["code"], "severity": d["severity"],
            "reason": d.get("reason", None), "offset_u16": d["ui_offset_utf16"],
        })
    vd = _text_digest(verbatim_text)
    pd = _text_digest(plain_text)
    canon_obj = {
        "contract_version": EXPRESSIVE_CONTRACT_VERSION,
        "legacy_plan_version": EXPRESSIVE_LEGACY_PLAN_VERSION,
        "mode": mode,
        "effective_version": effective_version,
        "node_count": len(nodes),
        "nodes": canon_nodes,
        "emotion_transitions": canon_emotions,
        "local_prosody": canon_prosody,
        "laughs": canon_laughs,
        "explicit_pauses": canon_pauses,
        "boundaries": canon_boundaries,
        "diagnostics": canon_diags,
        "verbatim_bytes": vd["bytes"], "verbatim_sha256": vd["sha256"],
        "plain_bytes": pd["bytes"], "plain_sha256": pd["sha256"],
    }
    return _sha256_hex(_canonicalize(canon_obj).encode("utf-8"))


# ─────────────────────────────────────────────────────────────────────────────
# 10. 모드 플래그 영속 계약 (store/session.json · buildTtsConfig payload · result metadata)
#
#  ⚠️ 세 곳 모두 '같은 필드 이름·같은 타입·같은 값'이어야 한다.
#  ⚠️ 필드가 없으면 언제나 legacy_v2. 본문 내용은 절대 이 값을 바꾸지 않는다.
#  ⚠️ 값이 있는데 계약 밖이면 조용히 기본값으로 넘어가지 말고 EXPRESSIVE_MODE_INVALID 로 실패시킨다.
# ─────────────────────────────────────────────────────────────────────────────

EXPRESSIVE_MODE_FIELD = "ttsExpressiveMode"
EXPRESSIVE_MODE_CARRIERS = ("session", "config", "metadata")
EXPRESSIVE_MODE_CARRIER_PAIRS = ("session_vs_config", "session_vs_metadata", "config_vs_metadata")
EXPRESSIVE_MODE_PRESET_MAY_CHANGE = False
EXPRESSIVE_MODE_SOURCES = ("absent", "explicit", "invalid")


def _js_typeof(value):
    """TS 의 `typeof` 와 같은 문자열을 돌려준다(parity 를 위해 bool 을 int 보다 먼저 본다)."""
    if isinstance(value, str):
        return "string"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if callable(value):
        return "function"
    return "object"


def resolve_expressive_mode(value):
    """있을 수도 없을 수도 있는 플래그 값 → 모드. 세 캐리어 모두 이 함수 하나만 쓴다."""
    if value is None:
        return {"mode": EXPRESSIVE_DEFAULT_MODE, "source": "absent", "valid": True,
                "error_code": None, "raw_type": None}
    if isinstance(value, str) and not isinstance(value, bool) and value in EXPRESSIVE_MODES:
        return {"mode": value, "source": "explicit", "valid": True,
                "error_code": None, "raw_type": "string"}
    return {"mode": EXPRESSIVE_DEFAULT_MODE, "source": "invalid", "valid": False,
            "error_code": "EXPRESSIVE_MODE_INVALID", "raw_type": _js_typeof(value)}


def read_expressive_mode(carrier):
    """캐리어 dict 에서 EXPRESSIVE_MODE_FIELD 를 읽어 모드로 해석."""
    if carrier is None:
        return {"mode": EXPRESSIVE_DEFAULT_MODE, "source": "absent", "valid": True,
                "error_code": None, "raw_type": None}
    if EXPRESSIVE_MODE_FIELD not in carrier:
        return {"mode": EXPRESSIVE_DEFAULT_MODE, "source": "absent", "valid": True,
                "error_code": None, "raw_type": None}
    return resolve_expressive_mode(carrier[EXPRESSIVE_MODE_FIELD])


def write_expressive_mode(carrier, mode):
    """캐리어에 모드를 기록한 '새 dict' 를 돌려준다(round-trip 의 쓰기 쪽)."""
    out = dict(carrier or {})
    out[EXPRESSIVE_MODE_FIELD] = mode
    return out


def apply_preset_preserving_expressive_mode(base, preset):
    """preset 이 이 플래그를 조용히 바꾸지 못하게 한다(base 값을 반드시 유지)."""
    merged = dict(base or {})
    merged.update(preset or {})
    if base is not None and EXPRESSIVE_MODE_FIELD in base:
        merged[EXPRESSIVE_MODE_FIELD] = base[EXPRESSIVE_MODE_FIELD]
    else:
        merged.pop(EXPRESSIVE_MODE_FIELD, None)
    return merged


def assert_expressive_mode_carriers(session, config, metadata):
    """store/session.json · config payload · result metadata 세 곳의 모드가 같은지 검증."""
    resolved = {
        "session": read_expressive_mode(session),
        "config": read_expressive_mode(config),
        "metadata": read_expressive_mode(metadata),
    }
    invalid_carriers = [c for c in EXPRESSIVE_MODE_CARRIERS if not resolved[c]["valid"]]
    mismatches = []
    for pair, a, b in (
        ("session_vs_config", "session", "config"),
        ("session_vs_metadata", "session", "metadata"),
        ("config_vs_metadata", "config", "metadata"),
    ):
        if resolved[a]["mode"] != resolved[b]["mode"]:
            mismatches.append({"pair": pair, "left": resolved[a]["mode"], "right": resolved[b]["mode"]})
    if len(invalid_carriers) > 0:
        error_code = "EXPRESSIVE_MODE_INVALID"
    elif len(mismatches) > 0:
        error_code = "EXPRESSIVE_MODE_CARRIER_MISMATCH"
    else:
        error_code = None
    ok = error_code is None
    return {
        "ok": ok,
        "mode": resolved["session"]["mode"] if ok else None,
        "resolved": resolved,
        "invalid_carriers": invalid_carriers,
        "mismatches": mismatches,
        "error_code": error_code,
    }
