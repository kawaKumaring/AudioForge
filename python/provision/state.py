# -*- coding: utf-8 -*-
"""provision.state — plan/dry-run/verify state machine(순수). apply는 이 단계에서 차단.

PROVISIONER-PLAN §7·§9. plan/dry-run은 파일·네트워크 변경 0. verify는 주입된 evidence로 상태만
해석(설치 없음). apply는 승인 토큰(plan fingerprint) 검증 후에도 실제 설치 로직 미구현이라
APPLY_DISABLED로 차단한다(unresolved/bootstrap이 있으면 그 사유가 우선).

plan 결과는 renderer-safe: **전체 절대경로 0**. installPath는 레이아웃 상대경로, displayLabel은
비민감 라벨/basename, reasonCode는 계약 ReasonCode만. 여기서 root 절대경로를 담지 않는다.
"""

from . import dag
from . import fingerprint as fp
from . import manifest as mf
from . import reason_codes as rc

PLAN_SCHEMA_VERSION = 1


def _sizes(component):
    return {
        "compressed": component.get("compressedSize"),
        "installed": component.get("installedSize"),
        "total": component.get("totalSize"),
    }


def _component_view(component):
    """renderer-safe component 요약(절대경로 0). fingerprint 입력과 표시 둘 다에 쓰는 안정 형태."""
    resolved = mf.is_resolved(component)
    view = {
        "id": component["id"],
        "kind": component["kind"],
        "version": component.get("version"),
        "required": bool(component.get("required")),
        "dependsOn": list(component.get("dependsOn", [])),
        "installPath": component.get("installPath"),  # 레이아웃 상대경로(절대경로 아님)
        "displayLabel": component.get("displayLabel"),
        "license": component.get("license"),
        "resolved": resolved,
        "reasonCode": mf.unresolved_reason(component),
        "sizes": _sizes(component),
    }
    if component.get("kind") == "model":
        view["repoId"] = component.get("repoId")
        view["pinnedRevision"] = component.get("pinnedRevision")
        # requiredFiles는 상대 path + sha256(비민감). 절대경로 아님.
        view["requiredFiles"] = [
            {"path": f.get("path"), "sha256": f.get("sha256")}
            for f in component.get("requiredFiles", [])
        ]
    return view


def _fingerprint_payload(views):
    """apply 승인 대상이 되는 canonical 입력. mode·displayLabel 등 표시 전용/휘발 필드는 제외하고
    '무엇을 설치하는가'만 담는다 → manifest/경로/버전/checksum 변경 시 fingerprint가 바뀐다."""
    payload = []
    for v in views:
        item = {
            "id": v["id"], "kind": v["kind"], "version": v["version"],
            "required": v["required"], "dependsOn": v["dependsOn"],
            "installPath": v["installPath"], "license": v["license"],
            "resolved": v["resolved"],
        }
        if v["kind"] == "model":
            item["repoId"] = v.get("repoId")
            item["pinnedRevision"] = v.get("pinnedRevision")
            item["requiredFiles"] = v.get("requiredFiles", [])
            item["totalSize"] = v["sizes"]["total"]
        payload.append(item)
    return payload


def _make(manifest, engine_ids, mode):
    components = mf.validate_manifest(manifest)
    ordered = dag.select_components(components, engine_ids=tuple(engine_ids))
    views = [_component_view(c) for c in ordered]
    blocking = []
    for v in views:
        if not v["resolved"] and v["reasonCode"] not in blocking:
            blocking.append(v["reasonCode"])
    payload = _fingerprint_payload(views)
    return {
        "schemaVersion": PLAN_SCHEMA_VERSION,
        "mode": mode,
        "components": views,
        "resolvedAll": all(v["resolved"] for v in views),
        "blockingReasons": blocking,
        "planFingerprint": fp.fingerprint(payload),
    }


def plan(manifest, engine_ids=()):
    """설치 계획 산출 — 파일/네트워크 변경 0. 항상 실행 가능."""
    return _make(manifest, engine_ids, "plan")


def dry_run(manifest, engine_ids=()):
    """dry-run — plan과 동일 내용(같은 fingerprint), mode만 다름. 파일/네트워크 변경 0."""
    return _make(manifest, engine_ids, "dry-run")


def verify(manifest, engine_ids=(), evidence_by_id=None):
    """설치 없이 상태 검사. evidence_by_id: {component_id: {present, reasonCode, ...}} 주입.
    (checksum '계산'은 상위가 model_manifest/staging으로 수행해 주입 — 이 함수는 순수 해석.)
    반환: 각 component의 resolved/present/reasonCode 요약(renderer-safe)."""
    evidence_by_id = evidence_by_id or {}
    components = mf.validate_manifest(manifest)
    ordered = dag.select_components(components, engine_ids=tuple(engine_ids))
    out = []
    for c in ordered:
        v = _component_view(c)
        ev = evidence_by_id.get(c["id"]) or {}
        present = bool(ev.get("present"))
        reason = ev.get("reasonCode")
        if reason is None and not v["resolved"]:
            reason = v["reasonCode"]
        out.append({
            "id": v["id"], "kind": v["kind"], "displayLabel": v["displayLabel"],
            "resolved": v["resolved"], "present": present, "reasonCode": reason,
        })
    return {"schemaVersion": PLAN_SCHEMA_VERSION, "mode": "verify", "components": out}


def apply(plan_result, approval_token):
    """실제 설치 — 이번 단계 **비활성**. 항상 예외로 차단하되 사유는 명확히:
      1) approval_token이 plan_result.planFingerprint와 다르면 PLAN_FINGERPRINT_MISMATCH
         (manifest/경로/버전 변경으로 과거 승인이 무효화된 경우 포함).
      2) blockingReasons(unresolved/bootstrap)가 있으면 그 첫 사유(BOOTSTRAP_PYTHON_UNRESOLVED
         우선, 그 외 UNRESOLVED_COMPONENT).
      3) 위를 모두 통과해도 설치 로직 미구현 → APPLY_DISABLED.
    실제 다운로드/설치/venv 생성 코드는 존재하지 않는다(STOP 표 승인 전)."""
    if not isinstance(plan_result, dict) or "planFingerprint" not in plan_result:
        raise rc.ProvisionError(rc.APPLY_DISABLED, "plan 없음")
    expected = plan_result.get("planFingerprint")
    if not fp.matches_token(approval_token, expected):
        raise rc.ProvisionError(rc.PLAN_FINGERPRINT_MISMATCH, "승인 토큰 불일치")
    blocking = plan_result.get("blockingReasons") or []
    if rc.BOOTSTRAP_PYTHON_UNRESOLVED in blocking:
        raise rc.ProvisionError(rc.BOOTSTRAP_PYTHON_UNRESOLVED, "bootstrap python 미결정")
    if blocking:
        raise rc.ProvisionError(blocking[0], "unresolved component")
    raise rc.ProvisionError(rc.APPLY_DISABLED, "설치 로직 미구현(STOP 표 승인 전)")
