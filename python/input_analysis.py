# -*- coding: utf-8 -*-
"""입력 분석과 생성 시간 추정 — production planner 와 **같은 권위**를 쓴다.

왜 여기 있나
------------
UI 가 보여 주는 "몇 묶음, 얼마나 걸림" 이 실제 생성과 어긋나면 안내가 아니라 오정보다.
그래서 문단·문장 분리와 분할 계획을 TS 에 다시 구현하지 않고 production 경로를 그대로 부른다.

  문단·segment  tts_grammar.parse_tts_script  (감정 태그·명시적 쉼을 뗀 spoken_text 와 원문 offset)
  분할          text_segmenter.split_for_generation + chunk_budget.max_production_tokens
  토큰          호출자가 주입하는 production tokenizer (qwen_bridge._prod_tokens 와 동일 경로)
  예산          chunk_budget.budget_for  (generation tier)

세 축을 섞지 않는다
-------------------
  source_paragraphs  사용자가 Enter 로 만든 문단. 화면에서 "문단" 은 이것 하나뿐이다.
  segments           parser 가 만든 **대사 구간**. 감정 태그·명시적 쉼도 구간을 만든다.
  chunks             실제 model call 계획. 구간이 예산을 넘을 때만 더 쪼개진다.

한 줄 안에서 감정이 바뀌면 구간은 늘지만 문단은 그대로다. 그걸 문단 수로 세면 화면이
없는 문단을 있다고 말하게 된다. chunk 행은 두 축의 index 를 모두 들고 있다.

생성에 들어가는 것은 `spoken_text` 라서 `[기쁨]` 같은 태그가 붙은 줄은 원문 길이와 토큰
수가 다르다(실측). 그 차이를 무시하면 planned calls 가 실제 호출 수와 어긋난다.

줄 끝 표기는 파서 입구에서 정규화된다(CRLF·단독 CR → LF). 따라서 LF 와 CRLF 는 같은 계획을
만들고, `source_sha256` 은 원문 기준, `normalized_sha256` 은 파서가 실제로 본 것 기준이다.
offset 은 언제나 **사용자가 입력한 원문 좌표**다.

두 가지 시간을 구분한다
-----------------------
`estimated_audio_seconds` 는 **결과 음성 길이**, `estimated_wall_seconds` 는 **기다리는 시간**이다.
작업 시간에는 대사 길이와 무관한 모델 준비 비용이 한 번 들어간다. 그래서 문단 줄은
`estimated_wall_seconds_marginal`(그 문단이 더 얹는 시간)만 쓴다 — 문단마다 준비 비용을
다시 세면 문단 합이 전체보다 커진다.
참조 재발화(legacy controlled-prefix)는 생성은 하지만 vendor 가 잘라내므로 **작업 시간에만**
들어가고 음성 길이에는 들어가지 않는다.

시간 모델
---------
`_local/artifacts/drafts/timing-model/model.md` 의 실측에서 왔다. 동일 250자를 호출수만 바꿔
생성한 통제 실험 6건(정상 종료·high_quality_icl)에서 유도했고, 미종료 표본은 학습에서 뺐다.
프레임당 비용 C 는 자유도가 남아 구간으로만 확정된다 — 단일값으로 쓰지 않는다.

  elapsed = job_start(C) + per_call(C) * calls + C * total_frames,  C in [0.18, 0.22]
  job_start(C) = 130.61 - 333*C,  per_call(C) = max(0, 18.25 - 83*C)

통제 표본이 없는 모드(safe_xvector, auto)는 숫자를 만들지 않고 insufficient_data 로 답한다.
"""
import hashlib

import chunk_budget
import text_segmenter as ts

SCHEMA_VERSION = 4

# 시간 모델 계수(model.md). 회귀 잔차 sd 7.49 s.
_C_RANGE = (0.18, 0.22)
_FIT_A, _FIT_K, _FIT_TARGET = 130.61, 18.25, 333.0
_RESID_SD = 7.49
_Z = 2.0
FPS = 12.5

