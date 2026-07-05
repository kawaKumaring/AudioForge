#!/usr/bin/env python3
"""AudioForge 환경 점검 (doctor) — 부수효과 없음.

실행 중인 파이썬 인터프리터에 AudioForge가 필요로 하는 AI 패키지가
설치돼 있는지, ffmpeg·CUDA가 사용 가능한지 점검한다.

의존 대상은 'ComfyUI 앱'이 아니라 **이 패키지들**이다. ComfyUI는 이들이
이미 설치된 편리한 파이썬일 뿐 — 어느 파이썬이든 아래를 갖추면 동작한다.

사용법:
  <python> env_check.py           # 사람이 읽는 리포트
  <python> env_check.py --json    # 기계용 JSON (setup_env / 앱이 소비)
종료코드: 0 = core 전부 충족, 1 = core 부족.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys

# (pip 이름, import 이름, 용도, 등급)  등급: core=필수, tts=합성, hub=torch.hub로 받음
REQUIRED = [
    ("torch",            "torch",           "AI 엔진 (CUDA)",        "core"),
    ("numpy",            "numpy",           "수치 연산",             "core"),
    ("soundfile",        "soundfile",       "오디오 I/O",            "core"),
    ("openai-whisper",   "whisper",         "텍스트 추출",           "core"),
    ("demucs",           "demucs",          "음악 4트랙 분리",       "core"),
    ("audio-separator",  "audio_separator", "RoFormer 보컬 분리",    "core"),
    ("onnxruntime-gpu",  "onnxruntime",     "audio-separator 백엔드","core"),
    ("speechbrain",      "speechbrain",     "화자 분리(ECAPA)",      "core"),
    ("transformers",     "transformers",    "NLLB 번역",             "core"),
    ("f5-tts",           "f5_tts",          "TTS(영어/클로닝)",      "tts"),
    ("kokoro",           "kokoro",          "TTS(다국어 폴백)",      "tts"),
    ("silero-vad",       "silero_vad",      "음성 검출(torch.hub도 가능)", "hub"),
]


def _pkg_status():
    rows = []
    for pip_name, import_name, purpose, tier in REQUIRED:
        spec = importlib.util.find_spec(import_name)
        version = ""
        if spec is not None:
            try:
                import importlib.metadata as md
                version = md.version(pip_name)
            except Exception:
                version = "?"
        rows.append({
            "pip": pip_name, "import": import_name, "purpose": purpose,
            "tier": tier, "installed": spec is not None, "version": version,
        })
    return rows


def _find_ffmpeg():
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        return True
    local = os.environ.get("LOCALAPPDATA", "")
    if local:
        base = os.path.join(local, "Microsoft", "WinGet", "Packages")
        if os.path.isdir(base):
            for root, _dirs, files in os.walk(base):
                if "ffprobe.exe" in files:
                    return True
    return False


def _cuda_status():
    try:
        import torch
        if torch.cuda.is_available():
            return {"available": True, "device": torch.cuda.get_device_name(0),
                    "torch": torch.__version__}
        return {"available": False, "device": None, "torch": torch.__version__}
    except Exception as e:
        return {"available": False, "device": None, "torch": None, "error": str(e)}


def collect():
    pkgs = _pkg_status()
    core_missing = [p["pip"] for p in pkgs if p["tier"] == "core" and not p["installed"]]
    tts_missing = [p["pip"] for p in pkgs if p["tier"] == "tts" and not p["installed"]]
    return {
        "python": sys.executable,
        "python_version": sys.version.split()[0],
        "packages": pkgs,
        "ffmpeg": _find_ffmpeg(),
        "cuda": _cuda_status(),
        "core_missing": core_missing,
        "tts_missing": tts_missing,
        "core_ok": len(core_missing) == 0,
    }


def _print_human(r):
    print(f"AudioForge 환경 점검\n  python : {r['python']}")
    print(f"  버전   : {r['python_version']}")
    print("\n  [패키지]")
    for p in r["packages"]:
        mark = "O" if p["installed"] else "X"
        ver = f" {p['version']}" if p["version"] else ""
        print(f"    [{mark}] {p['pip']:<18}{ver:<12} {p['purpose']} ({p['tier']})")
    cu = r["cuda"]
    print("\n  [시스템]")
    print(f"    [{'O' if r['ffmpeg'] else 'X'}] ffmpeg/ffprobe")
    if cu["available"]:
        print(f"    [O] CUDA GPU: {cu['device']} (torch {cu['torch']})")
    else:
        print(f"    [X] CUDA GPU 없음 → CPU 폴백(느림). torch={cu.get('torch')}")
    print("\n  [판정]")
    if r["core_ok"]:
        print("    core 전부 충족 — 이 파이썬으로 동작 가능")
    else:
        print(f"    core 부족: {', '.join(r['core_missing'])}")
    if r["tts_missing"]:
        print(f"    tts 부족(선택): {', '.join(r['tts_missing'])}")
    if not r["ffmpeg"]:
        print("    ffmpeg 미설치 → 시스템 설치 필요(pip 아님): winget install Gyan.FFmpeg")


def main():
    r = collect()
    if "--json" in sys.argv:
        print(json.dumps(r, ensure_ascii=False))
    else:
        _print_human(r)
    return 0 if r["core_ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
