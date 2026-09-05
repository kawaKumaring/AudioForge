# -*- coding: utf-8 -*-
"""RAVDESS 최소 추출 — 같은 화자·같은 문장의 중립/감정 쌍에서 시간축 F0 와 길이·쉼을 뽑는다.

**이 스크립트가 하지 않는 것**
  · 구절 정렬을 하지 않는다. 시간 정규화(0~1 로 늘여 겹치기)만 한다.
    따라서 **구절별 규칙을 얻었다고 말할 수 없다.** 그래프의 x 축은 "발화의 몇 %" 이지 "어느 구절" 이 아니다.
  · 영어 자료다. 여기서 나온 값을 한국어 규칙으로 옮기지 않는다. 확인하는 것은
    (a) 추출 파이프라인이 작동하는가 (b) 기존 요약 통계의 방향이 재현되는가 둘뿐이다.

분석기는 §6.7 에서 쓴 것과 같다(harvest → stonemask). 새 분석기를 만들지 않는다.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pyworld as pw
import soundfile as sf

HERE = Path(__file__).resolve().parent
PAIRS = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent.parent / "datasets/ravdess/pairs"
OUT = HERE / "ravdess_out"
OUT.mkdir(exist_ok=True)

FRAME_MS = 5.0
EMOTION = {"01": "neutral", "04": "sad"}
# 무성(0) 이 이 길이 이상 이어지면 '쉼 후보'로 센다. 무성 자음은 이보다 짧다.
PAUSE_MIN_MS = 150.0
# 이웃 유성 프레임 사이 반음 도약이 이보다 크면 F0 추정 오류(옥타브 튐) 후보로 표시한다.
OCTAVE_JUMP_ST = 6.0


def parse(name):
    """RAVDESS 파일명 7토막. 공식 규약 그대로 읽는다(추측하지 않는다)."""
    p = name.replace(".wav", "").split("-")
    return {"modality": p[0], "channel": p[1], "emotion": p[2], "intensity": p[3],
            "statement": p[4], "repetition": p[5], "actor": p[6],
            "gender": "male" if int(p[6]) % 2 == 1 else "female"}


def analyze(path):
    x, fs = sf.read(str(path), dtype="float64")
    if x.ndim > 1:
        x = x[:, 0]
    f0, t = pw.harvest(x, fs, frame_period=FRAME_MS)
    f0 = pw.stonemask(x, f0, t, fs)
    voiced = f0 > 0

    # 무성 연속 구간 → 쉼 후보(앞뒤 묵음 포함). 프레임 단위 길이로 잰다.
    runs, start = [], None
    for i, v in enumerate(voiced):
        if not v and start is None:
            start = i
        elif v and start is not None:
            runs.append((start, i)); start = None
    if start is not None:
        runs.append((start, len(voiced)))
    pauses = [{"start_sec": round(a * FRAME_MS / 1000, 3),
               "dur_sec": round((b - a) * FRAME_MS / 1000, 3),
               "edge": a == 0 or b == len(voiced)}
              for a, b in runs if (b - a) * FRAME_MS >= PAUSE_MIN_MS]

    # F0 추정 오류 후보 — 이웃 유성 프레임 사이의 큰 도약.
    vi = np.flatnonzero(voiced)
    jumps = []
    for k in range(1, vi.size):
        i, j = vi[k - 1], vi[k]
        if j - i != 1:                     # 무성으로 끊긴 경계는 도약으로 세지 않는다
            continue
        st = 12.0 * np.log2(f0[j] / f0[i])
        if abs(st) > OCTAVE_JUMP_ST:
            jumps.append({"frame": int(j), "sec": round(j * FRAME_MS / 1000, 3),
                          "semitones": round(float(st), 2)})

    v = f0[voiced]
    stats = {
        "duration_sec": round(x.size / fs, 3),
        "sample_rate": int(fs),
        "frames_total": int(f0.size),
        "frames_voiced": int(voiced.sum()),
        "frames_unvoiced": int((~voiced).sum()),
        "voiced_ratio": round(float(voiced.mean()), 4),
        "f0_median_hz": round(float(np.median(v)), 2) if v.size else None,
        "f0_q10_hz": round(float(np.quantile(v, 0.10)), 2) if v.size else None,
        "f0_q90_hz": round(float(np.quantile(v, 0.90)), 2) if v.size else None,
        "f0_range_st": round(float(12 * np.log2(np.quantile(v, 0.90) / np.quantile(v, 0.10))), 3) if v.size else None,
        "speech_sec": round(float(voiced.sum()) * FRAME_MS / 1000, 3),
        "pause_candidates": pauses,
        "pause_total_sec": round(sum(p["dur_sec"] for p in pauses), 3),
        "pause_inner_sec": round(sum(p["dur_sec"] for p in pauses if not p["edge"]), 3),
        "f0_error_candidates": jumps,
    }
    return f0, voiced, stats


def norm_curve(f0, voiced, bins=50):
    """시간 정규화 곡선. **구절 정렬이 아니다.** 유성 프레임만 중앙값으로 묶는다."""
    n = f0.size
    edges = np.linspace(0, n, bins + 1).astype(int)
    out = []
    for a, b in zip(edges[:-1], edges[1:]):
        seg = f0[a:b][voiced[a:b]]
        out.append(round(float(np.median(seg)), 2) if seg.size else None)
    return out


def svg(pairs, path):
    """의존성 없이 SVG 를 직접 쓴다. 값이 없는 칸(분석 불가)은 선을 끊는다."""
    W, H, PAD = 900, 260, 46
    rows = []
    for actor, d in pairs.items():
        cn, ce = d["neutral"]["curve"], d["emotion"]["curve"]
        vals = [x for x in cn + ce if x]
        lo, hi = min(vals) * 0.92, max(vals) * 1.08
        def pts(curve):
            segs, cur = [], []
            for i, y in enumerate(curve):
                if y is None:
                    if len(cur) > 1: segs.append(cur)
                    cur = []
                    continue
                X = PAD + (W - 2 * PAD) * i / (len(curve) - 1)
                Y = H - PAD - (H - 2 * PAD) * (y - lo) / (hi - lo)
                cur.append(f"{X:.1f},{Y:.1f}")
            if len(cur) > 1: segs.append(cur)
            return segs
        body = [f'<text x="{PAD}" y="20" font-size="13" font-family="sans-serif">'
                f'배우 {actor} ({d["gender"]}) · 같은 문장 · 시간 정규화(구절 정렬 아님) · '
                f'세로축 {lo:.0f}~{hi:.0f} Hz</text>']
        for segs, color, label in ((pts(cn), "#2563eb", "neutral"), (pts(ce), "#dc2626", "sad")):
            for s in segs:
                body.append(f'<polyline points="{" ".join(s)}" fill="none" stroke="{color}" stroke-width="2"/>')
        body.append(f'<text x="{W-PAD-150}" y="{PAD}" font-size="12" fill="#2563eb" font-family="sans-serif">— neutral</text>')
        body.append(f'<text x="{W-PAD-60}" y="{PAD}" font-size="12" fill="#dc2626" font-family="sans-serif">— sad</text>')
        body.append(f'<line x1="{PAD}" y1="{H-PAD}" x2="{W-PAD}" y2="{H-PAD}" stroke="#999"/>')
        body.append(f'<text x="{PAD}" y="{H-PAD+18}" font-size="11" font-family="sans-serif">발화 시작</text>')
        body.append(f'<text x="{W-PAD-46}" y="{H-PAD+18}" font-size="11" font-family="sans-serif">발화 끝</text>')
        rows.append(f'<svg x="0" y="{len(rows)*H}" width="{W}" height="{H}">' + "".join(body) + "</svg>")
    total = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H*len(rows)}">' \
            f'<rect width="{W}" height="{H*len(rows)}" fill="white"/>' + "".join(rows) + "</svg>"
    Path(path).write_text(total, encoding="utf-8")


def main():
    files = sorted(PAIRS.glob("*.wav"))
    by_actor = {}
    for f in files:
        meta = parse(f.name)
        f0, voiced, stats = analyze(f)
        slot = "neutral" if meta["emotion"] == "01" else "emotion"
        by_actor.setdefault(meta["actor"], {"gender": meta["gender"],
                                            "statement": meta["statement"], "repetition": meta["repetition"]})
        by_actor[meta["actor"]][slot] = {"file": f.name, "emotion": EMOTION[meta["emotion"]],
                                         "intensity": meta["intensity"], "stats": stats,
                                         "curve": norm_curve(f0, voiced)}

    report = {"dataset": "RAVDESS (CC BY-NC-SA 4.0)",
              "note": "영어 자료. 방법 검증용이며 한국어 규칙으로 옮기지 않는다.",
              "alignment": "time-normalized only. NO phrase alignment. per-phrase rules NOT claimed.",
              "frame_period_ms": FRAME_MS, "pause_min_ms": PAUSE_MIN_MS,
              "octave_jump_threshold_st": OCTAVE_JUMP_ST, "actors": {}}

    for actor, d in sorted(by_actor.items()):
        n, e = d["neutral"]["stats"], d["emotion"]["stats"]
        rel = {
            "f0_median_delta_st": round(12 * np.log2(e["f0_median_hz"] / n["f0_median_hz"]), 3),
            "f0_range_delta_st": round(e["f0_range_st"] - n["f0_range_st"], 3),
            "duration_ratio": round(e["duration_sec"] / n["duration_sec"], 4),
            "speech_ratio": round(e["speech_sec"] / n["speech_sec"], 4),
            "pause_inner_delta_sec": round(e["pause_inner_sec"] - n["pause_inner_sec"], 3),
        }
        report["actors"][actor] = {"gender": d["gender"], "statement": d["statement"],
                                   "repetition": d["repetition"],
                                   "neutral": d["neutral"], "emotion": d["emotion"],
                                   "relative_emotion_vs_neutral": rel}

    (OUT / "ravdess_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    svg(report["actors"], OUT / "f0_curves.svg")

    print(f"{'배우':<6}{'성별':<8}{'ΔF0중앙(st)':>12}{'Δ음역(st)':>11}{'길이비':>9}{'발성비':>9}{'내부쉼Δ(s)':>12}"
          f"{'유성비 N/E':>14}{'오류후보 N/E':>13}")
    for a, d in report["actors"].items():
        r, n, e = d["relative_emotion_vs_neutral"], d["neutral"]["stats"], d["emotion"]["stats"]
        print(f"{a:<6}{d['gender']:<8}{r['f0_median_delta_st']:>12.3f}{r['f0_range_delta_st']:>11.3f}"
              f"{r['duration_ratio']:>9.3f}{r['speech_ratio']:>9.3f}{r['pause_inner_delta_sec']:>12.3f}"
              f"{n['voiced_ratio']:>7.2f}/{e['voiced_ratio']:<6.2f}"
              f"{len(n['f0_error_candidates']):>6}/{len(e['f0_error_candidates']):<6}")


if __name__ == "__main__":
    main()
