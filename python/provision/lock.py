# -*- coding: utf-8 -*-
"""Provision lock with atomic creation and nonce-bound ownership.

The lock is never stolen automatically. A stale or corrupt lock is diagnostic
state that requires an explicit recovery flow outside this module.
"""

import json
import math
import os
import secrets
import stat

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
    heartbeat = created if heartbeat_at is None else float(heartbeat_at)
    if not math.isfinite(created) or not math.isfinite(heartbeat):
        raise ValueError("lock time must be finite")
    payload = {
        "schemaVersion": LOCK_SCHEMA_VERSION,
        "pid": int(pid),
        "jobId": _required_text(job_id, "jobId"),
        "planFingerprint": _required_text(plan_fingerprint, "planFingerprint"),
        "nonce": _required_text(nonce, "nonce"),
        "createdAt": created,
        "heartbeatAt": heartbeat,
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
        if not math.isfinite(created) or not math.isfinite(heartbeat_at):
            return None
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


def _identity_from_stat(info, require_regular=True):
    attrs = getattr(info, "st_file_attributes", 0)
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    if (stat.S_ISLNK(info.st_mode) or bool(attrs & reparse)
            or (require_regular and not stat.S_ISREG(info.st_mode))
            or getattr(info, "st_nlink", 1) != 1):
        return None
    return (info.st_dev, info.st_ino)


def _path_identity(path):
    try:
        return _identity_from_stat(os.lstat(path))
    except OSError:
        return None


def _fd_identity(fd):
    try:
        return _identity_from_stat(os.fstat(fd))
    except OSError:
        return None


def _same_identity(path, identity):
    return identity is not None and _path_identity(path) == identity


def _create_exclusive_temp(path, payload):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    identity = _fd_identity(fd)
    try:
        if identity is None:
            raise rc.ProvisionError(rc.PROVISION_LOCK_STALE,
                                    "unsafe lock temp")
        data = payload.encode("utf-8")
        written = os.write(fd, data)
        if written != len(data):
            raise OSError("short lock temp write")
        os.fsync(fd)
    except BaseException:
        os.close(fd)
        if _same_identity(path, identity):
            try:
                os.remove(path)
            except OSError:
                pass
        raise
    else:
        os.close(fd)
    return identity


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
    created_identity = _fd_identity(fd)
    if created_identity is None:
        os.close(fd)
        raise rc.ProvisionError(rc.PROVISION_LOCK_STALE,
                                "unsafe lock file identity")
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
        # Never remove by path alone. A complete nonce-bound payload and the
        # originally-created file identity must both still match.
        try:
            with open(lock_path, "r", encoding="utf-8") as handle:
                current = decode_lock(handle.read())
        except OSError:
            current = None
        if (_owns(current, pid, job_id, plan_fingerprint, token)
                and _same_identity(lock_path, created_identity)):
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


def heartbeat(lock_path, pid, job_id, plan_fingerprint, nonce, now,
              replace_fn=None):
    """Atomically refresh a lock after identity and full-owner revalidation."""
    _replace = replace_fn if replace_fn is not None else os.replace
    try:
        with open(lock_path, "r", encoding="utf-8") as handle:
            original_identity = _fd_identity(handle.fileno())
            info = decode_lock(handle.read())
    except (FileNotFoundError, OSError):
        return False
    if (original_identity is None
            or not _owns(info, pid, job_id, plan_fingerprint, nonce)):
        return False
    payload = encode_lock(pid, info["createdAt"], job_id,
                          plan_fingerprint, nonce, heartbeat_at=now)
    temp = lock_path + ".heartbeat-" + secrets.token_hex(16)
    temp_identity = _create_exclusive_temp(temp, payload)
    try:
        # TOCTOU fail-closed: both original identity and nonce-bound payload
        # must remain unchanged immediately before replacement.
        try:
            with open(lock_path, "r", encoding="utf-8") as handle:
                current_identity = _fd_identity(handle.fileno())
                current = decode_lock(handle.read())
        except OSError:
            return False
        if (current_identity != original_identity
                or not _owns(current, pid, job_id, plan_fingerprint, nonce)
                or not _same_identity(lock_path, original_identity)
                or not _same_identity(temp, temp_identity)):
            return False
        _replace(temp, lock_path)
        temp = None
        try:
            with open(lock_path, "r", encoding="utf-8") as handle:
                installed = decode_lock(handle.read())
                installed_identity = _fd_identity(handle.fileno())
        except OSError:
            return False
        return bool(
            installed_identity == temp_identity
            and _owns(installed, pid, job_id, plan_fingerprint, nonce)
            and installed.get("heartbeatAt") == float(now)
        )
    finally:
        if temp and _same_identity(temp, temp_identity):
            try:
                os.remove(temp)
            except OSError:
                pass


def release(lock_path, pid, job_id, plan_fingerprint, nonce):
    """Release only the lock identified by the complete nonce-bound token."""
    try:
        with open(lock_path, "r", encoding="utf-8") as handle:
            original_identity = _fd_identity(handle.fileno())
            info = decode_lock(handle.read())
    except FileNotFoundError:
        return False
    if (original_identity is None
            or not _owns(info, pid, job_id, plan_fingerprint, nonce)):
        return False
    try:
        with open(lock_path, "r", encoding="utf-8") as handle:
            current_identity = _fd_identity(handle.fileno())
            current = decode_lock(handle.read())
    except OSError:
        return False
    if (current_identity != original_identity
            or not _same_identity(lock_path, original_identity)
            or not _owns(current, pid, job_id, plan_fingerprint, nonce)):
        return False
    os.remove(lock_path)
    return True
