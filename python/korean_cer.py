# -*- coding: utf-8 -*-
"""한국어 CER(문자 오류율) 계산 코어 — 순수 모듈(모델·오디오·GPU·파일 I/O 없음).

합성된 한국어 음성을 ASR 로 다시 읽어 원문과 비교하는 **회귀 게이트용 측정 도구**다.
이 모듈은 어떤 오디오도 만들지 않고, 어떤 ASR 도 실행하지 않는다. 문자열 두 개
(reference / hypothesis)와 provenance(어느 ASR 이 만든 결과인가)만 받아 수치를 낸다.
따라서 합성(mock) ASR 결과만으로 전부 단위 테스트가 가능하다.

⚠ ⚠ 이 모듈이 측정하는 것은 **내용 보존(content preservation)** 과 **명료도
   (intelligibility) 대리 지표** 다. **자연스러움 점수가 아니다.**
   CER 이 낮다고 해서 합성음이 자연스럽다는 뜻이 아니고, CER 이 높다고 해서 표현이
   나쁘다는 뜻도 아니다. 이 모듈의 어떤 결과 필드·키·함수도 `naturalness`,
   `quality`, `emotion_quality` 또는 그 유사어를 이름으로 쓸 수 없다.
   FORBIDDEN_NAME_TOKENS / FORBIDDEN_NAME_SUBSTRINGS 로 선언하고, 테스트가
   public_result_keys() · public_api_names() 를 스캔해 위반 시 실패시킨다.

측정 대상 밖(이 도구가 측정하지 않는 것):
  * 자연스러움·운율의 좋고 나쁨·화자 유사도·감정 표현의 설득력
  * 오디오 품질(잡음·클리핑·대역), 음량, 타이밍/길이
  * ASR 자체의 정확도 (ASR 오류와 TTS 오류를 분리하지 못한다 — 둘의 합이다)

핵심 설계
  1. **분해된 편집거리.** 비율만이 아니라 substitutions/deletions/insertions/N 을
     모두 노출한다. 비율 하나로는 어떤 종류의 오류인지 알 수 없다.
  2. **선언적·버전된 정규화.** 정규화는 암묵적이면 안 된다. NORMALIZATION_PIPELINE
     으로 단계를 선언하고, normalize() 는 단계별 before/after 추적(trace)을 돌려준다.
     규칙이 바뀌면 NORMALIZATION_VERSION 을 반드시 올린다(지표 드리프트 방지).
  3. **provenance 필수.** ASR 모델명·버전·지문·정규화 버전이 없으면 결과 레코드를
     만들 수 없다(기본값 없음 → 생략 시 TypeError, 빈 값 → ProvenanceError).
  4. **표현 이벤트는 별도 지표.** 감정 태그·운율 문장부호·웃음은 문자 CER 에서
     제거하고, 발생/누락/유령 발생 여부를 자기 자신의 지표로 따로 보고한다.
     웃음을 단어 오류로 세면 표현 기능을 잘못 평가한다.
  5. **결과 레코드는 본문·경로 없음(body-free).** 결과 dict 에는 전사 본문도,
     파일 경로도, 오디오도 담기지 않는다(코드베이스 asr_canonical 사이드카 규약과 동일).
     본문을 보려면 NormalizationResult(검사용 아티팩트)를 쓴다.

granularity 선택은 SYLLABLE_PRIMARY_RATIONALE 를 참고한다(음절 단위가 1차 지표).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from enum import Enum
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Tuple


# ── 스키마/버전 (asr_canonical 규약과 동일한 형태) ──
SCHEMA_ID = "audioforge/korean-cer"
SCHEMA_VERSION = "1.0.0"

# ★ 정규화 규칙이 한 글자라도 바뀌면 반드시 올린다. 이 값이 결과 레코드에 박혀
#   저장되므로, 과거 수치와 현재 수치가 같은 규칙에서 나왔는지 판별할 수 있다.
NORMALIZATION_VERSION = "audioforge/ko-cer-normalization 1.0.0"

# 비율 직렬화 고정 소수 자리 (결정적 출력).
RATE_DECIMALS = 6


# ─────────────────────────────────────────────────────────────────────────
# 예외
# ─────────────────────────────────────────────────────────────────────────

class KoreanCerError(ValueError):
    """이 모듈의 전제가 깨졌을 때 승격하는 기반 예외 — 조용한 기본값 금지."""


class ProvenanceError(KoreanCerError):
    """provenance(모델명·버전·지문·정규화 버전)가 없거나 비었거나 불일치."""


class PoolingError(KoreanCerError):
    """서로 다른 fixture 카테고리를 명시적 승인 없이 합치려 할 때."""


class ForbiddenNameError(KoreanCerError):
    """결과 필드·키·함수 이름이 자연스러움/품질 계열 단어를 쓸 때."""


# ─────────────────────────────────────────────────────────────────────────
# 금지 이름 (자연스러움/품질 계열) — 선언 + 스캐너
#
# CER 은 내용 보존·명료도 대리 지표다. 이름이 `naturalness`/`quality` 가 되면
# 읽는 사람이 즉시 다른 것으로 오해한다. 그래서 이름 자체를 금지하고 테스트로 강제한다.
# ─────────────────────────────────────────────────────────────────────────

# snake_case/CamelCase 를 쪼갠 *토큰* 과 정확히 일치하면 위반.
# (부분 문자열이 아니라 토큰 일치 — "normalization" 의 "mos" 같은 오탐 방지)
FORBIDDEN_NAME_TOKENS = frozenset({
    "naturalness", "natural", "naturally", "naturalness_score",
    "quality", "qualities", "qual",
    "mos", "cmos", "dmos", "nmos",            # mean opinion score 계열
    "opinion", "preference", "rating",
    "expressiveness", "expressivity",
    "pleasantness", "pleasant", "realism", "realistic",
    "humanlike", "humanlikeness", "lifelike",
    "goodness", "beauty", "aesthetic", "aesthetics",
    "fidelity", "listenability",
})

# 이름 전체(소문자)에 이 문자열이 들어가면 위반. 한글/합성어 대응.
FORBIDDEN_NAME_SUBSTRINGS = (
    "naturalness", "emotionquality", "emotion_quality",
    "voicequality", "voice_quality", "audioquality", "audio_quality",
    "speechquality", "speech_quality", "soundquality", "sound_quality",
    "자연스러움", "자연도", "품질", "음질",
)

_NAME_TOKEN_SPLIT = re.compile(r"[^0-9A-Za-z가-힣]+")
_CAMEL_SPLIT = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def _name_tokens(name: str) -> Tuple[str, ...]:
    """이름을 소문자 토큰으로 분해. snake_case · CamelCase · kebab-case 모두 대응."""
    parts: List[str] = []
    for chunk in _NAME_TOKEN_SPLIT.split(str(name)):
        if not chunk:
            continue
        parts.extend(p for p in _CAMEL_SPLIT.split(chunk) if p)
    return tuple(p.lower() for p in parts)


def is_forbidden_name(name: str) -> bool:
    """이름이 자연스러움/품질 계열이면 True (순수 판정 — 예외를 던지지 않는다)."""
    lowered = str(name).lower()
    for sub in FORBIDDEN_NAME_SUBSTRINGS:
        if sub in lowered:
            return True
    return any(tok in FORBIDDEN_NAME_TOKENS for tok in _name_tokens(name))


def scan_forbidden_names(names: Iterable[str]) -> Tuple[str, ...]:
    """위반 이름만 정렬해 반환. 비어 있으면 통과."""
    return tuple(sorted({str(n) for n in names if is_forbidden_name(n)}))


def assert_names_allowed(names: Iterable[str]) -> None:
    """위반이 하나라도 있으면 ForbiddenNameError. 테스트/호출부 공용 가드."""
    bad = scan_forbidden_names(names)
    if bad:
        raise ForbiddenNameError(
            "자연스러움/품질 계열 이름 금지 — CER 은 내용 보존·명료도 대리 지표다. "
            f"위반: {', '.join(bad)}"
        )


# ─────────────────────────────────────────────────────────────────────────
# provenance — 결과 레코드의 필수 동반자
# ─────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class AsrProvenance:
    """이 수치가 *어느 ASR 로 어느 정규화 규칙에서* 나왔는지. 기본값이 없다.

    asr_model_name       : 모델 이름 (예: "whisper-large-v3")
    asr_model_version    : 모델 버전/식별자 (예: "20231117" / "v3.1")
    asr_model_fingerprint: 가중치 지문 (예: "sha256:ab12…") — 같은 이름·버전이라도
                           가중치가 바뀌면 CER 이 움직인다. 그 드리프트를 잡는 값.
    normalization_version: 결과 산출에 쓰인 정규화 파이프라인 버전.

    네 값 모두 비어 있으면 ProvenanceError. 인자를 생략하면 TypeError.
    """
    asr_model_name: str
    asr_model_version: str
    asr_model_fingerprint: str
    normalization_version: str

    _REQUIRED = ("asr_model_name", "asr_model_version",
                 "asr_model_fingerprint", "normalization_version")

    def __post_init__(self):
        for fname in AsrProvenance._REQUIRED:
            value = getattr(self, fname)
            if value is None or not isinstance(value, str) or not value.strip():
                raise ProvenanceError(
                    f"provenance 필드 '{fname}' 는 비어 있을 수 없다 — "
                    "ASR 지문 없는 CER 은 재현·감사 불가(드리프트 무방비)."
                )

    @classmethod
    def for_current_pipeline(cls, asr_model_name: str, asr_model_version: str,
                             asr_model_fingerprint: str) -> "AsrProvenance":
        """현재 NORMALIZATION_VERSION 을 자동으로 각인한 provenance."""
        return cls(asr_model_name=asr_model_name,
                   asr_model_version=asr_model_version,
                   asr_model_fingerprint=asr_model_fingerprint,
                   normalization_version=NORMALIZATION_VERSION)

    def to_dict(self) -> dict:
        return {
            "asr_model_name": self.asr_model_name,
            "asr_model_version": self.asr_model_version,
            "asr_model_fingerprint": self.asr_model_fingerprint,
            "normalization_version": self.normalization_version,
        }


def _require_provenance(provenance: Optional[AsrProvenance]) -> AsrProvenance:
    if provenance is None:
        raise ProvenanceError(
            "provenance 없이 결과 레코드를 만들 수 없다 — "
            "ASR 모델명·버전·지문·정규화 버전은 필수다."
        )
    if not isinstance(provenance, AsrProvenance):
        raise ProvenanceError(
            f"provenance 는 AsrProvenance 여야 한다 — 받은 타입: {type(provenance).__name__}"
        )
    return provenance


# ─────────────────────────────────────────────────────────────────────────
# 표현 이벤트 (감정 태그 · 운율 문장부호 · 웃음)
#
# ★ 계약 경계 주의 ★
#   AudioForge 의 실제 "표현 언어(expressive language) 계약" 은 다른 브랜치
#   (design/tts-expression-contract, feature/expressive-prosody-language)에 있고
#   이 브랜치에서는 볼 수 없다. 따라서 아래 토큰 서술은 **이 모듈이 스스로 소유한
#   최소한의 임시(provisional) 서술** 이다. 평가 도구가 표현 이벤트를 문자 오류로
#   세지 않게 만드는 것이 목적이지, 표현 문법을 정의하는 것이 목적이 아니다.
#   실제 계약과의 정합(reconcile)은 후속 작업이다 — EXPRESSION_TOKEN_SPEC_VERSION
#   의 `-provisional` 접미사가 그 미완결 상태를 표시한다.
# ─────────────────────────────────────────────────────────────────────────

EXPRESSION_TOKEN_SPEC_VERSION = "audioforge/ko-eval-expression-tokens 0.1.0-provisional"


class EventKind(str, Enum):
    """표현 이벤트 종류. 문자 CER 에서 제거되고 자기 지표로 따로 보고된다."""
    EMOTION = "emotion"              # 감정 태그
    LAUGH = "laugh"                  # 웃음 (태그 또는 한글 표기)
    PROSODY_PUNCT = "prosody_punct"  # 운율 문장부호(!, ?, !?, dot-run)


# (kind, 원문 패턴 설명, 정규 토큰, 비고) — 사람이 읽고 검사할 수 있는 선언표.
EXPRESSION_TOKEN_SPEC: Tuple[Tuple[str, str, str, str], ...] = (
    (EventKind.EMOTION.value, "[emotion:<이름>]", "emotion:<이름 소문자>",
     "대괄호 감정 태그. 이름은 ASCII 영문/숫자/밑줄/하이픈."),
    (EventKind.LAUGH.value, "[laugh]", "laugh",
     "명시적 웃음 태그."),
    (EventKind.LAUGH.value, "ㅋ 또는 ㅎ 가 2자 이상 연속", "laugh",
     "한글 표기 웃음(ㅋㅋ, ㅎㅎ, ㅋㅎ…). 1자 단독은 이벤트가 아니다."),
    (EventKind.PROSODY_PUNCT.value, "! 와 ? 의 연속 런", "excl | ques | excl_ques",
     "런 전체가 이벤트 1개. !! 와 ! 는 같은 토큰(excl), !? 와 ?! 는 excl_ques."),
    (EventKind.PROSODY_PUNCT.value, ".. 이상 또는 … 연속", "dots",
     "dot-run(말줄임) 운율 토큰. 마침표 1개는 이벤트가 아니라 일반 문장부호."),
)

# 매칭 순서 = 아래 alternation 순서. 앞선 그룹이 우선한다.
_EVENT_PATTERN = re.compile(
    r"\[emotion:(?P<emotion>[A-Za-z_][A-Za-z0-9_\-]*)\]"
    r"|\[laugh\](?P<laughtag>)"
    r"|(?P<laughrun>[ㅋㅎ]{2,})"
    r"|(?P<dots>\.{2,}|\u2026+)"
    r"|(?P<bang>[!?]+)"
)

# 이벤트 위치를 ref/hyp 사이에서 비교할 때 허용하는 문자 오프셋 오차.
# 이벤트 주변에서 한두 음절이 어긋났다고 "누락 + 유령발생" 으로 뒤집히면
# 이벤트 지표가 문자 오류를 그대로 되받아 세는 꼴이 된다. 그래서 2음절 여유를 둔다.
DEFAULT_EVENT_POSITION_TOLERANCE = 2


@dataclass(frozen=True)
class ExpressionEvent:
    """추출된 표현 이벤트 1개.

    kind     : EventKind
    token    : 정규 토큰(비교 단위). 예 "emotion:joy", "laugh", "excl_ques", "dots"
    position : **정규화 완료 텍스트 기준** 문자 오프셋(이 이벤트 앞에 남은 문자 수).
    raw      : 원문에서 실제로 매치된 리터럴(감사용).
    """
    kind: EventKind
    token: str
    position: int
    raw: str

    def to_dict(self) -> dict:
        return {"kind": self.kind.value, "token": self.token,
                "position": self.position, "raw": self.raw}

    @property
    def key(self) -> Tuple[str, str]:
        """비교 그룹 키 — 같은 종류·같은 토큰끼리만 대응시킨다."""
        return (self.kind.value, self.token)


def _classify_event_match(m: "re.Match") -> Tuple[EventKind, str]:
    if m.group("emotion") is not None:
        return EventKind.EMOTION, "emotion:" + m.group("emotion").lower()
    if m.group("laughtag") is not None or m.group("laughrun") is not None:
        return EventKind.LAUGH, "laugh"
    if m.group("dots") is not None:
        return EventKind.PROSODY_PUNCT, "dots"
    run = m.group("bang")
    has_bang = "!" in run
    has_q = "?" in run
    if has_bang and has_q:
        return EventKind.PROSODY_PUNCT, "excl_ques"
    return EventKind.PROSODY_PUNCT, ("excl" if has_bang else "ques")


def extract_expression_events(text: str) -> Tuple[str, Tuple[ExpressionEvent, ...]]:
    """텍스트에서 표현 이벤트를 **제거하고** 이벤트 목록을 함께 돌려준다.

    반환 (stripped_text, events).
      - stripped_text : 이벤트 리터럴이 빠진 텍스트 (이후 정규화 단계가 계속 적용됨).
      - events        : position 은 *정규화 완료* 텍스트 기준 오프셋.

    position 이 정규화 완료 기준일 수 있는 이유: 이 단계 뒤의 정규화 단계는 모두
    **문자 국소(character-local)** 연산(문자 제거/치환)이라 접두사에 적용한 결과가
    전체에 적용한 결과의 접두사와 같다. 이 불변식은 테스트로 강제한다.
    """
    if text is None:
        text = ""
    if not isinstance(text, str):
        raise KoreanCerError(f"텍스트는 str 이어야 한다 — 받은 타입: {type(text).__name__}")
    events: List[ExpressionEvent] = []
    kept = ""
    cursor = 0
    for m in _EVENT_PATTERN.finditer(text):
        kept += text[cursor:m.start()]
        kind, token = _classify_event_match(m)
        events.append(ExpressionEvent(
            kind=kind, token=token,
            position=len(_finalize_after_events(kept)),
            raw=m.group(0),
        ))
        cursor = m.end()
    kept += text[cursor:]
    return kept, tuple(events)


def _strip_expression_events(text: str) -> str:
    """정규화 파이프라인 단계용 얇은 래퍼 (이벤트는 normalize() 가 따로 수집)."""
    return extract_expression_events(text)[0]


# ─────────────────────────────────────────────────────────────────────────
# 정규화 파이프라인 — 선언적 · 버전됨 · 단계별 추적 가능
#
# 정규화가 암묵적이면 CER 숫자는 해석 불가능해진다("이 3.2% 는 띄어쓰기를 센 건가?").
# 그래서 단계를 자료구조로 선언하고, normalize() 가 단계별 before/after 를 돌려준다.
# 규칙을 바꾸면 NORMALIZATION_VERSION 을 올린다.
# ─────────────────────────────────────────────────────────────────────────

_INVISIBLES = "\u200b\u200c\u200d\u2060\ufeff"


def _step_unicode_nfc(text: str) -> str:
    """Unicode NFC — 분해된 자모(NFD)를 음절로 합성한다.

    ASR/TTS 경로에 따라 같은 "가" 가 U+AC00(합성) 또는 U+1100+U+1161(분해)로 올 수
    있다. 이걸 맞추지 않으면 내용이 같은데 CER 이 100% 로 튄다.
    """
    return unicodedata.normalize("NFC", text)


# Unicode 가 Po(문장부호)로 분류하지만 **발화되는 내용**을 담아 남기는 예외 문자.
# "50%" 와 "50" 은 다른 내용이다 — 이걸 지우면 숫자 fixture 가 진짜 오류를 놓친다.
CONTENT_PUNCTUATION_KEPT = "%‰"


def _step_strip_punctuation(text: str) -> str:
    """Unicode 일반 카테고리 P*(문장부호) 제거. 단 CONTENT_PUNCTUATION_KEPT 는 예외.

    기호 카테고리 S*($, ₩, ℃, °, + 등)는 애초에 P* 가 아니므로 **남는다** — 내용을
    담기 때문이다. %/‰ 는 Unicode 상 Po 지만 같은 이유로 예외 처리한다.
    표현 이벤트(!, ?, dot-run)는 이 단계 전에 이미 이벤트로 빠져나갔다.
    """
    return "".join(ch for ch in text
                   if ch in CONTENT_PUNCTUATION_KEPT
                   or not unicodedata.category(ch).startswith("P"))


def _step_lower_latin(text: str) -> str:
    """대소문자 통일. 한글은 무영향, 한국어 안의 영문(WAV/wav)에만 작용한다.

    한국어 화자에게 대소문자는 발화되지 않는 정보다. 대소문자 차이를 문자 오류로
    세면 영문 fixture 의 CER 이 내용과 무관하게 부풀어 오른다.
    """
    return text.lower()


def _step_remove_whitespace(text: str) -> str:
    """모든 공백과 zero-width 문자 제거.

    한국어 띄어쓰기는 정서법상 흔들리고, ASR 의 띄어쓰기는 내용 오류가 아니다.
    (한국어 STT 벤치마크가 WER 대신 CER 을 쓰는 이유와 같은 이유다.)
    ⚠ 알려진 대가: 영문 단어 경계도 함께 사라진다("open ai" → "openai").
      영문 fixture 는 이 사실을 알고 읽어야 한다.
    """
    return "".join(ch for ch in text
                   if not ch.isspace() and ch not in _INVISIBLES)


@dataclass(frozen=True)
class NormalizationStep:
    """정규화 단계 1개 선언. name 은 결과 추적에 그대로 실린다."""
    name: str
    description: str
    fn: Callable[[str], str]


# ★ 순서가 의미를 가진다 ★
#   1) NFC 를 먼저 해야 이벤트 정규식이 안정적으로 걸린다.
#   2) 이벤트 제거는 문장부호 제거보다 **앞** 이어야 한다 — !, ?, dot-run 자체가
#      문장부호라서, 먼저 지워버리면 표현 이벤트를 영영 볼 수 없다.
#   3) 이벤트 이후 단계는 모두 문자 국소 연산이어야 한다(이벤트 position 불변식).
NORMALIZATION_PIPELINE: Tuple[NormalizationStep, ...] = (
    NormalizationStep(
        "unicode_nfc",
        "Unicode NFC 합성 — 분해 자모를 음절로 통일",
        _step_unicode_nfc),
    NormalizationStep(
        "strip_expression_events",
        "감정 태그·웃음·운율 문장부호를 제거하고 별도 이벤트로 수집",
        _strip_expression_events),
    NormalizationStep(
        "strip_punctuation",
        "Unicode P* 문장부호 제거(기호 S* 및 CONTENT_PUNCTUATION_KEPT 는 유지)",
        _step_strip_punctuation),
    NormalizationStep(
        "lower_latin",
        "대소문자 통일 — 한국어 안의 영문 표기 차이를 오류로 세지 않음",
        _step_lower_latin),
    NormalizationStep(
        "remove_whitespace",
        "모든 공백·zero-width 제거 — 한국어 띄어쓰기는 내용 오류가 아님",
        _step_remove_whitespace),
)

_EVENT_STEP_NAME = "strip_expression_events"
_EVENT_STEP_INDEX = next(i for i, s in enumerate(NORMALIZATION_PIPELINE)
                         if s.name == _EVENT_STEP_NAME)
# 이벤트 제거 이후 단계들 — 이벤트 position 계산에 재사용된다.
_POST_EVENT_STEPS: Tuple[NormalizationStep, ...] = NORMALIZATION_PIPELINE[_EVENT_STEP_INDEX + 1:]


def _finalize_after_events(text: str) -> str:
    """이벤트 제거 이후 단계만 적용. (문자 국소 연산이라 접두사에 그대로 쓸 수 있다.)"""
    for step in _POST_EVENT_STEPS:
        text = step.fn(text)
    return text


def describe_pipeline() -> Tuple[dict, ...]:
    """파이프라인 선언을 사람이 읽을 수 있는 형태로 (검사·문서화용, 순수)."""
    return tuple({"order": i, "name": s.name, "description": s.description}
                 for i, s in enumerate(NORMALIZATION_PIPELINE))


def pipeline_step_names() -> Tuple[str, ...]:
    return tuple(s.name for s in NORMALIZATION_PIPELINE)


@dataclass(frozen=True)
class NormalizationTrace:
    """단계 1개의 before/after. 어떤 단계가 무엇을 바꿨는지 눈으로 확인하는 용도."""
    step_name: str
    before: str
    after: str

    @property
    def changed(self) -> bool:
        return self.before != self.after

    def to_dict(self) -> dict:
        return {"step_name": self.step_name, "before": self.before,
                "after": self.after, "changed": self.changed}


@dataclass(frozen=True)
class NormalizationResult:
    """정규화 **검사용** 아티팩트 — 결과 레코드가 아니다(본문 텍스트를 담는다).

    결과 레코드(CerResult 등)는 body-free 다. 본문을 보고 싶을 때만 이걸 쓴다.
    """
    version: str
    original: str
    text: str
    traces: Tuple[NormalizationTrace, ...]
    events: Tuple[ExpressionEvent, ...]

    def step_names(self) -> Tuple[str, ...]:
        return tuple(t.step_name for t in self.traces)

    def changed_step_names(self) -> Tuple[str, ...]:
        return tuple(t.step_name for t in self.traces if t.changed)

    def to_dict(self) -> dict:
        return {
            "normalization_version": self.version,
            "original": self.original,
            "text": self.text,
            "traces": [t.to_dict() for t in self.traces],
            "events": [e.to_dict() for e in self.events],
        }


def normalize(text: str) -> NormalizationResult:
    """선언된 파이프라인을 순서대로 적용하고 단계별 추적 + 표현 이벤트를 돌려준다."""
    if text is None:
        text = ""
    if not isinstance(text, str):
        raise KoreanCerError(f"텍스트는 str 이어야 한다 — 받은 타입: {type(text).__name__}")
    current = text
    traces: List[NormalizationTrace] = []
    events: Tuple[ExpressionEvent, ...] = ()
    for step in NORMALIZATION_PIPELINE:
        before = current
        if step.name == _EVENT_STEP_NAME:
            current, events = extract_expression_events(before)
        else:
            current = step.fn(before)
        traces.append(NormalizationTrace(step.name, before, current))
    return NormalizationResult(NORMALIZATION_VERSION, text, current,
                               tuple(traces), events)


def normalize_text(text: str) -> str:
    """정규화된 문자열만 필요할 때의 축약 (추적/이벤트는 버린다)."""
    return normalize(text).text


# ─────────────────────────────────────────────────────────────────────────
# 세는 단위: 음절(1차) vs 자모(보조)
# ─────────────────────────────────────────────────────────────────────────

SYLLABLE_PRIMARY_RATIONALE = (
    "1차 지표는 **음절 단위(syllable)** 다. 이유: "
    "(1) 한국어 STT 벤치마크가 보고하는 CER 이 음절 단위라 공개 기준선과 비교 가능하다. "
    "(2) 음절은 한국어 정서법의 표기 단위이고, 독자가 오류로 인지하는 단위다. "
    "(3) 자모 단위로 세면 음절 하나의 오류가 최대 3개 오류로 흩어지고 분모(N)가 "
    "2~3배로 커져 같은 오류가 더 낮은 비율로 보인다 — 지표가 실제보다 좋아 보인다. "
    "(4) NFC 합성 후 음절은 코드포인트 1개라 결정적이다. "
    "자모 단위는 버리지 않고 jamo_jer(Jamo Error Rate) 라는 **다른 이름**으로만 "
    "노출한다. cer 이라는 이름은 음절 단위에만 쓴다 — 두 수치는 절대 섞이면 안 된다."
)


def syllable_units(normalized_text: str) -> Tuple[str, ...]:
    """1차 지표 단위: NFC 음절/문자 1개 = 1단위."""
    return tuple(unicodedata.normalize("NFC", normalized_text))


def jamo_units(normalized_text: str) -> Tuple[str, ...]:
    """보조 지표 단위: NFD 분해 자모 1개 = 1단위 (초/중/종성이 각각 1개)."""
    return tuple(unicodedata.normalize("NFD", normalized_text))


# ─────────────────────────────────────────────────────────────────────────
# 편집거리 분해 (S / D / I / N)
# ─────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class EditCounts:
    """편집거리 분해 결과. total == substitutions + deletions + insertions 불변식."""
    substitutions: int
    deletions: int
    insertions: int
    ref_length: int
    hyp_length: int

    @property
    def total_errors(self) -> int:
        return self.substitutions + self.deletions + self.insertions

    @property
    def error_rate(self) -> Optional[float]:
        """total_errors / N.

        N==0 이면서 hyp 도 비었으면 0.0. N==0 인데 hyp 가 있으면 비율이
        **정의되지 않는다**(0 으로 나눌 수 없다) → None. 조용히 0 이나 inf 로
        속이지 않는다. 코퍼스 단위 집계는 micro-average 로 이 문제를 피한다.
        """
        if self.ref_length == 0:
            return 0.0 if self.hyp_length == 0 else None
        return self.total_errors / self.ref_length

    def to_dict(self) -> dict:
        return {
            "substitutions": self.substitutions,
            "deletions": self.deletions,
            "insertions": self.insertions,
            "ref_length": self.ref_length,
            "hyp_length": self.hyp_length,
            "total_errors": self.total_errors,
        }


def edit_counts(reference_units: Sequence[str],
                hypothesis_units: Sequence[str]) -> EditCounts:
    """Levenshtein 편집거리를 S/D/I 로 **분해해서** 센다 (순수, O(N·M) 시간/O(M) 공간).

    용어(ASR 관례). reference 기준으로
      substitution = 다른 단위로 바뀜, deletion = ref 에 있는데 hyp 에 없음,
      insertion    = ref 에 없는데 hyp 에 생김.

    동률(같은 비용의 경로) tie-break 는 **S > D > I** 로 고정한다 — 결정적 출력.
    """
    ref = list(reference_units)
    hyp = list(hypothesis_units)
    n, m = len(ref), len(hyp)
    # 각 칸 = (cost, S, D, I)
    prev: List[Tuple[int, int, int, int]] = [(j, 0, 0, j) for j in range(m + 1)]
    for i in range(1, n + 1):
        cur: List[Tuple[int, int, int, int]] = [(i, 0, i, 0)] + [(0, 0, 0, 0)] * m
        r = ref[i - 1]
        for j in range(1, m + 1):
            if r == hyp[j - 1]:
                cur[j] = prev[j - 1]            # 일치 — 대각 이동, 비용 0
                continue
            pc, ps, pd, pi = prev[j - 1]        # 치환
            best = (pc + 1, ps + 1, pd, pi)
            dc, ds, dd, di = prev[j]            # 삭제
            if dc + 1 < best[0]:
                best = (dc + 1, ds, dd + 1, di)
            ic, isub, idel, iins = cur[j - 1]   # 삽입
            if ic + 1 < best[0]:
                best = (ic + 1, isub, idel, iins + 1)
            cur[j] = best
        prev = cur
    cost, s, d, i_ = prev[m]
    if cost != s + d + i_:
        raise KoreanCerError(
            "편집거리 분해 불변식 위반: cost={0} != S+D+I={1}".format(cost, s + d + i_))
    return EditCounts(substitutions=s, deletions=d, insertions=i_,
                      ref_length=n, hyp_length=m)


# ─────────────────────────────────────────────────────────────────────────
# 표현 이벤트 지표 (문자 CER 과 **분리된** 지표)
# ─────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ExpressionEventReport:
    """표현 이벤트 대조 결과 — 존재/위치/개수만 본다. 문자 오류로 세지 않는다.

    matched  : 기대 이벤트와 관측 이벤트가 같은 (kind, token) 으로 허용 오차 안에서
               대응된 쌍의 수.
    missing  : 기대했는데 관측되지 않은 이벤트(표현이 사라짐).
    spurious : 기대하지 않았는데 관측된 이벤트(없던 표현이 생김).
    """
    item_id: str
    provenance: AsrProvenance
    token_spec_version: str
    position_tolerance: int
    expected_count: int
    observed_count: int
    matched_count: int
    missing: Tuple[dict, ...]
    spurious: Tuple[dict, ...]
    max_position_delta: Optional[int]
    expected_by_kind: Dict[str, int]
    observed_by_kind: Dict[str, int]

    def __post_init__(self):
        _require_provenance(self.provenance)

    @property
    def missing_count(self) -> int:
        return len(self.missing)

    @property
    def spurious_count(self) -> int:
        return len(self.spurious)

    @property
    def miss_rate(self) -> Optional[float]:
        """누락 / 기대. 기대가 0 이면 정의되지 않음 → None."""
        if self.expected_count == 0:
            return None
        return self.missing_count / self.expected_count

    def to_dict(self) -> dict:
        return {
            "item_id": self.item_id,
            "provenance": self.provenance.to_dict(),
            "token_spec_version": self.token_spec_version,
            "position_tolerance": self.position_tolerance,
            "expected_count": self.expected_count,
            "observed_count": self.observed_count,
            "matched_count": self.matched_count,
            "missing_count": self.missing_count,
            "spurious_count": self.spurious_count,
            "missing": [dict(d) for d in self.missing],
            "spurious": [dict(d) for d in self.spurious],
            "max_position_delta": self.max_position_delta,
            "miss_rate": (None if self.miss_rate is None
                          else round(self.miss_rate, RATE_DECIMALS)),
            "expected_by_kind": dict(sorted(self.expected_by_kind.items())),
            "observed_by_kind": dict(sorted(self.observed_by_kind.items())),
        }


def _count_by_kind(events: Sequence[ExpressionEvent]) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for e in events:
        out[e.kind.value] = out.get(e.kind.value, 0) + 1
    return out


def compare_expression_events(
        item_id: str,
        expected: Sequence[ExpressionEvent],
        observed: Sequence[ExpressionEvent],
        provenance: AsrProvenance,
        position_tolerance: int = DEFAULT_EVENT_POSITION_TOLERANCE,
) -> ExpressionEventReport:
    """기대 이벤트 vs 관측 이벤트를 (kind, token) 그룹별 위치 순 그리디로 대응시킨다.

    같은 종류·같은 토큰끼리만 대응하며, 위치 차가 position_tolerance 를 넘으면
    대응하지 않고 각각 누락/유령으로 남긴다. 결정적(위치 오름차순 2-포인터).
    """
    _require_provenance(provenance)
    if position_tolerance < 0:
        raise KoreanCerError(
            "position_tolerance 는 0 이상이어야 한다 — {0}".format(position_tolerance))

    groups: Dict[Tuple[str, str], Tuple[List[ExpressionEvent], List[ExpressionEvent]]] = {}
    for e in expected:
        groups.setdefault(e.key, ([], []))[0].append(e)
    for e in observed:
        groups.setdefault(e.key, ([], []))[1].append(e)

    matched = 0
    missing: List[ExpressionEvent] = []
    spurious: List[ExpressionEvent] = []
    deltas: List[int] = []

    for key in sorted(groups):
        exp_list = sorted(groups[key][0], key=lambda e: e.position)
        obs_list = sorted(groups[key][1], key=lambda e: e.position)
        i = j = 0
        while i < len(exp_list) and j < len(obs_list):
            delta = obs_list[j].position - exp_list[i].position
            if abs(delta) <= position_tolerance:
                matched += 1
                deltas.append(abs(delta))
                i += 1
                j += 1
            elif delta < 0:
                spurious.append(obs_list[j])   # 관측이 너무 이르다 — 짝이 없다
                j += 1
            else:
                missing.append(exp_list[i])    # 기대가 너무 이르다 — 짝이 없다
                i += 1
        missing.extend(exp_list[i:])
        spurious.extend(obs_list[j:])

    missing.sort(key=lambda e: (e.position, e.kind.value, e.token))
    spurious.sort(key=lambda e: (e.position, e.kind.value, e.token))

    return ExpressionEventReport(
        item_id=item_id,
        provenance=provenance,
        token_spec_version=EXPRESSION_TOKEN_SPEC_VERSION,
        position_tolerance=position_tolerance,
        expected_count=len(expected),
        observed_count=len(observed),
        matched_count=matched,
        missing=tuple(e.to_dict() for e in missing),
        spurious=tuple(e.to_dict() for e in spurious),
        max_position_delta=(max(deltas) if deltas else None),
        expected_by_kind=_count_by_kind(expected),
        observed_by_kind=_count_by_kind(observed),
    )


# ─────────────────────────────────────────────────────────────────────────
# 결과 레코드 (body-free) — provenance 없이는 만들 수 없다
# ─────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class CerResult:
    """항목 1개의 문자 오류 측정 결과.

    ★ body-free ★ 이 레코드에는 원문/전사 본문도, 파일 경로도, 오디오도 없다.
      본문이 필요하면 NormalizationResult(검사용 아티팩트)를 따로 쓴다.

    ★ 이름 규약 ★ 1차 지표는 `syllable_cer`(음절 단위). 보조 지표는
      `jamo_jer`(Jamo Error Rate, 자모 단위)로 **다른 이름**을 쓴다.
      `cer` 이라는 맨 이름은 어디에도 두지 않는다 — 둘이 섞이면 해석이 무너진다.
    """
    item_id: str
    category: str
    provenance: AsrProvenance
    syllable: EditCounts
    jamo: Optional[EditCounts]
    events: Optional[ExpressionEventReport]

    def __post_init__(self):
        _require_provenance(self.provenance)
        if not self.item_id or not str(self.item_id).strip():
            raise KoreanCerError("item_id 는 비어 있을 수 없다 — 결과 추적 불가.")
        if not self.category or not str(self.category).strip():
            raise KoreanCerError(
                "category 는 비어 있을 수 없다 — 카테고리 없는 결과는 조용히 합쳐진다.")

    @property
    def syllable_cer(self) -> Optional[float]:
        """1차 지표: 음절 단위 문자 오류율. 정의 불가면 None."""
        return self.syllable.error_rate

    @property
    def jamo_jer(self) -> Optional[float]:
        """보조 지표: 자모 단위 오류율. CER 과 **다른 수치**다 (이름도 다르다)."""
        return None if self.jamo is None else self.jamo.error_rate

    def to_dict(self) -> dict:
        return {
            "schema": SCHEMA_ID,
            "schema_version": SCHEMA_VERSION,
            "item_id": self.item_id,
            "category": self.category,
            "provenance": self.provenance.to_dict(),
            "primary_metric": "syllable_cer",
            "syllable_counts": self.syllable.to_dict(),
            "syllable_cer": (None if self.syllable_cer is None
                             else round(self.syllable_cer, RATE_DECIMALS)),
            "jamo_counts": (None if self.jamo is None else self.jamo.to_dict()),
            "jamo_jer": (None if self.jamo_jer is None
                         else round(self.jamo_jer, RATE_DECIMALS)),
            "expression_events": (None if self.events is None
                                  else self.events.to_dict()),
        }


def score_item(item_id: str,
               category: str,
               reference: str,
               hypothesis: str,
               provenance: AsrProvenance,
               include_jamo: bool = True,
               event_position_tolerance: int = DEFAULT_EVENT_POSITION_TOLERANCE
               ) -> CerResult:
    """reference(원문)와 hypothesis(ASR 결과) 한 쌍을 측정한다 (순수).

    provenance 는 필수 위치 인자다 — 기본값이 없으므로 생략하면 TypeError.
    provenance.normalization_version 이 현재 NORMALIZATION_VERSION 과 다르면
    ProvenanceError: 낡은 규칙 버전을 새 수치에 각인하는 드리프트를 막는다.

    표현 이벤트(감정 태그·웃음·운율 문장부호)는 정규화 단계에서 문자열에서 빠지고,
    문자 CER 에 전혀 기여하지 않는다. 대신 별도 ExpressionEventReport 로 보고된다.
    """
    _require_provenance(provenance)
    if provenance.normalization_version != NORMALIZATION_VERSION:
        raise ProvenanceError(
            "provenance.normalization_version 이 현재 파이프라인과 다르다 — "
            "기록={0} 현재={1}. 규칙이 다른 수치를 같은 표에 올리면 안 된다.".format(
                provenance.normalization_version, NORMALIZATION_VERSION))

    ref_norm = normalize(reference)
    hyp_norm = normalize(hypothesis)

    syllable = edit_counts(syllable_units(ref_norm.text), syllable_units(hyp_norm.text))
    jamo = (edit_counts(jamo_units(ref_norm.text), jamo_units(hyp_norm.text))
            if include_jamo else None)
    events = compare_expression_events(
        item_id=item_id,
        expected=ref_norm.events,
        observed=hyp_norm.events,
        provenance=provenance,
        position_tolerance=event_position_tolerance,
    )
    return CerResult(item_id=item_id, category=category, provenance=provenance,
                     syllable=syllable, jamo=jamo, events=events)


# ─────────────────────────────────────────────────────────────────────────
# 집계 — 카테고리를 조용히 합치지 않는다
# ─────────────────────────────────────────────────────────────────────────

POOLED_CATEGORY = "__pooled__"


@dataclass(frozen=True)
class CerAggregate:
    """항목 여러 개의 micro-average 집계.

    micro-average = (ΣS + ΣD + ΣI) / ΣN. 항목별 비율의 평균(macro)이 아니다 —
    짧은 문장 하나가 전체를 지배하는 것을 막고, 빈 reference 항목도 안전하게 흡수한다.

    category 는 항상 하나다. 서로 다른 카테고리를 합치려면 pool_aggregates() 를
    명시적 승인 인자와 함께 호출해야 하며, 그 결과의 category 는 POOLED_CATEGORY 이고
    pooled_from 에 원래 카테고리가 남는다 — 합쳐진 수치를 단일 카테고리로 오인할 수 없다.
    """
    label: str
    category: str
    provenance: AsrProvenance
    items: Tuple[CerResult, ...]
    pooled_from: Tuple[str, ...] = ()

    def __post_init__(self):
        _require_provenance(self.provenance)

    @property
    def item_count(self) -> int:
        return len(self.items)

    @property
    def substitutions(self) -> int:
        return sum(r.syllable.substitutions for r in self.items)

    @property
    def deletions(self) -> int:
        return sum(r.syllable.deletions for r in self.items)

    @property
    def insertions(self) -> int:
        return sum(r.syllable.insertions for r in self.items)

    @property
    def ref_length(self) -> int:
        return sum(r.syllable.ref_length for r in self.items)

    @property
    def total_errors(self) -> int:
        return self.substitutions + self.deletions + self.insertions

    @property
    def syllable_cer(self) -> Optional[float]:
        """micro-average 음절 CER. ΣN==0 이면 정의되지 않음 → None."""
        if self.ref_length == 0:
            return None
        return self.total_errors / self.ref_length

    @property
    def event_expected_count(self) -> int:
        return sum(r.events.expected_count for r in self.items if r.events is not None)

    @property
    def event_matched_count(self) -> int:
        return sum(r.events.matched_count for r in self.items if r.events is not None)

    @property
    def event_missing_count(self) -> int:
        return sum(r.events.missing_count for r in self.items if r.events is not None)

    @property
    def event_spurious_count(self) -> int:
        return sum(r.events.spurious_count for r in self.items if r.events is not None)

    def to_dict(self) -> dict:
        return {
            "schema": SCHEMA_ID,
            "schema_version": SCHEMA_VERSION,
            "label": self.label,
            "category": self.category,
            "pooled_from": list(self.pooled_from),
            "provenance": self.provenance.to_dict(),
            "primary_metric": "syllable_cer",
            "aggregation": "micro_average",
            "item_count": self.item_count,
            "substitutions": self.substitutions,
            "deletions": self.deletions,
            "insertions": self.insertions,
            "ref_length": self.ref_length,
            "total_errors": self.total_errors,
            "syllable_cer": (None if self.syllable_cer is None
                             else round(self.syllable_cer, RATE_DECIMALS)),
            "event_expected_count": self.event_expected_count,
            "event_matched_count": self.event_matched_count,
            "event_missing_count": self.event_missing_count,
            "event_spurious_count": self.event_spurious_count,
            "items": [r.to_dict() for r in self.items],
        }


def aggregate_results(label: str,
                      results: Sequence[CerResult],
                      category: Optional[str] = None) -> CerAggregate:
    """같은 카테고리·같은 provenance 의 결과만 집계한다.

    카테고리가 섞이면 PoolingError, provenance 가 섞이면 ProvenanceError.
    (지표 드리프트와 조용한 pooling 은 둘 다 조용히 넘어가면 안 되는 사고다.)
    """
    results = tuple(results)
    if not results:
        raise KoreanCerError(
            "빈 결과는 집계할 수 없다 — provenance 를 유도할 곳이 없다. "
            "최소 1개 CerResult 가 필요하다.")

    categories = sorted({r.category for r in results})
    if len(categories) > 1:
        raise PoolingError(
            "서로 다른 카테고리를 조용히 합칠 수 없다: {0}. "
            "의도적으로 합치려면 pool_aggregates(..., acknowledge_pooling=True) 를 쓴다.".format(
                ", ".join(categories)))
    if category is not None and category != categories[0]:
        raise PoolingError(
            "요청 category={0} 와 결과 category={1} 가 다르다.".format(category, categories[0]))

    provs = {r.provenance for r in results}
    if len(provs) > 1:
        raise ProvenanceError(
            "서로 다른 ASR provenance 의 결과를 한 표에 합칠 수 없다 — "
            "모델/지문/정규화 버전이 다르면 수치가 비교 불가다.")

    return CerAggregate(label=label, category=categories[0],
                        provenance=results[0].provenance, items=results)


def pool_aggregates(label: str,
                    aggregates: Sequence[CerAggregate],
                    acknowledge_pooling: bool = False) -> CerAggregate:
    """카테고리별 집계를 **의도적으로** 하나로 합친다.

    acknowledge_pooling=True 없이는 PoolingError. 기본값이 False 인 이유:
    숫자·영문·고유명사는 실패 방식이 다르다. 하나로 평균 내면 어느 층이 무너졌는지
    사라진다. 합치는 것은 가능하지만 반드시 호출부가 명시적으로 선언해야 한다.
    """
    aggregates = tuple(aggregates)
    if not acknowledge_pooling:
        raise PoolingError(
            "카테고리 pooling 은 기본값이 아니다 — 숫자/영문/고유명사는 실패 양상이 "
            "다르므로 평균 하나로 합치면 진단 정보가 사라진다. "
            "정말 합치려면 acknowledge_pooling=True 를 명시한다.")
    if not aggregates:
        raise KoreanCerError("합칠 집계가 없다.")

    provs = {a.provenance for a in aggregates}
    if len(provs) > 1:
        raise ProvenanceError("서로 다른 ASR provenance 의 집계를 합칠 수 없다.")

    items: List[CerResult] = []
    for a in aggregates:
        items.extend(a.items)
    sources = tuple(sorted({a.category for a in aggregates}))
    return CerAggregate(label=label, category=POOLED_CATEGORY,
                        provenance=aggregates[0].provenance,
                        items=tuple(items), pooled_from=sources)


# ─────────────────────────────────────────────────────────────────────────
# 자기 점검용 introspection — 금지 이름 스캔·위생 검사에 테스트가 쓴다
# ─────────────────────────────────────────────────────────────────────────

# 이름 스캔 전용 가짜 provenance. 측정에 쓰지 않는다.
_INTROSPECTION_PROVENANCE = AsrProvenance.for_current_pipeline(
    asr_model_name="introspection-only",
    asr_model_version="0",
    asr_model_fingerprint="sha256:0",
)


def sample_result_records(provenance: Optional[AsrProvenance] = None) -> Tuple[dict, ...]:
    """이 모듈이 만들어 내는 **결과 레코드**(body-free)의 대표 샘플.

    금지 이름 스캔과 위생(경로·오디오 없음) 테스트가 이걸 훑는다.
    NormalizationResult 는 결과 레코드가 아니라 검사용 아티팩트이므로 포함하지 않는다.
    """
    prov = provenance or _INTROSPECTION_PROVENANCE
    result = score_item("sample-1", "sample_category",
                        "안녕하세요! 김하늘 씨 ㅋㅋ", "안녕하세요 김하늘 씨",
                        prov)
    empty_events = compare_expression_events("sample-2", (), (), prov)
    agg = aggregate_results("sample_category", (result,))
    return (result.to_dict(), empty_events.to_dict(), agg.to_dict())


def _walk_keys(node, out: List[str]) -> None:
    if isinstance(node, dict):
        for k, v in node.items():
            out.append(str(k))
            _walk_keys(v, out)
    elif isinstance(node, (list, tuple)):
        for v in node:
            _walk_keys(v, out)


def public_result_keys() -> Tuple[str, ...]:
    """결과 레코드(+정규화 검사 아티팩트)에 등장하는 모든 키를 중첩까지 훑어 정렬 반환."""
    keys: List[str] = []
    for rec in sample_result_records():
        _walk_keys(rec, keys)
    _walk_keys(normalize("안녕!").to_dict(), keys)
    return tuple(sorted(set(keys)))


_PUBLIC_TYPES = (
    "AsrProvenance", "EditCounts", "ExpressionEvent", "ExpressionEventReport",
    "NormalizationStep", "NormalizationTrace", "NormalizationResult",
    "CerResult", "CerAggregate", "EventKind",
)


def public_api_names() -> Tuple[str, ...]:
    """모듈 공개 이름 + 공개 클래스의 공개 속성 이름 전체 (정렬)."""
    import sys as _sys
    module = _sys.modules[__name__]
    names = [n for n in dir(module) if not n.startswith("_")]
    for type_name in _PUBLIC_TYPES:
        cls = getattr(module, type_name, None)
        if cls is None:
            continue
        names.extend(a for a in dir(cls) if not a.startswith("_"))
    return tuple(sorted(set(names)))
