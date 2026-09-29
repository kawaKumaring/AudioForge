"""설치된 **기본 목소리** 목록 — 참조 소리 없이 바로 읽을 수 있는 것들.

★'폴더가 있으니 된다' 고 말하지 않는다 (2026-09-27 지시)
  Kokoro 에서 한 번 값을 치렀다 — 지원 언어라고 적어 두기만 하고 실제로 되는지 보지 않아,
  구하러 온 사다리가 썩어 있는 것을 몰랐다. 여기서는 셋을 모두 본다:
    ① 런타임을 실제로 불러올 수 있는가
    ② 모델 파일과 설정 파일이 둘 다 있는가
    ③ 설정에서 언어·샘플레이트를 읽을 수 있는가
  하나라도 아니면 **목록에 넣지 않고 사유를 남긴다.**

돌려주는 것(JSON 한 줄):
  {"voices": [{engineId, modelId, label, language, sampleRate, path}], "skipped": [{why}]}
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _repo_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def piper_voices_list(repo_root=None):
    """piper 로 쓸 수 있는 목소리. 안 되면 사유와 함께 비운다."""
    out, skipped = [], []
    try:
        import piper  # noqa: F401
    except Exception as e:
        skipped.append({"engineId": "piper",
                        "why": "piper 런타임을 불러오지 못했습니다: %s" % type(e).__name__})
        return out, skipped
    try:
        import piper_voices as pv
    except Exception as e:
        skipped.append({"engineId": "piper", "why": "목소리 목록을 읽지 못했습니다: %s" % e})
        return out, skipped

    root = pv.voices_root(repo_root or _repo_root())
    if not os.path.isdir(root):
        skipped.append({"engineId": "piper", "why": "내려받아 둔 목소리가 없습니다"})
        return out, skipped

    for v in pv.scan(repo_root=repo_root or _repo_root()):
        onnx, cfg = v.get("onnx"), (v.get("config") or "")
        if not (onnx and os.path.isfile(onnx) and cfg and os.path.isfile(cfg)):
            skipped.append({"engineId": "piper", "modelId": v.get("name"),
                            "why": "모델 또는 설정 파일이 없습니다"})
            continue
        if not v.get("lang"):
            skipped.append({"engineId": "piper", "modelId": v.get("name"),
                            "why": "설정에서 언어를 읽지 못했습니다"})
            continue
        out.append({
            "engineId": "piper",
            "modelId": v["name"],
            "label": v["name"],
            "language": v["lang"],
            "sampleRate": int(v.get("sample_rate") or 0),
            "path": onnx,
        })
    return out, skipped


def supertonic_voices_list(repo_root=None):
    """Supertonic 3 의 목소리 열 개(2026-09-30). 런타임·모델 파일·설정을 모두 본 뒤에만 넣는다."""
    out, skipped = [], []
    try:
        import onnxruntime  # noqa: F401
        import numpy  # noqa: F401
    except Exception as e:
        skipped.append({"engineId": "supertonic",
                        "why": "Supertonic 런타임(onnxruntime)을 불러오지 못했습니다: %s" % type(e).__name__})
        return out, skipped
    try:
        import supertonic_tts as st
    except Exception as e:
        skipped.append({"engineId": "supertonic", "why": "Supertonic 을 읽지 못했습니다: %s" % e})
        return out, skipped
    styles, why = st.scan(repo_root or _repo_root())
    if why:
        skipped.append({"engineId": "supertonic", "why": why})
        return out, skipped
    try:
        sr = st.sample_rate(repo_root or _repo_root())
    except Exception as e:
        skipped.append({"engineId": "supertonic", "why": "설정에서 샘플레이트를 읽지 못했습니다: %s" % type(e).__name__})
        return out, skipped
    for sid, path in styles:
        out.append({
            "engineId": "supertonic",
            "modelId": sid,
            "label": "Supertonic %s" % st.voice_label(sid),
            "language": st.LANG,
            "sampleRate": sr,
            "path": path,
        })
    return out, skipped


def main():
    voices, skipped = piper_voices_list()
    more, more_skipped = supertonic_voices_list()
    voices += more
    skipped += more_skipped
    # 이름 순 — 같은 설치에서 늘 같은 순서가 나와야 한다.
    voices.sort(key=lambda v: (v["language"], v["modelId"]))
    sys.stdout.write(json.dumps({"voices": voices, "skipped": skipped}, ensure_ascii=False))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
