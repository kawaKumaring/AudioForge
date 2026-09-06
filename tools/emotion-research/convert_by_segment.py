# -*- coding: utf-8 -*-
"""말하는 구간만 변환하고 쉼은 원본을 그대로 둔다.

사용자가 짚은 자리(이오몽 5~6초)를 재 보니 **긴 쉼 직후 발성이 재개되는 경계**였다.
원본 3.0~5.0초가 거의 무음(유성 0%, −44~−56dB)이고 5.0초부터 말이 다시 시작된다.

f0 조건 변환기는 음높이 궤적을 따라간다. 무음 구간에는 음높이가 없어서 0 이고,
경계에서 0 → 350Hz 로 튄다. 그 도약에서 흔들림이 생긴다.
자동 음높이 보정이 음역을 밀어 올리는 화자(이오몽 +5.5반음)는 도약이 더 커진다.

그래서 **경계를 없앤다** — 발성 덩어리만 따로 변환하고, 쉼은 원본에서 그대로 옮긴다.
쉼에는 숨소리·한숨이 들어 있고 사용자가 그것을 좋게 들었으므로 **지우지 않는다**.
숨소리는 대부분 무성음이라 화자 정체성을 거의 싣지 않는다.

부수 효과로 변환할 길이가 줄어 처리 시간도 짧아진다.
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

SRC = Path(sys.argv[1])
TARGET = Path(sys.argv[2])
OUT = Path(sys.argv[3])
SEEDVC = Path(sys.argv[4])
PYEXE = Path(sys.argv[5])
STEPS = sys.argv[6] if len(sys.argv) > 6 else "30"
CFG = sys.argv[7] if len(sys.argv) > 7 else "0.7"
AUTO_F0 = sys.argv[8] if len(sys.argv) > 8 else "False"

SILENCE_DB = -38.0      # 이보다 조용하면 쉼으로 본다
MIN_SIL = 0.35          # 이보다 짧은 조용함은 발화 안의 숨 — 자르지 않는다
PAD = 0.05              # 덩어리 앞뒤로 조금 남겨 말머리·말끝이 잘리지 않게


def speech_spans(m, fs):
    w = int(fs * 0.02)
    n = m.size // w
    rms = np.array([np.sqrt(np.mean(m[i * w:(i + 1) * w] ** 2)) for i in range(n)])
    ref = np.quantile(rms[rms > 0], 0.95) if np.any(rms > 0) else 1e-9
    loud = 20 * np.log10(np.maximum(rms, 1e-12) / ref) > SILENCE_DB
    gap = int(MIN_SIL / 0.02)
    i = 0
    while i < n:                       # 짧은 조용함은 메워서 한 덩어리로 둔다
        if not loud[i]:
            j = i
            while j < n and not loud[j]:
                j += 1
            if i > 0 and j < n and (j - i) < gap:
                loud[i:j] = True
            i = j
        else:
            i += 1
    spans, s = [], None
    for i, v in enumerate(loud):
        if v and s is None: s = i
        elif not v and s is not None: spans.append((s * 0.02, i * 0.02)); s = None
    if s is not None: spans.append((s * 0.02, n * 0.02))
    return [(max(0.0, a - PAD), min(m.size / fs, b + PAD)) for a, b in spans]


def main():
    x, fs = sf.read(str(SRC), dtype="float64")
    m = x.mean(axis=1) if x.ndim > 1 else x
    spans = speech_spans(m, fs)
    print("발성 덩어리 %d개:" % len(spans),
          ", ".join("%.2f~%.2f초" % s for s in spans))

    work = OUT.parent / (OUT.stem + "_work")
    work.mkdir(parents=True, exist_ok=True)
    pieces = []
    for k, (a, b) in enumerate(spans):
        p = work / ("piece_%02d.wav" % k)
        sf.write(str(p), m[int(a * fs):int(b * fs)], fs, subtype="PCM_16")
        d = work / ("out_%02d" % k)
        subprocess.run([str(PYEXE), "inference.py", "--source", str(p.resolve()),
                        "--target", str(TARGET), "--output", str(d.resolve()),
                        "--diffusion-steps", STEPS, "--length-adjust", "1.0",
                        "--inference-cfg-rate", CFG, "--f0-condition", "True",
                        "--auto-f0-adjust", AUTO_F0, "--semi-tone-shift", "0",
                        "--fp16", "True"], cwd=str(SEEDVC), check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        got = sorted(d.glob("*.wav"))
        if not got:
            raise RuntimeError("변환 산출 없음: %s" % d)
        y, ysr = sf.read(str(got[0]), dtype="float64")
        pieces.append((a, b, y.mean(axis=1) if y.ndim > 1 else y, ysr))
        print("  %.2f~%.2f초 → %.2f초 (%dHz)" % (a, b, pieces[-1][2].size / ysr, ysr))

    osr = pieces[0][3]
    # 원본 타이밍 그대로 재조립. 쉼은 **원본을 옮긴다**(숨소리·한숨을 지우지 않는다).
    total = int(m.size / fs * osr)
    src_rs = np.interp(np.linspace(0, m.size - 1, total), np.arange(m.size), m)
    out = src_rs.copy()          # 바탕은 원본 — 이음매에서 무음이 생기지 않는다

    # 변환 조각의 **가장자리는 버린다.** 모델 출력은 시작·끝 수십 ms 가 불안정하고,
    # 실측에서 그 자리에 583Hz·87Hz 같은 엉뚱한 음높이가 나왔다(조각 경계 아티팩트).
    # 버린 만큼은 앞서 PAD 로 여유를 뒀으므로 말이 잘리지 않는다.
    trim = int(osr * 0.030)      # 30ms
    fade = int(osr * 0.020)      # 20ms 교차 페이드
    ramp = np.linspace(0.0, 1.0, fade)
    for a, b, y, ysr in pieces:
        if y.size <= 2 * (trim + fade):
            continue
        z = y[trim:y.size - trim]
        i0 = int(a * osr) + trim
        i1 = min(total, i0 + z.size)
        z = z[:i1 - i0]
        if z.size <= 2 * fade:
            continue
        seg = out[i0:i1].copy()
        merged = z.copy()
        merged[:fade] = seg[:fade] * (1 - ramp) + z[:fade] * ramp          # 들어갈 때
        merged[-fade:] = seg[-fade:] * ramp + z[-fade:] * (1 - ramp)       # 나올 때
        out[i0:i1] = merged
    OUT.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(OUT), out, osr, subtype="PCM_16")
    print("완성:", OUT.resolve(), "%.2f초 %dHz" % (out.size / osr, osr))


if __name__ == "__main__":
    main()
