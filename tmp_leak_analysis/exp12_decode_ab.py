# -*- coding: utf-8 -*-
"""1단계 — 같은 generated token 을 두 방식으로 디코딩해 비교.

  A. 현재 제품 경로 : prompt+generated 공동 디코딩 → PCM 비율 절단   (저장물로 재구성 가능, GPU 불필요)
  B. 대조 경로     : post-slice generated token 단독 디코딩        (보코더 필요, GPU)
  L. context 사다리 : prompt 마지막 k 프레임만 붙여 디코딩 후 절단   (k=0 이 곧 B)

--stage a  : GPU 없이 A 산출물만 뽑는다(이미 저장된 s3/s4 사용)
--stage b  : 보코더로 B 와 사다리를 만든다(qwen venv, GPU 게이트 통과 시에만)
제품 코드는 건드리지 않는다 — 전부 이 스크립트 안에서만 한다.
"""
import argparse, hashlib, json, os, sys
import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fix", "gen")
OUT = os.path.join(HERE, "fix", "ab")
LISTEN = r"E:\AudioForge_output\expressive-comparison\20260828-FIX-A\ab_listen"
HOP, SR = 1920, 24000
LADDER = (0, 1, 2, 4, 8, 16, 25, 50)


def sha8(b): return hashlib.sha256(b).hexdigest()[:8]


def first_voiced(x, sr, dbfs=-40.0, frame_ms=20.0, hop_ms=10.0):
    n, h = int(sr*frame_ms/1000), int(sr*hop_ms/1000)
    thr = 10.0 ** (dbfs/20.0)
    for i in range(max(0, (x.size-n)//h + 1)):
        if np.sqrt(np.mean(x[i*h:i*h+n]**2)) >= thr:
            return round(i*h/sr, 4)
    return None


def emit(tag, pcm, sr, rows):
    os.makedirs(OUT, exist_ok=True); os.makedirs(LISTEN, exist_ok=True)
    pcm = np.asarray(pcm, np.float32)
    p = os.path.join(OUT, f"{tag}.wav"); sf.write(p, pcm, sr)
    h2 = pcm[:int(2.0*sr)]
    sf.write(os.path.join(OUT, f"{tag}_head2s.wav"), h2, sr)
    pad = np.zeros(int(1.0*sr), np.float32)
    sf.write(os.path.join(LISTEN, f"{tag}_preview.wav"), np.concatenate([pad, pcm, pad]), sr)
    rows.append({"tag": tag, "samples": int(pcm.size), "sec": round(pcm.size/sr, 4),
                 "pcm_sha8": sha8(pcm.tobytes()), "head2s_sha8": sha8(np.ascontiguousarray(h2).tobytes()),
                 "first_voiced_sec": first_voiced(np.asarray(pcm, np.float64), sr),
                 "wav": p})


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--stage", required=True)
    a = ap.parse_args()
    rows = []
    cases = [d for d in sorted(os.listdir(FIX)) if os.path.isfile(os.path.join(FIX, d, "record.json"))]

    if a.stage == "a":
        for name in cases:
            d = os.path.join(FIX, name)
            rec = json.load(open(os.path.join(d, "record.json"), encoding="utf-8"))
            s3, sr = sf.read(os.path.join(d, "s3_vocoder_pcm.wav"), dtype="float32")
            cut = rec["slice_index_samples"]
            emit(f"{name}__A_joint_then_cut", np.asarray(s3)[cut:], sr, rows)
        json.dump(rows, open(os.path.join(OUT, "rows_a.json"), "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
    else:
        import torch
        os.environ["HF_HOME"] = r"E:\AI_Project\claudeCodeVsCode\apps\development\AudioForge\externals\qwen3_tts_hf"
        os.environ["HF_HUB_OFFLINE"] = "1"
        from qwen_tts import Qwen3TTSModel
        snap = os.path.join(os.environ["HF_HOME"], "hub",
                            "models--Qwen--Qwen3-TTS-12Hz-0.6B-Base", "snapshots",
                            "5d83992436eae1d760afd27aff78a71d676296fc")
        model = Qwen3TTSModel.from_pretrained(snap, device_map="cuda:0", dtype=torch.bfloat16,
                                              attn_implementation="sdpa", local_files_only=True)
        st = model.model.speech_tokenizer
        dev = getattr(st, "device", None) or torch.device("cuda:0")

        def dec(codes):
            w, fs = st.decode([{"audio_codes": torch.as_tensor(codes, device=dev)}])
            x = w[0]
            if isinstance(x, torch.Tensor):
                x = x.float().detach().cpu().numpy()
            return np.asarray(x, np.float32), int(fs)

        for name in cases:
            d = os.path.join(FIX, name)
            prompt = np.load(os.path.join(d, "s0b_prompt_codec.npy"))
            gen = np.load(os.path.join(d, "s1_returned_tokens.npy"))
            for k in LADDER:
                k = min(k, prompt.shape[0])
                codes = gen if k == 0 else np.concatenate([prompt[-k:], gen], axis=0)
                pcm, fs = dec(codes)
                cut = 0 if k == 0 else int(k / (k + gen.shape[0]) * pcm.size)
                tag = f"{name}__B_genonly" if k == 0 else f"{name}__L_ctx{k:03d}"
                emit(tag, pcm[cut:], fs, rows)
        json.dump(rows, open(os.path.join(OUT, "rows_b.json"), "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
    for r in rows:
        print(f"{r['tag']:44s} n={r['samples']:7d} sec={r['sec']:6.3f} "
              f"first_voiced={r['first_voiced_sec']} sha={r['pcm_sha8']}")


if __name__ == "__main__":
    main()
