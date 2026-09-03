# -*- coding: utf-8 -*-
"""공용 Script Plan — 대본을 **한 번** 읽어 만든 하나의 계획.

왜 이것이 필요한가
------------------
지금까지는 기능마다 대본을 따로 읽었다. 감정은 파서가, 분할은 splitter 가, 예상 시간은
estimator 가 각자 읽었다. 화자·환경음·공간 지시가 들어오면 이 방식은 반드시 갈라진다 —
같은 대본에 대해 서로 다른 해석이 여러 개 생기고, 화면과 생성 결과가 어긋난다.

그래서 대본을 한 번 읽어 하나의 계획으로 만들고, 소비자는 모두 그 계획만 본다.
설계 권위는 `doc/script-scene-architecture.md` 다.

  - plan 은 **서술적**이다. 무엇을 할지 적고, 어떻게 만들지는 소비자가 정한다.
  - plan 은 **결정적**이다. 같은 입력·같은 parser version 이면 같은 plan 이 나온다.
  - plan 의 모든 좌표는 **사용자가 입력한 원문 기준**이다.
  - plan 에는 대사 원문이 들어가지 않는다. 화면은 offset 으로 자기 textarea 에서 잘라 쓴다.

축을 섞지 않는다
----------------
  source_paragraphs  사용자가 Enter 로 나눈 문단
  speakers           대본에 등장한 인물(내부 stable id + 화면 표시 이름)
  utterances         파서가 만든 **한 덩어리의 말**(= v1.2.0 의 segment 와 같은 행)
  emotions           연속한 발화가 같은 감정을 유지하는 **구간**
  pauses             명시적 쉼
  chunks             실제 model call 계획 — 여기가 아니라 `input_analysis` 가 채운다

화자는 사용자의 의도이고 chunk 는 실행 계획이다. 예산이 바뀌어 chunk 가 더 갈려도 어느
말이 누구의 것인지는 바뀌지 않는다 — 그래서 화자는 발화 행에 붙고 chunk 는 발화를 가리킨다.

문단 != 발화 != 묶음이다. 한 문단 안에서 감정이 바뀌면 발화는 늘지만 문단은 그대로고, 한
발화가 예산을 넘으면 여러 묶음으로 갈린다. `chunks` 만 성격이 다르다 — 나머지는 사용자의
의도이고 chunks 는 실행 계획이라, chunk 경계가 바뀌어도 의도는 바뀌지 않아야 한다.

아직 비어 있는 축
-----------------
`prosody`·`actions`·`ambience`·`music`·`spatial` 은 아직 문법에 해당 지시가 없어서
**항상 빈 배열**이다(`speakers` 는 v1.4 에서 실제 축이 됐다). 그래도 여기에 선언해 둔다 — 화면이 "앞으로 여기에 들어온다"
고 말할 근거가 코드에 있어야 하고, 소비자가 없는 축을 스스로 지어내면 안 되기 때문이다.

TS 와의 parity
--------------
`src/shared/scriptPlan.ts` 가 같은 구조를 낸다. 같은 입력에 대해 `structure_sha256` 이
같아야 하고 `src/shared/scriptPlan.parity-hashes.json` 이 그것을 고정한다. 한쪽만 고치면
parity 테스트가 깨진다. UI 용 별도 파서를 만들지 않는다.
"""
import hashlib

import tts_grammar

PLAN_SCHEMA_VERSION = 2

# 사전 경고(비민감 enum). 문구는 renderer 가 붙인다.
# 경고는 **합성을 막지 않고 원문을 고치지도 않는다.** 알려 주는 것이 전부다.
WARN_UNCLOSED_TAG = "UNCLOSED_TAG"                       # `[기쁨` — 닫히지 않아 대괄호가 대사에 남는다
WARN_UNKNOWN_DIRECTIVE = "UNKNOWN_DIRECTIVE"             # 해석할 수 없는 표기(감정·화자·쉼 인자)
WARN_EMPTY_UTTERANCE = "EMPTY_UTTERANCE"                 # 지시는 있는데 말이 없다
WARN_CONFLICTING_DIRECTIVES = "CONFLICTING_DIRECTIVES"   # 연속한 지시가 서로 부딪친다
WARN_DIRECTIVE_ONLY_PARAGRAPH = "DIRECTIVE_ONLY_PARAGRAPH"  # 문단 전체가 지시뿐이다
WARN_INVALID_SPEAKER = "INVALID_SPEAKER"                 # `[화자]` 이름 없음·허용 문자 밖
WARN_SPEAKER_LABEL_VARIANT = "SPEAKER_LABEL_VARIANT"     # 같은 화자를 두 가지로 적었다