# 실측이 덮는 총 생성 frame 구간. 밖은 외삽이다.
MEASURED_FRAME_RANGE = (396, 1342)

CONFIDENCE_MEASURED = "measured"
CONFIDENCE_EXTRAPOLATED = "extrapolated"
CONFIDENCE_INSUFFICIENT = "insufficient_data"

# 통제 표본이 있는 모드. 나머지는 숫자를 내지 않는다.
_MODES_WITH_SAMPLES = ("high_quality_icl",)

# 왜 이 chunk 가 여기서 끝났는가(비민감 enum). UI 문구는 renderer 가 붙인다.
SPLIT_USER_PARAGRAPH = "user_paragraph"     # 사용자가 Enter 로 나눈 경계
SPLIT_SENTENCE_END = "sentence_end"         # 마침표·느낌표·물음표
SPLIT_CLAUSE = "clause"                     # 쉼표·절 — 긴 단일 문장에서만
SPLIT_FORCED_CHARACTER = "forced_character"  # 문장부호가 없어 문자 단위로 잘랐다
SPLIT_END_OF_INPUT = "end_of_input"

WARN_SOURCE_OFFSETS_APPROXIMATE = "SOURCE_OFFSETS_APPROXIMATE"
WARN_SEGMENT_TOO_LONG = "SEGMENT_TOO_LONG"


class AnalysisError(Exception):
    def __init__(self, message, code="INPUT_ANALYSIS_FAILED"):
        super().__init__(message)
        self.code = code


def _split_sentences(text):
    return [p for p in ts._cut_after(text, ts.SENTENCE_ENDERS, eat_closers=True) if p.strip()]


def _segments_of(text):
    """production parser 가 보는 segment. 실패하면 원문 줄로 물러나되 그 사실을 남긴다."""
    try:
        import tts_grammar
        plan = tts_grammar.parse_tts_script(text or "")["plan"]
        out = []
        for i, s in enumerate(plan.get("segments") or ()):
            off = s.get("offset") or {}
            out.append({
                "index": i,
                "line_index": s.get("original_line_index"),
                "text": s.get("spoken_text") or "",
                "emotion_id": s.get("emotion_id"),
                "boundary_type": s.get("boundary_type"),
                "source_start": int(off.get("ui_start_utf16") or 0),
                "source_end": int(off.get("ui_end_utf16") or 0),
            })
        return out, True
    except Exception:
        return _lines_fallback(text), False


def _lines_fallback(text):
    """parser 를 못 쓸 때의 최소 경로 — 빈 줄이 아닌 원문 줄. 근사임을 호출부가 표시한다."""
    out, char = [], 0
    for raw in (text or "").split(chr(10)):
        if raw.strip():
            out.append({"index": len(out), "line_index": len(out), "text": raw,
                        "emotion_id": None, "boundary_type": None,
                        "source_start": char, "source_end": char + len(raw)})
        char += len(raw) + 1
    return out


def source_paragraphs_of(text):
    """**사용자가 Enter 로 만든 문단.** 화면에서 "문단" 이라고 부르는 것은 이것 하나뿐이다.

    parser segment 와 섞지 않는다 — 감정 태그나 명시적 쉼도 segment 를 만들지만, 그건 사용자가
    문단을 나눈 것이 아니다. 그걸 문단 수로 세면 화면이 없는 문단을 있다고 말하게 된다.

    좌표는 **원문 기준**이다. CRLF·단독 CR 도 줄 끝으로 보되(파서와 같은 규칙) 원문 offset 을
    그대로 돌려준다. 빈 줄은 문단이 아니지만 `blank_lines_before` 로 관계를 보존한다.
    """
    import tts_grammar
    src = text or ""
    norm, u16_map, _cp = tts_grammar.normalize_line_endings(src)
    out, blank = [], 0
    pos = 0
    for line in norm.split(chr(10)):
        if line.strip():
            out.append({
                "index": len(out),
                "line_index": None,          # 아래에서 정규화 줄 번호를 채운다
                "source_start": u16_map[pos] if pos < len(u16_map) else u16_map[-1],
                "source_end": (u16_map[pos + len(line)] if pos + len(line) < len(u16_map)
                               else u16_map[-1]),
                "chars": len(line),
                "blank_lines_before": blank,
            })
            blank = 0
        else:
            blank += 1
        pos += len(line) + 1
    # 정규화본의 줄 번호 = parser 의 original_line_index 와 같은 좌표계다.
    li, k = 0, 0
    for line in norm.split(chr(10)):
        if line.strip():
            out[k]["line_index"] = li
            k += 1
        li += 1
    return out


