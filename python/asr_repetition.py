# -*- coding: utf-8 -*-
"""받아쓴 글에 박힌 **반복 환청**을 지운다 — 확신도가 아니라 글자를 증거로 쓴다.

왜 필요한가(2026-09-22)
  알아듣기 모델은 소리가 잦아들거나 반주만 남는 자리에서 같은 말을 되풀이한다.
  "URL URL URL…", "thanks for watching"×N, 띄어쓰기 없는 "ありがとう"×N 같은 모양이다.

  우리는 이미 **에너지 게이트**(transcribe_worker._filter_silent_segments)로
  "소리가 없는데 글이 있는 것" 을 지운다. 그건 잘 듣는다.
  ★하지만 **소리가 있는데 같은 글이 되풀이되는 것** 은 그 그물에 걸리지 않는다.
  반주가 깔린 자리는 조용하지 않기 때문이다. 이 파일이 그 구멍을 맡는다.

왜 모델에 맡기지 않는가
  번역·다듬기를 맡는 언어 모델에 반복을 그대로 넘기면 양쪽으로 다 망가진다.
  작은 모델은 그 반복에 자리를 내주려 **멀쩡한 줄을 잘라 먹고**,
  큰 모델은 "내용을 빠뜨리지 말라"는 지시가 이겨 **반복을 그대로 베낀다**.
  그래서 **넘기기 전에 규칙으로** 치운다.

★저쪽(voicebox)과 일부러 다르게 한 것
  저쪽은 되풀이된 것을 **통째로** 버린다. 우리는 **하나만 남긴다.**
  사람이 실제로 한 번 말했을 가능성을 지우지 않기 위해서다.
  글을 잃는 쪽이 읽기 불편한 쪽보다 나쁘다는 우리 기준(subtitle_cues 와 같다)을 따른다.

★노래에는 손대지 않는 것이 있다
  구간과 구간에 걸친 반복(후렴!)은 **세기만 하고 지우지 않는다.**
  후렴이 여섯 번 이어지는 노래는 얼마든지 있고, 그것이 환청인지 진짜인지
  **가려낼 측정을 아직 하지 않았다.** 재 보지 않은 것을 지우지 않는다.

이 파일은 **계산만** 한다. 모델도 파일도 소리도 읽지 않는다.
"""
import re

# 이만큼 잇따라 되풀이되면 환청으로 본다.
# 6 은 수사적 반복을 살리려고 고른 값이다 — "아니 아니 아니 아니 아니"(5번)는 남는다.
REPEAT_RUN_MIN = 6

# 글자 단위로 훑을 때 '되풀이 단위' 의 최대 길이.
# 실제로 관측된 상투구("Subtitles by the Amara.org community" 36자,
# "Please like and subscribe to my channel." 41자)를 덮으면서,
# 우연히 긴 구절이 겹치는 일은 문턱 아래 남도록 잡았다.
MAX_UNIT_CHARS = 60
# 1자 단위를 허용하면 "우와아아아아아" 같은 늘인 소리를 지운다. 2자부터 본다.
MIN_UNIT_CHARS = 2

# ★비율 빗장을 두지 않는 이유(2026-09-22, 만들다가 스스로 걷어냄)
#   처음엔 "너무 많이 지우면 손대지 않는다" 는 빗장을 뒀는데, 구간 하나가
#   **통째로 반복**인 경우가 바로 고쳐야 할 경우다. 그때 빗장이 걸려 아무것도
#   못 하게 된다. 무음 게이트의 빗장은 '음량 눈금 이상'이라는 딴 원인을 막는 것이라
#   여기에 그대로 옮기면 안 된다. 규칙이 엉뚱하게 먹는 일은 빗장이 아니라
#   **검사로** 막는다.


def _token_key(word):
    """견주기 위한 알맹이 — 둘레 문장부호를 떼고 소문자로.

    "URL", "url," , "URL." 이 같은 것으로 보이게 한다.
    """
    return re.sub(r'[^\w]', '', word, flags=re.UNICODE).lower()


def collapse_word_runs(text, min_run=REPEAT_RUN_MIN):
    """같은 낱말이 잇따라 min_run 번 이상 나오면 **하나만 남긴다.**

    돌려주는 것: (고친 글, 지운 낱말 수)
    """
    words = (text or '').split()
    if len(words) < min_run:
        return text, 0

    out = []
    removed = 0
    i = 0
    while i < len(words):
        key = _token_key(words[i])
        j = i
        if key:
            while j < len(words) and _token_key(words[j]) == key:
                j += 1
        else:
            # 문장부호만 있는 조각은 같은 것으로 세지 않는다.
            j = i + 1
        run = j - i
        if run >= min_run:
            out.append(words[i])        # 하나만 남긴다
            removed += run - 1
        else:
            out.extend(words[i:j])
        i = j
    return ' '.join(out), removed


