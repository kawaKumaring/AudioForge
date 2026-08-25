"""TTS 감정/쉼 문법 파서 (parser_version=2) — 순수 stdlib, 합성 권위.

src/shared/ttsGrammar.ts 와 동형(isomorphic): 같은 raw ttsText 입력에 대해
동일한 정규화 segments + 동일한 canonical full SHA256 을 산출한다(D-2 parity 안전장치).

⚠️ 대사 전문을 로그/오류 payload에 넣지 않는다(code·tag·arg·reason·offset 필드만).
⚠️ numpy 등 무거운 의존성 없음 — 텍스트 파서는 순수. (합성 파이프라인 배선은 Agent B/통합 담당.)
"""
import hashlib
import re
import unicodedata  # noqa: F401 (미사용이지만 code-point 의미 문서화용 자리)

TTS_PARSER_VERSION = 2

TTS_GRAMMAR_ERROR_CODES = (
    "UNKNOWN_TTS_TAG",
    "INVALID_PAUSE_TAG",
    "EMPTY_EMOTION_SEGMENT",
    "PARSER_PARITY_MISMATCH",
    "INVALID_TTS_CONFIG",
)

# 감정 label(한글)/id(영문) → emotionId. python/tts_worker.py EMOTION_TAGS 의 거울.
# 드리프트 방지: test_tts_grammar_parity 가 tts_worker.py 를 ast 로 읽어 이 표와 대조한다.
# (src/shared/ttsGrammar.ts TTS_EMOTION_LABEL_TO_ID 와도 동일해야 한다.)
TTS_EMOTION_LABEL_TO_ID = {
    "기본": "default", "기쁨": "happy", "슬픔": "sad", "화남": "angry",
    "놀람": "surprise", "속삭임": "whisper", "진지": "serious", "명랑": "cheerful",
    "걱정": "worried", "피곤": "tired", "공손": "polite", "냉소": "sarcastic",
    "긴장": "nervous", "부끄러움": "shy", "자신감": "confident", "위로": "comforting",
    "흥분": "excited", "공포": "scared", "짜증": "annoyed", "나레이션": "narration",
    "그리움": "longing", "질투": "jealous", "감동": "touched", "허탈": "empty",
    "비꼼": "mocking", "애교": "cute", "냉정": "cold", "다정": "tender",
    "울먹": "tearful", "한숨": "sighing", "비장": "solemn", "장난": "playful",
    "경멸": "contempt", "동경": "admiring", "초조": "restless", "체념": "resigned",
    "호기심": "curious", "지루함": "bored", "당황": "flustered", "득의": "proud",
    "설렘": "flutter", "유혹": "seductive", "달콤": "sweet", "은밀": "intimate",
    "애틋": "bittersweet", "매력": "charming", "흥분(성적)": "aroused",
    "절정": "climax", "신음": "moaning", "황홀": "ecstasy",
    # English aliases
    "happy": "happy", "sad": "sad", "angry": "angry", "surprise": "surprise",
    "whisper": "whisper", "serious": "serious", "cheerful": "cheerful",
    "worried": "worried", "tired": "tired", "polite": "polite", "sarcastic": "sarcastic",
    "nervous": "nervous", "shy": "shy", "confident": "confident", "comforting": "comforting",
    "excited": "excited", "scared": "scared", "annoyed": "annoyed", "narration": "narration",
    "longing": "longing", "jealous": "jealous", "touched": "touched", "empty": "empty",
    "mocking": "mocking", "cute": "cute", "cold": "cold", "tender": "tender",
    "tearful": "tearful", "sighing": "sighing", "solemn": "solemn", "playful": "playful",
    "contempt": "contempt", "admiring": "admiring", "restless": "restless", "resigned": "resigned",
    "curious": "curious", "bored": "bored", "flustered": "flustered", "proud": "proud",
    "flutter": "flutter", "seductive": "seductive", "sweet": "sweet", "intimate": "intimate",
    "bittersweet": "bittersweet", "charming": "charming", "aroused": "aroused",
    "climax": "climax", "moaning": "moaning", "ecstasy": "ecstasy",
}

