# -*- coding: utf-8 -*-
"""의미 기반 장문 분할(C2) — 순수 계획 로직. 모델/GPU/오디오/파일 I/O 없음.

────────────────────────────────────────────────────────────────────────────
이 모듈이 '하지 않는' 일 (이미 있는 계약을 소비만 한다)
────────────────────────────────────────────────────────────────────────────
  · 경계 우선순위 결정        → tts_grammar 가 이미 segment 마다 boundary_type 으로 '단일 결정' 했다.
                               여기서는 그 승자를 그대로 읽는다. 다시 유도하지 않는다.
  · 감정 태그/문장부호가 분할점인지 → expressive_timeline 이 이미 False 로 못 박았다
                               (EMOTION_TRANSITION_IS_CHUNK_BOUNDARY / LOCAL_PROSODY_IS_CHUNK_BOUNDARY).
                               아래 _assert_consumed_contracts() 가 그 값을 실제로 읽어 소비한다.
  · 합산 금지                 → expressive_timeline.SENTENCE_GAP_AND_EMOTION_PAUSE_MAY_SUM = False.
  · 한 문장이 상한을 넘을 때의 최후 분할(절→단어→문자)
                              → text_segmenter.split_for_generation 이 이미 소유한다.
                                이 모듈은 그것을 복제하지 않는다(테스트가 그 동작을 규칙 2·4·5 로 고정한다).
  · 생성 상한 / watchdog / timeout → generation_limit 이 유일 권위. 이 모듈은 import 조차 하지 않는다.

────────────────────────────────────────────────────────────────────────────
이 모듈이 '새로 더하는' 두 가지 (v2 에 없어서 장문에서 실제로 문제가 되는 것)
────────────────────────────────────────────────────────────────────────────
 (1) 문단 경계(빈 줄)의 승격 — 규칙 1.
     v2 는 '빈 줄 있는 줄바꿈' 과 '그냥 줄바꿈' 을 둘 다 lineSilenceGap 하나로 뭉갠다.
     원문의 문단 구조는 original_line_index 의 '건너뛴 줄 수' 에 그대로 남아 있으므로,
     그 사실만 읽어 kind 를 paragraph 로 승격한다(파서 출력·해시는 건드리지 않는다).
     paragraph_gap 을 주지 않으면 값은 line 과 동일 → 오늘 동작과 완전히 같다.

 (2) 무음 예산(pause budget) — 규칙 7.
     실제로 들리는 쉼 = 모델이 낸 말미 무음 + 앱이 넣는 gap + 다음 청크 앞머리 무음.
     오늘은 앱 gap 만 계산하므로 이 셋이 '합산' 되어 목표보다 길어진다.
     여기서는 셋의 합이 목표가 되도록 앱 gap 을 역산하는 계약을 제공한다.
     ⚠️ 말미/앞머리 무음을 '재는' 일은 이 모듈의 몫이 아니다(C3 소유). 측정값은 주입받는다.
        주입이 없으면 보정하지 않고 그 사실을 reason 으로 정직하게 표기한다.

하위호환(규칙 8): model_tail_ms / model_lead_ms / paragraph_gap 을 모두 주지 않으면
resolve_boundary_gaps 의 gap 초값은 tts_worker 가 오늘 계산하는 값과 '같은 식·같은 부동소수'다.
(보정이 없을 때는 ms 도메인으로 내려가지 않는다 — 초↔ms 왕복 반올림을 피하기 위해서다.)

프라이버시: 이 모듈은 대사 전문을 읽지도 반환하지도 않는다. 인덱스·짧은 토큰·숫자만 다룬다.
"""
from typing import List, Optional

import expressive_timeline as ex   # 계약(감정/문장부호 경계 여부, 합산 금지)의 단일 권위

# ─────────────────────────────────────────────────────────────────────────────
# 0. 소비하는 계약의 드리프트 가드
# ─────────────────────────────────────────────────────────────────────────────


