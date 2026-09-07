# -*- coding: utf-8 -*-
"""감정을 **글로 지시**할 수 있는가 — CustomVoice 첫 시험.

지금까지 쓰던 0.6B-Base 는 목소리 복제는 되지만 **감정 지시 인자가 없다**(벤더 표에 명시).
CustomVoice 는 반대다 — 목소리 복제는 안 되지만 `instruct` 로 어조를 지시한다.
그래서 이 시험이 답할 것은 하나다: **한국어 대사에 감정 지시가 실제로 먹히는가.**

세 조건. 대사·화자·언어 전부 같고 **지시만 다르다.**
  1 지시없음   — 대조군
  2 한국어지시 — 우리가 실제로 쓰고 싶은 형태
  3 중국어지시 — 문서 예제가 중국어뿐이라, 언어를 가리는지 함께 본다

앱은 건드리지 않는다. 앱의 격리 venv 를 **읽기 전용으로 빌려 쓰고** 모델은 _local 에 따로 받았다.
"""
import sys
import time
from pathlib import Path

import soundfile as sf

MODEL_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("_local/models/qwen3_tts_1_7b_customvoice")
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("_local/experiments/customvoice-20260907")
OUT.mkdir(parents=True, exist_ok=True)

SPEAKER = "Sohee"          # 유일한 한국어 프리셋 — "따뜻하고 감정이 풍부한 한국어 여성 목소리"
LANGUAGE = "Korean"
# 말 자체에는 감정이 없는 문장. 감정이 들린다면 **지시에서 온 것**이다.
TEXT = "내일 오전 아홉 시부터 정기 점검이 시작됩니다. 점검이 진행되는 동안에는 일부 기능을 사용할 수 없습니다."

# 사용자 판정: 중국어 지시가 한숨까지 넣고 더 자연스러웠다. 다만 **낮은 음의 냉랭한 분노**였고,
# 녹음 기반으로 만들던 쪽은 **비명을 지르는 폭발적 분노**였다. 둘은 다른 감정 강도다.
# 그래서 이번엔 **강도**를 올려 본다 — 자연어 지시니 세기를 말로 지정할 수 있다.
CONDITIONS = [
    ("4_격분", "用暴怒的语气大声吼叫着说，情绪完全爆发"),
    ("5_비명", "歇斯底里地尖叫着怒吼，声音嘶哑，几乎失控"),
    ("6_차가운분노", "用压抑的、冰冷的愤怒语气说，声音低沉"),
]


def main():
    import torch
    from qwen_tts import Qwen3TTSModel

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device.startswith("cuda") else torch.float32
    t0 = time.perf_counter()
    # 앱의 bridge 와 같은 방식 — 이 클래스는 .to() 가 없고 device_map 으로 올린다.
    model = Qwen3TTSModel.from_pretrained(
        str(MODEL_DIR), device_map=device, dtype=dtype,
        attn_implementation="sdpa", local_files_only=True)
    print("모델 적재 %.1f초 (%s)" % (time.perf_counter() - t0, device))
    print("화자 %s / 언어 %s / 대사 %d자" % (SPEAKER, LANGUAGE, len(TEXT)))

    for name, instruct in CONDITIONS:
        kw = dict(text=TEXT, language=LANGUAGE, speaker=SPEAKER)
        if instruct:
            kw["instruct"] = instruct
        t = time.perf_counter()
        try:
            wavs, sr = model.generate_custom_voice(**kw)
        except Exception as e:                     # 인자를 안 받으면 여기서 드러난다
            print("  %-12s 실패: %s: %s" % (name, type(e).__name__, str(e)[:160]))
            continue
        w = wavs[0] if isinstance(wavs, (list, tuple)) else wavs
        try:
            w = w.detach().float().cpu().numpy()
        except AttributeError:
            pass
        w = w.squeeze()
        p = OUT / (name + ".wav")
        sf.write(str(p), w, int(sr), subtype="PCM_16")
        print("  %-12s %5.2f초  %5dHz  최고진폭 %.3f  (%.1f초 걸림)  지시=%s"
              % (name, w.size / sr, int(sr), float(abs(w).max()), time.perf_counter() - t,
                 instruct or "(없음)"))

    print("\n산출:", OUT.resolve())


if __name__ == "__main__":
    main()
