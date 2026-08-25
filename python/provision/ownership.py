# -*- coding: utf-8 -*-
"""provision.ownership — 소유권 강제(순수 판정 + makedirs 가드).

PROVISIONER-PLAN §4. managed root만 쓰기, borrowed는 read-only(위반=BORROWED_RUNTIME_READ_ONLY).
staging은 managed cacheRoot에서만. runtimeRoot/modelRoot는 apply 승인 전 자동 생성 0.

이 모듈은 root 소유권을 runtime_paths.ownership/can_write로 조회해 판정만 한다. 실제 makedirs는
ensure_dir이 **managed일 때만** 수행하며, staging_makedirs는 cacheRoot 전용이다. 이 단계에서
runtimeRoot/modelRoot에 대한 자동 생성은 호출되지 않는다(호출 시에도 managed 가드가 적용됨).
"""

import os

import runtime_paths
from . import reason_codes as rc


def require_writable(root_key):
    """root_key가 managed(쓰기 허용)인지 확인. borrowed면 BORROWED_RUNTIME_READ_ONLY."""
    if not runtime_paths.can_write(root_key):
        raise rc.ProvisionError(rc.BORROWED_RUNTIME_READ_ONLY, root_key)


def can_stage():
    """staging 생성 가능 여부 — managed cacheRoot일 때만 True."""
    return runtime_paths.is_configured() and runtime_paths.ownership("cacheRoot") == "audioforge-managed"


def require_stageable():
    """staging은 managed cacheRoot에서만. 아니면 BORROWED_RUNTIME_READ_ONLY."""
    require_writable("cacheRoot")


def ensure_dir(abs_path, root_key):
    """abs_path 디렉터리를 managed root에서만 생성. borrowed면 만들지 않고 예외.
    abs_path는 반드시 runtime_paths *_subdir로 이미 containment 검증된 경로여야 한다."""
    require_writable(root_key)
    os.makedirs(abs_path, exist_ok=True)
    return abs_path


def staging_makedirs(abs_path):
    """cacheRoot(managed) 전용 staging 디렉터리 생성."""
    require_stageable()
    os.makedirs(abs_path, exist_ok=True)
    return abs_path