def _assert_consumed_contracts():
    """소비 대상 계약이 뒤집히면 이 모듈의 규칙 4·6 근거가 사라진다 → import 시점에 즉시 실패."""
    if ex.EMOTION_TRANSITION_IS_CHUNK_BOUNDARY:
        raise RuntimeError("contract drift: EMOTION_TRANSITION_IS_CHUNK_BOUNDARY")
    if ex.LOCAL_PROSODY_IS_CHUNK_BOUNDARY:
        raise RuntimeError("contract drift: LOCAL_PROSODY_IS_CHUNK_BOUNDARY")
    if ex.SENTENCE_GAP_AND_EMOTION_PAUSE_MAY_SUM:
        raise RuntimeError("contract drift: SENTENCE_GAP_AND_EMOTION_PAUSE_MAY_SUM")
    if not ex.SENTENCE_GAP_SUPPRESSED_BY_EXPLICIT_PAUSE:
        raise RuntimeError("contract drift: SENTENCE_GAP_SUPPRESSED_BY_EXPLICIT_PAUSE")


_assert_consumed_contracts()

PLANNER_VERSION = 1

# ─────────────────────────────────────────────────────────────────────────────
# 1. 의미 경계 종류와 강도 (규칙 1·2)
# ─────────────────────────────────────────────────────────────────────────────

# 약 → 강. 이 튜플 하나가 규칙 1(문단이 가장 강함)과 규칙 2(종결부호가 선호 경계)의 유일한 표현이다.
#   internal      : 경계 아님(같은 줄·같은 감정, 무음 0)
#   emotion       : 감정 전환만으로 생긴 v2 segment 경계 — '분할 사유' 로는 쓰지 않는다(규칙 4)
#   sentence      : '.', '!', '?' 종결 — 선호 경계(규칙 2)
#   line          : 줄바꿈
#   paragraph     : 빈 줄 — 가장 강한 구조 경계(규칙 1)
#   explicitPause : 사용자가 직접 쓴 [쉼 N] — 언제나 override(합산 아님)
SEMANTIC_BOUNDARY_ORDER = (
    "internal", "emotion", "sentence", "line", "paragraph", "explicitPause",
)

# 규칙 4 — 여기 있는 종류는 '여기서 잘라라' 의 근거가 될 수 없다.
NON_SPLITTING_BOUNDARY_KINDS = ("internal", "emotion")

# 규칙 2·5 — 한 덩어리가 상한을 넘을 때 잘라도 되는 경계(강한 것부터).
# 위 두 튜플에서 '유도' 한다 — 손으로 적으면 종류가 늘어날 때 조용히 어긋난다.
SPLIT_ELIGIBLE_KINDS = tuple(
    k for k in reversed(SEMANTIC_BOUNDARY_ORDER) if k not in NON_SPLITTING_BOUNDARY_KINDS
)

# v2 boundary_type → 의미 경계. paragraph 승격만 별도 판정한다(빈 줄이 있을 때).
V2_BOUNDARY_TYPE_TO_KIND = {
    "internal": "internal",
    "emotionBoundaryPause": "emotion",
    "lineSilenceGap": "line",
    "explicitPause": "explicitPause",
}


def boundary_strength(kind: str) -> int:
    """의미 경계 강도(클수록 강함). 알 수 없는 종류는 계약 위반."""
    try:
        return SEMANTIC_BOUNDARY_ORDER.index(kind)
    except ValueError:
        raise ValueError("unknown boundary kind: %s" % kind)


def is_split_eligible(kind: str) -> bool:
    """규칙 4 — 감정 전환/내부는 분할 근거가 아니다."""
    boundary_strength(kind)          # 종류 검증
    return kind not in NON_SPLITTING_BOUNDARY_KINDS


# ─────────────────────────────────────────────────────────────────────────────
# 2. 무음 예산 (규칙 7)
# ─────────────────────────────────────────────────────────────────────────────

PAUSE_BUDGET_REASONS = (
    "TARGET_ZERO",                   # 목표 0 — 넣을 무음이 없다
    "TAIL_UNMEASURED",               # 측정값 미주입 — 보정하지 않는다(정직). 앱 gap = 목표
    "MEASURED_COMPENSATED",          # 측정값으로 역산 — tail + app + lead == target
    "MEASURED_TAIL_EXCEEDS_TARGET",  # 모델 무음만으로 이미 목표 이상 — 앱 gap 0(음수 금지)
)

