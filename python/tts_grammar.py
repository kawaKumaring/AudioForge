"""TTS 감정/쉼 문법 파서 (parser_version=2) — 순수 stdlib, 합성 권위.

src/shared/ttsGrammar.ts 와 동형(isomorphic): 같은 raw ttsText 입력에 대해
동일한 정규화 segments + 동일한 canonical full SHA256 을 산출한다(D-2 parity 안전장치).

⚠️ 대사 전문을 로그/오류 payload에 넣지 않는다(code·tag·arg·reason·offset 필드만).
⚠️ numpy 등 무거운 의존성 없음 — 텍스트 파서는 순수. (합성 파이프라인 배선은 Agent B/통합 담당.)
"""
import hashlib
import re
import unicodedata  # noqa: F401 (미사용이지만 code-point 의미 문서화용 자리)

TTS_PARSER_VERSION = 3

# 의미 기반 plan hash 입력의 스키마 버전. **파서 계약 버전과 다른 축이다.**
#
# 왜 분리하나: parser_version 을 hash 입력에 그대로 넣으면 문법을 넓힐 때마다 기존 대본의
# hash 가 달라진다. 그 hash 는 renderer↔Python parity 기준이라, 의미가 하나도 안 바뀐 대본이
# PARSER_PARITY_MISMATCH 로 막히게 된다. 그래서 "무엇을 해석할 수 있는가"(파서 계약)와
# "이 대본이 무엇을 뜻하는가"(의미 hash)를 따로 센다.
#
# 이 값은 **hash 입력의 구성이 바뀔 때만** 올린다. v1.4 의 화자 축은 화자 표기가 실제로
# 있는 대본에서만 입력에 더해지므로(아래 _compute_plan_full_sha256) 기존 대본의 값은 그대로다.
# 버전을 숨기는 것이 아니다 — parser_version=3 은 plan·config·metadata·run bundle 에 그대로 나간다.
SEMANTIC_PLAN_HASH_VERSION = 2

