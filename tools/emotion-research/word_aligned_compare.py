# -*- coding: utf-8 -*-
"""단어 정렬 비교 — 같은 화자·같은 문장의 중립/감정을 **같은 단어 위에서** 견준다.

이전 판(`ravdess_extract_pairs.py`)은 발화를 0~1 로 늘여 겹쳤다. 그것은 시간 정규화이지 정렬이 아니다.
이 스크립트는 **단어 경계**(Whisper 단어 타임스탬프)를 기준으로 잘라 비교하므로,
"같은 위치" 가 "같은 단어" 를 뜻한다.

함께 답하는 것 둘.
  · 발화가 길어진 것이 **앞뒤 무음 / 내부 쉼 / 실제 말하는 구간** 중 어디 때문인가.
  · F0 가 비어 있는 칸이 **무음인가, 무성 자음인가, 추정 실패인가.** 셋을 섞지 않는다.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pyworld as pw
import soundfile as sf

PAIRS = Path(sys.argv[1])
TIMINGS = Path(sys.argv[2])
OUT = Path(sys.argv[3])
OUT.mkdir(parents=True, exist_ok=True)

FRAME_MS = 5.0
EMOTION = {"01": "neutral", "04": "sad"}
PAUSE_MIN_MS = 150.0
# 프레임 에너지가 이 값보다 낮으면 '소리 없음'으로 본다. 그 파일의 발화 레벨(90분위) 대비 상대값이라
# 화자·녹음 레벨이 달라도 같은 기준이 된다.
SILENCE_BELOW_DB = -35.0


def frame_rms(x, fs, n_frames):
    hop = int(round(fs * FRAME_MS / 1000))
    win = hop * 4                              # 20 ms 창
    out = np.zeros(n_frames)
    for i in range(n_frames):
        c = i * hop
        a, b = max(0, c - win // 2), min(x.size, c + win // 2)
        seg = x[a:b]
        out[i] = np.sqrt(np.mean(seg ** 2)) if seg.size else 0.0
    return out


def analyze(path):
    x, fs = sf.read(str(path), dtype="float64")
    if x.ndim > 1:
        x = x[:, 0]
    f0, t = pw.harvest(x, fs, frame_period=FRAME_MS)
    f0 = pw.stonemask(x, f0, t, fs)
    rms = frame_rms(x, fs, f0.size)
    ref = np.quantile(rms[rms > 0], 0.90) if np.any(rms > 0) else 1e-9
    db = 20 * np.log10(np.maximum(rms, 1e-12) / ref)
    silent = db < SILENCE_BELOW_DB          # 소리 없음
    voiced = f0 > 0

    # F0 가 비어 있는 칸을 셋으로 가른다. "전부 무성" 이라고 뭉뚱그리지 않는다.
    empty = ~voiced
    empty_silent = empty & silent            # 소리 자체가 없다(무음·쉼)
    empty_loud = empty & ~silent             # 소리는 있는데 F0 가 없다
    #   → 무성 자음일 수도, 추정 실패일 수도 있다. **파형만으로는 구분할 수 없다.**
    return dict(x=x, fs=fs, f0=f0, voiced=voiced, silent=silent, db=db,
                empty_silent=empty_silent, empty_loud=empty_loud)


def segments(mask):
    runs, s = [], None
    for i, v in enumerate(mask):
        if v and s is None:
            s = i
        elif not v and s is not None:
            runs.append((s, i)); s = None
    if s is not None:
        runs.append((s, len(mask)))
    return runs


def duration_parts(a):
    """길이를 앞 무음 / 뒤 무음 / 내부 쉼 / 그 밖(말하는 구간)으로 나눈다."""
    n = a["f0"].size
    sil = segments(a["silent"])
    lead = sil[0][1] - sil[0][0] if sil and sil[0][0] == 0 else 0
    trail = sil[-1][1] - sil[-1][0] if sil and sil[-1][1] == n else 0
    inner = sum(b - s for s, b in sil
                if not (s == 0) and not (b == n) and (b - s) * FRAME_MS >= PAUSE_MIN_MS)
    total = n
    speech = total - lead - trail - inner
    f = FRAME_MS / 1000
    return {"total_sec": round(total * f, 3), "lead_silence_sec": round(lead * f, 3),
            "trail_silence_sec": round(trail * f, 3), "inner_pause_sec": round(inner * f, 3),
            "speech_sec": round(speech * f, 3)}


def word_stats(a, w):
    i0 = int(round(w["start"] * 1000 / FRAME_MS))
    i1 = int(round(w["end"] * 1000 / FRAME_MS))
    i0, i1 = max(0, i0), min(a["f0"].size, i1)
    if i1 <= i0:
        return None
    f0 = a["f0"][i0:i1]
    v = f0[f0 > 0]
    return {"dur_sec": round((i1 - i0) * FRAME_MS / 1000, 3),
            "f0_median_hz": round(float(np.median(v)), 2) if v.size else None,
            "voiced_frames": int(v.size), "frames": int(i1 - i0),
            "empty_loud_frames": int(a["empty_loud"][i0:i1].sum()),
            "empty_silent_frames": int(a["empty_silent"][i0:i1].sum())}


def st(a, b):
    return round(float(12 * np.log2(a / b)), 3) if (a and b) else None


def svg(rows, path, title):
    W, H, PAD = 900, 300, 56
    n = len(rows)
    body = [f'<rect width="{W}" height="{H*n}" fill="white"/>']
    for k, (actor, gender, words, nv, sv) in enumerate(rows):
        y0 = k * H
        vals = [x for x in nv + sv if x]
        lo, hi = min(vals) * 0.9, max(vals) * 1.1
        body.append(f'<text x="{PAD}" y="{y0+22}" font-size="13" font-family="sans-serif">'
                    f'배우 {actor} ({gender}) · 단어 경계 정렬 · 세로축 {lo:.0f}~{hi:.0f} Hz</text>')
        bw = (W - 2 * PAD) / len(words)
        for i, wd in enumerate(words):
            x = PAD + bw * i
            body.append(f'<line x1="{x:.1f}" y1="{y0+PAD-8}" x2="{x:.1f}" y2="{y0+H-PAD}" stroke="#ddd"/>')
            body.append(f'<text x="{x+bw/2:.1f}" y="{y0+H-PAD+18}" font-size="11" text-anchor="middle" '
                        f'font-family="sans-serif">{wd}</text>')
        for series, color, lab in ((nv, "#2563eb", "neutral"), (sv, "#dc2626", "sad")):
            pts = []
            for i, y in enumerate(series):
                if y is None:
                    continue
                X = PAD + bw * (i + 0.5)
                Y = y0 + H - PAD - (H - 2 * PAD) * (y - lo) / (hi - lo)
                pts.append(f"{X:.1f},{Y:.1f}")
                body.append(f'<circle cx="{X:.1f}" cy="{Y:.1f}" r="3.5" fill="{color}"/>')
            if len(pts) > 1:
                body.append(f'<polyline points="{" ".join(pts)}" fill="none" stroke="{color}" stroke-width="2"/>')
        body.append(f'<text x="{W-PAD-150}" y="{y0+PAD-10}" font-size="12" fill="#2563eb" font-family="sans-serif">— neutral</text>')
        body.append(f'<text x="{W-PAD-60}" y="{y0+PAD-10}" font-size="12" fill="#dc2626" font-family="sans-serif">— sad</text>')
    Path(path).write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H*n}">' + "".join(body) + "</svg>",
        encoding="utf-8")


def main():
    timings = json.loads(TIMINGS.read_text(encoding="utf-8"))
    by_actor = {}
    for wav in sorted(PAIRS.glob("*.wav")):
        p = wav.stem.split("-")
        emo, actor = p[2], p[6]
        a = analyze(wav)
        slot = "neutral" if emo == "01" else "emotion"
        by_actor.setdefault(actor, {"gender": "male" if int(actor) % 2 else "female"})
        by_actor[actor][slot] = {"file": wav.name, "emotion": EMOTION[emo], "an": a,
                                 "words": timings[wav.name]["words"],
                                 "text": timings[wav.name]["text"],
                                 "duration": duration_parts(a)}

    report = {"dataset": "RAVDESS (CC BY-NC-SA 4.0)",
              "alignment": "Whisper word timestamps (base, CPU). 단어 경계 정렬 — 시간 정규화가 아니다.",
              "note": "영어 자료. 규칙 후보이며 한국어 제품 기본값이 아니다.",
              "silence_threshold_db": SILENCE_BELOW_DB, "pause_min_ms": PAUSE_MIN_MS, "actors": {}}
    rows = []

    for actor, d in sorted(by_actor.items()):
        nw, sw = d["neutral"]["words"], d["emotion"]["words"]
        if len(nw) != len(sw):
            report["actors"][actor] = {"error": f"단어 수 불일치 {len(nw)} vs {len(sw)} — 비교하지 않는다"}
            continue
        per = []
        for wn, ws in zip(nw, sw):
            a = word_stats(d["neutral"]["an"], wn)
            b = word_stats(d["emotion"]["an"], ws)
            per.append({"word": wn["text"], "neutral": a, "sad": b,
                        "f0_delta_st": st(b["f0_median_hz"], a["f0_median_hz"]) if a and b else None,
                        "dur_ratio": round(b["dur_sec"] / a["dur_sec"], 3) if a and b and a["dur_sec"] else None})
        dn, ds = d["neutral"]["duration"], d["emotion"]["duration"]
        report["actors"][actor] = {
            "gender": d["gender"], "text": d["neutral"]["text"],
            "duration_neutral": dn, "duration_sad": ds,
            "duration_delta_sec": {k: round(ds[k] - dn[k], 3) for k in dn},
            "per_word": per,
            "f0_empty_frames": {
                "neutral": {"silent": int(d["neutral"]["an"]["empty_silent"].sum()),
                            "loud_no_f0": int(d["neutral"]["an"]["empty_loud"].sum())},
                "sad": {"silent": int(d["emotion"]["an"]["empty_silent"].sum()),
                        "loud_no_f0": int(d["emotion"]["an"]["empty_loud"].sum())}},
        }
        rows.append((actor, d["gender"], [p["word"] for p in per],
                     [p["neutral"]["f0_median_hz"] if p["neutral"] else None for p in per],
                     [p["sad"]["f0_median_hz"] if p["sad"] else None for p in per]))

    (OUT / "word_aligned_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    svg(rows, OUT / "f0_word_aligned.svg", "word aligned")

    print("── 길이 분해 (슬픔 − 중립, 초) ──")
    print(f"{'배우':<5}{'전체':>8}{'앞무음':>8}{'뒤무음':>8}{'내부쉼':>8}{'말하는구간':>11}")
    for a, d in report["actors"].items():
        if "error" in d: continue
        x = d["duration_delta_sec"]
        print(f"{a:<5}{x['total_sec']:>8.3f}{x['lead_silence_sec']:>8.3f}{x['trail_silence_sec']:>8.3f}"
              f"{x['inner_pause_sec']:>8.3f}{x['speech_sec']:>11.3f}")

    print("\n── 단어별 F0 변화(반음) ──")
    words = [p["word"] for p in report["actors"][rows[0][0]]["per_word"]]
    print(f"{'배우':<5}" + "".join(f"{w:>10}" for w in words))
    for a, d in report["actors"].items():
        if "error" in d: continue
        print(f"{a:<5}" + "".join(f"{(p['f0_delta_st'] if p['f0_delta_st'] is not None else 0):>10.2f}"
                                  for p in d["per_word"]))

    print("\n── 단어별 길이비(슬픔/중립) ──")
    print(f"{'배우':<5}" + "".join(f"{w:>10}" for w in words))
    for a, d in report["actors"].items():
        if "error" in d: continue
        print(f"{a:<5}" + "".join(f"{(p['dur_ratio'] or 0):>10.2f}" for p in d["per_word"]))

    print("\n── F0 빈 칸의 정체 (프레임) ──")
    print(f"{'배우':<5}{'중립:무음':>11}{'중립:소리있음':>15}{'슬픔:무음':>11}{'슬픔:소리있음':>15}")
    for a, d in report["actors"].items():
        if "error" in d: continue
        e = d["f0_empty_frames"]
        print(f"{a:<5}{e['neutral']['silent']:>11}{e['neutral']['loud_no_f0']:>15}"
              f"{e['sad']['silent']:>11}{e['sad']['loud_no_f0']:>15}")


if __name__ == "__main__":
    main()
