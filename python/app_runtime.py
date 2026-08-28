#!/usr/bin/env python3
"""AudioForge 앱 전용 런타임 경로 해석 — 단일 소스, 표준 라이브러리만 사용.

이 모듈은 "앱이 어느 파이썬·어느 코드·어느 모델을 쓰는가"를 한 곳에서 답한다.
호출자는 세 부류다.

  1. 설치기(app_env_installer.py)  — 설치 후 연결 정보를 기록한다.
  2. 앱 워커(tts_worker.py 등)      — 기록된 연결 정보를 읽어 하위 프로세스를 띄운다.
  3. 실행 런처(scripts/af-launch.mjs) — 같은 규칙을 Node로 다시 구현해 사전 점검한다.

설계 규칙
---------
* 표준 라이브러리만 쓴다. 아직 아무 패키지도 설치되지 않은 부트스트랩 파이썬에서도
  import 가능해야 하기 때문이다.
* 연결(link)은 파일 시스템의 모양이 아니라 **runtime.json 의 기록**이다.
  디렉터리가 있다는 사실만으로 "정상"이라고 판정하지 않는다.
* 두 종류의 위치를 구분한다.
    runtime_root() — 앱이 **소유한** 것(전용 파이썬·전용 venv·runtime.json).
                     설치기가 만들고 고치고 지울 수 있는 유일한 영역.
    assets_root()  — **외부에서 참조하는** 것(GPT-SoVITS 코드·모델, Qwen, 분리 모델).
                     설치기는 읽기만 한다.
  기본값은 둘 다 **본체 저장소** 밑이다. 작업 트리 안이 아니다 — 작업 트리를
  정리하면 그 안의 런타임도 함께 사라지기 때문이다(2026-08-29 사고).
* 기록에는 검증 결과와 함께 **지문(fingerprint)** 을 남긴다. 지문은 venv 안에 실제로
  설치된 배포 목록에서 계산하므로, 패키지가 지워지면(2026-08-29 사고 유형) 즉시 어긋난다.
* runtime.json 이 없거나 항목이 없으면 **기존 관례 경로로 폴백**한다. 이 저장소를
  예전 방식으로 쓰던 환경이 이 변경만으로 깨지지 않게 하기 위해서다.
"""

import hashlib
import json
import os
import sys
import tempfile

SCHEMA_VERSION = 1

# runtime.json 이 침묵할 때 쓰는 예전 관례 경로 (기존 환경 호환).
LEGACY_GPTSOVITS_VENV = "gptsovits_venv"
LEGACY_GPTSOVITS_REPO = "GPT-SoVITS"


def repo_root():
    """python/ 의 부모 = 이 체크아웃의 루트(작업 트리일 수도 있다)."""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main_repo_root():
    """작업 트리가 아니라 **본체 저장소**의 루트.

    왜 필요한가: 런타임(파이썬·venv, 수 GiB)을 작업 트리 안에 만들면 그 작업 트리를
    정리하는 순간 함께 사라진다. 실제로 2026-08-29 에 그렇게 잃었다. 런타임은
    작업 트리보다 오래 살아야 하므로 본체 저장소 밑에 둔다.

    판별은 .git 하나만 본다.
      * .git 이 디렉터리  → 여기가 본체다.
      * .git 이 파일      → "gitdir: <본체>/.git/worktrees/<이름>" 이 들어 있다.
                            worktrees 앞부분이 본체의 .git 이고, 그 부모가 본체 루트다.
    판별에 실패하면 이 체크아웃을 본체로 본다(단독 클론은 실제로 그렇다).
    git 명령을 부르지 않는다 — 아직 아무것도 설치되지 않은 부트스트랩에서도 답해야 한다.
    """
    here = repo_root()
    dot_git = os.path.join(here, ".git")
    if os.path.isdir(dot_git):
        return here
    if os.path.isfile(dot_git):
        try:
            with open(dot_git, encoding="utf-8") as f:
                line = f.read().strip()
        except OSError:
            return here
        if line.startswith("gitdir:"):
            gitdir = line.split(":", 1)[1].strip().replace("/", os.sep)
            if not os.path.isabs(gitdir):
                gitdir = os.path.join(here, gitdir)
            gitdir = os.path.abspath(gitdir)
            marker = os.sep + "worktrees" + os.sep
            idx = gitdir.lower().rfind(marker.lower())
            if idx != -1:
                main_git = gitdir[:idx]          # <본체>/.git
                if os.path.basename(main_git).lower() == ".git":
                    return os.path.dirname(main_git)
    return here