TTS_PAUSE_NAMES = {"쉼", "pause"}
TTS_PAUSE_MIN_SEC = 0.05
TTS_PAUSE_MAX_SEC = 5.0
TTS_NON_REFERENCE_EMOTION_IDS = {"default"}

_PAUSE_ARG_RE = re.compile(r"^[0-9]+(\.[0-9]+)?$")
_WS_SPLIT_RE = re.compile(r"\s+")
_LSTRIP_RE = re.compile(r"^\s+")


class TtsGrammarError:
    """구조화 오류(비민감). code + 위치/식별자만."""

    __slots__ = ("code", "tag", "arg", "reason", "ui_offset_utf16")

    def __init__(self, code, tag=None, arg=None, reason=None, ui_offset_utf16=None):
        self.code = code
        self.tag = tag
        self.arg = arg
        self.reason = reason
        self.ui_offset_utf16 = ui_offset_utf16

    def to_dict(self):
        d = {"code": self.code}
        if self.tag is not None:
            d["tag"] = self.tag
        if self.arg is not None:
            d["arg"] = self.arg
        if self.reason is not None:
            d["reason"] = self.reason
        if self.ui_offset_utf16 is not None:
            d["ui_offset_utf16"] = self.ui_offset_utf16
        return d

    def __repr__(self):
        return "TtsGrammarError(%r)" % (self.to_dict(),)


def default_resolve_emotion(name):
    return TTS_EMOTION_LABEL_TO_ID.get(name)


def _utf16_len(ch):
    """code point 한 개의 UTF-16 code unit 수(BMP=1, astral=2)."""
    return 2 if ord(ch) > 0xFFFF else 1


def _validate_pause_arg(arg):
    if not _PAUSE_ARG_RE.match(arg):
        return {"type": "pauseInvalid", "arg": arg, "reason": "format"}
    sec = float(arg)
    if sec < TTS_PAUSE_MIN_SEC or sec > TTS_PAUSE_MAX_SEC:
        return {"type": "pauseInvalid", "arg": arg, "reason": "range"}
    ms = int(round(sec * 1000))
    return {"type": "pause", "seconds": sec, "ms": ms, "arg": arg}


def _classify_bracket(inner, resolve_emotion):
    t = inner.strip()
    if t == "":
        return {"type": "literalize"}
    parts = _WS_SPLIT_RE.split(t)
    if len(parts) == 1:
        name = parts[0]
        eid = resolve_emotion(name)
        if eid is not None:
            return {"type": "emotion", "id": eid, "name": name}
        if name in TTS_PAUSE_NAMES:
            return {"type": "pauseInvalid", "arg": "", "reason": "missing_arg"}
        return {"type": "unknown", "name": name}
    if parts[0] in TTS_PAUSE_NAMES:
        if len(parts) != 2:
            return {"type": "pauseInvalid", "arg": " ".join(parts[1:]), "reason": "format"}
        return _validate_pause_arg(parts[1])
    # 첫 토큰이 쉼/pause 아닌데 내부 공백 존재 → control-tag 아님 → 리터럴.
    return {"type": "literalize"}


