# -*- coding: utf-8 -*-
"""**끝이 잘린 줄을 다시 만든다** — 재기만 하던 것에 조치를 붙인다.

무엇이 있었고 무엇이 없었나(2026-09-24)
  합성 결과의 말끝이 살아 있는 채 끊기는 일이 있다. 모델이 마지막 음절이 울리는 중에
  스스로 끝내는 것이라 **생성 상한 도달도, 우리 쪽 절단도 아니어서 오류로 드러나지 않는다.**

  우리에게 이미 있던 것
    · 재기   — `audio_finishing.tail_residual_ratio`(fade 걸기 전 마지막 창 ÷ 전체 최대)
    · 판정   — 0.03 이상이면 잘린 것으로 본다
    · 표시   — 도구 화면에 꼬리표가 붙는다
  없던 것
    · **조치.** 그때 적어 둔 "되살릴 수는 없다" 는 **파형을 고칠 수 없다**는 뜻이지,
      좋은 결과를 못 얻는다는 뜻이 아니었다. **다시 만들면 된다.**
    · 그리고 **더빙 경로는 재지도 않았다** — 사용자가 겪은 자리가 바로 거기다.

왜 다시 만들면 되는가
  합성은 매번 조금씩 다르게 나온다(표본 추출). 같은 글을 다시 부르면 끝맺음을
  제대로 하는 회차가 나온다. 바깥 구현(voicebox)도 같은 발상으로,
  잡히면 **글을 쪼개 다시 만든다.**

이 파일은 **판단만** 한다. 소리를 만들지도, 재지도 않는다 — 값을 받아 "다시 할까" 를 답한다.
"""

# ★이 값은 화면 쪽 TAIL_RESIDUAL_CUT(src/shared/labWorkspace.ts)과 **같아야 한다.**
#   말이 다르면 화면은 "잘렸다" 는데 여기서는 다시 만들지 않는 일이 생긴다.
#   언어가 달라 한 곳에 둘 수 없으므로 **양쪽에 서로를 가리키는 말을 적어 두고
#   검사로 값을 붙잡는다.**
#   근거(2026-09-16 실측): 끊긴 1회 0.087 · 정상 3회 0.000/0.002/0.007.
CUT_RATIO = 0.03

# 몇 번까지 다시 만들 것인가. 값이 비싸므로(합성 한 번) 넉넉히 두지 않는다.
MAX_RETRIES = 2


def is_cut(ratio, cut=CUT_RATIO):
    """끝이 잘렸는가. **재지 못했으면 False** — 모르는 것을 잘렸다고 말하지 않는다."""
    try:
        v = float(ratio)
    except (TypeError, ValueError):
        return False
    if v != v:                      # NaN
        return False
    return v >= cut


def should_retry(ratio, attempt, *, cut=CUT_RATIO, max_retries=MAX_RETRIES):
    """다시 만들까. attempt 는 지금까지 만든 횟수(첫 회차면 1)."""
    if attempt >= max_retries + 1:
        return False
    return is_cut(ratio, cut)


def pick_best(takes):
    """만든 것들 중 **가장 덜 잘린 것**의 자리. 빈 목록이면 None.

    takes — [{'ratio': 0.087, ...}, ...] 순서대로.
    ★재지 못한 회차(None)는 **맨 뒤로** 민다 — 모르는 것을 좋은 것으로 치지 않는다.
    """
    best = None
    for i, t in enumerate(takes or []):
        r = t.get('ratio')
        try:
            v = float(r)
            if v != v:
                v = None
        except (TypeError, ValueError):
            v = None
        key = (1, 0.0) if v is None else (0, v)
        if best is None or key < best[0]:
            best = (key, i)
    return None if best is None else best[1]


def summarize(rows):
    """한눈에. rows — [{'index':.., 'attempts':.., 'ratio':.., 'cut':bool}, ...]"""
    total = len(rows or [])
    retried = sum(1 for r in (rows or []) if int(r.get('attempts') or 1) > 1)
    still = sum(1 for r in (rows or []) if r.get('cut'))
    return {'lines': total, 'retried': retried, 'still_cut': still,
            'rescued': max(0, retried - still)}