def runtime_root():
    """**앱이 소유한** 런타임(전용 파이썬·전용 venv·연결 기록)이 사는 곳.

    기본값은 <본체 저장소>/externals/runtime 이다. 작업 트리에서 실행해도 같은 곳을
    가리키므로, 작업 트리를 만들고 지우는 일이 런타임에 영향을 주지 않는다.
    AUDIOFORGE_RUNTIME_ROOT 를 명시하면 그쪽이 우선한다(다른 디스크로 옮길 때).
    """
    override = os.environ.get("AUDIOFORGE_RUNTIME_ROOT")
    if override:
        return os.path.abspath(override)
    return os.path.join(main_repo_root(), "externals", "runtime")


def assets_root():
    """**외부에서 참조하는** 자산(이미 내려받아 둔 코드·모델)이 사는 곳.

    설치기는 여기를 읽기만 한다 — 만들지도, 고치지도, 지우지도 않는다.
    GPT-SoVITS 코드·모델, Qwen venv·가중치, 분리 모델이 여기 있다.
    """
    override = os.environ.get("AUDIOFORGE_ASSETS_ROOT")
    if override:
        return os.path.abspath(override)
    return os.path.join(main_repo_root(), "externals")


def config_path():
    return os.path.join(runtime_root(), "runtime.json")


def spec_path():
    return os.path.join(repo_root(), "python", "runtime_spec.json")


def load_spec():
    with open(spec_path(), encoding="utf-8") as f:
        return json.load(f)


# ── runtime.json 읽기/쓰기 ────────────────────────────────────────────────

def load_config():
    p = config_path()
    if not os.path.exists(p):
        return {"schema": SCHEMA_VERSION, "components": {}}
    try:
        with open(p, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        # 손상된 설정은 "연결 없음"으로 취급한다. 조용히 덮어쓰지 않는다.
        return {"schema": SCHEMA_VERSION, "components": {}, "_unreadable": True}
    cfg.setdefault("schema", SCHEMA_VERSION)
    cfg.setdefault("components", {})
    return cfg


def save_config(cfg):
    """원자적 쓰기. 쓰다 죽어도 반쯤 쓰인 runtime.json 이 남지 않는다."""
    p = config_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p), prefix=".runtime-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, p)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return p


def get_component(name, cfg=None):
    cfg = cfg if cfg is not None else load_config()
    return (cfg.get("components") or {}).get(name)


# ── 지문 ─────────────────────────────────────────────────────────────────

def venv_site_packages(venv_dir):
    return os.path.join(venv_dir, "Lib", "site-packages")


def venv_python(venv_dir):
    return os.path.join(venv_dir, "Scripts", "python.exe")


def distribution_list(venv_dir):
    """venv 에 실제로 설치돼 있는 배포 목록(dist-info 디렉터리 이름) — 정렬본.

    dist-info 는 pip 이 설치를 마쳐야 생기므로, 이 목록은 "설치되었다고 주장하는
    것"이 아니라 "설치가 끝난 것"이다. 목록이 줄어들면 지문이 바뀐다.
    """
    site = venv_site_packages(venv_dir)
    try:
        names = [n for n in os.listdir(site) if n.endswith(".dist-info")]
    except OSError:
        return []
    names.sort()
    return names


def venv_fingerprint(venv_dir):
    """설치 내용의 지문 — **빠른 재실행 점검**용이지 무결성 증명이 아니다.

    무엇을 잡는가
        배포(dist-info) 가 사라지거나 늘어난 것, 인터프리터가 바뀐 것.
        즉 2026-08-29 사고 유형(디렉터리는 남고 패키지가 통째로 소실)을 잡는다.

    무엇을 못 잡는가 (정직하게)
        * dist-info 는 남고 패키지 **본문**(.py/.pyd/.dll)만 손상·삭제된 경우.
        * 파일 내용이 바뀌었지만 이름 목록은 그대로인 경우.
        * 버전이 같은 다른 빌드로 바꿔치기된 경우.
      이 지문은 site-packages 전체를 해싱하지 않는다. 수 GiB 를 앱 실행 때마다
      읽는 것은 점검이 아니라 부하이기 때문이다. 본문까지 확인하는 일은
      app_env_verify.py 의 **실제 import·모델 로딩**이 담당하며, 그것은 설치 직후와
      `verify` 명령에서만 돈다. 두 검사의 범위가 다르다는 점을 섞지 말 것.
    """
    dists = distribution_list(venv_dir)
    py = venv_python(venv_dir)
    try:
        py_size = os.path.getsize(py)
    except OSError:
        py_size = -1
    h = hashlib.sha256()
    h.update(f"py:{py_size}\n".encode())
    for name in dists:
        h.update(name.encode("utf-8"))
        h.update(b"\n")
    return {"sha256": h.hexdigest(), "distributions": len(dists), "python_size": py_size}


def _hostname():
    """기록·비교 양쪽이 같은 출처를 쓰도록 한 곳에서만 구한다."""
    import socket
    return socket.gethostname()


