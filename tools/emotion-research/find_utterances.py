# -*- coding: utf-8 -*-
"""가져온 음원에서 **발화 구간의 시각만** 찾는다.

내용을 판단하지 않는다. 소리 크기(RMS)로 말이 있는 구간과 조용한 구간을 가르고
시작·끝·길이만 돌려준다. 어느 구간이 감정이 실렸는지는 사람이 듣고 정한다.
"""
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

SRC = Path(sys.argv[1])
SILENCE_DB = float(sys.argv[2]) if len(sys.argv) > 2 else -32.0
MIN_SPEECH = 1.0          # 이보다 짧은 덩어리는 말로 세지 않는다
MIN_GAP = 0.30            # 이보다 짧은 무음은 구간을 가르지 않는다(어절 사이 숨)
FRAME_MS = 20.0

x, fs = sf.read(str(SRC), dtype="float64")
mono = x.mean(axis=1) if x.ndim > 1 else x
hop = int(fs * FRAME_MS / 1000)
n = mono.size // hop
rms = np.array([np.sqrt(np.mean(mono[i * hop:(i + 1) * hop] ** 2)) for i in range(n)])
ref = np.quantile(rms[rms > 0], 0.95) if np.any(rms > 0) else 1e-9
db = 20 * np.log10(np.maximum(rms, 1e-12) / ref)
loud = db > SILENCE_DB

# 짧은 무음은 메워서 한 발화가 조각나지 않게 한다.
gap_frames = int(MIN_GAP * 1000 / FRAME_MS)
i = 0
while i < n:
    if not loud[i]:
        j = i
        while j < n and not loud[j]:
            j += 1
        if i > 0 and j < n and (j - i) < gap_frames:
            loud[i:j] = True
        i = j
    else:
        i += 1

runs, s = [], None
for i, v in enumerate(loud):
    if v and s is None: s = i
    elif not v and s is not None: runs.append((s, i)); s = None
if s is not None: runs.append((s, n))

segs = [(a * FRAME_MS / 1000, b * FRAME_MS / 1000) for a, b in runs
        if (b - a) * FRAME_MS / 1000 >= MIN_SPEECH]

print(f"전체 {mono.size / fs:.2f}초 · {fs}Hz · 발화 후보 {len(segs)}개")
for k, (a, b) in enumerate(segs, 1):
    fa, fb = int(a * fs), int(b * fs)
    peak = float(np.abs(mono[fa:fb]).max())
    seg_rms = float(np.sqrt(np.mean(mono[fa:fb] ** 2)))
    print(f"  {k:2d}.  {a:6.2f} ~ {b:6.2f}초   길이 {b - a:5.2f}초   "
          f"평균크기 {20 * np.log10(max(seg_rms, 1e-12)):6.1f}dB  최대 {peak:.3f}")
