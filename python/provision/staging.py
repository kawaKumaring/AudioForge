# -*- coding: utf-8 -*-
"""provision.staging — owned staging/verify/atomic pointer primitives.

PROVISIONER-PLAN §8. 이 단계에서 apply(다운로드/설치)는 비활성이므로 이 프리미티브들은
합성 tmp 디렉터리에서만 단위검증된다 — 다운로드/네트워크/pip 없음, 이미 존재하는 파일에 대한
checksum 검증 + immutable 이동 + 작은 pointer의 atomic replace만 수행한다.

원자성 계약:
  - final 대상의 같은 볼륨·부모에 target-local staging을 만들고 소유 marker로 묶는다.
  - immutable `versioned_component_dir`에 설치(사전 미존재 필수 — 기존 버전 절대 덮어쓰지/삭제하지 않음).
  - 검증 완료 후 **작은 pointer 파일만** atomic replace(os.replace on file). dir을 replace하지 않는다.
  - 실패/cancel/disk full → staging만 제거, 기존 active pointer·기존 버전 불변.

checksum '계산'은 model_manifest(Python) 재사용. '해석'은 상위(state)·C.
"""

import json
import os
import shutil
import stat

import model_manifest
from . import reason_codes as rc

JOB_MARKER_FILE = ".audioforge-provision-job.json"
TARGET_STAGING_DIR = ".audioforge-staging"


def validate_path_segment(value, field="path segment"):
    """Validate an identifier before using it as exactly one path segment."""
    if (not isinstance(value, str) or not value or value in (".", "..")
            or len(value) > 255 or "\x00" in value
            or "/" in value or "\\" in value or ":" in value
            or any(ord(ch) < 0x20 for ch in value)):
        raise rc.ProvisionError(rc.PATH_OUTSIDE_ROOT, field)
    return value


def _within(path, root):
    try:
        child = os.path.normcase(os.path.abspath(path))
        parent = os.path.normcase(os.path.abspath(root))
        return os.path.commonpath((child, parent)) == parent
    except (ValueError, OSError):
        return False


def _has_reparse_or_link(path, root):
    """Reject symlink/junction/reparse points in the existing path chain."""
    root_abs = os.path.abspath(root)
    path_abs = os.path.abspath(path)
    if not _within(path_abs, root_abs):
        return True
    if os.path.lexists(root_abs):
        try:
            root_info = os.lstat(root_abs)
        except OSError:
            return True
        root_attrs = getattr(root_info, "st_file_attributes", 0)
        reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        if stat.S_ISLNK(root_info.st_mode) or bool(root_attrs & reparse):
            return True
    rel = os.path.relpath(path_abs, root_abs)
    current = root_abs
    parts = [] if rel == "." else rel.split(os.sep)
    for part in parts:
        current = os.path.join(current, part)
        if not os.path.lexists(current):
            break
        try:
            info = os.lstat(current)
        except OSError:
            return True
        attrs = getattr(info, "st_file_attributes", 0)
        reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        if stat.S_ISLNK(info.st_mode) or bool(attrs & reparse):
            return True
    return False


def require_managed_containment(path, managed_root, must_exist=False):
    """Return an absolute path only when lexical and resolved containment hold."""
    candidate = os.path.abspath(path)
    root = os.path.abspath(managed_root)
    if not _within(candidate, root):
        raise rc.ProvisionError(rc.PATH_OUTSIDE_ROOT, "managed containment")
    if must_exist and not os.path.lexists(candidate):
        raise rc.ProvisionError(rc.PATH_OUTSIDE_ROOT, "managed path missing")
    if _has_reparse_or_link(candidate, root):
        raise rc.ProvisionError(rc.PATH_OUTSIDE_ROOT, "reparse/link path")
    root_real = os.path.realpath(root)
    candidate_real = os.path.realpath(candidate)
    if not _within(candidate_real, root_real):
        raise rc.ProvisionError(rc.PATH_OUTSIDE_ROOT, "resolved path escape")
    return candidate


def target_local_staging_dir(versioned_component_dir, job_id, component_id):
    """Derive staging beside the final component so os.replace stays local."""
    validate_path_segment(job_id, "jobId")
    validate_path_segment(component_id, "componentId")
    parent = os.path.dirname(os.path.abspath(versioned_component_dir))
    return os.path.join(parent, TARGET_STAGING_DIR, job_id, component_id)