PLAN_WARNING_CODES = (
    WARN_UNCLOSED_TAG,
    WARN_UNKNOWN_DIRECTIVE,
    WARN_EMPTY_UTTERANCE,
    WARN_CONFLICTING_DIRECTIVES,
    WARN_DIRECTIVE_ONLY_PARAGRAPH,
    WARN_INVALID_SPEAKER,
    WARN_SPEAKER_LABEL_VARIANT,
)

# v1.2.0 문법에 지시가 없는 축. 항상 빈 배열이지만 이름은 지금 정해 둔다.
RESERVED_AXES = ("prosody", "actions", "ambience", "music", "spatial")


def _warning(code, line_index, u16_start, u16_end, cp_start, cp_end, reason=None, tag=None):
    w = {
        "code": code,
        "line_index": line_index,
        "source_start": u16_start,
        "source_end": u16_end,
        "text_start": cp_start,
        "text_end": cp_end,
        "reason": reason,
    }
    if tag is not None:
        w["tag"] = tag
    return w


def _line_rows(text):
    """정규화본의 **빈 줄이 아닌 줄** 목록. 좌표는 원문 기준.

    문단과 (파서를 못 쓸 때의) 대체 발화가 모두 이 한 벌에서 나온다 — 줄을 세는 규칙이
    두 곳에 있으면 언젠가 갈라진다.

    UTF-16 index 와 code point index 를 **따로** 센다. 두 map 은 서로 다른 좌표계로
    색인되므로(u16_map 은 UTF-16, cp_map 은 code point) 한쪽 커서로 둘 다 조회하면
    비 BMP 문자(이모지 등) 앞뒤에서 좌표가 밀린다.
    """
    src = text or ""
    norm, u16_map, cp_map = tts_grammar.normalize_line_endings(src)
    rows = []
    blank = 0
    cp_pos = 0
    u16_pos = 0
    line_index = 0
    for line in norm.split(chr(10)):
        cp_len = len(line)
        u16_len = sum(tts_grammar._utf16_len(ch) for ch in line)
        if line.strip():
            rows.append({
                "index": len(rows),
                "line_index": line_index,
                "text": line,
                "source_start": tts_grammar._map_u16(u16_map, u16_pos),
                "source_end": tts_grammar._map_u16(u16_map, u16_pos + u16_len),
                "text_start": tts_grammar._map_cp(cp_map, cp_pos),
                "text_end": tts_grammar._map_cp(cp_map, cp_pos + cp_len),
                "chars": cp_len,
                "blank_lines_before": blank,
            })
            blank = 0
        else:
            blank += 1
        cp_pos += cp_len + 1
        u16_pos += u16_len + 1
        line_index += 1
    return rows


def source_paragraphs(text):
    """**사용자가 Enter 로 만든 문단.** 화면에서 "문단" 이라고 부르는 것은 이것 하나뿐이다.

    파서가 만든 발화와 섞지 않는다 — 감정 태그나 명시적 쉼도 발화를 나누지만, 그건 사용자가
    문단을 나눈 것이 아니다. 그걸 문단 수로 세면 화면이 없는 문단을 있다고 말하게 된다.

    빈 줄은 문단이 아니지만 `blank_lines_before` 로 관계를 보존한다. 원문은 담지 않는다.
    """
    out = []
    for r in _line_rows(text):
        row = dict(r)
        row.pop("text", None)
        out.append(row)
    return out


