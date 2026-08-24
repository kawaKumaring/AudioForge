# -*- coding: utf-8 -*-
"""provision.staging — staging/verify/atomic pointer 프리미티브(주입 경로에서만 동작).

PROVISIONER-PLAN §8. 이 단계에서 apply(다운로드/설치)는 비활성이므로 이 프리미티브들은
합성 tmp 디렉터리에서만 단위검증된다 — 다운로드/네트워크/pip 없음, 이미 존재하는 파일에 대한
checksum 검증 + immutable 이동 + 작은 pointer의 atomic replace만 수행한다.

원자성 계약(Windows 비어있지 않은 dir os.replace 의존 금지):
  - immutable `versioned_component_dir`에 설치(사전 미존재 필수 — 기존 버전 절대 덮어쓰지/삭제하지 않음).
  - 검증 완료 후 **작은 pointer 파일만** atomic replace(os.replace on file). dir을 replace하지 않는다.
  - 실패/cancel/disk full → staging만 제거, 기존 active pointer·기존 버전 불변.

checksum '계산'은 model_manifest(Python) 재사용. '해석'은 상위(state)·C.
"""

import json
import os

import model_manifest
from . import reason_codes as rc


# ── checksum 검증 ─────────────────────────────────────────────────────────────
def check_required_files(base_dir, required_files):
    """required_files=[{path, sha256}] 각각을 base_dir 기준으로 검사(예외 없이 결과 리스트 반환).
    반환 항목: {path, present, expectedChecksum, actualChecksum, reasonCode}.
    multi-file 모델에서 일부만 실패하는 상황을 상위가 집계할 수 있게 raise하지 않는다."""
    out = []
    for entry in required_files:
        rel = entry.get("path")
        expected = entry.get("sha256")
        abs_path = os.path.join(base_dir, rel)
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
def cleanup_staging(staging_dir):
    """staging 디렉터리만 제거(소유 가드는 상위 ownership에서). 부재면 no-op."""
    import shutil
    if staging_dir and os.path.isdir(staging_dir):
        shutil.rmtree(staging_dir, ignore_errors=True)


def promote(staging_dir, versioned_component_dir, pointer_path, active,
            replace_dir_fn=None, replace_pointer_fn=None):
    """검증된 staging_dir을 immutable versioned_component_dir로 이동한 뒤, 작은 pointer만 atomic 교체.
    - versioned_component_dir가 이미 존재하면 덮어쓰지 않는다(immutable) → 그대로 예외.
    - 디렉터리 이동 실패(disk full 등) → staging 제거, 기존 active/버전 불변 후 예외.
    - pointer 교체 실패 → 방금 만든 versioned dir은 그대로 두되(부분 산출물 아님, 검증 완료본),
      기존 active pointer는 불변. staging은 이미 이동됐으므로 제거 대상 아님.
    replace_dir_fn/replace_pointer_fn: 테스트 주입(disk full 시뮬레이션). 기본 os.replace.
    반환: {versionedDir 존재 여부는 노출 안 함} active(dict).
    NOTE: 실제 apply(설치)는 이 단계에서 호출되지 않는다 — 합성 tmp 검증 전용 프리미티브."""
    _rep_dir = replace_dir_fn if replace_dir_fn is not None else os.replace
    if os.path.exists(versioned_component_dir):
        raise rc.ProvisionError(rc.APPLY_DISABLED, "immutable 버전 이미 존재(덮어쓰기 금지)")
    # 대상 부모(버전 저장소)만 준비 — 기존 버전은 건드리지 않는다. os.replace(dir)는 부모가 있어야 함.
    parent = os.path.dirname(versioned_component_dir)
    if parent:
        os.makedirs(parent, exist_ok=True)
    try:
        _rep_dir(staging_dir, versioned_component_dir)
    except OSError:
        # 이동 실패 → staging만 정리, 기존 active/버전 불변.
        cleanup_staging(staging_dir)
        raise rc.ProvisionError(rc.APPLY_DISABLED, "staging 이동 실패 — 기존 active 보존")
    write_pointer_atomic(pointer_path, active, replace_fn=replace_pointer_fn)
    return active
