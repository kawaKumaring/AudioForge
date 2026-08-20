# -*- coding: utf-8 -*-
"""GPT-SoVITS 참조 음성의 Whisper 전사 결과 구조화 + 프롬프트 정책.

설계: reference_audio.py와 같은 패턴 — "전사(사실)"과 "프롬프트 정책(엔진용)"을 분리한다.
  - transcribe_reference(): Whisper 전사 사실만 담는다. Whisper가 준 언어를 문자 비율로 다시
    추정하지 않는다(일본어 한자↔중국어 오판 방지). 예외/빈 결과를 조용히 ""로 삼키지 않고
    status + error_code로 남긴다.
  - build_gpt_prompt(): ReferenceTranscript → GPT-SoVITS용 ReferencePrompt 정책 판정.
    지원 언어(ko/ja/zh/en)만 transcribed, 그 외/실패/빈 결과는 ref_free로 강등하되 구조화된
    warning으로 원인을 남긴다(이번 단계에선 ref-free를 금지하지 않음 — 수동 전사 UI는 2C-2).

의존성: transcribe_worker(_get_whisper_model, run_transcribe)만 사용. 새 패키지 없음.
결과 dataclass는 모두 to_dict()로 json.dumps 가능.
"""
import os
from collections.abc import Mapping
from dataclasses import dataclass, field, asdict
from typing import Optional, List

# transcript status
STATUS_OK = "ok"
STATUS_EMPTY = "empty"
STATUS_FAILED = "failed"

# prompt mode
MODE_TRANSCRIBED = "transcribed"   # 자동 Whisper 전사 사용
MODE_MANUAL = "manual"             # 사용자가 직접 입력/수정한 전사 사용(자동보다 우선)
MODE_REF_FREE = "ref_free"         # 전사 없이 합성

# 안정적 issue code (문자열 메시지 대신 IPC/UI 분기용)
TRANSCRIPTION_FAILED = "TRANSCRIPTION_FAILED"
EMPTY_TRANSCRIPT = "EMPTY_TRANSCRIPT"
LANGUAGE_MISSING = "LANGUAGE_MISSING"
UNSUPPORTED_PROMPT_LANGUAGE = "UNSUPPORTED_PROMPT_LANGUAGE"
REF_FREE_FALLBACK = "REF_FREE_FALLBACK"
REF_FREE_USER = "REF_FREE_USER"    # 사용자가 명시적으로 ref-free 선택

# GPT-SoVITS 프롬프트가 지원하는 언어
GPT_PROMPT_LANGUAGES = ("ko", "ja", "zh", "en")

# 언어 정규화 alias — 최소한만 명시(추측으로 다른 언어를 지정하지 않는다).
_LANG_ALIASES = {
    "zh-cn": "zh", "zh_cn": "zh", "zh-tw": "zh", "zh_tw": "zh", "cmn": "zh", "yue": "zh",
    "jp": "ja", "kr": "ko",
}

_REASON_MSG = {
    TRANSCRIPTION_FAILED: "참조 음성 전사에 실패했습니다.",
    EMPTY_TRANSCRIPT: "참조 음성 전사 결과가 비어 있습니다.",
    LANGUAGE_MISSING: "참조 음성의 언어를 판별하지 못했습니다.",
    UNSUPPORTED_PROMPT_LANGUAGE: "GPT-SoVITS 프롬프트가 지원하지 않는 언어입니다.",
}


def normalize_language(lang) -> Optional[str]:
    """Whisper 언어 코드 정규화. 소문자화 + 최소 alias. unknown/빈 값은 None."""
    if not lang:
        return None
    v = str(lang).strip().lower()
    if not v or v == "unknown":
        return None
    return _LANG_ALIASES.get(v, v)


@dataclass
class ReferenceTranscript:
    source_path: str
    status: str                      # ok | empty | failed
    text: str = ""
    language: Optional[str] = None   # Whisper가 준 언어(정규화). 재추정하지 않음.
    model_name: str = ""
    source: str = "whisper"
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    file_size: Optional[int] = None
    file_mtime_ns: Optional[int] = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class TranscriptIssue:
    code: str
    message: str
    measured: Optional[dict] = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ReferencePrompt:
    mode: str                        # transcribed | manual | ref_free
    prompt_text: str
    prompt_language: Optional[str]
    transcript: Optional[ReferenceTranscript] = None
    warnings: List[TranscriptIssue] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def _stat(path):
    try:
        st = os.stat(path)
        return st.st_size, st.st_mtime_ns
    except OSError:
        return None, None


