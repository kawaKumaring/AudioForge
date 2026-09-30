"""Qwen 지정 목소리 **상주 실행기** — 모델을 한 번 불러 두고 요청마다 소리만 만든다.

★왜 (2026-09-30 실측): 조각마다 프로세스를 새로 띄우면 모델 열기·묶어 실행 준비에 약 10초가 매번 든다
  (10.6초 분량이 20초 — 그중 생성은 10초). 띄워 두면 그 10초는 첫 조각에만 든다 → 읽는 속도보다 빨라진다.
★격리 환경(externals/qwen3_tts_venv)의 파이썬으로 돈다. 앱 본체(reader)가 하나만 띄워 관리한다.
★부모가 사라지면(입력이 끊기면) 스스로 끝난다 — 그래픽카드 메모리를 붙든 고아로 남지 않는다.

주고받기(한 줄에 JSON 하나)
  요청: {"id": "...", "model": "<폴더>", "speaker": "sohee", "language": "korean", "text_file": "<글.txt>", "out": "<소리.wav>", "seed": 0}
        {"id": "...", "model": "<폴더>", "warm": true}   미리 열기(소리는 만들지 않는다 · 2026-10-01)
  답  : {"id": "...", "ok": true, "seconds": 10.6, "sample_rate": 24000, "gen_sec": 9.8, "loaded_now": false}
        {"id": "...", "ok": false, "error": "..."}
  그 밖의 줄(라이브러리가 찍는 경고 등)은 부모가 무시한다 — 답은 id 로 짝짓는다.
"""
import json
import sys
import time


def reply(**kw):
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    import numpy as np
    import soundfile as sf
    import torch
    import qwen_custom_voice as qcv
    model, model_dir = None, None
    reply(id="", ok=True, ready=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = ""
        try:
            req = json.loads(line)
            rid = str(req.get("id", ""))
            loaded_now = False
            if model is None or req["model"] != model_dir:
                model, model_dir = None, None
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                model = qcv.load(req["model"])
                model_dir = req["model"]
                loaded_now = True
            if req.get("warm"):
                # 미리 열기 — 소희를 고른 순간 모델을 올려 둔다(첫 조각의 약 10초를 누르기 전에 치른다).
                reply(id=rid, ok=True, seconds=0, sample_rate=0, gen_sec=0, loaded_now=loaded_now)
                continue
            with open(req["text_file"], encoding="utf-8") as f:
                text = f.read().strip()
            if not text:
                raise RuntimeError("읽을 글이 없습니다")
            seed = int(req.get("seed", 0))
            torch.manual_seed(seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(seed)
            t = time.time()
            wavs, sr = model.generate_custom_voice(text=text, speaker=req["speaker"], language=req.get("language", "korean"))
            gen = time.time() - t
            wav = np.asarray(wavs[0], dtype="float32").reshape(-1)
            if wav.size == 0 or not np.isfinite(wav).all():
                raise RuntimeError("소리가 비었거나 깨졌습니다")
            sf.write(req["out"], wav, int(sr), subtype="PCM_16")
            reply(id=rid, ok=True, seconds=round(wav.size / float(sr), 2), sample_rate=int(sr),
                  gen_sec=round(gen, 2), loaded_now=loaded_now)
        except Exception as e:
            reply(id=rid, ok=False, error="%s: %s" % (type(e).__name__, str(e)[:300]))
    return 0      # 입력이 끊겼다 = 부모가 닫았거나 사라졌다


if __name__ == "__main__":
    raise SystemExit(main())
