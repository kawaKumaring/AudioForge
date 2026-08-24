# -*- coding: utf-8 -*-
"""Default schema-v2 manifest (pure unresolved data; apply remains disabled).

The default profile is deliberately minimal-qwen. GPT-SoVITS and separator
components remain represented for planning, but are explicitly excluded and not
required. Unknown immutable metadata stays ``None``; no guessed URL/hash/license
can accidentally make a component resolved.
"""

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
_GPTSOVITS_REPO = "lj1995/GPT-SoVITS"


def _unknown_artifact(filename=None, revision=None):
    return {
        "url": None,
        "revision": revision,
        "filename": filename,
        "sha256": None,
        "compressedBytes": None,
        "installedBytes": None,
        "license": None,
        "noticeSha256": None,
        "sbomSha256": None,
    }


def _unknown_lock():
    return {"format": "pip-requirements-hashes", "sha256": None, "entries": []}


def _unresolved_files(paths):
    return [{"path": path, "sha256": None} for path in paths]


def build():
    components = [
        {
            "id": "bootstrap-python", "kind": "bootstrap", "version": "unresolved",
            "required": True, "dependsOn": [], "installPath": "bootstrap-python",
            "displayLabel": "Python 런타임", "license": None,
            "artifact": _unknown_artifact("python-bootstrap.zip"),
        },
        {
            "id": "parent-runtime", "kind": "venv", "version": "unresolved",
            "required": True, "dependsOn": ["bootstrap-python"],
            "installPath": layout.RUNTIME_PARENT_VENV, "displayLabel": "AudioForge 실행 환경",
            "license": None, "artifact": _unknown_artifact("parent-runtime.lock"),
            "lock": _unknown_lock(),
        },
        {
            "id": "ffmpeg", "kind": "tool", "version": "unresolved",
            "required": True, "dependsOn": [],
            "installPath": layout.RUNTIME_TOOLS + "/" + layout.RUNTIME_TOOLS_FFMPEG,
            "displayLabel": "ffmpeg", "license": None,
            "artifact": _unknown_artifact("ffmpeg.zip"),
        },
        {
            "id": "cache-area", "kind": "cache", "version": "1",
            "required": True, "dependsOn": [], "installPath": layout.CACHE_STAGING,
            "displayLabel": "다운로드 캐시",
            "license": {"code": "n/a", "weights": "n/a", "data": "n/a", "output": "n/a"},
        },
        {
            "id": "qwen-venv", "kind": "venv", "version": "unresolved",
            "required": True, "dependsOn": ["bootstrap-python"],
            "installPath": layout.RUNTIME_QWEN_VENV, "displayLabel": "Qwen TTS 환경",
            "license": None, "artifact": _unknown_artifact("qwen-runtime.lock"),
            "lock": _unknown_lock(),
        },
        {
            "id": "gptsovits-venv", "kind": "venv", "version": "unresolved",
            "required": False, "dependsOn": ["bootstrap-python"],
            "installPath": layout.RUNTIME_GPTSOVITS_VENV, "displayLabel": "GPT-SoVITS 환경",
            "license": None, "artifact": _unknown_artifact("gptsovits-runtime.lock"),
            "lock": _unknown_lock(),
        },
        {
            "id": "models.separator", "kind": "model", "version": "unresolved",
            "required": False, "dependsOn": [], "installPath": layout.SEPARATOR_MODELS,
            "displayLabel": "보컬 분리 모델", "repoId": None, "pinnedRevision": None,
            "requiredFiles": _unresolved_files([
                layout.SEPARATOR_ENGINE_ROFORMER + "/" + _ROFORMER_FILE,
                layout.SEPARATOR_ENGINE_MELBAND + "/" + _MELBAND_FILE,
            ]),
            "license": None, "artifact": _unknown_artifact("separator-models.tar.zst"),
        },
        {
            "id": "models.qwen3", "kind": "model", "version": _QWEN_REVISION[:12],
            "required": True, "dependsOn": ["qwen-venv"],
            "installPath": layout.QWEN_MODELS, "displayLabel": "Qwen3-TTS 모델",
            "repoId": _QWEN_REPO, "pinnedRevision": _QWEN_REVISION,
            "requiredFiles": _unresolved_files(_QWEN_REQUIRED), "license": None,
            "artifact": _unknown_artifact("qwen3-tts.snapshot", _QWEN_REVISION),
        },
        {
            "id": "models.gptsovits", "kind": "model", "version": "v2",
            "required": False, "dependsOn": ["gptsovits-venv"],
            "installPath": layout.GPTSOVITS_MODELS, "displayLabel": "GPT-SoVITS 사전학습 모델",
            "repoId": _GPTSOVITS_REPO, "pinnedRevision": None, "requiredFiles": [],
            "license": None, "artifact": _unknown_artifact("gptsovits.snapshot"),
        },
    ]
    return {
        "schemaVersion": mf.MANIFEST_SCHEMA_VERSION,
        "profile": mf.DEFAULT_PROFILE,
        "profiles": {
            mf.DEFAULT_PROFILE: {
                "componentIds": ["qwen-venv", "models.qwen3"],
                "excludedComponentIds": [
                    "gptsovits-venv", "models.gptsovits", "models.separator",
                ],
            },
        },
        "components": components,
    }
