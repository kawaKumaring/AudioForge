# -*- coding: utf-8 -*-
"""Provision lock with atomic creation and nonce-bound ownership.

The lock is never stolen automatically. A stale or corrupt lock is diagnostic
state that requires an explicit recovery flow outside this module.
"""

import json
import os
import secrets

from . import reason_codes as rc

DEFAULT_STALE_AFTER_SEC = 30 * 60
LOCK_SCHEMA_VERSION = 2


def _required_text(value, field):
    if not isinstance(value, str) or not value or len(value) > 512:
        raise ValueError(f"invalid {field}")
    if any(ord(ch) < 0x20 for ch in value):
        raise ValueError(f"invalid {field}")
    return value


def encode_lock(pid, created_at, job_id, plan_fingerprint, nonce,
                heartbeat_at=None):
    """Return the canonical v2 lock payload."""
    created = float(created_at)
    payload = {
        "schemaVersion": LOCK_SCHEMA_VERSION,
        "pid": int(pid),
        "jobId": _required_text(job_id, "jobId"),
        "planFingerprint": _required_text(plan_fingerprint, "planFingerprint"),
        "nonce": _required_text(nonce, "nonce"),
        "createdAt": created,
        "heartbeatAt": created if heartbeat_at is None else float(heartbeat_at),
    }
    return json.dumps(payload, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))


def decode_lock(text):
    """Parse a complete v2 lock. Invalid or legacy payloads return None."""
    try:
        obj = json.loads(text)
    except (ValueError, TypeError):
        return None
    if not isinstance(obj, dict) or obj.get("schemaVersion") != LOCK_SCHEMA_VERSION:
        return None
    if not isinstance(obj.get("pid"), int):
        return None
    try:
        for field in ("jobId", "planFingerprint", "nonce"):
            _required_text(obj.get(field), field)
        created = float(obj.get("createdAt"))
        heartbeat_at = float(obj.get("heartbeatAt"))
    except (TypeError, ValueError):
        return None
    return {
        "schemaVersion": LOCK_SCHEMA_VERSION,
        "pid": obj["pid"],
        "jobId": obj["jobId"],
        "planFingerprint": obj["planFingerprint"],
        "nonce": obj["nonce"],
        "createdAt": created,
        "heartbeatAt": heartbeat_at,
    }


def is_stale(lock_info, mtime, now, pid_alive,
             stale_after_sec=DEFAULT_STALE_AFTER_SEC):
    """Classify an orphan candidate without modifying or taking its lock."""
    if lock_info is None:
        return True
    pid = lock_info.get("pid")
    if not isinstance(pid, int) or not pid_alive(pid):
        return True
    try:
        last_seen = max(float(mtime), float(lock_info.get("heartbeatAt")))
    except (TypeError, ValueError):
        return True
    return (float(now) - last_seen) > float(stale_after_sec)


def _read_existing(lock_path, stat_fn):
    try:
        with open(lock_path, "r", encoding="utf-8") as handle:
            info = decode_lock(handle.read())
    except OSError:
        info = None
    try:
        mtime = stat_fn(lock_path)
    except OSError:
        mtime = 0
    return info, mtime


def acquire(lock_path, pid, now, pid_alive, job_id, plan_fingerprint,
            nonce=None, stale_after_sec=DEFAULT_STALE_AFTER_SEC, stat_fn=None,
            open_fn=None):
    """Atomically create a lock and return its decoded ownership token.

    On EEXIST the existing lock is inspected only for HELD or STALE reporting;
    it is never removed or replaced.
    """
    _stat = stat_fn if stat_fn is not None else os.path.getmtime
    _open = open_fn if open_fn is not None else os.open
    token = nonce if nonce is not None else secrets.token_hex(16)
    payload = encode_lock(pid, now, job_id, plan_fingerprint, token)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_BINARY"):
        flags |= os.O_BINARY
    try:
        fd = _open(lock_path, flags, 0o600)
    except FileExistsError:
        info, mtime = _read_existing(lock_path, _stat)
        if is_stale(info, mtime, now, pid_alive, stale_after_sec):
            raise rc.ProvisionError(rc.PROVISION_LOCK_STALE,
                                    "orphan lock — 수동 복구 필요")
        raise rc.ProvisionError(rc.PROVISION_LOCK_HELD,
                                "다른 provision 실행 진행 중")
    try:
        data = payload.encode("utf-8")
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("short lock write")
            view = view[written:]
        os.fsync(fd)
    except BaseException:
        os.close(fd)
        try:
            os.remove(lock_path)
        except OSError:
            pass
        raise
    else:
        os.close(fd)
    return decode_lock(payload)


def _owns(info, pid, job_id, plan_fingerprint, nonce):
    return bool(
        info
        and info.get("pid") == int(pid)
        and info.get("jobId") == job_id
        and info.get("planFingerprint") == plan_fingerprint
        and info.get("nonce") == nonce
    )


def heartbeat(lock_path, pid, job_id, plan_fingerprint, nonce, now):
    """Refresh a lock only when every ownership field still matches."""
    with open(lock_path, "r+", encoding="utf-8") as handle:
        info = decode_lock(handle.read())
        if not _owns(info, pid, job_id, plan_fingerprint, nonce):
            return False
        payload = encode_lock(pid, info["createdAt"], job_id,
                              plan_fingerprint, nonce, heartbeat_at=now)
        handle.seek(0)
        handle.write(payload)
        handle.truncate()
        handle.flush()
        os.fsync(handle.fileno())
    return True


def release(lock_path, pid, job_id, plan_fingerprint, nonce):
    """Release only the lock identified by the complete nonce-bound token."""
    try:
        with open(lock_path, "r", encoding="utf-8") as handle:
            info = decode_lock(handle.read())
    except FileNotFoundError:
        return False
    if not _owns(info, pid, job_id, plan_fingerprint, nonce):
        return False
    os.remove(lock_path)
    return True
