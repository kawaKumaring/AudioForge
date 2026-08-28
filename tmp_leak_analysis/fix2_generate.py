# -*- coding: utf-8 -*-
"""수정 검증 2단계 — happy 대사로 before/after 한 쌍 생성 + 7단계 증거.

같은 프로세스에서 같은 seed 로 두 번 생성한다(연속 생성이 결과에 영향을 주지 않는다는 것은
E1~E4 에서 해시 동일로 확인됐다). 참조만 다르고 나머지는 전부 같다.
"""
import argparse
import hashlib
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
LISTEN = r"E:\AudioForge_output\expressive-comparison\20260828-FIX-A"

TARGETS = {
    "happy": "정말 잘됐어! 오늘은 좋은 일이 가득할 것 같아.",
    "angry": "지금 그 말을 다시 해봐. 더는 참을 수 없어.",
    "sad": "이제 정말 끝난 것 같아. 다시는 돌아갈 수 없겠지.",
}
SEEDS = {"happy": 20260830, "angry": 20260831, "sad": 20260832}
CAP = {}


def sha8(b):
    return hashlib.sha256(b).hexdigest()[:8]


def arr(a, name, **kw):
    a = np.asarray(a)
    d = {"name": name, "shape": list(a.shape), "dtype": str(a.dtype), "count": int(a.size),
         "sha8": sha8(np.ascontiguousarray(a).tobytes())}
    d.update(kw)
    return d


def wrap(model):
    inner = model.model
    on = model._normalize_audio_inputs

    def norm(*a, **k):
        o = on(*a, **k)
        CAP["s0a"] = [(np.asarray(w, np.float32).copy(), int(s)) for w, s in o]
        return o
    model._normalize_audio_inputs = norm

    og = inner.generate

    def gen(*a, **k):
        vcp = k.get("voice_clone_prompt") or {}
        rc = vcp.get("ref_code") or []
        CAP["s0b_codec"] = [None if c is None else c.detach().cpu().numpy().copy() for c in rc]
        rids = k.get("ref_ids")
        CAP["s0b_text"] = ([None if t is None else t.detach().cpu().numpy().copy() for t in rids]
                           if rids else None)
        o = og(*a, **k)
        CAP["s1"] = [c.detach().cpu().numpy().copy() for c in o[0]]
        return o
    inner.generate = gen

    st = inner.speech_tokenizer
    od = st.decode

    def dec(items, *a, **k):
        CAP["s2"] = [np.asarray(d["audio_codes"].detach().cpu().numpy()).copy() for d in items]
        w, fs = od(items, *a, **k)
        CAP["s3"] = [np.asarray(x.float().detach().cpu().numpy() if isinstance(x, torch.Tensor)
                                else x, np.float32).copy() for x in w]
        CAP["s3_fs"] = int(fs)
        return w, fs
    st.decode = dec


