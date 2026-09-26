# -*- coding: utf-8 -*-
"""알아듣기가 준 시각을 **소리의 무음 경계에 맞춰 민다.**

왜(2026-09-22)
  알아듣기가 말한 시작 시각이 실제 소리와 어긋난다. 낱말 시각도 구간 시각과
  같은 말을 해서(중앙 0밀리초) 낱말 단위로 바꿔도 소용이 없었다.
  그래서 "정렬 모델을 받아야 한다" 고 판단했는데 **그 판단이 틀렸다.**
  모델을 더 쓰지 않고 고치는 길이 있다.

  ★어긋난 크기도 바로잡았다. 예전에 적어 둔 **중앙 720밀리초는 부풀려진 값**이었다.
    `timing_audit.find_onset` 이 탐색 창의 첫 칸부터 시끄러우면 **창의 왼쪽 끝**을
    답으로 내놨고, 노래는 내내 소리가 나서 그 일이 자주 일어났다. 그러면 오차가
    언제나 창 크기가 된다(최대가 정확히 1500밀리초였다 — 창도 1500밀리초).
    "조용하다 **커지는**" 자리만 세도록 고치고 다시 재니 **중앙 490밀리초**다.

무엇을 하는가
  소리에서 **무음 구간의 지도**를 만들고, 알아듣기가 말한 시각이 그 무음 **안에**
  떨어져 있으면 무음의 경계로 민다. 시작이 무음 안이면 무음의 **끝**으로,
  끝이 무음 안이면 무음의 **시작**으로.
  말이 없는 자리를 말이 있다고 우기던 것을 걷어내는 것이라, 모델이 필요 없다.

핵심 설계 (바깥 구현 `jianfch/stable-ts` 를 읽고 옮긴 판단)
  · 소리 지도를 **20밀리초 한 칸**으로 만든다 — 위스퍼가 시각을 내는 눈금과 같게.
    고칠 대상과 자를 같은 눈금에 올려 두는 것이 요령이다.
  · 크기 기준을 **최댓값이 아니라 상위 0.1% 값**으로 잡는다.
    클릭음 하나가 전체 기준을 망치지 않는다.
  · 문턱을 **절대값이 아니라 상대값**으로 둔다(정규화 크기의 1/40).
    ★우리 무음 게이트는 절대 RMS 0.005 를 쓴다 — 녹음이 작게 들어오면 흔들린다.
    여기서는 같은 실수를 하지 않는다.
  · **짧은 소리 덩어리(0.1초 미만)는 소리로 세지 않는다** — 클릭·잡음 때문에
    무음이 조각나면 스냅할 경계가 사라진다.
  · 구간이 무음을 **통째로 품고 있을 때**는 양쪽 중 덜 삐져나온 쪽만 고치되,
    기준이 절대 시간이 아니라 **삐져나온 길이 ÷ 무음 길이** 다.
  · 무음이 **둘 이상** 들어 있으면 손대지 않는다 — 여러 말이 든 구간이라
    어느 쪽 경계로 밀어야 할지 알 수 없다.
  · 어떤 경우에도 **최소 길이 아래로 줄이지 않는다.**

이 파일은 **계산만** 한다. 모델을 쓰지 않는다. 소리 배열을 받아 숫자를 돌려준다.
"""
import numpy as np

UNIT_SEC = 0.02            # 한 칸 = 20밀리초(위스퍼 시각 눈금)
PEAK_FRACTION = 0.001      # 크기 기준으로 삼을 상위 비율(0.1%)
PEAK_HEADROOM = 1.75       # 그 값의 몇 배를 '가득 참' 으로 볼지
LEVEL_STEPS = 20           # 크기를 몇 단으로 나눌지 → 문턱 = 0.5/20 = 0.025
SMOOTH_UNITS = 5           # 문지르는 창(홀수). 5 = 앞뒤 40밀리초
MIN_SOUND_SEC = 0.10       # 이보다 짧은 소리 덩어리는 소리로 세지 않는다
MIN_SILENCE_SEC = 0.10     # 이보다 짧은 무음은 스냅 대상으로 보지 않는다
MIN_DUR_SEC = 0.10         # 밀고 나서도 남겨야 할 최소 길이
NONSPEECH_ERROR = 0.10     # 삐져나온 길이 ÷ 무음 길이 허용치

