# -*- coding: utf-8 -*-
"""provision.dag — component 의존 그래프(순수 데이터 + 위상정렬).

PROVISIONER-PLAN §5. 노드는 manifest component, 엣지는 dependsOn. 코드가 위상정렬하고
누락 의존/순환을 검출한다. 엔진별 선택은 select_components로 필수+선택을 편다.

부작용 0 — 순수 그래프 알고리즘만.
"""

from . import reason_codes as rc
from . import manifest as mf


def missing_dependencies(components):
    """dependsOn이 가리키는 id 중 manifest에 없는 것들을 (component_id, missing_dep) 리스트로."""
    ids = {c["id"] for c in components}
    out = []
    for c in components:
        for d in c.get("dependsOn", []):
            if d not in ids:
                out.append((c["id"], d))
    return out


def topo_sort(components):
    """dependsOn을 만족하는 위상정렬 순서(설치 순서). 안정 정렬(입력 순서 tiebreak).
    누락 의존 → DEPENDENCY_MISSING. 순환 → DAG_CYCLE."""
    miss = missing_dependencies(components)
    if miss:
        cid, dep = miss[0]
        raise rc.ProvisionError(rc.DEPENDENCY_MISSING, f"{cid} → {dep}")

    index = mf.component_index(components)
    order_hint = {c["id"]: i for i, c in enumerate(components)}
    visited = {}  # id → 0(진행중) | 1(완료)
    result = []

    def visit(cid, stack):
        state = visited.get(cid)
        if state == 1:
            return
        if state == 0:
            raise rc.ProvisionError(rc.DAG_CYCLE, " → ".join(stack + [cid]))
        visited[cid] = 0
        deps = sorted(index[cid].get("dependsOn", []), key=lambda d: order_hint[d])
        for d in deps:
            visit(d, stack + [cid])
        visited[cid] = 1
        result.append(cid)

    for c in sorted(components, key=lambda c: order_hint[c["id"]]):
        visit(c["id"], [])
    return [index[cid] for cid in result]


def required_ids(components):
    """required=True인 component id 집합."""
    return {c["id"] for c in components if c.get("required")}


def _closure(index, roots):
    """roots에서 dependsOn을 따라 도달하는 모든 id(자신 포함) 집합."""
    seen = set()
    stack = list(roots)
    while stack:
        cid = stack.pop()
        if cid in seen or cid not in index:
            continue
        seen.add(cid)
        stack.extend(index[cid].get("dependsOn", []))
    return seen


def select_components(components, engine_ids=()):
    """설치 대상 선택: 모든 required + 요청된 engine_ids의 의존 폐포. 위상정렬 순서로 반환.
    engine_ids는 선택 component id(예: models.qwen3, qwen-venv). 존재하지 않는 id는 무시하지 않고
    DEPENDENCY_MISSING로 표면화(조용한 스킵 금지)."""
    index = mf.component_index(components)
    for eid in engine_ids:
        if eid not in index:
            raise rc.ProvisionError(rc.DEPENDENCY_MISSING, f"선택 대상 없음: {eid}")
    roots = set(required_ids(components)) | set(engine_ids)
    wanted = _closure(index, roots)
    subset = [c for c in components if c["id"] in wanted]
    return topo_sort(subset)


def profile_component_ids(manifest, profile_name=None):
    """Return the explicit optional ids for a schema-v2 profile.

    ``validate_manifest`` is the authority for profile shape and id existence.
    Keeping the profile choice separate from ``select_components`` preserves the
    old explicit-engine API while preventing callers from silently inventing a
    profile or including components listed as excluded.
    """
    mf.validate_manifest(manifest)
    selected = profile_name or manifest["profile"]
    profiles = manifest["profiles"]
    if selected not in profiles:
        raise rc.ProvisionError(rc.DEPENDENCY_MISSING, f"profile 없음: {selected}")
    spec = profiles[selected]
    included = list(spec["componentIds"])
    excluded = set(spec["excludedComponentIds"])
    if set(included) & excluded:
        raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, "profile include/exclude 충돌")
    return included


def select_profile(manifest, profile_name=None, extra_ids=()):
    """Select required + profile components + explicitly requested extras."""
    components = mf.validate_manifest(manifest)
    profile_ids = profile_component_ids(manifest, profile_name)
    return select_components(components, engine_ids=tuple(profile_ids) + tuple(extra_ids))
