# -*- coding: utf-8 -*-
"""더빙 평가 — **정답지를 놓고** 알아듣기와 번역을 잰다.

왜 생겼나(2026-09-21): 그때까지는 정답지가 없어 '모델 자신의 확신도' 같은 **대리 지표**로만
견주었다. 사용자가 가사 파일을 준비해 주면서 진짜로 잴 수 있게 됐다.

가사 파일의 모양 (원문 / 발음 / 뜻 이 되풀이된다)
    風が表で呼んでいる        ← 일본어 원문   : 알아듣기의 정답지
    카제가 오모테데 요은데이루   ← 한글 발음      : 번역의 정답지가 **아니다**
    바람이 바깥에서 부르고 있어  ← 한국어 뜻      : 번역의 정답지

★발음 줄과 뜻 줄을 이름이 아니라 **숫자로** 가린다 — 발음은 원문 길이를 따라가고 뜻은 덜 따라간다.
  잘못 고르면 번역 점수가 통째로 헛것이 되므로 고른 근거를 함께 돌려준다.

재는 것은 글자 단위 오류율(CER)이다. 편집거리는 korean_cer.edit_counts 를 그대로 쓴다
— 같은 계산을 두 곳에 두지 않는다.

이 파일은 **계산만** 한다. 모델도 GPU도 쓰지 않는다.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from korean_cer import edit_counts

KANA = re.compile(r'[぀-ゟ゠-ヿ]')
HANGUL = re.compile(r'[가-힣]')
HANJA = re.compile(r'[一-鿿]')
# 견줄 때 지우는 것: 공백과 문장부호. 뜻이 같은데 부호만 다른 것을 틀렸다고 세지 않는다.
STRIP = re.compile(r'[\s、。，．・！？!?…「」『』"\'（）()\[\]【】~〜ー\-—,.:;]+')


class DubEvalError(ValueError):
    """평가할 수 없는 입력. 사유를 문구로 담는다."""


def normalize(text):
    """견주기 전에 고른다 — 공백·문장부호를 지우고 한 줄로 만든다."""
    return STRIP.sub('', (text or '')).strip()


def is_japanese(line):
    return bool(KANA.search(line or ''))


def is_korean(line):
    return bool(HANGUL.search(line or '')) and not is_japanese(line)


def parse_lyrics(text):
    """가사 파일을 (원문, 한국어1, 한국어2) 묶음으로 가른다.

    원문 한 줄 뒤에 한국어 두 줄이 오는 모양만 받는다. 그 모양이 아니면 건너뛴다 —
    머리말·제목 같은 것이 섞여 있기 때문이다.
    """
    lines = [l.strip() for l in (text or '').splitlines()]
    rows = [l for l in lines if l]
    out = []
    i = 0
    while i + 2 < len(rows) + 1:
        if (i + 2 < len(rows) and is_japanese(rows[i])
                and is_korean(rows[i + 1]) and is_korean(rows[i + 2])):
            out.append((rows[i], rows[i + 1], rows[i + 2]))
            i += 3
        else:
            i += 1
    return out


def pick_meaning_column(triples):
    """발음 줄과 뜻 줄 중 **어느 쪽이 뜻인지** 고른다.

    발음은 원문을 글자 그대로 옮긴 것이라 길이가 원문을 바짝 따라간다.
    뜻은 말을 바꿔 옮기므로 덜 따라간다. 그 차이로 가른다.

    돌려주는 것: (뜻이 몇 번째인가(1|2), 첫째 상관, 둘째 상관)
    """
    if len(triples) < 5:
        raise DubEvalError('짝이 %d개뿐이라 어느 쪽이 뜻인지 가릴 수 없습니다' % len(triples))

    def corr(xs, ys):
        n = len(xs)
        mx, my = sum(xs) / n, sum(ys) / n
        num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
        dx = sum((x - mx) ** 2 for x in xs) ** 0.5
        dy = sum((y - my) ** 2 for y in ys) ** 0.5
        return num / (dx * dy) if dx and dy else 0.0

    j = [len(t[0]) for t in triples]
    c1 = corr(j, [len(t[1]) for t in triples])
    c2 = corr(j, [len(t[2]) for t in triples])
    # 원문 길이를 **덜** 따라가는 쪽이 뜻이다.
    return (2 if c2 < c1 else 1), c1, c2


def cer(reference, hypothesis):
    """글자 단위 오류율과 그 속내. 정답지가 비면 잴 수 없다고 말한다."""
    ref = list(normalize(reference))
    hyp = list(normalize(hypothesis))
    if not ref:
        raise DubEvalError('정답지가 비어 있어 잴 수 없습니다')
    counts = edit_counts(ref, hyp)
    s, d, i = counts.substitutions, counts.deletions, counts.insertions
    return {
        'cer': (s + d + i) / float(len(ref)),
        'accuracy': 100.0 * (1.0 - (s + d + i) / float(len(ref))),
        'ref_chars': len(ref),
        'hyp_chars': len(hyp),
        'substitutions': s,
        'deletions': d,
        'insertions': i,
    }


def evaluate(lyrics_text, asr_text, korean_text=None):
    """알아듣기와 번역을 한 번에 잰다.

    asr_text     — 우리가 알아들은 것(원어). 정답지는 가사의 원문 줄.
    korean_text  — 우리가 번역한 것. 정답지는 가사의 뜻 줄.

    ★줄을 하나씩 맞추지 않는다. 줄 나눔이 서로 다르기 때문이다.
      전부 이어 붙여 **통째로** 견준다 — 전체 정확도를 보는 데는 이 편이 정직하다.
    """
    triples = parse_lyrics(lyrics_text)
    if not triples:
        raise DubEvalError('가사에서 원문+한국어 짝을 찾지 못했습니다')
    which, c1, c2 = pick_meaning_column(triples)

    out = {
        'pairs': len(triples),
        'meaning_column': which,
        'corr_first': round(c1, 3),
        'corr_second': round(c2, 3),
    }
    out['asr'] = cer(''.join(t[0] for t in triples), asr_text)
    if korean_text is not None:
        out['translation'] = cer(''.join(t[which] for t in triples), korean_text)
        # 고른 근거를 눈으로 확인할 수 있게 반대쪽도 함께 잰다.
        other = 1 if which == 2 else 2
        out['translation_other_column'] = cer(''.join(t[other] for t in triples), korean_text)
    return out
