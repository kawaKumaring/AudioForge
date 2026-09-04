"""다국어 token-aware 자동 분할(계약 B) — 한 줄을 동적 상한 이내 chunk로 나눈다.

목적: 생성 안전 상한(ABS=256)에 맞춰 각 chunk의 production token 수가 max_tokens(=generation_limit.
max_segment_tokens()=33) 이하가 되도록 분할. 정상 긴 문장을 clamp로 잘라내지 않고, 의미 단위로 나눈다.

원칙:
  - 내용 불변: 모든 분할은 '원문 슬라이스'만 사용 → "".join(chunks) == 원문(공백·구두점 포함) 정확히 보존.
    (합성 시 chunk를 순서대로 이어붙이면 원문과 동일한 내용.)
  - 우선순위: 문장 종결부호 → 절 구분(쉼표류) → 공백 → 문자 경계(최후). 각 단계에서 greedy로 최대한 크게 묶되
    max_tokens 초과 시 다음 단계로 정련.
  - token 수는 주입된 count_tokens(text)로 측정(bridge의 실제 _build_assistant_text+processor). 순수 로직은
    이 콜백에만 의존 → 모델 없이 테스트 가능.
  - 무한 재분할 방지: 단계는 유한(문자 단계가 최후). 문자 하나로도 max_tokens 초과면(래퍼 자체가 큼 등 병리적)
    SegmentTooLong 발생.
  - 빈 chunk 금지: 결과에 공백만인 chunk 없음(단, 원문 보존 위해 chunk 경계의 공백은 인접 chunk에 붙어 있을 수 있음).
  - 원문·전사 전문은 로그/오류에 넣지 않는다(호출부 책임). 여기서는 예외에 길이/토큰 수만.
"""

SENTENCE_ENDERS = set(".!?。！？…！？")
CLAUSE_DELIMS = set(",、;；:：·")
CLOSERS = set("\"'”’」』）)]】》〉 \t")


class SegmentTooLong(Exception):
    """더는 의미 단위로 나눌 수 없는데도 max_tokens를 초과 — TEXT_SEGMENT_TOO_LONG 사유(내용 미포함)."""

    def __init__(self, prod_tokens, max_tokens):
        self.prod_tokens = prod_tokens
        self.max_tokens = max_tokens
        super().__init__(f"segment token {prod_tokens} > max {max_tokens} and no further split")


def _cut_after(s, marks, eat_closers=False):
    """marks 문자 run 뒤(선택적으로 뒤따르는 closer/공백까지)에서 자른 substring 리스트. join == s."""
    out = []
    start = 0
    i = 0
    n = len(s)
    while i < n:
        if s[i] in marks:
            j = i + 1
            while j < n and s[j] in marks:
                j += 1
            if eat_closers:
                while j < n and s[j] in CLOSERS:
                    j += 1
            out.append(s[start:j])
            start = j
            i = j
        else:
            i += 1
    if start < n:
        out.append(s[start:])
    return out


def _cut_whitespace(s):
    """공백 run 뒤에서 자름. join == s."""
    out = []
    start = 0
    i = 0
    n = len(s)
    while i < n:
        if s[i] in " \t　":
            j = i + 1
            while j < n and s[j] in " \t　":
                j += 1
            out.append(s[start:j])
            start = j
            i = j
        else:
            i += 1
    if start < n:
        out.append(s[start:])
    return out


def _level_split(s, level):
    """레벨별 원문 슬라이스 분할(join == s). 0:문장 1:절 2:공백 3:문자."""
    if level == 0:
        return _cut_after(s, SENTENCE_ENDERS, eat_closers=True)
    if level == 1:
        return _cut_after(s, CLAUSE_DELIMS, eat_closers=False)
    if level == 2:
        return _cut_whitespace(s)
    return list(s)  # 문자 경계(최후). 코드포인트 단위(BMP 밖은 파이썬 str이 코드포인트라 안전).


NUM_LEVELS = 4


# 안전 목표(soft_max)가 뜻을 갖는 레벨 — 문장(0)·절(1) 경계에서만 미리 끊는다. 공백·문자 레벨에서는
# 의미 경계가 아니므로 hard max 까지 채운다(단어 한가운데를 소프트 목표 때문에 자르지 않는다).
SOFT_BOUNDARY_LEVELS = (0, 1)


