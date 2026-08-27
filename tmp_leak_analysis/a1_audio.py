# -*- coding: utf-8 -*-
"""진단 3/4/5 — 파형 NCC / log-mel DTW / preview 앞 2초 정체 확인.

읽기 전용: 사용자 산출물 폴더는 절대 쓰지 않는다.
"""
import json
import os
import sys

import numpy as np
import soundfile as sf
from scipy.signal import fftconvolve

SRC = r"E:\AudioForge_output\expressive-comparison\20260827-A2-emotion3"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "a1_audio.json")

EMO = ("happy", "angry", "sad")


def load(path):
    d, sr = sf.read(path, dtype="float32", always_2d=False)
    if d.ndim > 1:
        d = d.mean(axis=1)
    return np.asarray(d, dtype=np.float64), int(sr)


def running_energy(x, n):
    """길이 n 창의 이동 에너지(합). 반환 길이 len(x)-n+1."""
    c = np.concatenate(([0.0], np.cumsum(x * x)))
    return c[n:] - c[:-n]


def ncc_scan(win, ref):
    """win 을 ref 위에서 미끄러뜨리며 정규화 상호상관. (peak_abs, lag_samples) 반환."""
    n = win.size
    if ref.size < n:
        return 0.0, -1
    num = fftconvolve(ref, win[::-1], mode="valid")          # len(ref)-n+1
    den = np.sqrt(running_energy(ref, n)) * np.sqrt(np.dot(win, win))
    den = np.where(den <= 1e-12, np.inf, den)
    r = num / den
    i = int(np.argmax(np.abs(r)))
    return float(np.abs(r[i])), i


def windowed_ncc(sig, ref, sr, win_ms, hop_ms, silence_rms=1e-3):
    n = int(sr * win_ms / 1000.0)
    hop = int(sr * hop_ms / 1000.0)
    rows = []
    for s in range(0, max(sig.size - n + 1, 1), hop):
        w = sig[s:s + n]
        if w.size < n:
            break
        rms = float(np.sqrt(np.mean(w * w)))
        if rms < silence_rms:          # 무음 창은 NCC 가 무의미
            continue
        peak, lag = ncc_scan(w, ref)
        rows.append({"t_sec": round(s / sr, 3), "rms": round(rms, 5),
                     "ncc": round(peak, 4), "ref_lag_sec": round(lag / sr, 3)})
    return rows


