# -*- coding: utf-8 -*-
"""숫자 서수 읽기 보정 — 화면 쪽 src/shared/spokenOrdinals.ts 의 파이썬 짝(2026-10-09).

규칙·근거·토큰 경계는 TS 쪽 머리말이 원본이다. 두 쪽은 src/shared/spokenOrdinals.cases.json 한 벌로 검사한다.
요지: 1~99 의 '숫자+번째'만 고유어 관형형("일곱 번째")으로. 원문은 그대로 두고 소리로 보낼 글만 만든다.
기호 정리(speech_symbols) **전에** 원문에서 경계를 본다. stdlib only.
"""
import re

ORDINAL_RULE = "ordinal-ko-v1"

_UNIT_ALONE = ["", "첫", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉"]
_UNIT_IN = ["", "한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉"]
_TENS = ["", "열", "스물", "서른", "마흔", "쉰", "예순", "일흔", "여든", "아흔"]

_BLOCK_BEFORE = set(".,:'’-‐‑‒–—―−~～〜+±/#_%$₩€£¥@&*^=")
_RANGE_SIGN = set("-‐‑‒–—―−~～〜+±")
_TOKEN = re.compile(r"[0-9]+")


def ordinal_word(n):
    """1~99 → 서수 관형형. 범위 밖은 None."""
    if not isinstance(n, int) or n < 1 or n > 99:
        return None
    t, u = divmod(n, 10)
    if t == 0:
        return _UNIT_ALONE[u]
    if n == 20:
        return "스무"
    return _TENS[t] + _UNIT_IN[u]


def _letter_or_digit(ch):
    # TS 의 /[\p{L}\p{N}]/u 와 같게 — 유니코드 글자·숫자(밑줄은 아님).
    return ch.isalnum()


def find_ordinals(text):
    """원문에서 바꿀 서수 자리 [{start, end, original, spoken}] (원문 좌표)."""
    out = []
    for m in _TOKEN.finditer(text or ""):
        digits, start = m.group(0), m.start()
        if len(digits) > 2 or digits[0] == "0":
            continue
        before = text[start - 1] if start > 0 else ""
        if before and (_letter_or_digit(before) or before in _BLOCK_BEFORE):
            continue
        k = start - 1
        while k >= 0 and text[k] in " \t":
            k -= 1
        if 0 <= k < start - 1 and text[k] in _RANGE_SIGN:
            continue
        j = start + len(digits)
        if j < len(text) and text[j] == " ":
            j += 1
        if text[j:j + 2] != "번째":
            continue
        word = ordinal_word(int(digits))
        if not word:
            continue
        out.append({"start": start, "end": j + 2, "original": text[start:j + 2], "spoken": word + " 번째"})
    return out


def apply_ordinals(text, start, end, changes):
    """[start, end) 안에 통째로 든 자리만 바꾼다. 반환 (글, 바꾼 수)."""
    s, at, applied = "", start, 0
    for c in changes:
        if c["start"] < start or c["end"] > end:
            continue
        s += text[at:c["start"]] + c["spoken"]
        at = c["end"]
        applied += 1
    return s + text[at:end], applied


def spoken_ordinals(text):
    """글 전체 → (소리로 보낼 글, 바꾼 자리 목록)."""
    text = text or ""
    changes = find_ordinals(text)
    return apply_ordinals(text, 0, len(text), changes)[0], changes