def _tokenize(raw, resolve_emotion):
    """원문을 pieces 리스트로. 각 piece dict: kind + 전역 offset(u16/cp) + lineIndex."""
    chars = list(raw)  # code point 리스트
    pieces = []
    i = 0
    u16 = 0
    cp = 0
    line_index = 0
    lit_text = []
    lit_start = None  # (u16, cp)

    def here():
        return (u16, cp)

    def flush_lit():
        nonlocal lit_text, lit_start
        if lit_start is not None:
            pieces.append({"kind": "lit", "text": "".join(lit_text),
                           "start": lit_start, "end": here(), "line": line_index})
        lit_text = []
        lit_start = None

    n = len(chars)
    while i < n:
        c = chars[i]
        if c == "\n":
            flush_lit()
            s = here()
            u16 += 1
            cp += 1
            pieces.append({"kind": "linebreak", "start": s, "end": here(), "line": line_index})
            line_index += 1
            i += 1
            continue
        if c == "\\":
            nxt = chars[i + 1] if i + 1 < n else None
            if nxt == "\\":
                if lit_start is None:
                    lit_start = here()
                lit_text.append("\\")
                u16 += 1
                cp += 1  # 첫 backslash 소비(위치)
                u16 += 1
                cp += 1  # 둘째 backslash 소비
                i += 2
                continue
            if nxt == "[" or nxt == "]":
                if lit_start is None:
                    lit_start = here()
                lit_text.append(nxt)
                u16 += 1
                cp += 1  # backslash
                u16 += _utf16_len(nxt)
                cp += 1  # bracket char
                i += 2
                continue
            # \x 기타 → backslash literal, 다음 문자 정상 처리
            if lit_start is None:
                lit_start = here()
            lit_text.append("\\")
            u16 += 1
            cp += 1
            i += 1
            continue
        if c == "[":
            j = i + 1
            inner_chars = []
            close = -1
            open_start = here()
            while j < n:
                cj = chars[j]
                if cj == "\\" and j + 1 < n and chars[j + 1] in ("[", "]", "\\"):
                    inner_chars.append(chars[j + 1])
                    j += 2
                    continue
                if cj == "]":
                    close = j
                    break
                if cj == "[" or cj == "\n":
                    break
                inner_chars.append(cj)
                j += 1
            if close == -1:
                if lit_start is None:
                    lit_start = here()
                lit_text.append("[")
                u16 += 1
                cp += 1
                i += 1
                continue
            inner = "".join(inner_chars)
            cls = _classify_bracket(inner, resolve_emotion)
            # 위치 진행: i..close 소비
            def _consume_range(a, b):
                nonlocal u16, cp
                for k in range(a, b + 1):
                    u16 += _utf16_len(chars[k])
                    cp += 1
            if cls["type"] == "literalize":
                flush_lit()
                start_pos = open_start
                _consume_range(i, close)
                pieces.append({"kind": "lit", "text": "[" + inner + "]",
                               "start": start_pos, "end": here(), "line": line_index})
                i = close + 1
                continue
            flush_lit()
            start_pos = open_start
            _consume_range(i, close)
            end_pos = here()
            if cls["type"] == "emotion":
                pieces.append({"kind": "emotion", "id": cls["id"], "name": cls["name"],
                               "start": start_pos, "end": end_pos, "line": line_index})
            elif cls["type"] == "pause":
                pieces.append({"kind": "pause", "ms": cls["ms"], "seconds": cls["seconds"],
                               "start": start_pos, "end": end_pos, "line": line_index})
            elif cls["type"] == "pauseInvalid":
                pieces.append({"kind": "pauseInvalid", "arg": cls["arg"], "reason": cls["reason"],
                               "start": start_pos, "end": end_pos, "line": line_index})
            else:  # unknown
                pieces.append({"kind": "unknown", "name": cls["name"],
                               "start": start_pos, "end": end_pos, "line": line_index})
            i = close + 1
            continue
        # 일반 문자
        if lit_start is None:
            lit_start = here()
        lit_text.append(c)
        u16 += _utf16_len(c)
        cp += 1
        i += 1
    flush_lit()
    return pieces


