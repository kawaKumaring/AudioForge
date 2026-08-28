# -*- coding: utf-8 -*-
"""codec token 유사도(참조 prompt codec 대 생성 codec) + 생성 시작 2초 ASR + 5단계 해시.

이미 저장된 산출물만 읽는다 — 새 생성 없음(GPU 게이트 미충족).
"""
import glob
import hashlib
import json
import os
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))
import korean_cer as kc          # noqa: E402

EXP = os.path.join(HERE, "exp")
prep = json.load(open(os.path.join(EXP, "prep.json"), encoding="utf-8"))
MARKER_TOKENS = tuple(prep["marker_tokens"])


def sha8(b):
    return hashlib.sha256(b).hexdigest()[:8]


def file_sha8(p):
    with open(p, "rb") as f:
        return sha8(f.read())


def lcs_run(a, b):
    """두 정수열의 최장 공통 '연속' 부분열 길이(동적계획, O(n*m))."""
    n, m = len(a), len(b)
    if n == 0 or m == 0:
        return 0
    prev = np.zeros(m + 1, dtype=np.int32)
    best = 0
    for i in range(1, n + 1):
        cur = np.zeros(m + 1, dtype=np.int32)
        eq = (b == a[i - 1])
        cur[1:][eq] = prev[:-1][eq] + 1
        best = max(best, int(cur.max()))
        prev = cur
    return best


def ngram_set(seq, n):
    if len(seq) < n:
        return set()
    return {tuple(seq[i:i + n]) for i in range(len(seq) - n + 1)}


def codec_similarity(ref_code, gen_code):
    """참조 prompt codec 과 생성 codec 이 얼마나 같은 토큰을 쓰는가.

    같은 화자면 코드북 사용 분포는 당연히 겹친다 — 그래서 '분포'가 아니라 '연속 일치'를 본다.
    참조 토큰이 그대로 복사됐다면 긴 연속 일치가 나온다."""
    r0 = np.asarray(ref_code[:, 0] if ref_code.ndim > 1 else ref_code, dtype=np.int64)
    g0 = np.asarray(gen_code[:, 0] if gen_code.ndim > 1 else gen_code, dtype=np.int64)
    rq = ref_code if ref_code.ndim > 1 else ref_code[:, None]
    gq = gen_code if gen_code.ndim > 1 else gen_code[:, None]
    q = min(rq.shape[1], gq.shape[1])
    ref_frames = {tuple(int(x) for x in rq[i, :q]) for i in range(rq.shape[0])}
    exact = sum(1 for i in range(gq.shape[0]) if tuple(int(x) for x in gq[i, :q]) in ref_frames)
    out = {
        "ref_frames": int(r0.size), "gen_frames": int(g0.size),
        "quantizers_compared": int(q),
        "exact_full_frame_matches": int(exact),
        "exact_full_frame_rate": round(exact / max(g0.size, 1), 4),
        "codebook0_longest_common_run": int(lcs_run(g0, r0)),
        "codebook0_unique_ref": int(np.unique(r0).size),
        "codebook0_unique_gen": int(np.unique(g0).size),
        "codebook0_symbol_overlap": round(
            len(set(r0.tolist()) & set(g0.tolist())) / max(len(set(g0.tolist())), 1), 4),
    }
    for n in (3, 5):
        rn, gn = ngram_set(r0.tolist(), n), ngram_set(g0.tolist(), n)
        out[f"codebook0_shared_{n}grams"] = len(rn & gn)
    return out


def main():
    import whisper
    import torch
    m = whisper.load_model("large-v3", device="cuda" if torch.cuda.is_available() else "cpu")

    def tr(p):
        r = m.transcribe(p, language="ko", temperature=0.0,
                         condition_on_previous_text=False, verbose=False)
        return (r.get("text") or "").strip()

    def markers(t):
        n = kc.normalize_text(t)
        return sorted({x for x in MARKER_TOKENS if kc.normalize_text(x) in n})

    rows = []
    for d in sorted(glob.glob(os.path.join(EXP, "*", "*"))):
        f4 = os.path.join(d, "s4_final.wav")
        gcp = os.path.join(d, "s3_gen_codes.npy")
        if not (os.path.isfile(f4) and os.path.isfile(gcp)):
            continue
        rec = json.load(open(os.path.join(d, "record.json"), encoding="utf-8"))
        gen = np.load(gcp)

        # 참조 codec 은 저장하지 않았으므로 s3_ref_only.wav 유무로만 확인하고,
        # 유사도는 '같은 조건의 다른 실행' 대조군과 함께 낸다.
        row = {"dir": os.path.basename(d), "mode": os.path.basename(os.path.dirname(d)),
               "tag": rec["tag"],
               "prompt_codec_frames": rec.get("ref_code_frames"),
               "returned_token_frames": rec.get("gen_code_frames"),
               "slice_index_samples": rec.get("generation_start_sample"),
               "slice_error_samples": rec.get("cut_error_samples"),
               "decoded_samples": rec.get("decoded_samples"),
               "final_samples": rec.get("final_samples"),
               "post_slice_first_token": rec.get("gen_code_first5", [None])[0],
               "gen_code_first5": rec.get("gen_code_first5"),
               "input_token_count": rec.get("input_token_count"),
               "ref_token_count": rec.get("ref_token_count"),
               "sha_gen_codes": sha8(gen.tobytes()),
               "sha_s4_final_wav": file_sha8(f4)}
        for extra, key in (("s1_ref_preprocessed.wav", "sha_s1_ref_pre"),
                           ("s3_gen_only.wav", "sha_s3_gen_only"),
                           ("s3_ref_only.wav", "sha_s3_ref_only")):
            p = os.path.join(d, extra)
            if os.path.isfile(p):
                row[key] = file_sha8(p)

        sig, sr = sf.read(f4, dtype="float32")
        head = np.asarray(sig[:int(2.0 * sr)], np.float32)
        hp = os.path.join(d, "_head2s.wav")
        sf.write(hp, head, sr)
        th = tr(hp)
        row["head2s_chars"] = len(th)
        row["head2s_markers"] = markers(th)
        row["head2s_samples"] = int(head.size)
        row["sha_head2s"] = sha8(head.tobytes())

        g3 = os.path.join(d, "s3_gen_only.wav")
        if os.path.isfile(g3):
            row["gen_only_markers"] = markers(tr(g3))
        rows.append(row)

    # codec 유사도: 같은 참조를 쓴 실행끼리(대조군) vs 마커 누출 실행
    by = {r["dir"]: r for r in rows}
    sims = {}
    pairs = [("X2_marker_text_only_0", "X3_control_aligned_0"),
             ("X2_marker_text_only_0", "X2_0"),
             ("X1_repro_original_0", "X3_control_aligned_0")]
    for a, b in pairs:
        pa = os.path.join(EXP, by[a]["mode"], a, "s3_gen_codes.npy") if a in by else None
        pb = os.path.join(EXP, by[b]["mode"], b, "s3_gen_codes.npy") if b in by else None
        if pa and pb and os.path.isfile(pa) and os.path.isfile(pb):
            sims[f"{a}__vs__{b}"] = codec_similarity(np.load(pb), np.load(pa))

    out = {"rows": rows, "codec_similarity_gen_vs_gen": sims}
    with open(os.path.join(EXP, "tokens.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    for r in rows:
        print(f"{r['dir']:26s} prompt={r['prompt_codec_frames']} ret={r['returned_token_frames']} "
              f"slice={r['slice_index_samples']} err={r['slice_error_samples']} "
              f"head2s={r['head2s_markers']} genonly={r.get('gen_only_markers')}")
    print(json.dumps(sims, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
