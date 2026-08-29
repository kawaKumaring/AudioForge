# -*- coding: utf-8 -*-
"""통제실험 본체 — 마커 참조로 생성하고 4구간(전처리 참조 / 입력 토큰 / 원시 생성 토큰 / 최종 WAV)을 저장.

vendor(qwen_tts) 파일은 건드리지 않는다. 계측은 이 스크립트에서 런타임 래핑으로만 한다.
실행: qwen3_tts_venv 의 python. `--mode consecutive|fresh`.
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
import generation_limit  # noqa: E402

EXP = os.path.join(HERE, "exp")
AF = r"E:\AI_Project\claudeCodeVsCode\apps\development\AudioForge"
HF_HOME = os.path.join(AF, "externals", "qwen3_tts_hf")
SNAP = os.path.join(HF_HOME, "hub", "models--Qwen--Qwen3-TTS-12Hz-0.6B-Base",
                    "snapshots", "5d83992436eae1d760afd27aff78a71d676296fc")
ORIG_DIR = r"E:\AudioForge_output\expressive-comparison\20260827-A2-emotion3"

TARGET = "정말 잘됐어! 오늘은 좋은 일이 가득할 것 같아."
SR = 24000

_CAP = {}


def _wrap(model):
    """전처리 참조(1) / 입력 토큰(2) / 원시 생성 토큰(3) 을 가로챈다. 생성 분포는 건드리지 않는다."""
    inner = model.model

    orig_norm = model._normalize_audio_inputs
    def norm(*a, **k):
        out = orig_norm(*a, **k)
        _CAP["ref_pre"] = [(np.asarray(w, np.float32).copy(), int(s)) for w, s in out]
        return out
    model._normalize_audio_inputs = norm

    orig_gen = inner.generate
    def gen(*a, **k):
        ids = k.get("input_ids")
        rids = k.get("ref_ids")
        vcp = k.get("voice_clone_prompt") or {}
        _CAP["input_ids"] = [t.detach().cpu().tolist() for t in ids] if isinstance(ids, list) \
            else ids.detach().cpu().tolist()
        _CAP["ref_ids"] = ([None if t is None else t.detach().cpu().tolist() for t in rids]
                           if rids else None)
        rc = vcp.get("ref_code") or []
        _CAP["ref_code"] = [None if c is None else c.detach().cpu().numpy().copy() for c in rc]
        out = orig_gen(*a, **k)
        _CAP["gen_codes"] = [c.detach().cpu().numpy().copy() for c in out[0]]
        return out
    inner.generate = gen


def _decode(model, codes_np):
    """codec 토큰만 따로 보코더에 통과 — '원시 생성 토큰에 이미 있는가'를 직접 듣기 위한 것."""
    st = model.model.speech_tokenizer
    dev = getattr(st, "device", None) or torch.device("cuda:0")
    t = torch.as_tensor(codes_np, device=dev)
    wavs, fs = model.model.speech_tokenizer.decode([{"audio_codes": t}])
    w = wavs[0]
    if isinstance(w, torch.Tensor):
        w = w.float().detach().cpu().numpy()
    return np.asarray(w, np.float32), int(fs)


def _tok_stats(model, ids, ref_ids):
    tk = getattr(model.processor, "tokenizer", None)
    bos = getattr(tk, "bos_token_id", None) if tk else None
    eos = getattr(tk, "eos_token_id", None) if tk else None
    flat = ids[0] if (ids and isinstance(ids[0], list)) else ids
    r = (ref_ids or [None])[0]
    rflat = (r[0] if (r and isinstance(r[0], list)) else r) if r else None
    return {"bos_token_id": bos, "eos_token_id": eos,
            "input_token_count": len(flat),
            "input_bos_count": (flat.count(bos) if bos is not None else None),
            "input_eos_count": (flat.count(eos) if eos is not None else None),
            "ref_token_count": (len(rflat) if rflat else 0),
            "ref_bos_count": (rflat.count(bos) if (rflat and bos is not None) else 0),
            "ref_eos_count": (rflat.count(eos) if (rflat and eos is not None) else 0)}


def run_one(model, builder, proc, tag, ref_path, ref_text, target, outdir, dump=True):
    os.makedirs(outdir, exist_ok=True)
    _CAP.clear()
    at = builder(target)
    prod = int(proc(text=at, return_tensors="pt")["input_ids"].shape[-1])
    limit = generation_limit.compute_max_new_tokens(prod)
    t0 = time.monotonic()
    wavs, fs = model.generate_voice_clone(text=target, language="Korean",
                                          ref_audio=ref_path, ref_text=ref_text,
                                          x_vector_only_mode=False, max_new_tokens=limit)
    el = round(time.monotonic() - t0, 2)

    final = np.asarray(wavs[0] if isinstance(wavs, list) else wavs, np.float32)
    sf.write(os.path.join(outdir, "s4_final.wav"), final, int(fs))

    rc = (_CAP.get("ref_code") or [None])[0]
    gc_ = (_CAP.get("gen_codes") or [None])[0]
    rec = {"tag": tag, "prod_tokens": prod, "generation_limit": limit,
           "elapsed_sec": el, "sample_rate": int(fs),
           "final_samples": int(final.size), "final_sec": round(final.size / fs, 4),
           "ref_text_chars": len(ref_text), "target_chars": len(target)}
    rec.update(_tok_stats(model, _CAP.get("input_ids"), _CAP.get("ref_ids")))

    if rc is not None:
        rec["ref_code_frames"] = int(rc.shape[0])
        rec["ref_code_quantizers"] = int(rc.shape[1]) if rc.ndim > 1 else 1
    if gc_ is not None:
        rec["gen_code_frames"] = int(gc_.shape[0])
        col0 = gc_[:, 0] if gc_.ndim > 1 else gc_
        rec["gen_code_eos2150_count"] = int((col0 == 2150).sum())
        rec["gen_code_first5"] = [int(x) for x in col0[:5]]
        rec["gen_code_last5"] = [int(x) for x in col0[-5:]]
    if rc is not None and gc_ is not None:
        total = rc.shape[0] + gc_.shape[0]
        decoded = total * 1920
        cut = int(rc.shape[0] / max(total, 1) * decoded)
        rec.update({"codec_hop": 1920, "total_frames": int(total),
                    "decoded_samples": int(decoded), "cut_samples": int(cut),
                    "exact_ref_samples": int(rc.shape[0] * 1920),
                    "cut_error_samples": int(cut - rc.shape[0] * 1920),
                    "generation_start_sample": int(cut),
                    "generation_start_sec": round(cut / fs, 4),
                    "expected_final_samples": int(decoded - cut)})

    if dump:
        pre = _CAP.get("ref_pre")
        if pre:
            w, s = pre[0]
            sf.write(os.path.join(outdir, "s1_ref_preprocessed.wav"), w, s)
            rec["ref_pre_samples"] = int(w.size)
            rec["ref_pre_sr"] = int(s)
        with open(os.path.join(outdir, "s2_input_tokens.json"), "w", encoding="utf-8") as f:
            json.dump({"input_ids": _CAP.get("input_ids"), "ref_ids": _CAP.get("ref_ids")}, f)
        if gc_ is not None:
            np.save(os.path.join(outdir, "s3_gen_codes.npy"), gc_)
            w, s = _decode(model, gc_)
            sf.write(os.path.join(outdir, "s3_gen_only.wav"), w, s)
            rec["gen_only_samples"] = int(w.size)
        if rc is not None:
            w, s = _decode(model, rc)
            sf.write(os.path.join(outdir, "s3_ref_only.wav"), w, s)
    with open(os.path.join(outdir, "record.json"), "w", encoding="utf-8") as f:
        json.dump(rec, f, ensure_ascii=False, indent=1)
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="consecutive")
    ap.add_argument("--samples", type=int, default=3)
    args = ap.parse_args()

    os.environ["HF_HOME"] = HF_HOME
    os.environ["HF_HUB_OFFLINE"] = "1"
    from qwen_tts import Qwen3TTSModel

    prep = json.load(open(os.path.join(EXP, "prep.json"), encoding="utf-8"))
    clip_a, text_a = prep["clip_a_path"], prep["text_a"]
    marker = prep["marker_text"]
    orig_ref = os.path.join(ORIG_DIR, "reference_clip.wav")
    orig_text = json.load(open(os.path.join(ORIG_DIR, "config_happy.json"),
                               encoding="utf-8"))["ttsReferencePrompts"]["default"]["manual_text"]

    model = Qwen3TTSModel.from_pretrained(SNAP, device_map="cuda:0", dtype=torch.bfloat16,
                                          attn_implementation="sdpa", local_files_only=True)
    builder, proc = model._build_assistant_text, model.processor
    _wrap(model)

    root = os.path.join(EXP, args.mode)
    os.makedirs(root, exist_ok=True)
    out = []

    if args.mode == "fresh":
        # 갓 뜬 프로세스의 '첫' 생성만 — 캐시/버퍼 잔류 비교의 기준점
        out.append(run_one(model, builder, proc, "X2_marker_text_only#fresh0", clip_a,
                           text_a + " " + marker, TARGET, os.path.join(root, "X2_0")))
    else:
        # X0: 마커 오디오 합성(같은 화자). 이 결과를 X4 참조 뒤에 붙인다.
        m0 = os.path.join(root, "X0_marker")
        out.append(run_one(model, builder, proc, "X0_marker_synth", clip_a, text_a,
                           marker, m0))
        a, asr = sf.read(clip_a, dtype="float32")
        mk, mksr = sf.read(os.path.join(m0, "s4_final.wav"), dtype="float32")
        assert asr == mksr, (asr, mksr)
        ref_marker = os.path.join(EXP, "clipA_plus_marker.wav")
        sf.write(ref_marker, np.concatenate([a, np.zeros(int(0.3 * asr), np.float32), mk,
                                             np.zeros(int(0.25 * asr), np.float32)]), asr)

        conds = [
            ("X1_repro_original", orig_ref, orig_text),
            ("X2_marker_text_only", clip_a, text_a + " " + marker),
            ("X3_control_aligned", clip_a, text_a),
            ("X4_marker_in_audio", ref_marker, text_a + " " + marker),
        ]
        for name, rp, rt in conds:
            for i in range(args.samples):
                out.append(run_one(model, builder, proc, f"{name}#{i}", rp, rt, TARGET,
                                   os.path.join(root, f"{name}_{i}"), dump=(i == 0)))
        # 같은 프로세스에서 마지막으로 X2 재실행 — 연속 생성 누적 효과 비교
        out.append(run_one(model, builder, proc, "X2_marker_text_only#last", clip_a,
                           text_a + " " + marker, TARGET,
                           os.path.join(root, "X2_last"), dump=False))

    with open(os.path.join(root, "records.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    for r in out:
        print(r["tag"], "final_sec", r["final_sec"], "ref_frames", r.get("ref_code_frames"),
              "gen_frames", r.get("gen_code_frames"), "cut_err", r.get("cut_error_samples"))


if __name__ == "__main__":
    main()
