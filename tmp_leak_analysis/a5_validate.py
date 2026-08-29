# -*- coding: utf-8 -*-
"""새 검출기가 '실제로 놓쳤던 그 건'을 잡는지 확인(읽기 전용)."""
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

SRC = r"E:\AudioForge_output\expressive-comparison\20260827-A2-emotion3"
EMO = ("happy", "angry", "sad")


def load(p):
    d, sr = sf.read(p, dtype="float32", always_2d=False)
    if d.ndim > 1:
        d = d.mean(axis=1)
    return np.asarray(d, np.float64), int(sr)


ref, sr = load(os.path.join(SRC, "reference_clip.wav"))
tx = json.load(open(os.path.join(HERE, "a3_transcripts_PRIVATE.json"), encoding="utf-8"))
cfg0 = json.load(open(os.path.join(SRC, "config_happy.json"), encoding="utf-8"))
ref_units = kc.syllable_units(kc.normalize_text(
    cfg0["ttsReferencePrompts"]["default"]["manual_text"]))

out = {"boundary_truncation_reference_clip": rl.boundary_truncation(ref, sr)}
per = {}
for e in EMO:
    sig, s_sr = load(os.path.join(SRC, f"{e}_raw.wav"))
    cfg = json.load(open(os.path.join(SRC, f"config_{e}.json"), encoding="utf-8"))
    tgt_units = kc.syllable_units(kc.normalize_text(cfg["ttsText"]))
    row = {"waveform_copy": rl.waveform_copy_scan(sig, ref, s_sr)}
    row["waveform_copy"].pop("hits", None)
    for tag, text in (("full", tx[e]["full"]["text"]),
                      ("head1.5s", tx[e]["edge"]["head"]["text"]),
                      ("tail1.5s", tx[e]["edge"]["tail"]["text"])):
        asr_units = kc.syllable_units(kc.normalize_text(text))
        r2 = rl.short_ngram_leaks(ref_units, tgt_units, asr_units, sizes=(2, 3))
        r4 = rl.short_ngram_leaks(ref_units, tgt_units, asr_units, sizes=(4, 5))
        row[f"ngram_{tag}"] = {"short_2_3_total": r2["total"],
                               "old_style_4_5_total": r4["total"],
                               "leak_detected": r2["leak_detected"]}
    per[e] = row
out["per_emotion"] = per
print(json.dumps(out, ensure_ascii=False, indent=1))
