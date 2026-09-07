# -*- coding: utf-8 -*-
"""목소리만 바꾸고 연기는 그대로 둔다 — 감정이 살아남는지 보는 시험.

지금까지 우리는 **중립 음성에 감정을 덧칠**했고 세 번 다 실패했다.
이번은 반대다. **이미 감정이 실린 실제 연기**에서 목소리(정체성)만 바꾼다.

WORLD 가 소리를 셋으로 나눈다.
  · F0        음높이 궤적  ← 연기. 그대로 둔다
  · 비주기성   숨소리       ← 연기. 그대로 둔다
  · 스펙트럼 포락  성도 모양 = **정체성** ← 이것만 바꾼다

포먼트를 주파수축으로 밀어 성도 길이를 바꾼다(VTLN). 음높이도 타이밍도 건드리지 않는다.

만드는 것
  A 원본 구간
  B 무변경 재합성  ← 대조군. 재합성 자체가 만드는 변화를 가르기 위해 반드시 필요하다
  C 목소리 바꿈    ← 연기 재료는 A 와 동일하고 성도 모양만 다르다

**한계(미리 적는다)**: 이건 제대로 된 목소리 변환의 대용품이다. 진짜 VC 는 숨소리까지
대상 화자 것으로 바꾸지만 C 는 숨소리를 원본에서 유지한다. 즉 **C 는 진짜 VC 보다
감정에 유리한 조건**이다. C 에서도 감정이 죽으면 강한 경고 신호다.
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import pyworld as pw
import soundfile as sf

SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])
SPANS = [tuple(float(v) for v in a.split(":")) for a in sys.argv[3:]]
OUT.mkdir(parents=True, exist_ok=True)

FRAME_MS = 5.0
PAD_SEC = 0.03          # 구간 경계에서 말머리·말끝이 잘리지 않게 아주 조금만 남긴다
LOW_REGISTER_HZ = 165.0  # 이보다 낮으면 포먼트를 올려서, 높으면 내려서 다른 사람으로 만든다


def warp_envelope(sp, alpha):
    """스펙트럼 포락을 주파수축으로 민다. alpha>1 이면 포먼트가 올라간다(성도가 짧아진 효과)."""
    n = sp.shape[1]
    src = np.clip(np.arange(n) / alpha, 0, n - 1)
    lo = np.floor(src).astype(int)
    hi = np.minimum(lo + 1, n - 1)
    w = (src - lo)[None, :]
    out = sp[:, lo] * (1.0 - w) + sp[:, hi] * w
    return np.ascontiguousarray(out, dtype=np.float64)  # pyworld 는 C-contiguous 만 받는다


def main():
    x, fs = sf.read(str(SRC), dtype="float64")
    mono = x.mean(axis=1) if x.ndim > 1 else x
    report = {"source": SRC.name, "sample_rate": int(fs), "segments": []}

    for a_sec, b_sec in SPANS:
        tag = f"seg_{a_sec:.2f}-{b_sec:.2f}".replace(".", "p")
        a = max(0, int((a_sec - PAD_SEC) * fs))
        b = min(mono.size, int((b_sec + PAD_SEC) * fs))
        seg = np.ascontiguousarray(mono[a:b])
        t0 = time.perf_counter()

        f0, t = pw.harvest(seg, fs, frame_period=FRAME_MS)
        f0 = pw.stonemask(seg, f0, t, fs)
        sp = pw.cheaptrick(seg, f0, t, fs)
        ap = pw.d4c(seg, f0, t, fs)
        voiced = f0 > 0
        if voiced.sum() < 10:
            print(f"{tag}: 유성 프레임이 너무 적다 — 건너뛴다")
            continue
        f0_med = float(np.median(f0[voiced]))
        alpha = 1.20 if f0_med < LOW_REGISTER_HZ else 0.85

        y_b = pw.synthesize(f0, sp, ap, fs, frame_period=FRAME_MS)
        y_c = pw.synthesize(f0, warp_envelope(sp, alpha), ap, fs, frame_period=FRAME_MS)
        fit = lambda y: (y[:seg.size] if y.size >= seg.size
                         else np.pad(y, (0, seg.size - y.size)))
        files = {"A_original": seg, "B_resynth_unchanged": fit(y_b), "C_voice_changed": fit(y_c)}

        d = OUT / tag
        d.mkdir(exist_ok=True)
        # 음량 맞춤 — 기준 A 의 RMS, 고정 gain 만. 압축·리미터·음높이 변경 없음.
        rms = {k: float(np.sqrt(np.mean(v ** 2))) for k, v in files.items()}
        gains = {}
        for k, y in files.items():
            g = rms["A_original"] / max(rms[k], 1e-12)
            z = y * g
            sf.write(str(d / f"{k}.wav"), z, fs, subtype="PCM_16")
            gains[k] = {"gain_db": round(20 * np.log10(g), 3),
                        "peak": round(float(np.abs(z).max()), 4),
                        "clipped": int((np.abs(z) >= 0.999).sum())}

        # 재측정 — 연기 재료가 정말 그대로인지 확인한다. 이게 이번 시험의 전제다.
        def remeasure(p):
            z, zfs = sf.read(str(p), dtype="float64")
            zf, zt = pw.harvest(z, zfs, frame_period=FRAME_MS)
            zf = pw.stonemask(z, zf, zt, zfs)
            v = zf > 0
            return {"f0_median": round(float(np.median(zf[v])), 2) if v.any() else None,
                    "duration": round(z.size / zfs, 3)}

        m = {k: remeasure(d / f"{k}.wav") for k in files}
        report["segments"].append({
            "tag": tag, "span_sec": [a_sec, b_sec], "length_sec": round(seg.size / fs, 3),
            "f0_median_hz": round(f0_med, 2),
            "register": "낮음(포먼트 올림)" if alpha > 1 else "높음(포먼트 내림)",
            "warp_alpha": alpha, "voiced_frames": int(voiced.sum()),
            "measured": m, "level_match": gains,
            "elapsed_sec": round(time.perf_counter() - t0, 2)})
        print(f"{tag}  길이 {seg.size / fs:.2f}초  F0중앙값 {f0_med:.1f}Hz  "
              f"워핑 {alpha}  ({time.perf_counter() - t0:.1f}초)")
        for k in files:
            print(f"    {k:22s} F0 {m[k]['f0_median']}Hz  {m[k]['duration']}초  "
                  f"음량보정 {gains[k]['gain_db']:+.2f}dB  클립 {gains[k]['clipped']}")

    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2),
                                     encoding="utf-8")


if __name__ == "__main__":
    main()