def parse_units(text):
    """대본을 **한 번** 해석한다. 이 함수 밖에서 대본을 다시 파싱하지 않는다.

    반환 (units, parser_authority, warnings).

    units 는 내부 소비자용이라 `text`(발화 본문)를 들고 있다 — 토크나이저·분할이 그것을
    필요로 한다. plan 으로 나갈 때는 `structure_from_units` 가 본문을 떼고 좌표만 남긴다.

    파서가 실패하면(구조화 오류) **막지 않고** 원문 줄로 물러난다. 대신 실패 사유를 경고로
    남기고 `parser_authority=False` 로 그 사실을 밝힌다. 분석은 fail-open 이다 — 미리보기가
    사라지는 것보다 근사라도 보이는 것이 낫고, 차단은 생성 경로의 일이다.
    """
    source = text or ""
    warnings = []
    # 닫히지 않은 `[` 는 파서에게 오류가 아니다(리터럴로 지난다). 그래서 따로 물어본다.
    for u in tts_grammar.unclosed_tag_offsets(source):
        warnings.append(_warning(
            WARN_UNCLOSED_TAG, u["line_index"],
            u["ui_offset_utf16"], u["ui_offset_utf16"],
            u["text_offset_codepoint"], u["text_offset_codepoint"]))

    parsed = tts_grammar.parse_tts_script(source)
    if parsed.get("ok"):
        units = []
        for i, s in enumerate(parsed["plan"].get("segments") or ()):
            off = s.get("offset") or {}
            units.append({
                "index": i,
                "line_index": s.get("original_line_index"),
                "text": s.get("spoken_text") or "",
                "speaker_id": s.get("speaker_id"),
                "speaker_label": s.get("speaker_label"),
                "emotion_id": s.get("emotion_id"),
                "boundary_kind": s.get("boundary_type"),
                "source_start": int(off.get("ui_start_utf16") or 0),
                "source_end": int(off.get("ui_end_utf16") or 0),
                "text_start": int(off.get("text_start_codepoint") or 0),
                "text_end": int(off.get("text_end_codepoint") or 0),
                "pauses": list(s.get("pauses") or ()),
            })
        return units, True, warnings

    for e in parsed.get("errors") or ():
        warnings.append(_warning_from_parse_error(e))
    units = []
    for r in _line_rows(source):
        units.append({
            "index": r["index"],
            "line_index": r["line_index"],
            "text": r["text"],
            # 파서를 못 썼으면 화자를 **모른다.** 지어내지 않고 비워 둔다.
            "speaker_id": None,
            "speaker_label": None,
            "emotion_id": None,
            "boundary_kind": None,
            "source_start": r["source_start"],
            "source_end": r["source_end"],
            "text_start": r["text_start"],
            "text_end": r["text_end"],
            "pauses": [],
        })
    return units, False, warnings


def _warning_from_parse_error(err):
    """구조화 오류를 사전 경고로 옮긴다. 조용히 버리지 않는다.

    쉼 인자 오류는 사유로 갈린다 — 인접 중복은 지시 충돌이고, 형식·범위·인자 누락은
    "해석할 수 없는 표기" 다. 사유(`reason`)를 지우지 않고 그대로 실어 보낸다.
    """
    code = err.get("code")
    reason = err.get("reason")
    tag = err.get("tag")
    off = err.get("ui_offset_utf16")
    if code == "INVALID_SPEAKER_TAG":
        out = WARN_INVALID_SPEAKER
    elif code == "UNKNOWN_TTS_TAG":
        out = WARN_UNKNOWN_DIRECTIVE
    elif code == "EMPTY_EMOTION_SEGMENT":
        out = WARN_EMPTY_UTTERANCE
    elif code == "INVALID_PAUSE_TAG":
        out = (WARN_CONFLICTING_DIRECTIVES if reason == "adjacent_duplicate"
               else WARN_UNKNOWN_DIRECTIVE)
    else:
        out = WARN_UNKNOWN_DIRECTIVE
    if reason is None:
        reason = code
    return _warning(out, None, off, off, None, None, reason=reason, tag=tag)


def _emotion_spans(units):
    """연속한 발화가 **같은 감정을 유지하는 구간**. 발화마다 한 줄씩 늘어놓지 않는다.

    세기(`intensity`)는 v1.2.0 문법에 없어 항상 None 이다 — 자리만 둔다.
    """
    spans = []
    for u in units:
        eid = u.get("emotion_id")
        if eid is None:
            continue
        prev = spans[-1] if spans else None
        if (prev is not None and prev["emotion_id"] == eid
                and prev["utterance_end"] == u["index"] - 1):
            prev["utterance_end"] = u["index"]
            prev["source_end"] = u["source_end"]
            prev["text_end"] = u["text_end"]
            continue
        spans.append({
            "index": len(spans),
            "emotion_id": eid,
            "intensity": None,
            "utterance_start": u["index"],
            "utterance_end": u["index"],
            "source_start": u["source_start"],
            "source_end": u["source_end"],
            "text_start": u["text_start"],
            "text_end": u["text_end"],
        })
    return spans


def _speaker_rows(units):
    """대본에 등장한 인물. 발화마다 한 줄씩이 아니라 인물 단위다.

    `id` 는 내부 stable id(정규화), `label` 은 **처음 쓴 표기**다. 화면에는 사용자가 쓴
    이름이 보여야 하고 계획·생성·기록은 흔들리지 않는 id 를 써야 한다.

    기본 화자(화자 표기가 없거나 `[화자 기본]`)는 여기 나오지 않는다 — 인물로 등록된 것이
    아니라 "지정하지 않음" 이기 때문이다. 화면은 기본 참조를 쓴다고 말하면 된다.
    """
    rows = []
    index_of = {}
    for u in units:
        sid = u.get("speaker_id")
        if sid is None:
            continue
        if sid not in index_of:
            index_of[sid] = len(rows)
            rows.append({
                "index": len(rows),
                "speaker_id": sid,
                "label": u.get("speaker_label") or sid,
                "utterance_count": 0,
                "first_utterance_index": u["index"],
                "source_start": u["source_start"],
            })
        rows[index_of[sid]]["utterance_count"] += 1
    return rows