def sha256_file(path, chunk=1024 * 1024):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


# ── 구성요소 해석 ────────────────────────────────────────────────────────

def _legacy_gptsovits():
    """예전 관례 경로 — 외부 자산 폴더 밑의 venv/코드.

    런타임 루트가 아니라 자산 루트를 본다. 예전 설치는 externals/ 바로 밑에 있었고,
    새 런타임 루트(externals/runtime)에는 그런 것이 없다.
    """
    root = assets_root()
    return {
        "python": venv_python(os.path.join(root, LEGACY_GPTSOVITS_VENV)),
        "venv": os.path.join(root, LEGACY_GPTSOVITS_VENV),
        "repo": os.path.join(root, LEGACY_GPTSOVITS_REPO),
        "source": "legacy",
        "owned": False,
    }


def resolve_gptsovits(cfg=None):
    """GPT-SoVITS 실행에 필요한 경로 묶음.

    반환: {python, venv, repo, source, owned}
      source = "runtime.json" (설치기가 연결한 것) | "legacy" (예전 관례 경로)
      owned  = python/venv 가 앱 소유 런타임인가 (외부 자산이면 False)
    존재 여부는 확인하지 않는다 — 판정은 probe_gptsovits() 담당.
    """
    comp = get_component("gptsovits", cfg)
    if comp and comp.get("status") == "linked" and comp.get("python") and comp.get("repo"):
        venv = comp.get("venv") or os.path.dirname(os.path.dirname(comp["python"]))
        return {
            "python": comp["python"],
            "venv": venv,
            "repo": comp["repo"],
            "source": "runtime.json",
            "owned": bool((comp.get("owned") or {}).get("venv")),
        }
    return _legacy_gptsovits()


def _model_requirements(spec=None):
    """검증에 쓸 모델 파일 목록: (상대경로, 최소 바이트)."""
    try:
        spec = spec or load_spec()
        rows = spec["components"]["gptsovits"]["model_files"]
        return [(r["path"], int(r["min_bytes"])) for r in rows]
    except Exception:
        # 명세를 못 읽어도 판정은 가능해야 한다 — 최소 집합을 내장한다.
        base = "GPT_SoVITS/pretrained_models"
        return [
            (f"{base}/chinese-hubert-base/pytorch_model.bin", 100_000_000),
            (f"{base}/chinese-roberta-wwm-ext-large/pytorch_model.bin", 400_000_000),
            (f"{base}/gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt", 100_000_000),
            (f"{base}/gsv-v2final-pretrained/s2G2333k.pth", 50_000_000),
        ]


