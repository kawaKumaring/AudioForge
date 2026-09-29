"""Qwen3-TTS **지정 목소리**(CustomVoice) — 참조 소리 없이 모델 안의 목소리로 읽는다.

★격리 환경(externals/qwen3_tts_venv)의 파이썬으로 돈다 — qwen_tts 패키지가 거기에만 있다.
  앱 쪽(tts_worker 의 QwenCustomEngine)이 한 조각마다 이 스크립트를 부른다.
★인터넷에 닿지 않는다 — 받아 둔 폴더 '경로'로 열고 local_files_only. 모델 불러오기는 qwen_bridge 와 같은 방식
  (GPU 면 bfloat16, sdpa 먼저·실패하면 eager).
★2026-09-30 지시: "Qwen 기본 목소리에서 한국어가 있다면 받아 본다." — 0.6B CustomVoice 의 한국어 목소리(Sohee).

쓰는 법(격리 파이썬으로):
  python qwen_custom_voice.py --model <폴더> --list
  python qwen_custom_voice.py --model <폴더> --speaker sohee --language korean --text-file <글.txt> --out <소리.wav> [--seed 0]
출력: JSON 한 줄씩. 마지막 줄이 {"type": "done", ...} 또는 {"type": "error", "message": ...}.
"""
import argparse
import json
import sys


def emit(**kw):
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load(model_dir):
    import gc
    import torch
    from qwen_tts import Qwen3TTSModel
    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device.startswith("cuda") else torch.float32
    errors = {}
    for attn in ("sdpa", "eager"):
        try:
            return Qwen3TTSModel.from_pretrained(model_dir, device_map=device, dtype=dtype,
                                                 attn_implementation=attn, local_files_only=True)
        except Exception as e:
            errors[attn] = "%s: %s" % (type(e).__name__, str(e)[:200])
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
    raise RuntimeError("모델을 열지 못했습니다 — %s" % errors)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--speaker")
    ap.add_argument("--language", default="korean")
    ap.add_argument("--text-file")
    ap.add_argument("--out")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    try:
        m = load(a.model)
        if a.list:
            emit(type="done", speakers=m.get_supported_speakers(), languages=m.get_supported_languages())
            return 0
        import numpy as np
        import soundfile as sf
        import torch
        with open(a.text_file, encoding="utf-8") as f:
            text = f.read().strip()
        if not text:
            raise RuntimeError("읽을 글이 없습니다")
        # 같은 글·같은 목소리는 같은 소리 — 낭독의 쌓아 두기와 새로 만든 것이 갈리지 않게.
        torch.manual_seed(a.seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(a.seed)
        wavs, sr = m.generate_custom_voice(text=text, speaker=a.speaker, language=a.language)
        wav = np.asarray(wavs[0], dtype="float32").reshape(-1)
        if wav.size == 0 or not np.isfinite(wav).all():
            raise RuntimeError("소리가 비었거나 깨졌습니다")
        sf.write(a.out, wav, int(sr), subtype="PCM_16")
        emit(type="done", sample_rate=int(sr), seconds=round(wav.size / float(sr), 2))
        return 0
    except Exception as e:
        emit(type="error", message="%s: %s" % (type(e).__name__, str(e)[:300]))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
