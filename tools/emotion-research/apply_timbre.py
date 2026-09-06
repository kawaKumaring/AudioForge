# -*- coding: utf-8 -*-
"""음색 축 적용 — 마지막 후처리 시도.

F0 중앙값 이동은 두 번 실패했다(§6.7, §6.16). 이번에는 **한 번도 걸지 않은 축**을 건다.

한국어 25쌍 측정(§measure_timbre):
  · **화남: 비주기성 +0.0336 — 25/25 전부 증가.** 지금까지 나온 것 중 가장 일관된 신호다.
  · 화남: spectral tilt +1.302 dB/decade (18/25)
  · 기쁨·슬픔: 두 축 모두 방향 없음 → 걸지 않는다.

만드는 것
  A 원본 · B 무변경 재합성(대조군)
  E 화남 전체  : F0(전체 −1.98 · 끝 −3.08) + 쉼 +0.465초 + **음색(비주기성·기울기)**
  F 음색만     : **비주기성·기울기만.** F0 도 쉼도 건드리지 않는다 → 새 축의 효과만 본다
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import pyworld as pw
import soundfile as sf

SRC = Path(sys.argv[1])
TIMINGS = Path(sys.argv[2])
OUT = Path(sys.argv[3])
OUT.mkdir(parents=True, exist_ok=True)

FRAME_MS = 5.0
SILENCE_BELOW_DB = -35.0
RAMP_MS = 150.0
TILT_LO_HZ, TILT_HI_HZ = 200.0, 5000.0

ANGRY_ALL_ST = -1.98
ANGRY_FINAL_ST = -3.08
ANGRY_PAUSE_SEC = +0.465
ANGRY_AP_DELTA = +0.0336          # 25/25
ANGRY_TILT_DELTA = +1.302         # 18/25, dB/decade


def frame_rms(x, fs, n):
    hop = int(round(fs * FRAME_MS / 1000)); win = hop * 4
    out = np.zeros(n)
    for i in range(n):
        c = i * hop; a, b = max(0, c - win // 2), min(x.size, c + win // 2)
        seg = x[a:b]
        out[i] = np.sqrt(np.mean(seg ** 2)) if seg.size else 0.0
    return out


def ramp_offsets(n, idx, base_st, final_st):
    off = np.full(n, base_st, dtype=float)
    ramp = max(1, int(round(RAMP_MS / FRAME_MS)))
    s = max(0, idx - ramp)
    if idx > s:
        off[s:idx] = np.linspace(base_st, final_st, idx - s)
    off[idx:] = final_st
    return off


def tilt_gain(freqs, delta_db_per_decade):
    """기울기를 delta 만큼 더하는 주파수별 이득(dB). 측정 대역 밖은 가장자리 값을 유지한다."""
    band = (freqs >= TILT_LO_HZ) & (freqs <= TILT_HI_HZ)
    fref = float(np.sqrt(TILT_LO_HZ * TILT_HI_HZ))          # 대역의 기하평균 = 회전 중심
    g = np.zeros_like(freqs)
    g[band] = delta_db_per_decade * (np.log10(np.maximum(freqs[band], 1.0)) - np.log10(fref))
    g[freqs < TILT_LO_HZ] = g[band][0] if band.any() else 0.0
    g[freqs > TILT_HI_HZ] = g[band][-1] if band.any() else 0.0
    return g


def main():
    wav = sorted(SRC.glob("*.wav"))[0] if SRC.is_dir() else SRC
    tim = json.loads(TIMINGS.read_text(encoding="utf-8"))[wav.name]
    words = tim["words"]
    t0 = time.perf_counter()

    x, fs = sf.read(str(wav), dtype="float64")
    if x.ndim > 1:
        x = x[:, 0]
    f0, t = pw.harvest(x, fs, frame_period=FRAME_MS)
    f0 = pw.stonemask(x, f0, t, fs)
    sp = pw.cheaptrick(x, f0, t, fs)
    ap = pw.d4c(x, f0, t, fs)
    voiced = f0 > 0
    n = f0.size
    freqs = np.linspace(0, fs / 2, sp.shape[1])
    final_start = min(max(0, int(round(words[-1]["start"] * 1000 / FRAME_MS))), n - 1)

    def timbre(sp_in, ap_in):
        """유성 프레임만 음색을 바꾼다. 무성 자음의 성질은 건드리지 않는다."""
        sp2, ap2 = sp_in.copy(), ap_in.copy()
        g_db = tilt_gain(freqs, ANGRY_TILT_DELTA)
        sp2[voiced] = sp2[voiced] * (10.0 ** (g_db / 10.0))[None, :]
        ap2[voiced] = np.clip(ap2[voiced] + ANGRY_AP_DELTA, 0.0, 1.0)
        return sp2, ap2

    def synth(off_st, use_timbre):
        g = f0.copy()
        if off_st is not None:
            g[voiced] = f0[voiced] * (2.0 ** (off_st[voiced] / 12.0))
        s2, a2 = timbre(sp, ap) if use_timbre else (sp, ap)
        y = pw.synthesize(g, s2, a2, fs, frame_period=FRAME_MS)
        return y[:x.size] if y.size >= x.size else np.pad(y, (0, x.size - y.size))

    y_b = synth(None, False)
    y_e = synth(ramp_offsets(n, final_start, ANGRY_ALL_ST, ANGRY_FINAL_ST), True)
    y_f = synth(None, True)

    # E 만 쉼을 넣는다(F 는 음색 하나만 보기 위해 시간축을 건드리지 않는다).
    rms = frame_rms(x, fs, n)
    ref = np.quantile(rms[rms > 0], 0.90) if np.any(rms > 0) else 1e-9
    silent = 20 * np.log10(np.maximum(rms, 1e-12) / ref) < SILENCE_BELOW_DB
    runs, s = [], None
    for i, v in enumerate(silent):
        if v and s is None: s = i
        elif not v and s is not None: runs.append((s, i)); s = None
    if s is not None: runs.append((s, n))
    inner = [(a, b) for a, b in runs if a != 0 and b != n]
    pause_info = {"inserted": False}
    if inner:
        a, b = max(inner, key=lambda r: r[1] - r[0])
        mid = int(round((a + b) / 2 * FRAME_MS / 1000 * fs))
        add = int(round(ANGRY_PAUSE_SEC * fs))
        y_e = np.concatenate([y_e[:mid], np.zeros(add), y_e[mid:]])
        pause_info = {"inserted": True, "at_sec": round(mid / fs, 3), "added_sec": round(add / fs, 3)}

    files = {"A_original": x, "B_resynth_unchanged": y_b,
             "E_angry_full": y_e, "F_timbre_only": y_f}
    for k, y in files.items():
        sf.write(str(OUT / f"{k}.wav"), y, fs, subtype="PCM_16")

    lm = OUT / "levelmatched"; lm.mkdir(exist_ok=True)
    rms_of = {k: float(np.sqrt(np.mean(v ** 2))) for k, v in files.items()}
    gains = {}
    for k, y in files.items():
        g = rms_of["A_original"] / rms_of[k]
        sf.write(str(lm / f"{k}.wav"), y * g, fs, subtype="PCM_16")
        gains[k] = {"gain_db": round(20 * np.log10(g), 3),
                    "peak_after": round(float(np.abs(y * g).max()), 4),
                    "clipped": int((np.abs(y * g) >= 0.999).sum())}

    # 재측정 — 음색이 실제로 바뀌었는지 확인한다.
    def remeasure(p):
        z, zfs = sf.read(str(p), dtype="float64")
        zf, zt = pw.harvest(z, zfs, frame_period=FRAME_MS)
        zf = pw.stonemask(z, zf, zt, zfs)
        zsp = pw.cheaptrick(z, zf, zt, zfs)
        zap = pw.d4c(z, zf, zt, zfs)
        v = zf > 0
        fr = np.linspace(0, zfs / 2, zsp.shape[1])
        band = (fr >= TILT_LO_HZ) & (fr <= TILT_HI_HZ)
        logf = np.log10(np.maximum(fr[band], 1.0))
        A = np.vstack([logf, np.ones_like(logf)]).T
        ts = []
        for i in np.flatnonzero(v):
            db = 10 * np.log10(np.maximum(zsp[i, band], 1e-20)); db -= db.mean()
            ts.append(np.linalg.lstsq(A, db, rcond=None)[0][0])
        return {"tilt": round(float(np.median(ts)), 3),
                "ap_mean": round(float(np.mean(zap[v][:, band])), 5)}

    base_m = remeasure(OUT / "A_original.wav")
    rep = {"source": wav.name, "text": tim["text"],
           "applied": {"tilt_delta_db_per_decade": ANGRY_TILT_DELTA,
                       "aperiodicity_delta": ANGRY_AP_DELTA,
                       "E_also": {"f0_all_st": ANGRY_ALL_ST, "f0_final_st": ANGRY_FINAL_ST,
                                  "pause": pause_info}},
           "measured": {"A_original": base_m}, "level_match": gains,
           "elapsed_sec": round(time.perf_counter() - t0, 3)}
    for k in ("B_resynth_unchanged", "E_angry_full", "F_timbre_only"):
        m = remeasure(OUT / f"{k}.wav")
        rep["measured"][k] = dict(m, tilt_delta_vs_A=round(m["tilt"] - base_m["tilt"], 3),
                                  ap_delta_vs_A=round(m["ap_mean"] - base_m["ap_mean"], 5))
    (OUT / "report.json").write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(rep["measured"], ensure_ascii=False, indent=2))
    print("elapsed", rep["elapsed_sec"], "초")


if __name__ == "__main__":
    main()
