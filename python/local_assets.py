# -*- coding: utf-8 -*-
"""로컬 전용 자산 루트(`_local`) 해석 — 앱이 소유한 비추적 자산의 단일 권위.

`externals` 와의 역할 분리(중요):
  * externals/ : 이미 내려받아 둔 **모델·venv·엔진 코드**. 이 모듈은 손대지 않는다.
  * _local/    : 앱이 만들어 내는 **자산과 기록**(참조 보관본·진단·개발 검증물·manifest).

해석 우선순위 — junction 탐색이나 '먼저 발견한 폴더' 추측을 쓰지 않는다:
  1. 환경변수 AUDIOFORGE_LOCAL_ROOT (명시가 언제나 이긴다)
  2. runtime.json 에 기록된 검증된 경로
  3. <본체 저장소>/_local
작업 트리에서 실행해도 (3)은 본체를 가리킨다 — worktree 안에 `_local` 을 만들지 않기 위해서다.

`_local/runtime` 은 **만들지 않는다.** 실제 런타임은 externals/runtime 이고,
빈 폴더를 만들어 두면 그쪽이 소비 경로인 것처럼 오독되기 때문이다(허위 기록 금지).

managed 정책:
  assets/*(originals·references·golden) 는 read-only 로 취급한다 — 앱의 자동정리 대상이 아니다.
  artifacts/diagnostics 와 artifacts/generated 만 수명 정책 대상이 될 수 있다.
  drafts·recovery 는 사람이 보관하는 자료이며 production 소비 대상이 아니다.
"""
import json
import os

import app_runtime

LOCAL_ROOT_ENV = "AUDIOFORGE_LOCAL_ROOT"
DIR_NAME = "_local"

#: 표준 구조. (상대경로, 앱이 수명 관리해도 되는가)
STRUCTURE = (
    ("assets/originals", False),
    ("assets/references", False),
    ("assets/golden", False),
    ("artifacts/generated", True),
    ("artifacts/diagnostics", True),
    ("artifacts/drafts", False),
    ("artifacts/recovery", False),
    ("manifests", False),
)

MANAGED_SUBDIRS = tuple(rel for rel, managed in STRUCTURE if managed)
READ_ONLY_SUBDIRS = tuple(rel for rel, managed in STRUCTURE if not managed)


class LocalRootError(Exception):
    """로컬 자산 루트를 확정할 수 없다. 조용한 추측 대신 이 오류로 재연결을 안내한다."""


def _recorded_root():
    """runtime.json 에 기록된 경로. 다른 host 의 기록이면 무효(존재하지 않음)로 본다."""
    try:
        cfg = app_runtime.config_path()
        if not os.path.isfile(cfg):
            return None
        with open(cfg, encoding="utf-8") as f:
            rec = json.load(f).get("local_root")
    except Exception:
        return None
    if not rec:
        return None
    return rec if os.path.isdir(rec) else None


def local_root():
    """`_local` 실체 경로. 존재 여부는 보장하지 않는다(ensure_structure 가 만든다)."""
    override = os.environ.get(LOCAL_ROOT_ENV)
    if override:
        return os.path.abspath(override)
    rec = _recorded_root()
    if rec:
        return os.path.abspath(rec)
    return os.path.join(app_runtime.main_repo_root(), DIR_NAME)


def resolve_source():
    """지금 경로가 어디서 왔는지 — 진단·보고용(값이 아니라 출처만)."""
    if os.environ.get(LOCAL_ROOT_ENV):
        return "env:" + LOCAL_ROOT_ENV
    if _recorded_root():
        return "runtime.json"
    return "main_repo"


def ensure_structure(root=None):
    """표준 구조를 만든다. **기존 파일을 덮어쓰거나 초기화하지 않는다.**

    이미 있으면 아무 것도 하지 않고, 없는 디렉터리만 만든다.
    반환: (root, 새로 만든 상대경로 목록) — 두 번째 실행에서는 목록이 비어야 한다(멱등).
    """
    base = os.path.abspath(root or local_root())
    created = []
    for rel, _managed in STRUCTURE:
        p = os.path.join(base, rel.replace("/", os.sep))
        if not os.path.isdir(p):
            os.makedirs(p, exist_ok=True)
            created.append(rel)
    return base, created


