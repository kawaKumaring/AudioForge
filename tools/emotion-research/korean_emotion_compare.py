# -*- coding: utf-8 -*-
"""한국어 감정 쌍 비교 — emotiontts_open_db `plain-to-emotional` 공개분.

구조(공식 README 로 확정): 같은 화자가 **같은 문장**을 네 감정으로 읽었다.
  `*00001~` 일반 · `*00101~` 기쁨 · `*00201~` 화남 · `*00301~` 슬픔
문장 번호는 끝 두 자리(01~05)이고, 백의 자리가 감정이다.

영어 파일럿(§6.13)에서 배운 것을 그대로 적용한다.
  · 잰 값은 **어절 구간의 F0 중앙값**이다. 어절 **안의** 상승·하강 곡선이 아니다.
  · 어절 경계는 인식기가 준 **추정 시각**이다. 실제 발성 시간으로 단정하지 않는다.
  · 길이 변화는 앞뒤 무음·내부 쉼·말하는 구간으로 **분해**한다(분류가 아니다).
  · F0 가 비어 있는 칸은 무음 / 소리는 있는데 F0 없음 으로 나눈다. 뒤엣것은 무성 자음인지
    추정 실패인지 파형만으로 구분되지 않는다.

영어와 달리 **문장이 5개**라 '문장 위치'와 '그 낱말' 을 어느 정도 가를 수 있다 —
같은 위치(첫 어절·끝 어절)를 서로 다른 문장에서 보면 된다.
"""
import json
import sys
import unicodedata
from pathlib import Path

import numpy as np
import pyworld as pw
import soundfile as sf

WAVS = Path(sys.argv[1])
TIMINGS = Path(sys.argv[2])
SCRIPTS = Path(sys.argv[3])
OUT = Path(sys.argv[4])
TARGET = sys.argv[5] if len(sys.argv) > 5 else "sad"
OUT.mkdir(parents=True, exist_ok=True)

FRAME_MS = 5.0
PAUSE_MIN_MS = 150.0
SILENCE_BELOW_DB = -35.0
EMOTION_BLOCK = {0: "neutral", 1: "happy", 2: "angry", 3: "sad"}
EMO_KO = {"neutral": "일반", "happy": "기쁨", "angry": "화남", "sad": "슬픔"}


