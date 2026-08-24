# -*- coding: utf-8 -*-
"""Managed provision manifest schema v2 (pure validation, no I/O).

Schema v2 closes v1's false-resolved gaps. Every installable component needs
an immutable artifact with sizes and audit evidence; venvs additionally need an
exact hashed dependency lock. Manifest paths are portable POSIX-relative paths.
"""

import re
from urllib.parse import urlsplit

from . import reason_codes as rc

KINDS = ("bootstrap", "venv", "tool", "model", "cache")
INSTALLABLE_KINDS = ("bootstrap", "venv", "tool", "model")
MANIFEST_SCHEMA_VERSION = 2
DEFAULT_PROFILE = "minimal-qwen"

_LICENSE_SLOTS = ("code", "weights", "data", "output")
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_LOCK_FORMATS = ("pip-requirements-hashes",)
_MUTABLE_REVISIONS = {"latest", "main", "master", "head", "tip", "stable"}


def _nonempty_str(value):
    return isinstance(value, str) and bool(value.strip())


def _positive_int(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _sha256(value):
    return isinstance(value, str) and _SHA256_RE.fullmatch(value) is not None


def _valid_license(license_info):
    return isinstance(license_info, dict) and all(
        _nonempty_str(license_info.get(slot)) for slot in _LICENSE_SLOTS
    )


def _portable_relative(path):
    """Return canonical relative path, or None for unsafe/non-canonical input."""
    if not _nonempty_str(path) or path != path.strip():
        return None
    if "\\" in path or path.startswith("/") or re.match(r"^[A-Za-z]:", path):
        return None
    parts = path.split("/")
    if any(
        part in ("", ".", "..") or "\x00" in part or ":" in part
        or part != part.strip() or part.endswith(".")
        for part in parts
    ):
        return None
    return "/".join(parts)


def _artifact_valid(artifact):
    if not isinstance(artifact, dict):
        return False
    url = artifact.get("url")
    if not _nonempty_str(url):
        return False
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        return False
    revision = artifact.get("revision")
    if not _nonempty_str(revision) or revision.strip().lower() in _MUTABLE_REVISIONS:
        return False
    filename = artifact.get("filename")
    if _portable_relative(filename) is None or "/" in filename:
        return False
    return (
        _sha256(artifact.get("sha256"))
        and _positive_int(artifact.get("compressedBytes"))
        and _positive_int(artifact.get("installedBytes"))
        and _valid_license(artifact.get("license"))
        and _sha256(artifact.get("noticeSha256"))
        and _sha256(artifact.get("sbomSha256"))
    )


def _lock_valid(lock):
    """Exact pip lock: lock document and every selected artifact are hashed."""
    if not isinstance(lock, dict) or lock.get("format") not in _LOCK_FORMATS:
        return False
    if not _sha256(lock.get("sha256")):
        return False
    entries = lock.get("entries")
    if not isinstance(entries, list) or not entries:
        return False
    names = set()
    for entry in entries:
        if not isinstance(entry, dict):
            return False
        name, version, filename = entry.get("name"), entry.get("version"), entry.get("filename")
        if not _nonempty_str(name) or name.lower() in names:
            return False
        if not _nonempty_str(version) or any(ch in version for ch in "<>=!~* ,@"):
            return False
        if _portable_relative(filename) is None or "/" in filename:
            return False
        if not _sha256(entry.get("sha256")):
            return False
        names.add(name.lower())
    return True


def _required_files_valid(files):
    if not isinstance(files, list) or not files:
        return False
    seen = set()
    for required in files:
        if not isinstance(required, dict):
            return False
        path = _portable_relative(required.get("path"))
        key = path.casefold() if path is not None else None
        if path is None or key in seen or not _sha256(required.get("sha256")):
            return False
        seen.add(key)
    return True


def is_resolved(component):
    """Whether a component has enough immutable evidence for a future apply."""
    if not isinstance(component, dict):
        return False
    kind = component.get("kind")
    if kind == "cache":
        return _nonempty_str(component.get("version")) and _portable_relative(
            component.get("installPath")
        ) is not None
    if kind not in INSTALLABLE_KINDS:
        return False
    if _portable_relative(component.get("installPath")) is None:
        return False
    if not _artifact_valid(component.get("artifact")):
        return False
    if kind == "venv" and not _lock_valid(component.get("lock")):
        return False
    if kind == "model" and not _required_files_valid(component.get("requiredFiles")):
        return False
    return True


def unresolved_reason(component):
    if is_resolved(component):
        return None
    if isinstance(component, dict) and component.get("kind") == "bootstrap":
        return rc.BOOTSTRAP_PYTHON_UNRESOLVED
    return rc.UNRESOLVED_COMPONENT


def _validate_profiles(manifest, components):
    component_ids = {component["id"] for component in components}
    profile, profiles = manifest.get("profile"), manifest.get("profiles")
    if profile != DEFAULT_PROFILE or not isinstance(profiles, dict):
        raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, "minimal-qwen 기본 profile 누락")
    spec = profiles.get(profile)
    if not isinstance(spec, dict):
        raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, "기본 profile 정의 누락")
    included, excluded = spec.get("componentIds"), spec.get("excludedComponentIds")
    if not isinstance(included, list) or not isinstance(excluded, list):
        raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, "profile component 목록 누락")
    if len(set(included)) != len(included) or len(set(excluded)) != len(excluded):
        raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, "profile component 중복")
    if set(included) & set(excluded):
        raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, "profile include/exclude 충돌")
    unknown = (set(included) | set(excluded)) - component_ids
    if unknown:
        raise rc.ProvisionError(rc.DEPENDENCY_MISSING, f"profile 대상 없음: {sorted(unknown)[0]}")


