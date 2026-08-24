# -*- coding: utf-8 -*-
"""provision.manifest — component manifest 스키마 로더/검증(순수).

PROVISIONER-PLAN §6·§10. 각 component는 아래 형태이며, resolved 여부를 코드가 판정한다.
URL/checksum/license가 미상이면 **추정값 금지** → resolved=False → apply 차단(state.apply).

component(dict) 공통 필드:
  id            : str (고유)
  kind          : "bootstrap" | "venv" | "tool" | "model" | "cache"
  version       : str
  required      : bool
  dependsOn     : [id, ...]
  installPath   : str | None  (레이아웃 상대경로. 전체 절대경로 아님 — fingerprint·displayLabel용)
  displayLabel  : str         (renderer 표시용 비민감 라벨/basename)
  license       : {code, weights, data, output} | None  (구분 보관; None이면 미상)
  pythonCompat  : str | None
  cudaCompat    : str | None
  torchCompat   : str | None
  installReasonCode / verifyReasonCode : ReasonCode | None

model kind 추가 필드(HF snapshot 형태 — 단일 dir hash로 단순화 금지):
  repoId        : str
  pinnedRevision: str (commit)
  requiredFiles : [{path, sha256}, ...]   (파일별 digest)
  totalSize     : int   (바이트; 미상이면 None)

resolved 판정:
  - bootstrap: 항상 False(획득 방식 미결정 — §2).
  - model: repoId·pinnedRevision·requiredFiles(각 path+sha256)·totalSize·license 전부 있으면 True.
  - venv/tool/cache: license 있고 kind별 필수 필드가 채워졌으면 True. 아니면 False.
"""

from . import reason_codes as rc

KINDS = ("bootstrap", "venv", "tool", "model", "cache")

# manifest 스키마 버전(runtime 계약 SCHEMA_VERSION과는 별개 — provisioner manifest 전용).
MANIFEST_SCHEMA_VERSION = 1

_LICENSE_SLOTS = ("code", "weights", "data", "output")


def _nonempty_str(v):
    return isinstance(v, str) and len(v) > 0


def _valid_license(lic):
    """license는 {code,weights,data,output} 슬롯을 가진 dict. 각 슬롯은 비어있지 않은 문자열이거나
    'n/a'(해당 없음 명시). 슬롯이 None/누락이면 '미상' → license 미결정으로 본다."""
    if not isinstance(lic, dict):
        return False
    for slot in _LICENSE_SLOTS:
        val = lic.get(slot)
        if not _nonempty_str(val):
            return False
    return True


def _valid_required_files(files):
    if not isinstance(files, list) or len(files) == 0:
        return False
    for f in files:
        if not isinstance(f, dict):
            return False
        if not _nonempty_str(f.get("path")) or not _nonempty_str(f.get("sha256")):
            return False
    return True


def is_resolved(component):
    """component가 apply 가능한 만큼 확정됐는가(추정 없이). 미상 필드가 하나라도 있으면 False."""
    if not isinstance(component, dict):
        return False
    kind = component.get("kind")
    if kind == "bootstrap":
        return False  # §2: bootstrap python 획득 방식 미결정 — 항상 unresolved
    if not _valid_license(component.get("license")):
        return False
    if kind == "model":
        return (
            _nonempty_str(component.get("repoId"))
            and _nonempty_str(component.get("pinnedRevision"))
            and _valid_required_files(component.get("requiredFiles"))
            and isinstance(component.get("totalSize"), int)
            and component.get("totalSize") > 0
        )
    if kind in ("venv", "tool", "cache"):
        # 획득/설치 방식이 확정됐다는 신호로 installPath + version을 요구.
        return _nonempty_str(component.get("installPath")) and _nonempty_str(component.get("version"))
    return False


def unresolved_reason(component):
    """component가 unresolved인 이유 코드. resolved면 None."""
    if is_resolved(component):
        return None
    if component.get("kind") == "bootstrap":
        return rc.BOOTSTRAP_PYTHON_UNRESOLVED
    return rc.UNRESOLVED_COMPONENT


def validate_manifest(manifest):
    """manifest 구조 검증. 실패 시 ProvisionError. 성공 시 components 리스트 반환(입력 불변).
    검증: schemaVersion, components가 리스트, 각 component id 고유 + kind 유효 + dependsOn이 리스트."""
    if not isinstance(manifest, dict):
        raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, "manifest가 dict 아님")
    if manifest.get("schemaVersion") != MANIFEST_SCHEMA_VERSION:
        raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, "manifest schemaVersion 불일치")
    comps = manifest.get("components")
    if not isinstance(comps, list) or not comps:
        raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, "components 누락/빈 리스트")
    seen = set()
    for c in comps:
        if not isinstance(c, dict):
            raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, "component가 dict 아님")
        cid = c.get("id")
        if not _nonempty_str(cid):
            raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, "component id 누락")
        if cid in seen:
            raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, f"중복 component id: {cid}")
        seen.add(cid)
        if c.get("kind") not in KINDS:
            raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, f"알 수 없는 kind: {cid}")
        deps = c.get("dependsOn", [])
        if not isinstance(deps, list):
            raise rc.ProvisionError(rc.DEPENDENCY_MISSING, f"dependsOn이 리스트 아님: {cid}")
    return comps


def component_index(components):
    """id → component dict."""
    return {c["id"]: c for c in components}
