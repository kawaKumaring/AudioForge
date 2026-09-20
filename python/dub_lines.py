# -*- coding: utf-8 -*-
"""조각난 구간을 **한 문장으로 묶는다.**

왜 필요한가(2026-09-20 실측): 알아듣기가 낸 36개 구간 중 문장부호로 끝나는 것이 **0개**였다.
글자 수 중앙 11자, 10자 미만이 15개, 틈의 절반이 0.3초 미만이다.
즉 **모든 줄이 문장의 조각**인데, 번역에는 조각을 하나씩 따로 넘기고 있었다.

조각을 완성된 문장처럼 번역하라고 하면 모델은 **없는 말을 지어내 끝을 맺는다.**
"바람이 표면에" 를 넘기면 "바람이 표면에 울고 있습니다" 가 나오는 식이다.
그래서 번역 전에 묶는다.

★쪼개 놓았다가 다시 붙이는 것이 아니다. **묶은 채로 한 줄로 둔다.**
  더빙 줄이 알아듣기의 구간 나눔을 그대로 따라야 할 이유가 없다.
  묶으면 자리도 넓어져 늘이기가 덜 필요해진다.

이 파일은 **계산만** 한다. 파일도 모델도 건드리지 않는다.
"""

# 문장이 끝났다고 볼 글자. 일본어·중국어·한국어·서양 부호를 함께 본다.
SENTENCE_END = '。．.！？!?…」』"\''

# 묶을 때의 한계. 넘으면 새 줄로 시작한다.
#
# ★이 값들은 **노래 한 곡으로 정한 시작값**이다. 대화는 구간이 더 촘촘하므로 다를 수 있다.
#   대화 영상을 돌려 본 뒤 조정한다. 부르는 쪽에서 바꿀 수 있게 인자로 열어 두었다.
MAX_MERGED_SEC = 10.0      # 한 번에 말하기 편한 길이. 12초로 해 보니 7줄이 한계에 걸렸다.
MAX_MERGED_CHARS = 50      # 번역이 길어지면 자리에 넣기 어려워진다
MERGE_GAP_SEC = 0.4        # 이보다 크게 쉬면 다른 문장으로 본다


class DubLinesError(ValueError):
    """묶을 수 없는 입력. 사유를 문구로 담는다."""


def ends_sentence(text):
    """문장이 끝났는가. 부호가 없으면 알 수 없으므로 False 다(틈으로 판단하게 넘긴다)."""
    t = (text or '').rstrip()
    return bool(t) and t[-1] in SENTENCE_END


def _is_cjk(ch):
    o = ord(ch)
    return (0x3040 <= o <= 0x30ff or 0x4e00 <= o <= 0x9fff
            or 0xac00 <= o <= 0xd7a3 or 0x3000 <= o <= 0x303f)


def join_text(a, b):
    """두 토막을 잇는다. 한·중·일은 띄어쓰기 없이, 그 밖은 한 칸 띄워서."""
    a, b = (a or '').rstrip(), (b or '').lstrip()
    if not a:
        return b
    if not b:
        return a
    if _is_cjk(a[-1]) or _is_cjk(b[0]):
        return a + b
    return a + ' ' + b


def should_break(prev, nxt, merged_sec, merged_chars, *,
                 max_sec=MAX_MERGED_SEC, max_chars=MAX_MERGED_CHARS,
                 gap_sec=MERGE_GAP_SEC):
    """여기서 줄을 끊어야 하는가. **왜 끊는지**를 함께 돌려준다.

    조용히 끊지 않는다 — 나중에 '왜 이렇게 묶였나' 를 되짚을 수 있어야 한다.
    """
    if ends_sentence(prev.get('text')):
        return True, '문장이 끝났다'
    gap = float(nxt.get('start', 0)) - float(prev.get('end', 0))
    if gap > gap_sec:
        return True, '%.2f초 쉬었다' % gap
    nxt_sec = float(nxt.get('end', 0)) - float(nxt.get('start', 0))
    if merged_sec + gap + nxt_sec > max_sec:
        return True, '%.1f초를 넘는다' % max_sec
    if merged_chars + len(nxt.get('text') or '') > max_chars:
        return True, '%d자를 넘는다' % max_chars
    return False, ''


def merge_segments(segments, *, max_sec=MAX_MERGED_SEC, max_chars=MAX_MERGED_CHARS,
                   gap_sec=MERGE_GAP_SEC):
    """조각난 구간을 문장 단위로 묶는다.

    묶은 줄에는 **무엇이 묶였는지**(parts)와 **왜 거기서 끊었는지**(break_reason)를 남긴다.
    낱말 시각은 이어 붙인다 — 나중에 어절 단위로 자리를 맞출 재료다.
    """
    out = []
    cur = None
    for i, seg in enumerate(segments or []):
        try:
            start = float(seg['start'])
            end = float(seg['end'])
        except (KeyError, TypeError, ValueError) as e:
            raise DubLinesError('%d번째 구간의 시각을 읽지 못했습니다: %s' % (i + 1, e))
        text = (seg.get('text') or '').strip()
        words = list(seg.get('words') or [])

        if cur is None:
            cur = {'start': start, 'end': end, 'text': text,
                   'words': words, 'parts': [i], 'break_reason': ''}
            continue

        brk, why = should_break(
            {'text': cur['text'], 'end': cur['end']},
            {'start': start, 'end': end, 'text': text},
            cur['end'] - cur['start'], len(cur['text']),
            max_sec=max_sec, max_chars=max_chars, gap_sec=gap_sec)
        if brk:
            cur['break_reason'] = why
            out.append(cur)
            cur = {'start': start, 'end': end, 'text': text,
                   'words': words, 'parts': [i], 'break_reason': ''}
        else:
            cur['end'] = end
            cur['text'] = join_text(cur['text'], text)
            cur['words'] = cur['words'] + words
            cur['parts'].append(i)

    if cur is not None:
        cur['break_reason'] = cur['break_reason'] or '마지막'
        out.append(cur)
    return out


def summarize(before, after):
    """묶기 전후를 한눈에. 사람에게 보여 주기 위한 것이다."""
    def chars(rows):
        return [len(r.get('text') or '') for r in rows]

    cb, ca = chars(before), chars(after)
    merged = sum(1 for r in after if len(r.get('parts') or []) > 1)
    return {
        'before': len(before),
        'after': len(after),
        'merged_lines': merged,
        'before_median_chars': sorted(cb)[len(cb) // 2] if cb else 0,
        'after_median_chars': sorted(ca)[len(ca) // 2] if ca else 0,
        'longest_sec': max([r['end'] - r['start'] for r in after], default=0.0),
    }
