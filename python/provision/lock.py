# -*- coding: utf-8 -*-
"""provision.lock — provision 실행 lock의 순수 로직 + crash orphan stale 판정.

PROVISIONER-PLAN §8. lock 파일은 runtimeRoot/locks/provision.lock(layout.provision_lock_path).
중복 실행을 차단하고, crash로 남은 orphan lock은 pid/mtime으로 stale 판정한다.
**자동 탈취 금지** — stale이어도 사용자 안내(PROVISION_LOCK_STALE)만 하고 자동으로 뺏지 않는다.

부작용을 격리하기 위해 lock 파일 경로와 시각/pid-alive 판정을 전부 주입받는다(테스트는 tmp에서만).
lock 내용은 JSON {pid, createdAt, mtime는 파일 stat}. 여기서는 payload 직렬화·해석·stale 판정만.
"""

import json
import os

from . import reason_codes as rc

# stale 판정 기본 임계(초): 이 시간 넘게 갱신 없는 lock은 crash orphan 후보.
DEFAULT_STALE_AFTER_SEC = 30 * 60


def encode_lock(pid, created_at):
    """lock 파일에 쓸 canonical payload 문자열."""
    return json.dumps({"pid": int(pid), "createdAt": float(created_at)},
                      ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def decode_lock(text):
    """lock 파일 내용을 파싱. 실패/손상 시 None(→ 손상 lock은 stale 취급 판단은 상위에서)."""
    try:
        obj = json.loads(text)
    except (ValueError, TypeError):
        return None
    if not isinstance(obj, dict):
        return None
    pid = obj.get("pid")
    if not isinstance(pid, int):
        return None
    return {"pid": pid, "createdAt": obj.get("createdAt")}


def is_stale(lock_info, mtime, now, pid_alive, stale_after_sec=DEFAULT_STALE_AFTER_SEC):
    """lock이 crash orphan(stale)인가.
    - lock_info None(손상) → True(내용 신뢰 불가 → orphan으로 안내)
    - 보유 pid가 살아있지 않으면 → True
    - 살아있어도 mtime이 now보다 stale_after_sec 넘게 오래됐으면 → True
    - 그 외 → False(live).
    pid_alive: callable(pid) -> bool (주입). 실제 프로세스 조회를 격리."""
    if lock_info is None:
        return True
    pid = lock_info.get("pid")
    if not isinstance(pid, int):
        return True
    if not pid_alive(pid):
        return True
    if (now - float(mtime)) > stale_after_sec:
        return True
    return False


def acquire(lock_path, pid, now, pid_alive, stale_after_sec=DEFAULT_STALE_AFTER_SEC, stat_fn=None):
    """lock 획득 시도(순수 판정 + 파일 쓰기). 성공 시 lock payload 반환.
    이미 lock이 존재하면:
      - live  → PROVISION_LOCK_HELD (중복 실행 차단)
      - stale → PROVISION_LOCK_STALE (자동 탈취 금지 — 사용자 안내만)
    lock_path 부모 디렉터리는 호출자가 이미 생성(managed 가드 통과)한 상태여야 한다.
    stat_fn: path→mtime(테스트 주입). None이면 os.path.getmtime."""
    _stat = stat_fn if stat_fn is not None else os.path.getmtime
    if os.path.exists(lock_path):
        with open(lock_path, "r", encoding="utf-8") as f:
            info = decode_lock(f.read())
        try:
            mtime = _stat(lock_path)
        except OSError:
            mtime = 0
        if is_stale(info, mtime, now, pid_alive, stale_after_sec):
            raise rc.ProvisionError(rc.PROVISION_LOCK_STALE, "orphan lock — 수동 정리 필요")
        raise rc.ProvisionError(rc.PROVISION_LOCK_HELD, "다른 provision 실행 진행 중")
    payload = encode_lock(pid, now)
    with open(lock_path, "w", encoding="utf-8") as f:
        f.write(payload)
    return payload


def release(lock_path, pid):
    """자신(pid)이 보유한 lock만 해제. 다른 pid의 lock은 건드리지 않는다(자동 탈취 금지)."""
    if not os.path.exists(lock_path):
        return False
    with open(lock_path, "r", encoding="utf-8") as f:
        info = decode_lock(f.read())
    if info is None or info.get("pid") != int(pid):
        return False
    os.remove(lock_path)
    return True