def validate_manifest(manifest):
    """Validate schema and path/DAG safety; return components without mutation."""
    if not isinstance(manifest, dict):
        raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, "manifest가 dict 아님")
    if manifest.get("schemaVersion") != MANIFEST_SCHEMA_VERSION:
        raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, "manifest schemaVersion 불일치")
    components = manifest.get("components")
    if not isinstance(components, list) or not components:
        raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, "components 누락/빈 리스트")

    ids, install_paths = set(), set()
    for component in components:
        if not isinstance(component, dict):
            raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, "component가 dict 아님")
        cid = component.get("id")
        if not _nonempty_str(cid) or cid in ids:
            raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, f"component id 누락/중복: {cid}")
        ids.add(cid)
        if component.get("kind") not in KINDS:
            raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, f"알 수 없는 kind: {cid}")
        dependencies = component.get("dependsOn", [])
        if not isinstance(dependencies, list) or any(not _nonempty_str(d) for d in dependencies):
            raise rc.ProvisionError(rc.DEPENDENCY_MISSING, f"dependsOn이 문자열 리스트 아님: {cid}")
        if len(set(dependencies)) != len(dependencies):
            raise rc.ProvisionError(rc.DEPENDENCY_MISSING, f"dependsOn 중복: {cid}")
        install_path = _portable_relative(component.get("installPath"))
        if install_path is None:
            raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, f"installPath가 안전한 상대경로 아님: {cid}")
        folded = install_path.casefold()
        overlap = next((existing for existing in install_paths
                        if folded == existing.casefold()
                        or folded.startswith(existing.casefold() + "/")
                        or existing.casefold().startswith(folded + "/")), None)
        if overlap is not None:
            raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT,
                                    f"중복/중첩 installPath: {install_path} ↔ {overlap}")
        install_paths.add(install_path)

        required_files = component.get("requiredFiles")
        if required_files is not None:
            paths = []
            if not isinstance(required_files, list):
                raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, f"requiredFiles가 리스트 아님: {cid}")
            for required in required_files:
                path = required.get("path") if isinstance(required, dict) else None
                canonical = _portable_relative(path)
                folded_path = canonical.casefold() if canonical is not None else None
                if canonical is None or folded_path in paths:
                    raise rc.ProvisionError(rc.UNRESOLVED_COMPONENT, f"requiredFiles path 오류/중복: {cid}")
                paths.append(folded_path)

    _validate_profiles(manifest, components)
    return components


def component_index(components):
    return {component["id"]: component for component in components}