def parse(name):
    stem = name.replace(".wav", "")
    spk, num = stem[:3], stem[3:]
    n = int(num)
    return spk, EMOTION_BLOCK[n // 100], n % 100


def frame_rms(x, fs, n):
    hop = int(round(fs * FRAME_MS / 1000)); win = hop * 4
    out = np.zeros(n)
    for i in range(n):
        c = i * hop; a, b = max(0, c - win // 2), min(x.size, c + win // 2)
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
    silent = 20 * np.log10(np.maximum(rms, 1e-12) / ref) < SILENCE_BELOW_DB
    voiced = f0 > 0
    return dict(fs=fs, f0=f0, voiced=voiced, silent=silent,
                empty_silent=(~voiced) & silent, empty_loud=(~voiced) & ~silent)


def runs(mask):
    out, s = [], None
    for i, v in enumerate(mask):
        if v and s is None: s = i
        elif not v and s is not None: out.append((s, i)); s = None
    if s is not None: out.append((s, len(mask)))
    return out


def duration_parts(a):
    n = a["f0"].size; sil = runs(a["silent"])
    lead = sil[0][1] - sil[0][0] if sil and sil[0][0] == 0 else 0
    trail = sil[-1][1] - sil[-1][0] if sil and sil[-1][1] == n else 0
    inner = sum(b - s for s, b in sil if s != 0 and b != n and (b - s) * FRAME_MS >= PAUSE_MIN_MS)
    f = FRAME_MS / 1000
    return {"total_sec": round(n * f, 3), "lead_sec": round(lead * f, 3),
            "trail_sec": round(trail * f, 3), "inner_pause_sec": round(inner * f, 3),
            "speech_sec": round((n - lead - trail - inner) * f, 3)}


def word_stats(a, w):
    i0 = max(0, int(round(w["start"] * 1000 / FRAME_MS)))
    i1 = min(a["f0"].size, int(round(w["end"] * 1000 / FRAME_MS)))
    if i1 <= i0: return None
    v = a["f0"][i0:i1][a["f0"][i0:i1] > 0]
    return {"dur_sec": round((i1 - i0) * FRAME_MS / 1000, 3),
            "f0_median_hz": round(float(np.median(v)), 2) if v.size else None,
            "voiced": int(v.size), "frames": int(i1 - i0)}


def st(a, b):
    return round(float(12 * np.log2(a / b)), 3) if (a and b) else None


def norm(s):
    return unicodedata.normalize("NFC", s).replace(" ", "")


def main():
    tim = json.loads(TIMINGS.read_text(encoding="utf-8"))
    items = {}
    for wav in sorted(WAVS.glob("*.wav")):
        spk, emo, sent = parse(wav.name)
        a = analyze(wav)
        sp = (SCRIPTS / spk / "script" / wav.name.replace(".wav", ".txt"))
        script = sp.read_text(encoding="utf-8-sig").strip() if sp.exists() else ""
        items[(spk, sent, emo)] = {"file": wav.name, "an": a, "duration": duration_parts(a),
                                   "words": tim[wav.name]["words"], "asr": tim[wav.name]["text"],
                                   "script": script}

    report = {"dataset": "emotiontts_open_db plain-to-emotional (CC BY-NC-SA 4.0, 연구 목적)",
              "structure": "같은 화자·같은 문장·4감정. 공식 README 로 확정한 번호 규칙.",
              "alignment": "Whisper small(ko) 어절 타임스탬프 — 추정 시각이다.",
              "target_emotion": TARGET, "pairs": [], "skipped": []}

    for (spk, sent, emo), d in sorted(items.items()):
        if emo != TARGET: continue
        base = items.get((spk, sent, "neutral"))
        if base is None: continue
        nw, sw = base["words"], d["words"]
        if len(nw) != len(sw):
            report["skipped"].append({"speaker": spk, "sentence": sent,
                                      "reason": f"어절 수 불일치 {len(nw)} vs {len(sw)}",
                                      "asr_neutral": base["asr"], "asr_target": d["asr"]})
            continue
        per = []
        for wn, ws in zip(nw, sw):
            A, B = word_stats(base["an"], wn), word_stats(d["an"], ws)
            per.append({"word_neutral": wn["text"], "word_target": ws["text"],
                        "f0_delta_st": st(B["f0_median_hz"], A["f0_median_hz"]) if A and B else None,
                        "dur_ratio": round(B["dur_sec"] / A["dur_sec"], 3) if A and B and A["dur_sec"] else None})
        dn, ds = base["duration"], d["duration"]
        report["pairs"].append({
            "speaker": spk, "sentence": sent, "script": base["script"],
            "asr_neutral": base["asr"], "asr_target": d["asr"],
            "n_words": len(per),
            "duration_delta_sec": {k: round(ds[k] - dn[k], 3) for k in dn},
            "per_word": per,
            "f0_empty": {"neutral": {"silent": int(base["an"]["empty_silent"].sum()),
                                     "loud_no_f0": int(base["an"]["empty_loud"].sum())},
                         "target": {"silent": int(d["an"]["empty_silent"].sum()),
                                    "loud_no_f0": int(d["an"]["empty_loud"].sum())}},
        })

    (OUT / f"korean_{TARGET}_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"대상 감정: {EMO_KO[TARGET]}  ·  성립한 쌍 {len(report['pairs'])}  ·  제외 {len(report['skipped'])}")
    if report["skipped"]:
        print("\n[제외 — 어절 수가 달라 비교하지 않음]")
        for s_ in report["skipped"]:
            print(f"  {s_['speaker']} 문장{s_['sentence']}: {s_['reason']}")

    print("\n── 길이 분해 (감정 − 일반, 초) ──")
    print(f"{'화자':<5}{'문장':>4}{'전체':>8}{'앞무음':>8}{'뒤무음':>8}{'내부쉼':>8}{'말하는구간':>11}")
    for p in report["pairs"]:
        x = p["duration_delta_sec"]
        print(f"{p['speaker']:<5}{p['sentence']:>4}{x['total_sec']:>8.3f}{x['lead_sec']:>8.3f}"
              f"{x['trail_sec']:>8.3f}{x['inner_pause_sec']:>8.3f}{x['speech_sec']:>11.3f}")

    print("\n── 첫 어절 / 끝 어절 F0 변화(반음)와 길이비 ──")
    print(f"{'화자':<5}{'문장':>4}{'첫F0':>8}{'끝F0':>8}{'첫길이':>8}{'끝길이':>8}   {'첫어절':<12}{'끝어절':<12}")
    first, last = [], []
    for p in report["pairs"]:
        a, b = p["per_word"][0], p["per_word"][-1]
        if a["f0_delta_st"] is not None: first.append(a["f0_delta_st"])
        if b["f0_delta_st"] is not None: last.append(b["f0_delta_st"])
        print(f"{p['speaker']:<5}{p['sentence']:>4}"
              f"{(a['f0_delta_st'] if a['f0_delta_st'] is not None else float('nan')):>8.2f}"
              f"{(b['f0_delta_st'] if b['f0_delta_st'] is not None else float('nan')):>8.2f}"
              f"{(a['dur_ratio'] or 0):>8.2f}{(b['dur_ratio'] or 0):>8.2f}   "
              f"{a['word_neutral'][:11]:<12}{b['word_neutral'][:11]:<12}")
    if first:
        print(f"\n첫 어절 F0: 내려간 쌍 {sum(1 for v in first if v < 0)}/{len(first)}  "
              f"중앙값 {np.median(first):+.2f}반음")
    if last:
        print(f"끝 어절 F0: 올라간 쌍 {sum(1 for v in last if v > 0)}/{len(last)}  "
              f"중앙값 {np.median(last):+.2f}반음")


if __name__ == "__main__":
    main()
