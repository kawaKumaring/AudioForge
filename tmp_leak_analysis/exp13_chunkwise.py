# -*- coding: utf-8 -*-
"""1단계(GPU 불필요) — 혼입이 파일 첫머리뿐 아니라 **내부 조각마다** 반복되는지 확인.

지금까지는 파일 맨 앞 1.5~2초만 봤다. 각 raw 를 발화 조각으로 나눠 **모든 조각 시작부**를
참조 전체와 대조한다. 저장된 사용자 산출물은 읽기만 한다.
"""
import json
import os
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))
import reference_leakage as rl   # noqa: E402

SRC = r"E:\AudioForge_output\expressive-comparison\20260827-A2-emotion3"
EMO = ("happy", "angry", "sad")
OUT = os.path.join(HERE, "chunkwise")
os.makedirs(OUT, exist_ok=True)


def load(p):
    d, sr = sf.read(p, dtype="float32", always_2d=False)
    if d.ndim > 1:
        d = d.mean(axis=1)
    return np.asarray(d, np.float64), int(sr)


def segments(x, sr, dbfs=-40.0, frame_ms=20.0, hop_ms=10.0, min_speech=0.15, min_gap=0.12):
    """발화 조각 [(start,end)] — 조각 '시작 위치 복구'가 목적이다."""
    n, h = int(sr * frame_ms / 1000), int(sr * hop_ms / 1000)
    thr = 10.0 ** (dbfs / 20.0)
    k = max(0, (x.size - n) // h + 1)
    act = np.array([np.sqrt(np.mean(x[i * h:i * h + n] ** 2)) >= thr for i in range(k)])
    segs, s = [], None
    for i, v in enumerate(act):
        if v and s is None:
            s = i
        elif not v and s is not None:
            segs.append([s * h / sr, (i * h + n) / sr])
            s = None
    if s is not None:
        segs.append([s * h / sr, x.size / sr])
    merged = []
    for a, b in segs:
        if merged and a - merged[-1][1] < min_gap:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return [(round(a, 3), round(b, 3)) for a, b in merged if b - a >= min_speech]


def mel(x, sr, n_fft=1024, hop=240, n_mels=40):
    def hz2mel(f):
        return 2595.0 * np.log10(1.0 + f / 700.0)

    def mel2hz(m):
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)
    pts = mel2hz(np.linspace(hz2mel(50.0), hz2mel(sr / 2), n_mels + 2))
    bins = np.floor((n_fft + 1) * pts / sr).astype(int)
    fb = np.zeros((n_mels, n_fft // 2 + 1))
    for m in range(1, n_mels + 1):
        l, c, r = bins[m - 1], bins[m], bins[m + 1]
        c = max(c, l + 1)
        r = max(r, c + 1)
        for j in range(l, min(c, fb.shape[1])):
            fb[m - 1, j] = (j - l) / (c - l)
        for j in range(c, min(r, fb.shape[1])):
            fb[m - 1, j] = (r - j) / (r - c)
    w = np.hanning(n_fft)
    frames = 1 + max(0, (x.size - n_fft) // hop)
    out = np.zeros((frames, n_mels))
    for i in range(frames):
        out[i] = np.log(fb @ (np.abs(np.fft.rfft(x[i * hop:i * hop + n_fft] * w)) ** 2) + 1e-10)
    return out


def best_mel_sim(a, b):
    """a(짧은 조각)의 mel 을 b 전체 위에서 미끄러뜨린 최대 평균 코사인 유사도."""
    A, B = mel(a, 24000), mel(b, 24000)
    if A.shape[0] < 3 or B.shape[0] < A.shape[0]:
        return None
    An = (A - A.mean(1, keepdims=True))
    An /= (np.linalg.norm(An, axis=1, keepdims=True) + 1e-9)
    Bn = (B - B.mean(1, keepdims=True))
    Bn /= (np.linalg.norm(Bn, axis=1, keepdims=True) + 1e-9)
    S = Bn @ An.T                       # (B_frames, A_frames)
    best = -1.0
    for off in range(0, S.shape[0] - S.shape[1] + 1):
        d = np.mean(np.diagonal(S, offset=0)[0:0]) if False else \
            float(np.mean([S[off + i, i] for i in range(S.shape[1])]))
        best = max(best, d)
    return round(best, 4)


def main():
    ref, sr = load(os.path.join(SRC, "reference_clip.wav"))
    res = {"reference_sec": round(ref.size / sr, 3), "emotions": {}}
    heads = {}
    for e in EMO:
        x, xsr = load(os.path.join(SRC, f"{e}_raw.wav"))
        assert xsr == sr
        segs = segments(x, sr)
        rows = []
        for i, (a, b) in enumerate(segs):
            head = x[int(a * sr):int(min(b, a + 0.7) * sr)]
            if head.size < int(0.15 * sr):
                continue
            ncc, lag = rl._ncc_scan(head, ref)
            rows.append({
                "chunk": i, "start_sec": a, "end_sec": b, "dur_sec": round(b - a, 3),
                "head_ncc_vs_ref": round(ncc, 4),
                "head_ncc_ref_lag_sec": round(lag / sr, 3),
                "head_mel_sim_vs_ref": best_mel_sim(head, ref),
            })
            if i == 0:
                heads[e] = head
            sf.write(os.path.join(OUT, f"{e}_chunk{i:02d}_head.wav"),
                     head.astype(np.float32), sr)
        res["emotions"][e] = {"total_sec": round(x.size / sr, 3),
                              "chunk_count": len(segs), "chunks": rows}

    # 세 raw 시작부 상호 유사도(같은 화자·다른 대사의 기준선)
    cross = {}
    for a in EMO:
        for b in EMO:
            if a >= b or a not in heads or b not in heads:
                continue
            n, m = heads[a], heads[b]
            if n.size > m.size:
                n, m = m, n
            v, lag = rl._ncc_scan(n, m)
            cross[f"{a}_vs_{b}"] = {"ncc": round(v, 4),
                                    "mel_sim": best_mel_sim(n, m)}
    res["cross_first_chunk_heads"] = cross

    with open(os.path.join(OUT, "chunkwise.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    for e in EMO:
        d = res["emotions"][e]
        print(f"== {e}  {d['total_sec']}s  chunks={d['chunk_count']}")
        for r in d["chunks"]:
            print(f"   c{r['chunk']:02d} {r['start_sec']:6.2f}~{r['end_sec']:6.2f} "
                  f"ncc={r['head_ncc_vs_ref']:.3f} @ref {r['head_ncc_ref_lag_sec']:6.2f}s "
                  f"mel={r['head_mel_sim_vs_ref']}")
    print("cross:", json.dumps(cross, ensure_ascii=False))


if __name__ == "__main__":
    main()
