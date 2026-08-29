# -*- coding: utf-8 -*-
"""통제실험 준비 — 무음에서 시작·끝나는 깨끗한 참조 클립 + 정확한 전사.

원본 vocals.wav 는 읽기만 한다. 파생물은 전부 worktree 안(exp/)에 만든다.
"""
import json
import os
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))
import reference_leakage as rl      # noqa: E402
import reference_region as rr       # noqa: E402

SRC = r"E:\AudioForge_output\버킷리스트\vocals.wav"
EXP = os.path.join(HERE, "exp")
os.makedirs(EXP, exist_ok=True)

# 마커 문장 — 원본 참조에도 대상 대사에도 없는 어휘만 쓴다. 출력에 이 어휘가 나오면
# 참조에서 왔다는 것이 논증 없이 확정된다.
MARKER_TEXT = "보랏빛 낙타가 우산을 삼켰다."
MARKER_TOKENS = ("보랏", "랏빛", "낙타", "우산", "삼켰")


def silence_map(mono, sr, frame_ms=20.0, hop_ms=10.0, dbfs=-40.0):
    n, h = int(sr * frame_ms / 1000), int(sr * hop_ms / 1000)
    thr = 10.0 ** (dbfs / 20.0)
    k = (mono.size - n) // h + 1
    return np.array([np.sqrt(np.mean(mono[i * h:i * h + n] ** 2)) >= thr for i in range(k)]), h


def main():
    data, sr = sf.read(SRC, dtype="float32", always_2d=True)
    mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]
    mono = np.asarray(mono, np.float64)
    act, hop = silence_map(mono, sr)

    # 실패한 실행의 구간(14.0~23.0s)이 왜 잘렸는지 먼저 기록해 둔다.
    def active_at(sec):
        i = int(sec * sr / hop)
        return bool(act[min(max(i, 0), act.size - 1)])

    report = {"source_sec": round(mono.size / sr, 3), "source_sr": sr,
              "failing_region": {"start_sec": 14.0, "dur_sec": 9.0,
                                 "active_at_start": active_at(14.0),
                                 "active_at_end": active_at(23.0)}}

    # 경계는 '무음 런의 한가운데'에서만 고른다 — 말 도중 절단을 구조적으로 배제한다.
    runs, s = [], None
    for i, v in enumerate(act):
        if not v and s is None:
            s = i
        elif v and s is not None:
            runs.append((s * 0.01, i * 0.01))
            s = None
    mids = [round((a + b) / 2.0, 3) for a, b in runs if (b - a) >= 0.20]
    report["silence_midpoints"] = mids

    best = None
    for a in mids:
        for b in mids:
            dur = round(b - a, 3)
            if not (6.0 <= dur <= 8.0):
                continue
            si, ei = int(a * sr / hop), int(b * sr / hop)
            speech = float(act[si:ei].mean())
            if best is None or speech > best[0]:
                best = (speech, a, dur)
    if best is None:
        raise RuntimeError("무음 경계 후보를 찾지 못했다")
    _, start_sec, dur_sec = best
    report["clipA"] = {"start_sec": start_sec, "dur_sec": dur_sec, "speech_ratio": round(best[0], 4)}

    clip_a = os.path.join(EXP, "clipA.wav")
    rr.trim_region(SRC, start_sec, dur_sec, clip_a)
    a, a_sr = sf.read(clip_a, dtype="float32")
    report["clipA"]["boundary"] = rl.boundary_truncation(np.asarray(a, np.float64), a_sr)
    report["clipA"]["sr"] = int(a_sr)
    report["clipA"]["sec"] = round(len(a) / a_sr, 3)

    # 정확한 전사 — ref_text 가 오디오와 어긋나면 실험 자체가 무효라 여기서 확정한다.
    import whisper
    import torch
    m = whisper.load_model("large-v3", device="cuda" if torch.cuda.is_available() else "cpu")
    r = m.transcribe(clip_a, language="ko", temperature=0.0,
                     condition_on_previous_text=False, verbose=False)
    text_a = (r.get("text") or "").strip()
    report["text_a_chars"] = len(text_a)

    # 원본(실패 실행)의 참조도 같은 조건으로 다시 재어 둔다.
    orig = r"E:\AudioForge_output\expressive-comparison\20260827-A2-emotion3\reference_clip.wav"
    o, o_sr = sf.read(orig, dtype="float32")
    report["original_reference_boundary"] = rl.boundary_truncation(np.asarray(o, np.float64), o_sr)

    payload = {"marker_text": MARKER_TEXT, "marker_tokens": list(MARKER_TOKENS),
               "clip_a_path": clip_a, "text_a": text_a, "report": report}
    with open(os.path.join(EXP, "prep.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print(json.dumps(report, ensure_ascii=False, indent=1))
    print("MARKER:", MARKER_TEXT)
    print("text_a chars:", len(text_a))


if __name__ == "__main__":
    main()
