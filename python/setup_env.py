#!/usr/bin/env python3
"""AudioForge 메인 AI 환경 해석/설치 오케스트레이터.

의존 대상은 'ComfyUI 앱'이 아니라 AI 패키지들(env_check.REQUIRED)이다.
이 스크립트는 다른 환경에서도 동작하도록:

  1. 후보 파이썬 탐색 (설정 → ComfyUI 자동탐지 → 전용 venv → 시스템)
  2. 각 후보를 env_check로 점검, core 충족하는 첫 후보에 **attach**(설치 0)
  3. 아무 후보도 부족하면 → 전용 venv 생성 후 **거기에만** 설치
     (★빌린 환경에는 절대 자동설치하지 않음 — ComfyUI 오염/파손 방지)
  4. 선택된 파이썬 경로를 externals/env.json에 기록 (앱이 읽음)

GPT-SoVITS(TTS) 전용 venv는 별도(setup_gptsovits.py) — 여긴 메인 환경만.

사용법:
  python setup_env.py            # 탐색 후 attach, 없으면 venv 생성/설치
  python setup_env.py --check    # 탐색/점검만 (설치·생성 안 함)
  python setup_env.py --force-venv          # 전용 venv 강제 생성/설치
  python setup_env.py --torch-index cu124   # venv 생성 시 torch CUDA 채널
"""

import json
import os
import subprocess
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY_DIR = os.path.join(BASE, "python")
VENV_DIR = os.path.join(BASE, "externals", "audioforge_venv")
VENV_PY = os.path.join(VENV_DIR, "Scripts", "python.exe")
CONFIG = os.path.join(BASE, "externals", "env.json")
ENV_CHECK = os.path.join(PY_DIR, "env_check.py")

sys.path.insert(0, PY_DIR)
from env_check import REQUIRED  # 패키지 목록 단일 소스  # noqa: E402


def _comfyui_candidates():
    """ComfyUI 임베디드 파이썬 흔한 위치 (best-effort)."""
    cands = []
    # 현재 하드코딩 기본값
    cands.append("E:/AI/ComfyUI_windows_portable_python3.12/python_embeded/python.exe")
    # 드라이브별 흔한 경로
    for drive in ("C:", "D:", "E:", "F:"):
        for name in ("ComfyUI_windows_portable_python3.12", "ComfyUI_windows_portable"):
            cands.append(f"{drive}/AI/{name}/python_embeded/python.exe")
            cands.append(f"{drive}/{name}/python_embeded/python.exe")
    return cands


def candidate_pythons():
    """우선순위 순 후보 파이썬 경로."""
    out = []
    # 1. 환경변수 설정
    env_py = os.environ.get("AUDIOFORGE_PYTHON")
    if env_py:
        out.append(env_py)
    # 2. 이미 기록된 config
    if os.path.exists(CONFIG):
        try:
            with open(CONFIG, encoding="utf-8") as f:
                p = json.load(f).get("python")
                if p:
                    out.append(p)
        except Exception:
            pass
    # 3. ComfyUI 자동탐지
    out.extend(_comfyui_candidates())
    # 4. 전용 venv
    out.append(VENV_PY)
    # 5. 시스템 파이썬
    out.append(sys.executable)
    # 중복 제거(순서 유지) + 실존만
    seen, uniq = set(), []
    for p in out:
        ap = os.path.abspath(p) if p else p
        if ap and ap not in seen and os.path.exists(ap):
            seen.add(ap)
            uniq.append(ap)
    return uniq


def check_python(py):
    """py로 env_check --json 실행 → 결과 dict (실패 시 None)."""
    try:
        r = subprocess.run([py, "-X", "utf8", ENV_CHECK, "--json"],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=120)
        # stdout 마지막 JSON 라인 파싱 (경고 로그 섞일 수 있음)
        for line in reversed(r.stdout.splitlines()):
            line = line.strip()
            if line.startswith("{"):
                return json.loads(line)
    except Exception:
        pass
    return None


