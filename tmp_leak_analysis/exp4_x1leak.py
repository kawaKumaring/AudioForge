# -*- coding: utf-8 -*-
"""X1(원본 실패 config 재현)에서 참조 꼬리 조각이 다시 나오는지 + 토큰 통계 요약."""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))
import reference_leakage as rl   # noqa: E402
import korean_cer as kc          # noqa: E402

EXP = os.path.join(HERE, "exp")
ORIG = r"E:\AudioForge_output\expressive-comparison\20260827-A2-emotion3"
cfg = json.load(open(os.path.join(ORIG, "config_happy.json"), encoding="utf-8"))
REF_TEXT = cfg["ttsReferencePrompts"]["default"]["manual_text"]
TARGET = "정말 잘됐어! 오늘은 좋은 일이 가득할 것 같아."

ref_u = kc.syllable_units(kc.normalize_text(REF_TEXT))
tgt_u = kc.syllable_units(kc.normalize_text(TARGET))


def main():
    import whisper
    import torch
    m = whisper.load_model("large-v3", device="cuda" if torch.cuda.is_available() else "cpu")

    def tr(p, **kw):
        r = m.transcribe(p, language="ko", temperature=0.0,
                         condition_on_previous_text=False, verbose=False, **kw)
        return (r.get("text") or "").strip()

    out = []
    for d in sorted(glob.glob(os.path.join(EXP, "consecutive", "X1_repro_original_*"))):
        f4 = os.path.join(d, "s4_final.wav")
        rec = json.load(open(os.path.join(d, "record.json"), encoding="utf-8"))
        t = tr(f4)
        u = kc.syllable_units(kc.normalize_text(t))
        short = rl.short_ngram_leaks(ref_u, tgt_u, u, sizes=(2, 3))
        old = rl.short_ngram_leaks(ref_u, tgt_u, u, sizes=(4, 5))
        # 머리 1.5초만 따로 — 전체 디코딩이 삼키는 앞머리 조각을 드러낸다
        import numpy as np
        import soundfile as sf
        sig, sr = sf.read(f4, dtype="float32")
        hp = os.path.join(d, "_head15.wav")
        sf.write(hp, np.asarray(sig[:int(1.5 * sr)], np.float32), sr)
        th = tr(hp)
        uh = kc.syllable_units(kc.normalize_text(th))
        shorth = rl.short_ngram_leaks(ref_u, tgt_u, uh, sizes=(2, 3))
        out.append({"dir": os.path.basename(d), "final_sec": rec["final_sec"],
                    "asr_syllables": len(u), "target_syllables": len(tgt_u),
                    "full_short_2_3": short["total"],
                    "full_short_items": short["per_size"]["3"]["items"][:8],
                    "full_old_4_5": old["total"],
                    "head15_syllables": len(uh),
                    "head15_short_2_3": shorth["total"],
                    "head15_items": shorth["per_size"]["3"]["items"][:8]})
    print(json.dumps(out, ensure_ascii=False, indent=1))

    # 토큰 통계 요약(조건별 대표 1건)
    v = json.load(open(os.path.join(EXP, "verdict.json"), encoding="utf-8"))
    keys = ("tag", "input_token_count", "ref_token_count", "input_eos_count", "ref_eos_count",
            "ref_code_frames", "gen_code_frames", "gen_code_eos2150_count",
            "generation_start_sample", "cut_error_samples", "final_sec")
    print(json.dumps([{k: r.get(k) for k in keys} for r in v if r.get("input_token_count")],
                     ensure_ascii=False, indent=1))
    with open(os.path.join(EXP, "x1_leak.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
