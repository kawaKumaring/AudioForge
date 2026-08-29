# -*- coding: utf-8 -*-
"""확정 실험 4개 판정 — 단계별 마커 ASR / 시작 2초 ASR / fresh vs sequential 해시 대조."""
import glob
import json
import os
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))
import korean_cer as kc   # noqa: E402

AB = os.path.join(HERE, "exp_ab")
TOK = {"A": ("보랏", "랏빛", "낙타", "우산", "삼켰"),
       "B": ("무쇠", "해오", "오라", "라기", "벽돌", "쌓았")}


def main():
    import whisper
    import torch
    m = whisper.load_model("large-v3", device="cuda" if torch.cuda.is_available() else "cpu")

    def tr(p):
        r = m.transcribe(p, language="ko", temperature=0.0,
                         condition_on_previous_text=False, verbose=False)
        return (r.get("text") or "").strip()

    def hits(t):
        n = kc.normalize_text(t)
        return {k: sorted([x for x in v if kc.normalize_text(x) in n]) for k, v in TOK.items()}

    rows = []
    for d in sorted(glob.glob(os.path.join(AB, "*", "*_marker*"))):
        rec = json.load(open(os.path.join(d, "record.json"), encoding="utf-8"))
        exp = os.path.basename(os.path.dirname(d))
        row = {"experiment": exp, "tag": rec["tag"],
               "own_marker": rec["tag"][-1],
               "prompt_codec_frames": rec["prompt_codec_frames"],
               "returned_token_frames": rec["returned_token_frames"],
               "vocoder_input_frames": rec["vocoder_input_frames"],
               "s2_is_ref_plus_s1": rec["s2_equals_ref_plus_s1"],
               "slice_index_samples": rec["slice_index_samples"],
               "slice_error_samples": rec["slice_error_samples"],
               "final_sec": round(rec["final_samples"] / rec["sample_rate"], 3),
               "overlap": rec["prompt_tail_vs_postslice_head_overlap"],
               "stage_sha": {s["name"]: s["sha8"] for s in rec["stages"]},
               "seed_applied": rec["seed_applied"]}
        for f, tag in (("s0a_ref_pre.wav", "stage0A"), ("s3_vocoder_pcm.wav", "stage3"),
                       ("s5_final.wav", "stage5")):
            p = os.path.join(d, f)
            if os.path.isfile(p):
                row[f"{tag}_markers"] = hits(tr(p))
        sig, sr = sf.read(os.path.join(d, "s5_final.wav"), dtype="float32")
        hp = os.path.join(d, "_head2s.wav")
        sf.write(hp, np.asarray(sig[:int(2.0 * sr)], np.float32), sr)
        t2 = tr(hp)
        row["head2s_chars"] = len(t2)
        row["head2s_markers"] = hits(t2)
        rows.append(row)

    # fresh vs sequential — 같은 마커끼리 최종 WAV 해시 비교
    byk = {}
    for r in rows:
        byk.setdefault(r["own_marker"], []).append(
            (r["experiment"], r["stage_sha"].get("5_final_wav"), r["final_sec"]))
    out = {"rows": rows, "fresh_vs_sequential": byk}
    with open(os.path.join(AB, "verdict_ab.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    for r in rows:
        print(f"{r['experiment']:16s} {r['tag']:14s} own={r['own_marker']} "
              f"ovK10={r['overlap']['K10']['exact_frame_rate']} "
              f"s0A={r.get('stage0A_markers')} s3={r.get('stage3_markers')} "
              f"s5={r.get('stage5_markers')} head2s={r['head2s_markers']}")
    print(json.dumps(byk, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