def parse_tts_script(raw, resolve_emotion=None):
    """raw ttsText → dict. 성공: {ok:True, plan:{...}}. 실패: {ok:False, errors:[dict...]}.

    plan 구조(정규화): {
      parser_version, segments:[{original_line_index, emotion_id, spoken_text,
        offset:{ui_start_utf16,ui_end_utf16,text_start_codepoint,text_end_codepoint},
        pauses:[{pause_ms, boundary_type, offset:{...}}], boundary_type}],
      summary:{...}, full_sha256 }
    """
    if resolve_emotion is None:
        resolve_emotion = default_resolve_emotion
    text = raw or ""
    pieces = _tokenize(text, resolve_emotion)
    errors = []

    segments = []
    open_seg = None
    pending_pause_ms = None
    pending_pause_sec = None
    strip_next_ws = False
    cur_emotion = None
    cur_emotion_name = None

    def new_open(line_index, start):
        nonlocal pending_pause_ms, pending_pause_sec
        o = {
            "emotion_id": cur_emotion, "emotion_name": cur_emotion_name,
            "parts": [], "start": start, "end": start, "line": line_index,
            "leading_pause_ms": pending_pause_ms, "leading_pause_sec": pending_pause_sec,
        }
        pending_pause_ms = None
        pending_pause_sec = None
        return o

    def flush_open():
        nonlocal open_seg
        if open_seg is None:
            return
        spoken = "".join(open_seg["parts"])
        if open_seg["emotion_id"] is not None and spoken == "":
            start = open_seg["start"] or (0, 0)
            errors.append(TtsGrammarError("EMPTY_EMOTION_SEGMENT",
                                          tag=open_seg["emotion_name"], ui_offset_utf16=start[0]))
            open_seg = None
            return
        if spoken == "" and open_seg["emotion_id"] is None and open_seg["leading_pause_ms"] is None:
            open_seg = None
            return
        start = open_seg["start"] or (0, 0)
        end = open_seg["end"] or start
        pauses = []
        if open_seg["leading_pause_ms"] is not None:
            pauses.append({
                "pause_ms": open_seg["leading_pause_ms"],
                "boundary_type": "explicitPause",
                "offset": {"ui_start_utf16": start[0], "ui_end_utf16": start[0],
                           "text_start_codepoint": start[1], "text_end_codepoint": start[1]},
            })
        segments.append({
            "original_line_index": open_seg["line"],
            "emotion_id": open_seg["emotion_id"],
            "spoken_text": spoken,
            "offset": {"ui_start_utf16": start[0], "ui_end_utf16": end[0],
                       "text_start_codepoint": start[1], "text_end_codepoint": end[1]},
            "pauses": pauses,
        })
        open_seg = None

    for p in pieces:
        kind = p["kind"]
        if kind == "unknown":
            errors.append(TtsGrammarError("UNKNOWN_TTS_TAG", tag=p["name"], ui_offset_utf16=p["start"][0]))
            continue
        if kind == "pauseInvalid":
            errors.append(TtsGrammarError("INVALID_PAUSE_TAG", arg=p["arg"], reason=p["reason"],
                                          ui_offset_utf16=p["start"][0]))
            continue
        if kind == "lit":
            if open_seg is None:
                open_seg = new_open(p["line"], p["start"])
            if open_seg["start"] is None:
                open_seg["start"] = p["start"]
            t = p["text"]
            if strip_next_ws:
                t = _LSTRIP_RE.sub("", t)
                strip_next_ws = False
            open_seg["parts"].append(t)
            open_seg["end"] = p["end"]
            continue
        if kind == "emotion":
            cur_emotion = p["id"]
            cur_emotion_name = p["name"]
            if open_seg is not None and open_seg["emotion_id"] is not None:
                flush_open()
                open_seg = new_open(p["line"], p["start"])
            elif open_seg is not None and open_seg["emotion_id"] is None:
                open_seg["emotion_id"] = p["id"]
                open_seg["emotion_name"] = p["name"]
            else:
                open_seg = new_open(p["line"], p["start"])
            open_seg["end"] = p["end"]
            strip_next_ws = True
            continue
        if kind == "pause":
            if open_seg is not None:
                flush_open()
            if pending_pause_ms is not None:
                errors.append(TtsGrammarError("INVALID_PAUSE_TAG", reason="adjacent_duplicate",
                                              ui_offset_utf16=p["start"][0]))
            else:
                pending_pause_ms = p["ms"]
                pending_pause_sec = p["seconds"]
            strip_next_ws = True
            continue
        if kind == "linebreak":
            flush_open()
            strip_next_ws = False
            cur_emotion = None
            cur_emotion_name = None
            continue
    flush_open()

    if errors:
        return {"ok": False, "errors": [e.to_dict() for e in errors], "error_objs": errors}

    # 경계 타입(추가계약3 우선순위, 합산 금지)
    boundary_types = []
    for idx, s in enumerate(segments):
        if idx == 0:
            bt = "internal"
        elif any(x["boundary_type"] == "explicitPause" for x in s["pauses"]):
            bt = "explicitPause"
        elif s["original_line_index"] > segments[idx - 1]["original_line_index"]:
            bt = "lineSilenceGap"
        elif s["emotion_id"] != segments[idx - 1]["emotion_id"]:
            bt = "emotionBoundaryPause"
        else:
            bt = "internal"
        boundary_types.append(bt)
        s["boundary_type"] = bt

    used_emotion_ids = []
    seen = set()
    for s in segments:
        eid = s["emotion_id"]
        if eid is not None and eid not in TTS_NON_REFERENCE_EMOTION_IDS and eid not in seen:
            seen.add(eid)
            used_emotion_ids.append(eid)

    explicit_pause_count = 0
    total_pause_ms = 0
    for s in segments:
        for b in s["pauses"]:
            if b["boundary_type"] == "explicitPause":
                explicit_pause_count += 1
                total_pause_ms += b["pause_ms"]

    full_sha256 = _compute_plan_full_sha256(segments, boundary_types)
    plan_sha8 = full_sha256[:8]

    summary = {
        "parser_version": TTS_PARSER_VERSION,
        "segment_count": len(segments),
        "chunk_count": len(segments),
        "explicit_pause_count": explicit_pause_count,
        "total_pause_ms": total_pause_ms,
        "used_emotion_ids": used_emotion_ids,
        "plan_sha8": plan_sha8,
    }
    plan = {
        "parser_version": TTS_PARSER_VERSION,
        "segments": segments,
        "summary": summary,
        "full_sha256": full_sha256,
    }
    return {"ok": True, "plan": plan}


