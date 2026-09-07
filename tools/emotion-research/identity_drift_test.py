# -*- coding: utf-8 -*-
"""문장마다 목소리가 변하는 문제 — 배선을 바꾸면 잡히는가.

실측: 한 번의 생성 안에서 문장별 F0 가 평균 9.6~9.9반음 벌어지고, 문장간 음색거리가
3.7~3.9dB 다. 서로 **다른 인물 다섯 명 사이 평균이 4.24dB** 이므로 같은 인물의 문장끼리가
남남만큼 벌어져 있다. master 판과 develop 판이 같으므로 코드 회귀가 아니라 구조 문제다.

앱은 지금 문장마다 `ref_audio` 경로를 넘겨 **매번 특징을 다시 뽑는다**(qwen_bridge.py:331).
라이브러리에는 `create_voice_clone_prompt` 로 특징을 한 번만 뽑아 재사용하는 길이 있고,
벤더 문서는 "여러 대사에 걸쳐 일관된 캐릭터 목소리를 원할 때 특히 유용"이라고 적었다.

**다만 그 문구의 주된 설명은 속도다.** 같은 참조에서 뽑은 특징이 매번 같다면 흔들림은
생성 무작위성 탓이고 재사용으로는 잡히지 않는다. **제품 코드를 고치기 전에 여기서 가른다.**

조건 셋 — 대사·참조·설정 동일, **넘기는 방식만 다르다.**
  A 문장마다 따로 : 지금 앱과 같다(ref_audio 를 매 호출에 넘긴다)
  B 재사용 프롬프트: 특징을 한 번 뽑아 다섯 문장에 같은 것을 물린다
  C 한 번에 배치  : 다섯 문장을 한 호출에 넘긴다
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
REPS = int(sys.argv[4]) if len(sys.argv) > 4 else 1
OUT.mkdir(parents=True, exist_ok=True)

LANG = "Korean"
SENTENCES = [
    "내일 오전 아홉 시부터 정기 점검이 시작됩니다.",
    "점검이 진행되는 동안에는 일부 기능을 사용할 수 없습니다.",
    "작업 중인 내용은 미리 저장해 두시기 바랍니다.",
    "예상 소요 시간은 두 시간이며, 상황에 따라 조금 더 걸릴 수 있습니다.",
    "점검이 끝나면 별도로 안내해 드리겠습니다.",
]


def voice_profile(w, sr):
    """이 발화의 '누구인가' — 음높이 중앙값과 평균 로그 스펙트럼(음색 지문).

    pyworld 는 앱 venv 에 없다(넣지 않는다). 없으면 None 을 돌려주고 분석은
    별도 환경에서 저장된 wav 로 한다."""
    try:
        import pyworld as pw
    except ModuleNotFoundError:
        return None
    m = np.ascontiguousarray(np.asarray(w, dtype="float64"))
    f0, t = pw.harvest(m, sr, frame_period=10.0)
    f0 = pw.stonemask(m, f0, t, sr)
    sp = pw.cheaptrick(m, f0, t, sr)
    v = f0 > 0
    if v.sum() < 10:
        return None
    fr = np.linspace(0, sr / 2, sp.shape[1])
    band = (fr >= 100) & (fr <= 6000)
    tim = 10 * np.log10(np.maximum(sp[v][:, band], 1e-20)).mean(axis=0)
    tim = np.interp(np.linspace(0, 1, 200), np.linspace(0, 1, tim.size), tim)
    return float(np.median(f0[v])), tim - tim.mean()


def drift(profiles):
    """문장끼리 얼마나 벌어졌는가 — 음높이 폭(반음)과 음색거리(dB)."""
    ps = [p for p in profiles if p]
    if len(ps) < 2:
        return None
    f0s = [p[0] for p in ps]
    ds = [float(np.sqrt(np.mean((ps[i][1] - ps[j][1]) ** 2)))
          for i, j in itertools.combinations(range(len(ps)), 2)]
    return dict(f0_min=min(f0s), f0_max=max(f0s),
                semitone_span=float(12 * np.log2(max(f0s) / min(f0s))),
                timbre_mean=float(np.mean(ds)), timbre_max=float(max(ds)), n=len(ps))


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
        str(MODEL_DIR), device_map=dev, dtype=torch.bfloat16 if dev == "cuda" else torch.float32,
        attn_implementation="sdpa", local_files_only=True)
    print("모델 적재 완료 (%s) · 참조 %s" % (dev, REF.name))
    ref = str(REF.resolve())
    report = {"reference": REF.name, "reps": REPS, "runs": []}

    for rep in range(1, REPS + 1):
        row = {"rep": rep}
        # A — 지금 앱과 같다. 문장마다 참조를 다시 넘긴다.
        t0 = time.perf_counter()
        profs, sr = [], None
        for i, s in enumerate(SENTENCES):
            w, sr = model.generate_voice_clone(text=s, language=LANG, ref_audio=ref,
                                               ref_text=None, x_vector_only_mode=True)
            y = as_np(w[0] if isinstance(w, (list, tuple)) else w)
            sf.write(str(OUT / f"A_rep{rep}_{i + 1}.wav"), y, int(sr), subtype="PCM_16")
            profs.append(voice_profile(y, int(sr)))
        row["A_문장마다"] = dict(drift(profs) or {}, elapsed=round(time.perf_counter() - t0, 1))

        # B — 특징을 한 번만 뽑아 다섯 문장에 같은 것을 물린다.
        t0 = time.perf_counter()
        prompt = model.create_voice_clone_prompt(ref_audio=ref, ref_text=None, x_vector_only_mode=True)
        one = prompt[0] if isinstance(prompt, list) else prompt
        profs = []
        for i, s in enumerate(SENTENCES):
            w, sr = model.generate_voice_clone(text=s, language=LANG, voice_clone_prompt=one)
            y = as_np(w[0] if isinstance(w, (list, tuple)) else w)
            sf.write(str(OUT / f"B_rep{rep}_{i + 1}.wav"), y, int(sr), subtype="PCM_16")
            profs.append(voice_profile(y, int(sr)))
        row["B_재사용프롬프트"] = dict(drift(profs) or {}, elapsed=round(time.perf_counter() - t0, 1))

        # C — 다섯 문장을 한 호출에.
        t0 = time.perf_counter()
        try:
            w, sr = model.generate_voice_clone(
                text=list(SENTENCES), language=[LANG] * len(SENTENCES),
                ref_audio=[ref] * len(SENTENCES), ref_text=[None] * len(SENTENCES),
                x_vector_only_mode=[True] * len(SENTENCES))
            profs = []
            for i in range(len(SENTENCES)):
                y = as_np(w[i])
                sf.write(str(OUT / f"C_rep{rep}_{i + 1}.wav"), y, int(sr), subtype="PCM_16")
                profs.append(voice_profile(y, int(sr)))
            row["C_한번에배치"] = dict(drift(profs) or {}, elapsed=round(time.perf_counter() - t0, 1))
        except Exception as e:
            row["C_한번에배치"] = {"error": "%s: %s" % (type(e).__name__, str(e)[:120])}

        report["runs"].append(row)
        print("\n[%d회차]" % rep)
        for k, v in row.items():
            if k == "rep":
                continue
            if "error" in v:
                print("  %-16s 실패: %s" % (k, v["error"])); continue
            print("  %-16s 음높이 %3.0f~%3.0fHz (%5.2f반음)  문장간 음색거리 평균 %.2f 최대 %.2f dB  %5.1f초"
                  % (k, v["f0_min"], v["f0_max"], v["semitone_span"], v["timbre_mean"], v["timbre_max"], v["elapsed"]))

    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n기록:", (OUT / "report.json").resolve())


if __name__ == "__main__":
    main()