def _sub(rel):
    p = os.path.join(local_root(), rel.replace("/", os.sep))
    os.makedirs(p, exist_ok=True)
    return p


def diagnostics_dir():
    """ICL 정렬 실패 raw·비민감 진단 JSON 저장 위치. 사용자 결과 폴더가 아니다."""
    return _sub("artifacts/diagnostics")


def references_dir():
    """앱이 참조 목소리를 **자체 보관**할 때만 쓴다. 사용자 원본은 수정하지 않는다."""
    return _sub("assets/references")


def originals_dir():
    return _sub("assets/originals")


def golden_dir():
    """개발 검증 하네스가 명시적으로 실행될 때만 읽는다. 일반 앱 실행은 여기를 보지 않는다."""
    return _sub("assets/golden")


def generated_dir():
    return _sub("artifacts/generated")


def manifests_dir():
    return _sub("manifests")


def is_managed(rel):
    """앱이 수명 정책(보존 개수 제한 등)을 적용해도 되는 구역인가."""
    return rel.replace("\\", "/").strip("/") in MANAGED_SUBDIRS

# ─────────────────────────────────────────────────────────────────────────────
# 개발 산출물 경로 계약
#
# 저장소가 소유한 하네스(합성 검증·진단·GPU 확인)는 **여기 말고 다른 곳에 쓰지 않는다.**
# 예전에는 실행할 때마다 사람이 경로를 골랐고, 그래서 E:\AudioForge_output 아래에
# _af_* 폴더가 여섯 개나 생겼다. 규칙을 사람 기억에 두면 반드시 다시 흩어진다.
#
# 사용자가 앱에서 고른 최종 출력 경로는 이 계약의 대상이 아니다 — 그건 사용자 것이다.
# ─────────────────────────────────────────────────────────────────────────────

EXTERNAL_OVERRIDE_FLAG = "--allow-external-output"


class ExternalOutputBlocked(Exception):
    """개발 하네스가 _local 밖으로 쓰려 했다. 명시 override 없이는 막는다."""


def _run_scoped(kind, run_id):
    if kind not in ("generated", "diagnostics"):
        raise ValueError("kind must be 'generated' or 'diagnostics'")
    rid = str(run_id or "").strip()
    if (not rid or any(c in rid for c in r'\\/:*?"<>|')
            or any(ord(c) < 32 for c in rid)):
        raise ValueError("run_id 가 비었거나 경로 문자를 포함한다: %r" % run_id)
    p = os.path.join(local_root(), "artifacts", kind, rid)
    os.makedirs(p, exist_ok=True)
    return p


def run_output_dir(run_id):
    """개발 하네스의 생성물 위치 — _local/artifacts/generated/<run-id>."""
    return _run_scoped("generated", run_id)


def run_diagnostics_dir(run_id):
    """개발 하네스의 진단 위치 — _local/artifacts/diagnostics/<run-id>."""
    return _run_scoped("diagnostics", run_id)


def drafts_dir():
    return _sub("artifacts/drafts")


def recovery_dir():
    return _sub("artifacts/recovery")


def assert_inside_local(path, argv=None):
    """개발 도구의 출력 경로가 _local 안인지 확인한다.

    argv 에 EXTERNAL_OVERRIDE_FLAG 가 있으면 통과시킨다 — 밖으로 쓰는 일이 불가능해야 하는
    건 아니고, **모르는 사이에** 밖으로 나가는 일이 없어야 한다.
    """
    root = os.path.realpath(local_root())
    real = os.path.realpath(path)
    # 드라이브가 다르면 commonpath 가 ValueError 를 던진다 — 그건 '바깥' 이라는 뜻이지 오류가 아니다.
    try:
        inside = os.path.commonpath([root, real]) == root
    except ValueError:
        inside = False
    if inside:
        return real
    if argv and EXTERNAL_OVERRIDE_FLAG in argv:
        return real
    raise ExternalOutputBlocked(
        "DEV_OUTPUT_OUTSIDE_LOCAL: 개발 산출물은 _local 안에 써야 한다. "
        "정말 밖으로 써야 하면 %s 를 명시하라." % EXTERNAL_OVERRIDE_FLAG)
