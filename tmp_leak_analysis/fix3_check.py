# -*- coding: utf-8 -*-
"""수정 검증 3단계 — before/after 의 참조 꼬리 혼입 판정.

마커가 없는 실제 대사 조건이라 판정은 (a) 참조에만 있는 짧은 n-gram, (b) 시작 2초 ASR,
(c) 단계별 등장 위치로 한다. 전사 원문은 파일로만 남기고 콘솔에는 지표만 낸다.
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
import korean_cer as kc          # noqa: E402
import reference_leakage as rl   # noqa: E402

FIX = os.path.join(HERE, "fix")
TARGETS = {
    "happy": "정말 잘됐어! 오늘은 좋은 일이 가득할 것 같아.",
    "angry": "지금 그 말을 다시 해봐. 더는 참을 수 없어.",
    "sad": "이제 정말 끝난 것 같아. 다시는 돌아갈 수 없겠지.",
}


def main():
    import whisper
    import torch
    m = whisper.load_model("large-v3", device="cuda" if torch.cuda.is_available() else "cpu")

    def tr(p):
        r = m.transcribe(p, language="ko", temperature=0.0,
                         condition_on_previous_text=False, verbose=False)
        return (r.get("text") or "").strip()

    ref_txt = {
        "before": open(os.path.join(FIX, "before_ref_text.txt"), encoding="utf-8").read().strip(),
        "after": open(os.path.join(FIX, "after_ref_text.txt"), encoding="utf-8").read().strip(),
    }

    rows, dump = [], {}
    for d in sorted(glob.glob(os.path.join(FIX, "gen", "*_*"))):
        name = os.path.basename(d)
        if not os.path.isdir(d):
            continue
        emo, which = name.rsplit("_", 1)
        rec = json.load(open(os.path.join(d, "record.json"), encoding="utf-8"))
        ru = kc.syllable_units(kc.normalize_text(ref_txt[which]))
        tu = kc.syllable_units(kc.normalize_text(TARGETS[emo]))

        f5 = os.path.join(d, "s5_final.wav")
        full = tr(f5)
        sig, sr = sf.read(f5, dtype="float32")
        hp = os.path.join(d, "_head2s.wav")
        sf.write(hp, np.asarray(sig[:int(2.0 * sr)], np.float32), sr)
        head = tr(hp)
        dump[name] = {"full": full, "head2s": head}

        fu = kc.syllable_units(kc.normalize_text(full))
        hu = kc.syllable_units(kc.normalize_text(head))
        short_full = rl.short_ngram_leaks(ru, tu, fu, sizes=(2, 3))
        short_head = rl.short_ngram_leaks(ru, tu, hu, sizes=(2, 3))
        old_style = rl.short_ngram_leaks(ru, tu, fu, sizes=(4, 5))
        ec = kc.edit_counts(tu, fu)

        rows.append({
            "case": name, "emotion": emo, "which": which,
            "final_sec": rec["final_sec"],
            "prompt_codec_frames": rec["prompt_codec_frames"],
            "returned_token_frames": rec["returned_token_frames"],
            "slice_error_samples": rec["slice_error_samples"],
            "overlap_K10": rec["prompt_tail_vs_postslice_head_overlap"]["K10"]["exact_frame_rate"],
            "target_syllables": len(tu), "asr_syllables": len(fu),
            "cer": round((ec.substitutions + ec.deletions + ec.insertions) / max(len(tu), 1), 4),
            "ins": ec.insertions, "dele": ec.deletions, "sub": ec.substitutions,
            "ref_leak_full_2_3": short_full["total"],
            "ref_leak_full_items": short_full["per_size"]["3"]["items"][:10],
            "ref_leak_head2s_2_3": short_head["total"],
            "ref_leak_head2s_items": short_head["per_size"]["3"]["items"][:10],
            "old_4_5_style": old_style["total"],
            "head2s_syllables": len(hu),
            "stage_sha": {s["name"]: s["sha8"] for s in rec["stages"]},
        })

    with open(os.path.join(FIX, "verdict_fix.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    with open(os.path.join(FIX, "transcripts_PRIVATE.json"), "w", encoding="utf-8") as f:
        json.dump(dump, f, ensure_ascii=False, indent=1)

    for r in rows:
        print(f"{r['case']:16s} sec={r['final_sec']:5.2f} ret={r['returned_token_frames']:3d} "
              f"asr_syl={r['asr_syllables']:3d}/{r['target_syllables']:3d} cer={r['cer']:.3f} "
              f"ins={r['ins']:2d} leak_full={r['ref_leak_full_2_3']:2d} "
              f"leak_head2s={r['ref_leak_head2s_2_3']:2d} old={r['old_4_5_style']} "
              f"items={r['ref_leak_head2s_items']}")


if __name__ == "__main__":
    main()
