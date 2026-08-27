# -*- coding: utf-8 -*-
"""진단 6/7/8 — codec prompt 길이·슬라이싱 산술 복원, 참조 클립 절단 여부.

GPU/모델 로딩 없이 관측 길이만으로 vendor 슬라이싱을 역산한다.
"""
import json
import os

import numpy as np
import soundfile as sf

SRC = r"E:\AudioForge_output\expressive-comparison\20260827-A2-emotion3"
HOP = 1920          # tokenizer_12hz: encode_downsample_rate == decode_upsample_rate == 1920
SR = 24000

OBS = {  # emotion: (generated_iterations, 출력 샘플 수)
    "happy": (62, 117120),
    "angry": (61, 115201),
    "sad": (55, 103680),
}


def vendor_cut(ref_len, gen_len):
    """qwen3_tts_model.generate_voice_clone 의 실제 슬라이싱 재현.
    total = ref+gen, wav = total*HOP, cut = int(ref/total * wav), 출력 = wav-cut."""
    total = ref_len + gen_len
    wav = total * HOP
    cut = int(ref_len / max(total, 1) * wav)
    return wav - cut, cut


def solve():
    """(ref_len, delta) 를 전수 탐색. delta = generated_iterations - 실제 codes 길이."""
    hits = []
    for ref_len in range(1, 400):
        for delta in range(0, 4):
            ok = True
            for e, (it, n) in OBS.items():
                out, _ = vendor_cut(ref_len, it - delta)
                if out != n:
                    ok = False
                    break
            if ok:
                hits.append((ref_len, delta))
    return hits


def main():
    res = {}
    ref, sr = sf.read(os.path.join(SRC, "reference_clip.wav"), dtype="float32")
    if ref.ndim > 1:
        ref = ref.mean(axis=1)
    ref = ref.astype(np.float64)

    # ---- 진단 6/7 ----
    hits = solve()
    res["slicing_solutions"] = [{"ref_code_frames": r, "iters_minus_codes": d} for r, d in hits]
    res["encode_ceil_frames_for_9s"] = int(-(-ref.size // HOP))   # vendor encode 의 ceil 나눗셈
    detail = {}
    for e, (it, n) in OBS.items():
        row = {}
        for r, d in hits:
            out, cut = vendor_cut(r, it - d)
            exact = r * HOP
            row[f"ref{r}_delta{d}"] = {
                "gen_frames": it - d, "decoded_samples": (r + it - d) * HOP,
                "cut_samples": cut, "exact_ref_samples": exact,
                "cut_error_samples": cut - exact,       # 음수 = 참조가 그만큼 남음
                "output_samples": out, "matches_observed": out == n,
                "output_equals_gen_frames_x_hop": out == (it - d) * HOP,
            }
        detail[e] = row
    res["per_emotion_slicing"] = detail

    # ---- 진단 8: 참조 클립이 말 도중에 잘렸는가 ----
    def rms_db(x):
        if x.size == 0:
            return -999.0
        v = float(np.sqrt(np.mean(x * x)))
        return round(20.0 * np.log10(max(v, 1e-12)), 2)

    tail = {}
    for ms in (100, 200, 300, 500, 1000):
        n = int(sr * ms / 1000)
        tail[f"last{ms}ms_dbfs"] = rms_db(ref[-n:])
        tail[f"first{ms}ms_dbfs"] = rms_db(ref[:n])
    # 20ms 프레임 RMS 로 마지막 '유성 프레임' 위치
    n, h = int(sr * 0.02), int(sr * 0.01)
    thr = 10.0 ** (-40.0 / 20.0)
    k = (ref.size - n) // h + 1
    act = np.array([np.sqrt(np.mean(ref[i * h:i * h + n] ** 2)) >= thr for i in range(k)])
    last_active = int(np.max(np.where(act)[0])) if act.any() else -1
    tail["last_active_frame_end_sec"] = round((last_active * h + n) / sr, 3)
    tail["clip_sec"] = round(ref.size / sr, 3)
    tail["trailing_silence_sec"] = round(ref.size / sr - (last_active * h + n) / sr, 3)
    tail["active_ratio"] = round(float(act.mean()), 4)
    res["reference_tail"] = tail

    print(json.dumps(res, ensure_ascii=False, indent=1))
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "a4_codec_align.json"),
              "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
