# -*- coding: utf-8 -*-
"""2단계(GPU 불필요) — 토큰 경계 전후 분석 + 디코더 receptive field + 절단 방식 점검.

이미 저장된 s3(보코더 직후 PCM)와 토큰 .npy 만 읽는다. 새 디코딩·생성 없음.
"""
import json, os, sys
import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fix", "gen")
HOP = 1920
SR = 24000

# vendor 상수(qwen_tts/core/tokenizer_12hz/modeling_qwen3_tts_tokenizer_v2.py)
CHUNK_SIZE = 300          # chunked_decode
LEFT_CONTEXT = 25         # chunked_decode 가 '정상 출력에 필요하다'고 보는 좌측 문맥 프레임 수
UPSAMPLE_RATES = (8, 5, 4, 3)
UPSAMPLING_RATIOS = (2, 2)


def frame_energy(x, sr, ms=20.0):
    n = int(sr * ms / 1000)
    k = x.size // n
    return np.array([20 * np.log10(max(float(np.sqrt(np.mean(x[i*n:(i+1)*n] ** 2))), 1e-12))
                     for i in range(k)])


out = {"receptive_field": {
    "total_upsample": int(np.prod(UPSAMPLE_RATES + UPSAMPLING_RATIOS)),
    "codec_hop_samples": HOP,
    "codec_frame_rate_hz": SR / HOP,
    "decoder_is_causal": True,
    "causal_evidence": [
        "CausalConvNet.forward: F.pad(x,(padding,extra)) - 좌측만 패딩",
        "CausalTransConvNet: left_pad=0, right_pad=pad 후 우측 절단",
        "DecoderAttention.is_causal=True + create_causal_mask",
    ],
    "chunked_decode_chunk_size": CHUNK_SIZE,
    "chunked_decode_left_context_frames": LEFT_CONTEXT,
    "left_context_samples": LEFT_CONTEXT * HOP,
    "left_context_sec": LEFT_CONTEXT * HOP / SR,
}}

cases = {}
for name in sorted(os.listdir(FIX)):
    d = os.path.join(FIX, name)
    rj = os.path.join(d, "record.json")
    if not os.path.isfile(rj):
        continue
    rec = json.load(open(rj, encoding="utf-8"))
    prompt = np.load(os.path.join(d, "s0b_prompt_codec.npy"))
    gen = np.load(os.path.join(d, "s1_returned_tokens.npy"))
    s3, sr = sf.read(os.path.join(d, "s3_vocoder_pcm.wav"), dtype="float32")
    s3 = np.asarray(s3, np.float64)
    rl, gl = int(prompt.shape[0]), int(gen.shape[0])
    cut = rec["slice_index_samples"]

    # 단일 chunk 인가 (context 폐기가 일어나지 않는 조건)
    total = rl + gl
    single_chunk = total <= CHUNK_SIZE
    ctx_used = 0 if single_chunk else LEFT_CONTEXT

    # 토큰 경계 비교: prompt 마지막 N 프레임 vs generated 첫 N 프레임
    tok = {}
    for N in (1, 2, 4, 8, 16, 25):
        n = min(N, rl, gl)
        a, b = prompt[-n:], gen[:n]
        q = min(a.shape[1], b.shape[1])
        exact = sum(1 for i in range(n) if np.array_equal(a[i, :q], b[i, :q]))
        tok[f"N{N}"] = {
            "n": n,
            "exact_frame_equal": exact,
            "codebook0_equal": int((a[:, 0] == b[:, 0]).sum()),
            "per_codebook_agree_rate": round(float((a[:, :q] == b[:, :q]).mean()), 4),
        }

    # 보코더 직후 PCM 의 절단 지점 전후 에너지(20ms)
    lo = max(0, cut - int(0.5 * sr))
    hi = min(s3.size, cut + int(2.0 * sr))
    seg = s3[lo:hi]
    e = frame_energy(seg, sr)
    pre = frame_energy(s3[max(0, cut - int(0.5 * sr)):cut], sr)
    post = frame_energy(s3[cut:cut + int(2.0 * sr)], sr)

    cases[name] = {
        "prompt_frames": rl, "generated_frames": gl, "total_frames": total,
        "single_chunk_decode": single_chunk,
        "chunked_decode_context_discarded_frames": ctx_used,
        "cut_sample_index": cut,
        "cut_is_exact_multiple_of_hop": cut % HOP == 0,
        "cut_frame_index": cut / HOP,
        "s3_samples": int(s3.size),
        "s3_expected_samples": total * HOP,
        "generated_region_samples": int(s3.size) - cut,
        "context_bleed_frames_into_generated": min(LEFT_CONTEXT, gl),
        "context_bleed_sec": round(min(LEFT_CONTEXT, gl) * HOP / sr, 3),
        "context_bleed_pct_of_generated": round(
            100.0 * min(LEFT_CONTEXT, gl) / max(gl, 1), 1),
        "token_boundary": tok,
        "pcm_pre_cut_500ms_dbfs_last5": [round(v, 1) for v in pre[-5:]],
        "pcm_post_cut_2000ms_dbfs_first20": [round(v, 1) for v in post[:20]],
    }
out["cases"] = cases
json.dump(out, open(os.path.join(HERE, "fix", "boundary.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print(json.dumps(out, ensure_ascii=False, indent=1))
