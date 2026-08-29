# -*- coding: utf-8 -*-
"""통과 기준 계측 — '클립 ASR 음절열' vs 'ref_text 음절열' 편집거리가 0 인가.

지금까지의 계측은 이 값을 보고 있지 않았다. 그래서 세그먼트 단위로는 '완전 포함'인데도
어절 하나가 어긋난 채 통과했다. GPU 생성 없이 기존 클립만 다시 잰다.
"""
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
ORIG = r"E:\AudioForge_output\expressive-comparison\20260827-A2-emotion3\reference_clip.wav"


def last_voiced_sec(sig, sr, dbfs=-40.0, frame_ms=20.0, hop_ms=10.0):
    n, h = int(sr * frame_ms / 1000), int(sr * hop_ms / 1000)
    thr = 10.0 ** (dbfs / 20.0)
    k = max(0, (sig.size - n) // h + 1)
    last = -1
    first = -1
    for i in range(k):
        w = sig[i * h:i * h + n]
        if np.sqrt(np.mean(w * w)) >= thr:
            last = i
            if first < 0:
                first = i
    return ((first * h) / sr if first >= 0 else None,
            ((last * h + n) / sr if last >= 0 else None))


def main():
    import whisper
    import torch
    m = whisper.load_model("large-v3", device="cuda" if torch.cuda.is_available() else "cpu")

    def tr(p):
        r = m.transcribe(p, language="ko", temperature=0.0,
                         condition_on_previous_text=False, word_timestamps=True, verbose=False)
        words = [{"w": w["word"], "s": round(float(w["start"]), 3), "e": round(float(w["end"]), 3)}
                 for s in r.get("segments", []) for w in (s.get("words") or [])]
        return (r.get("text") or "").strip(), words

    rb = json.load(open(os.path.join(FIX, "rebuild.json"), encoding="utf-8"))
    ref_text = open(os.path.join(FIX, "after_ref_text.txt"), encoding="utf-8").read().strip()
    ru = kc.syllable_units(kc.normalize_text(ref_text))

    clips = {
        "before(14.00~23.00, 9.00s)": rb["before"]["clip"],
        "after (14.00~23.65, 9.65s)": rb["after"]["clip"],
        "original_A2(14.0~23.0)": ORIG,
    }
    rows, dump = [], {}
    for name, p in clips.items():
        sig, sr = sf.read(p, dtype="float32")
        sig = np.asarray(sig, np.float64)
        text, words = tr(p)
        cu = kc.syllable_units(kc.normalize_text(text))
        ec = kc.edit_counts(ru, cu)
        first_v, last_v = last_voiced_sec(sig, sr)
        b = rl.boundary_truncation(sig, sr)
        dump[name] = {"text": text, "words": words}
        rows.append({
            "clip": name,
            "clip_sec": round(sig.size / sr, 4),
            "ref_text_syllables": len(ru),
            "clip_asr_syllables": len(cu),
            "edit_sub": ec.substitutions, "edit_del": ec.deletions, "edit_ins": ec.insertions,
            "edit_total": ec.substitutions + ec.deletions + ec.insertions,
            "PASS_edit_zero": (ec.substitutions + ec.deletions + ec.insertions) == 0,
            "first_voiced_sec": None if first_v is None else round(first_v, 3),
            "last_voiced_end_sec": None if last_v is None else round(last_v, 3),
            "head_silence_sec": None if first_v is None else round(first_v, 3),
            "tail_silence_sec": None if last_v is None else round(sig.size / sr - last_v, 3),
            "asr_last_word_end_sec": words[-1]["e"] if words else None,
            "asr_first_word_start_sec": words[0]["s"] if words else None,
            "gap_clipend_minus_lastword": (round(sig.size / sr - words[-1]["e"], 3)
                                           if words else None),
            "boundary_head_dbfs": b["head_dbfs"], "boundary_tail_dbfs": b["tail_dbfs"],
            "boundary_head_truncated": b["head_truncated"],
            "boundary_tail_truncated": b["tail_truncated"],
        })

    with open(os.path.join(FIX, "clipcheck.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    with open(os.path.join(FIX, "clipcheck_PRIVATE.json"), "w", encoding="utf-8") as f:
        json.dump(dump, f, ensure_ascii=False, indent=1)
    for r in rows:
        print(json.dumps(r, ensure_ascii=False))


if __name__ == "__main__":
    main()