def _speaker_label_variants(units, speakers):
    """같은 인물을 두 가지 표기로 적었다 — 알려만 준다(합성은 된다).

    `[speaker Minsu]` 와 `[speaker minsu]` 는 같은 id 로 모이므로 생성에는 문제가 없다.
    다만 사용자는 두 사람으로 적었다고 생각할 수 있어 그 사실을 말해 준다.
    """
    first = {r["speaker_id"]: r["label"] for r in speakers}
    seen = set()
    out = []
    for u in units:
        sid = u.get("speaker_id")
        label = u.get("speaker_label")
        if sid is None or label is None:
            continue
        if label == first.get(sid) or (sid, label) in seen:
            continue
        seen.add((sid, label))
        out.append(_warning(WARN_SPEAKER_LABEL_VARIANT, u.get("line_index"),
                            u["source_start"], u["source_end"],
                            u["text_start"], u["text_end"], reason="label_differs"))
    return out


def _pause_rows(units):
    rows = []
    for u in units:
        for b in u.get("pauses") or ():
            if b.get("boundary_type") != "explicitPause":
                continue
            off = b.get("offset") or {}
            rows.append({
                "index": len(rows),
                "utterance_index": u["index"],
                "pause_ms": int(b.get("pause_ms") or 0),
                "boundary_type": b.get("boundary_type"),
                "source_start": int(off.get("ui_start_utf16") or 0),
                "source_end": int(off.get("ui_end_utf16") or 0),
                "text_start": int(off.get("text_start_codepoint") or 0),
                "text_end": int(off.get("text_end_codepoint") or 0),
            })
    return rows


def _directive_only_paragraphs(paragraphs, utterances, line_rows=None):
    """문단 전체가 지시뿐이다 — 말이 하나도 없다.

    `[쉼 1.0]` 만 있는 문단이 그렇다. 파서는 이것을 오류로 보지 않으므로(쉼은 유효한
    지시다) 알려 주지 않으면 사용자는 그 문단이 소리를 내지 않는 것을 모른다.

    쉼만 있는 줄은 발화 자체가 만들어지지 않고 쉼이 다음 발화에 붙는다. 그래서 "발화가
    있는데 비었다" 가 아니라 **문단에 말이 하나도 없다** 로 판정한다. 파서를 못 써서 원문
    줄로 물러난 경우에는 모든 줄이 발화가 되므로 이 경고가 헛되게 울리지 않는다.
    """
    spoken = set()
    for u in utterances:
        pi = u.get("source_paragraph_index")
        if pi is not None and u["chars"] > 0:
            spoken.add(pi)
    text_of = {r["index"]: r.get("text", "") for r in (line_rows or ())}
    out = []
    for p in paragraphs:
        if p["index"] in spoken:
            continue
        # 화자 표기만 있는 줄은 대화 대본의 형식이다 — 빠뜨린 말이 아니다.
        # 판정은 문법이 소유한다(여기서 브래킷 규칙을 다시 쓰지 않는다).
        if tts_grammar.is_speaker_only_directive(text_of.get(p["index"])):
            continue
        out.append(_warning(
            WARN_DIRECTIVE_ONLY_PARAGRAPH, p["line_index"],
            p["source_start"], p["source_end"], p["text_start"], p["text_end"]))
    return out


def _warning_sort_key(w):
    return (w["source_start"] if w["source_start"] is not None else -1, w["code"])


