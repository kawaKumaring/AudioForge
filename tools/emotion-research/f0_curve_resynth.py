# -*- coding: utf-8 -*-
"""F0 곡선 적용 통로 확인 — A/B/C 세 파일만 만든다. 제품 코드와 분리된 실험 스크립트다.

  A. 원본(승인된 생성 음성). **읽기만 하고 절대 건드리지 않는다.**
  B. 분석 → 파라미터 무변경 재합성.  재합성 자체의 손상을 보는 대조군이다.
  C. B 와 같은 조건에서 **F0 곡선만** 완만하게 바꾼 재합성.

C 의 곡선은 **제어 가능성 시험값**이다. 감정 이름을 붙이지 않는다.
유성 구간만 바꾸고 길이·음량·스펙트럼 포락·비주기성은 그대로 둔다.

한 번의 CPU 처리로 B 와 C 를 만든다(분석 1회를 공유). 후보를 반복 생성하지 않는다.
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import pyworld as pw
import soundfile as sf

HERE = Path(__file__).resolve().parent
SRC = Path(sys.argv[1])
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)

# WORLD 분석 프레임 간격(ms). 기본값 5ms 를 그대로 쓴다.
FRAME_PERIOD = 5.0
# C 의 시험 곡선: 발화 전체에 걸친 완만한 상승. 시작 -1.0 → 끝 +1.0 반음.
# 감정 규칙이 아니라 "곡선을 걸 수 있는가"를 보는 값이다.
C_START_ST = -1.0
C_END_ST = +1.0


def semitone_ratio(st):
    return 2.0 ** (st / 12.0)


def measure(f0, voiced):
    """유성 프레임만으로 잰다. 무성 구간의 0 을 통계에 넣지 않는다."""
    v = f0[voiced]
    if v.size == 0:
        return {"n_voiced": 0}
    return {
        "n_voiced": int(v.size),
        "median_hz": round(float(np.median(v)), 2),
        "q10_hz": round(float(np.quantile(v, 0.10)), 2),
        "q90_hz": round(float(np.quantile(v, 0.90)), 2),
        # 음역 폭(반음) — 중앙값이 아니라 분포 폭이다.
        "range_st": round(float(12.0 * np.log2(np.quantile(v, 0.90) / np.quantile(v, 0.10))), 3),
    }


def main():
    t_all = time.perf_counter()
    x, fs = sf.read(str(SRC), dtype="float64", always_2d=False)
    if x.ndim > 1:                       # 모노만 다룬다(이 실험 대상은 1ch)
        x = x[:, 0]
    src_len = x.size

    # ── 분석 1회 (B·C 가 공유한다) ─────────────────────────────────────
    t0 = time.perf_counter()
    f0, t = pw.harvest(x, fs, frame_period=FRAME_PERIOD)   # F0 (DIO 보다 정확)
    f0 = pw.stonemask(x, f0, t, fs)                        # F0 정련
    sp = pw.cheaptrick(x, f0, t, fs)                       # 스펙트럼 포락
    ap = pw.d4c(x, f0, t, fs)                              # 비주기성
    t_analyze = time.perf_counter() - t0

    voiced = f0 > 0                                        # 유성 판정은 WORLD 것을 그대로 쓴다

    # ── B: 아무것도 바꾸지 않고 재합성 ────────────────────────────────
    t0 = time.perf_counter()
    y_b = pw.synthesize(f0, sp, ap, fs, frame_period=FRAME_PERIOD)
    t_synth_b = time.perf_counter() - t0

    # ── C: F0 곡선만 변경 (유성 프레임만) ─────────────────────────────
    # 발화 전체 길이에 걸친 선형 곡선. 무성 프레임의 0 은 그대로 둔다.
    n = f0.size
    pos = np.linspace(0.0, 1.0, n) if n > 1 else np.zeros(1)
    curve_st = C_START_ST + (C_END_ST - C_START_ST) * pos
    f0_c = f0.copy()
    f0_c[voiced] = f0[voiced] * semitone_ratio(curve_st[voiced])

    t0 = time.perf_counter()
    y_c = pw.synthesize(f0_c, sp, ap, fs, frame_period=FRAME_PERIOD)   # sp·ap 는 B 와 같은 것
    t_synth_c = time.perf_counter() - t0

    # 길이를 원본에 맞춘다(WORLD 합성은 프레임 수에서 나와 몇 샘플 어긋날 수 있다).
    def fit(y):
        if y.size >= src_len:
            return y[:src_len]
        return np.pad(y, (0, src_len - y.size))

    y_b, y_c = fit(y_b), fit(y_c)

    sf.write(str(OUT / "B_resynth_unchanged.wav"), y_b, fs, subtype="PCM_16")
    sf.write(str(OUT / "C_f0curve.wav"), y_c, fs, subtype="PCM_16")

    # ── 출력에서 다시 측정 ────────────────────────────────────────────
    def remeasure(path):
        z, zfs = sf.read(str(path), dtype="float64")
        zf0, zt = pw.harvest(z, zfs, frame_period=FRAME_PERIOD)
        zf0 = pw.stonemask(z, zf0, zt, zfs)
        return zf0, zf0 > 0, z.size

    b_f0, b_voiced, b_len = remeasure(OUT / "B_resynth_unchanged.wav")
    c_f0, c_voiced, c_len = remeasure(OUT / "C_f0curve.wav")

    # 요청한 곡선 vs 출력에서 다시 잰 곡선 — 구간 5등분으로 견준다.
    def segment_medians(f0v, mask, k=5):
        idx = np.linspace(0, f0v.size, k + 1).astype(int)
        out = []
        for a, b in zip(idx[:-1], idx[1:]):
            seg = f0v[a:b][mask[a:b]]
            out.append(round(float(np.median(seg)), 2) if seg.size else None)
        return out

    a_seg = segment_medians(f0, voiced)
    c_req_seg = segment_medians(f0_c, voiced)
    c_out_seg = segment_medians(c_f0, c_voiced)
    b_out_seg = segment_medians(b_f0, b_voiced)

    # 요청 반음 변화량 vs 실제 반음 변화량(구간별, A 대비)
    def st_delta(seg, base):
        out = []
        for s, b in zip(seg, base):
            out.append(round(float(12.0 * np.log2(s / b)), 3) if (s and b) else None)
        return out

    report = {
        "source": str(SRC),
        "sample_rate_hz": int(fs),
        "sample_rate_converted": False,          # WORLD 는 이 fs 를 그대로 받는다(§변환 없음)
        "frame_period_ms": FRAME_PERIOD,
        "requested_curve_semitones": {"start": C_START_ST, "end": C_END_ST,
                                      "shape": "linear over utterance, voiced frames only"},
        "length_samples": {"A": int(src_len), "B": int(b_len), "C": int(c_len)},
        "duration_sec": {k: round(v / fs, 4) for k, v in
                         (("A", src_len), ("B", b_len), ("C", c_len))},
        "voiced_frames": {"A": int(voiced.sum()), "B": int(b_voiced.sum()), "C": int(c_voiced.sum()),
                          "total_frames": int(voiced.size)},
        "unvoiced_frames": {"A": int((~voiced).sum()), "B": int((~b_voiced).sum()),
                            "C": int((~c_voiced).sum())},
        "f0_stats": {"A": measure(f0, voiced), "B": measure(b_f0, b_voiced),
                     "C_requested": measure(f0_c, voiced), "C_measured": measure(c_f0, c_voiced)},
        "segment_median_hz_5": {"A": a_seg, "B_measured": b_out_seg,
                                "C_requested": c_req_seg, "C_measured": c_out_seg},
        "segment_semitone_delta_vs_A": {"B_measured": st_delta(b_out_seg, a_seg),
                                        "C_requested": st_delta(c_req_seg, a_seg),
                                        "C_measured": st_delta(c_out_seg, a_seg)},
        "rms": {"A": round(float(np.sqrt(np.mean(x ** 2))), 6),
                "B": round(float(np.sqrt(np.mean(y_b ** 2))), 6),
                "C": round(float(np.sqrt(np.mean(y_c ** 2))), 6)},
        "elapsed_sec": {"analyze": round(t_analyze, 3), "synth_B": round(t_synth_b, 3),
                        "synth_C": round(t_synth_c, 3), "total": round(time.perf_counter() - t_all, 3)},
        "library": {"pyworld": pw.__version__ if hasattr(pw, "__version__") else "0.3.5",
                    "algorithms": ["harvest", "stonemask", "cheaptrick", "d4c", "synthesize"]},
    }
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
