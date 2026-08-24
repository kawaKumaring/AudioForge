# -*- coding: utf-8 -*-
"""Fail-closed managed provision manifest schema v2 (pure; no I/O)."""

import re
from urllib.parse import urlsplit

from . import reason_codes as rc

KINDS = ("bootstrap", "venv", "tool", "model", "cache")
INSTALLABLE_KINDS = ("bootstrap", "venv", "tool", "model")
TARGET_ROOTS = ("runtime", "model", "cache")
KIND_TARGET_ROOT = {
    "bootstrap": "runtime", "venv": "runtime", "tool": "runtime",
    "model": "model", "cache": "cache",
}
SOURCE_KINDS = ("github-release", "huggingface-snapshot", "pypi-file", "direct-https")
MANIFEST_SCHEMA_VERSION = 2
DEFAULT_PROFILE = "minimal-qwen"
MINIMAL_QWEN_COMPONENT_IDS = (
    "bootstrap-python", "parent-runtime", "ffmpeg", "cache-area",
    "qwen-venv", "models.qwen3",
)
MINIMAL_QWEN_EXCLUDED_IDS = (
    "gptsovits-venv", "models.gptsovits", "models.separator",
)

_LICENSE_SLOTS = ("code", "weights", "data", "output")
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_HF_REV_RE = re.compile(r"^[0-9a-fA-F]{40}$")
_IMMUTABLE_TAG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_EXACT_VERSION_RE = re.compile(r"^[0-9]+(?:[A-Za-z0-9._+-]*[A-Za-z0-9])?$")
_MUTABLE_REVISIONS = {"latest", "main", "master", "head", "tip", "stable", "nightly"}
_WINDOWS_RESERVED = {"con", "prn", "aux", "nul", "clock$"} | {
    f"{base}{number}" for base in ("com", "lpt") for number in range(1, 10)
}
_WINDOWS_BAD_CHARS = set('<>:"|?*')


def _error(code, message):
    raise rc.ProvisionError(code, message)


def _nonempty(value):
    return isinstance(value, str) and value == value.strip() and bool(value)


def _positive_int(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _sha256(value):
    return isinstance(value, str) and _SHA256_RE.fullmatch(value) is not None


def pep503_normalize(name):
    if not _nonempty(name):
        return None
    normalized = re.sub(r"[-_.]+", "-", name).lower()
    return normalized if re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", normalized) else None


def _portable_relative(path):
    if not _nonempty(path) or "\\" in path or path.startswith("/") or re.match(r"^[A-Za-z]:", path):
        return None
    parts = path.split("/")
    for part in parts:
        stem = part.split(".", 1)[0].casefold()
        if (part in ("", ".", "..") or part != part.strip() or part.endswith((".", " "))
                or any(ord(ch) < 32 or ch in _WINDOWS_BAD_CHARS for ch in part)
                or stem in _WINDOWS_RESERVED):
            return None
    return "/".join(parts)


def _path_key(path):
    canonical = _portable_relative(path)
    return canonical.casefold() if canonical is not None else None


def _paths_overlap(left, right):
    a, b = left.casefold(), right.casefold()
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


def _evidence_valid(value):
    return isinstance(value, dict) and _portable_relative(value.get("path")) is not None and _sha256(value.get("sha256"))


def _license_valid(value):
    return (isinstance(value, dict)
            and all(_nonempty(value.get(slot)) for slot in _LICENSE_SLOTS)
            and _evidence_valid(value.get("notice"))
            and _evidence_valid(value.get("sbom")))


def _url_revision_valid(source_kind, url, revision):
    if source_kind not in SOURCE_KINDS or not _nonempty(url) or not _nonempty(revision):
        return False
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password
            or parsed.query or parsed.fragment):
        return False
    if revision.casefold() in _MUTABLE_REVISIONS:
        return False
    if source_kind == "huggingface-snapshot":
        return _HF_REV_RE.fullmatch(revision) is not None
    if source_kind == "pypi-file":
        return _EXACT_VERSION_RE.fullmatch(revision) is not None
    return _IMMUTABLE_TAG_RE.fullmatch(revision) is not None


def _artifact_valid(artifact):
    if not isinstance(artifact, dict):
        return False
    filename = artifact.get("filename")
    return (
        _url_revision_valid(artifact.get("sourceKind"), artifact.get("url"), artifact.get("revision"))
        and _portable_relative(filename) is not None and "/" not in filename
        and _sha256(artifact.get("sha256"))
        and _positive_int(artifact.get("compressedBytes"))
        and _positive_int(artifact.get("installedBytes"))
        and _license_valid(artifact.get("license"))
    )


def _filename_binds_package(filename, normalized_name, version):
    if _portable_relative(filename) is None or "/" in filename:
        return False
    normalized_file = filename.casefold().replace("_", "-")
    normalized_version = version.casefold().replace("_", "-")
    return normalized_file.startswith(f"{normalized_name}-{normalized_version}")


