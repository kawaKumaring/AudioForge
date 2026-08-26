# -*- coding: utf-8 -*-
"""한국어 ASR 재전사 평가 fixture — 카테고리별로 **분리** 보관 (순수, 합성).

실제 음성·모델·GPU·사용자 미디어를 전혀 쓰지 않는다. 각 fixture 는
원문(reference)과 **합성 mock ASR 결과**(hypothesis) 후보들을 문자열로만 들고 있다.
따라서 이 파일만으로 측정 도구(korean_cer)의 동작을 끝까지 검증할 수 있다.

⚠ 이 fixture 로 나오는 수치는 **내용 보존·명료도 대리 지표(CER)** 다.
   자연스러움 점수가 아니다. 여기의 어떤 이름도 naturalness/quality 계열을 쓰지 않는다.

★ 카테고리 분리가 이 파일의 존재 이유다 ★
  숫자 / 한국어 속 영문 / 고유명사는 **실패 방식이 서로 다르다.**
    - 숫자   : "삼십" ↔ "30" 처럼 표기 변환에서 통째로 어긋난다.
    - 영문   : 음차 전사("GPU" ↔ "지피유")로 길이까지 달라진다.
    - 고유명사: 사전에 없는 이름이 비슷한 발음의 흔한 단어로 바뀐다.
  이 셋을 하나의 평균으로 합치면 어느 층이 무너졌는지 사라진다. 그래서 기본값은
  **절대 합치지 않는 것**이다. evaluate_all() 은 카테고리별 집계 dict 를 돌려주고,
  합치려면 korean_cer.pool_aggregates(..., acknowledge_pooling=True) 를 명시해야 한다.

표현 이벤트(감정 태그·웃음·운율 토큰·쉼) probe 는 EXPRESSION_EVENT_PROBES 에 따로 둔다.
그것은 CER 카테고리가 아니며 CATEGORIES 에 포함되지 않는다. probe 의 표기는 전부 실제
표현 언어 계약(expressive_timeline v3) 문법이다 — 이 파일이 토큰을 발명하지 않는다.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import Callable, Dict, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import korean_cer as kc


FIXTURE_SET_VERSION = "audioforge/ko-asr-eval-fixtures 2.0.0"

# ── 카테고리 (CER 로 보고되는 세 층) ──
CATEGORY_NUMBERS = "numbers"
CATEGORY_LATIN = "latin_in_korean"
CATEGORY_PROPER_NOUNS = "proper_nouns"
CATEGORIES: Tuple[str, ...] = (CATEGORY_NUMBERS, CATEGORY_LATIN, CATEGORY_PROPER_NOUNS)

# CER 카테고리가 **아니다** — 표현 이벤트 지표 전용 probe 묶음.
PROBE_GROUP_EXPRESSION_EVENTS = "expression_event_probe"

# 모든 항목이 반드시 갖는 mock 라벨 두 종.
PERFECT_LABEL = "perfect"      # 원문과 동일 → CER 0 이어야 한다
DEGRADED_LABEL = "degraded"    # 그 층의 전형적 실패 → CER > 0 이어야 한다

# 합성 mock provenance. 실제 모델이 아님을 이름으로 못 박는다.
MOCK_ASR_PROVENANCE = kc.AsrProvenance.for_current_pipeline(
    asr_model_name="mock-asr",
    asr_model_version="0.0.0-synthetic",
    asr_model_fingerprint="sha256:synthetic-fixture-not-a-real-model",
)


@dataclass(frozen=True)
class MockHypothesis:
    """합성 ASR 결과 후보 1개. 실제 전사가 아니라 손으로 쓴 시나리오다."""
    label: str
    text: str
    note: str


@dataclass(frozen=True)
class EvalItem:
    """평가 항목 1개 — 원문 + 그 층의 전형적 실패 시나리오들."""
    item_id: str
    category: str
    reference_text: str
    note: str
    hypotheses: Tuple[MockHypothesis, ...]

    def labels(self) -> Tuple[str, ...]:
        return tuple(h.label for h in self.hypotheses)

    def hypothesis(self, label: str) -> MockHypothesis:
        for h in self.hypotheses:
            if h.label == label:
                return h
        raise KeyError(
            "fixture {0} 에 mock 라벨 '{1}' 이 없다 — 있는 라벨: {2}".format(
                self.item_id, label, ", ".join(self.labels())))


def _item(item_id, category, reference_text, note, hypotheses) -> EvalItem:
    return EvalItem(item_id=item_id, category=category,
                    reference_text=reference_text, note=note,
                    hypotheses=tuple(MockHypothesis(*h) for h in hypotheses))


# ─────────────────────────────────────────────────────────────────────────
# 1) 숫자 — 한국어 수사, 아라비아 숫자, 분류사(counter)
# ─────────────────────────────────────────────────────────────────────────

NUMBER_ITEMS: Tuple[EvalItem, ...] = (
    _item("num_sino_amount", CATEGORY_NUMBERS,
          "이만 삼천 오백 원입니다",
          "한자어 수사로 읽은 금액. ASR 이 아라비아 숫자로 되돌리면 통째로 어긋난다.",
          [
              (PERFECT_LABEL, "이만 삼천 오백 원입니다", "완전 일치."),
              (DEGRADED_LABEL, "23500원입니다", "숫자 표기로 축약 — 대량 치환/삭제."),
              ("spacing_only", "이만삼천오백원입니다",
               "띄어쓰기만 다름 — 정규화 규칙상 오류가 아니어야 한다(CER 0)."),
          ]),
    _item("num_native_counter", CATEGORY_NUMBERS,
          "사과 세 개 주세요",
          "고유어 수사 + 분류사(개). 한자어 수사나 숫자로 바뀌기 쉽다.",
          [
              (PERFECT_LABEL, "사과 세 개 주세요", "완전 일치."),
              (DEGRADED_LABEL, "사과 3개 주세요", "고유어 수사가 숫자로."),
              ("native_to_sino", "사과 삼 개 주세요", "고유어 → 한자어 수사 오독."),
          ]),
    _item("num_date_digits", CATEGORY_NUMBERS,
          "2026년 8월 26일",
          "원문이 아라비아 숫자. ASR 이 한글 수사로 풀어 쓰면 길이가 크게 늘어난다.",
          [
              (PERFECT_LABEL, "2026년 8월 26일", "완전 일치."),
              (DEGRADED_LABEL, "이천이십육년 팔월 이십육일", "숫자를 한글 수사로 풀어 씀."),
          ]),
    _item("num_phone_reading", CATEGORY_NUMBERS,
          "공일공 일이삼사 오륙칠팔",
          "전화번호 낭독. 하이픈 표기와 숫자 표기가 뒤섞이는 전형적 지점.",
          [
              (PERFECT_LABEL, "공일공 일이삼사 오륙칠팔", "완전 일치."),
              (DEGRADED_LABEL, "010 1234 5678", "숫자 표기로 되돌림."),
              ("hyphenated_digits", "010-1234-5678",
               "하이픈은 문장부호로 제거되므로 degraded 와 같은 정규화 결과."),
          ]),
    _item("num_time_counter", CATEGORY_NUMBERS,
          "세 시 삼십 분에 만나요",
          "시각 = 고유어(시) + 한자어(분) 혼합. 한국어 수사 규칙의 대표 함정.",
          [
              (PERFECT_LABEL, "세 시 삼십 분에 만나요", "완전 일치."),
              (DEGRADED_LABEL, "3시 30분에 만나요", "둘 다 숫자로."),
          ]),
    _item("num_percent_symbol", CATEGORY_NUMBERS,
          "볼륨을 50 % 로 낮춰 주세요",
          "% 는 Unicode 상 문장부호(Po)지만 발화 내용을 담으므로 정규화 예외로 남는다.",
          [
              (PERFECT_LABEL, "볼륨을 50 % 로 낮춰 주세요", "완전 일치."),
              (DEGRADED_LABEL, "볼륨을 오십 퍼센트로 낮춰 주세요", "숫자+기호를 한글로 풀어 씀."),
          ]),
)


# ─────────────────────────────────────────────────────────────────────────
# 2) 한국어 속 영문(latin script)
# ─────────────────────────────────────────────────────────────────────────

LATIN_ITEMS: Tuple[EvalItem, ...] = (
    _item("latin_brand_name", CATEGORY_LATIN,
          "AudioForge 로 음성을 만들어요",
          "영문 제품명. 음차 전사되면 문자열 자체가 통째로 바뀐다.",
          [
              (PERFECT_LABEL, "AudioForge 로 음성을 만들어요", "완전 일치."),
              (DEGRADED_LABEL, "오디오포지로 음성을 만들어요", "영문 제품명을 한글 음차로."),
              ("case_only", "audioforge 로 음성을 만들어요",
               "대소문자만 다름 — 정규화 규칙상 오류가 아니어야 한다(CER 0)."),
          ]),
    _item("latin_acronym", CATEGORY_LATIN,
          "GPU 메모리가 부족합니다",
          "약어. 글자 수가 3 → 3(지피유)로 우연히 같아도 전부 치환이다.",
          [
              (PERFECT_LABEL, "GPU 메모리가 부족합니다", "완전 일치."),
              (DEGRADED_LABEL, "지피유 메모리가 부족합니다", "약어를 한글 음차로."),
          ]),
    _item("latin_file_format", CATEGORY_LATIN,
          "이 파일은 WAV 포맷입니다",
          "포맷명. 대문자/소문자/음차 세 가지로 갈린다.",
          [
              (PERFECT_LABEL, "이 파일은 WAV 포맷입니다", "완전 일치."),
              (DEGRADED_LABEL, "이 파일은 웨이브 포맷입니다", "포맷명을 한글 음차로."),
              ("case_only", "이 파일은 wav 포맷입니다", "대소문자만 다름 — CER 0."),
          ]),
    _item("latin_inline_word", CATEGORY_LATIN,
          "그럼 start 버튼을 눌러 주세요",
          "문장 중간의 소문자 영단어. 공백 제거 규칙의 대가가 드러나는 지점.",
          [
              (PERFECT_LABEL, "그럼 start 버튼을 눌러 주세요", "완전 일치."),
              (DEGRADED_LABEL, "그럼 스타트 버튼을 눌러 주세요", "영단어를 한글 음차로."),
          ]),
    _item("latin_two_words", CATEGORY_LATIN,
          "open ai 모델을 씁니다",
          "영문 두 단어. remove_whitespace 로 경계가 사라지는 알려진 대가를 드러낸다.",
          [
              (PERFECT_LABEL, "open ai 모델을 씁니다", "완전 일치."),
              (DEGRADED_LABEL, "오픈 에이아이 모델을 씁니다", "영문 두 단어를 한글 음차로."),
              ("joined", "openai 모델을 씁니다",
               "공백만 다름 — 공백 제거 규칙상 CER 0(선언된 대가)."),
          ]),
)


# ─────────────────────────────────────────────────────────────────────────
# 3) 고유명사
# ─────────────────────────────────────────────────────────────────────────

PROPER_NOUN_ITEMS: Tuple[EvalItem, ...] = (
    _item("noun_place_name", CATEGORY_PROPER_NOUNS,
          "서울 성수동 카페에서 만나요",
          "지명 + 외래어 표기. 표준 표기와 관용 표기가 갈린다.",
          [
              (PERFECT_LABEL, "서울 성수동 카페에서 만나요", "완전 일치."),
              (DEGRADED_LABEL, "서울 성수동 까페에서 만나요", "외래어 표기 흔들림(1치환)."),
          ]),
    _item("noun_person_name", CATEGORY_PROPER_NOUNS,
          "김하늘 씨가 도착했어요",
          "인명. 사전에 없어 비슷한 발음의 흔한 음절로 바뀌기 쉽다.",
          [
              (PERFECT_LABEL, "김하늘 씨가 도착했어요", "완전 일치."),
              (DEGRADED_LABEL, "김하날 씨가 도착했어요", "인명 1음절 오인식."),
              ("spacing_only", "김하늘씨가 도착했어요", "띄어쓰기만 다름 — CER 0."),
          ]),
    _item("noun_org_name", CATEGORY_PROPER_NOUNS,
          "위메이드플레이 사옥으로 가 주세요",
          "조직명. 붙여쓰기/띄어쓰기와 어미 추가가 동시에 일어난다.",
          [
              (PERFECT_LABEL, "위메이드플레이 사옥으로 가 주세요", "완전 일치."),
              (DEGRADED_LABEL, "위메이드플레이스 사옥으로 가 주세요", "조직명 끝에 1음절 삽입."),
              ("spacing_split", "위메이드 플레이 사옥으로 가 주세요",
               "띄어쓰기만 다름 — CER 0."),
          ]),
    _item("noun_foreign_person", CATEGORY_PROPER_NOUNS,
          "일론 머스크가 발표했습니다",
          "외국 인명의 한글 표기. 관용 표기가 여러 개다.",
          [
              (PERFECT_LABEL, "일론 머스크가 발표했습니다", "완전 일치."),
              (DEGRADED_LABEL, "일런 머스크가 발표했습니다", "외국 인명 표기 흔들림(1치환)."),
          ]),
    _item("noun_title_work", CATEGORY_PROPER_NOUNS,
          "오징어 게임 시즌 삼을 봤어요",
          "작품명 + 수사. 고유명사와 숫자가 겹치는 경계 사례.",
          [
              (PERFECT_LABEL, "오징어 게임 시즌 삼을 봤어요", "완전 일치."),
              (DEGRADED_LABEL, "오징어 게임 시즌 3을 봤어요", "수사가 숫자로."),
          ]),
)


# 카테고리 → fixture 집합. ★ 이 dict 는 절대 하나로 합쳐지지 않는다 ★
FIXTURE_SETS: Dict[str, Tuple[EvalItem, ...]] = {
    CATEGORY_NUMBERS: NUMBER_ITEMS,
    CATEGORY_LATIN: LATIN_ITEMS,
    CATEGORY_PROPER_NOUNS: PROPER_NOUN_ITEMS,
}


# ─────────────────────────────────────────────────────────────────────────
# 표현 이벤트 probe — CER 카테고리가 아니다
#
# 목적: 표현 언어 계약(expressive_timeline v3)의 토큰이 문자 CER 에 **전혀**
#       기여하지 않으면서 이벤트 지표로는 누락/유령/크기 차이가 잡히는지 확인한다.
#       (웃음을 단어 오류로 세면 표현 기능을 잘못 평가한다.)
#
# ★ 표기는 전부 계약 문법이다 ★ 감정 태그는 [기쁨]·[기쁨|즉시], 웃음은 [ㅋㅋ],
#   쉼은 [쉼 0.5], 운율은 !·?·!?·dot-run·~. 본문에 그냥 쓴 ㅋㅋ 는 계약상 텍스트이므로
#   여기서는 이벤트 표기로 쓰지 않는다.
# ─────────────────────────────────────────────────────────────────────────

EXPRESSION_EVENT_PROBES: Tuple[EvalItem, ...] = (
    _item("probe_laugh_missing", PROBE_GROUP_EXPRESSION_EVENTS,
          "정말 웃겼어요 [ㅋㅋ]",
          "웃음이 사라져도 문자 CER 은 0 이어야 하고, 이벤트 누락 1 이 잡혀야 한다.",
          [
              (PERFECT_LABEL, "정말 웃겼어요 [ㅋㅋ]", "완전 일치 — 이벤트도 일치."),
              (DEGRADED_LABEL, "정말 웃겼어요", "웃음만 사라짐 — CER 0, 이벤트 누락 1."),
              ("spurious_laugh", "정말 웃겼어요 [ㅋㅋ] [ㅋㅋ]",
               "없던 웃음이 하나 더 생김 — 일치 1 + 유령 1, 문자 CER 은 0."),
          ]),
    _item("probe_emotion_tag", PROBE_GROUP_EXPRESSION_EVENTS,
          "[기쁨] 오늘 기분이 좋아요",
          "감정 태그는 문자 CER 에서 제거되고 이벤트로만 평가된다.",
          [
              (PERFECT_LABEL, "[기쁨] 오늘 기분이 좋아요", "완전 일치."),
              (DEGRADED_LABEL, "오늘 기분이 좋아요", "감정 태그 소실 — CER 0, 이벤트 누락 1."),
              ("wrong_emotion", "[슬픔] 오늘 기분이 좋아요",
               "다른 감정 id — 누락 1 + 유령 1, 문자 CER 은 0."),
              ("immediate_mode", "[기쁨|즉시] 오늘 기분이 좋아요",
               "전이 모드는 크기가 아니라 범주적 선택이라 identity 에 포함 — 누락 1 + 유령 1."),
          ]),
    _item("probe_prosody_punct", PROBE_GROUP_EXPRESSION_EVENTS,
          "정말요?! 믿을 수 없어요...",
          "운율 토큰(shock_rise, fade_end)도 문자 CER 에서 빠지고 이벤트로만 평가된다.",
          [
              (PERFECT_LABEL, "정말요?! 믿을 수 없어요...", "완전 일치."),
              (DEGRADED_LABEL, "정말요 믿을 수 없어요", "운율 토큰 2개 소실 — CER 0, 누락 2."),
              ("flattened_punct", "정말요. 믿을 수 없어요.",
               "마침표 1개는 계약상 firm_end — 다른 운율이 생긴 것이라 누락 2 + 유령 2."),
              ("alias_form", "정말요!? 믿을 수 없어요…",
               "'?!' 는 '!?' 의 별칭이고 '…' 는 '...' 과 같은 개수 — 전부 일치해야 한다."),
          ]),
    _item("probe_content_error_with_event", PROBE_GROUP_EXPRESSION_EVENTS,
          "안녕하세요! 반갑습니다",
          "이벤트는 그대로인데 내용만 틀린 경우 — CER > 0, 이벤트 누락/유령 0.",
          [
              (PERFECT_LABEL, "안녕하세요! 반갑습니다", "완전 일치."),
              (DEGRADED_LABEL, "안녕하세요! 반값습니다", "1음절 치환 — 이벤트는 정상 대응."),
          ]),
    _item("probe_magnitude_attenuated", PROBE_GROUP_EXPRESSION_EVENTS,
          "정말 대단해요!!!",
          "표현이 '사라진 것'과 '살아남았지만 약해진 것'을 구분한다 — identity 결정의 핵심.",
          [
              (PERFECT_LABEL, "정말 대단해요!!!", "완전 일치."),
              (DEGRADED_LABEL, "정말 대단해요!",
               "같은 emphasis 가 약해짐 — 일치 1, 누락/유령 0, magnitude_mismatch 1."),
              ("capped_run", "정말 대단해요!!!!!!",
               "계약 상한(BANG_RUN_MAX_COUNT)이 이미 지운 차이 — mismatch 0."),
          ]),
    _item("probe_vowel_extend", PROBE_GROUP_EXPRESSION_EVENTS,
          "안녕하세요~~",
          "'~' 는 계약상 vowel_extend 토큰이지 내용 문자가 아니다.",
          [
              (PERFECT_LABEL, "안녕하세요~~", "완전 일치."),
              (DEGRADED_LABEL, "안녕하세요", "늘임 토큰 소실 — CER 0, 누락 1."),
          ]),
    _item("probe_explicit_pause", PROBE_GROUP_EXPRESSION_EVENTS,
          "잠깐 [쉼 0.5] 생각해 볼게요",
          "명시적 쉼도 본문에서 빠지는 토큰이라 이벤트로 추적한다(길이는 identity 아님).",
          [
              (PERFECT_LABEL, "잠깐 [쉼 0.5] 생각해 볼게요", "완전 일치."),
              (DEGRADED_LABEL, "잠깐 생각해 볼게요", "쉼 소실 — CER 0, 누락 1."),
              ("longer_pause", "잠깐 [쉼 2.0] 생각해 볼게요",
               "길이만 다름 — 일치 1, magnitude_mismatch 1."),
          ]),
    _item("probe_contract_parse_failure", PROBE_GROUP_EXPRESSION_EVENTS,
          "안녕하세요 반갑습니다",
          "계약이 모르는 대괄호 태그 — 이벤트 지표는 신뢰 불가로 표시되고 CER 은 계속 계산된다.",
          [
              (PERFECT_LABEL, "안녕하세요 반갑습니다", "완전 일치, 이벤트 0."),
              (DEGRADED_LABEL, "[웃음] 안녕하세요 반갑습니다",
               "UNKNOWN_EXPRESSIVE_TAG — contract_ok=False 가 레코드에 남는다."),
          ]),
)


# ─────────────────────────────────────────────────────────────────────────
# 조회 · 검증 · 평가
# ─────────────────────────────────────────────────────────────────────────

def items_for(category: str) -> Tuple[EvalItem, ...]:
    """카테고리 하나의 fixture 만 돌려준다. 전체를 한 덩어리로 주는 API 는 없다."""
    if category not in FIXTURE_SETS:
        raise KeyError(
            "알 수 없는 카테고리 '{0}' — 사용 가능: {1}".format(
                category, ", ".join(CATEGORIES)))
    return FIXTURE_SETS[category]


def validate_fixtures() -> None:
    """fixture 자체의 불변식 검사 (테스트가 호출한다).

    - 세 카테고리가 모두 비어 있지 않다.
    - 각 항목의 category 필드가 소속 집합과 일치한다.
    - item_id 는 probe 를 포함해 전역 고유하다.
    - 모든 항목이 PERFECT_LABEL 과 DEGRADED_LABEL 을 갖는다.
    - PERFECT 는 원문과 글자까지 같고, DEGRADED 는 원문과 다르다.
    """
    seen = set()
    groups = list(FIXTURE_SETS.items()) + [(PROBE_GROUP_EXPRESSION_EVENTS,
                                            EXPRESSION_EVENT_PROBES)]
    for group_name, items in groups:
        if not items:
            raise kc.KoreanCerError("fixture 집합 '{0}' 이 비었다.".format(group_name))
        for it in items:
            if it.category != group_name:
                raise kc.KoreanCerError(
                    "{0} 의 category 필드가 집합과 다르다: {1} != {2}".format(
                        it.item_id, it.category, group_name))
            if it.item_id in seen:
                raise kc.KoreanCerError("item_id 중복: {0}".format(it.item_id))
            seen.add(it.item_id)
            labels = it.labels()
            for required in (PERFECT_LABEL, DEGRADED_LABEL):
                if required not in labels:
                    raise kc.KoreanCerError(
                        "{0} 에 필수 mock 라벨 '{1}' 이 없다.".format(it.item_id, required))
            if it.hypothesis(PERFECT_LABEL).text != it.reference_text:
                raise kc.KoreanCerError(
                    "{0} 의 perfect mock 이 원문과 다르다.".format(it.item_id))
            if it.hypothesis(DEGRADED_LABEL).text == it.reference_text:
                raise kc.KoreanCerError(
                    "{0} 의 degraded mock 이 원문과 같다 — 실패 시나리오가 아니다.".format(
                        it.item_id))


def mock_asr(label: str = DEGRADED_LABEL) -> Callable[[EvalItem], str]:
    """라벨 하나를 고르는 합성 ASR 대역(stand-in)을 만든다.

    실제 ASR 을 흉내 내지 않는다 — fixture 가 미리 적어 둔 문자열을 되돌려 줄 뿐이다.
    라벨이 없는 항목을 만나면 조용히 대체하지 않고 KeyError 를 낸다.
    """
    def _fn(item: EvalItem) -> str:
        return item.hypothesis(label).text
    return _fn


def evaluate_category(category: str,
                      hypothesis_fn: Callable[[EvalItem], str],
                      provenance: kc.AsrProvenance,
                      event_position_tolerance: int = kc.DEFAULT_EVENT_POSITION_TOLERANCE
                      ) -> kc.CerAggregate:
    """카테고리 **하나**를 평가해 그 카테고리만의 집계를 돌려준다.

    hypothesis_fn(item) -> str 로 합성 ASR 결과를 받는다(실제 ASR 도 여기에 꽂을 수
    있지만, 이 브랜치에서는 mock 만 쓴다). provenance 는 필수다.
    """
    items = items_for(category)
    results = [
        kc.score_item(
            item_id=it.item_id,
            category=it.category,
            reference=it.reference_text,
            hypothesis=hypothesis_fn(it),
            provenance=provenance,
            event_position_tolerance=event_position_tolerance,
        )
        for it in items
    ]
    return kc.aggregate_results(label=category, results=results, category=category)


def evaluate_all(hypothesis_fn: Callable[[EvalItem], str],
                 provenance: kc.AsrProvenance,
                 event_position_tolerance: int = kc.DEFAULT_EVENT_POSITION_TOLERANCE
                 ) -> Dict[str, kc.CerAggregate]:
    """세 카테고리를 각각 평가한다. ★ 합계·평균을 만들지 않는다 ★

    반환은 카테고리별 집계 dict 다. 단일 대표 숫자는 일부러 제공하지 않는다 —
    필요하면 호출부가 korean_cer.pool_aggregates(..., acknowledge_pooling=True) 로
    자기 이름을 걸고 합쳐야 한다.
    """
    return {c: evaluate_category(c, hypothesis_fn, provenance,
                                 event_position_tolerance)
            for c in CATEGORIES}


def evaluate_expression_probes(hypothesis_fn: Callable[[EvalItem], str],
                               provenance: kc.AsrProvenance,
                               event_position_tolerance: int = kc.DEFAULT_EVENT_POSITION_TOLERANCE
                               ) -> Tuple[kc.CerResult, ...]:
    """표현 이벤트 probe 결과 — CER 카테고리 집계와 섞지 않기 위해 tuple 로만 돌려준다."""
    return tuple(
        kc.score_item(
            item_id=it.item_id,
            category=it.category,
            reference=it.reference_text,
            hypothesis=hypothesis_fn(it),
            provenance=provenance,
            event_position_tolerance=event_position_tolerance,
        )
        for it in EXPRESSION_EVENT_PROBES
    )
