# -*- coding: utf-8 -*-
"""수정 검증 4단계 — before/after 각각 여러 seed 로 돌려 '혼입 발생률'을 잰다.

한 쌍(n=1)으로는 확률적 현상을 판정할 수 없다. 실제로 첫 쌍에서 after 쪽에 혼입이 나왔고,
그것이 수정 실패인지 표본 하나의 흔들림인지 구분하려면 비율이 필요하다.
"""
import argparse
import json
import os
import sys
import time

import numpy as np
import soundfile as sf
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))
import generation_limit                  # noqa: E402
from qwen_bridge import _seed_rng        # noqa: E402

FIX = os.path.join(HERE, "fix")
AF = r"E:\AI_Project\claudeCodeVsCode\apps\development\AudioForge"
HF_HOME = os.path.join(AF, "externals", "qwen3_tts_hf")
SNAP = os.path.join(HF_HOME, "hub", "models--Qwen--Qwen3-TTS-12Hz-0.6B-Base",
                    "snapshots", "5d83992436eae1d760afd27aff78a71d676296fc")
TARGET = "정말 잘됐어! 오늘은 좋은 일이 가득할 것 같아."


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=6)
    ap.add_argument("--base-seed", type=int, default=771000)
    a = ap.parse_args()
    os.environ["HF_HOME"] = HF_HOME
    os.environ["HF_HUB_OFFLINE"] = "1"
    from qwen_tts import Qwen3TTSModel

    rb = json.load(open(os.path.join(FIX, "rebuild.json"), encoding="utf-8"))
    ref_text = open(os.path.join(FIX, "after_ref_text.txt"), encoding="utf-8").read().strip()
    refs = {"before": rb["before"]["clip"], "after": rb["after"]["clip"]}

    model = Qwen3TTSModel.from_pretrained(SNAP, device_map="cuda:0", dtype=torch.bfloat16,
                                          attn_implementation="sdpa", local_files_only=True)
    prod = int(model.processor(text=model._build_assistant_text(TARGET),
                               return_tensors="pt")["input_ids"].shape[-1])
    limit = generation_limit.compute_max_new_tokens(prod)

    out = []
    root = os.path.join(FIX, "rate")
    os.makedirs(root, exist_ok=True)
    for i in range(a.n):
        seed = a.base_seed + i
        for which in ("before", "after"):
            _seed_rng(seed, 0)                      # 같은 seed → 참조만 다른 대조
            t0 = time.monotonic()
            wavs, fs = model.generate_voice_clone(
                text=TARGET, language="Korean", ref_audio=refs[which], ref_text=ref_text,
                x_vector_only_mode=False, max_new_tokens=limit)
            el = round(time.monotonic() - t0, 2)
            w = np.asarray(wavs[0] if isinstance(wavs, list) else wavs, np.float32)
            p = os.path.join(root, f"{which}_s{seed}.wav")
            sf.write(p, w, int(fs))
            out.append({"which": which, "seed": seed, "path": p,
                        "sec": round(w.size / fs, 4), "elapsed": el})
            print(which, seed, round(w.size / fs, 3))
    with open(os.path.join(root, "runs.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
