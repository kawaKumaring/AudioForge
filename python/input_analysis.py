# -*- coding: utf-8 -*-
"""입력 분석과 생성 시간 추정 — production planner 와 **같은 권위**를 쓴다.

왜 여기 있나
------------
UI 가 보여 주는 "몇 묶음, 얼마나 걸림" 이 실제 생성과 어긋나면 안내가 아니라 오정보다.
그래서 문단·문장 분리와 분할 계획을 TS 에 다시 구현하지 않고 production 경로를 그대로 부른다.

  문단   tts_grammar.parse_tts_script
  문장   text_segmenter._cut_after(SENTENCE_ENDERS)
  분할   text_segmenter.split_for_generation + chunk_budget.max_production_tokens
  토큰   호출자가 주입하는 production tokenizer (qwen_bridge._prod_tokens 와 동일 경로)

시간 모델
---------
`_local/artifacts/drafts/timing-model/model.md` 의 실측에서 왔다. 동일 250자를 호출수만 바꿔
생성한 통제 실험 6건(정상 종료·high_quality_icl)에서 유도했고, 미종료 표본은 학습에서 뺐다.
프레임당 비용 C 는 자유도가 남아 구간으로만 확정된다 — 단일값으로 쓰지 않는다.

  elapsed = job_start(C) + per_call(C) * calls + C * total_frames,  C in [0.18, 0.22]
  job_start(C) = 130.61 - 333*C,  per_call(C) = max(0, 18.25 - 83*C)

통제 표본이 없는 모드(safe_xvector, auto)는 숫자를 만들지 않고 insufficient_data 로 답한다.
"""
import chunk_budget
import text_segmenter as ts

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


def _split_sentences(text):
    return [p for p in ts._cut_after(text, ts.SENTENCE_ENDERS, eat_closers=True) if p.strip()]


def paragraphs_of(text):
    """Enter 는 사용자가 지정한 문단 경계다. 비어 있지 않은 줄만 문단이 된다.

    연속 빈 줄은 문단을 만들지 않는다 — 휴지일 뿐이다. 자동 줄바꿈은 경계가 아니다
    (원문 문자열에 개행이 없으면 경계도 없다).
    """
    out, char = [], 0
    for raw in (text or "").split(chr(10)):
        if raw.strip():
            out.append({"index": len(out), "char_start": char, "char_end": char + len(raw),
                        "text": raw})
        char += len(raw) + 1
    return out


def analyze(text, count_tokens, mode="high_quality_icl", reference_replay_frames=0):
    """입력을 production 권위로 분석한다. 반환은 UI 가 그대로 쓸 수 있는 수치다.

    count_tokens: str -> int (production tokenizer). 주입받아 여기서 모델을 로드하지 않는다.
    """
    paras = paragraphs_of(text)
    cap = chunk_budget.max_production_tokens(reference_replay_frames=reference_replay_frames)
    per_para, total_calls, total_frames, total_tokens = [], 0, 0.0, 0
    for p in paras:
        tok = count_tokens(p["text"])
        # 문단이 예산을 넘을 때만 문장·절 단위로 하향 분할한다.
        chunks = ([p["text"]] if tok <= cap
                  else ts.split_for_generation(p["text"], count_tokens, cap))
        assert "".join(chunks) == p["text"], "분할이 원문을 보존하지 않음"
        frames = sum(chunk_budget.predict_frames(max(1, count_tokens(c)))["high"] for c in chunks)
        frames += reference_replay_frames * len(chunks)
        per_para.append({
            "index": p["index"], "chars": len(p["text"]),
            "char_start": p["char_start"], "char_end": p["char_end"],
            "sentence_count": len(_split_sentences(p["text"])),
            "production_tokens": tok, "planned_calls": len(chunks),
            "auto_split": len(chunks) > 1,
            "estimated_audio_seconds": round(frames / FPS, 1),
        })
        total_calls += len(chunks)
        total_frames += frames
        total_tokens += tok
    est = _estimate_seconds(total_frames, total_calls, mode)
    return {
        "chars": len(text or ""),
        "paragraph_count": len(paras),
        "sentence_count": sum(p["sentence_count"] for p in per_para),
        "production_tokens": total_tokens,
        "planned_calls": total_calls,
        "split_cap_production_tokens": cap,
        "estimated_audio_seconds": round(total_frames / FPS, 1),
        "estimated_generation_seconds": est["seconds"],
        "confidence": est["confidence"],
        "mode": mode,
        "paragraphs": per_para,
    }


def _estimate_seconds(total_frames, calls, mode):
    """모드에 통제 표본이 없으면 숫자를 만들지 않는다."""
    if mode not in _MODES_WITH_SAMPLES or calls <= 0:
        return {"seconds": None, "confidence": CONFIDENCE_INSUFFICIENT}
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
            "confidence": CONFIDENCE_MEASURED if inside else CONFIDENCE_EXTRAPOLATED}