def collapse_char_runs(text, min_run=REPEAT_RUN_MIN):
    """2~60자짜리 조각이 곧바로 min_run 번 이상 되풀이되면 **하나만 남긴다.**

    낱말 훑기가 못 잡는 두 가지를 맡는다.
      · 낱말이 서로 안 겹치는 여러 낱말 구절("thanks for watching"×6)
      · **띄어쓰기가 없는 글**(일본어·중국어) — split() 이 통째로 한 덩어리가 된다.

    돌려주는 것: (고친 글, 지운 글자 수)
    """
    src = text or ''
    if not src:
        return src, 0
    pattern = re.compile(
        r'(.{%d,%d}?)\1{%d,}' % (MIN_UNIT_CHARS, MAX_UNIT_CHARS, min_run - 1),
        flags=re.DOTALL)
    out = pattern.sub(lambda m: m.group(1), src)
    if out == src:
        return src, 0
    # 되풀이가 앞뒤를 잇고 있던 자리라 공백이 겹친다. 고친 때만 고른다.
    out = re.sub(r'[ \t]{2,}', ' ', out).strip()
    return out, len(src) - len(out)


def collapse(text, min_run=REPEAT_RUN_MIN):
    """낱말 훑기 → 글자 훑기 차례로. 돌려주는 것: (고친 글, 지운 글자 수)."""
    src = text or ''
    if not src.strip():
        return src, 0
    step1, n_word = collapse_word_runs(src, min_run)
    step2, n_char = collapse_char_runs(step1 if n_word else src, min_run)
    # ★고친 것이 없으면 **원문을 그대로** 돌려준다(2026-09-24 계측대에서 드러남).
    #   collapse_word_runs 는 늘 " ".join 으로 다시 엮어서, 되풀이가 하나도 없어도
    #   앞뒤 공백이 사라진다. 그 탓에 알아듣기 결과의 **모든 구간**이 "고쳤다" 로 세어졌다
    #   (계측대 실측: 11구간 중 7구간 "고침", 지운 글자는 구간당 1자 = 앞 공백 하나).
    #   진단 숫자가 거짓이 되고, 부탁하지 않은 공백 손질이 덤으로 끼어든다.
    if not n_word and not n_char:
        return src, 0
    return step2, len(src) - len(step2)


def scan_segment_runs(segments, min_run=REPEAT_RUN_MIN):
    """**구간과 구간에 걸친** 반복을 센다. ★지우지 않는다.

    노래의 후렴은 진짜로 여섯 번 이어질 수 있고, 그것이 환청인지 진짜인지
    가려낼 측정을 아직 하지 않았다. 그래서 **세어서 알리기만** 한다.

    돌려주는 것: [{'from': 첫 번째 자리, 'count': 몇 번, 'text': 그 글}, ...]
    """
    rows = []
    texts = [' '.join((s.get('text') or '').split()) for s in (segments or [])]
    i = 0
    while i < len(texts):
        j = i
        if texts[i]:
            while j < len(texts) and texts[j] == texts[i]:
                j += 1
        else:
            j = i + 1
        if j - i >= min_run:
            rows.append({'from': i, 'count': j - i, 'text': texts[i]})
        i = j
    return rows


def apply(result, min_run=REPEAT_RUN_MIN):
    """전사 결과(dict)를 제자리에서 손본다. 한 일을 전부 돌려준다.

    · 구간마다 그 구간 **안의** 반복을 하나로 줄인다
    · 줄인 것이 있으면 result['text'] 를 다시 만든다
    · 구간에 **걸친** 반복은 세기만 해서 알린다

    돌려주는 것:
      {'segments_fixed': n, 'chars_removed': n, 'cross_segment_runs': [...]}
    """
    segs = (result or {}).get('segments') or []
    fixed = 0
    removed = 0
    for s in segs:
        before = s.get('text') or ''
        after, n = collapse(before, min_run)
        if n > 0:
            s['text'] = after
            fixed += 1
            removed += n
    if fixed:
        result['text'] = ''.join(s.get('text', '') for s in segs).strip()
    return {
        'segments_fixed': fixed,
        'chars_removed': removed,
        'cross_segment_runs': scan_segment_runs(segs, min_run),
    }