def paragraphs_of(text):
    """production parser 가 만든 **대사 구간**(segment). 문단과 다른 축이다.

    이름을 유지하는 이유는 planner parity 테스트가 이 경로로 실제 분할을 재현하기 때문이다.
    화면 문구는 `source_paragraphs_of` 쪽을 "문단" 으로 쓴다.
    """
    segs, _exact = _segments_of(text)
    return segs


def _split_reason(chunk_text, is_last_of_segment, boundary_type, is_last_overall):
    """이 chunk 가 **왜** 여기서 끝났는가. 실제로 쓰인 경계만 말한다."""
    if is_last_of_segment:
        if is_last_overall:
            return SPLIT_END_OF_INPUT
        return SPLIT_USER_PARAGRAPH
    tail = (chunk_text or "").rstrip("".join(ts.CLOSERS))
    if tail and tail[-1] in ts.SENTENCE_ENDERS:
        return SPLIT_SENTENCE_END
    if tail and tail[-1] in ts.CLAUSE_DELIMS:
        return SPLIT_CLAUSE
    return SPLIT_FORCED_CHARACTER


def _chunk_spans(source, seg, chunks):
    """chunk 를 **원문 좌표**로 되돌린다.

    spoken_text 는 감정 태그를 뗀 결과라 원문과 길이가 다르다. 원문 구간 안에서 spoken_text 를
    찾아 기준점을 잡고, 못 찾으면(중간에 표기가 빠진 경우) 근사임을 알린다.
    """
    base = source.find(seg["text"], seg["source_start"], max(seg["source_end"], seg["source_start"]))
    exact = base >= 0 and bool(seg["text"])
    if not exact:
        base = seg["source_start"]
    spans, cursor = [], base
    for c in chunks:
        if exact:
            spans.append((cursor, cursor + len(c)))
            cursor += len(c)
        else:
            spans.append((seg["source_start"], seg["source_end"]))
    return spans, exact


