# -*- coding: utf-8 -*-
"""톡 튀는 소리만 골라 없앤다 — 파라미터 사냥 대신 들리는 것을 직접 고친다.

변환 결과에 순간적으로 튀는 소리("톡톡", "지직")가 섞인다. 파라미터를 바꿔 가며 찾으려
했지만 실행 간 편차가 커서 1회 비교로 가려지지 않았다. 그래서 **결과를 고친다.**

방법은 좁고 보수적이다.
  · 인접 샘플 변화량이 **주변 50ms 평균의 N배**를 넘는 자리만 후보로 본다.
  · 그 자리에서 **1.5ms 만** 잘라내고 양옆을 이어 붙인다(3차 보간).
  · 그 밖의 구간은 **한 샘플도 건드리지 않는다.**

말소리의 파열음(ㅂㄷㄱㅊㅋㅌㅍ)도 순간적으로 튄다. 그래서 문턱을 낮게 잡으면 발음을 뭉갠다.
기본값은 **원본 TTS 에서 관측된 최대 돌출도(11.4)보다 높게** 잡았다 — 정상 발음은 남기고
변환이 만든 것만 건드리기 위해서다.
"""
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])
THRESH = float(sys.argv[3]) if len(sys.argv) > 3 else 14.0   # 주변 대비 돌출도
REPAIR_MS = 1.5
LOCAL_MS = 50.0


def prominence(d, fs):
    w = max(1, int(fs * LOCAL_MS / 1000))
    local = np.convolve(d, np.ones(w) / w, mode="same") + 1e-12
    return d / local


def declick(x, fs, thresh):
    y = x.copy()
    d = np.abs(np.diff(x))
    r = prominence(d, fs)
    hits = np.flatnonzero(r > thresh)
    if hits.size == 0:
        return y, 0
    half = max(2, int(fs * REPAIR_MS / 2000))
    # 붙어 있는 검출은 한 덩어리로 처리한다(같은 클릭을 여러 번 손대지 않는다).
    groups, cur = [], [hits[0]]
    for i in hits[1:]:
        if i - cur[-1] <= half: cur.append(i)
        else: groups.append(cur); cur = [i]
    groups.append(cur)

    n = x.size
    for g in groups:
        c = int(np.mean(g))
        a, b = max(1, c - half), min(n - 2, c + half)
        if b - a < 2: continue
        # 양옆 실제 샘플로 3차 보간 — 무음을 넣지 않는다(무음도 클릭으로 들린다).
        left = np.arange(max(0, a - 4), a)
        right = np.arange(b + 1, min(n, b + 5))
        if left.size < 2 or right.size < 2: continue
        xs = np.concatenate([left, right])
        ys = x[xs]
        y[a:b + 1] = np.interp(np.arange(a, b + 1), xs, ys)
    return y, len(groups)


def report(x, fs, label):
    d = np.abs(np.diff(x))
    r = prominence(d, fs)
    top = np.sort(r)[::-1]
    print("  %-14s 돌출도 상위100 %5.1f  최대 %5.1f  최고진폭 %.3f"
          % (label, top[:100].mean(), top[0], float(np.abs(x).max())))


def main():
    x, fs = sf.read(str(SRC), dtype="float64")
    m = x.mean(axis=1) if x.ndim > 1 else x
    report(m, fs, "처리 전")
    y, n = declick(m, fs, THRESH)
    report(y, fs, "처리 후")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(OUT), y, fs, subtype="PCM_16")
    dur = m.size / fs
    print("  고친 자리 %d곳 (초당 %.1f) · 손댄 시간 총 %.1fms / 전체 %.2f초 = %.4f%%"
          % (n, n / dur, n * REPAIR_MS, dur, 100 * n * REPAIR_MS / 1000 / dur))


if __name__ == "__main__":
    main()
