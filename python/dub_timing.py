# -*- coding: utf-8 -*-
"""자리 맞추기 — 번역된 한 줄을 영상의 어디에 어떻게 놓을지 **계산만** 한다.

소리를 건드리지 않는다. 파일도 열지 않는다. 숫자를 받아 숫자를 돌려준다 —
그래서 화면 없이, 소리 없이, GPU 없이 검사할 수 있다.
실제로 늘이고 섞는 일은 audio_fit.py 의 몫이고, 이 파일은 **무엇을 할지만** 정한다.

기획서(doc/work-in-progress/video-dubbing.md)의 '자리 맞추기 규칙' 을 그대로 옮긴 것이다.
  1. 쉼을 먹는다   - 앞뒤 무음만큼 자리를 넓힌다. 품질을 깎지 않고 얻는 시간이라 가장 먼저 쓴다.
  2. 속도를 조절한다 - 그래도 모자라면 음높이를 지키며 줄인다. 한계선까지만.
  3. 표시한다      - 그래도 넘치면 억지로 넣지 않고 '안 맞음' 으로 남긴다.

상태는 셋뿐이다: 'fit'(맞음) / 'stretched'(늘여서 맞춤) / 'over'(안 맞음).
"""

class DubTimingError(ValueError):
    """자리를 계산할 수 없는 입력. 사유를 문구로 담는다."""


EPS = 1e-6

# 줄과 줄 사이에 남기는 최소 틈. 앞줄 끝과 뒷줄 시작이 붙어 들리지 않게 한다.
LINE_GAP_SEC = 0.06

# 원래 시작보다 얼마나 일찍 시작해도 되는가.
# 늦게 끝나는 것보다 일찍 시작하는 쪽이 입모양과 더 크게 어긋나 보여서 더 짜게 준다.
MAX_EARLY_SEC = 0.25

# 자리가 아예 없다고 볼 길이. 이보다 좁으면 늘여서 될 일이 아니다.
MIN_SLOT_SEC = 0.05

# 더빙에서 허용하는 최대 배율. 넘으면 '안 맞음' 으로 표시하고 사용자가 번역문을 줄인다.
#
# ★2026-09-20 실측: 1.0~1.7배에서 길이 오차는 0ms, 음높이는 +-40센트(반음 미만)였고
#   말이 깨지는 지점은 없었다. 즉 **절벽이 아니다.** 다만 높은 가성 구간에서 울림이
#   진해지는 결이 보여, '못 쓰는 선'이 아니라 **되도록 넘지 않는 선**으로 잡았다.
#   실제 영상을 돌려 보고 '안 맞음' 이 너무 많으면 올리고, 소리가 거슬리면 내린다.
MAX_RATIO = 1.30


