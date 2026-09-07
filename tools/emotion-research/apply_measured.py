# -*- coding: utf-8 -*-
"""측정된 값을 측정된 자리에 걸어 본다 — 들리는지 확인하는 시험.

앞선 실험(§6.7)은 발화 전체에 ±1반음 완만한 기울기를 걸었고 사용자가 변화를 못 느꼈다.
이번에는 **임의 값이 아니라 한국어 22쌍에서 잰 값**을 **그 값이 관찰된 자리**에 건다.

  C 기쁨 후보 : 문장 **끝 어절**을 +2.41반음 (관찰 20/23, 화자 4/5)
  D 화남 후보 : 문장 **전체** −1.98반음, **끝 어절**은 −3.08반음, **내부 쉼** +0.465초
                (관찰 첫 20/21 · 끝 19/21 · 쉼 18/21)

**주의 — 이 값의 뜻**: 잰 것은 어절 구간의 F0 **중앙값**이다. 어절 **안의** 상승·하강 곡선이 아니다.
따라서 여기서 하는 것은 "그 어절을 중립보다 높은/낮은 음으로 옮기는 것"이지 억양을 그리는 것이 아니다.

B(무변경 재합성)를 반드시 함께 만든다 — 재합성 자체가 만드는 변화와 F0 변경 효과를 가르기 위해서다.
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
RAMP_MS = 150.0          # 어절 경계에서 음높이를 갑자기 꺾으면 그 자체가 잡음으로 들린다. 완만히 옮긴다.

# 한국어 22쌍 측정값(중앙값). emotiontts_open_db plain-to-emotional 공개분.
HAPPY_FINAL_ST = +2.41
ANGRY_ALL_ST = -1.98
ANGRY_FINAL_ST = -3.08
ANGRY_PAUSE_SEC = +0.465


def frame_rms(x, fs, n):
    hop = int(round(fs * FRAME_MS / 1000)); win = hop * 4
    out = np.zeros(n)
    for i in range(n):
        c = i * hop; a, b = max(0, c - win // 2), min(x.size, c + win // 2)
        seg = x[a:b]
        out[i] = np.sqrt(np.mean(seg ** 2)) if seg.size else 0.0
    return out


def ramp_offsets(n, final_start_idx, base_st, final_st):
    """프레임별 반음 오프셋. 끝 어절 앞 RAMP 구간에서 base → final 로 완만히 옮긴다."""
    off = np.full(n, base_st, dtype=float)
    ramp = max(1, int(round(RAMP_MS / FRAME_MS)))
    s = max(0, final_start_idx - ramp)
    if final_start_idx > s:
        off[s:final_start_idx] = np.linspace(base_st, final_st, final_start_idx - s)
    off[final_start_idx:] = final_st
    return off


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
    t_analyze = time.perf_counter() - t0

    final_start = int(round(words[-1]["start"] * 1000 / FRAME_MS))
    final_start = min(max(0, final_start), n - 1)

    def synth(off_st):
        g = f0.copy()
        g[voiced] = f0[voiced] * (2.0 ** (off_st[voiced] / 12.0))
        y = pw.synthesize(g, sp, ap, fs, frame_period=FRAME_MS)
        return (y[:x.size] if y.size >= x.size else np.pad(y, (0, x.size - y.size))), g

    y_b, _ = synth(np.zeros(n))
    y_c, f0_c = synth(ramp_offsets(n, final_start, 0.0, HAPPY_FINAL_ST))
    y_d, f0_d = synth(ramp_offsets(n, final_start, ANGRY_ALL_ST, ANGRY_FINAL_ST))

    # D 의 내부 쉼 — 발화 안에서 가장 긴 무음 자리를 측정치만큼 늘린다(새 자리를 만들지 않는다).
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
        y_d = np.concatenate([y_d[:mid], np.zeros(add), y_d[mid:]])
        pause_info = {"inserted": True, "at_sec": round(mid / fs, 3),
                      "added_sec": round(add / fs, 3),
                      "existing_gap_sec": round((b - a) * FRAME_MS / 1000, 3)}

    files = {"A_original": x, "B_resynth_unchanged": y_b,
             "C_happy_final_up": y_c, "D_angry_all_down_plus_pause": y_d}
    for k, y in files.items():
        sf.write(str(OUT / f"{k}.wav"), y, fs, subtype="PCM_16")

    # 음량 맞춤본 — 기준 A 의 RMS, 고정 gain 만. 압축·리미터·피치 변경 없음.
    lm = OUT / "levelmatched"; lm.mkdir(exist_ok=True)
    rms_of = {k: float(np.sqrt(np.mean(v ** 2))) for k, v in files.items()}
    gains = {}
    for k, y in files.items():
        g = rms_of["A_original"] / rms_of[k]
        sf.write(str(lm / f"{k}.wav"), y * g, fs, subtype="PCM_16")
        gains[k] = {"gain_db": round(20 * np.log10(g), 3),
                    "peak_after": round(float(np.abs(y * g).max()), 4),
                    "clipped": int((np.abs(y * g) >= 0.999).sum())}

    def remeasure(p):
        z, zfs = sf.read(str(p), dtype="float64")
        zf, zt = pw.harvest(z, zfs, frame_period=FRAME_MS)
        zf = pw.stonemask(z, zf, zt, zfs)
        return zf, zf > 0

    def final_median(f0v, mask, start_idx):
        seg = f0v[start_idx:][mask[start_idx:]]
        return round(float(np.median(seg)), 2) if seg.size else None

    a_fin = final_median(f0, voiced, final_start)
    out_report = {"source": wav.name, "text": tim["text"], "sample_rate": int(fs),
                  "words": [w["text"] for w in words],
                  "final_word": words[-1]["text"], "final_word_start_sec": words[-1]["start"],
                  "applied": {"C_happy": {"final_st": HAPPY_FINAL_ST},
                              "D_angry": {"all_st": ANGRY_ALL_ST, "final_st": ANGRY_FINAL_ST,
                                          "pause": pause_info}},
                  "final_word_f0_median_hz": {"A": a_fin}, "requested_vs_measured_st": {},
                  "duration_sec": {}, "level_match": gains,
                  "elapsed_sec": {"analyze": round(t_analyze, 3),
                                  "total": round(time.perf_counter() - t0, 3)}}
    for k in ("B_resynth_unchanged", "C_happy_final_up", "D_angry_all_down_plus_pause"):
        zf, zv = remeasure(OUT / f"{k}.wav")
        # 쉼을 끝 어절 **앞**에 넣었으면 그만큼 시간축이 밀린다. 밀린 채로 재면 엉뚱한 구간을 잰다.
        shift = 0
        if k.startswith("D_") and pause_info.get("inserted") and pause_info["at_sec"] < words[-1]["start"]:
            shift = int(round(pause_info["added_sec"] * 1000 / FRAME_MS))
        fs_idx = min(final_start + shift, zf.size - 1)
        m = final_median(zf, zv, fs_idx)
        out_report["final_word_f0_median_hz"][k] = m
        out_report["requested_vs_measured_st"][k] = {
            "measured_vs_A_st": round(float(12 * np.log2(m / a_fin)), 3) if (m and a_fin) else None}
        z, _ = sf.read(str(OUT / f"{k}.wav"))
        out_report["duration_sec"][k] = round(z.size / fs, 3)
    out_report["duration_sec"]["A_original"] = round(x.size / fs, 3)

    (OUT / "report.json").write_text(json.dumps(out_report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(out_report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