# ---- log-mel ----
def mel_fb(sr, n_fft, n_mels, fmin=40.0, fmax=None):
    fmax = fmax or sr / 2
    def hz2mel(f):
        return 2595.0 * np.log10(1.0 + f / 700.0)
    def mel2hz(m):
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)
    pts = mel2hz(np.linspace(hz2mel(fmin), hz2mel(fmax), n_mels + 2))
    bins = np.floor((n_fft + 1) * pts / sr).astype(int)
    fb = np.zeros((n_mels, n_fft // 2 + 1))
    for m in range(1, n_mels + 1):
        l, c, r = bins[m - 1], bins[m], bins[m + 1]
        if c == l:
            c = l + 1
        if r == c:
            r = c + 1
        for k in range(l, min(c, fb.shape[1])):
            fb[m - 1, k] = (k - l) / (c - l)
        for k in range(c, min(r, fb.shape[1])):
            fb[m - 1, k] = (r - k) / (r - c)
    return fb


def logmel(sig, sr, n_fft=1024, hop=240, n_mels=64):
    fb = mel_fb(sr, n_fft, n_mels)
    win = np.hanning(n_fft)
    frames = 1 + max(0, (sig.size - n_fft) // hop)
    out = np.zeros((frames, n_mels))
    for i in range(frames):
        seg = sig[i * hop:i * hop + n_fft] * win
        spec = np.abs(np.fft.rfft(seg)) ** 2
        out[i] = np.log(fb @ spec + 1e-10)
    return out


def cos_sim_matrix(A, B):
    """행 정규화 후 코사인 유사도 행렬 (frames_A x frames_B)."""
    A = A - A.mean(axis=1, keepdims=True)
    B = B - B.mean(axis=1, keepdims=True)
    A = A / (np.linalg.norm(A, axis=1, keepdims=True) + 1e-9)
    B = B / (np.linalg.norm(B, axis=1, keepdims=True) + 1e-9)
    return A @ B.T


def best_diagonal_runs(S, hop_sec, min_len, top=5):
    """대각 방향(1:1 정렬) 누적 유사도가 가장 높은 구간 = 파형/내용 그대로 복사 후보."""
    fa, fb = S.shape
    best = []
    for off in range(-(fa - min_len), fb - min_len + 1):
        d = np.diagonal(S, offset=off)
        if d.size < min_len:
            continue
        c = np.concatenate(([0.0], np.cumsum(d)))
        means = (c[min_len:] - c[:-min_len]) / min_len
        i = int(np.argmax(means))
        best.append((float(means[i]), int(off), int(i)))
    best.sort(reverse=True)
    out = []
    seen = []
    for m, off, i in best:
        a_start = i if off >= 0 else i - off
        b_start = i + off if off >= 0 else i
        if any(abs(a_start - x) < min_len // 2 and abs(b_start - y) < min_len // 2 for x, y in seen):
            continue
        seen.append((a_start, b_start))
        out.append({"mean_cos": round(m, 4),
                    "a_start_sec": round(a_start * hop_sec, 3),
                    "b_start_sec": round(b_start * hop_sec, 3),
                    "len_sec": round(min_len * hop_sec, 3)})
        if len(out) >= top:
            break
    return out


def subsequence_dtw(A, B):
    """A(짧은 쪽) 전체를 B 어디에나 정렬하는 subsequence DTW. (평균 코사인거리, 시작/끝) 반환."""
    S = cos_sim_matrix(A, B)
    D = 1.0 - S                       # 거리 0..2
    na, nb = D.shape
    acc = np.full((na, nb), np.inf)
    ptr = np.zeros((na, nb), dtype=np.int8)
    acc[0] = D[0]                     # 시작은 B 의 어디서든 자유
    for i in range(1, na):
        prev = acc[i - 1]
        # 세 전이: (i-1,j) 삽입, (i-1,j-1) 대각, (i,j-1) 는 아래에서 순차 처리
        cand = np.full((3, nb), np.inf)
        cand[0] = prev                                  # j 유지
        cand[1, 1:] = prev[:-1]                         # 대각
        cand[2, 2:] = prev[:-2]                         # j 두 칸(빠른 진행)
        k = np.argmin(cand, axis=0)
        acc[i] = cand[k, np.arange(nb)] + D[i]
        ptr[i] = k
    j_end = int(np.argmin(acc[-1]))
    cost = float(acc[-1, j_end])
    # 역추적으로 시작점
    j = j_end
    for i in range(na - 1, 0, -1):
        j -= int(ptr[i, j])
        if j < 0:
            j = 0
    return {"mean_cos_dist": round(cost / na, 4),
            "mean_cos_sim": round(1.0 - cost / na, 4),
            "b_start_frame": int(j), "b_end_frame": j_end}


def main():
    res = {}
    ref, sr = load(os.path.join(SRC, "reference_clip.wav"))
    res["reference"] = {"samples": int(ref.size), "sr": sr,
                        "sec": round(ref.size / sr, 4)}

    sigs = {}
    for e in EMO:
        s, s_sr = load(os.path.join(SRC, f"{e}_raw.wav"))
        assert s_sr == sr, (e, s_sr)
        sigs[e] = s

    # ---------- 진단 5: 파형 NCC ----------
    ncc = {}
    for e in EMO:
        s = sigs[e]
        ncc[e] = {}
        # (a) 전역 1창 NCC — 출력 전체를 참조 위에서 미끄러뜨림
        p, l = ncc_scan(s, ref)
        ncc[e]["whole_output_vs_ref"] = {"ncc": round(p, 4), "ref_lag_sec": round(l / sr, 3)}
        # (b) 창 단위 스캔
        for win_ms, hop_ms in ((100, 25), (200, 50), (500, 100)):
            rows = windowed_ncc(s, ref, sr, win_ms, hop_ms)
            if rows:
                mx = max(rows, key=lambda r: r["ncc"])
                vals = np.array([r["ncc"] for r in rows])
                ncc[e][f"win{win_ms}ms"] = {
                    "n_windows": len(rows),
                    "max_ncc": mx["ncc"], "max_at_out_sec": mx["t_sec"],
                    "max_ref_lag_sec": mx["ref_lag_sec"],
                    "p50": round(float(np.median(vals)), 4),
                    "p90": round(float(np.quantile(vals, 0.90)), 4),
                    "p99": round(float(np.quantile(vals, 0.99)), 4),
                    "count_ge_0.9": int((vals >= 0.9).sum()),
                    "count_ge_0.7": int((vals >= 0.7).sum()),
                    "count_ge_0.5": int((vals >= 0.5).sum()),
                }
        # (c) 머리 200ms 를 참조 머리에 정확히 겹쳐본 값(슬라이싱 오프셋 검출용)
        n = int(sr * 0.2)
        a = s[:n]
        b = ref[:n]
        d = np.sqrt(np.dot(a, a) * np.dot(b, b))
        ncc[e]["head200ms_aligned_ncc"] = round(float(np.dot(a, b) / d) if d > 1e-12 else 0.0, 4)
    res["ncc_vs_reference"] = ncc

    # (d) 대조군: 출력끼리 NCC (같은 화자·다른 내용)
    ctrl = {}
    for a, b in (("happy", "angry"), ("happy", "sad"), ("angry", "sad")):
        rows = windowed_ncc(sigs[a], sigs[b], sr, 200, 50)
        vals = np.array([r["ncc"] for r in rows]) if rows else np.array([0.0])
        ctrl[f"{a}_vs_{b}"] = {"max_ncc": round(float(vals.max()), 4),
                               "p50": round(float(np.median(vals)), 4),
                               "p99": round(float(np.quantile(vals, 0.99)), 4)}
    res["ncc_control_output_pairs"] = ctrl

    # ---------- 진단 4: log-mel DTW / 대각 매칭 ----------
    hop = 240                      # 10ms @24k
    hop_sec = hop / sr
    M = {"reference": logmel(ref, sr, hop=hop)}
    for e in EMO:
        M[e] = logmel(sigs[e], sr, hop=hop)
    mel = {}
    for e in EMO:
        S = cos_sim_matrix(M[e], M["reference"])
        mel[e] = {
            "frames_out": int(M[e].shape[0]), "frames_ref": int(M["reference"].shape[0]),
            "global_max_cos": round(float(S.max()), 4),
            "mean_cos": round(float(S.mean()), 4),
            "subsequence_dtw": subsequence_dtw(M[e], M["reference"]),
            "diag_runs_300ms": best_diagonal_runs(S, hop_sec, min_len=30),
            "diag_runs_600ms": best_diagonal_runs(S, hop_sec, min_len=60),
        }
    res["logmel_vs_reference"] = mel

    mel_ctrl = {}
    for a, b in (("happy", "angry"), ("happy", "sad"), ("angry", "sad")):
        S = cos_sim_matrix(M[a], M[b])
        mel_ctrl[f"{a}_vs_{b}"] = {
            "global_max_cos": round(float(S.max()), 4),
            "mean_cos": round(float(S.mean()), 4),
            "diag_runs_300ms": best_diagonal_runs(S, hop_sec, min_len=30, top=3),
            "diag_runs_600ms": best_diagonal_runs(S, hop_sec, min_len=60, top=3),
        }
    res["logmel_control_output_pairs"] = mel_ctrl

    # ---------- preview 앞 2초 정체 ----------
    prev = {}
    for e in EMO:
        p = os.path.join(SRC, f"{e}_preview.wav")
        if not os.path.exists(p):
            continue
        s, s_sr = load(p)
        head = s[:2 * s_sr]
        tail = s[2 * s_sr:]
        raw = sigs[e]
        same = bool(tail.size == raw.size and np.allclose(tail, raw, atol=1e-6))
        hp, hl = ncc_scan(head, ref) if head.size <= ref.size else (0.0, -1)
        prev[e] = {"sec": round(s.size / s_sr, 4),
                   "head2s_peak": round(float(np.abs(head).max()), 6),
                   "head2s_rms": round(float(np.sqrt(np.mean(head * head))), 8),
                   "head2s_is_digital_silence": bool(np.all(head == 0.0)),
                   "head2s_ncc_vs_ref": round(hp, 4),
                   "tail_equals_raw": same}
    res["preview_head"] = prev

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    print(json.dumps(res, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
