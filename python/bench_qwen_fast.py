"""Qwen 보조 모델 — 원래 · 직접 반복(loop) · 묶어 실행(graph)의 속도와 결과를 같은 문장·씨앗 3개로 잰다.

★격리 환경(externals/qwen3_tts_venv)의 파이썬으로 돈다 — qwen_tts 가 거기에만 있다. GPU 를 쓴다(몇 분).
★2026-09-30 실측(소희 · RTX 5070 Ti): 원래 29초 → loop 27.5초(원래와 비트까지 같은 소리) → graph 10초(받아 적기 일치 1.00).
  만든 소리는 테스트 폴더 _local/테스트/결과/qgraph 에 남는다 — 받아 적기로 따로 확인한다(앱 파이썬의 whisper).

실행: externals/qwen3_tts_venv/Scripts/python.exe -X utf8 python/bench_qwen_fast.py
"""
import json, os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import numpy as np, torch, soundfile as sf
import qwen_custom_voice as qcv, qwen_fast

MODEL = os.path.join(ROOT, "externals", "qwen3_tts_0_6b_customvoice")
import _test_root   # 테스트 전용 폴더(_local/테스트) — 2026-10-10
OUT = _test_root.test_dir("results", "qgraph")
TEXT = "그는 천천히 문을 열고 어두운 복도를 내다보았다. 멀리서 물이 떨어지는 소리만 일정하게 이어졌다."
m = qcv.load(MODEL)
cp = m.model.talker.code_predictor
orig_gen = cp.generate

def run(seed):
    torch.manual_seed(seed); torch.cuda.manual_seed_all(seed)
    torch.cuda.synchronize(); t = time.time()
    wavs, sr = m.generate_custom_voice(text=TEXT, speaker="sohee", language="korean")
    torch.cuda.synchronize()
    return np.asarray(wavs[0], dtype=np.float32), sr, time.time() - t

res = {}
for mode in ("orig", "loop", "graph"):
    cp.generate = orig_gen
    if mode == "loop":
        os.environ["AUDIOFORGE_QWEN_GRAPH"] = "0"; qwen_fast.apply(m)
    elif mode == "graph":
        os.environ["AUDIOFORGE_QWEN_GRAPH"] = "1"; qwen_fast.apply(m)
    run(99)                                            # 데우기(묶어 실행은 여기서 기록한다)
    rows = []
    for seed in (0, 1, 2):
        w, sr, t = run(seed)
        sf.write(os.path.join(OUT, "%s_%d.wav" % (mode, seed)), w, sr, subtype="PCM_16")
        rows.append({"seed": seed, "audio_s": round(len(w) / sr, 2), "gen_s": round(t, 2), "rtf": round(len(w) / sr / t, 2)})
    res[mode] = rows
res["graph_failed"] = bool(getattr(cp, "_af_graph_failed", False))
print(json.dumps(res, ensure_ascii=False))