def transcribe_reference(path: str, model_name: str = "small") -> ReferenceTranscript:
    """참조 음성을 Whisper로 전사한 '사실'을 구조화해 반환. 예외/빈 결과를 삼키지 않는다.
    Whisper가 준 언어를 그대로 정규화해 쓰고, 문자 비율로 재추정하지 않는다."""
    size, mtime = _stat(path)
    # 전사 호출뿐 아니라 '결과 파싱'까지 예외 경계에 포함한다.
    # run_transcribe가 None/비-Mapping을 반환하거나 text/language 타입이 이상해도
    # AttributeError로 터지지 않고 구조화된 실패(TRANSCRIPTION_FAILED)로 강등한다.
    try:
        from transcribe_worker import _get_whisper_model, run_transcribe
        model = _get_whisper_model(model_name)
        result = run_transcribe(model, path, None)
        if not isinstance(result, Mapping):
            raise TypeError(f"전사 결과 타입 이상: {type(result).__name__}")
        raw_text = result.get("text")
        raw_lang = result.get("language")
        if raw_text is not None and not isinstance(raw_text, str):
            raise TypeError(f"text 타입 이상: {type(raw_text).__name__}")
        if raw_lang is not None and not isinstance(raw_lang, str):
            raise TypeError(f"language 타입 이상: {type(raw_lang).__name__}")
    except Exception as e:
        return ReferenceTranscript(
            source_path=path, status=STATUS_FAILED, text="", language=None,
            model_name=model_name, error_code=TRANSCRIPTION_FAILED,
            error_message=str(e)[:300], file_size=size, file_mtime_ns=mtime)

    text = (raw_text or "").strip()
    language = normalize_language(raw_lang)

    if not text:
        return ReferenceTranscript(
            source_path=path, status=STATUS_EMPTY, text="", language=language,
            model_name=model_name, error_code=EMPTY_TRANSCRIPT,
            file_size=size, file_mtime_ns=mtime)

    return ReferenceTranscript(
        source_path=path, status=STATUS_OK, text=text, language=language,
        model_name=model_name, file_size=size, file_mtime_ns=mtime)


def build_gpt_prompt(transcript: ReferenceTranscript, target_language: Optional[str]) -> ReferencePrompt:
    """ReferenceTranscript → GPT-SoVITS용 ReferencePrompt. 지원 언어면 transcribed,
    그 외/실패/빈 결과/언어 없음이면 ref_free로 강등(구조화된 warning + REF_FREE_FALLBACK).
    ref-free는 이번 단계에서 금지하지 않는다(수동 전사 UI는 2C-2). target_language는 목표 텍스트 언어."""
    t = transcript
    reason = None
    if t.status == STATUS_FAILED:
        reason = t.error_code or TRANSCRIPTION_FAILED
    elif t.status == STATUS_EMPTY:
        reason = EMPTY_TRANSCRIPT
    elif t.language is None:
        reason = LANGUAGE_MISSING
    elif t.language not in GPT_PROMPT_LANGUAGES:
        reason = UNSUPPORTED_PROMPT_LANGUAGE

    if reason is None:
        # 전사 성공 + 지원 언어 → Whisper 언어를 그대로 프롬프트 언어로(재추정 없음)
        return ReferencePrompt(MODE_TRANSCRIBED, t.text, t.language, t, [])

    warnings = [
        TranscriptIssue(reason, _REASON_MSG.get(reason, reason), {"language": t.language}),
        TranscriptIssue(REF_FREE_FALLBACK, "참조 전사 없이(ref-free) 합성합니다.",
                        {"prompt_language": target_language}),
    ]
    return ReferencePrompt(MODE_REF_FREE, "", target_language, t, warnings)


def build_manual_prompt(manual_text, prompt_language, target_language) -> ReferencePrompt:
    """사용자가 직접 입력/수정한 전사문으로 프롬프트를 만든다(자동 전사보다 우선).
    manual_text는 비어있지 않아야 한다(호출부에서 strip 후 보장). 언어는 사용자 선택 언어 우선,
    없으면 목표 텍스트 언어. Whisper를 호출하지 않는다."""
    lang = normalize_language(prompt_language) or target_language
    t = ReferenceTranscript(source_path="", status=STATUS_OK, text=manual_text,
                            language=lang, model_name="", source="manual")
    return ReferencePrompt(MODE_MANUAL, manual_text, lang, t, [])


def build_user_ref_free_prompt(target_language, prompt_language=None) -> ReferencePrompt:
    """사용자가 명시적으로 ref-free를 선택한 경우. 구조화된 warning 유지(REF_FREE_USER + REF_FREE_FALLBACK)."""
    lang = normalize_language(prompt_language) or target_language
    warnings = [
        TranscriptIssue(REF_FREE_USER, "사용자가 ref-free를 선택했습니다.", {"prompt_language": lang}),
        TranscriptIssue(REF_FREE_FALLBACK, "참조 전사 없이(ref-free) 합성합니다.", {"prompt_language": lang}),
    ]
    return ReferencePrompt(MODE_REF_FREE, "", lang, None, warnings)
