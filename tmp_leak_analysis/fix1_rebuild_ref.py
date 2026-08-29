# -*- coding: utf-8 -*-
"""수정 검증 1단계 — 사고와 같은 요청(14.0s + 9.0s)을 새 정책으로 다시 태워 참조를 만든다.

before: 예전 경로(trim_region + 창에 걸친 세그먼트 통째로) 재현
after : 새 경로(build_aligned_reference)
원본 vocals.wav 는 읽기만 한다. 산출물은 worktree 안에만 만든다.
"""
import json
import os
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))
import reference_alignment as ra      # noqa: E402
import reference_region as rr         # noqa: E402
import reference_leakage as rl        # noqa: E402

SRC = r"E:\AudioForge_output\버킷리스트\vocals.wav"
OUT = os.path.join(HERE, "fix")
os.makedirs(OUT, exist_ok=True)
REQ_START, REQ_DUR = 14.0, 9.0        # 사고와 동일한 요청


def whisper_segments(path):
    """실제 발화 경계를 얻는다 — 표시용 1초 타임스탬프가 아니라 단어 단위 정렬 결과."""
    import whisper
    import torch
    m = whisper.load_model("large-v3", device="cuda" if torch.cuda.is_available() else "cpu")
    r = m.transcribe(path, language="ko", temperature=0.0,
                     condition_on_previous_text=False, word_timestamps=True, verbose=False)
    segs = []
    for i, s in enumerate(r.get("segments", [])):
        words = s.get("words") or []
        st = float(words[0]["start"]) if words else float(s["start"])
        en = float(words[-1]["end"]) if words else float(s["end"])
        segs.append({"id": f"seg{i}", "start": round(st, 3), "end": round(en, 3),
                     "text": (s.get("text") or "").strip()})
    return segs


def main():
    segs = whisper_segments(SRC)
    sil = rr.detect_silences(SRC)

    report = {"request": {"start_sec": REQ_START, "dur_sec": REQ_DUR},
              "silences": sil,
              "segments": [{"id": s["id"], "start": s["start"], "end": s["end"],
                            "chars": len(s["text"])} for s in segs]}

    # ── before: 예전 경로 재현 (요청 구간 그대로 자르고, 창에 '걸친' 세그먼트까지 통째로) ──
    before_clip = os.path.join(OUT, "before_reference_clip.wav")
    rr.trim_region(SRC, REQ_START, REQ_DUR, before_clip)
    b_end = REQ_START + REQ_DUR
    overlapping = [s for s in segs if s["end"] > REQ_START and s["start"] < b_end]
    before_text = " ".join(s["text"] for s in overlapping).strip()
    b, b_sr = sf.read(before_clip, dtype="float32")
    b_bound = rl.boundary_truncation(np.asarray(b, np.float64), b_sr)
    straddle = [s["id"] for s in overlapping
                if s["start"] < b_end < s["end"] or s["start"] < REQ_START < s["end"]]
    report["before"] = {
        "clip": before_clip, "clip_start": REQ_START, "clip_end": b_end,
        "clip_sec": round(len(b) / b_sr, 4),
        "included_ids": [s["id"] for s in overlapping],
        "straddling_ids": straddle,
        "ref_text_chars": len(before_text),
        "boundary": b_bound,
        "tail_truncated": b_bound["tail_truncated"],
    }

    # ── after: 새 정책 ──
    after_clip = os.path.join(OUT, "after_reference_clip.wav")
    try:
        _, plan = rr.build_aligned_reference(SRC, REQ_START, REQ_DUR, segs, after_clip)
        a, a_sr = sf.read(after_clip, dtype="float32")
        report["after"] = {
            "clip": after_clip, "ok": True, "reason": plan["reason"],
            "clip_start": plan["clip_start"], "clip_end": plan["clip_end"],
            "clip_sec": round(len(a) / a_sr, 4),
            "included_ids": [s["id"] for s in plan["included"]],
            "excluded_ids": [s["id"] for s in plan["excluded"]],
            "ref_text_chars": plan["ref_text_chars"],
            "head_silence_sec": plan["head_silence_sec"],
            "tail_silence_sec": plan["tail_silence_sec"],
            "boundary_silences": plan["boundary_silences"],
            "boundary": plan["clip_boundary_check"],
            "actions": plan["actions"],
            "log": ra.format_plan_log(plan),
        }
        with open(os.path.join(OUT, "after_ref_text.txt"), "w", encoding="utf-8") as f:
            f.write(plan["ref_text"])
        with open(os.path.join(OUT, "before_ref_text.txt"), "w", encoding="utf-8") as f:
            f.write(before_text)
    except ra.AlignmentError as e:
        report["after"] = {"ok": False, "code": e.code, "error": str(e)}

    with open(os.path.join(OUT, "rebuild.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print(json.dumps({k: v for k, v in report.items() if k != "segments"},
                     ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
