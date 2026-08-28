#!/usr/bin/env python3
"""AudioForge 앱 전용 환경 설치기.

무엇을 하는가
-------------
앱이 쓸 GPT-SoVITS 실행 환경을 **앱이 소유한 별도 venv** 로 새로 만들고, 검증을
통과했을 때에만 앱과 연결한다. 이미 내려받아 둔 코드·모델은 재사용한다.

무엇을 하지 않는가 (안전 경계)
------------------------------
* 시스템 파이썬, ComfyUI 임베디드 파이썬, 기존 venv 의 패키지를 건드리지 않는다.
* 손상된 기존 venv 를 수리하거나 삭제하지 않는다 — 그대로 둔 채 옆에 새로 만든다.
* PATH·레지스트리·환경 변수를 영구 변경하지 않는다.
* 재귀 삭제를 하지 않는다. 되돌리기는 "설치 디렉터리를 사용자가 지운다"로 충분하도록
  모든 산출물을 한 폴더 안에 모은다.
* 다른 구성요소(예: Qwen) 의 연결 기록은 읽지도 쓰지도 않는다.

흐름
----
    plan → (동의) → venv 생성 → 패키지 설치 → shim → 검증 → 연결(runtime.json)

연결은 마지막 단계다. 검증을 통과하기 전까지 새 환경은 만들어져 있어도 앱에서
보이지 않는다(runtime.json 이 가리키지 않으므로). 중간에 실패하면 기존 연결은
그대로 남는다.

사용법
------
    python app_env_installer.py status  [--json]
    python app_env_installer.py plan    [--json]
    python app_env_installer.py install [--yes] [--reinstall] [--skip-deep]
    python app_env_installer.py verify  [--json]
    python app_env_installer.py link    --venv <dir> --repo <dir>
    python app_env_installer.py unlink
"""

import argparse
import getpass
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app_runtime as rt  # noqa: E402

COMPONENT = "gptsovits"
LOCK_NAME = "runtime-lock.json"


# ── 표시 도우미 ──────────────────────────────────────────────────────────

def _hr():
    print("-" * 68)


def _gib(n):
    return f"{n / (1024 ** 3):.2f} GiB"


def _mib(n):
    return f"{n / (1024 ** 2):.1f} MiB"