# ★한 번에 이만큼보다 많이 밀지 않는다(2026-09-22, 실측으로 정함).
#   노래 한 곡(견줄 수 있는 구간 16개)으로 재 보니 상한이 없으면
#   중앙 오차는 490 → 400밀리초로 좋아지는데 **상위10%가 800 → 1290밀리초로 나빠졌다.**
#   크게 밀린 것을 들여다보니 한 구간(#22)은 실제 소리가 139.04초에 시작하는데
#   말한 시각 139.14 를 139.84 로 **0.8초나 지나쳐** 밀고 있었다 —
#   숨소리처럼 여린 시작을 무음 지도가 무음으로 본 것이다.
#   0.40초로 묶으면 중앙 490 → 460, 꼬리는 그대로다. **나빠지는 것이 없다.**
MAX_SHIFT_SEC = 0.40

REDUCE_PEAK = 'peak'
REDUCE_RMS = 'rms'


def loudness_map(y, sr, unit_sec=UNIT_SEC, reduce=REDUCE_PEAK):
    """소리를 한 칸당 값 하나로 줄이고 **상위 0.1% 기준으로 정규화**한다.

    reduce='peak' — 한 칸 안의 가장 큰 값. 말이 시작하는 자리에 빠르게 반응한다.
    reduce='rms'  — 한 칸 안의 실효값. 더 차분하지만 시작을 늦게 잡는다.
    ★어느 쪽이 나은지는 재 보고 정한다. 그래서 고를 수 있게 뒀다.

    돌려주는 것: 0~1 언저리의 1차원 배열(넘칠 수 있다). 잴 수 없으면 길이 0.
    """
    y = np.asarray(y, dtype=np.float64)
    if y.ndim > 1:
        y = y.mean(axis=1)
    n = max(1, int(round(sr * unit_sec)))
    usable = (len(y) // n) * n
    if usable <= 0:
        return np.zeros(0)
    frames = np.abs(y[:usable]).reshape(-1, n)
    if reduce == REDUCE_RMS:
        loud = np.sqrt((frames ** 2).mean(axis=1))
    else:
        loud = frames.max(axis=1)

    # ★최댓값으로 나누지 않는다 — 클릭음 하나가 기준이 되면 나머지가 전부 조용해진다.
    flat = np.abs(y[:usable])
    k = int(flat.size * PEAK_FRACTION)
    ref = np.partition(flat, -k)[-k] if k >= 1 else float(np.max(flat) if flat.size else 0.0)
    scale = min(1.0, float(ref) * PEAK_HEADROOM)
    if scale <= 1e-9:
        return np.zeros(len(loud))
    return loud / scale


def _smooth(values, window=SMOOTH_UNITS):
    """가장자리를 되비쳐 채우고 옮김평균. 한 칸 빠진 것 때문에 무음이 조각나지 않게."""
    if window <= 1 or len(values) < 3:
        return values
    if window % 2 == 0:
        raise ValueError('문지르는 창은 홀수여야 합니다: %r' % (window,))
    pad = window // 2
    if pad >= len(values):
        pad = len(values) - 1
        window = pad * 2 + 1
    if window <= 1:
        return values
    padded = np.pad(values, pad, mode='reflect')
    kernel = np.ones(window) / window
    return np.convolve(padded, kernel, mode='valid')


def _runs(mask):
    """참인 구간의 (시작칸, 끝칸) 목록. 끝칸은 열린 끝이다."""
    if not len(mask):
        return []
    edged = np.concatenate(([False], mask.astype(bool), [False]))
    starts = np.flatnonzero(~edged[:-2] & edged[1:-1])
    ends = np.flatnonzero(edged[1:-1] & ~edged[2:]) + 1
    return list(zip(starts.tolist(), ends.tolist()))


def sound_mask(loud, unit_sec=UNIT_SEC, window=SMOOTH_UNITS,
               level_steps=LEVEL_STEPS, min_sound_sec=MIN_SOUND_SEC):
    """어느 칸이 **소리**인가. 문턱은 상대값이다.

    크기를 level_steps 단으로 나눠 반올림해 0이 아니면 소리 —
    곧 정규화 크기가 0.5/level_steps 이상이면 소리다.
    """
    if not len(loud):
        return np.zeros(0, dtype=bool)
    sm = _smooth(np.asarray(loud, dtype=np.float64), window)
    mask = np.round(sm * level_steps) >= 1
    # ★짧은 소리 덩어리는 소리로 세지 않는다 — 클릭 하나로 무음이 조각나면
    #   밀어 붙일 경계가 사라진다.
    min_units = max(1, int(round(min_sound_sec / unit_sec)))
    for a, b in _runs(mask):
        if b - a < min_units:
            mask[a:b] = False
    return mask


def silence_spans(y, sr, *, unit_sec=UNIT_SEC, reduce=REDUCE_PEAK,
                  window=SMOOTH_UNITS, level_steps=LEVEL_STEPS,
                  min_sound_sec=MIN_SOUND_SEC, min_silence_sec=MIN_SILENCE_SEC):
    """무음 구간의 (시작초 배열, 끝초 배열). 무음이 없으면 빈 배열 둘."""
    loud = loudness_map(y, sr, unit_sec=unit_sec, reduce=reduce)
    mask = sound_mask(loud, unit_sec=unit_sec, window=window,
                      level_steps=level_steps, min_sound_sec=min_sound_sec)
    if not len(mask):
        return np.zeros(0), np.zeros(0)
    quiet = ~mask
    spans = [(a, b) for a, b in _runs(quiet)
             if (b - a) * unit_sec >= min_silence_sec]
    if not spans:
        return np.zeros(0), np.zeros(0)
    starts = np.array([a * unit_sec for a, _ in spans], dtype=float)
    ends = np.array([b * unit_sec for _, b in spans], dtype=float)
    return starts, ends


def snap_span(start, end, sil_starts, sil_ends, *,
              min_dur=MIN_DUR_SEC, nonspeech_error=NONSPEECH_ERROR, keep_end=None,
              max_shift=MAX_SHIFT_SEC):
    """한 구간의 시각을 무음 경계에 맞춰 민다.

    keep_end=True  — 시작만 고친다
    keep_end=False — 끝만 고친다
    keep_end=None  — 둘 중 **덜 삐져나온 쪽**을 고친다(기본)
    max_shift      — 이보다 많이 밀어야 한다면 **밀지 않는다**(None 이면 상한 없음).
                     여린 시작을 무음으로 잘못 보는 경우를 막는다. 실측 근거는 위 상수 설명.

    돌려주는 것: (새 시작, 새 끝, 무엇을 옮겼는지 문구 또는 '')
    """
    def _ok(distance):
        return max_shift is None or distance <= max_shift + 1e-9
    s, e = float(start), float(end)
    if e - s <= min_dur or not len(sil_starts):
        return s, e, ''
    ss = np.asarray(sil_starts, dtype=float)
    se = np.asarray(sil_ends, dtype=float)

    # ① 시작이 무음 **안에** 있고 그 무음이 이 구간 안에서 끝난다 → 무음 끝으로 민다
    if keep_end is None or keep_end:
        hit = np.flatnonzero((ss <= s) & (s < se) & (se <= e))
        if len(hit):
            new_s = min(float(se[hit[0]]), round(e - min_dur, 3))
            if new_s > s and _ok(new_s - s):
                return new_s, e, 'start'

    # ② 끝이 무음 안에 있고 그 무음이 이 구간 안에서 시작한다 → 무음 시작으로 당긴다
    if keep_end is None or not keep_end:
        hit = np.flatnonzero((s <= ss) & (ss < e) & (e <= se))
        if len(hit):
            new_e = max(float(ss[hit[0]]), round(s + min_dur, 3))
            if new_e < e and _ok(e - new_e):
                return s, new_e, 'end'

    # ③ 구간이 무음을 통째로 품었다
    if nonspeech_error:
        inside = np.flatnonzero((s <= ss) & (e >= se))
        # ★무음이 둘 이상이면 손대지 않는다 — 여러 말이 든 구간이라
        #   어느 경계로 밀어야 할지 알 수 없다.
        if len(inside) != 1:
            return s, e, ''
        i = int(inside[0])
        dur = float(se[i] - ss[i])
        if dur <= 0:
            return s, e, ''
        start_err = (float(ss[i]) - s) / dur     # 무음 앞에 얼마나 삐져나왔나
        end_err = (e - float(se[i])) / dur       # 무음 뒤에 얼마나 삐져나왔나
        fix_start = keep_end if keep_end is not None else (start_err <= end_err)
        if fix_start and start_err <= nonspeech_error:
            new_s = min(float(se[i]), round(e - min_dur, 3))
            if new_s > s and _ok(new_s - s):
                return new_s, e, 'start'
        if (not fix_start) and end_err <= nonspeech_error:
            new_e = max(float(ss[i]), round(s + min_dur, 3))
            if new_e < e and _ok(e - new_e):
                return s, new_e, 'end'
    return s, e, ''


def snap_segments(segments, sil_starts, sil_ends, *,
                  min_dur=MIN_DUR_SEC, nonspeech_error=NONSPEECH_ERROR,
                  keep_end=None, words=True, max_shift=MAX_SHIFT_SEC):
    """구간(과 낱말) 시각을 제자리에서 민다. 한 일을 돌려준다.

    ★시각만 건드린다. 글은 손대지 않는다.
    ★구간 차례를 흔들지 않는다 — 민 결과가 앞뒤와 엇갈리면 그 구간은 되돌린다.
    """
    moved_start = moved_end = 0
    shifts = []
    prev_end = None
    for seg in (segments or []):
        s0 = float(seg.get('start') or 0.0)
        e0 = float(seg.get('end') or 0.0)
        s1, e1, what = snap_span(s0, e0, sil_starts, sil_ends,
                                 min_dur=min_dur, nonspeech_error=nonspeech_error,
                                 keep_end=keep_end, max_shift=max_shift)
        if what and prev_end is not None and s1 < prev_end - 1e-6:
            what = ''                       # 앞 구간과 엇갈린다 — 되돌린다
        if what:
            seg['start'], seg['end'] = s1, e1
            shifts.append(abs((s1 - s0) if what == 'start' else (e1 - e0)))
            if what == 'start':
                moved_start += 1
            else:
                moved_end += 1
        prev_end = float(seg.get('end') or e0)

        if words:
            for w in (seg.get('words') or []):
                if w.get('start') is None or w.get('end') is None:
                    continue
                ws, we, wwhat = snap_span(float(w['start']), float(w['end']),
                                          sil_starts, sil_ends, min_dur=min_dur,
                                          nonspeech_error=nonspeech_error,
                                          keep_end=keep_end, max_shift=max_shift)
                if wwhat:
                    w['start'], w['end'] = ws, we

    return {
        'moved_start': moved_start,
        'moved_end': moved_end,
        'median_shift': float(np.median(shifts)) if shifts else 0.0,
        'max_shift': float(np.max(shifts)) if shifts else 0.0,
        'silences': int(len(sil_starts)),
    }