def structure_from_units(source, units, parser_authority, warnings, paragraphs=None):
    """한 번의 해석 결과를 plan 구조로 만든다(본문은 떼고 좌표만 남긴다)."""
    src = source or ""
    paras = source_paragraphs(src) if paragraphs is None else paragraphs
    line_to_para = {p["line_index"]: p["index"] for p in paras
                    if p["line_index"] is not None}

    utterances = []
    for u in units:
        utterances.append({
            "index": u["index"],
            "source_paragraph_index": line_to_para.get(u.get("line_index")),
            "line_index": u.get("line_index"),
            "speaker_id": u.get("speaker_id"),
            "speaker_label": u.get("speaker_label"),
            "emotion_id": u.get("emotion_id"),
            "boundary_kind": u.get("boundary_kind"),
            "source_start": u["source_start"],
            "source_end": u["source_end"],
            "text_start": u["text_start"],
            "text_end": u["text_end"],
            "chars": len(u.get("text") or ""),
            # 파서가 준 좌표는 정확하다. 원문 줄로 물러난 경우만 근사다.
            "source_offsets_exact": bool(parser_authority),
        })

    speakers = _speaker_rows(utterances)
    all_warnings = (list(warnings)
                    + _directive_only_paragraphs(paras, utterances, _line_rows(src))
                    + _speaker_label_variants(utterances, speakers))
    all_warnings.sort(key=_warning_sort_key)

    structure = {
        "plan_schema_version": PLAN_SCHEMA_VERSION,
        "parser_version": tts_grammar.TTS_PARSER_VERSION,
        # 원문 SHA 는 사용자가 입력한 그대로, 정규화 SHA 는 파서가 실제로 본 것.
        # 줄 끝 표기만 다른 두 입력은 normalized 가 같고 plan 도 같아야 한다.
        "source_sha256": hashlib.sha256(src.encode("utf-8")).hexdigest(),
        "normalized_sha256": hashlib.sha256(
            tts_grammar.normalize_line_endings(src)[0].encode("utf-8")).hexdigest(),
        "parser_authority": bool(parser_authority),
        "source_paragraphs": paras,
        "speakers": speakers,
        "utterances": utterances,
        "emotions": _emotion_spans(utterances),
        "pauses": _pause_rows(units),
        "warnings": all_warnings,
    }
    for axis in RESERVED_AXES:
        structure.setdefault(axis, [])
    structure["structure_sha256"] = structure_sha256(structure)
    return structure


def build_structure(text):
    """대본 -> plan 구조. 생성 묶음(`chunks`)은 tokenizer 권위가 필요해 여기 없다.

    `input_analysis.analyze()` 가 같은 해석 결과에 `chunks` 를 얹어 완성한다.
    """
    src = text or ""
    units, authority, warnings = parse_units(src)
    return structure_from_units(src, units, authority, warnings)


# 구조 해시 입력. 좌표·개수·코드만 들어간다 — 대사 원문은 넣지 않는다(SHA 로 이미 신원이 있다).
_HASH_UTTERANCE_KEYS = ("index", "source_paragraph_index", "line_index", "speaker_id",
                        "emotion_id", "boundary_kind", "source_start", "source_end",
                        "text_start", "text_end", "chars", "source_offsets_exact")
_HASH_SPEAKER_KEYS = ("index", "speaker_id", "label", "utterance_count",
                      "first_utterance_index", "source_start")
_HASH_PARAGRAPH_KEYS = ("index", "line_index", "source_start", "source_end",
                        "text_start", "text_end", "chars", "blank_lines_before")
_HASH_EMOTION_KEYS = ("index", "emotion_id", "intensity", "utterance_start", "utterance_end",
                      "source_start", "source_end", "text_start", "text_end")
_HASH_PAUSE_KEYS = ("index", "utterance_index", "pause_ms", "boundary_type",
                    "source_start", "source_end", "text_start", "text_end")
_HASH_WARNING_KEYS = ("code", "line_index", "source_start", "source_end",
                      "text_start", "text_end", "reason", "tag")


def _pick(rows, keys):
    return [{k: r.get(k) for k in keys} for r in rows]


def structure_sha256(structure):
    """TS `scriptPlanStructureSha256` 과 **같은 값**이어야 한다.

    한쪽만 고치면 parity 테스트가 깨진다. 해시 입력에 대사 원문을 넣지 않는다 —
    원문 신원은 `source_sha256` 이 이미 들고 있다.
    """
    canon = {
        "plan_schema_version": structure["plan_schema_version"],
        "parser_version": structure["parser_version"],
        "source_sha256": structure["source_sha256"],
        "normalized_sha256": structure["normalized_sha256"],
        "parser_authority": bool(structure["parser_authority"]),
        "source_paragraphs": _pick(structure["source_paragraphs"], _HASH_PARAGRAPH_KEYS),
        "speakers": _pick(structure["speakers"], _HASH_SPEAKER_KEYS),
        "utterances": _pick(structure["utterances"], _HASH_UTTERANCE_KEYS),
        "emotions": _pick(structure["emotions"], _HASH_EMOTION_KEYS),
        "pauses": _pick(structure["pauses"], _HASH_PAUSE_KEYS),
        "warnings": _pick(structure["warnings"], _HASH_WARNING_KEYS),
        "reserved_axes": list(RESERVED_AXES),
    }
    return hashlib.sha256(
        tts_grammar.canonical_json(canon).encode("utf-8")).hexdigest()