def _dir_size(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


# ── 계획 ─────────────────────────────────────────────────────────────────

def _canonical(p):
    """junction/symlink 를 풀어 **실체 경로**를 돌려준다.

    작업 트리의 externals 는 공용 externals 를 가리키는 junction 인 경우가 있다.
    연결 기록에 junction 경유 경로를 남기면 (1) 그 작업 트리를 지울 때 링크를 따라
    실제 자산이 함께 지워지고(2026-08-29 사고), (2) 작업 트리가 사라진 뒤에는
    기록된 경로 자체가 무효가 된다. 기록은 언제나 실체를 가리켜야 한다.
    """
    return os.path.realpath(os.path.abspath(p))


def _find_repo(spec):
    """이미 내려받아 둔 GPT-SoVITS 코드/모델을 찾는다.

    탐색은 **명시된 곳만** 본다. 예전에는 형제 디렉터리를 훑었는데, 그러면 공용
    externals 를 가리키는 junction 을 먼저 만나 그 경유 경로를 기록해 버렸다.
    "먼저 발견한 것"을 답으로 삼는 탐색은 여기서 없앤다.

    탐색 순서:
      1. AUDIOFORGE_GPTSOVITS_REPO 환경 변수 (명시 지정)
      2. runtime.json 에 이미 기록된 repo (검증을 통과했던 실체 경로)
      3. assets_root()/GPT-SoVITS  — 본체 저장소의 externals. 작업 트리에서 실행해도
                                     본체를 보므로 junction 을 거칠 일이 없다.
      4. runtime_root()/GPT-SoVITS — 런타임 루트를 딴 데로 옮기고 코드도 함께 둔 경우
    찾은 경로는 모두 realpath 로 풀어 실체만 기록한다.
    반환: (경로 or None, 판단 근거 문자열)
    """
    def _usable(p):
        return os.path.isdir(p) and os.path.isdir(os.path.join(p, "GPT_SoVITS"))

    env = os.environ.get("AUDIOFORGE_GPTSOVITS_REPO")
    if env and _usable(env):
        return _canonical(env), "AUDIOFORGE_GPTSOVITS_REPO"

    comp = rt.get_component(COMPONENT)
    recorded = (comp or {}).get("repo")
    if recorded and _usable(recorded):
        return _canonical(recorded), "runtime.json(검증된 기록)"

    for base, label in ((rt.assets_root(), "assets_root(본체 externals)"),
                        (rt.runtime_root(), "runtime_root")):
        cand = os.path.join(base, "GPT-SoVITS")
        if _usable(cand):
            real = _canonical(cand)
            via = "" if real.lower() == os.path.abspath(cand).lower() else f" ({cand} 경유)"
            return real, label + via
    return None, "찾지 못함"


def _model_report(repo, spec):
    rows = []
    for r in spec["components"][COMPONENT]["model_files"]:
        p = os.path.join(repo, r["path"].replace("/", os.sep))
        try:
            size = os.path.getsize(p)
        except OSError:
            size = None
        rows.append({"path": r["path"], "size": size, "min_bytes": r["min_bytes"],
                     "ok": size is not None and size >= r["min_bytes"]})
    return rows


def _preserved_items(root, repo):
    """이 설치기가 손대지 않는 것 중, 이 기계에 **실제로 있는** 것만 보여 준다.

    없는 경로까지 나열하면 안내가 아니라 소음이다.
    외부 자산 루트와, 재사용할 코드가 사는 폴더를 함께 본다.
    """
    roots = [rt.assets_root()]
    for extra in (root, os.path.dirname(repo) if repo else None):
        if extra and all(os.path.normcase(extra) != os.path.normcase(r) for r in roots):
            roots.append(extra)

    labels = [
        ("gptsovits_venv", "손상된 기존 venv — 보존(수리·삭제하지 않음)"),
        ("qwen3_tts_venv", "정상 — 재설치하지 않음"),
        ("qwen3_tts_hf", "정상 — 그대로 둠"),
        ("qwen3_tts_1_7b_base", "정상 — 그대로 둠"),
        ("separator_models", "정상 — 그대로 둠"),
        ("env.json", "메인 환경 연결 기록 — 읽지도 쓰지도 않음"),
    ]
    items, seen = [], set()
    for base in roots:
        for name, why in labels:
            p = os.path.join(base, name)
            key = os.path.normcase(p)
            if key in seen or not os.path.exists(p):
                continue
            seen.add(key)
            items.append(f"{p}  ({why})")
    items.append("시스템 파이썬 / ComfyUI 임베디드 파이썬 (패키지 변경 없음)")
    items.append("PATH·레지스트리·환경 변수 (영구 변경 없음)")
    return items


def build_plan():
    spec = rt.load_spec()
    comp_spec = spec["components"][COMPONENT]
    root = rt.runtime_root()
    venv_dir = os.path.join(root, comp_spec["venv_dir"])
    repo, repo_src = _find_repo(spec)

    interp = spec["interpreter"]
    interp_dir = os.path.join(root, interp["install_dir"].replace("/", os.sep))

    plan = {
        "runtime_root": root,
        "assets_root": rt.assets_root(),
        "main_repo": rt.main_repo_root(),
        "checkout": rt.repo_root(),
        "config": rt.config_path(),
        "interpreter": {
            "version": interp["python_version"],
            "release": interp["release_tag"],
            "asset": interp["asset"],
            "sha256": interp["sha256"],
            "download_bytes": interp["download_bytes"],
            "install_dir": interp_dir,
            "present": os.path.exists(os.path.join(interp_dir, "python.exe")),
            "license": interp["license"],
            "running_under": sys.executable,
            "running_version": platform.python_version(),
        },
        "venv": {
            "dir": venv_dir,
            "present": os.path.exists(rt.venv_python(venv_dir)),
            "packages": comp_spec["packages"],
            "optional_packages": comp_spec["optional_packages"],
            "torch": comp_spec["torch"],
            "estimated_download_bytes": 4 * 1024 ** 3,
            "license": comp_spec["torch"]["license"],
        },
        "reuse": {
            "repo": repo,
            "repo_source": repo_src,
            "models": _model_report(repo, spec) if repo else [],
            "license": comp_spec["license"],
        },
        "preserved": {
            "note": "아래는 이 설치기가 절대 건드리지 않는다.",
            "items": _preserved_items(root, repo),
        },
        "probe": rt.probe_gptsovits(),
    }
    plan["ready"] = plan["probe"]["ok"]
    plan["blockers"] = []
    if not repo:
        plan["blockers"].append(
            "GPT-SoVITS 코드·모델을 찾지 못했습니다. "
            "이 설치기는 코드·모델을 자동으로 내려받지 않습니다(아직 구현 범위 밖). "
            f"이미 있다면 AUDIOFORGE_GPTSOVITS_REPO 로 지정하거나 "
            f"{os.path.join(rt.assets_root(), 'GPT-SoVITS')} 에 두세요.")
    else:
        bad = [m["path"] for m in plan["reuse"]["models"] if not m["ok"]]
        if bad:
            plan["blockers"].append(
                "사전학습 모델이 없거나 크기가 모자랍니다: " + ", ".join(bad))
    return plan


def print_plan(plan):
    _hr()
    print("AudioForge 앱 전용 환경 설치 계획")
    _hr()
    print(f"실행 위치      : {plan['checkout']}")
    print(f"본체 저장소    : {plan['main_repo']}")
    print(f"설치 위치      : {plan['runtime_root']}   <- 앱 소유(여기만 만들고 고친다)")
    print(f"외부 자산      : {plan['assets_root']}   <- 읽기만 함(수정·삭제 안 함)")
    print(f"연결 기록 파일 : {plan['config']}")
    if os.path.normcase(plan["checkout"]) != os.path.normcase(plan["main_repo"]):
        print("  (작업 트리에서 실행 중입니다. 런타임은 본체 저장소 밑에 설치되므로")
        print("   이 작업 트리를 정리해도 설치가 사라지지 않습니다.)")
    print()
    i = plan["interpreter"]
    print("[1] 앱 전용 파이썬 (새로 설치)")
    print(f"    CPython {i['version']} · python-build-standalone {i['release']}")
    print(f"    자산     : {i['asset']}")
    print(f"    sha256   : {i['sha256']}")
    print(f"    내려받기 : {_mib(i['download_bytes'])}")
    print(f"    설치 위치: {i['install_dir']}")
    print(f"    상태     : {'이미 있음(재사용)' if i['present'] else '새로 내려받음'}")
    print(f"    라이선스 : {i['license']}")
    print("    영향 범위: 이 폴더만. PATH·레지스트리·시스템 파이썬 변경 없음.")
    print()
    v = plan["venv"]
    print("[2] GPT-SoVITS 전용 venv (새로 생성)")
    print(f"    위치     : {v['dir']}")
    print(f"    상태     : {'이미 있음' if v['present'] else '새로 생성'}")
    print(f"    torch    : {', '.join(v['torch']['packages'])}")
    print(f"               index {v['torch']['index_url']}")
    print(f"    패키지   : {len(v['packages'])}개 (+ 선택 {len(v['optional_packages'])}개)")
    print(f"    내려받기 : 약 {_gib(v['estimated_download_bytes'])} (실측은 설치 후 lock 에 기록)")
    print(f"    라이선스 : {v['license']}")
    print()
    r = plan["reuse"]
    print("[3] 재사용 (내려받지 않음)")
    print(f"    코드/모델: {r['repo']}  [{r['repo_source']}]")
    for m in r["models"]:
        mark = "O" if m["ok"] else "X"
        size = _mib(m["size"]) if m["size"] is not None else "없음"
        # 파일 이름만 찍으면 config.json 이 여러 줄 나와 구분이 안 된다.
        short = "/".join(m["path"].split("/")[-2:])
        print(f"      [{mark}] {short:<58} {size:>12}")
    print(f"    라이선스 : {r['license']}")
    print()
    print("[4] 건드리지 않는 것")
    for item in plan["preserved"]["items"]:
        print(f"    - {item}")
    print()
    if plan["blockers"]:
        print("[!] 진행 불가 사유")
        for b in plan["blockers"]:
            print(f"    - {b}")
        print()
    _hr()


# ── 설치 단계 ────────────────────────────────────────────────────────────

def _run(cmd, cwd=None, env=None, label=""):
    """하위 프로세스 실행. 출력은 그대로 흘려보낸다(진행이 보여야 한다)."""
    if label:
        print(f"\n>>> {label}")
    print(f"    $ {' '.join(cmd[:3])} ... ({len(cmd)} args)")
    r = subprocess.run(cmd, cwd=cwd, env=env)
    return r.returncode


def create_venv(venv_dir, reinstall):
    py = rt.venv_python(venv_dir)
    if os.path.exists(py):
        if not reinstall:
            print(f"    venv 이미 있음 — 재사용: {venv_dir}")
            return py
        print(f"[!] --reinstall 은 기존 venv 를 지우지 않습니다. "
              f"패키지만 다시 설치합니다: {venv_dir}")
        return py
    os.makedirs(os.path.dirname(venv_dir), exist_ok=True)
    rc = _run([sys.executable, "-m", "venv", venv_dir], label=f"venv 생성: {venv_dir}")
    if rc != 0 or not os.path.exists(py):
        raise RuntimeError(f"venv 생성 실패 (rc={rc}): {venv_dir}")
    return py


def pip_install(venv_py, args, label):
    cmd = [venv_py, "-m", "pip", "install", "--no-input", *args]
    rc = _run(cmd, label=label)
    return rc


def install_packages(venv_py, comp_spec):
    stages = []

    rc = pip_install(venv_py, ["--upgrade", "pip", "setuptools", "wheel"], "pip/setuptools/wheel 갱신")
    stages.append({"stage": "bootstrap", "rc": rc})
    if rc != 0:
        raise RuntimeError("pip 부트스트랩 실패")

    torch_spec = comp_spec["torch"]
    rc = pip_install(venv_py, ["--index-url", torch_spec["index_url"], *torch_spec["packages"]],
                     f"torch 설치 ({torch_spec['index_url']})")
    stages.append({"stage": "torch", "rc": rc, "packages": torch_spec["packages"]})
    if rc != 0:
        raise RuntimeError("torch 설치 실패 — CUDA 채널(index_url)이 이 GPU 에 맞는지 확인하세요.")

    rc = pip_install(venv_py, comp_spec["packages"], f"필수 패키지 {len(comp_spec['packages'])}개")
    stages.append({"stage": "required", "rc": rc, "packages": comp_spec["packages"]})
    if rc != 0:
        raise RuntimeError("필수 패키지 설치 실패")

    # 선택 패키지는 하나씩 — 하나가 실패해도 설치 전체를 무너뜨리지 않는다.
    opt = []
    for pkg in comp_spec["optional_packages"]:
        rc = pip_install(venv_py, [pkg], f"선택 패키지 {pkg}")
        opt.append({"package": pkg, "rc": rc, "installed": rc == 0})
        if rc != 0:
            print(f"    [건너뜀] {pkg} 설치 실패 — 한국어 합성에는 필요 없습니다.")
    stages.append({"stage": "optional", "results": opt})
    return stages


JIEBA_FAST_INIT = '''\
"""jieba_fast shim -> jieba (C 확장 빌드 회피). app_env_installer.py 가 생성."""
import jieba as _jieba
from jieba import *  # noqa: F401,F403
setLogLevel = _jieba.setLogLevel
cut = _jieba.cut
lcut = _jieba.lcut
load_userdict = _jieba.load_userdict
Tokenizer = _jieba.Tokenizer
dt = _jieba.dt
'''

JIEBA_FAST_POSSEG = '''\
"""jieba_fast.posseg shim -> jieba.posseg."""
from jieba.posseg import *  # noqa: F401,F403
import jieba.posseg as _posseg
cut = _posseg.cut
lcut = _posseg.lcut
POSTokenizer = _posseg.POSTokenizer
dt = _posseg.dt
'''

EUNJEON_INIT = '''\
"""eunjeon shim -> python-mecab-ko (MSVC 빌드 회피). app_env_installer.py 가 생성.
g2pk2 가 쓰는 것은 mecab.pos(text) -> [(surface, tag), ...] 뿐이다."""
from mecab import MeCab as _MeCab


class Mecab:
    def __init__(self, dicpath=None, *args, **kwargs):
        self._m = _MeCab()

    def pos(self, text, *args, **kwargs):
        return self._m.pos(text)

    def morphs(self, text, *args, **kwargs):
        return self._m.morphs(text)

    def nouns(self, text, *args, **kwargs):
        return self._m.nouns(text)
'''


def write_shims(venv_dir):
    """빌드가 필요한 패키지를 순수 파이썬 대체물로 위임한다.

    이 venv 안에만 쓴다. 다른 환경의 site-packages 를 건드리지 않는다.
    """
    site = rt.venv_site_packages(venv_dir)
    written = []
    for rel, content in (
        (os.path.join("jieba_fast", "__init__.py"), JIEBA_FAST_INIT),
        (os.path.join("jieba_fast", "posseg.py"), JIEBA_FAST_POSSEG),
        (os.path.join("eunjeon", "__init__.py"), EUNJEON_INIT),
    ):
        p = os.path.join(site, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)
        written.append(os.path.relpath(p, site).replace(os.sep, "/"))
        print(f"    shim 생성: {written[-1]}")
    return written


def pip_freeze(venv_py):
    try:
        r = subprocess.run([venv_py, "-m", "pip", "list", "--format=json"],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=180)
        if r.returncode == 0:
            return json.loads(r.stdout)
    except Exception:
        pass
    return []


# ── 검증 ─────────────────────────────────────────────────────────────────

def run_verify(venv_py, repo, deep=True, timeout=1800):
    """venv 안에서 app_env_verify.py 를 실행해 실제 import·모델 로딩을 확인한다."""
    script = os.path.join(rt.repo_root(), "python", "app_env_verify.py")
    cmd = [venv_py, "-X", "utf8", "-u", script, "--repo", repo, "--json"]
    if not deep:
        cmd.append("--no-deep")
    print(f"\n>>> 검증 실행 ({'깊은 검증: 모델 로딩까지' if deep else '얕은 검증: import 만'})")
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"검증 시간 초과 ({timeout}s)"}
    payload = None
    for line in reversed((r.stdout or "").splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                payload = json.loads(line)
                break
            except ValueError:
                continue
    if payload is None:
        return {"ok": False, "error": "검증 스크립트가 결과를 내지 않았습니다.",
                "stdout_tail": (r.stdout or "")[-2000:], "stderr_tail": (r.stderr or "")[-2000:]}
    return payload


def print_verify(v):
    _hr()
    print("검증 결과")
    _hr()
    imports = v.get("imports") or {}
    failed = [k for k, r in imports.items() if not r.get("ok")]
    print(f"  import      : {len(imports) - len(failed)}/{len(imports)} 성공")
    for k in failed:
        print(f"    [X] {k}: {imports[k].get('error')}")
    cu = v.get("cuda") or {}
    print(f"  CUDA        : {'사용 가능' if cu.get('available') else '사용 불가(CPU 폴백)'}"
          f" {cu.get('device') or ''} torch={cu.get('torch')}")
    d = v.get("deep") or {}
    if d:
        if d.get("ok"):
            print(f"  모델 로딩   : 성공 ({d.get('elapsed_sec')}s, device={d.get('device')})")
            print(f"                t2s={d.get('t2s_loaded')} vits={d.get('vits_loaded')} "
                  f"bert={d.get('bert_loaded')} hubert={d.get('hubert_loaded')}")
        else:
            print(f"  모델 로딩   : 실패 — {d.get('error')}")
    print(f"  종합        : {'통과' if v.get('ok') else '실패'}")
    if v.get("error"):
        print(f"  오류        : {v['error']}")
    _hr()


# ── 연결 ─────────────────────────────────────────────────────────────────

def link(venv_dir, repo, verification, lock_path=None):
    """검증을 통과한 환경을 앱과 연결한다.

    다른 구성요소의 기록은 그대로 두고 gptsovits 항목만 갈아 끼운다.
    """
    cfg = rt.load_config()
    if cfg.get("_unreadable"):
        raise RuntimeError(
            f"runtime.json 을 읽을 수 없습니다: {rt.config_path()} — "
            "손상된 설정을 덮어쓰지 않습니다. 파일을 확인하거나 이름을 바꾼 뒤 다시 시도하세요.")
    cfg.pop("_unreadable", None)
    cfg["schema"] = rt.SCHEMA_VERSION
    cfg.setdefault("components", {})
    cfg["components"][COMPONENT] = {
        "status": "linked",
        # 평면 키는 읽는 쪽(브리지·워커) 호환용. 아래 owned/external 이 의미를 붙인다.
        "python": rt.venv_python(venv_dir),
        "venv": venv_dir,
        "repo": repo,
        # 앱이 소유한 것 — 설치기가 만들었고, 재설치·갱신·삭제의 대상이다.
        "owned": {
            "runtime_root": rt.runtime_root(),
            "venv": venv_dir,
            "python": rt.venv_python(venv_dir),
            "managed": True,
        },
        # 외부에서 참조하는 것 — 설치기는 읽기만 한다. 손대지 않는다.
        "external": {
            "repo": {
                "path": repo,
                "managed": False,
                "note": "이미 내려받아 둔 GPT-SoVITS 코드·모델. 설치기의 수정·갱신·삭제 대상이 아니다.",
            },
        },
        "recorded_on": {
            "host": socket.gethostname(),
            "user": getpass.getuser(),
            "checkout": rt.repo_root(),
            "main_repo": rt.main_repo_root(),
        },
        "fingerprint": rt.venv_fingerprint(venv_dir),
        "verification": {
            "ok": bool(verification.get("ok")),
            "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "cuda": (verification.get("cuda") or {}).get("available"),
            "device": (verification.get("cuda") or {}).get("device"),
            "deep": bool((verification.get("deep") or {}).get("ok")),
            "model_load_sec": (verification.get("deep") or {}).get("elapsed_sec"),
            "imports_ok": sum(1 for r in (verification.get("imports") or {}).values() if r.get("ok")),
            "imports_total": len(verification.get("imports") or {}),
        },
        "lock": lock_path,
        "installed_by": "python/app_env_installer.py",
    }
    p = rt.save_config(cfg)
    print(f"\n연결 기록: {p}")
    return p


def write_lock(venv_dir, venv_py, repo, spec, stages, shims, verification):
    lock = {
        "schema": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "host": socket.gethostname(),
        "platform": platform.platform(),
        "interpreter": {
            "executable": sys.executable,
            "version": platform.python_version(),
            "spec": spec["interpreter"],
        },
        "component": COMPONENT,
        "venv": {
            "dir": venv_dir,
            "python": venv_py,
            "size_bytes": _dir_size(venv_dir),
            "fingerprint": rt.venv_fingerprint(venv_dir),
        },
        "repo": {"dir": repo, "size_bytes": None},
        "install_stages": stages,
        "shims": shims,
        "packages": pip_freeze(venv_py),
        "verification": verification,
    }
    path = os.path.join(rt.runtime_root(), LOCK_NAME)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(lock, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"설치 명세(lock): {path}  — 패키지 {len(lock['packages'])}개, "
          f"venv {_gib(lock['venv']['size_bytes'])}")
    return path


# ── 동의 ─────────────────────────────────────────────────────────────────

def ask_consent(plan, auto_yes):
    if auto_yes:
        print("동의: --yes 로 비대화식 승인됨.")
        return {"granted": True, "mode": "--yes"}
    if not sys.stdin or not sys.stdin.isatty():
        print("\n[중단] 대화형 입력이 없어 동의를 받을 수 없습니다.")
        print("       터미널에서 직접 실행하거나 --yes 를 붙이세요.")
        return {"granted": False, "mode": "non-interactive"}
    print("위 계획대로 설치할까요? 내려받기는 수 GiB, 수십 분이 걸릴 수 있습니다.")
    try:
        ans = input("  진행하려면 y 를 입력하세요 [y/N]: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return {"granted": False, "mode": "aborted"}
    return {"granted": ans in ("y", "yes"), "mode": "interactive"}


def record_consent(consent):
    cfg = rt.load_config()
    if cfg.get("_unreadable"):
        return
    cfg.pop("_unreadable", None)
    cfg.setdefault("consents", {})[COMPONENT] = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "user": getpass.getuser(),
        "host": socket.gethostname(),
        "mode": consent.get("mode"),
    }
    rt.save_config(cfg)


# ── 명령 ─────────────────────────────────────────────────────────────────

def cmd_status(args):
    probe = rt.probe_gptsovits()
    if args.json:
        print(json.dumps(probe, ensure_ascii=False))
        return 0 if probe["ok"] else 1
    print(f"연결 상태 : {'정상' if probe['ok'] else '미비'}  (기록 출처: {probe['source']})")
    if not probe["ok"]:
        print(f"사유      : {probe['reason']} — {rt.describe(probe['reason'])}")
        hint = (probe.get("details") or {}).get("hint")
        if hint:
            print(f"            {hint}")
    print(f"python    : {probe['python']}")
    print(f"repo      : {probe['repo']}")
    return 0 if probe["ok"] else 1


def cmd_plan(args):
    plan = build_plan()
    if args.json:
        print(json.dumps(plan, ensure_ascii=False))
    else:
        print_plan(plan)
    return 0 if not plan["blockers"] else 1


def cmd_install(args):
    spec = rt.load_spec()
    comp_spec = spec["components"][COMPONENT]
    plan = build_plan()

    if plan["ready"] and not args.reinstall:
        print("이미 검증된 앱 전용 환경이 연결돼 있습니다. 재설치하지 않습니다.")
        print(f"  python: {plan['probe']['python']}")
        print("  다시 설치하려면 --reinstall 을 붙이세요.")
        return 0

    print_plan(plan)
    if plan["blockers"]:
        print("[중단] 위 사유를 해결한 뒤 다시 실행하세요.")
        return 2

    if not _check_interpreter():
        return 2

    consent = ask_consent(plan, args.yes)
    if not consent["granted"]:
        print("\n[취소] 설치하지 않았습니다. 기존 연결은 그대로입니다.")
        return 3
    record_consent(consent)

    venv_dir = plan["venv"]["dir"]
    repo = plan["reuse"]["repo"]
    t0 = time.time()
    try:
        venv_py = create_venv(venv_dir, args.reinstall)
        stages = install_packages(venv_py, comp_spec)
        print("\n>>> shim 생성")
        shims = write_shims(venv_dir)
    except (RuntimeError, OSError) as e:
        print(f"\n[실패] {e}")
        print("       기존 연결은 변경하지 않았습니다. 원인을 고친 뒤 다시 실행하세요.")
        print(f"       재개: python python/app_env_installer.py install")
        return 1

    verification = run_verify(venv_py, repo, deep=not args.skip_deep)
    print_verify(verification)

    lock_path = write_lock(venv_dir, venv_py, repo, spec, stages, shims, verification)

    if not verification.get("ok"):
        print("\n[미연결] 검증을 통과하지 못해 연결하지 않았습니다.")
        print("         새 venv 는 남겨 두었습니다(진단용). 기존 연결도 그대로입니다.")
        print(f"         venv: {venv_dir}")
        print(f"         재검증: python python/app_env_installer.py verify")
        return 1

    link(venv_dir, repo, verification, lock_path)
    print(f"\n완료. 총 {time.time() - t0:.0f}초.")
    final = rt.probe_gptsovits()
    print(f"최종 점검: {'정상' if final['ok'] else final['reason']}")
    return 0 if final["ok"] else 1


def _check_interpreter():
    """설치를 실행 중인 인터프리터가 명세와 맞는지 확인한다.

    venv 는 sys.executable 을 바탕으로 만들어지므로, 여기서 어긋나면 만들어지는
    환경의 파이썬 버전이 명세와 달라진다. 그 사실을 조용히 넘기지 않는다.
    """
    spec = rt.load_spec()
    want = spec["interpreter"]["python_version"].rsplit(".", 1)[0]  # "3.12"
    have = f"{sys.version_info[0]}.{sys.version_info[1]}"
    if have != want:
        print(f"[중단] 이 설치기는 파이썬 {want} 로 실행돼야 합니다 (현재 {have}: {sys.executable}).")
        print("       run.bat 이 앱 전용 파이썬을 먼저 준비한 뒤 이 스크립트를 부릅니다.")
        print("       수동 실행이라면: node scripts/af-launch.mjs --install")
        return False
    return True


def cmd_verify(args):
    probe = rt.probe_gptsovits()
    paths = rt.resolve_gptsovits()
    venv_py = args.python or paths["python"]
    repo = args.repo or paths["repo"]
    if not os.path.exists(venv_py):
        print(f"[오류] 파이썬이 없습니다: {venv_py}")
        return 2
    if not os.path.isdir(repo):
        print(f"[오류] GPT-SoVITS 코드 폴더가 없습니다: {repo}")
        return 2
    v = run_verify(venv_py, repo, deep=not args.no_deep)
    if args.json:
        print(json.dumps(v, ensure_ascii=False))
    else:
        print_verify(v)
    if v.get("ok") and args.relink:
        link(os.path.dirname(os.path.dirname(venv_py)), repo, v)
    if not args.json:
        print(f"(구조 점검: {'정상' if probe['ok'] else probe['reason']})")
    return 0 if v.get("ok") else 1


def cmd_link(args):
    venv_dir = os.path.abspath(args.venv)
    repo = os.path.abspath(args.repo)
    venv_py = rt.venv_python(venv_dir)
    if not os.path.exists(venv_py):
        print(f"[오류] venv 파이썬 없음: {venv_py}")
        return 2
    v = run_verify(venv_py, repo, deep=not args.no_deep)
    print_verify(v)
    if not v.get("ok"):
        print("[중단] 검증을 통과하지 못한 환경은 연결하지 않습니다.")
        return 1
    link(venv_dir, repo, v)
    return 0


def cmd_unlink(args):
    cfg = rt.load_config()
    if cfg.get("_unreadable"):
        print("[오류] runtime.json 을 읽을 수 없습니다.")
        return 2
    cfg.pop("_unreadable", None)
    if COMPONENT in (cfg.get("components") or {}):
        del cfg["components"][COMPONENT]
        rt.save_config(cfg)
        print("연결을 해제했습니다. 설치된 파일은 지우지 않았습니다.")
    else:
        print("연결된 기록이 없습니다.")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="AudioForge 앱 전용 환경 설치기")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("status", help="연결 상태(빠른 구조 점검)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("plan", help="설치 계획 산출")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_plan)

    p = sub.add_parser("install", help="계획 → 동의 → 설치 → 검증 → 연결")
    p.add_argument("--yes", action="store_true", help="동의를 비대화식으로 승인")
    p.add_argument("--reinstall", action="store_true", help="이미 연결돼 있어도 다시 설치")
    p.add_argument("--skip-deep", action="store_true", help="모델 로딩 검증 생략(권장하지 않음)")
    p.set_defaults(func=cmd_install)

    p = sub.add_parser("verify", help="실제 import·모델 로딩 검증")
    p.add_argument("--json", action="store_true")
    p.add_argument("--no-deep", action="store_true")
    p.add_argument("--python", help="검사할 venv 파이썬(기본: 연결된 것)")
    p.add_argument("--repo", help="GPT-SoVITS 코드 폴더(기본: 연결된 것)")
    p.add_argument("--relink", action="store_true", help="통과 시 연결 기록 갱신")
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("link", help="검증 후 수동 연결")
    p.add_argument("--venv", required=True)
    p.add_argument("--repo", required=True)
    p.add_argument("--no-deep", action="store_true")
    p.set_defaults(func=cmd_link)

    p = sub.add_parser("unlink", help="연결 해제(파일은 지우지 않음)")
    p.set_defaults(func=cmd_unlink)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