TTS_GRAMMAR_ERROR_CODES = (
    "UNKNOWN_TTS_TAG",
    "INVALID_PAUSE_TAG",
    "EMPTY_EMOTION_SEGMENT",
    "PARSER_PARITY_MISMATCH",
    "INVALID_TTS_CONFIG",
    "INVALID_SPEAKER_TAG",    # [화자] 이름 없음 / 허용 문자 밖 / 형식 위반 → 합성 차단
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
# 화자 표기의 예약 접두어. 이 둘만 화자로 읽는다 — 다른 대괄호 표현을 화자로 오인하지 않는다.
TTS_SPEAKER_NAMES = {"화자", "speaker"}
# 기본 화자로 돌아가는 이름. 앞의 화자 지정을 해제하고 기본 참조로 되돌린다.
TTS_DEFAULT_SPEAKER_NAMES = {"기본", "default"}
# 화자 식별자에 허용하는 문자: 한국어 음절·영문·숫자·밑줄·붙임표.
_SPEAKER_ID_RE = re.compile("^[0-9A-Za-z_\\-\u3131-\u318E\uAC00-\uD7A3]+$")
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


def normalize_speaker_id(name):
    """표시 이름 → **내부 stable id**.

    화면에 보이는 것은 사용자가 쓴 그대로(`label`)이고, 계획·생성·기록이 쓰는 것은 이
    정규화된 id 다. 둘을 구분해 두는 이유는 `[speaker Minsu]` 와 `[speaker minsu]` 가
    같은 사람이어야 하고, 그러면서도 화면에는 사용자가 쓴 표기가 보여야 하기 때문이다.

    NFC 로 모으고 소문자로 내린다(한글은 소문자 변환이 무연산이다).
    """
    import unicodedata
    return unicodedata.normalize("NFC", (name or "").strip()).lower()


def default_resolve_emotion(name):
    return TTS_EMOTION_LABEL_TO_ID.get(name)


def _utf16_len(ch):
    """code point 한 개의 UTF-16 code unit 수(BMP=1, astral=2)."""
    return 2 if ord(ch) > 0xFFFF else 1


# ── 줄 끝 정규화(공용 parser 입력 경계) ──────────────────────────────────────
# Windows 에서 붙여넣은 CRLF 의 CR 이 spoken_text 에 남으면 tokenizer 결과·chunk 계획·
# 실제 발화·시간 예측이 LF 입력과 갈라진다(실측). 그래서 **파서 입구에서** 정규화한다.
# 사용자가 입력한 원문은 건드리지 않는다 — 정규화는 파서 내부에서만 일어나고, 밖으로 나가는
# offset 은 아래 map 으로 **원문 좌표**로 되돌린다.

def normalize_line_endings(raw):
    """CRLF 와 단독 CR 을 LF 로. 반환 (normalized, u16_map, cp_map).

    u16_map[n] = 정규화본의 UTF-16 index n 에 대응하는 **원문** UTF-16 index.
    cp_map[n]  = 정규화본의 code point index n 에 대응하는 원문 code point index.
    두 map 모두 끝 경계를 담아 길이가 하나 더 길다(슬라이스 끝 좌표를 되돌리기 위해서다).
    """
    src = raw or ""
    out, u16_map, cp_map = [], [], []
    su16, i, n = 0, 0, len(src)
    while i < n:
        ch = src[i]
        if ch == "\r":
            cp_map.append(i)
            u16_map.append(su16)
            out.append("\n")
            if i + 1 < n and src[i + 1] == "\n":
                su16 += 2            # CRLF 두 글자를 한 LF 로
                i += 2
            else:
                su16 += 1            # 단독 CR
                i += 1
            continue
        cp_map.append(i)
        w = _utf16_len(ch)
        for k in range(w):
            u16_map.append(su16 + k)
        out.append(ch)
        su16 += w
        i += 1
    cp_map.append(n)
    u16_map.append(su16)
    return "".join(out), u16_map, cp_map


def _map_u16(u16_map, value):
    if value is None:
        return None
    v = int(value)
    if v < 0:
        return v
    return u16_map[v] if v < len(u16_map) else u16_map[-1]


def _map_cp(cp_map, value):
    if value is None:
        return None
    v = int(value)
    if v < 0:
        return v
    return cp_map[v] if v < len(cp_map) else cp_map[-1]


def _remap_offset(off, u16_map, cp_map):
    if not isinstance(off, dict):
        return
    for k in ("ui_start_utf16", "ui_end_utf16"):
        if k in off:
            off[k] = _map_u16(u16_map, off[k])
    for k in ("text_start_codepoint", "text_end_codepoint"):
        if k in off:
            off[k] = _map_cp(cp_map, off[k])


def _remap_plan_offsets(segments, errors, u16_map, cp_map):
    """정규화 좌표로 만들어진 offset 을 전부 원문 좌표로 되돌린다."""
    for seg in segments:
        _remap_offset(seg.get("offset"), u16_map, cp_map)
        for b in seg.get("pauses") or ():
            _remap_offset(b.get("offset"), u16_map, cp_map)
    for e in errors or ():
        cur = getattr(e, "ui_offset_utf16", None)
        if cur is not None:
            e.ui_offset_utf16 = _map_u16(u16_map, cur)

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
        if name in TTS_SPEAKER_NAMES:
            return {"type": "speakerInvalid", "arg": "", "reason": "missing_name"}
        return {"type": "unknown", "name": name}
    if parts[0] in TTS_SPEAKER_NAMES:
        # 이름이 없는 `[화자]` 는 조용히 지나가지 않는다 — 무엇을 뜻하는지 알 수 없다.
        if len(parts) == 1:
            return {"type": "speakerInvalid", "arg": "", "reason": "missing_name"}
        if len(parts) != 2:
            return {"type": "speakerInvalid", "arg": " ".join(parts[1:]), "reason": "format"}
        raw = parts[1]
        if raw in TTS_DEFAULT_SPEAKER_NAMES:
            return {"type": "speaker", "id": None, "name": raw}
        if not _SPEAKER_ID_RE.match(raw):
            return {"type": "speakerInvalid", "arg": raw, "reason": "charset"}
        return {"type": "speaker", "id": normalize_speaker_id(raw), "name": raw}
    if parts[0] in TTS_PAUSE_NAMES:
        if len(parts) != 2:
            return {"type": "pauseInvalid", "arg": " ".join(parts[1:]), "reason": "format"}
        return _validate_pause_arg(parts[1])
    # 첫 토큰이 쉼/pause 아닌데 내부 공백 존재 → control-tag 아님 → 리터럴.
    return {"type": "literalize"}


def _tokenize(raw, resolve_emotion, unclosed_out=None):
    """원문을 pieces 리스트로. 각 piece dict: kind + 전역 offset(u16/cp) + lineIndex.

    `unclosed_out` 을 주면 닫히지 않은 `[` 의 위치를 거기에 담는다. 파서는 그 `[` 를
    리터럴로 다루므로 오류가 아니다 — 다만 사용자가 태그를 의도했을 수 있어 알려야 하고,
    브래킷 규칙은 여기 한 곳에만 있어야 하므로 판정도 여기서 한다.
    """
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
                if unclosed_out is not None:
                    unclosed_out.append({"ui_offset_utf16": u16, "text_offset_codepoint": cp,
                                         "line_index": line_index})
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
            elif cls["type"] == "speaker":
                pieces.append({"kind": "speaker", "id": cls["id"], "name": cls["name"],
                               "start": start_pos, "end": end_pos, "line": line_index})
            elif cls["type"] == "speakerInvalid":
                pieces.append({"kind": "speakerInvalid", "arg": cls["arg"],
                               "reason": cls["reason"],
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


def unclosed_tag_offsets(raw, resolve_emotion=None):
    """닫히지 않은 `[` 의 **원문 좌표** 목록.

    파서는 이것을 리터럴로 삼아 계속 진행한다(오류가 아니다). 그래서 `[기쁨` 처럼 쓴 줄은
    조용히 대사 안에 대괄호가 남는다. 사전 경고가 그 사실을 말해야 하므로 위치를 따로 낸다.
    합성을 막지도, 원문을 고치지도 않는다.
    """
    if resolve_emotion is None:
        resolve_emotion = default_resolve_emotion
    source = raw or ""
    text, u16_map, cp_map = normalize_line_endings(source)
    found = []
    _tokenize(text, resolve_emotion, unclosed_out=found)
    if text != source:
        for o in found:
            o["ui_offset_utf16"] = _map_u16(u16_map, o["ui_offset_utf16"])
            o["text_offset_codepoint"] = _map_cp(cp_map, o["text_offset_codepoint"])
    return found


def parse_tts_script(raw, resolve_emotion=None):
    """raw ttsText → dict. 성공: {ok:True, plan:{...}}. 실패: {ok:False, errors:[dict...]}.

    plan 구조(정규화): {
      parser_version, segments:[{original_line_index, speaker_id, speaker_label, emotion_id,
        spoken_text,
        offset:{ui_start_utf16,ui_end_utf16,text_start_codepoint,text_end_codepoint},
        pauses:[{pause_ms, boundary_type, offset:{...}}], boundary_type}],
      summary:{...}, full_sha256 }

    화자 지속 규칙(v1.4 확정)
    ------------------------
    화자는 **다음 화자 표기가 나올 때까지 유지**된다. 줄바꿈·빈 줄·문단 경계·쉼 지시는
    화자를 초기화하지 않는다. 대본 관습이 "바뀔 때만 적는다" 이고, 대화문에서 줄마다 화자를
    다시 쓰게 하면 쓰기 어려워진다.

    감정은 기존 계약대로 **줄 단위로 초기화**된다. 두 규칙을 섞지 않는다 — 하나는 인물이
    누구인가이고 다른 하나는 그 줄을 어떻게 말하는가다.

    화자 표기는 **항상 앞의 말을 닫는다**(감정 태그와 다르다). 감정 태그는 앞에 감정이 없던
    구간에 소급 적용되지만, 화자는 그럴 수 없다 — 태그 앞의 말은 그 사람이 한 말이 아니다.

    `[화자 기본]`/`[speaker default]` 는 화자 지정을 해제해 기본 참조로 되돌린다.
    잘못된 화자 표기(`[화자]`, 허용 문자 밖)는 구조화 오류이며, **이전 화자 상태를 바꾸지
    않는다** — 해석하지 못한 표기가 인물을 조용히 갈아치우면 안 된다.
    """
    if resolve_emotion is None:
        resolve_emotion = default_resolve_emotion
    source = raw or ""
    # 파서 입력 경계에서만 정규화한다. 원문 문자열 자체는 어디서도 바꾸지 않는다.
    text, _u16_map, _cp_map = normalize_line_endings(source)
    _needs_remap = text != source
    pieces = _tokenize(text, resolve_emotion)
    errors = []

    segments = []
    open_seg = None
    pending_pause_ms = None
    pending_pause_sec = None
    strip_next_ws = False
    cur_emotion = None
    cur_emotion_name = None
    # 화자는 줄바꿈에서 초기화되지 않는다(감정과 다른 축이다).
    cur_speaker = None
    cur_speaker_label = None

    def new_open(line_index, start):
        nonlocal pending_pause_ms, pending_pause_sec
        o = {
            "emotion_id": cur_emotion, "emotion_name": cur_emotion_name,
            "speaker_id": cur_speaker, "speaker_label": cur_speaker_label,
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
            # 내부 stable id 와 화면 표시 이름을 나눠 싣는다(id 는 정규화, label 은 쓴 그대로).
            "speaker_id": open_seg["speaker_id"],
            "speaker_label": open_seg["speaker_label"],
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
        if kind == "speakerInvalid":
            # 해석하지 못한 화자 표기는 **이전 화자를 바꾸지 않는다.** 오류로만 남는다.
            errors.append(TtsGrammarError("INVALID_SPEAKER_TAG", arg=p["arg"],
                                          reason=p["reason"],
                                          ui_offset_utf16=p["start"][0]))
            continue
        if kind == "speaker":
            # 화자가 바뀌면 지금까지 모은 말은 이전 화자의 것이므로 먼저 닫는다.
            flush_open()
            cur_speaker = p["id"]
            cur_speaker_label = None if p["id"] is None else p["name"]
            strip_next_ws = True
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
            # cur_speaker 는 그대로 둔다 — 화자는 다음 화자 표기까지 유지된다.
            continue
    flush_open()

    if errors:
        # 성공 경로와 같은 계약: 밖으로 나가는 좌표는 언제나 원문 기준이다.
        # (전에는 실패 경로만 정규화 좌표로 나가 CRLF 입력에서 위치가 어긋났다.)
        if _needs_remap:
            _remap_plan_offsets((), errors, _u16_map, _cp_map)
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

    used_speaker_ids = []
    _seen_spk = set()
    for seg in segments:
        sid = seg["speaker_id"]
        if sid is not None and sid not in _seen_spk:
            _seen_spk.add(sid)
            used_speaker_ids.append(sid)

    explicit_pause_count = 0
    total_pause_ms = 0
    for s in segments:
        for b in s["pauses"]:
            if b["boundary_type"] == "explicitPause":
                explicit_pause_count += 1
                total_pause_ms += b["pause_ms"]

    if _needs_remap:
        # spoken_text·plan sha 는 정규화본 기준(LF 와 CRLF 가 같은 계획을 만든다).
        # 밖으로 나가는 좌표만 원문으로 되돌린다.
        _remap_plan_offsets(segments, errors, _u16_map, _cp_map)
    full_sha256 = _compute_plan_full_sha256(segments, boundary_types)
    plan_sha8 = full_sha256[:8]

    summary = {
        "parser_version": TTS_PARSER_VERSION,
        "segment_count": len(segments),
        "chunk_count": len(segments),
        "explicit_pause_count": explicit_pause_count,
        "total_pause_ms": total_pause_ms,
        "used_emotion_ids": used_emotion_ids,
        # 화자 표기를 쓰지 않은 대본에서는 빈 목록이다(기본 화자 하나).
        "used_speaker_ids": used_speaker_ids,
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


def canonical_json(value):
    """구조 해시용 결정적 직렬화. TS `canonicalJson` 과 같은 문자열이어야 한다.

    규칙: object key 알파벳 정렬, 배열 순서 유지, 공백 없음, 정수만(float 금지).
    plan hash 를 이 파일 밖(예: script_plan)에서 계산할 때 알고리즘을 다시 쓰지 않게
    공개한다 — 직렬화가 두 곳에 있으면 언젠가 갈라진다.
    """
    return _canonicalize(value)


def _sha256_hex(data_bytes):
    return hashlib.sha256(data_bytes).hexdigest()


def _compute_plan_full_sha256(segments, boundary_types):
    """대본이 **무엇을 뜻하는가**의 지문. 파서 계약 버전은 여기 들어가지 않는다.

    두 가지를 지킨다.

    1. `parser_version` 대신 `SEMANTIC_PLAN_HASH_VERSION` 을 쓴다. 문법을 넓혀 파서 버전이
       올라가도, 의미가 같은 대본의 지문은 그대로여야 한다 — 이 값이 곧 renderer↔Python
       parity 기준이라 흔들리면 의미가 안 바뀐 대본이 PARSER_PARITY_MISMATCH 로 막힌다.
       (버전을 숨기는 것이 아니다. parser_version=3 은 plan·config·metadata 로 그대로 나간다.)
    2. 화자는 **화자 표기가 실제로 있는 대본에서만** 입력에 들어간다. 그래서 v1.3.0 대본의
       지문은 한 바이트도 달라지지 않는다. 화자가 하나라도 있으면 모든 segment 에 키가
       붙는다(같은 대본에서 키가 들쭉날쭉하지 않게).
    """
    has_speaker = any(s.get("speaker_id") is not None for s in segments)
    canon_segments = []
    for i, s in enumerate(segments):
        pause_ms = 0
        for b in s["pauses"]:
            if b["boundary_type"] == "explicitPause":
                pause_ms = b["pause_ms"]
        text_bytes = s["spoken_text"].encode("utf-8")
        row = {
            "boundary": boundary_types[i],
            "emotion_id": s["emotion_id"],
            "i": i,
            "line_index": s["original_line_index"],
            "pause_ms": pause_ms,
            "text_bytes": len(text_bytes),
            "text_sha256": _sha256_hex(text_bytes),
        }
        if has_speaker:
            # 표시 이름(label)은 넣지 않는다 — 같은 사람을 다르게 적었을 뿐이면 의미는 같다.
            row["speaker_id"] = s.get("speaker_id")
        canon_segments.append(row)
    canon_obj = {
        "parser_version": SEMANTIC_PLAN_HASH_VERSION,
        "segment_count": len(segments),
        "segments": canon_segments,
    }
    return _sha256_hex(_canonicalize(canon_obj).encode("utf-8"))


def sha256_hex_of_string(s):
    return _sha256_hex(s.encode("utf-8"))