def probe_gptsovits(cfg=None, spec=None):
    """빠른 재실행 점검 — 앱 실행 직전마다 돌아도 될 만큼 싸다.

    "정상"의 조건은 네 가지가 모두 참일 때뿐이다.
      1. runtime.json 에 검증 통과 기록이 있다 (파일 모양이 아니라 기록).
      2. 인터프리터가 실존한다.
      3. 모델 파일이 실존하고 기대 크기 이상이다 (0바이트 껍데기 배제).
      4. venv 지문이 기록된 지문과 같다 (배포 목록·인터프리터 변화 감지).

    이 점검이 통과했다는 것은 "지난번 통과한 그 설치가 그대로 있어 보인다"는 뜻이지
    "지금 import 가 된다"는 뜻이 아니다. 패키지 본문 손상은 여기서 안 잡힌다
    (venv_fingerprint 의 한계 참고). 본문까지 보는 것은
    app_env_installer.py verify → app_env_verify.py 의 실제 import·모델 로딩이며,
    그것은 수십 초가 걸리므로 설치 직후와 명시 요청에서만 돈다.
    """
    cfg = cfg if cfg is not None else load_config()
    comp = get_component("gptsovits", cfg)
    paths = resolve_gptsovits(cfg)
    out = {
        "component": "gptsovits",
        "source": paths["source"],
        "python": paths["python"],
        "repo": paths["repo"],
        "venv": paths["venv"],
        "owned": paths.get("owned", False),
        "runtime_root": runtime_root(),
        "assets_root": assets_root(),
        "ok": False,
        "reason": None,
        "details": {},
    }

    if paths["source"] == "legacy":
        out["reason"] = "NOT_LINKED"
        out["details"]["hint"] = "runtime.json 에 gptsovits 연결 기록이 없습니다."
        # 폴백 경로가 실제로 쓸 만한지까지는 굳이 판정하지 않는다.
        # 여기서 ok 를 주면 손상된 예전 venv 를 정상으로 오인하게 된다.
        return out

    recorded_host = ((comp or {}).get("recorded_on") or {}).get("host")
    foreign = bool(recorded_host) and recorded_host.lower() != _hostname().lower()

    if not os.path.exists(paths["python"]) or not os.path.isdir(paths["repo"]):
        # 다른 PC 에서 만든 기록이면 그 사실을 이름으로 말한다.
        # 조용히 예전 경로로 미끄러지면 "왜 안 되는지"가 영원히 안 보인다.
        if foreign:
            out["reason"] = "RECORDED_ON_OTHER_HOST"
            out["details"]["recorded_host"] = recorded_host
            out["details"]["this_host"] = _hostname()
            out["details"]["hint"] = (
                f"이 연결 기록은 다른 PC('{recorded_host}')에서 만들어졌고, "
                f"여기('{_hostname()}')에는 그 경로가 없습니다. "
                "run.bat 을 실행해 이 PC 에 설치하세요. 기록은 덮어쓰지 않았습니다.")
            return out
        out["reason"] = "PYTHON_MISSING" if not os.path.exists(paths["python"]) else "REPO_MISSING"
        return out

    missing = []
    for rel, min_bytes in _model_requirements(spec):
        p = os.path.join(paths["repo"], rel.replace("/", os.sep))
        try:
            size = os.path.getsize(p)
        except OSError:
            missing.append({"path": rel, "size": None, "min_bytes": min_bytes})
            continue
        if size < min_bytes:
            missing.append({"path": rel, "size": size, "min_bytes": min_bytes})
    if missing:
        out["reason"] = "MODEL_INCOMPLETE"
        out["details"]["missing"] = missing
        return out

    recorded = (comp or {}).get("fingerprint") or {}
    actual = venv_fingerprint(paths["venv"])
    out["details"]["fingerprint"] = {"recorded": recorded, "actual": actual}
    if not recorded.get("sha256"):
        out["reason"] = "NO_FINGERPRINT"
        return out
    if recorded.get("sha256") != actual.get("sha256"):
        out["reason"] = "FINGERPRINT_MISMATCH"
        out["details"]["hint"] = (
            f"기록 {recorded.get('distributions')}개 → 현재 {actual.get('distributions')}개. "
            "패키지가 삭제·변경되었습니다."
        )
        return out

    verification = (comp or {}).get("verification") or {}
    if not verification.get("ok"):
        out["reason"] = "NOT_VERIFIED"
        return out

    out["ok"] = True
    out["details"]["verified_at"] = verification.get("at")
    return out


REASON_TEXT = {
    "NOT_LINKED": "앱 전용 GPT-SoVITS 환경이 아직 연결되지 않았습니다.",
    "PYTHON_MISSING": "연결된 파이썬 실행 파일이 없습니다.",
    "REPO_MISSING": "GPT-SoVITS 코드 폴더가 없습니다.",
    "MODEL_INCOMPLETE": "사전학습 모델 파일이 없거나 손상되었습니다.",
    "NO_FINGERPRINT": "설치 지문 기록이 없습니다(옛 형식 기록).",
    "FINGERPRINT_MISMATCH": "설치된 패키지가 기록과 다릅니다(삭제·변경 감지).",
    "NOT_VERIFIED": "설치 기록은 있으나 검증을 통과한 적이 없습니다.",
    "RECORDED_ON_OTHER_HOST": "다른 PC 에서 만든 연결 기록입니다. 이 PC 에는 그 경로가 없습니다.",
}


def describe(reason):
    return REASON_TEXT.get(reason, reason or "")


def _cli():
    import argparse
    ap = argparse.ArgumentParser(description="AudioForge 런타임 경로 해석")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    r = probe_gptsovits()
    if args.json:
        print(json.dumps({"runtime_root": runtime_root(), "assets_root": assets_root(),
                          "main_repo": main_repo_root(), "checkout": repo_root(),
                          "config": config_path(), "gptsovits": r}, ensure_ascii=False))
    else:
        print(f"checkout     : {repo_root()}")
        print(f"main repo    : {main_repo_root()}")
        print(f"runtime root : {runtime_root()}   (앱 소유 — 설치기가 만들고 고친다)")
        print(f"assets root  : {assets_root()}   (외부 참조 — 읽기만 한다)")
        print(f"config       : {config_path()}")
        print(f"gptsovits    : {'OK' if r['ok'] else 'NG'} ({r['source']})")
        if not r["ok"]:
            print(f"  사유       : {r['reason']} — {describe(r['reason'])}")
            hint = (r.get("details") or {}).get("hint")
            if hint:
                print(f"             {hint}")
        print(f"  python     : {r['python']}  [{'앱 소유' if r.get('owned') else '외부/미상'}]")
        print(f"  repo       : {r['repo']}  [외부 참조]")
    return 0 if r["ok"] else 1


if __name__ == "__main__":
    sys.exit(_cli())