def _lock_entry_valid(entry):
    if not isinstance(entry, dict):
        return False
    normalized = pep503_normalize(entry.get("name"))
    version = entry.get("version")
    return (
        normalized is not None and entry.get("normalizedName") == normalized
        and _nonempty(version) and _EXACT_VERSION_RE.fullmatch(version) is not None
        and _url_revision_valid(entry.get("sourceKind"), entry.get("url"), entry.get("revision"))
        and entry.get("revision") == version
        and _filename_binds_package(entry.get("filename"), normalized, version)
        and _sha256(entry.get("sha256"))
        and _license_valid(entry.get("license"))
    )


def _lock_valid(lock):
    if not isinstance(lock, dict) or lock.get("format") != "pip-requirements-hashes":
        return False
    if not _evidence_valid(lock.get("locator")) or not _evidence_valid(lock.get("closure")):
        return False
    target, resolver = lock.get("target"), lock.get("resolver")
    if not isinstance(target, dict) or not all(_nonempty(target.get(k)) for k in ("python", "platform", "abi")):
        return False
    if not isinstance(resolver, dict) or not all(_nonempty(resolver.get(k)) for k in ("name", "version")):
        return False
    entries = lock.get("entries")
    if not isinstance(entries, list) or not entries:
        return False
    names = set()
    for entry in entries:
        if not _lock_entry_valid(entry):
            return False
        name = entry["normalizedName"]
        if name in names:
            return False
        names.add(name)
    return True


def _required_files_valid(files):
    if not isinstance(files, list) or not files:
        return False
    paths = []
    for item in files:
        if not isinstance(item, dict) or not _sha256(item.get("sha256")):
            return False
        path = _portable_relative(item.get("path"))
        if path is None or any(_paths_overlap(path, prior) for prior in paths):
            return False
        paths.append(path)
    return True


def is_resolved(component):
    if not isinstance(component, dict):
        return False
    kind, version = component.get("kind"), component.get("version")
    if kind not in KINDS or component.get("targetRoot") != KIND_TARGET_ROOT[kind]:
        return False
    if _portable_relative(component.get("installPath")) is None or not _nonempty(version) or version == "unresolved":
        return False
    if kind == "cache":
        return True
    artifact = component.get("artifact")
    if not _artifact_valid(artifact) or artifact.get("revision") != version:
        return False
    if kind == "venv" and not _lock_valid(component.get("lock")):
        return False
    if kind == "model":
        return (_nonempty(component.get("repoId"))
                and _nonempty(component.get("pinnedRevision"))
                and component.get("pinnedRevision") == version == artifact.get("revision")
                and _required_files_valid(component.get("requiredFiles")))
    return True


def unresolved_reason(component):
    if is_resolved(component):
        return None
    if isinstance(component, dict) and component.get("kind") == "bootstrap":
        return rc.BOOTSTRAP_PYTHON_UNRESOLVED
    return rc.UNRESOLVED_COMPONENT


def _string_list(value, label):
    if not isinstance(value, list) or any(not _nonempty(item) for item in value):
        _error(rc.UNRESOLVED_COMPONENT, f"{label} 문자열 리스트 아님")
    if len({item.casefold() for item in value}) != len(value):
        _error(rc.UNRESOLVED_COMPONENT, f"{label} 중복")
    return value


def _validate_profile(manifest, components):
    if manifest.get("profile") != DEFAULT_PROFILE or not isinstance(manifest.get("profiles"), dict):
        _error(rc.UNRESOLVED_COMPONENT, "minimal-qwen 기본 profile 누락")
    profiles = manifest["profiles"]
    if set(profiles) != {DEFAULT_PROFILE} or not isinstance(profiles[DEFAULT_PROFILE], dict):
        _error(rc.UNRESOLVED_COMPONENT, "지원 profile 집합 불일치")
    spec = profiles[DEFAULT_PROFILE]
    included = _string_list(spec.get("componentIds"), "profile componentIds")
    excluded = _string_list(spec.get("excludedComponentIds"), "profile excludedComponentIds")
    if tuple(included) != MINIMAL_QWEN_COMPONENT_IDS or tuple(excluded) != MINIMAL_QWEN_EXCLUDED_IDS:
        _error(rc.UNRESOLVED_COMPONENT, "minimal-qwen exact component 집합 불일치")
    ids = {component["id"] for component in components}
    unknown = (set(included) | set(excluded)) - ids
    if unknown:
        _error(rc.DEPENDENCY_MISSING, f"profile 대상 없음: {sorted(unknown)[0]}")
    if any(not next(c for c in components if c["id"] == cid).get("required") for cid in included):
        _error(rc.UNRESOLVED_COMPONENT, "profile 포함 component가 required 아님")
    if any(next(c for c in components if c["id"] == cid).get("required") for cid in excluded):
        _error(rc.UNRESOLVED_COMPONENT, "profile 제외 component가 required임")