def line_boundary_type(plan, line_a, line_b):
    """segment 경계 우선순위 조회(경계 테스트/UI용)."""
    segs = plan["segments"]
    idx_b = next((k for k, s in enumerate(segs) if s["original_line_index"] == line_b), -1)
    if idx_b <= 0:
        return None
    prev = segs[idx_b - 1]
    if prev["original_line_index"] != line_a:
        return None
    s = segs[idx_b]
    if any(x["boundary_type"] == "explicitPause" for x in s["pauses"]):
        return "explicitPause"
    if s["original_line_index"] > prev["original_line_index"]:
        return "lineSilenceGap"
    if s["emotion_id"] != prev["emotion_id"]:
        return "emotionBoundaryPause"
    return "internal"


# ── canonical 직렬화 + 해시(D-7). TS/Python 동일 알고리즘. ──
# object key 알파벳 정렬, 배열 순서 유지, 공백 없음, string JSON escape(ascii), int만, null=null.

def _json_escape(s):
    out = ['"']
    for ch in s:
        code = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif code < 0x20:
            out.append("\\u%04x" % code)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


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
    raise TypeError("canonical: 미지원 타입 %r" % type(v))


def _sha256_hex(data_bytes):
    return hashlib.sha256(data_bytes).hexdigest()


def _compute_plan_full_sha256(segments, boundary_types):
    canon_segments = []
    for i, s in enumerate(segments):
        pause_ms = 0
        for b in s["pauses"]:
            if b["boundary_type"] == "explicitPause":
                pause_ms = b["pause_ms"]
        text_bytes = s["spoken_text"].encode("utf-8")
        canon_segments.append({
            "boundary": boundary_types[i],
            "emotion_id": s["emotion_id"],
            "i": i,
            "line_index": s["original_line_index"],
            "pause_ms": pause_ms,
            "text_bytes": len(text_bytes),
            "text_sha256": _sha256_hex(text_bytes),
        })
    canon_obj = {
        "parser_version": TTS_PARSER_VERSION,
        "segment_count": len(segments),
        "segments": canon_segments,
    }
    return _sha256_hex(_canonicalize(canon_obj).encode("utf-8"))


def sha256_hex_of_string(s):
    return _sha256_hex(s.encode("utf-8"))