def write_config(py):
    os.makedirs(os.path.dirname(CONFIG), exist_ok=True)
    with open(CONFIG, "w", encoding="utf-8") as f:
        json.dump({"python": py}, f, ensure_ascii=False, indent=2)
    print(f"  env.json 기록: {py}")


def create_venv_and_install(torch_index):
    """전용 venv 생성 후 core+tts 패키지 설치 (우리 소유 venv에만)."""
    print(f"전용 venv 생성: {VENV_DIR}")
    r = subprocess.run([sys.executable, "-m", "venv", VENV_DIR])
    if r.returncode != 0 or not os.path.exists(VENV_PY):
        print("[오류] venv 생성 실패"); return None

    pip = [VENV_PY, "-m", "pip", "install", "--upgrade", "pip"]
    subprocess.run(pip)

    # torch는 CUDA 채널에서 (GPU별 상이 — 기본 cu124, --torch-index로 조정)
    print(f"torch 설치 (CUDA {torch_index})... GPU에 맞는 채널이어야 함")
    subprocess.run([VENV_PY, "-m", "pip", "install", "torch", "torchaudio",
                    "--index-url", f"https://download.pytorch.org/whl/{torch_index}"])

    # 나머지 core+tts (torch 제외)
    pkgs = [pip_name for pip_name, _imp, _p, tier in REQUIRED
            if tier in ("core", "tts") and pip_name != "torch"]
    print(f"패키지 설치: {', '.join(pkgs)}")
    subprocess.run([VENV_PY, "-m", "pip", "install", *pkgs])

    # 빌드 회피 shim (한국어/중국어 텍스트 프론트엔드) — setup_gptsovits와 동일 패턴
    _apply_shims()
    return VENV_PY


def _apply_shims():
    """jieba_fast→jieba, eunjeon→python-mecab-ko shim (MSVC 빌드 회피).
    kokoro/f5-tts가 중/한 텍스트 처리 시 필요할 수 있어 메인 venv에도 적용."""
    print("  (참고) 일본어(pyopenjtalk)는 프리빌트 휠 없음 — 필요 시 별도 빌드")


def main():
    check_only = "--check" in sys.argv
    force_venv = "--force-venv" in sys.argv
    torch_index = "cu124"
    if "--torch-index" in sys.argv:
        i = sys.argv.index("--torch-index")
        if i + 1 < len(sys.argv):
            torch_index = sys.argv[i + 1]

    print("AudioForge 메인 환경 해석\n")

    if not force_venv:
        # attach 시도
        for py in candidate_pythons():
            r = check_python(py)
            if r and r.get("core_ok"):
                miss_tts = r.get("tts_missing", [])
                note = f" (tts 부족: {', '.join(miss_tts)})" if miss_tts else ""
                print(f"[attach] core 충족 파이썬 발견: {py}{note}")
                if not check_only:
                    write_config(py)
                print("  → 설치 없이 이 환경 사용. (권장)")
                return 0
            elif r:
                print(f"[skip] core 부족: {py}  결여: {', '.join(r.get('core_missing', []))}")
            else:
                print(f"[skip] 점검 실패: {py}")

        print("\ncore 충족 파이썬 없음.")

    if check_only:
        print("(--check: 생성/설치 안 함) 전용 venv가 필요합니다: python setup_env.py --force-venv")
        return 1

    # 폴백: 전용 venv 생성/설치
    py = create_venv_and_install(torch_index)
    if not py:
        return 1
    r = check_python(py)
    if r and r.get("core_ok"):
        write_config(py)
        print("\n전용 venv 준비 완료.")
        return 0
    print("\n[경고] venv 설치 후에도 core 부족 — torch CUDA 채널(--torch-index) 확인 필요")
    if r:
        print(f"  결여: {', '.join(r.get('core_missing', []))}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