def _nullable(value, typ):
    return value is None or isinstance(value, typ)


def _validate_component_shape(component, cid, kind):
    """Reject malformed schema types while allowing explicit unresolved nulls."""
    if not _nullable(component.get("version"), str) or not isinstance(component.get("required"), bool):
        _error(rc.UNRESOLVED_COMPONENT, f"version/required type 오류: {cid}")
    if not _nullable(component.get("displayLabel"), str):
        _error(rc.UNRESOLVED_COMPONENT, f"displayLabel type 오류: {cid}")
    if kind in INSTALLABLE_KINDS:
        artifact = component.get("artifact")
        if not isinstance(artifact, dict):
            _error(rc.UNRESOLVED_COMPONENT, f"artifact type 오류: {cid}")
        scalar = {"sourceKind": str, "url": str, "revision": str, "filename": str,
                  "sha256": str, "compressedBytes": int, "installedBytes": int}
        if any(not _nullable(artifact.get(key), typ) for key, typ in scalar.items()):
            _error(rc.UNRESOLVED_COMPONENT, f"artifact field type 오류: {cid}")
        license_info = artifact.get("license")
        if not isinstance(license_info, dict):
            _error(rc.UNRESOLVED_COMPONENT, f"license type 오류: {cid}")
        if any(not _nullable(license_info.get(key), str) for key in _LICENSE_SLOTS):
            _error(rc.UNRESOLVED_COMPONENT, f"license field type 오류: {cid}")
        for key in ("notice", "sbom"):
            evidence = license_info.get(key)
            if not isinstance(evidence, dict) or any(
                    not _nullable(evidence.get(field), str) for field in ("path", "sha256")):
                _error(rc.UNRESOLVED_COMPONENT, f"license evidence type 오류: {cid}")
    if kind == "venv" and not isinstance(component.get("lock"), dict):
        _error(rc.UNRESOLVED_COMPONENT, f"lock type 오류: {cid}")
    if kind == "model":
        if not _nullable(component.get("repoId"), str) or not _nullable(component.get("pinnedRevision"), str):
            _error(rc.UNRESOLVED_COMPONENT, f"model binding type 오류: {cid}")


def validate_manifest(manifest):
    """Validate every schema type and path fail-closed as ProvisionError."""
    try:
        if not isinstance(manifest, dict) or manifest.get("schemaVersion") != MANIFEST_SCHEMA_VERSION:
            _error(rc.UNRESOLVED_COMPONENT, "manifest/schemaVersion 불일치")
        components = manifest.get("components")
        if not isinstance(components, list) or not components:
            _error(rc.UNRESOLVED_COMPONENT, "components 누락/빈 리스트")
        ids, paths_by_root = set(), {root: [] for root in TARGET_ROOTS}
        for component in components:
            if not isinstance(component, dict):
                _error(rc.UNRESOLVED_COMPONENT, "component가 dict 아님")
            cid = component.get("id")
            if not _nonempty(cid) or cid.casefold() in ids:
                _error(rc.UNRESOLVED_COMPONENT, f"component id 누락/중복: {cid}")
            ids.add(cid.casefold())
            kind, target = component.get("kind"), component.get("targetRoot")
            if kind not in KINDS or target not in TARGET_ROOTS or target != KIND_TARGET_ROOT.get(kind):
                _error(rc.UNRESOLVED_COMPONENT, f"kind/targetRoot 불일치: {cid}")
            _validate_component_shape(component, cid, kind)
            deps = _string_list(component.get("dependsOn", []), f"dependsOn:{cid}")
            install_path = _portable_relative(component.get("installPath"))
            if install_path is None or any(_paths_overlap(install_path, prior) for prior in paths_by_root[target]):
                _error(rc.UNRESOLVED_COMPONENT, f"installPath 오류/중첩: {cid}")
            paths_by_root[target].append(install_path)
            required_files = component.get("requiredFiles")
            if required_files is not None:
                if not isinstance(required_files, list):
                    _error(rc.UNRESOLVED_COMPONENT, f"requiredFiles 리스트 아님: {cid}")
                file_paths = []
                for item in required_files:
                    path = item.get("path") if isinstance(item, dict) else None
                    canonical = _portable_relative(path)
                    if canonical is None or any(_paths_overlap(canonical, prior) for prior in file_paths):
                        _error(rc.UNRESOLVED_COMPONENT, f"requiredFiles path 오류/중첩: {cid}")
                    file_paths.append(canonical)
        _validate_profile(manifest, components)
        return components
    except rc.ProvisionError:
        raise
    except Exception:
        _error(rc.UNRESOLVED_COMPONENT, "manifest type 오류")


def component_index(components):
    return {component["id"]: component for component in components}
