# -*- coding: utf-8 -*-
"""단어 타임스탬프 추출 — 앱이 이미 쓰는 Whisper 를 그대로 쓴다.

**새 모델을 설치하지 않는다.** 가중치는 로컬 캐시(`~/.cache/whisper`)에 이미 있는 것만 쓰고,
`download_root` 를 명시해 조용한 다운로드를 막는다(앱의 `_get_whisper_model` 과 같은 이유).
**CPU 전용**으로 돌린다.

실행 인터프리터는 앱이 쓰는 것(`externals/env.json` 의 python)이어야 한다 — 그쪽에 whisper 가 있다.
분석(pyworld)은 별도 venv 에서 하므로, 이 스크립트는 **단어 구간 JSON 만** 만든다.
"""
import json
import os
import sys
from pathlib import Path

SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])
MODEL = sys.argv[3] if len(sys.argv) > 3 else "base"
LANG = sys.argv[4] if len(sys.argv) > 4 else "en"   # 언어를 반드시 지정한다 — 기본값에 맡기면 한국어를 영어로 옮겨 적는다
ROOT = os.path.expanduser("~/.cache/whisper")


def main():
    import whisper

    weight = Path(ROOT) / f"{MODEL}.pt"
    if not weight.exists():
        raise SystemExit(f"가중치가 없다: {weight} — 내려받지 않는다. 있는 모델만 쓴다.")
    model = whisper.load_model(MODEL, device="cpu", download_root=ROOT)

    out = {}
    for wav in sorted(SRC.glob("*.wav")):
        r = model.transcribe(str(wav), language=LANG, word_timestamps=True,
                             fp16=False, temperature=0.0, condition_on_previous_text=False)
        words = []
        for seg in r.get("segments", []):
            for w in seg.get("words", []) or []:
                words.append({"text": w["word"].strip(),
                              "start": round(float(w["start"]), 4),
                              "end": round(float(w["end"]), 4),
                              "probability": round(float(w.get("probability", 1.0)), 4)})
        out[wav.name] = {"text": r.get("text", "").strip(), "words": words}
        print(f"{wav.name}  단어 {len(words):>2}  {r.get('text','').strip()}")

    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n저장: {OUT}")


if __name__ == "__main__":
    main()
