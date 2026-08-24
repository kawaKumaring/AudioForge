# -*- coding: utf-8 -*-
"""Unresolved schema-v2 minimal-qwen manifest; no guessed acquisition data."""

from . import layout
from . import manifest as mf

_QWEN_REPO = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
_QWEN_REVISION = "5d83992436eae1d760afd27aff78a71d676296fc"
_QWEN_REQUIRED = [
    "config.json", "model.safetensors", "vocab.json", "merges.txt",
    "tokenizer_config.json", "speech_tokenizer/model.safetensors",
]
_ROFORMER_FILE = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
_MELBAND_FILE = "mel_band_roformer_kim_ft2_bleedless_unwa.ckpt"


def _unknown_license():
    return {
        "code": None, "weights": None, "data": None, "output": None,
        "notice": {"path": None, "sha256": None},
        "sbom": {"path": None, "sha256": None},
    }


def _unknown_artifact(filename=None, source_kind=None, revision=None):
    return {
        "sourceKind": source_kind, "url": None, "revision": revision,
        "filename": filename, "sha256": None,
        "compressedBytes": None, "installedBytes": None,
        "license": _unknown_license(),
    }


def _unknown_lock(locator):
    return {
        "format": "pip-requirements-hashes",
        "locator": {"path": locator, "sha256": None},
        "target": {"python": None, "platform": None, "abi": None},
        "resolver": {"name": None, "version": None},
        "closure": {"path": locator + ".closure.json", "sha256": None},
        "entries": [],
    }


def _files(paths):
    return [{"path": path, "sha256": None} for path in paths]


def build():
    components = [
        {"id": "bootstrap-python", "kind": "bootstrap", "targetRoot": "runtime",
         "version": "unresolved", "required": True, "dependsOn": [],
         "installPath": "bootstrap-python", "displayLabel": "Python 런타임",
         "artifact": _unknown_artifact("python-bootstrap.zip", "github-release")},
        {"id": "parent-runtime", "kind": "venv", "targetRoot": "runtime",
         "version": "unresolved", "required": True, "dependsOn": ["bootstrap-python"],
         "installPath": layout.RUNTIME_PARENT_VENV, "displayLabel": "AudioForge 실행 환경",
         "artifact": _unknown_artifact("parent-runtime.lock", "direct-https"),
         "lock": _unknown_lock("locks/parent-runtime.lock.json")},
        {"id": "ffmpeg", "kind": "tool", "targetRoot": "runtime",
         "version": "unresolved", "required": True, "dependsOn": [],
         "installPath": layout.RUNTIME_TOOLS + "/" + layout.RUNTIME_TOOLS_FFMPEG,
         "displayLabel": "ffmpeg", "artifact": _unknown_artifact("ffmpeg.zip", "github-release")},
        {"id": "cache-area", "kind": "cache", "targetRoot": "cache",
         "version": "1", "required": True, "dependsOn": [],
         "installPath": layout.CACHE_STAGING, "displayLabel": "다운로드 캐시"},
        {"id": "qwen-venv", "kind": "venv", "targetRoot": "runtime",
         "version": "unresolved", "required": True, "dependsOn": ["bootstrap-python"],
         "installPath": layout.RUNTIME_QWEN_VENV, "displayLabel": "Qwen TTS 환경",
         "artifact": _unknown_artifact("qwen-runtime.lock", "direct-https"),
         "lock": _unknown_lock("locks/qwen-runtime.lock.json")},
        {"id": "gptsovits-venv", "kind": "venv", "targetRoot": "runtime",
         "version": "unresolved", "required": False, "dependsOn": ["bootstrap-python"],
         "installPath": layout.RUNTIME_GPTSOVITS_VENV, "displayLabel": "GPT-SoVITS 환경",
         "artifact": _unknown_artifact("gptsovits-runtime.lock", "direct-https"),
         "lock": _unknown_lock("locks/gptsovits-runtime.lock.json")},
        {"id": "models.separator", "kind": "model", "targetRoot": "model",
         "version": "unresolved", "required": False, "dependsOn": [],
         "installPath": layout.SEPARATOR_MODELS, "displayLabel": "보컬 분리 모델",
         "repoId": None, "pinnedRevision": None,
         "requiredFiles": _files([
             layout.SEPARATOR_ENGINE_ROFORMER + "/" + _ROFORMER_FILE,
             layout.SEPARATOR_ENGINE_MELBAND + "/" + _MELBAND_FILE,
         ]), "artifact": _unknown_artifact("separator-models.snapshot", "huggingface-snapshot")},
        {"id": "models.qwen3", "kind": "model", "targetRoot": "model",
         "version": _QWEN_REVISION, "required": True, "dependsOn": ["qwen-venv"],
         "installPath": layout.QWEN_MODELS, "displayLabel": "Qwen3-TTS 모델",
         "repoId": _QWEN_REPO, "pinnedRevision": _QWEN_REVISION,
         "requiredFiles": _files(_QWEN_REQUIRED),
         "artifact": _unknown_artifact("qwen3-tts.snapshot", "huggingface-snapshot", _QWEN_REVISION)},
        {"id": "models.gptsovits", "kind": "model", "targetRoot": "model",
         "version": "unresolved", "required": False, "dependsOn": ["gptsovits-venv"],
         "installPath": layout.GPTSOVITS_MODELS, "displayLabel": "GPT-SoVITS 사전학습 모델",
         "repoId": "lj1995/GPT-SoVITS", "pinnedRevision": None, "requiredFiles": [],
         "artifact": _unknown_artifact("gptsovits.snapshot", "huggingface-snapshot")},
    ]
    return {
        "schemaVersion": mf.MANIFEST_SCHEMA_VERSION,
        "profile": mf.DEFAULT_PROFILE,
        "profiles": {mf.DEFAULT_PROFILE: {
            "componentIds": list(mf.MINIMAL_QWEN_COMPONENT_IDS),
            "excludedComponentIds": list(mf.MINIMAL_QWEN_EXCLUDED_IDS),
        }},
        "components": components,
    }
