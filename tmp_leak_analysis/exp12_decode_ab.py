# -*- coding: utf-8 -*-
"""1단계 — 같은 generated token 을 두 방식으로 디코딩해 비교 + context 사다리.

  A. 현재 제품 경로 : prompt+generated 공동 디코딩 후 PCM 비율 절단
  B. 대조 경로     : generated token 단독 디코딩 (= 사다리 k=0)
  L. 사다리        : prompt 마지막 k 프레임만 붙여 디코딩 후 같은 비율 절단

k=0 의 초기조건에 대하여(함정):
  k=0 은 prompt token 을 빼는 조건일 뿐, 디코더의 정상 초기조건을 없애는 조건이 아니다.
  CausalConvNet 은 좌측을 0 으로 패딩하고, 그것은 어떤 발화든 맨 앞을 디코딩할 때 쓰는
  바로 그 초기조건이다. 즉 k=0 은 "이 토큰열이 발화의 시작인 것처럼 디코딩" 이다.
  그래도 출력이 상하는지는 추측하지 말고 재야 한다 — 그래서 k 마다 품질 지표를 함께 낸다.
  혼입이 줄어도 첫 음절이 깨지거나 클릭이 끼면 그 k 는 해답이 아니다.

대조군: 문제 사례만 보면 그 지표가 혼입을 가리키는지 알 수 없다. 혼입이 확인되지 않은
  사례에도 같은 사다리를 그대로 적용해, 같은 패턴이 정상 사례에서도 나오는지 본다.

새 TTS 생성은 하지 않는다 — 저장된 토큰만 쓴다. 일부 사례는 prompt codec 배열이 저장돼
있지 않아 저장된 전처리 참조 PCM 을 다시 encode 해 복원한다(샘플링 없는 결정적 연산).
복원 결과의 프레임 수가 record.json 과 일치하는지 반드시 확인한다.
"""
import argparse
import hashlib
import json
import os

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fix", "ab")
LISTEN = r"E:\AudioForge_output\expressive-comparison\20260828-FIX-A\ab_listen"
HOP, SR = 1920, 24000
LADDER = (0, 1, 2, 4, 8, 16, 25, 50)

CASES = [
    ("happy_before", os.path.join(HERE, "fix", "gen", "happy_before"), "leak_user_confirmed"),
    ("happy_after", os.path.join(HERE, "fix", "gen", "happy_after"), "leak_user_confirmed"),
    ("X3_control", os.path.join(HERE, "exp", "consecutive", "X3_control_aligned_0"),
     "no_leak_measured_only"),
    ("X4_marker_in_audio", os.path.join(HERE, "exp", "consecutive", "X4_marker_in_audio_0"),
     "no_leak_measured_only"),
]


def sha8(b):
    return hashlib.sha256(b).hexdigest()[:8]