def _refine(s, level, count_tokens, max_tokens, soft_max=None):
    """s(단일 조각, count>max)를 level부터 정련해 max 이하 chunk 리스트로. join == s."""
    if level >= NUM_LEVELS:
        raise SegmentTooLong(count_tokens(s), max_tokens)
    pieces = _level_split(s, level)
    if len(pieces) <= 1:
        return _refine(s, level + 1, count_tokens, max_tokens, soft_max)  # 이 레벨로 못 나눔 → 다음 레벨
    return _greedy(pieces, level, count_tokens, max_tokens, soft_max)


def _greedy(pieces, level, count_tokens, max_tokens, soft_max=None):
    """인접 조각을 greedy로 병합(원문 인접 슬라이스라 "".join으로 정확 보존). 단일 조각이 크면 다음 레벨로 정련.

    soft_max: 문장·절 레벨에서 병합이 이 값을 넘기려 하면 그 경계에서 끊는다(hard max 까지 채우지 않는다).
    상한 직전까지 채우는 것이 EOS 미종료 폭주에 가장 오래 노출되는 길이었다(실측: 상한 실패 4건)."""
    chunks = []
    cur = ""
    soft_here = soft_max if (soft_max is not None and level in SOFT_BOUNDARY_LEVELS) else None
    for p in pieces:
        cand = cur + p
        n_cand = count_tokens(cand)
        if n_cand <= max_tokens and not (soft_here is not None and cur and n_cand > soft_here):
            cur = cand
            continue
        if cur:
            chunks.append(cur)
            cur = ""
        if count_tokens(p) <= max_tokens:
            cur = p
        else:
            chunks.extend(_refine(p, level + 1, count_tokens, max_tokens, soft_max))
    if cur:
        chunks.append(cur)
    return chunks


def split_for_generation(text, count_tokens, max_tokens, soft_max=None):
    """text를 각 chunk의 count_tokens <= max_tokens 이도록 분할. 반환: chunk 리스트("".join == text).

    count_tokens: str -> int (production token 수, 예: qwen_bridge._prod_tokens 부분적용).
    max_tokens: int > 0 — hard 상한(chunk_budget.max_production_tokens). 넘는 chunk 는 없다.
    soft_max: 선택. 안전 목표(chunk_budget.safe_production_tokens). 이 값을 넘기는 병합은 문장·절 경계에서
      미리 끊는다. 경계가 없으면 hard 상한까지 간다(단어 한가운데를 소프트 목표로 자르지 않는다).
    분할 불가(문자 단위로도 초과) → SegmentTooLong.
    """
    if not isinstance(max_tokens, int) or max_tokens <= 0:
        raise ValueError(f"max_tokens must be positive int, got {max_tokens!r}")
    if soft_max is not None and (not isinstance(soft_max, int) or soft_max <= 0):
        raise ValueError(f"soft_max must be positive int or None, got {soft_max!r}")
    if text is None:
        raise ValueError("text is None")
    n = count_tokens(text)
    if n <= max_tokens and (soft_max is None or n <= soft_max):
        return [text]                      # 분할 불필요(원문 그대로, 내용·경계 불변)
    chunks = _greedy(_level_split(text, 0), 0, count_tokens, max_tokens, soft_max)
    # 단언: join 보존, 빈(공백만) chunk 없음, 각 chunk <= max_tokens
    assert "".join(chunks) == text, "분할이 원문을 보존하지 않음"
    assert chunks, "빈 분할 결과"
    for c in chunks:
        assert c != "", "빈(길이 0) chunk 발생"   # 공백만 chunk는 드물지만 내용 보존상 허용(무해)
        n = count_tokens(c)
        if n > max_tokens:
            raise SegmentTooLong(n, max_tokens)   # 정련 후에도 초과(병리적)
    return chunks


def resplit_once(text, count_tokens, hard_max):
    """상한에 도달한 chunk 를 **한 번** 다시 나눈다 — 같은 chunk 를 그대로 재시도하지 않기 위해.

    문장 경계(0) → 절 경계(1) 순으로, 원래 길이의 절반을 안전 목표로 삼아 2조각 이상 만든다.
    경계가 없어 못 나누면 [text] 를 돌려준다(호출자가 상한 도달을 그대로 보고한다). join == text.
    """
    n = count_tokens(text)
    if n < 2:
        return [text]
    target = max(1, n // 2)
    for level in SOFT_BOUNDARY_LEVELS:
        pieces = _level_split(text, level)
        if len(pieces) < 2:
            continue
        chunks = _greedy(pieces, level, count_tokens, hard_max, soft_max=target)
        chunks = [c for c in chunks if c != ""]
        if len(chunks) >= 2 and "".join(chunks) == text:
            return chunks
    return [text]