def analyze(text, count_tokens, mode="high_quality_icl", reference_replay_frames=0):
    """입력을 production 권위로 분석한다. 반환은 UI 가 그대로 쓸 수 있는 수치다.

    count_tokens: str -> int (production tokenizer). 주입받아 여기서 모델을 로드하지 않는다.
    """
    source = text or ""
    segs, parser_ok = _segments_of(source)
    src_paras = source_paragraphs_of(source)
    # parser 의 original_line_index → 사용자 문단 index. 못 맞추면 None(추측하지 않는다).
    line_to_para = {p["line_index"]: p["index"] for p in src_paras
                    if p["line_index"] is not None}
    cap = chunk_budget.max_production_tokens(reference_replay_frames=reference_replay_frames)
    warnings = [] if parser_ok else [WARN_SOURCE_OFFSETS_APPROXIMATE]

    per_para, chunk_rows = [], []
    total_calls = total_tokens = 0
    audio_lo = audio_hi = 0.0
    gen_lo = gen_hi = 0.0

    for si, seg in enumerate(segs):
        tok = count_tokens(seg["text"])
        try:
            chunks = ([seg["text"]] if tok <= cap
                      else ts.split_for_generation(seg["text"], count_tokens, cap))
        except ts.SegmentTooLong:
            chunks = [seg["text"]]
            if WARN_SEGMENT_TOO_LONG not in warnings:
                warnings.append(WARN_SEGMENT_TOO_LONG)
        if "".join(chunks) != seg["text"]:
            raise AnalysisError("분할이 원문을 보존하지 않음", code="SPLIT_LOST_SOURCE")

        spans, exact = _chunk_spans(source, seg, chunks)
        if not exact and WARN_SOURCE_OFFSETS_APPROXIMATE not in warnings:
            warnings.append(WARN_SOURCE_OFFSETS_APPROXIMATE)

        p_audio_lo = p_audio_hi = 0.0
        p_gen_frames = 0.0
        for ci, ctext in enumerate(chunks):
            ctok = max(1, count_tokens(ctext))
            frames = chunk_budget.predict_audio_frames(ctok)
            budget = chunk_budget.budget_for(ctok, reference_replay_frames=reference_replay_frames)
            last_seg = ci == len(chunks) - 1
            chunk_rows.append({
                "global_index": len(chunk_rows),
                # 두 축을 모두 건다 — 사용자 문단과 parser 구간은 1:1 이 아니다.
                "source_paragraph_index": line_to_para.get(seg.get("line_index")),
                "segment_index": si, "local_chunk_index": ci,
                "source_start": spans[ci][0], "source_end": spans[ci][1],
                "source_offsets_exact": bool(exact),
                "chars": len(ctext),
                "production_tokens": ctok,
                "combined_prompt_tokens": budget["combined_prompt_tokens"],
                "generation_tier": budget["generation_limit"],
                "fits_budget": bool(budget["fits"]),
                "boundary_kind": seg.get("boundary_type"),
                "split_reason": _split_reason(
                    ctext, last_seg, seg.get("boundary_type"),
                    last_seg and si == len(segs) - 1),
                "estimated_audio_seconds": {"min": round(frames["min"] / FPS, 1),
                                            "max": round(frames["max"] / FPS, 1)},
            })
            p_audio_lo += frames["min"]
            p_audio_hi += frames["max"]
            # 작업 시간에는 참조 재발화까지 들어간다 — 생성은 했고 잘라냈을 뿐이다.
            p_gen_frames += frames["max"] + max(0, reference_replay_frames)

        per_para.append({
            "index": si,
            "source_paragraph_index": line_to_para.get(seg.get("line_index")),
            "line_index": seg.get("line_index"),
            "source_start": seg["source_start"], "source_end": seg["source_end"],
            "chars": len(seg["text"]),
            "sentence_count": len(_split_sentences(seg["text"])),
            "emotion_id": seg.get("emotion_id"),
            "boundary_kind": seg.get("boundary_type"),
            "production_tokens": tok,
            "planned_calls": len(chunks),
            "auto_split": len(chunks) > 1,
            "estimated_audio_seconds": {"min": round(p_audio_lo / FPS, 1),
                                        "max": round(p_audio_hi / FPS, 1)},
            # 전체 작업 시간이 아니라 **이 문단이 더 얹는 시간**이다(위 함수 주석 참고).
            "estimated_wall_seconds_marginal": _estimate_marginal_seconds(
                p_gen_frames, len(chunks), mode),
        })
        total_calls += len(chunks)
        total_tokens += tok
        audio_lo += p_audio_lo
        audio_hi += p_audio_hi
        gen_lo += p_gen_frames
        gen_hi += p_gen_frames

    est = _estimate_seconds(gen_hi, total_calls, mode)
    return {
        "schema_version": SCHEMA_VERSION,
        # 원문 SHA 는 사용자가 입력한 그대로, 정규화 SHA 는 파서가 실제로 본 것.
        "source_sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
        "normalized_sha256": _normalized_sha256(source),
        "character_count": len(source),
        # 문단은 사용자의 Enter 경계, segment 는 parser 가 만든 대사 구간이다. 섞지 않는다.
        "source_paragraph_count": len(src_paras),
        "segment_count": len(segs),
        "paragraph_count": len(src_paras),
        "sentence_count": sum(p["sentence_count"] for p in per_para),
        "production_tokens": total_tokens,
        "planned_calls": total_calls,
        "split_cap_production_tokens": cap,
        "estimated_audio_seconds": {"min": round(audio_lo / FPS, 1),
                                    "max": round(audio_hi / FPS, 1)},
        "estimated_wall_seconds": est["seconds"],
        # 위 작업 시간에 들어 있는 고정 준비 비용. UI 가 "모델 준비 포함" 을 말할 근거다.
        "preparation_seconds": _preparation_seconds(mode) if est["seconds"] else None,
        "confidence": est["confidence"],
        "confidence_reason": est["reason"],
        "mode": mode,
        "reference_replay_frames": int(max(0, reference_replay_frames)),
        "parser_authority": bool(parser_ok),
        "warnings": warnings,
        "source_paragraphs": src_paras,
        "segments": per_para,
        "paragraphs": per_para,      # 하위 호환 별칭(구 소비자). 새 코드는 segments 를 쓴다.
        "chunks": chunk_rows,
    }