def quality(x, sr):
    """품질 지표 — 혼입이 줄어도 여기가 나빠지면 그 k 는 해답이 아니다."""
    x = np.asarray(x, np.float64)
    if x.size == 0:
        return {"empty": True}
    d = np.diff(x)
    n50 = min(x.size - 1, int(0.05 * sr))
    thr = 10.0 ** (-40.0 / 20.0)
    fr, hp = int(sr * 0.02), int(sr * 0.01)
    fv = None
    for i in range(max(0, (x.size - fr) // hp + 1)):
        if np.sqrt(np.mean(x[i * hp:i * hp + fr] ** 2)) >= thr:
            fv = round(i * hp / sr, 4)
            break
    return {
        "first_voiced_sec": fv,
        "peak": round(float(np.abs(x).max()), 5),
        "rms_dbfs": round(20 * np.log10(max(float(np.sqrt(np.mean(x ** 2))), 1e-12)), 2),
        "clipping_ratio": round(float((np.abs(x) >= 0.99).mean()), 6),
        "max_sample_jump": round(float(np.abs(d).max()), 5),
        "head50ms_max_jump": round(float(np.abs(d[:n50]).max()) if n50 > 0 else 0.0, 5),
        "dc_offset": round(float(x.mean()), 6),
        "nonfinite": int((~np.isfinite(x)).sum()),
    }


def emit(tag, pcm, sr, rows, meta):
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(LISTEN, exist_ok=True)
    pcm = np.asarray(pcm, np.float32)
    sf.write(os.path.join(OUT, tag + ".wav"), pcm, sr)
    h2 = np.ascontiguousarray(pcm[:int(2.0 * sr)])
    sf.write(os.path.join(OUT, tag + "_head2s.wav"), h2, sr)
    pad = np.zeros(int(1.0 * sr), np.float32)
    sf.write(os.path.join(LISTEN, tag + "_preview.wav"), np.concatenate([pad, pcm, pad]), sr)
    r = {"tag": tag, "samples": int(pcm.size), "sec": round(pcm.size / sr, 4),
         "pcm_sha8": sha8(pcm.tobytes()), "head2s_sha8": sha8(h2.tobytes())}
    r.update(meta)
    r.update(quality(pcm, sr))
    rows.append(r)


def load_case(d):
    rec = json.load(open(os.path.join(d, "record.json"), encoding="utf-8"))
    p = None
    if os.path.isfile(os.path.join(d, "s0b_prompt_codec.npy")):
        p = np.load(os.path.join(d, "s0b_prompt_codec.npy"))
    g = None
    for n in ("s1_returned_tokens.npy", "s3_gen_codes.npy"):
        if os.path.isfile(os.path.join(d, n)):
            g = np.load(os.path.join(d, n))
            break
    return p, g, rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True)
    a = ap.parse_args()
    rows = []

    if a.stage == "a":
        for name, d, status in CASES:
            _, _, rec = load_case(d)
            s3p = os.path.join(d, "s3_vocoder_pcm.wav")
            if os.path.isfile(s3p):
                s3, sr = sf.read(s3p, dtype="float32")
                pcm = np.asarray(s3)[rec["slice_index_samples"]:]
                src = "s3[cut:]"
            else:
                pcm, sr = sf.read(os.path.join(d, "s4_final.wav"), dtype="float32")
                src = "s4_final(제품 출력이 곧 A 결과)"
            emit(name + "__A_joint_then_cut", pcm, sr, rows,
                 {"case": name, "leak_status": status, "path": "A", "k": None, "source": src,
                  "prompt_frames": rec.get("prompt_codec_frames") or rec.get("ref_code_frames"),
                  "gen_frames": rec.get("returned_token_frames") or rec.get("gen_code_frames")})
        with open(os.path.join(OUT, "rows_a.json"), "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, indent=1)
    else:
        import torch
        os.environ["HF_HOME"] = (r"E:\AI_Project\claudeCodeVsCode\apps\development"
                                 r"\AudioForge\externals\qwen3_tts_hf")
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
            t = torch.as_tensor(np.ascontiguousarray(codes), device=dev)
            w, fs = st.decode([{"audio_codes": t}])
            x = w[0]
            if isinstance(x, torch.Tensor):
                x = x.float().detach().cpu().numpy()
            return np.asarray(x, np.float32), int(fs)

        recon = {}
        for name, d, status in CASES:
            p, g, rec = load_case(d)
            want = rec.get("prompt_codec_frames") or rec.get("ref_code_frames")
            if p is None:
                ref, rsr = sf.read(os.path.join(d, "s1_ref_preprocessed.wav"), dtype="float32")
                enc = st.encode([np.asarray(ref, np.float32)], sr=int(rsr))
                p = np.asarray(enc.audio_codes[0].detach().cpu().numpy())
                recon[name] = {"reconstructed": True}
            else:
                recon[name] = {"reconstructed": False}
            recon[name].update({"frames": int(p.shape[0]), "record_frames": want,
                                "match": int(p.shape[0]) == want})
            gl = int(g.shape[0])
            for k in LADDER:
                kk = min(k, int(p.shape[0]))
                codes = g if kk == 0 else np.concatenate([p[-kk:], g], axis=0)
                pcm, fs = dec(codes)
                cut = 0 if kk == 0 else int(kk / (kk + gl) * pcm.size)
                tag = (name + "__B_genonly_k000") if kk == 0 else (name + "__L_ctx%03d" % kk)
                emit(tag, pcm[cut:], fs, rows,
                     {"case": name, "leak_status": status,
                      "path": "B" if kk == 0 else "L", "k": kk,
                      "prompt_frames": int(p.shape[0]), "gen_frames": gl,
                      "cut_samples": cut, "decoded_samples": int(pcm.size)})
        with open(os.path.join(OUT, "rows_b.json"), "w", encoding="utf-8") as f:
            json.dump({"prompt_codec_recovery": recon, "rows": rows}, f,
                      ensure_ascii=False, indent=1)
        print(json.dumps(recon, ensure_ascii=False, indent=1))

    for r in rows:
        print("%-46s n=%7d fv=%s jump=%s headjump=%s clip=%s sha=%s"
              % (r["tag"], r["samples"], r["first_voiced_sec"], r["max_sample_jump"],
                 r["head50ms_max_jump"], r["clipping_ratio"], r["pcm_sha8"]))


if __name__ == "__main__":
    main()
