# -*- coding: utf-8 -*-
"""기능 검사 — 모델 파일이 **제자리에 다 있는가**만 본다(불러오지 않는다).

★2026-09-30 지시: 설정의 기능 검사 탭에서 기능별로 눌러 확인한다.
  무거운 모델을 올리지 않는다 — 파일이 있는지·필수 파일이 빠지지 않았는지만. 몇 초 안에 끝난다.
★경로는 내보내지 않는다. 이름과 개수만.
출력: {"piper": {"voices": [이름...]}, "qwen": {"ok": bool, "missing": [파일 이름...]}}
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main():
    out = {}
    try:
        import piper_voices as pv
        out["piper"] = {"voices": [v.get("name") for v in pv.scan() if v.get("name")]}
    except Exception as e:  # 목록을 못 읽은 것도 결과다
        out["piper"] = {"voices": [], "error": type(e).__name__}
    try:
        import tts_worker as tw
        snap = tw._QWEN_SNAPSHOT
        missing = [os.path.basename(f) if os.sep not in f else f.replace(os.sep, "/")
                   for f in tw._QWEN_REQUIRED if not os.path.isfile(os.path.join(snap, f))]
        out["qwen"] = {"ok": not missing, "missing": missing}
    except Exception as e:
        out["qwen"] = {"ok": False, "missing": [], "error": type(e).__name__}
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
