# -*- coding: utf-8 -*-
"""preview wav 의 정체 확인 — 2초가 어디에 붙었고 무엇인지."""
import json
import os

import numpy as np
import soundfile as sf
from scipy.signal import fftconvolve

SRC = r"E:\AudioForge_output\expressive-comparison\20260827-A2-emotion3"
EMO = ("happy", "angry", "sad")


def load(p):
    d, sr = sf.read(p, dtype="float32", always_2d=False)
    if d.ndim > 1:
        d = d.mean(axis=1)
    return np.asarray(d, np.float64), int(sr)


def running_energy(x, n):
    c = np.concatenate(([0.0], np.cumsum(x * x)))
    return c[n:] - c[:-n]


def ncc_scan(win, hay):
    n = win.size
    if hay.size < n:
        return 0.0, -1
    num = fftconvolve(hay, win[::-1], mode="valid")
    den = np.sqrt(running_energy(hay, n)) * np.sqrt(np.dot(win, win))
    den = np.where(den <= 1e-12, np.inf, den)
    r = num / den
    i = int(np.argmax(np.abs(r)))
    return float(np.abs(r[i])), i


def rms_track(x, sr, ms=100):
    n = int(sr * ms / 1000)
    k = x.size // n
    return np.array([float(np.sqrt(np.mean(x[i * n:(i + 1) * n] ** 2))) for i in range(k)])


ref, sr = load(os.path.join(SRC, "reference_clip.wav"))
out = {}
for e in EMO:
    pv, psr = load(os.path.join(SRC, f"{e}_preview.wav"))
    raw, rsr = load(os.path.join(SRC, f"{e}_raw.wav"))
    d = {"preview_sr": psr, "preview_samples": int(pv.size),
         "raw_samples": int(raw.size), "delta_samples": int(pv.size - raw.size)}
    # raw 가 preview 안 어디에 있는가
    p, lag = ncc_scan(raw, pv)
    d["raw_in_preview"] = {"ncc": round(p, 5), "lag_sec": round(lag / psr, 4)}
    if p > 0.99:
        head = pv[:lag]
        tail = pv[lag + raw.size:]
        d["head_sec"] = round(head.size / psr, 4)
        d["tail_sec"] = round(tail.size / psr, 4)
        d["exact_head_match"] = bool(np.allclose(pv[lag:lag + raw.size], raw, atol=2e-4))
        for nm, seg in (("head", head), ("tail", tail)):
            if seg.size == 0:
                continue
            hp, hl = ncc_scan(seg, ref) if seg.size <= ref.size else (0.0, -1)
            d[f"{nm}_stats"] = {
                "peak": round(float(np.abs(seg).max()), 5),
                "rms": round(float(np.sqrt(np.mean(seg ** 2))), 6),
                "all_zero": bool(np.all(seg == 0.0)),
                "ncc_vs_reference": round(hp, 5),
                "ncc_lag_in_ref_sec": round(hl / sr, 4),
            }
            # 참조 앞/뒤 2초와 직접 정렬 비교
            n = min(seg.size, ref.size)
            for tag, rseg in (("ref_head", ref[:n]), ("ref_tail", ref[-n:])):
                a, b = seg[:n], rseg
                den = np.sqrt(np.dot(a, a) * np.dot(b, b))
                d[f"{nm}_stats"][f"aligned_ncc_{tag}"] = round(
                    float(np.dot(a, b) / den) if den > 1e-12 else 0.0, 5)
            d[f"{nm}_stats"]["rms_track_100ms"] = [round(v, 4) for v in rms_track(seg, psr)]
    out[e] = d

print(json.dumps(out, ensure_ascii=False, indent=1))