def plan_line(start, end, spoken_sec, *, floor_sec=None, ceil_sec=None,
              max_ratio=MAX_RATIO, max_early_sec=MAX_EARLY_SEC):
    """한 줄의 자리를 정한다.

    start, end   - 원본에서 이 대사가 있던 구간(초).
    spoken_sec   - 새로 만든 한국어 소리의 길이(초).
    floor_sec    - 이 줄이 시작할 수 있는 가장 이른 시각. 보통 앞줄이 끝난 뒤다.
    ceil_sec     - 이 줄이 끝날 수 있는 가장 늦은 시각. None 이면 뒤가 열려 있다(마지막 줄).

    돌려주는 것에는 **왜 그렇게 됐는지**가 함께 들어 있다 - 얼마를 앞뒤에서 빌렸는지,
    얼마나 밀렸는지. 화면과 진단이 조용한 결과를 받지 않게 한다.
    """
    if end <= start:
        raise DubTimingError('대사 구간이 거꾸로이거나 비어 있습니다: %.3f~%.3f초' % (start, end))
    if spoken_sec <= 0:
        raise DubTimingError('만든 소리의 길이가 0 이하입니다: %r' % (spoken_sec,))

    floor = 0.0 if floor_sec is None else max(0.0, float(floor_sec))

    # 앞줄이 길어져 이 줄의 원래 시작을 덮었으면 뒤로 민다. 조용히 겹치게 두지 않는다.
    eff_start = max(start, floor)
    pushed = eff_start - start

    room = max(0.0, end - eff_start)
    need = spoken_sec - room

    # --- 1. 쉼을 먹는다 -------------------------------------------------
    # 뒤를 먼저 쓴다. 늦게 끝나는 것이 일찍 시작하는 것보다 덜 어긋나 보인다.
    borrowed_after = 0.0
    borrowed_before = 0.0
    if need > EPS:
        if ceil_sec is None:
            borrowed_after = need
            need = 0.0
        elif ceil_sec > end + EPS:
            take = min(need, ceil_sec - end)
            borrowed_after = take
            need -= take
    if need > EPS:
        earliest = max(floor, eff_start - max_early_sec)
        if eff_start - earliest > EPS:
            take = min(need, eff_start - earliest)
            borrowed_before = take
            need -= take

    place_start = eff_start - borrowed_before
    slot_sec = room + borrowed_before + borrowed_after

    # --- 3. 자리가 아예 없는 경우 ---------------------------------------
    # 늘여서 될 일이 아니다. 나눗셈을 하지 않고 그대로 '안 맞음' 으로 낸다.
    if slot_sec < MIN_SLOT_SEC:
        return {
            'status': 'over',
            'place_start': place_start,
            'place_sec': spoken_sec,
            'slot_sec': slot_sec,
            'ratio': 1.0,
            'overflow_sec': spoken_sec - slot_sec,
            'borrowed_before_sec': borrowed_before,
            'borrowed_after_sec': borrowed_after,
            'pushed_sec': pushed,
            'reason': '자리가 %.3f초뿐입니다' % slot_sec,
        }

    # --- 2. 속도를 조절한다 ---------------------------------------------
    want = spoken_sec / slot_sec
    if want <= 1.0 + EPS:
        status, ratio, overflow, reason = 'fit', 1.0, 0.0, ''
    elif want <= max_ratio + EPS:
        status, ratio, overflow = 'stretched', want, 0.0
        reason = ''
    else:
        # 한계까지 줄여도 남는 시간을 알린다 - 사용자가 번역문을 얼마나 줄여야 하는지가 이 숫자다.
        status, ratio = 'over', max_ratio
        overflow = spoken_sec / max_ratio - slot_sec
        reason = '%.2f배까지 줄여도 %.2f초 넘칩니다' % (max_ratio, overflow)

    return {
        'status': status,
        'place_start': place_start,
        'place_sec': spoken_sec / ratio,
        'slot_sec': slot_sec,
        'ratio': ratio,
        'overflow_sec': max(0.0, overflow),
        'borrowed_before_sec': borrowed_before,
        'borrowed_after_sec': borrowed_after,
        'pushed_sec': pushed,
        'reason': reason,
    }


def plan_lines(lines, *, media_sec=None, max_ratio=MAX_RATIO,
               max_early_sec=MAX_EARLY_SEC, gap_sec=LINE_GAP_SEC):
    """여러 줄의 자리를 앞에서부터 차례로 정한다.

    lines - [{'start':초, 'end':초, 'spoken_sec':초}, ...] 을 **시작 시각 순서로** 준다.

    앞줄이 먼저 자리를 잡고 뒷줄은 남은 자리에서 시작한다. 뒤로 빌릴 수 있는 한계는
    **다음 줄의 원래 시작**이다 - 다음 줄이 실제로 어디에 놓일지는 아직 모르기 때문이다.
    그래서 앞줄이 유리하다. 이 치우침은 의도한 것이고, 그래서 밀린 양을 pushed_sec 로 남긴다.
    """
    plans = []
    cursor = 0.0
    prev_start = None
    for i, ln in enumerate(lines):
        try:
            start = float(ln['start'])
            end = float(ln['end'])
            spoken = float(ln['spoken_sec'])
        except (KeyError, TypeError, ValueError) as e:
            raise DubTimingError('%d번째 줄의 값이 모자라거나 숫자가 아닙니다: %s' % (i + 1, e))
        if prev_start is not None and start < prev_start - EPS:
            raise DubTimingError('%d번째 줄이 앞줄보다 먼저 시작합니다 - 순서대로 주세요' % (i + 1))
        prev_start = start

        nxt = float(lines[i + 1]['start']) if i + 1 < len(lines) else media_sec
        ceil = None if nxt is None else float(nxt) - gap_sec

        plan = plan_line(start, end, spoken,
                         floor_sec=cursor, ceil_sec=ceil,
                         max_ratio=max_ratio, max_early_sec=max_early_sec)
        plan['index'] = i
        plans.append(plan)
        cursor = plan['place_start'] + plan['place_sec'] + gap_sec
    return plans


def summarize(plans):
    """목록을 한눈에. 화면 위쪽에 '3줄이 안 맞습니다' 라고 띄우기 위한 것이다."""
    counts = {'fit': 0, 'stretched': 0, 'over': 0}
    for p in plans:
        counts[p['status']] = counts.get(p['status'], 0) + 1
    over = [p for p in plans if p['status'] == 'over']
    return {
        'total': len(plans),
        'fit': counts['fit'],
        'stretched': counts['stretched'],
        'over': counts['over'],
        'over_indexes': [p.get('index') for p in over],
        'worst_overflow_sec': max([p['overflow_sec'] for p in over], default=0.0),
        'max_ratio_used': max([p['ratio'] for p in plans], default=1.0),
    }
