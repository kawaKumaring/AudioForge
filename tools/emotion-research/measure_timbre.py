# -*- coding: utf-8 -*-
"""음색 축 측정 — spectral tilt 와 비주기성(숨소리). F0 말고 남은 축이다.

지금까지 F0 중앙값만 재고 걸었다(두 번 실패). `roadmap.md` 가 적어 둔 표현 축 여섯 중
**spectral tilt·배음** 과 **breathiness** 를 한 번도 재지 않았다. WORLD 가 이미 둘 다 준다.

  · CheapTrick → 스펙트럼 포락(sp). 여기서 **기울기**를 잰다.
  · D4C → 비주기성(ap). 0~1 이고 클수록 숨소리가 섞인다.

측정은 **유성 프레임만** 대상으로 한다. 값은 같은 화자의 일반 발화 대비 상대값이다.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pyworld as pw
import soundfile as sf

WAVS = Path(sys.argv[1])
OUT = Path(sys.argv[2])
TARGET = sys.argv[3] if len(sys.argv) > 3 else "sad"
OUT.mkdir(parents=True, exist_ok=True)

FRAME_MS = 5.0
EMOTION_BLOCK = {0: "neutral", 1: "happy", 2: "angry", 3: "sad"}
EMO_KO = {"neutral": "일반", "happy": "기쁨", "angry": "화남", "sad": "슬픔"}
# 기울기를 재는 주파수 범위. 아주 낮은/높은 끝은 추정이 불안정해 뺀다.
TILT_LO_HZ, TILT_HI_HZ = 200.0, 5000.0


def measure(path):
    x, fs = sf.read(str(path), dtype="float64")
    if x.ndim > 1:
        x = x[:, 0]
    f0, t = pw.harvest(x, fs, frame_period=FRAME_MS)
    f0 = pw.stonemask(x, f0, t, fs)
    sp = pw.cheaptrick(x, f0, t, fs)
    ap = pw.d4c(x, f0, t, fs)
    voiced = f0 > 0
    if voiced.sum() < 10:
        return None

    nbin = sp.shape[1]
    freqs = np.linspace(0, fs / 2, nbin)
    band = (freqs >= TILT_LO_HZ) & (freqs <= TILT_HI_HZ)
    fb = freqs[band]
    # 주파수를 로그로 두고 dB 포락에 직선을 맞춘다 → 기울기 dB/decade.
    logf = np.log10(np.maximum(fb, 1.0))
    A = np.vstack([logf, np.ones_like(logf)]).T
    tilts = []
    for i in np.flatnonzero(voiced):
        db = 10.0 * np.log10(np.maximum(sp[i, band], 1e-20))
        db = db - db.mean()                       # 전체 크기는 빼고 기울기만 본다
        tilts.append(np.linalg.lstsq(A, db, rcond=None)[0][0])
    tilt = float(np.median(tilts))

    apv = ap[voiced][:, band]
    return {"tilt_db_per_decade": round(tilt, 3),
            "aperiodicity_mean": round(float(np.mean(apv)), 5),
            "aperiodicity_median": round(float(np.median(apv)), 5),
            "voiced_frames": int(voiced.sum())}


def main():
    items = {}
    for wav in sorted(WAVS.glob("*.wav")):
        spk, num = wav.stem[:3], int(wav.stem[3:])
        emo, sent = EMOTION_BLOCK[num // 100], num % 100
        m = measure(wav)
        if m: items[(spk, sent, emo)] = m

    rows = []
    for (spk, sent, emo), m in sorted(items.items()):
        if emo != TARGET: continue
        base = items.get((spk, sent, "neutral"))
        if not base: continue
        rows.append({"speaker": spk, "sentence": sent,
                     "tilt_delta_db_per_decade": round(m["tilt_db_per_decade"] - base["tilt_db_per_decade"], 3),
                     "aperiodicity_delta": round(m["aperiodicity_mean"] - base["aperiodicity_mean"], 5),
                     "neutral": base, "target": m})

    tilt = np.array([r["tilt_delta_db_per_decade"] for r in rows])
    apd = np.array([r["aperiodicity_delta"] for r in rows])
    summary = {"emotion": TARGET, "pairs": len(rows),
               "tilt_delta_median": round(float(np.median(tilt)), 3),
               "tilt_positive": int((tilt > 0).sum()),
               "aperiodicity_delta_median": round(float(np.median(apd)), 5),
               "aperiodicity_positive": int((apd > 0).sum())}
    (OUT / f"timbre_{TARGET}.json").write_text(
        json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"{EMO_KO[TARGET]}  쌍 {len(rows)}")
    print(f"  기울기 변화(dB/decade)  중앙값 {summary['tilt_delta_median']:+.3f}  "
          f"양수 {summary['tilt_positive']}/{len(rows)}")
    print(f"  비주기성 변화           중앙값 {summary['aperiodicity_delta_median']:+.5f}  "
          f"양수 {summary['aperiodicity_positive']}/{len(rows)}")
    by = {}
    for r in rows: by.setdefault(r["speaker"], []).append(r)
    for s, rs in sorted(by.items()):
        print(f"    {s}  기울기 {np.median([r['tilt_delta_db_per_decade'] for r in rs]):+7.2f}  "
              f"비주기성 {np.median([r['aperiodicity_delta'] for r in rs]):+.5f}  (쌍 {len(rs)})")


if __name__ == "__main__":
    main()