def run(model, tag, ref_path, ref_text, target, seed, outdir):
    os.makedirs(outdir, exist_ok=True)
    CAP.clear()
    prod = int(model.processor(text=model._build_assistant_text(target),
                               return_tensors="pt")["input_ids"].shape[-1])
    limit = generation_limit.compute_max_new_tokens(prod)
    applied = _seed_rng(seed, 0)
    t0 = time.monotonic()
    wavs, fs = model.generate_voice_clone(text=target, language="Korean", ref_audio=ref_path,
                                          ref_text=ref_text, x_vector_only_mode=False,
                                          max_new_tokens=limit)
    el = round(time.monotonic() - t0, 2)
    s4 = np.asarray(wavs[0] if isinstance(wavs, list) else wavs, np.float32)
    p5 = os.path.join(outdir, "s5_final.wav")
    sf.write(p5, s4, int(fs))

    s0a, s0a_sr = CAP["s0a"][0]
    s0b, s0bt = CAP["s0b_codec"][0], (CAP["s0b_text"] or [None])[0]
    s1, s2, s3 = CAP["s1"][0], CAP["s2"][0], CAP["s3"][0]
    sf.write(os.path.join(outdir, "s0a_ref_pre.wav"), s0a, s0a_sr)
    np.save(os.path.join(outdir, "s0b_prompt_codec.npy"), s0b)
    np.save(os.path.join(outdir, "s1_returned_tokens.npy"), s1)
    np.save(os.path.join(outdir, "s2_vocoder_input_tokens.npy"), s2)
    sf.write(os.path.join(outdir, "s3_vocoder_pcm.wav"), s3, CAP["s3_fs"])
    sf.write(os.path.join(outdir, "s4_postproc_pcm.wav"), s4, int(fs))

    rl_, gl, hop = int(s0b.shape[0]), int(s1.shape[0]), 1920
    total = rl_ + gl
    cut = int(rl_ / max(total, 1) * (total * hop))
    stages = [
        arr(s0a, "0A_ref_preprocessed_pcm", sr=s0a_sr, sec=round(s0a.size / s0a_sr, 4)),
        arr(s0b, "0B_prompt_codec_tokens", frames=rl_),
        arr(s0bt, "0B_prompt_text_ids") if s0bt is not None else None,
        arr(s1, "1_generate_returned_tokens", frames=gl),
        arr(s2, "2_vocoder_input_tokens", frames=int(s2.shape[0])),
        arr(s3, "3_vocoder_output_pcm", sr=CAP["s3_fs"], sec=round(s3.size / CAP["s3_fs"], 4)),
        arr(s4, "4_postproc_pcm", sr=int(fs), sec=round(s4.size / fs, 4)),
        {"name": "5_final_wav", "bytes": os.path.getsize(p5), "sha8": sha8(open(p5, "rb").read()),
         "sec": round(s4.size / fs, 4)},
    ]
    ov = {}
    for K in (5, 10, 20):
        k = min(K, rl_, gl)
        tail, head = s0b[-k:], s2[rl_:rl_ + k]
        eq = sum(1 for i in range(k) if np.array_equal(tail[i], head[i]))
        ov[f"K{K}"] = {"k": int(k), "exact_frame_rate": round(eq / max(k, 1), 4)}

    rec = {"tag": tag, "ref_path": ref_path, "ref_text_chars": len(ref_text),
           "target": target, "seed_applied": applied, "elapsed_sec": el,
           "prompt_codec_frames": rl_, "returned_token_frames": gl,
           "vocoder_input_frames": int(s2.shape[0]), "codec_hop": hop,
           "slice_index_samples": cut, "exact_ref_samples": rl_ * hop,
           "slice_error_samples": cut - rl_ * hop,
           "sample_rate": int(fs), "final_samples": int(s4.size),
           "final_sec": round(s4.size / fs, 4),
           "s2_equals_ref_plus_s1": bool(np.array_equal(s2[:rl_], s0b)
                                         and np.array_equal(s2[rl_:], s1)),
           "stages": [s for s in stages if s], "prompt_tail_vs_postslice_head_overlap": ov}
    with open(os.path.join(outdir, "record.json"), "w", encoding="utf-8") as f:
        json.dump(rec, f, ensure_ascii=False, indent=1)

    # 청취용 — 앞뒤 1.0초 무음 preview 규격. raw 는 손대지 않는다.
    os.makedirs(LISTEN, exist_ok=True)
    sf.write(os.path.join(LISTEN, f"{tag}_raw.wav"), s4, int(fs))
    pad = np.zeros(int(1.0 * fs), np.float32)
    sf.write(os.path.join(LISTEN, f"{tag}_preview.wav"),
             np.concatenate([pad, s4, pad]), int(fs))
    print(tag, "prompt", rl_, "ret", gl, "sec", rec["final_sec"],
          "slice_err", rec["slice_error_samples"], "ovK10", ov["K10"]["exact_frame_rate"])
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--emotions", default="happy")
    a = ap.parse_args()
    os.environ["HF_HOME"] = HF_HOME
    os.environ["HF_HUB_OFFLINE"] = "1"
    from qwen_tts import Qwen3TTSModel

    rb = json.load(open(os.path.join(FIX, "rebuild.json"), encoding="utf-8"))
    before_text = open(os.path.join(FIX, "before_ref_text.txt"), encoding="utf-8").read().strip()
    after_text = open(os.path.join(FIX, "after_ref_text.txt"), encoding="utf-8").read().strip()
    refs = {"before": (rb["before"]["clip"], before_text),
            "after": (rb["after"]["clip"], after_text)}

    model = Qwen3TTSModel.from_pretrained(SNAP, device_map="cuda:0", dtype=torch.bfloat16,
                                          attn_implementation="sdpa", local_files_only=True)
    wrap(model)
    out = []
    for emo in a.emotions.split(","):
        for which in ("before", "after"):
            rp, rt = refs[which]
            out.append(run(model, f"{emo}_{which}", rp, rt, TARGETS[emo], SEEDS[emo],
                           os.path.join(FIX, "gen", f"{emo}_{which}")))
    with open(os.path.join(FIX, "gen", f"records_{a.emotions.replace(',', '_')}.json"),
              "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
