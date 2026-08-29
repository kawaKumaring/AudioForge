# -*- coding: utf-8 -*-
"""확정 실험 4개 — 마커 A/B 참조로 7단계 증거를 남긴다. 프로세스 1회 호출 = 실험 1개.

7단계: 0-A 전처리 참조 PCM / 0-B 실제 전달 prompt token / 1 model.generate 전체 반환 토큰 /
       2 보코더에 전달된 토큰(=prompt slicing 이후) / 3 보코더 직후 PCM /
       4 후처리 직후 PCM / 5 최종 저장 WAV
vendor(qwen_tts) 파일은 건드리지 않는다 — 전부 런타임 래핑.
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
import generation_limit                      # noqa: E402
from qwen_bridge import _seed_rng            # noqa: E402  진단 계측(57d1fa6)

EXP = os.path.join(HERE, "exp")
AF = r"E:\AI_Project\claudeCodeVsCode\apps\development\AudioForge"
HF_HOME = os.path.join(AF, "externals", "qwen3_tts_hf")
SNAP = os.path.join(HF_HOME, "hub", "models--Qwen--Qwen3-TTS-12Hz-0.6B-Base",
                    "snapshots", "5d83992436eae1d760afd27aff78a71d676296fc")
TARGET = "정말 잘됐어! 오늘은 좋은 일이 가득할 것 같아."
MARKERS = {"A": ("보랏빛 낙타가 우산을 삼켰다.", 20260828),
           "B": ("무쇠 해오라기가 벽돌을 쌓았다.", 20260829)}
CAP = {}


def sha8(b):
    return hashlib.sha256(b).hexdigest()[:8]


def arr(a, name):
    a = np.asarray(a)
    return {"name": name, "shape": list(a.shape), "dtype": str(a.dtype),
            "count": int(a.size), "sha8": sha8(np.ascontiguousarray(a).tobytes())}


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
        ids, rids = k.get("input_ids"), k.get("ref_ids")
        CAP["s0b_text_ids"] = ([None if t is None else t.detach().cpu().numpy().copy() for t in rids]
                               if rids else None)
        CAP["input_ids"] = ([t.detach().cpu().numpy().copy() for t in ids]
                            if isinstance(ids, list) else ids.detach().cpu().numpy().copy())
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


def run(model, builder, proc, tag, ref_path, ref_text, seed, outdir):
    os.makedirs(outdir, exist_ok=True)
    CAP.clear()
    prod = int(proc(text=builder(TARGET), return_tensors="pt")["input_ids"].shape[-1])
    limit = generation_limit.compute_max_new_tokens(prod)
    applied = _seed_rng(seed, 0)
    t0 = time.monotonic()
    wavs, fs = model.generate_voice_clone(text=TARGET, language="Korean", ref_audio=ref_path,
                                          ref_text=ref_text, x_vector_only_mode=False,
                                          max_new_tokens=limit)
    el = round(time.monotonic() - t0, 2)
    s4 = np.asarray(wavs[0] if isinstance(wavs, list) else wavs, np.float32)
    p5 = os.path.join(outdir, "s5_final.wav")
    sf.write(p5, s4, int(fs))

    s0a, s0a_sr = CAP["s0a"][0]
    s0b = CAP["s0b_codec"][0]
    s0bt = (CAP["s0b_text_ids"] or [None])[0]
    s1 = CAP["s1"][0]
    s2 = CAP["s2"][0]
    s3 = CAP["s3"][0]
    sf.write(os.path.join(outdir, "s0a_ref_pre.wav"), s0a, s0a_sr)
    np.save(os.path.join(outdir, "s0b_prompt_codec.npy"), s0b)
    if s0bt is not None:
        np.save(os.path.join(outdir, "s0b_prompt_text_ids.npy"), s0bt)
    np.save(os.path.join(outdir, "s1_returned_tokens.npy"), s1)
    np.save(os.path.join(outdir, "s2_vocoder_input_tokens.npy"), s2)
    sf.write(os.path.join(outdir, "s3_vocoder_pcm.wav"), s3, CAP["s3_fs"])
    sf.write(os.path.join(outdir, "s4_postproc_pcm.wav"), s4, int(fs))

    rl_, gl = int(s0b.shape[0]), int(s1.shape[0])
    total, hop = rl_ + gl, 1920
    cut = int(rl_ / max(total, 1) * (total * hop))
    stages = [
        dict(arr(s0a, "0A_ref_preprocessed_pcm"), sr=s0a_sr, sec=round(s0a.size / s0a_sr, 4)),
        dict(arr(s0b, "0B_prompt_codec_tokens"), frames=rl_),
        dict(arr(s1, "1_generate_returned_tokens"), frames=gl),
        dict(arr(s2, "2_vocoder_input_tokens"), frames=int(s2.shape[0])),
        dict(arr(s3, "3_vocoder_output_pcm"), sr=CAP["s3_fs"], sec=round(s3.size / CAP["s3_fs"], 4)),
        dict(arr(s4, "4_postproc_pcm"), sr=int(fs), sec=round(s4.size / fs, 4)),
        {"name": "5_final_wav", "path": p5, "bytes": os.path.getsize(p5),
         "sha8": sha8(open(p5, "rb").read()), "sec": round(s4.size / fs, 4)},
    ]
    if s0bt is not None:
        stages.insert(2, dict(arr(s0bt, "0B_prompt_text_ids"), count=int(s0bt.size)))

    # 0-B prompt tail 과 2번 post-slice head 의 직접 토큰 중복률
    ov = {}
    for K in (5, 10, 20):
        k = min(K, rl_, gl)
        tail, head = s0b[-k:], s2[rl_:rl_ + k]
        eq = sum(1 for i in range(k) if np.array_equal(tail[i], head[i]))
        ov[f"K{K}"] = {
            "k": int(k),
            "exact_frame_equal": int(eq),
            "exact_frame_rate": round(eq / max(k, 1), 4),
            "codebook0_equal": int((tail[:, 0] == head[:, 0]).sum()) if tail.ndim > 1 else 0,
            "codebook0_rate": round(float((tail[:, 0] == head[:, 0]).mean()) if tail.ndim > 1 else 0.0, 4),
            "setwise_frame_overlap": round(
                len({tuple(map(int, r)) for r in tail} & {tuple(map(int, r)) for r in head}) / max(k, 1), 4),
        }
    rec = {"tag": tag, "ref_path": ref_path, "ref_text_chars": len(ref_text),
           "seed_requested": seed, "seed_applied": applied, "elapsed_sec": el,
           "prod_tokens": prod, "generation_limit": limit, "sample_rate": int(fs),
           "prompt_codec_frames": rl_, "returned_token_frames": gl,
           "vocoder_input_frames": int(s2.shape[0]), "codec_hop": hop,
           "slice_index_samples": cut, "exact_ref_samples": rl_ * hop,
           "slice_error_samples": cut - rl_ * hop,
           "vocoder_pcm_samples": int(s3.size), "final_samples": int(s4.size),
           "s2_equals_ref_plus_s1": bool(s2.shape[0] == rl_ + gl
                                         and np.array_equal(s2[:rl_], s0b)
                                         and np.array_equal(s2[rl_:], s1)),
           "stages": stages, "prompt_tail_vs_postslice_head_overlap": ov}
    with open(os.path.join(outdir, "record.json"), "w", encoding="utf-8") as f:
        json.dump(rec, f, ensure_ascii=False, indent=1)
    print(tag, "prompt", rl_, "ret", gl, "voc_in", int(s2.shape[0]),
          "slice_err", rec["slice_error_samples"], "overlapK10",
          ov["K10"]["exact_frame_rate"], "sec", round(s4.size / fs, 3))
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)          # A | B | AB
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    os.environ["HF_HOME"] = HF_HOME
    os.environ["HF_HUB_OFFLINE"] = "1"
    from qwen_tts import Qwen3TTSModel
    prep = json.load(open(os.path.join(EXP, "prep.json"), encoding="utf-8"))
    clip, text_a = prep["clip_a_path"], prep["text_a"]
    model = Qwen3TTSModel.from_pretrained(SNAP, device_map="cuda:0", dtype=torch.bfloat16,
                                          attn_implementation="sdpa", local_files_only=True)
    wrap(model)
    out = []
    for i, key in enumerate(list(a.run)):
        mk, seed = MARKERS[key]
        out.append(run(model, model._build_assistant_text, model.processor,
                       f"{a.run}#{i}_marker{key}", clip, text_a + " " + mk, seed,
                       os.path.join(a.out, f"{i}_marker{key}")))
    with open(os.path.join(a.out, "records.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
