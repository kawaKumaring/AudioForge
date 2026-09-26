# -*- coding: utf-8 -*-
"""음높이 곡선을 **손잡이 몇 개로** 빚는다 — 그래프 맞추기.

★왜 이렇게 만드나 (2026-09-26 사용자 설계)
  "그래프를 하나하나 고친다기보단 슬라이드로 위아래로 조절해서 파형을 부드럽게
   편다든가 뾰족하게 만든다든가 폭을 넓힌다든가 해서 원본에 가깝게 맞춰 가는 것.
   게임의 그래프 맞추기 미니게임과 비슷하다."

  점 편집이 아니라 **모양 손잡이**다. 손잡이가 적어야 사람이 감으로 맞출 수 있다.

★자동과 수동이 같은 엔진을 쓴다
  자동 = 프로그램이 손잡이를 맞춘다. 수동 = 사람이 맞춘다. 빚는 일은 하나다.
  그래서 이 파일에는 **빚기와 점수**만 있고, 누가 돌리는지는 모른다.

★왜 숫자만 다루나
  여기에 소리를 들이면 GPU 없이 검사할 수 없다. 오늘 품질 지표를 여섯 번 고르고
  여섯 번 빗나갔다 — 적어도 **빚는 규칙만큼은** 확실히 검사되어야 한다.

★반음으로 다룬다
  Hz 로 다루면 높은 음에서만 폭이 커져 사람 감각과 어긋난다.
  음악은 비율로 들리므로 반음(로그)이 맞다.
"""
import math

# 손잡이 기본값. 전부 '아무것도 하지 않음' 이다.
NEUTRAL = {'smooth': 0.0, 'spread': 1.0, 'shift': 0.0}

REF_HZ = 55.0          # 반음 계산의 기준음
MAX_SMOOTH = 1.0       # 손잡이 위쪽 끝
MAX_SPREAD = 3.0


class PitchShapeError(ValueError):
    """빚을 수 없는 입력."""


def to_semitones(hz_list):
    """Hz 를 반음으로. 소리가 없던 자리(0·None)는 None 으로 남긴다."""
    out = []
    for v in hz_list:
        try:
            f = float(v)
        except (TypeError, ValueError):
            out.append(None)
            continue
        out.append(12.0 * math.log2(f / REF_HZ) if f and f > 0 else None)
    return out


def to_hz(semi_list):
    """반음을 Hz 로. None 은 0 으로 — '소리 없음' 을 지어내지 않는다."""
    return [0.0 if s is None else REF_HZ * (2.0 ** (float(s) / 12.0)) for s in semi_list]


def _runs(values):
    """이어진 구간들의 (시작, 끝) — 소리 없는 자리에서 끊는다.

    ★끊지 않고 뭉개면 **쉬는 자리를 가로질러** 곡선이 이어져 버린다.
      원본에 없던 소리를 만들어 내는 셈이다.
    """
    spans, start = [], None
    for i, v in enumerate(values):
        if v is None:
            if start is not None:
                spans.append((start, i))
                start = None
        elif start is None:
            start = i
    if start is not None:
        spans.append((start, len(values)))
    return spans


def smooth(values, amount):
    """들쑥날쑥한 자리를 편다. 0 이면 그대로, 1 이면 가장 부드럽게.

    ★중앙값을 쓴다. 평균은 튄 점 하나에 끌려가 **주변까지 함께 망가진다.**
      찢어지는 음을 다루는 일이라 튄 점에 끌려가면 안 된다.
    """
    a = max(0.0, min(float(amount), MAX_SMOOTH))
    if a <= 0:
        return list(values)
    width = 1 + 2 * int(round(a * 10))          # 3 ~ 21 칸
    out = list(values)
    for lo, hi in _runs(values):
        seg = values[lo:hi]
        for i in range(len(seg)):
            j0 = max(0, i - width // 2)
            j1 = min(len(seg), i + width // 2 + 1)
            win = sorted(seg[j0:j1])
            out[lo + i] = win[len(win) // 2]
    return out


def spread(values, factor):
    """곡선의 폭을 넓히거나 좁힌다. 1 이면 그대로, 크면 넓어진다.

    가운데(중앙값)를 축으로 벌린다 — 축이 흔들리면 조가 바뀐다.
    """
    f = max(0.0, min(float(factor), MAX_SPREAD))
    live = [v for v in values if v is not None]
    if not live or f == 1.0:
        return list(values)
    live_sorted = sorted(live)
    center = live_sorted[len(live_sorted) // 2]
    return [None if v is None else center + (v - center) * f for v in values]


def shift(values, semitones):
    """통째로 올리거나 내린다. 반음 단위."""
    s = float(semitones)
    if s == 0.0:
        return list(values)
    return [None if v is None else v + s for v in values]


def apply_knobs(values, knobs=None):
    """손잡이를 순서대로 먹인다: 편다 → 폭 → 옮김.

    ★순서가 중요하다. 튄 점을 먼저 펴지 않고 폭을 벌리면 **튄 점까지 같이 커진다.**
    """
    k = dict(NEUTRAL)
    k.update(knobs or {})
    out = smooth(values, k['smooth'])
    out = spread(out, k['spread'])
    return shift(out, k['shift'])


def similarity(target, current):
    """두 곡선이 얼마나 겹치는가. 1 이면 똑같고 0 이면 딴판.

    둘 다 소리가 있는 자리만 견준다 — 한쪽만 소리가 있는 자리는 빚어서 될 일이 아니다.
    반음 차이 1 을 '꽤 다름' 으로 보고 점수를 매긴다.
    """
    pairs = [(a, b) for a, b in zip(target, current) if a is not None and b is not None]
    if not pairs:
        return 0.0
    err = sum(abs(a - b) for a, b in pairs) / len(pairs)
    return 1.0 / (1.0 + err)


def auto_fit(target, current, *, steps=9):
    """손잡이를 프로그램이 맞춘다. 사람이 돌리는 것과 **같은 손잡이**를 쓴다.

    거친 격자로 훑는다 — 손잡이가 셋뿐이라 이것으로 충분하고,
    사람이 이어받아 미세하게 돌릴 수 있는 자리를 남긴다.
    """
    if not target or not current:
        raise PitchShapeError('견줄 곡선이 없습니다.')
    best, best_score = dict(NEUTRAL), -1.0
    for si in range(steps):
        sm = si / float(steps - 1) if steps > 1 else 0.0
        for pi in range(steps):
            sp = 0.5 + 1.5 * (pi / float(steps - 1) if steps > 1 else 0.0)
            shaped = apply_knobs(current, {'smooth': sm, 'spread': sp})
            # 옮김은 남은 차이를 그대로 메우면 된다 — 훑을 필요가 없다.
            pairs = [(a, b) for a, b in zip(target, shaped)
                     if a is not None and b is not None]
            off = (sum(a - b for a, b in pairs) / len(pairs)) if pairs else 0.0
            knobs = {'smooth': sm, 'spread': sp, 'shift': off}
            score = similarity(target, apply_knobs(current, knobs))
            if score > best_score:
                best, best_score = knobs, score
    return best, best_score
