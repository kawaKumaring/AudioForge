# -*- coding: utf-8 -*-
"""변환 잡음이 어느 단계에서 생기는가 — 기존 산출물만 대조한다 (생성·GPU 없음).

입력(변환 전)과 출력(변환 후)을 **같은 시간축**에 놓고(length_adjust 1.0 이라 길이가 보존된다)
24kHz 모노로 맞춘 뒤 같은 지표로 잰다. 절대값이 아니라 **입력→출력 변화량**을 본다 —
절대값은 내용(외침인가 낭독인가)에 좌우되어 경로 사이 비교가 되지 않는다(§6.19e).

지표 정의
  HNR     : 유성 프레임(pyin 으로 F0 가 잡힌 40ms 창)의 자기상관 기반 조화-대-잡음비(dB).
            F0 주기 근처(0.8~1.2배) 정규화 자기상관 최대값 r 로 10·log10(r/(1−r)).
  잔여%    : HPSS(margin 2.0)로 조화·타악 성분을 뺀 나머지 에너지 / 전체. '쉿' 계열 광대역 잡음 비율.
  음량편차  : 100ms 창 RMS(dB) 포락선의 출력−입력 차이(평균 제거)의 표준편차. 말하는 창(−40dB 이상)만.
            클수록 출력의 강약 굴곡이 입력과 다르게 울퉁불퉁하다.
  F0 |Δ|  : 유성 프레임별 출력/입력 음높이 차이(반음) 중앙값. 0 에 가까우면 음높이를 그대로 따라간 것.

한계
  · pyin·HPSS 는 근사다. 같은 정의로 잰 값끼리만 비교한다. 다른 문서의 수치와 섞지 않는다.
  · 시간 정렬은 길이 보존을 전제로 한 것이며 프레임 단위 재정렬을 하지 않았다.
  · 청취 인상(지직·톡톡·기계음)이 이 지표에 잡힌다는 보장은 없다. 지표는 방향 확인용이다.

사용
  python noise_stage_compare.py <입력.wav> <출력.wav> [시작초 끝초]   (시각은 입력 기준)
"""
import sys

import numpy as np
import soundfile as sf
import librosa

FS = 24000


def load24(p):
    x, sr = sf.read(p, dtype="float64")
    m = x.mean(axis=1) if x.ndim > 1 else x
    return librosa.resample(m, orig_sr=sr, target_sr=FS) if sr != FS else m


def f0track(y):
    f0, _, _ = librosa.pyin(y, fmin=80, fmax=600, sr=FS, frame_length=1024, hop_length=240)
    return f0


def hnr(y, f0, hop=240, win=960):
    out = []
    for i, f in enumerate(f0):
        c = i * hop
        seg = y[max(0, c - win // 2):c + win // 2]
        if seg.size < win or not np.isfinite(f) or f <= 0:
            out.append(np.nan)
            continue
        seg = seg - seg.mean()
        ac = np.correlate(seg, seg, "full")[seg.size - 1:]
        ac /= (ac[0] + 1e-12)
        lag = int(round(FS / f))
        lo, hi = max(2, int(lag * 0.8)), min(ac.size - 1, int(lag * 1.2))
        r = min(max(ac[lo:hi].max(), 1e-4), 0.9999)
        out.append(10 * np.log10(r / (1 - r)))
    return np.array(out)


def resid(y, hop=240):
    D = librosa.stft(y, n_fft=1024, hop_length=hop)
    H, P = librosa.decompose.hpss(D, margin=2.0)
    tot = (np.abs(D) ** 2).sum(axis=0) + 1e-20
    return 100 * np.clip(tot - (np.abs(H) ** 2).sum(axis=0) - (np.abs(P) ** 2).sum(axis=0), 0, None) / tot


def env(y, w=2400):
    n = y.size // w
    return 20 * np.log10(np.sqrt((y[:n * w].reshape(n, w) ** 2).mean(axis=1)) + 1e-12)


def compare(label, pin, pout, a=0.0, b=None):
    x, y = load24(pin), load24(pout)
    n = min(x.size, y.size)
    x, y = x[:n], y[:n]
    if b is not None:
        x, y = x[int(a * FS):int(b * FS)], y[int(a * FS):int(b * FS)]
    f0x, f0y = f0track(x), f0track(y)
    m = min(f0x.size, f0y.size)
    f0x, f0y = f0x[:m], f0y[:m]
    hx, hy = hnr(x, f0x)[:m], hnr(y, f0y)[:m]
    rx, ry = resid(x)[:m], resid(y)[:m]
    v = np.isfinite(f0x) & np.isfinite(f0y) & np.isfinite(hx) & np.isfinite(hy)
    vx = np.isfinite(f0x)
    ex, ey = env(x), env(y)
    k = min(ex.size, ey.size)
    ex, ey = ex[:k], ey[:k]
    sp = ex > -40
    d = (ey - ex)[sp]
    d = d - d.mean()
    df0 = np.abs(12 * np.log2(f0y[v] / f0x[v]))
    print("%-36s 유성 %3d프레임 | HNR %5.1f → %5.1f dB (Δ중앙 %5.1f, 3dB이상 손실 %3.0f%%) | 잔여%% 유성 %4.1f→%4.1f 무성 %4.1f→%4.1f"
          " | 음량편차 σ %4.1f dB (5dB초과 %3.0f%%) | F0 |Δ| %5.2f반음 (1반음초과 %3.0f%%)"
          % (label, v.sum(), np.median(hx[v]), np.median(hy[v]), np.median(hy[v] - hx[v]), 100 * np.mean((hy[v] - hx[v]) < -3),
             np.median(rx[vx]), np.median(ry[vx]), np.median(rx[~vx]), np.median(ry[~vx]),
             d.std(), 100 * np.mean(np.abs(d) > 5), np.median(df0), 100 * np.mean(df0 > 1)))


if __name__ == "__main__":
    if len(sys.argv) >= 5:
        compare("비교", sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]))
    else:
        compare("비교", sys.argv[1], sys.argv[2])