def _normalized_sha256(source):
    """파서가 실제로 본 문자열의 SHA. 줄 끝 표기만 다른 두 입력은 같은 값이 된다."""
    try:
        import tts_grammar
        norm, _u, _c = tts_grammar.normalize_line_endings(source or "")
    except Exception:
        norm = source or ""
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()


def _preparation_seconds(mode):
    """모델을 준비하는 데 드는 고정 시간. 대사 길이와 무관하게 **작업당 한 번** 든다."""
    if mode not in _MODES_WITH_SAMPLES:
        return None
    lo = hi = None
    for c in _C_RANGE:
        job = _FIT_A - c * _FIT_TARGET
        lo = job if lo is None else min(lo, job)
        hi = job if hi is None else max(hi, job)
    return {"min": round(max(0.0, lo), 1), "max": round(hi, 1)}


def _estimate_marginal_seconds(frames, calls, mode):
    """이 문단 **하나 때문에 더 걸리는** 시간.

    문단 줄에 전체 작업 시간을 그대로 쓰면 안 된다. 고정 준비 비용이 문단마다 한 번씩
    들어가 문단 줄의 합이 전체 예상보다 커진다(실제로 3문단에서 총 59~109초인데 문단
    합이 144~281초로 나왔다). 화면에서 앞뒤가 맞지 않는 숫자가 되므로, 문단 줄은
    **준비 비용을 뺀 한계 비용**만 말한다. 준비 비용은 요약 한 줄이 한 번 포함한다.
    """
    if calls <= 0 or mode not in _MODES_WITH_SAMPLES:
        return None
    lo = hi = None
    for c in _C_RANGE:
        per_call = max(0.0, _FIT_K - 83.0 * c)
        t = per_call * calls + c * frames
        lo = t if lo is None else min(lo, t)
        hi = t if hi is None else max(hi, t)
    return {"min": round(max(0.0, lo), 1), "max": round(hi, 1)}


def _estimate_seconds(total_frames, calls, mode):
    """모드에 통제 표본이 없으면 숫자를 만들지 않는다."""
    if calls <= 0:
        return {"seconds": None, "confidence": CONFIDENCE_INSUFFICIENT,
                "reason": "EMPTY_INPUT"}
    if mode not in _MODES_WITH_SAMPLES:
        return {"seconds": None, "confidence": CONFIDENCE_INSUFFICIENT,
                "reason": "NO_CONTROLLED_SAMPLES_FOR_MODE"}
    lo = hi = None
    for c in _C_RANGE:
        job = _FIT_A - c * _FIT_TARGET
        per_call = max(0.0, _FIT_K - 83.0 * c)
        t = job + per_call * calls + c * total_frames
        lo = t if lo is None else min(lo, t)
        hi = t if hi is None else max(hi, t)
    lo, hi = max(0.0, lo - _Z * _RESID_SD), hi + _Z * _RESID_SD
    inside = MEASURED_FRAME_RANGE[0] <= total_frames <= MEASURED_FRAME_RANGE[1]
    return {"seconds": {"min": round(lo, 1), "max": round(hi, 1)},
            "confidence": CONFIDENCE_MEASURED if inside else CONFIDENCE_EXTRAPOLATED,
            "reason": ("WITHIN_MEASURED_FRAME_RANGE" if inside
                       else "OUTSIDE_MEASURED_FRAME_RANGE")}
