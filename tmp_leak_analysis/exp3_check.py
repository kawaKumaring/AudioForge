# -*- coding: utf-8 -*-
"""통제실험 판정 — 4구간 중 마커가 처음 등장하는 구간을 찾는다 + NCC.

s3_gen_only.wav = 원시 생성 codec 토큰만 보코더에 통과시킨 것(참조 prefix 없음).
s4_final.wav    = vendor 경로(참조+생성 이어 디코드 후 잘라내기)의 최종 결과.
마커가 s3 에 이미 있으면 conditioning, s4 에만 있으면 vocoder/후처리.
"""
import glob
import json
import os
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))
import reference_leakage as rl   # noqa: E402
import korean_cer as kc          # noqa: E402

EXP = os.path.join(HERE, "exp")
prep = json.load(open(os.path.join(EXP, "prep.json"), encoding="utf-8"))
MARKER_TOKENS = tuple(prep["marker_tokens"])
CLIP_A = prep["clip_a_path"]
ORIG_REF = r"E:\AudioForge_output\expressive-comparison\20260827-A2-emotion3\reference_clip.wav"


def load(p):
    d, sr = sf.read(p, dtype="float32", always_2d=False)
    if d.ndim > 1:
        d = d.mean(axis=1)
    return np.asarray(d, np.float64), int(sr)


def marker_hits(text):
    """정규화 후 마커 어휘가 몇 개 들어왔는지. 마커는 우리가 만든 고유 어휘라 오검출 여지가 없다."""
    norm = kc.normalize_text(text)
    return sorted({t for t in MARKER_TOKENS if kc.normalize_text(t) in norm})


def main():
    import whisper
    import torch
    m = whisper.load_model("large-v3", device="cuda" if torch.cuda.is_available() else "cpu")

    def tr(p):
        r = m.transcribe(p, language="ko", temperature=0.0,
                         condition_on_previous_text=False, verbose=False)
        return (r.get("text") or "").strip()

    ref_for = {
        "X1_repro_original": ORIG_REF,
        "X2_marker_text_only": CLIP_A,
        "X3_control_aligned": CLIP_A,
        "X4_marker_in_audio": os.path.join(EXP, "clipA_plus_marker.wav"),
        "X2_0": CLIP_A, "X2_last": CLIP_A, "X0_marker": CLIP_A,
    }

    rows = []
    dirs = sorted(glob.glob(os.path.join(EXP, "*", "*")))
    for d in dirs:
        f4 = os.path.join(d, "s4_final.wav")
        if not os.path.isfile(f4):
            continue
        name = os.path.basename(d)
        mode = os.path.basename(os.path.dirname(d))
        base = name.rsplit("_", 1)[0] if name.rsplit("_", 1)[-1].isdigit() else name
        rec = json.load(open(os.path.join(d, "record.json"), encoding="utf-8"))
        row = {"mode": mode, "dir": name, "tag": rec["tag"],
               "final_sec": rec["final_sec"],
               "ref_code_frames": rec.get("ref_code_frames"),
               "gen_code_frames": rec.get("gen_code_frames"),
               "cut_error_samples": rec.get("cut_error_samples"),
               "generation_start_sample": rec.get("generation_start_sample"),
               "input_token_count": rec.get("input_token_count"),
               "ref_token_count": rec.get("ref_token_count"),
               "input_eos_count": rec.get("input_eos_count"),
               "ref_eos_count": rec.get("ref_eos_count"),
               "gen_code_eos2150_count": rec.get("gen_code_eos2150_count")}

        t4 = tr(f4)
        row["s4_marker"] = marker_hits(t4)
        row["s4_chars"] = len(t4)
        f3 = os.path.join(d, "s3_gen_only.wav")
        if os.path.isfile(f3):
            t3 = tr(f3)
            row["s3_marker"] = marker_hits(t3)
            row["s3_chars"] = len(t3)
            g, gsr = load(f3)
            row["s3_gen_only_sec"] = round(g.size / gsr, 3)
        f1 = os.path.join(d, "s1_ref_preprocessed.wav")
        if os.path.isfile(f1):
            t1 = tr(f1)
            row["s1_marker"] = marker_hits(t1)
        # NCC — 파형 그대로 복사됐는가(단독 판정 근거로 쓰지 않는다)
        rp = ref_for.get(base)
        if rp and os.path.isfile(rp):
            gen, sr = load(f4)
            ref, rsr = load(rp)
            if sr == rsr:
                sc = rl.waveform_copy_scan(gen, ref, sr)
                row["ncc_peak"] = sc["peak_ncc"]
                row["ncc_peak_out_sec"] = sc["peak_out_sec"]
                row["ncc_peak_ref_sec"] = sc["peak_ref_sec"]
                row["ncc_copy_detected"] = sc["copy_detected"]
        rows.append(row)

    with open(os.path.join(EXP, "verdict.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    for r in rows:
        print(f"{r['mode']:12s} {r['tag']:32s} sec={r['final_sec']:5.2f} "
              f"s1={r.get('s1_marker')} s3={r.get('s3_marker')} s4={r['s4_marker']} "
              f"ncc={r.get('ncc_peak')}")


if __name__ == "__main__":
    main()
