# -*- coding: utf-8 -*-
"""표현형 운율 ENGINE — 계획서 ↔ 산출 신호를 잇는 **얇은** 계측 레이어.

이 모듈에는 신호 처리 수식이 **하나도 없다.** RMS·F0·화자 임베딩 거리·mel 거리·온셋 기울기·
무음 길이·이음매 단차는 전부 범용 단일 권위 `onset_continuity_metrics` 가 계산한다.
여기가 하는 일은 두 가지뿐이다.

  1. 계획서(expressive_planner.build_plan 의 결과) + 청크별 실측 샘플 수 → ChunkSpan 목록으로 환산.
  2. 계획서에서만 알 수 있는 **숫자 주석**(분할 사유 인덱스, 웃음 위치, degraded 여부 등)을 붙여
     나중에 사람이 "어느 경계가 왜 그렇게 생겼는가" 를 대조할 수 있게 한다.

하드 요건:
  · 모델 로딩 없음. 화자 임베딩은 주입된 embed_fn 으로만 얻는다(권위 모듈이 받아 처리).
  · 파일 I/O·경로·대사·전사·오디오 샘플을 레코드에 담지 않는다. **숫자만** 나간다.
  · 판정하지 않는다 — 서술만 한다. 어떤 값도 '합격/불합격' 을 뜻하지 않는다.
  · 표현형 전용 임계값을 만들지 않는다(일반 연속성 임계는 권위 모듈의 상수다).
"""

from typing import Callable, List, Optional, Sequence

import expressive_planner as epl
import onset_continuity_metrics as ocm

MetricsError = ocm.MetricsError
PrivacyViolation = ocm.PrivacyViolation

# 문자열을 레코드에 넣지 않기 위해, 사유/전략은 계약 튜플의 **인덱스**로 기록한다.
SPLIT_REASON_INDEX = {code: i for i, code in enumerate(epl.SPLIT_REASON_CODES)}
EMOTION_STRATEGY_INDEX = {code: i for i, code in enumerate(epl.EMOTION_STRATEGIES)}
LAUGH_POSITION_INDEX = {code: i for i, code in enumerate(("leading", "inline", "trailing", "standalone"))}
LAUGH_STRATEGY_INDEX = {code: i for i, code in enumerate(epl.LAUGH_STRATEGIES)}

UNKNOWN_INDEX = -1

ANNOTATION_FIELDS = (
    "chunk_index",
    "sentence_count",
    "split_reason_index",        # SPLIT_REASON_CODES 의 인덱스
    "emotion_strategy_index",    # EMOTION_STRATEGIES 의 인덱스
    "chunk_degraded",            # 0/1
    "chunk_oversized",           # 0/1
    "prod_tokens",
    "max_tokens",
    "leading_gap_ms",            # 없으면 -1
    "trailing_gap_ms",           # 없으면 -1
    "native_prosody_count",
    "non_native_prosody_count",
    "internal_transition_count",
    "laugh_count",
    "laugh_position_index",      # 청크 첫 웃음의 위치 인덱스(없으면 -1)
    "laugh_strategy_index",      # 웃음 전략 인덱스(없으면 -1)
    "laugh_checks_required",     # 이 청크에서 요구되는 웃음 검사 개수
)

ANNOTATION_INT_FIELDS = ANNOTATION_FIELDS   # 전부 정수다


def chunk_spans_from_plan(plan, chunk_sample_counts: Sequence[int],
                          gap_samples_before: Optional[Sequence[int]] = None) -> List[ocm.ChunkSpan]:
    """계획서의 청크 순서 + 청크별 실측 샘플 수 → ChunkSpan 목록.

    gap_samples_before[i] 는 청크 i **앞**에 실제로 삽입된 무음 샘플 수다(i=0 은 선행 무음).
    파일을 읽지 않는다 — 샘플 수는 호출부가 실측해 넘긴다.
    """
    chunks = plan.get("chunks") or []
    counts = list(chunk_sample_counts or [])
    if len(counts) != len(chunks):
        raise MetricsError("chunk/sample-count mismatch: %d vs %d" % (len(chunks), len(counts)))
    gaps = list(gap_samples_before) if gap_samples_before is not None else [0] * len(chunks)
    if len(gaps) != len(chunks):
        raise MetricsError("chunk/gap-count mismatch: %d vs %d" % (len(chunks), len(gaps)))

    spans: List[ocm.ChunkSpan] = []
    cursor = 0
    for i, c in enumerate(chunks):
        g = int(gaps[i])
        n = int(counts[i])
        if g < 0:
            raise MetricsError("negative gap at %d: %d" % (i, g))
        if n <= 0:
            raise MetricsError("non-positive chunk samples at %d: %d" % (i, n))
        cursor += g
        spans.append(ocm.ChunkSpan(chunk_index=int(c["index"]), start_sample=cursor,
                                   end_sample=cursor + n, gap_before_samples=g))
        cursor += n
    return spans