# 앱 gap 하한. 오디오를 깎지 않기 위해 '무음을 빼는' 일은 하지 않는다 → 0 에서 멈춘다.
APP_GAP_FLOOR_MS = 0


def plan_pause_budget(target_pause_ms, model_tail_ms=None, model_lead_ms=None) -> dict:
    """목표 쉼(ms) → 앱이 실제로 삽입할 무음(ms).

    model_tail_ms / model_lead_ms 는 **측정 결과를 주입받는 값**이다. 이 모듈은 재지 않는다(C3 소유).
    둘 다 None 이면 보정 없이 목표를 그대로 쓰고 reason='TAIL_UNMEASURED' 로 표기한다.

    불변식: reason 이 MEASURED_COMPENSATED 이면 model_tail_ms + app_gap_ms + model_lead_ms == target_pause_ms.
            app_gap_ms 는 절대 음수가 아니다(무음을 '깎는' 보정은 하지 않는다).
    """
    t = int(round(float(target_pause_ms)))
    if t < 0:
        raise ValueError("target_pause_ms must be >= 0")

    if model_tail_ms is None and model_lead_ms is None:
        return {
            "target_pause_ms": t, "model_tail_ms": None, "model_lead_ms": None,
            "app_gap_ms": t, "realized_pause_ms": None,
            "compensated": False, "reason": "TAIL_UNMEASURED",
        }

    tail = int(round(float(model_tail_ms or 0)))
    lead = int(round(float(model_lead_ms or 0)))
    if tail < 0 or lead < 0:
        raise ValueError("measured silence must be >= 0")

    if t == 0:
        app, reason = APP_GAP_FLOOR_MS, "TARGET_ZERO"
    elif tail + lead >= t:
        app, reason = APP_GAP_FLOOR_MS, "MEASURED_TAIL_EXCEEDS_TARGET"
    else:
        app, reason = t - tail - lead, "MEASURED_COMPENSATED"

    return {
        "target_pause_ms": t, "model_tail_ms": tail, "model_lead_ms": lead,
        "app_gap_ms": app, "realized_pause_ms": tail + app + lead,
        "compensated": reason == "MEASURED_COMPENSATED", "reason": reason,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 3. plan(segments) → 의미 경계 분류 (규칙 1·4·6)
# ─────────────────────────────────────────────────────────────────────────────

def _explicit_pause_ms(seg) -> Optional[int]:
    for p in seg.get("pauses", []) or []:
        if p.get("boundary_type") == "explicitPause":
            pm = p.get("pause_ms")
            if isinstance(pm, (int, float)):
                return int(pm)
    return None


def classify_plan_boundaries(plan) -> List[dict]:
    """v2 plan → segment 마다 '이 앞 경계가 의미상 무엇인가'.

    승자(kind)는 파서가 정한 boundary_type 에서 온다 — 여기서 우선순위를 다시 매기지 않는다(규칙 6).
    candidates 는 segment 에 남아 있는 '사실'(명시 쉼 존재 / 줄 번호 증가 / 감정 변화)에서만 만들고,
    suppressed = candidates - 승자 로 '합산하지 않았다' 는 증거를 남긴다.

    유일한 추가 판정은 문단 승격이다(규칙 1): lineSilenceGap 인데 건너뛴 줄이 1 이상이면 paragraph.
    """
    segs = plan.get("segments", []) or []
    out: List[dict] = []
    paragraph_index = 0

    for idx, s in enumerate(segs):
        bt = s.get("boundary_type", "internal")
        cur_line = int(s.get("original_line_index", 0) or 0)

        blank_lines_before = 0
        candidates: List[str] = []
        if idx > 0:
            prev = segs[idx - 1]
            prev_line = int(prev.get("original_line_index", 0) or 0)
            blank_lines_before = max(0, cur_line - prev_line - 1)
            if _explicit_pause_ms(s) is not None:
                candidates.append("explicitPause")
            if cur_line > prev_line:
                candidates.append("paragraph" if blank_lines_before > 0 else "line")
            if s.get("emotion_id") != prev.get("emotion_id"):
                candidates.append("emotion")

        if idx == 0:
            kind = "internal"
        else:
            kind = V2_BOUNDARY_TYPE_TO_KIND.get(bt, "internal")
            if kind == "line" and blank_lines_before > 0:
                kind = "paragraph"          # 규칙 1 — 유일한 승격 지점

        if kind == "paragraph":
            paragraph_index += 1

        suppressed = [c for c in candidates if c != kind]
        out.append({
            "index": idx,
            "kind": kind,
            "source_boundary_type": bt,
            "strength": boundary_strength(kind),
            "split_eligible": is_split_eligible(kind),
            "candidates": candidates,
            "suppressed": suppressed,
            "blank_lines_before": blank_lines_before,
            "paragraph_index": paragraph_index,
            "explicit_pause_ms": _explicit_pause_ms(s),
            # 규칙 3 — 앞 청크와 이어 붙여도 무음이 0 이라 안전한 자리(실제 병합은 통합 담당자 몫).
            # 'internal' 만이다. 'emotion' 은 분할 사유는 아니지만(규칙 4) pause 모드에서 무음이 있어
            # 합치면 그 무음이 사라진다 → 병합 안전하지 않다.
            "mergeable_with_prev": idx > 0 and kind == "internal",
        })
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 4. 경계 → 실제 삽입 무음 (규칙 6·7·8)
# ─────────────────────────────────────────────────────────────────────────────

def _target_gap_sec(entry, silence_gap, emotion_boundary_mode,
                    emotion_boundary_pause_ms, paragraph_gap):
    """오늘 tts_worker._boundary_gaps_from_plan 이 쓰는 것과 '같은 식'으로 목표 무음(초)을 낸다.

    paragraph_gap 이 None 이면 문단도 line 과 같은 값 → 오늘과 동일(규칙 8).
    """
    kind = entry["kind"]
    if entry["index"] == 0 or kind == "internal":
        return 0.0
    if kind == "explicitPause":
        pm = entry["explicit_pause_ms"]
        return (pm / 1000.0) if isinstance(pm, (int, float)) else 0.0
    if kind == "paragraph":
        return float(silence_gap) if paragraph_gap is None else float(paragraph_gap)
    if kind == "line":
        return float(silence_gap)
    if kind == "emotion":
        return 0.0 if emotion_boundary_mode == "immediate" else (float(emotion_boundary_pause_ms) / 1000.0)
    return 0.0


def resolve_boundary_gaps(plan, silence_gap, emotion_boundary_mode="pause",
                          emotion_boundary_pause_ms=200, paragraph_gap=None,
                          model_tail_ms=None, model_lead_ms=None) -> List[dict]:
    """v2 plan → segment 마다 {경계 분류 + 목표 무음 + 실제 삽입 무음}.

    gap_sec 이 tts_worker 가 오디오 결합에 쓰는 값이다. 보정 입력(model_tail_ms/model_lead_ms)이
    없으면 target_gap_sec 을 '그 객체 그대로' 통과시킨다 — 초↔ms 왕복을 하지 않으므로
    오늘 나오는 부동소수와 완전히 동일하다(규칙 8).
    """
    entries = classify_plan_boundaries(plan)
    uncompensated = model_tail_ms is None and model_lead_ms is None

    for entry in entries:
        target_sec = _target_gap_sec(entry, silence_gap, emotion_boundary_mode,
                                     emotion_boundary_pause_ms, paragraph_gap)
        entry["target_gap_sec"] = target_sec
        if entry["index"] == 0 or uncompensated:
            # 첫 segment 는 앞 무음이 없고(경계 아님), 미측정이면 보정하지 않는다.
            entry["budget"] = plan_pause_budget(target_sec * 1000.0)
            entry["gap_sec"] = 0.0 if entry["index"] == 0 else target_sec
        else:
            budget = plan_pause_budget(target_sec * 1000.0, model_tail_ms, model_lead_ms)
            entry["budget"] = budget
            entry["gap_sec"] = budget["app_gap_ms"] / 1000.0
    return entries
