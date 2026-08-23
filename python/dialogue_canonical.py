# -*- coding: utf-8 -*-
"""대화 처리 canonical artifact 코어 (순수 모듈, 모델·오디오 의존 없음).

이 모듈은 화자 분리/전사 파이프라인의 *결과*를 담는 표준(canonical) 데이터
구조와 직렬화 스키마만 정의한다. torch/numpy/모델/파일 I/O에 의존하지 않는
순수 로직이므로 합성 타임라인만으로 단위 테스트가 가능하다.

정의하는 것:
  - DialogueSegment: 발화 구간 1개 (start/end · 화자 posterior · confidence ·
    상태 · overlap 다중 화자 라벨 · backchannel 여부 · 선택적 단어 부착)
  - WordToken: CTM/word attribution용 단어 단위
  - CanonicalSidecar: 세그먼트 묶음 + 스키마 버전 + 화자 목록 (사이드카 파일 본체)
  - 직렬화: 결정적(deterministic) JSON, NIST RTTM, CTM
  - 합성 프레임 타임라인 → 세그먼트 빌더

불변식(테스트로 고정):
  * 0 <= start <= end                          (구간 유효성)
  * 500ms 미만 backchannel 은 버리지 않는다     (is_backchannel 플래그로 보존)
  * overlap 은 speakers 다중 라벨로 표현         (동시 발화 손실 없음)
  * posterior 는 정규화(합=1, 화자 없으면 예외)  (UNKNOWN 은 빈 posterior 허용)
  * 직렬화는 정렬·고정 소수 자리 → 같은 입력=같은 바이트

주의: 이 모듈은 기존 argmax 단일화자 마스킹 동작(conversation_worker.py)을
바꾸지 않는다. 현재 기능은 실제 "source separation" 이 아니라 argmax 마스킹이며,
이 사이드카는 그 결과를 손실 없이 표준 형식으로 담기 위한 것이다.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Dict, List, Optional, Sequence, Tuple


# 스키마 버전 — 직렬화 포맷이 바뀌면 반드시 올린다 (파서 호환성 판별용).
SCHEMA_VERSION = "1.0.0"
SCHEMA_ID = "audioforge/dialogue-canonical"

# 500ms 미만은 backchannel("응", "네", 맞장구)로 간주하여 보존 대상으로 표시.
BACKCHANNEL_MAX_SEC = 0.5

# 시간·확률 직렬화 고정 소수 자리 (결정적 출력 + ms/µprob 해상도).
TIME_DECIMALS = 3   # 1ms
PROB_DECIMALS = 6

# 상태 판정 기본 임계 (confidence 기반). 호출부에서 조정 가능.
DEFAULT_REVIEW_BELOW = 0.55   # 이 미만이면 REVIEW (사람 검토 권장)
DEFAULT_UNKNOWN_BELOW = 0.25  # 이 미만이면 UNKNOWN (화자 신뢰 불가)

# overlap 판정: 2순위 화자 posterior 가 이 값 이상이면 동시 발화로 다중 라벨.
DEFAULT_OVERLAP_MIN_POSTERIOR = 0.30


class SegmentStatus(str, Enum):
    """세그먼트 상태.

    OK      : 화자 배정 신뢰 가능.
    REVIEW  : 애매 — 사람 검토 권장 (자동 결과는 유지).
    UNKNOWN : 화자 판단 불가 (posterior 신뢰 불가 / 미배정).
    """
    OK = "OK"
    REVIEW = "REVIEW"
    UNKNOWN = "UNKNOWN"


def _round_time(v: float) -> float:
    return round(float(v), TIME_DECIMALS)


def _round_prob(v: float) -> float:
    return round(float(v), PROB_DECIMALS)


def normalize_posterior(posterior: Dict[str, float]) -> Dict[str, float]:
    """화자 posterior 를 합=1 로 정규화. 음수는 0 으로 클램프.

    빈 dict 또는 합<=0 이면 빈 dict 반환(→ UNKNOWN 로 취급).
    """
    if not posterior:
        return {}
    clamped = {spk: max(0.0, float(p)) for spk, p in posterior.items()}
    total = sum(clamped.values())
    if total <= 0.0:
        return {}
    return {spk: p / total for spk, p in clamped.items()}


def classify_status(confidence: float,
                    posterior: Dict[str, float],
                    review_below: float = DEFAULT_REVIEW_BELOW,
                    unknown_below: float = DEFAULT_UNKNOWN_BELOW) -> SegmentStatus:
    """confidence + posterior 로 상태 판정 (순수 함수).

    posterior 가 비어 있으면(화자 미배정) 무조건 UNKNOWN.
    아니면 confidence 임계로 UNKNOWN < REVIEW < OK 판정.
    """
    if not posterior:
        return SegmentStatus.UNKNOWN
    if confidence < unknown_below:
        return SegmentStatus.UNKNOWN
    if confidence < review_below:
        return SegmentStatus.REVIEW
    return SegmentStatus.OK


@dataclass(frozen=True)
class WordToken:
    """단어 단위(word attribution / CTM 용). 시간은 초 단위 절대 시각."""
    text: str
    start: float
    end: float
    speaker: Optional[str] = None
    confidence: float = 1.0

    def __post_init__(self):
        if self.start < 0:
            raise ValueError(f"word start<0: {self.start}")
        if self.end < self.start:
            raise ValueError(f"word end<start: {self.end}<{self.start}")

    @property
    def duration(self) -> float:
        return self.end - self.start

    def to_dict(self) -> dict:
        d = {
            "text": self.text,
            "start": _round_time(self.start),
            "end": _round_time(self.end),
            "confidence": _round_prob(self.confidence),
        }
        if self.speaker is not None:
            d["speaker"] = self.speaker
        return d

    @staticmethod
    def from_dict(d: dict) -> "WordToken":
        return WordToken(
            text=d["text"],
            start=float(d["start"]),
            end=float(d["end"]),
            speaker=d.get("speaker"),
            confidence=float(d.get("confidence", 1.0)),
        )


@dataclass(frozen=True)
class DialogueSegment:
    """대화 세그먼트 1개.

    speakers  : overlap(동시 발화) 표현용 화자 라벨 목록. 단일 화자면 길이 1,
                동시 발화면 2개 이상, 미배정이면 빈 목록.
    posterior : 화자→확률 (정규화됨, 합=1). UNKNOWN 이면 빈 dict.
    confidence: 이 세그먼트 배정의 신뢰도 [0,1].
    status    : SegmentStatus.
    words     : 선택적 단어 부착(CTM/word attribution).
    """
    start: float
    end: float
    speakers: Tuple[str, ...] = ()
    posterior: Dict[str, float] = field(default_factory=dict)
    confidence: float = 0.0
    status: SegmentStatus = SegmentStatus.UNKNOWN
    words: Tuple[WordToken, ...] = ()

    def __post_init__(self):
        if self.start < 0:
            raise ValueError(f"segment start<0: {self.start}")
        if self.end < self.start:
            raise ValueError(f"segment end<start: {self.end}<{self.start}")

    @property
    def duration(self) -> float:
        return self.end - self.start

    @property
    def is_backchannel(self) -> bool:
        """500ms 미만 = backchannel(맞장구). 파생 속성 — 절대 드롭 근거가 아니라 보존 신호."""
        return self.duration < BACKCHANNEL_MAX_SEC

    @property
    def is_overlap(self) -> bool:
        """동시 발화(다중 화자) 여부."""
        return len(self.speakers) >= 2

    def primary_speaker(self) -> Optional[str]:
        """posterior 최상위 화자 (동률이면 라벨 사전순). 없으면 None."""
        if not self.posterior:
            return None
        return max(sorted(self.posterior), key=lambda s: self.posterior[s])

    def to_dict(self) -> dict:
        return {
            "start": _round_time(self.start),
            "end": _round_time(self.end),
            "speakers": list(self.speakers),
            "posterior": {spk: _round_prob(p)
                          for spk, p in sorted(self.posterior.items())},
            "confidence": _round_prob(self.confidence),
            "status": self.status.value,
            "is_backchannel": self.is_backchannel,
            "is_overlap": self.is_overlap,
            "words": [w.to_dict() for w in self.words],
        }

    @staticmethod
    def from_dict(d: dict) -> "DialogueSegment":
        return DialogueSegment(
            start=float(d["start"]),
            end=float(d["end"]),
            speakers=tuple(d.get("speakers", ())),
            posterior={k: float(v) for k, v in d.get("posterior", {}).items()},
            confidence=float(d.get("confidence", 0.0)),
            status=SegmentStatus(d.get("status", "UNKNOWN")),
            words=tuple(WordToken.from_dict(w) for w in d.get("words", ())),
        )


def make_segment(start: float,
                 end: float,
                 posterior: Optional[Dict[str, float]] = None,
                 confidence: Optional[float] = None,
                 speakers: Optional[Sequence[str]] = None,
                 words: Sequence[WordToken] = (),
                 overlap_min_posterior: float = DEFAULT_OVERLAP_MIN_POSTERIOR,
                 review_below: float = DEFAULT_REVIEW_BELOW,
                 unknown_below: float = DEFAULT_UNKNOWN_BELOW) -> DialogueSegment:
    """정규화·상태판정·overlap 라벨을 일관되게 적용하는 세그먼트 팩토리 (순수).

    - posterior 정규화(합=1).
    - confidence 미지정 시 최상위 posterior 값으로 대입.
    - speakers 미지정 시 posterior 에서 파생: 최상위 화자 + overlap 임계 이상인 화자.
    - status 자동 판정(명시적 speakers 로 강제하지 않음).
    """
    norm = normalize_posterior(posterior or {})

    if confidence is None:
        confidence = max(norm.values()) if norm else 0.0

    if speakers is None:
        if norm:
            top = max(sorted(norm), key=lambda s: norm[s])
            others = sorted(
                (s for s in norm if s != top and norm[s] >= overlap_min_posterior),
                key=lambda s: (-norm[s], s),
            )
            speakers = [top] + others
        else:
            speakers = []

    status = classify_status(confidence, norm, review_below, unknown_below)

    return DialogueSegment(
        start=start,
        end=end,
        speakers=tuple(speakers),
        posterior=norm,
        confidence=confidence,
        status=status,
        words=tuple(words),
    )


def canonical_sort_key(seg: DialogueSegment) -> Tuple[float, float, str]:
    """세그먼트 결정적 정렬 키: (start, end, 최상위 화자 라벨)."""
    return (seg.start, seg.end, seg.primary_speaker() or "")


@dataclass
class CanonicalSidecar:
    """canonical 사이드카 본체 — 오디오 옆에 저장되는 표준 결과 문서.

    speakers : 전역 화자 라벨 목록(정렬됨). segments 에서 파생 가능하지만
               고정 순서·표시명 부여를 위해 명시 보관.
    segments : DialogueSegment 목록 (직렬화 시 canonical 정렬).
    source   : 선택적 출처 메타(파일명·모델 등) — 결정성에 영향 없도록 dict 정렬 직렬화.
    """
    segments: List[DialogueSegment] = field(default_factory=list)
    speakers: List[str] = field(default_factory=list)
    source: Dict[str, str] = field(default_factory=dict)
    schema_version: str = SCHEMA_VERSION

    def sorted_segments(self) -> List[DialogueSegment]:
        return sorted(self.segments, key=canonical_sort_key)

    def all_speakers(self) -> List[str]:
        """segments + 명시 speakers 를 합쳐 정렬된 고유 화자 목록."""
        found = set(self.speakers)
        for seg in self.segments:
            found.update(seg.speakers)
            found.update(seg.posterior.keys())
        return sorted(found)

    # ── 결정적 JSON ──
    def to_dict(self) -> dict:
        return {
            "schema": SCHEMA_ID,
            "schema_version": self.schema_version,
            "speakers": self.all_speakers(),
            "source": {k: self.source[k] for k in sorted(self.source)},
            "segments": [s.to_dict() for s in self.sorted_segments()],
        }

    def to_json(self, indent: Optional[int] = 2) -> str:
        """결정적 JSON 문자열. sort_keys + 고정 소수 → 같은 입력=같은 바이트."""
        return json.dumps(
            self.to_dict(),
            ensure_ascii=False,
            sort_keys=True,
            indent=indent,
            separators=(",", ": ") if indent is not None else (",", ":"),
        )

    @staticmethod
    def from_dict(d: dict) -> "CanonicalSidecar":
        return CanonicalSidecar(
            segments=[DialogueSegment.from_dict(s) for s in d.get("segments", [])],
            speakers=list(d.get("speakers", [])),
            source={str(k): str(v) for k, v in d.get("source", {}).items()},
            schema_version=str(d.get("schema_version", SCHEMA_VERSION)),
        )

    @staticmethod
    def from_json(text: str) -> "CanonicalSidecar":
        return CanonicalSidecar.from_dict(json.loads(text))

    # ── RTTM (NIST rich transcription) ──
    def to_rttm(self, uri: str = "audio") -> str:
        """NIST RTTM 직렬화. overlap 은 같은 구간에 화자별 SPEAKER 라인 다수로 표현.

        필드: SPEAKER <uri> <chan> <tbeg> <tdur> <ortho> <stype> <name> <conf> <slat>
        미배정(빈 speakers)은 라인을 생성하지 않는다(RTTM 은 화자 라인 형식).
        결정적: (start, end, 화자) 정렬.
        """
        lines: List[str] = []
        rows: List[Tuple[float, float, str, float]] = []
        for seg in self.segments:
            for spk in seg.speakers:
                rows.append((seg.start, seg.duration, spk, seg.confidence))
        rows.sort(key=lambda r: (r[0], r[1], r[2]))
        for start, dur, spk, conf in rows:
            lines.append(
                "SPEAKER {uri} 1 {tbeg:.{d}f} {tdur:.{d}f} <NA> <NA> {name} {conf:.{p}f} <NA>".format(
                    uri=uri, tbeg=start, tdur=dur, name=spk, conf=conf,
                    d=TIME_DECIMALS, p=PROB_DECIMALS,
                )
            )
        return "\n".join(lines) + ("\n" if lines else "")

    # ── CTM (word attribution) ──
    def to_ctm(self, uri: str = "audio") -> str:
        """CTM 직렬화 (word attribution). 단어가 있는 세그먼트만.

        필드: <uri> <chan> <tbeg> <tdur> <word> <conf>
        (화자 정보는 확장 컬럼으로 뒤에 붙인다: <speaker>)
        결정적: (start, end, word) 정렬.
        """
        rows: List[Tuple[float, float, str, float, str]] = []
        for seg in self.segments:
            seg_spk = seg.primary_speaker() or "<NA>"
            for w in seg.words:
                rows.append((w.start, w.end, w.text, w.confidence,
                             w.speaker or seg_spk))
        rows.sort(key=lambda r: (r[0], r[1], r[2]))
        lines = [
            "{uri} 1 {tbeg:.{d}f} {tdur:.{d}f} {word} {conf:.{p}f} {spk}".format(
                uri=uri, tbeg=start, tdur=(end - start), word=word, conf=conf, spk=spk,
                d=TIME_DECIMALS, p=PROB_DECIMALS,
            )
            for (start, end, word, conf, spk) in rows
        ]
        return "\n".join(lines) + ("\n" if lines else "")


# ─────────────────────────────────────────────────────────────────────────
# 합성/실측 프레임 타임라인 → 세그먼트 빌더 (순수)
#
# 이것이 conversation_worker.py 의 후속 배선 지점이다. worker 는 100Hz
# `smoothed` 프레임 라벨과 `speaker_scores` posterior 를 갖고 있으므로,
# 그것을 plain list 로 변환해 build_segments_from_frames 에 넘기면 된다.
# (이 모듈은 numpy 에 의존하지 않기 위해 plain list 만 받는다.)
# ─────────────────────────────────────────────────────────────────────────

def build_segments_from_frames(
    frame_labels: Sequence[int],
    frame_rate: float,
    speaker_names: Sequence[str],
    frame_posteriors: Optional[Sequence[Sequence[float]]] = None,
    silence_label: int = -1,
    overlap_min_posterior: float = DEFAULT_OVERLAP_MIN_POSTERIOR,
    review_below: float = DEFAULT_REVIEW_BELOW,
    unknown_below: float = DEFAULT_UNKNOWN_BELOW,
) -> List[DialogueSegment]:
    """프레임 라벨 타임라인을 연속 세그먼트로 묶는다 (순수, numpy 불필요).

    frame_labels      : 프레임별 화자 인덱스(silence_label = 무음, 건너뜀).
    frame_rate        : 프레임/초 (worker 의 PROB_SR=100 에 대응).
    speaker_names     : 인덱스→라벨 (예: ["화자 A", "화자 B"]).
    frame_posteriors  : 선택 — 프레임별 [화자수] 확률. 주어지면 세그먼트 posterior/
                        confidence/overlap 를 프레임 평균으로 산출. 없으면 라벨만으로
                        단일 화자 posterior=1.0 (argmax 동작과 정합).

    ★ 500ms 미만 turn 도 세그먼트로 그대로 보존한다(병합·삭제 없음) —
      backchannel 손실 방지. (worker 의 MIN_TURN_FRAMES 병합은 이 모듈이 아니라
      상류에서 일어나는 별개 단계이며, 여기서는 들어온 라벨을 손실 없이 표준화한다.)
    """
    n = len(frame_labels)
    if n == 0:
        return []
    if frame_rate <= 0:
        raise ValueError(f"frame_rate must be >0: {frame_rate}")

    segments: List[DialogueSegment] = []
    i = 0
    while i < n:
        lbl = frame_labels[i]
        if lbl == silence_label:
            i += 1
            continue
        j = i
        while j < n and frame_labels[j] == lbl:
            j += 1
        start = i / frame_rate
        end = j / frame_rate

        if frame_posteriors is not None:
            # 구간 내 프레임 posterior 평균 → 화자 라벨별 확률.
            ncols = len(speaker_names)
            acc = [0.0] * ncols
            cnt = 0
            for f in range(i, j):
                row = frame_posteriors[f]
                for c in range(min(ncols, len(row))):
                    acc[c] += float(row[c])
                cnt += 1
            mean = [a / cnt for a in acc] if cnt else acc
            posterior = {speaker_names[c]: mean[c] for c in range(ncols)}
            seg = make_segment(
                start, end, posterior=posterior,
                overlap_min_posterior=overlap_min_posterior,
                review_below=review_below, unknown_below=unknown_below,
            )
        else:
            # posterior 없음 → argmax 라벨을 확정 화자로 (posterior=1.0, OK).
            name = speaker_names[lbl] if 0 <= lbl < len(speaker_names) else str(lbl)
            seg = make_segment(
                start, end, posterior={name: 1.0}, confidence=1.0,
                overlap_min_posterior=overlap_min_posterior,
                review_below=review_below, unknown_below=unknown_below,
            )
        segments.append(seg)
        i = j
    return segments


def attach_words(segments: Sequence[DialogueSegment],
                 words: Sequence[WordToken]) -> List[DialogueSegment]:
    """단어를 시간 겹침 기준으로 세그먼트에 부착 (순수, 결정적).

    각 단어를 '중심 시각이 속하는' 세그먼트에 배정한다(경계 애매성 최소화).
    어느 세그먼트에도 안 들어가면 버리지 않고 무시하지 않기 위해, 가장 가까운
    세그먼트에 배정한다. 세그먼트가 없으면 빈 결과.
    반환은 words 가 채워진 새 세그먼트 목록(입력 불변).
    """
    if not segments:
        return []
    ordered = sorted(range(len(segments)), key=lambda k: canonical_sort_key(segments[k]))
    buckets: Dict[int, List[WordToken]] = {k: [] for k in range(len(segments))}

    for w in words:
        center = (w.start + w.end) / 2.0
        # 중심이 포함되는 세그먼트 우선.
        target = None
        for k in ordered:
            s = segments[k]
            if s.start <= center <= s.end:
                target = k
                break
        if target is None:
            # 가장 가까운 세그먼트(경계까지 거리 최소, 동률이면 앞선 것).
            def dist(k: int) -> float:
                s = segments[k]
                if center < s.start:
                    return s.start - center
                if center > s.end:
                    return center - s.end
                return 0.0
            target = min(ordered, key=lambda k: (dist(k), canonical_sort_key(segments[k])))
        buckets[target].append(w)

    out: List[DialogueSegment] = []
    for k in range(len(segments)):
        ws = tuple(sorted(buckets[k], key=lambda x: (x.start, x.end, x.text)))
        out.append(replace(segments[k], words=ws))
    return out


def count_backchannels(segments: Sequence[DialogueSegment]) -> int:
    """보존된 backchannel(<500ms) 개수 — 손실 방지 검증용."""
    return sum(1 for s in segments if s.is_backchannel)
