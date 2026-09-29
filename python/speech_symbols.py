"""소리로 내지 않는 기호 — `src/shared/speechSymbols.ts` 의 파이썬 짝.

★규칙과 이유는 그쪽 설명이 원본이다. 두 쪽이 같은 답을 내는지는 `src/shared/speechSymbols.cases.json`
  한 벌로 둘 다 검사한다(`python/test_speech_symbols.py` · `speechSymbols.test.ts`). 하나만 고치면 울린다.

★쓰는 자리: 기본 목소리(문장 단위 엔진)로 소리를 만들기 **바로 앞**(`tts_worker`).
  파서가 낸 글(spoken_text)은 바꾸지 않는다 — 실행 기록·지문 대조가 그 글을 기준으로 삼는다.
"""
import re

_SILENT = re.compile(r'["“”„‟«»‹›「」『』〈〉《》【】〔〕\[\]{}<>*＊_＿`´^|\\/＼#＃@=＝+＋♡♥☆★◆◇■□●○◎▲△▼▽※→←↑↓↔♪♬♩♫]')
_LONE_QUOTE = re.compile(r"(?<![A-Za-z])['‘’‚‛]|['‘’‚‛](?![A-Za-z])")
_RANGE_TILDE = re.compile(r"(\d)\s*[~～〜]\s*(\d)")
_TILDE = re.compile(r"[~～〜]")
_DOTS = re.compile(r"[.…](?:[ \t]*[.…])+")
_BANG_QUESTION = re.compile(r"([!?！？])[!?！？ \t]*[!?！？]")
_COMMAS = re.compile(r"([,，;:])(?:[ \t]*[,，;:])+")
# 글자·숫자 = [^\W_] (파이썬의 \w 에서 밑줄을 뺀 것)
_DASH_CH = "-‐‑‒–—―─━"
_DASH = re.compile(r"(?<![^\W_])[%s]+|[%s]+(?![^\W_])|[%s]{2,}" % (_DASH_CH, _DASH_CH, _DASH_CH))
_PAREN_RUN = re.compile(r"[(（]{2,}|[)）]{2,}|[(（]\s*[)）]")
_EMPTY_PAREN = re.compile(r"[(（]\s*[)）]")
_LETTER = re.compile(r"[^\W_]")


def _tidy(s):
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"[ \t]+([.,!?…;:)）])", r"\1", s)
    s = re.sub(r"([(（])[ \t]+", r"\1", s)
    return "\n".join(l.strip() for l in s.split("\n")).strip()


def strip_spoken_symbols(text):
    """소리로 보낼 글. 읽을 글자가 남지 않으면 빈 글 — 부르는 쪽이 소리 없이 건너뛴다."""
    s = _RANGE_TILDE.sub(r"\1에서 \2", text or "")
    s = _TILDE.sub(" ", s)
    s = _PAREN_RUN.sub(" ", s)
    s = _SILENT.sub(" ", s)
    s = _LONE_QUOTE.sub(" ", s)
    s = _DASH.sub(" ", s)
    s = _DOTS.sub("…", s)
    s = _BANG_QUESTION.sub(r"\1", s)
    s = _COMMAS.sub(r"\1", s)
    s = _EMPTY_PAREN.sub(" ", s)
    s = _tidy(s)
    return s if _LETTER.search(s) else ""
