# -*- coding: utf-8 -*-
"""문장마다 목소리가 변하는 원인 — 샘플링 온도.

실측: 한 생성 안에서 문장별 F0 가 평균 9.6~9.9반음 벌어지고 문장간 음색거리가 3.7~3.9dB.
**다른 인물 다섯 명 사이 평균이 4.24dB** 이므로 같은 인물의 문장끼리가 남남만큼 벌어졌다.
master 판과 develop 판을 각각 3회 돌려 보니 차이가 없었다 → 코드 회귀가 아니다.

체크포인트 `generation_config.json` 이 원인을 가리킨다.
    do_sample: true · temperature: 0.9 · top_k: 50
    subtalker_dosample: true · subtalker_temperature: 0.9
**샘플링이 온도 0.9 로 켜져 있고 앱은 이 값을 건드리지 않는다.** 문장마다 독립적으로
샘플링하니 목소리가 매번 다른 방향으로 흘러간다.

재사용 프롬프트(create_voice_clone_prompt)는 답이 아니다 — 라이브러리가 프롬프트 없이
호출해도 내부에서 같은 함수를 부르므로(qwen3_tts_model.py:568) 조건이 동일하다. **속도 최적화다.**

조건 — 대사·참조 동일, **샘플링 설정만 다르다.**
  A 기본(온도 0.9)  : 지금 앱
  B 온도 0.5
  C 온도 0.3
  D 샘플링 끔(greedy)
"""
import itertools
import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

MODEL_DIR = Path(sys.argv[1])
REF = Path(sys.argv[2])
OUT = Path(sys.argv[3])
OUT.mkdir(parents=True, exist_ok=True)

LANG = "Korean"
SENTENCES = [
    "내일 오전 아홉 시부터 정기 점검이 시작됩니다.",
    "점검이 진행되는 동안에는 일부 기능을 사용할 수 없습니다.",
    "작업 중인 내용은 미리 저장해 두시기 바랍니다.",
    "예상 소요 시간은 두 시간이며, 상황에 따라 조금 더 걸릴 수 있습니다.",
    "점검이 끝나면 별도로 안내해 드리겠습니다.",
]

# talker 와 subtalker 를 **함께** 내려야 한다 — 한쪽만 낮추면 다른 쪽이 계속 흔든다.
CONDITIONS = [
    ("A_기본_온도0p9", {}),
    ("B_온도0p5", dict(temperature=0.5, subtalker_temperature=0.5)),
    ("C_온도0p3", dict(temperature=0.3, subtalker_temperature=0.3)),
    ("D_샘플링끔", dict(do_sample=False, subtalker_dosample=False)),
]


def as_np(w):
    try:
        return w.detach().float().cpu().numpy().squeeze()
    except AttributeError:
        return np.asarray(w).squeeze()


def main():
    import torch
    from qwen_tts import Qwen3TTSModel

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    model = Qwen3TTSModel.from_pretrained(
        str(MODEL_DIR), device_map=dev,
        dtype=torch.bfloat16 if dev == "cuda" else torch.float32,
        attn_implementation="sdpa", local_files_only=True)
    print("모델 적재 완료 (%s) · 참조 %s" % (dev, REF.name))
    ref = str(REF.resolve())
    report = {"reference": REF.name, "conditions": []}

    for name, kw in CONDITIONS:
        t0 = time.perf_counter()
        ok, err = 0, None
        for i, s in enumerate(SENTENCES):
            try:
                w, sr = model.generate_voice_clone(
                    text=s, language=LANG, ref_audio=ref, ref_text=None,
                    x_vector_only_mode=True, **kw)
            except Exception as e:
                err = "%s: %s" % (type(e).__name__, str(e)[:140])
                break
            sf.write(str(OUT / ("%s_%d.wav" % (name, i + 1))), as_np(w[0] if isinstance(w, (list, tuple)) else w),
                     int(sr), subtype="PCM_16")
            ok += 1
        el = round(time.perf_counter() - t0, 1)
        report["conditions"].append({"name": name, "kwargs": {k: str(v) for k, v in kw.items()},
                                     "generated": ok, "error": err, "elapsed": el})
        print("  %-16s 문장 %d개 생성 %5.1f초 %s" % (name, ok, el, ("실패: " + err) if err else ""))

    (OUT / "gen.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n생성 기록:", (OUT / "gen.json").resolve())


if __name__ == "__main__":
    main()
