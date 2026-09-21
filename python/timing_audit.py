# -*- coding: utf-8 -*-
"""알아듣기가 말하는 시각이 실제 소리와 얼마나 어긋나는지 잰다.

왜(2026-09-21): 자막 시각도, 더빙 줄의 자리도, 전부 알아듣기가 준 구간 시각을 믿고 놓인다.
그런데 그 시각이 발화 단위라 수 초까지 틀린다는 것이 알려져 있다(WhisperX 가 존재하는 이유).
**믿을 만한지 재 보지도 않고 쓰고 있었다.**

어떻게 재는가: 모델을 더 들이지 않는다.
갈라낸 보컬은 대사 사이가 조용하므로, **소리가 실제로 커지는 자리**를 찾아
알아듣기가 말한 시작 시각과 견준다. 끝도 같은 방법으로 본다.

함께 보는 것: 알아듣기가 준 **낱말 시각**과 구간 시각이 서로 맞는가.
낱말 시각이 이미 정확하다면 정렬 모델을 새로 들일 필요가 없다.

실행:
  <앱파이썬> -X utf8 python/timing_audit.py --audio <보컬> --transcript <transcript.json>
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 이 배수보다 커지면 '소리가 시작됐다' 고 본다(그 구간 조용한 부분 대비).
ONSET_RATIO = 3.0
# 시작 시각 앞뒤로 이만큼만 본다. 너무 넓으면 옆 대사를 잡는다.
SEARCH_SEC = 1.5
FRAME_SEC = 0.02


def frame_energy(y, sr, frame_sec=FRAME_SEC):
    import numpy as np
    n = max(1, int(sr * frame_sec))
    usable = (len(y) // n) * n
    if usable <= 0:
        return np.zeros(0), frame_sec
    return np.sqrt((y[:usable].reshape(-1, n) ** 2).mean(axis=1)), frame_sec


def find_onset(energy, frame_sec, at_sec, search_sec=SEARCH_SEC, ratio=ONSET_RATIO):
    """at_sec 둘레에서 소리가 실제로 커지는 자리. 못 찾으면 None."""
    import numpy as np
    lo = max(0, int((at_sec - search_sec) / frame_sec))
    hi = min(len(energy), int((at_sec + search_sec) / frame_sec))
    if hi - lo < 3:
        return None
    win = energy[lo:hi]
    floor = float(np.percentile(win, 20))
    if floor <= 1e-9:
        floor = float(np.mean(win)) * 0.1
    if floor <= 1e-9:
        return None
    above = np.flatnonzero(win > floor * ratio)
    if not len(above):
        return None
    return (lo + int(above[0])) * frame_sec


MIN_GAP_SEC = 0.5   # 앞 구간이 이만큼 먼저 끝나야 '빈 자리' 로 본다


def audit(audio_path, segments, *, search_sec=SEARCH_SEC, min_gap=MIN_GAP_SEC):
    """구간마다 (알아듣기가 말한 시작, 실제 소리 시작, 차이)를 모은다.

    ★앞에 **진짜 빈 자리가 있는 구간만** 잰다.
      2026-09-21: 처음엔 모든 구간을 쟀는데, 노래는 보컬이 끊기지 않아
      '조용하다가 커지는 자리' 라는 전제가 성립하지 않았다.
      탐색 창 끝에 값이 몰려(중앙 1460 · 최대 1520밀리초, 창이 1500밀리초)
      **측정이 포화된 것**을 숫자 모양으로 알아챘다. 그런 값은 버린다.
    """
    import numpy as np
    import librosa
    y, sr = librosa.load(audio_path, sr=16000, mono=True)
    energy, frame_sec = frame_energy(y, sr)

    rows = []
    prev_end = 0.0
    for i, seg in enumerate(segments):
        start = float(seg.get('start') or 0.0)
        gap = start - prev_end
        prev_end = float(seg.get('end') or start)
        if gap < min_gap:
            continue                     # 잴 수 있는 빈 자리가 없다
        onset = find_onset(energy, frame_sec, start, min(search_sec, gap * 0.9))
        words = seg.get('words') or []
        first_word = float(words[0]['start']) if words and words[0].get('start') is not None else None
        rows.append({
            'index': i,
            'said': start,
            'onset': onset,
            'offset': (onset - start) if onset is not None else None,
            'first_word': first_word,
            'word_gap': (first_word - start) if first_word is not None else None,
        })
    return rows


def summarize(rows):
    import numpy as np
    offs = [abs(r['offset']) for r in rows if r['offset'] is not None]
    gaps = [abs(r['word_gap']) for r in rows if r['word_gap'] is not None]
    out = {'measured': len(offs), 'total': len(rows)}
    if offs:
        out.update({
            'median_err': float(np.median(offs)),
            'p90_err': float(np.percentile(offs, 90)),
            'max_err': float(np.max(offs)),
            'over_300ms': sum(1 for x in offs if x > 0.3),
            'over_1s': sum(1 for x in offs if x > 1.0),
        })
    if gaps:
        out['median_word_gap'] = float(np.median(gaps))
        out['max_word_gap'] = float(np.max(gaps))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', required=True)
    ap.add_argument('--transcript', required=True)
    args = ap.parse_args()

    with open(args.transcript, encoding='utf-8') as f:
        data = json.load(f)
    segs = data.get('raw_segments') or data.get('segments') or []
    if not segs:
        print('구간이 없다')
        return

    rows = audit(args.audio, segs)
    s = summarize(rows)
    print('구간 %d개 중 **앞에 빈 자리가 있는** %d개를 골라 %d개를 쟀다'
          % (len(segs), s['total'], s['measured']))
    if s['measured'] < 5:
        print('★잴 수 있는 구간이 너무 적다 — 이 재료로는 판단할 수 없다.')
        return
    if 'median_err' in s:
        print()
        print('알아듣기가 말한 시작 vs 실제 소리 시작')
        print('   중앙 오차 %.0f밀리초 · 상위10%% %.0f밀리초 · 최대 %.0f밀리초'
              % (s['median_err'] * 1000, s['p90_err'] * 1000, s['max_err'] * 1000))
        print('   0.3초 넘게 어긋난 구간 %d개 · 1초 넘게 %d개'
              % (s['over_300ms'], s['over_1s']))
    if 'median_word_gap' in s:
        print()
        print('구간 시작 vs 그 구간 첫 낱말 시각')
        print('   중앙 %.0f밀리초 · 최대 %.0f밀리초'
              % (s['median_word_gap'] * 1000, s['max_word_gap'] * 1000))
        print('   ★이 값이 작으면 낱말 시각이 구간 시각과 같은 말을 한다는 뜻이다.')
    print()
    print('★소리 시작 찾기는 어림이다 — 숨소리나 반주 잔재를 말의 시작으로 볼 수 있다.')
    print('  절대값보다 **얼마나 크게 어긋나는 구간이 있는가**를 본다.')


if __name__ == '__main__':
    main()
