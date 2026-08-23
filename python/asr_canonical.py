# -*- coding: utf-8 -*-
"""ASR(음성 인식) 후처리 canonical artifact 코어 (순수 모듈, 모델·오디오 의존 없음).

이 모듈은 Whisper 전사 파이프라인의 *결과*를 담는 표준(canonical) 전사 데이터
구조와 직렬화 스키마, SRT 자막 정리(sanitize), 적응형 무음 게이트의 *정책 계산*만
정의한다. torch/numpy/whisper/파일 I/O/네트워크에 의존하지 않는 순수 로직이므로
합성 데이터만으로 단위 테스트가 가능하다.

⚠ 이것은 오디오 ASR(자동 음성 인식) 후처리 데이터 모델이다. 이미지 OCR 과 무관하다.

정의하는 것:
  - WordTiming        : 단어 단위 타임스탬프(Whisper word_timestamps 대응)
  - TranscriptSegment : 전사 구간 1개 (start/end · text · words · confidence ·
                        no_speech_prob · avg_logprob · language · status)
  - CanonicalTranscript: 세그먼트 묶음 + provenance(출처/모델/파라미터) +
                        confidence 사이드카 (전사 결과 문서 본체)
  - SRT sanitizer     : cue 인덱스·시간 형식·길이·겹침·빈 cue 를 정리하는 순수 함수
  - 적응형 무음 게이트 정책: 측정된 RMS 통계로 *권장* 임계만 계산 (실제 오디오 처리·
                        기존 임계 변경 없음)

시간 단위·경계 규약:
  * 모든 시간은 **초(second) 단위 float**, 미디어 시작 기준 **절대 시각**.
  * 구간은 **반개(half-open) [start, end)** 로 취급 (end 는 배타).
  * 불변식: 0 <= start <= end.
  * JSON 직렬화는 3자리(1ms) 반올림, SRT 는 `HH:MM:SS,mmm`(ms 절삭 — 프로덕션
    audio_utils.fmt_srt_time 과 동일 규약).

로그 규약(전사 본문 미노출):
  * 이 모듈은 어떤 경로로도 전사 본문(segment.text / word.text)을 stdout/로그로
    내보내지 않는다. 진행/요약이 필요하면 `log_safe_summary()` — 개수·길이·언어만.

주의(프로덕션 배선 경계):
  * 이 모듈은 transcribe_worker.py 를 수정하지 않는다. 후속 배선은 worker 의
    `result["segments"]`(start/end/text/words/no_speech_prob/avg_logprob)를
    plain dict 로 넘겨 `segments_from_whisper()` 로 표준화하고, SRT 는
    `_save_transcription`(transcribe_worker.py:492-496)의 원시 쓰기를
    `sanitize_srt_cues()`→`render_srt()` 로 교체하는 지점이다(P0 범위 밖).
  * 무음 게이트 정책은 기존 임계(rms_threshold=0.005, keep-floor 0.4,
    hallucination_silence_threshold=2.0)를 *변경하지 않는다*. 여기의 상수는 그
    프로덕션 값의 읽기 전용 미러이며, 정책은 권장값을 [floor, cap] 로만 제안한다.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Dict, List, Optional, Sequence, Tuple


# 스키마 버전 — 직렬화 포맷이 바뀌면 반드시 올린다 (파서 호환성 판별용).
SCHEMA_VERSION = "1.0.0"
SCHEMA_ID = "audioforge/asr-canonical"

# 시간·확률 직렬화 고정 소수 자리 (결정적 출력).
TIME_DECIMALS = 3   # 1ms
PROB_DECIMALS = 6

# confidence 기반 상태 판정 기본 임계 (호출부에서 조정 가능).
DEFAULT_REVIEW_BELOW = 0.55    # 이 미만이면 REVIEW (사람 검토 권장)
DEFAULT_LOW_BELOW = 0.25       # 이 미만이면 LOW_CONFIDENCE

# no_speech_prob 가 이 값 이상이면 환각(무음 위 지어낸 자막) 의심 플래그.
DEFAULT_SUSPECT_NO_SPEECH = 0.6   # whisper no_speech 기본 임계(0.6)와 정합

# avg_logprob 클램프 범위 (exp 변환용). whisper avg_logprob 는 음수.
_LOGPROB_FLOOR = -10.0

# ── SRT cue 정리 기본값 ──
# 자막 가독을 위한 최소/최대 표시 시간(초). 프로덕션 임계가 아니라 sanitizer 정책값.
DEFAULT_MIN_CUE_SEC = 0.3
DEFAULT_MAX_CUE_SEC = 7.0

# ── 적응형 무음 게이트 정책 상수 (transcribe_worker.py 읽기 전용 미러) ──
# ★ 아래 값들은 transcribe_worker.py 의 프로덕션 값을 *복제*한 참조 상수다.
#   이 모듈은 이 값을 바꾸지 않으며, worker 의 상수도 건드리지 않는다.
DEFAULT_RMS_THRESHOLD = 0.005          # _filter_silent_segments(rms_threshold=0.005)
MIN_KEEP_RATIO = 0.4                   # over-delete guard: len(kept) < len(segs)*0.4
HALLUCINATION_SILENCE_SEC = 2.0        # run_transcribe hallucination_silence_threshold
# 적응 상한: 권장 임계가 이 배수(기본값 대비)를 넘지 못하게 막아 실제 발화 과삭제 방지.
DEFAULT_ADAPT_CEIL_MULT = 4.0


class SegmentStatus(str, Enum):
    """전사 세그먼트 상태.

    OK             : 전사 신뢰 가능.
    REVIEW         : 애매 — 사람 검토 권장 (자동 결과는 유지).
    LOW_CONFIDENCE : 신뢰도 낮음 (유지하되 낮은 신뢰 표시).
    EMPTY          : 본문이 비었거나 공백뿐 (타임라인만 존재).
    """
    OK = "OK"
    REVIEW = "REVIEW"
    LOW_CONFIDENCE = "LOW_CONFIDENCE"
    EMPTY = "EMPTY"


def _round_time(v: float) -> float:
    return round(float(v), TIME_DECIMALS)


def _round_prob(v: float) -> float:
    return round(float(v), PROB_DECIMALS)


def _clamp01(v: float) -> float:
    return 0.0 if v < 0.0 else (1.0 if v > 1.0 else v)


def whisper_confidence(avg_logprob: Optional[float],
                       no_speech_prob: Optional[float]) -> float:
    """Whisper 의 avg_logprob·no_speech_prob 로 [0,1] confidence 산출 (순수).

    confidence = exp(avg_logprob) * (1 - no_speech_prob)
      - avg_logprob 는 음수(로그확률) → exp 로 0..1 화, 하한 클램프로 폭주 방지.
      - no_speech_prob 높을수록(무음 위 환각 의심) confidence 를 끌어내린다.
    둘 다 None 이면 0.0(미상 → 낮은 신뢰).
    """
    if avg_logprob is None and no_speech_prob is None:
        return 0.0
    lp = _LOGPROB_FLOOR if avg_logprob is None else max(_LOGPROB_FLOOR, float(avg_logprob))
    p = math.exp(min(0.0, lp))
    ns = 0.0 if no_speech_prob is None else _clamp01(float(no_speech_prob))
    return _clamp01(p * (1.0 - ns))


def classify_status(text: str,
                    confidence: float,
                    review_below: float = DEFAULT_REVIEW_BELOW,
                    low_below: float = DEFAULT_LOW_BELOW) -> SegmentStatus:
    """본문 유무 + confidence 로 상태 판정 (순수 함수).

    본문이 비었거나 공백뿐이면 EMPTY. 아니면 confidence 임계로
    LOW_CONFIDENCE < REVIEW < OK 판정.
    """
    if not text or not text.strip():
        return SegmentStatus.EMPTY
    if confidence < low_below:
        return SegmentStatus.LOW_CONFIDENCE
    if confidence < review_below:
        return SegmentStatus.REVIEW
    return SegmentStatus.OK


@dataclass(frozen=True)
class WordTiming:
    """단어 단위 타임스탬프 (Whisper word_timestamps 대응). 초 단위 절대 시각."""
    text: str
    start: float
    end: float
    probability: float = 1.0

    def __post_init__(self):
        if self.start < 0:
            raise ValueError(f"word start<0: {self.start}")
        if self.end < self.start:
            raise ValueError(f"word end<start: {self.end}<{self.start}")

    @property
    def duration(self) -> float:
        return self.end - self.start

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "start": _round_time(self.start),
            "end": _round_time(self.end),
            "probability": _round_prob(self.probability),
        }

    @staticmethod
    def from_dict(d: dict) -> "WordTiming":
        return WordTiming(
            text=d["text"],
            start=float(d["start"]),
            end=float(d["end"]),
            probability=float(d.get("probability", 1.0)),
        )


@dataclass(frozen=True)
class TranscriptSegment:
    """전사 세그먼트 1개.

    text          : 전사 본문(원문 언어).
    words         : 선택적 단어 타임스탬프. 없을 수도 있음(word_timestamps=False).
    confidence    : [0,1] 신뢰도 (whisper_confidence 로 산출 권장).
    no_speech_prob: Whisper no_speech 확률 (환각 판별 provenance).
    avg_logprob   : Whisper 평균 로그확률 (provenance).
    language      : 세그먼트 언어 코드 (전역과 다를 수 있어 보관).
    status        : SegmentStatus.
    """
    start: float
    end: float
    text: str = ""
    words: Tuple[WordTiming, ...] = ()
    confidence: float = 0.0
    no_speech_prob: Optional[float] = None
    avg_logprob: Optional[float] = None
    language: Optional[str] = None
    status: SegmentStatus = SegmentStatus.EMPTY

    def __post_init__(self):
        if self.start < 0:
            raise ValueError(f"segment start<0: {self.start}")
        if self.end < self.start:
            raise ValueError(f"segment end<start: {self.end}<{self.start}")

    @property
    def duration(self) -> float:
        return self.end - self.start

    @property
    def has_words(self) -> bool:
        return len(self.words) > 0

    @property
    def is_empty(self) -> bool:
        return not self.text or not self.text.strip()

    def to_dict(self) -> dict:
        d = {
            "start": _round_time(self.start),
            "end": _round_time(self.end),
            "text": self.text,
            "confidence": _round_prob(self.confidence),
            "status": self.status.value,
            "has_words": self.has_words,
            "words": [w.to_dict() for w in self.words],
        }
        if self.no_speech_prob is not None:
            d["no_speech_prob"] = _round_prob(self.no_speech_prob)
        if self.avg_logprob is not None:
            d["avg_logprob"] = round(float(self.avg_logprob), PROB_DECIMALS)
        if self.language is not None:
            d["language"] = self.language
        return d

    @staticmethod
    def from_dict(d: dict) -> "TranscriptSegment":
        return TranscriptSegment(
            start=float(d["start"]),
            end=float(d["end"]),
            text=d.get("text", ""),
            words=tuple(WordTiming.from_dict(w) for w in d.get("words", ())),
            confidence=float(d.get("confidence", 0.0)),
            no_speech_prob=(float(d["no_speech_prob"])
                            if d.get("no_speech_prob") is not None else None),
            avg_logprob=(float(d["avg_logprob"])
                         if d.get("avg_logprob") is not None else None),
            language=d.get("language"),
            status=SegmentStatus(d.get("status", "EMPTY")),
        )


def make_segment(start: float,
                 end: float,
                 text: str = "",
                 words: Sequence[WordTiming] = (),
                 no_speech_prob: Optional[float] = None,
                 avg_logprob: Optional[float] = None,
                 confidence: Optional[float] = None,
                 language: Optional[str] = None,
                 review_below: float = DEFAULT_REVIEW_BELOW,
                 low_below: float = DEFAULT_LOW_BELOW) -> TranscriptSegment:
    """confidence 산출·상태 판정을 일관 적용하는 세그먼트 팩토리 (순수).

    confidence 미지정 시 whisper_confidence(avg_logprob, no_speech_prob)로 산출.
    status 는 본문 유무 + confidence 로 자동 판정.
    """
    if confidence is None:
        confidence = whisper_confidence(avg_logprob, no_speech_prob)
    confidence = _clamp01(confidence)
    status = classify_status(text, confidence, review_below, low_below)
    return TranscriptSegment(
        start=start,
        end=end,
        text=text,
        words=tuple(words),
        confidence=confidence,
        no_speech_prob=no_speech_prob,
        avg_logprob=avg_logprob,
        language=language,
        status=status,
    )


def segments_from_whisper(whisper_segments: Sequence[dict],
                          language: Optional[str] = None,
                          review_below: float = DEFAULT_REVIEW_BELOW,
                          low_below: float = DEFAULT_LOW_BELOW) -> List[TranscriptSegment]:
    """Whisper `result["segments"]`(plain dict) → 표준 세그먼트 목록 (순수).

    입력 dict 키: start, end, text, no_speech_prob, avg_logprob, words[{word|text,
    start, end, probability}]. numpy/torch 없이 plain dict 만 받는다 —
    이것이 transcribe_worker.py 후속 배선 지점이다(worker 결과를 그대로 넘김).
    """
    out: List[TranscriptSegment] = []
    for s in whisper_segments:
        words = []
        for w in s.get("words", ()) or ():
            wt = w.get("word", w.get("text", ""))
            words.append(WordTiming(
                text=wt,
                start=float(w["start"]),
                end=float(w["end"]),
                probability=float(w.get("probability", w.get("confidence", 1.0))),
            ))
        out.append(make_segment(
            start=float(s.get("start", 0.0)),
            end=float(s.get("end", 0.0)),
            text=(s.get("text") or "").strip(),
            words=words,
            no_speech_prob=s.get("no_speech_prob"),
            avg_logprob=s.get("avg_logprob"),
            language=s.get("language", language),
            review_below=review_below,
            low_below=low_below,
        ))
    return out


def canonical_sort_key(seg: TranscriptSegment) -> Tuple[float, float]:
    """세그먼트 결정적 정렬 키: (start, end)."""
    return (seg.start, seg.end)


@dataclass
class CanonicalTranscript:
    """canonical 전사 사이드카 본체 — 오디오 옆에 저장되는 표준 결과 문서.

    language   : 전역 감지 언어 코드.
    segments   : TranscriptSegment 목록 (직렬화 시 canonical 정렬).
    provenance : 출처/모델/파라미터 메타 (모델명·task·백엔드·게이트 파라미터 등).
                 confidence 재현·감사(audit)를 위해 보존. dict 정렬 직렬화로 결정성 유지.
    source     : 선택적 파일/도구 메타.
    """
    segments: List[TranscriptSegment] = field(default_factory=list)
    language: Optional[str] = None
    provenance: Dict[str, str] = field(default_factory=dict)
    source: Dict[str, str] = field(default_factory=dict)
    schema_version: str = SCHEMA_VERSION

    def sorted_segments(self) -> List[TranscriptSegment]:
        return sorted(self.segments, key=canonical_sort_key)

    # ── 결정적 JSON ──
    def to_dict(self) -> dict:
        return {
            "schema": SCHEMA_ID,
            "schema_version": self.schema_version,
            "language": self.language,
            "provenance": {k: self.provenance[k] for k in sorted(self.provenance)},
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
    def from_dict(d: dict) -> "CanonicalTranscript":
        return CanonicalTranscript(
            segments=[TranscriptSegment.from_dict(s) for s in d.get("segments", [])],
            language=d.get("language"),
            provenance={str(k): str(v) for k, v in d.get("provenance", {}).items()},
            source={str(k): str(v) for k, v in d.get("source", {}).items()},
            schema_version=str(d.get("schema_version", SCHEMA_VERSION)),
        )

    @staticmethod
    def from_json(text: str) -> "CanonicalTranscript":
        return CanonicalTranscript.from_dict(json.loads(text))

    def to_srt(self,
               min_cue_sec: float = DEFAULT_MIN_CUE_SEC,
               max_cue_sec: float = DEFAULT_MAX_CUE_SEC) -> str:
        """정리된(sanitized) SRT 문자열. 빈 세그먼트 제외·겹침 보정·재번호."""
        cues = [SrtCue(index=0, start=s.start, end=s.end, text=s.text)
                for s in self.sorted_segments()]
        return render_srt(sanitize_srt_cues(cues, min_cue_sec=min_cue_sec,
                                            max_cue_sec=max_cue_sec))


# ─────────────────────────────────────────────────────────────────────────
# SRT sanitizer (순수 함수)
#
# 후속 배선 지점: transcribe_worker.py:492-496 (`_save_transcription` 의
# `if do_srt:` 블록)이 현재 `result["segments"]` 를 정리 없이 그대로 SRT 로
# 쓴다(겹침·역전·0길이·빈 cue 가능). 그 원시 쓰기를 아래 sanitize→render 로
# 교체하면 자막 형식 안전성이 확보된다(P0 범위 밖, 배선 금지).
# ─────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class SrtCue:
    """SRT cue 1개. index 는 정리 후 재부여되므로 입력값은 무시된다."""
    index: int
    start: float
    end: float
    text: str


def format_srt_timestamp(seconds: float) -> str:
    """`HH:MM:SS,mmm`. 총 밀리초를 정수 반올림해 자리수를 유도한다.

    프로덕션 audio_utils.fmt_srt_time 은 `int((seconds%1)*1000)` 로 ms 를 절삭하는데,
    float 비표현(예: 2.3 == 2.2999…)에서 1ms 어긋나는 잠재 버그가 있다. 이 함수는
    round(seconds*1000) 로 정수화해 그 결함을 피하며, 두 결과는 항상 ≤1ms 이내로
    일치한다(형식 호환). 음수는 0 으로 클램프.

    ⚠ SNAPSHOT MIGRATION: canonical(반올림) 과 프로덕션(절삭)은 경계 ms 에서 최대
    1ms 다르다. 이 차이는 이번 P0 에서 임의로 통일하지 않는다 — production 배선
    시점에 어느 규약을 쓸지 최종 선택한다. canonical 반올림으로 전환하면 기존
    절삭 기준으로 만들어진 SRT 스냅샷/골든 파일은 경계 ms 가 어긋날 수 있으므로
    snapshot migration(재생성 또는 ≤1ms 허용 비교)이 필요하다."""
    if seconds < 0:
        seconds = 0.0
    total_ms = int(round(seconds * 1000))
    h, rem = divmod(total_ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def sanitize_srt_cues(cues: Sequence[SrtCue],
                      min_cue_sec: float = DEFAULT_MIN_CUE_SEC,
                      max_cue_sec: float = DEFAULT_MAX_CUE_SEC) -> List[SrtCue]:
    """SRT cue 목록을 안전하게 정리 (순수, 결정적).

    수행:
      1) 본문이 비었거나 공백뿐인 cue 제거.
      2) 시간 정규화: start<0 → 0, end<start → end=start (0길이 방지 위해 아래 3).
      3) 최소/최대 표시 시간 적용: 너무 짧으면 end 를 늘리고, 너무 길면 자른다.
      4) (start,end,text) 로 결정적 정렬.
      5) 겹침(역전) 보정: 이전 cue.end 가 다음 cue.start 를 넘으면 이전 end 를
         다음 start 로 당긴다(단, min_cue_sec 이 깨지면 그대로 둬 손실 방지 —
         내용은 지우지 않는다). 이 단계는 인접쌍만 본다.
      6) 1..N 재번호.

    text 는 앞뒤 공백만 정리하고 내용은 바꾸지 않는다(전사 본문 보존).
    """
    # 1) 빈 cue 제거 + 2~3) 시간 정규화
    cleaned: List[SrtCue] = []
    for c in cues:
        text = (c.text or "").strip()
        if not text:
            continue
        start = max(0.0, float(c.start))
        end = float(c.end)
        if end < start:
            end = start
        dur = end - start
        if dur < min_cue_sec:
            end = start + min_cue_sec
        elif dur > max_cue_sec:
            end = start + max_cue_sec
        cleaned.append(SrtCue(index=0, start=start, end=end, text=text))

    # 4) 결정적 정렬
    cleaned.sort(key=lambda c: (c.start, c.end, c.text))

    # 5) 인접 겹침 보정 (내용 보존 — end 만 당김)
    adjusted: List[SrtCue] = []
    for c in cleaned:
        if adjusted:
            prev = adjusted[-1]
            if prev.end > c.start:
                new_end = c.start
                # min_cue_sec 가 깨지면 당기지 않는다(짧은 발화·backchannel 손실 방지).
                if new_end - prev.start >= min_cue_sec:
                    adjusted[-1] = replace(prev, end=new_end)
        adjusted.append(c)

    # 6) 재번호 + ms(1/1000초) 반올림. SRT 는 ms 해상도뿐이며, 반올림으로
    #    float 오차(예: 2.0+0.3=2.2999…)가 ms 절삭 시 어긋나는 것을 막아
    #    결정적·깨끗한 타임코드를 보장한다.
    return [replace(c, index=i, start=_round_time(c.start), end=_round_time(c.end))
            for i, c in enumerate(adjusted, 1)]


def render_srt(cues: Sequence[SrtCue]) -> str:
    """정리된 cue 목록 → SRT 텍스트 (결정적). 빈 목록이면 빈 문자열."""
    blocks: List[str] = []
    for c in cues:
        blocks.append(
            f"{c.index}\n"
            f"{format_srt_timestamp(c.start)} --> {format_srt_timestamp(c.end)}\n"
            f"{c.text}\n"
        )
    return "\n".join(blocks) + ("\n" if blocks else "")


# ─────────────────────────────────────────────────────────────────────────
# 적응형 무음 게이트 — 정책 계산만 (실제 오디오 처리·기존 임계 변경 없음)
#
# transcribe_worker.py 의 _filter_silent_segments 는 세그먼트별 실제 RMS 를 재서
# rms_threshold(0.005) 미만을 환각으로 버리고, 40% 미만만 남으면(레벨 이상 의심)
# 필터를 건너뛴다. 이 모듈은 그 *숫자 정책*만 순수하게 재현/검증한다 —
# 오디오를 읽지 않고, worker 의 임계 상수를 바꾸지 않는다.
# ─────────────────────────────────────────────────────────────────────────

class LevelClass(str, Enum):
    """RMS 레벨 분류 (게이트 판단 보조)."""
    SILENCE = "SILENCE"   # 임계 미만 — 사실상 무음
    LOW = "LOW"           # 임계 ~ 2배 — 저음량(경계)
    SPEECH = "SPEECH"     # 2배 이상 — 명확한 발화


def classify_level(rms: float, threshold: float = DEFAULT_RMS_THRESHOLD) -> LevelClass:
    """단일 세그먼트 RMS 를 임계 기준으로 분류 (순수)."""
    if rms < threshold:
        return LevelClass.SILENCE
    if rms < threshold * 2.0:
        return LevelClass.LOW
    return LevelClass.SPEECH


def recommend_rms_threshold(noise_rms_samples: Sequence[float],
                            floor: float = DEFAULT_RMS_THRESHOLD,
                            ceil_mult: float = DEFAULT_ADAPT_CEIL_MULT,
                            margin: float = 1.5,
                            percentile: float = 0.5) -> float:
    """측정된 무음/노이즈 RMS 표본으로 *권장* 임계 계산 (순수, 자문용).

    정책:
      - 표본이 없으면 floor(=프로덕션 기본 0.005) 그대로.
      - 노이즈 바닥의 백분위수(기본 중앙값) × margin 을 후보로 삼되,
      - 절대 floor 미만으로 내려가지 않고(기존 민감도 보존),
      - floor × ceil_mult 를 넘지 않는다(실제 발화 과삭제 방지).

    ★ 이 함수는 어떤 프로덕션 상수도 변경하지 않는다. 반환값은 호출부가
      명시적으로 채택할 때만 의미를 갖는 *제안*이다.
    """
    if floor <= 0:
        raise ValueError(f"floor must be >0: {floor}")
    if not noise_rms_samples:
        return floor
    vals = sorted(max(0.0, float(v)) for v in noise_rms_samples)
    p = min(1.0, max(0.0, percentile))
    idx = min(len(vals) - 1, int(round(p * (len(vals) - 1))))
    candidate = vals[idx] * margin
    cap = floor * ceil_mult
    return max(floor, min(cap, candidate))


@dataclass(frozen=True)
class SilenceDecision:
    """무음 게이트 정책 결정 (순수 계산 결과, 오디오 미접근).

    keep         : 세그먼트별 유지 여부.
    guard_tripped: over-delete 가드 발동(너무 많이 지워 원본 유지)했는지.
    threshold    : 적용된 임계.
    kept_count / total_count : 검증용 카운트.
    """
    keep: Tuple[bool, ...]
    guard_tripped: bool
    threshold: float
    kept_count: int
    total_count: int


def apply_silence_policy(rms_values: Sequence[float],
                         threshold: float = DEFAULT_RMS_THRESHOLD,
                         min_keep_ratio: float = MIN_KEEP_RATIO,
                         durations: Optional[Sequence[float]] = None) -> SilenceDecision:
    """세그먼트별 RMS 로 유지/삭제 결정 (순수 — 오디오 안 읽음).

    transcribe_worker._filter_silent_segments 의 숫자 정책을 그대로 재현:
      - **0길이(측정 불가) 세그먼트는 RMS 를 재지 않고 무조건 유지.** 프로덕션
        transcribe_worker.py:107-109 의 `if b <= a: kept.append(s); continue`
        분기와 동일 — 샘플 범위가 비면(0길이) 임계 판정 없이 보존한다.
        canonical 계약이 0길이(end==start)를 유효 입력으로 허용하므로
        (TranscriptSegment.__post_init__ 는 end<start 만 거부),
        이 정책에 도달할 수 있고, 도달 시 동작이 프로덕션과 일치해야 한다.
      - 그 외에는 rms >= threshold 인 세그먼트만 유지.
      - 유지 개수가 total × min_keep_ratio 미만이면(레벨 이상 의심) 전부 유지
        (over-delete 가드) — guard_tripped=True. 0길이 유지분도 프로덕션과 같이
        kept 카운트에 포함된다.

    durations : 선택 — 세그먼트별 길이(초). 주어지면 duration<=0 인 항목을 위
                0길이 규칙으로 무조건 유지하고 rms_values 의 해당 값은 무시한다
                (None 이어도 됨). 미지정이면 모든 항목을 측정 대상으로 본다
                (기존 호출부 호환).
                주: 프로덕션의 b<=a 는 sample-rate 양자화로 sub-sample(0<dur<1/sr)
                까지 포함하나, 그 sr 의존 경계는 오디오 없는 순수 정책의 범위 밖이다
                — 여기서는 명시적 0길이(duration<=0)만 무조건 유지로 다룬다.
    """
    n = len(rms_values)
    if durations is not None and len(durations) != n:
        raise ValueError(
            f"durations length {len(durations)} != rms_values length {n}")
    if n == 0:
        return SilenceDecision(keep=(), guard_tripped=False, threshold=threshold,
                               kept_count=0, total_count=0)

    def _measurable(i: int) -> bool:
        return durations is None or float(durations[i]) > 0.0

    raw_keep = [
        (float(rms_values[i]) >= threshold) if _measurable(i) else True
        for i in range(n)
    ]
    kept = sum(raw_keep)
    if kept < n * min_keep_ratio:
        # 가드 발동: 과삭제로 판단 → 전부 유지(원본 보존).
        return SilenceDecision(keep=tuple([True] * n), guard_tripped=True,
                               threshold=threshold, kept_count=n, total_count=n)
    return SilenceDecision(keep=tuple(raw_keep), guard_tripped=False,
                           threshold=threshold, kept_count=kept, total_count=n)


# ─────────────────────────────────────────────────────────────────────────
# 로그 안전 요약 (전사 본문 절대 미노출)
# ─────────────────────────────────────────────────────────────────────────

def log_safe_summary(transcript: "CanonicalTranscript") -> dict:
    """전사 본문을 노출하지 않는 요약 dict — 진행/감사 로그용.

    개수·총 길이(초)·언어·상태 분포·단어 유무만 담는다. segment.text /
    word.text 는 어떤 경우에도 포함하지 않는다.
    """
    segs = transcript.segments
    status_counts: Dict[str, int] = {}
    words_total = 0
    dur_total = 0.0
    for s in segs:
        status_counts[s.status.value] = status_counts.get(s.status.value, 0) + 1
        words_total += len(s.words)
        dur_total += s.duration
    return {
        "segment_count": len(segs),
        "word_count": words_total,
        "total_duration_sec": _round_time(dur_total),
        "language": transcript.language,
        "status_counts": {k: status_counts[k] for k in sorted(status_counts)},
        "has_provenance": bool(transcript.provenance),
    }