def _ms_or_missing(value) -> int:
    return UNKNOWN_INDEX if value is None else int(value)


def build_annotations(plan) -> List[dict]:
    """계획서에서만 알 수 있는 정보를 **숫자 주석**으로 뽑는다(문자열 없음)."""
    strategy_index = EMOTION_STRATEGY_INDEX.get(
        (plan.get("emotion_strategy") or {}).get("strategy"), UNKNOWN_INDEX)
    manifest = plan.get("laugh_manifest") or []

    out: List[dict] = []
    for c in plan.get("chunks") or []:
        laughs = [m for m in manifest if m.get("chunk_index") == c["index"]]
        first = laughs[0] if laughs else None
        rec = {
            "chunk_index": int(c["index"]),
            "sentence_count": int(c["sentence_count"]),
            "split_reason_index": SPLIT_REASON_INDEX.get(c["end_reason"], UNKNOWN_INDEX),
            "emotion_strategy_index": strategy_index,
            "chunk_degraded": 1 if c.get("degraded") else 0,
            "chunk_oversized": 1 if c.get("oversized") else 0,
            "prod_tokens": int(c["prod_tokens"]),
            "max_tokens": int(c["max_tokens"]),
            "leading_gap_ms": _ms_or_missing(c.get("leading_gap_ms")),
            "trailing_gap_ms": _ms_or_missing(c.get("trailing_gap_ms")),
            "native_prosody_count": len(c.get("native_prosody_events") or []),
            "non_native_prosody_count": len(c.get("non_native_prosody_events") or []),
            "internal_transition_count": len(c.get("emotion_transitions") or []),
            "laugh_count": len(laughs),
            "laugh_position_index": (LAUGH_POSITION_INDEX.get(first["position"], UNKNOWN_INDEX)
                                     if first else UNKNOWN_INDEX),
            "laugh_strategy_index": (LAUGH_STRATEGY_INDEX.get(first["strategy"], UNKNOWN_INDEX)
                                     if first else UNKNOWN_INDEX),
            "laugh_checks_required": sum(len(m.get("required_checks") or []) for m in laughs),
        }
        assert tuple(rec.keys()) == ANNOTATION_FIELDS
        out.append(rec)
    return out


def measure_plan(signal, sr, plan, chunk_sample_counts: Sequence[int],
                 gap_samples_before: Optional[Sequence[int]] = None,
                 embed_fn: Optional[Callable] = None) -> dict:
    """산출 신호 + 계획서 → (권위 모듈의 청크 레코드, 계획 주석). 숫자만 나간다.

    embed_fn 이 없으면 화자 거리는 계산되지 않고 speaker_distance_available=0 으로 표기된다.
    (임베딩 모델을 여기서 로드하는 경로는 존재하지 않는다.)
    """
    spans = chunk_spans_from_plan(plan, chunk_sample_counts, gap_samples_before)
    records = ocm.compute_onset_continuity_metrics(signal, sr, spans, embed_fn=embed_fn)
    return {"records": records, "annotations": build_annotations(plan),
            "span_count": len(spans), "embed_available": 1 if embed_fn is not None else 0}


def serialize_annotation(record: dict) -> dict:
    """주석 1개 → 정수만 담은 dict. 문자열이 들어갈 자리가 없다는 것이 하드 계약이다."""
    if not isinstance(record, dict):
        raise PrivacyViolation("annotation must be a dict")
    extra = set(record.keys()) - set(ANNOTATION_FIELDS)
    if extra:
        raise PrivacyViolation("disallowed fields: %d" % len(extra))
    missing = set(ANNOTATION_FIELDS) - set(record.keys())
    if missing:
        raise PrivacyViolation("missing fields: %d" % len(missing))
    out = {}
    for key in ANNOTATION_FIELDS:
        value = record[key]
        if isinstance(value, bool) or not isinstance(value, int):
            raise PrivacyViolation("'%s' is not an int" % key)
        out[key] = int(value)
    return out


def serialize_measurement(result: dict) -> dict:
    """measure_plan 결과 전체 직렬화 — 권위 모듈의 직렬화를 그대로 쓴다(중복 검증 없음)."""
    return {
        "records": ocm.serialize_records(result.get("records") or []),
        "annotations": [serialize_annotation(a) for a in (result.get("annotations") or [])],
        "span_count": int(result.get("span_count", 0)),
        "embed_available": int(result.get("embed_available", 0)),
    }