def create_job_marker(staging_dir, managed_root, job_id, plan_fingerprint, nonce):
    """Create an exclusive ownership marker in an already-created staging dir."""
    validate_path_segment(job_id, "jobId")
    if not isinstance(plan_fingerprint, str) or not plan_fingerprint:
        raise ValueError("invalid planFingerprint")
    if not isinstance(nonce, str) or not nonce:
        raise ValueError("invalid nonce")
    base = require_managed_containment(staging_dir, managed_root, must_exist=True)
    marker = os.path.join(base, JOB_MARKER_FILE)
    payload = json.dumps({
        "schemaVersion": 1,
        "jobId": job_id,
        "planFingerprint": plan_fingerprint,
        "nonce": nonce,
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(marker, flags, 0o600)
    try:
        os.write(fd, payload.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    return marker


def _owned_job(staging_dir, job_id, nonce):
    marker = os.path.join(staging_dir, JOB_MARKER_FILE)
    try:
        with open(marker, "r", encoding="utf-8") as handle:
            info = json.load(handle)
    except (OSError, ValueError, TypeError):
        return False
    return bool(
        isinstance(info, dict)
        and info.get("schemaVersion") == 1
        and info.get("jobId") == job_id
        and info.get("nonce") == nonce
        and isinstance(info.get("planFingerprint"), str)
        and info.get("planFingerprint")
    )


def safe_archive_member_path(destination, member_name):
    """Map a ZIP member below destination, rejecting traversal/ADS/absolute paths."""
    if not isinstance(member_name, str) or not member_name or "\x00" in member_name:
        raise rc.ProvisionError(rc.PATH_OUTSIDE_ROOT, "archive member")
    normalized = member_name.replace("\\", "/")
    drive, _ = os.path.splitdrive(normalized)
    trimmed = normalized[:-1] if normalized.endswith("/") else normalized
    parts = trimmed.split("/")
    if (drive or normalized.startswith("/") or normalized.startswith("//")
            or any(part in ("", ".", "..") or ":" in part for part in parts)):
        raise rc.ProvisionError(rc.PATH_OUTSIDE_ROOT, "archive traversal")
    if not parts:
        raise rc.ProvisionError(rc.PATH_OUTSIDE_ROOT, "archive member")
    target = os.path.join(os.path.abspath(destination), *parts)
    return require_managed_containment(target, destination)


def validate_zip_infos(destination, infos):
    """Validate ZIP members without extracting; reject links and name collisions."""
    targets = []
    seen = set()
    for info in infos:
        name = getattr(info, "filename", None)
        mode = (int(getattr(info, "external_attr", 0)) >> 16) & 0o170000
        if mode == stat.S_IFLNK:
            raise rc.ProvisionError(rc.PATH_OUTSIDE_ROOT, "archive symlink")
        target = safe_archive_member_path(destination, name)
        key = os.path.normcase(os.path.normpath(target))
        if key in seen:
            raise rc.ProvisionError(rc.PATH_OUTSIDE_ROOT, "archive collision")
        seen.add(key)
        targets.append(target)
    return targets


def required_free_by_volume(entries, reserve_bytes=0):
    """Pure per-volume capacity calculation. Unknown or invalid sizes STOP."""
    if not isinstance(reserve_bytes, int) or reserve_bytes < 0:
        raise ValueError("invalid reserve_bytes")
    totals = {}
    for entry in entries:
        volume = entry.get("volumeId") if isinstance(entry, dict) else None
        if not isinstance(volume, str) or not volume:
            raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, "volumeId")
        subtotal = 0
        for field in ("downloadBytes", "stagingBytes", "installBytes", "rollbackBytes"):
            value = entry.get(field)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, field)
            subtotal += value
        totals[volume] = totals.get(volume, 0) + subtotal
    return {volume: total + reserve_bytes for volume, total in totals.items()}


# ── checksum 검증 ─────────────────────────────────────────────────────────────
def check_required_files(base_dir, required_files):
    """required_files=[{path, sha256}] 각각을 base_dir 기준으로 검사(예외 없이 결과 리스트 반환).
    반환 항목: {path, present, expectedChecksum, actualChecksum, reasonCode}.
    multi-file 모델에서 일부만 실패하는 상황을 상위가 집계할 수 있게 raise하지 않는다."""
    out = []
    for entry in required_files:
        rel = entry.get("path")
        expected = entry.get("sha256")
        abs_path = safe_archive_member_path(base_dir, rel)
        present = os.path.exists(abs_path) and os.path.getsize(abs_path) > 0
        actual = None
        reason = None
        if not present:
            reason = rc.MODEL_MISSING
        else:
            actual = model_manifest.sha256_file(abs_path)
            if expected is not None and actual != expected:
                reason = rc.MODEL_CHECKSUM_MISMATCH
        out.append({
            "path": rel, "present": present,
            "expectedChecksum": expected, "actualChecksum": actual, "reasonCode": reason,
        })
    return out


def verify_required_files(base_dir, required_files):
    """전 파일이 존재 + checksum 일치해야 성공. 하나라도 실패하면 첫 실패 사유로 ProvisionError.
    성공 시 결과 리스트 반환."""
    results = check_required_files(base_dir, required_files)
    for r in results:
        if r["reasonCode"] is not None:
            raise rc.ProvisionError(r["reasonCode"], r["path"])
    return results


# ── pointer(작은 active-manifest) atomic replace ────────────────────────────
def read_pointer(pointer_path):
    """active pointer 읽기. 없으면 None(설치 이력 없음). 손상 시 None."""
    if not os.path.exists(pointer_path):
        return None
    try:
        with open(pointer_path, "r", encoding="utf-8") as f:
            obj = json.loads(f.read())
    except (OSError, ValueError):
        return None
    return obj if isinstance(obj, dict) else None


def write_pointer_atomic(pointer_path, active, replace_fn=None):
    """active(dict, 예: {componentId, version})를 pointer_path에 atomic하게 기록.
    temp 파일에 쓰고 같은 디렉터리에서 os.replace(파일→파일; 원자적). replace_fn 주입 시 그것을 사용.
    실패(예: disk full)면 temp만 남기지 않고 정리 후 예외 전파 — 기존 pointer는 불변."""
    _replace = replace_fn if replace_fn is not None else os.replace
    d = os.path.dirname(pointer_path)
    tmp = pointer_path + ".tmp"
    payload = json.dumps(active, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(payload)
        _replace(tmp, pointer_path)
    except OSError:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        raise
    return active


# ── immutable 설치 + promote ─────────────────────────────────────────────────
def cleanup_staging(staging_dir, managed_root, job_id, nonce):
    """Remove only a contained staging tree bearing this job's marker.

    Missing directories are a no-op. Marker mismatch, traversal and reparse
    paths are hard failures; deletion errors are never converted to success.
    """
    if not staging_dir or not os.path.lexists(staging_dir):
        return False
    base = require_managed_containment(
        staging_dir, managed_root, must_exist=True)
    if not os.path.isdir(base) or not _owned_job(base, job_id, nonce):
        raise rc.ProvisionError(rc.PATH_OUTSIDE_ROOT,
                                "staging ownership marker mismatch")
    shutil.rmtree(base)
    return True


def _volume_identity(path):
    """Return a stable volume id using drive/UNC root or nearest st_dev."""
    absolute = os.path.abspath(path)
    drive, _ = os.path.splitdrive(absolute)
    if drive:
        return os.path.normcase(drive)
    current = absolute
    while not os.path.exists(current):
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return os.stat(current).st_dev


def promote(staging_dir, versioned_component_dir, pointer_path, active,
            managed_root, job_id, nonce, replace_dir_fn=None,
            replace_pointer_fn=None, volume_fn=None):
    """검증된 staging_dir을 immutable versioned_component_dir로 이동한 뒤, 작은 pointer만 atomic 교체.
    - versioned_component_dir가 이미 존재하면 덮어쓰지 않는다(immutable) → 그대로 예외.
    - 디렉터리 이동 실패(disk full 등) → staging 제거, 기존 active/버전 불변 후 예외.
    - pointer 교체 실패 → 방금 만든 versioned dir은 그대로 두되(부분 산출물 아님, 검증 완료본),
      기존 active pointer는 불변. staging은 이미 이동됐으므로 제거 대상 아님.
    replace_dir_fn/replace_pointer_fn: 테스트 주입(disk full 시뮬레이션). 기본 os.replace.
    반환: {versionedDir 존재 여부는 노출 안 함} active(dict).
    NOTE: 실제 apply(설치)는 이 단계에서 호출되지 않는다 — 합성 tmp 검증 전용 프리미티브."""
    _rep_dir = replace_dir_fn if replace_dir_fn is not None else os.replace
    _volume = volume_fn if volume_fn is not None else _volume_identity
    staging_dir = require_managed_containment(
        staging_dir, managed_root, must_exist=True)
    versioned_component_dir = require_managed_containment(
        versioned_component_dir, managed_root)
    pointer_path = require_managed_containment(pointer_path, managed_root)
    if not _owned_job(staging_dir, job_id, nonce):
        raise rc.ProvisionError(rc.PATH_OUTSIDE_ROOT,
                                "staging ownership marker mismatch")
    if _volume(staging_dir) != _volume(os.path.dirname(versioned_component_dir)):
        raise rc.ProvisionError(rc.APPLY_DISABLED,
                                "cross-volume promotion forbidden")
    if os.path.exists(versioned_component_dir):
        raise rc.ProvisionError(rc.APPLY_DISABLED, "immutable 버전 이미 존재(덮어쓰기 금지)")
    # 대상 부모(버전 저장소)만 준비 — 기존 버전은 건드리지 않는다. os.replace(dir)는 부모가 있어야 함.
    parent = os.path.dirname(versioned_component_dir)
    if parent:
        os.makedirs(parent, exist_ok=True)
    try:
        _rep_dir(staging_dir, versioned_component_dir)
    except OSError:
        # 이동 실패 → 검증된 소유 staging만 정리, 기존 active/버전 불변.
        cleanup_staging(staging_dir, managed_root, job_id, nonce)
        raise rc.ProvisionError(rc.APPLY_DISABLED, "staging 이동 실패 — 기존 active 보존")
    # Ownership metadata belongs to staging, not the immutable component.
    os.remove(os.path.join(versioned_component_dir, JOB_MARKER_FILE))
    write_pointer_atomic(pointer_path, active, replace_fn=replace_pointer_fn)
    return active
