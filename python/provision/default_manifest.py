# -*- coding: utf-8 -*-
"""provision.default_manifest — 기본 component manifest(순수 데이터).

정직성 원칙(PROVISIONER-PLAN §2·§6): URL/checksum/license 미상은 **추정 금지**. 아래 실제
component들은 코드에서 이미 알려진 비민감 사실(repoId·pinnedRevision·필수 파일명·레이아웃 경로)만
채우고, sha256·totalSize·license는 미상이므로 비워 둔다 → 전부 resolved=False가 되어 apply가
차단된다(STOP 표 승인 전 정상 상태). bootstrap-python은 §2에 따라 항상 unresolved.

이 데이터는 STOP 표 승인 시 sha256/size/license를 채워 resolved로 만드는 단일 소스가 된다.
"""

from . import layout
from . import manifest as mf

# tts_worker._QWEN_REPO / _QWEN_REVISION / _QWEN_REQUIRED와 동일 사실(코드에서 이미 공개).
_QWEN_REPO = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
_QWEN_REVISION = "5d83992436eae1d760afd27aff78a71d676296fc"
_QWEN_REQUIRED = ["config.json", "model.safetensors", "vocab.json", "merges.txt",
                  "tokenizer_config.json", "speech_tokenizer/model.safetensors"]
# music_worker._ROFORMER_MODEL / _MELBAND_ENSEMBLE_MODEL
_ROFORMER_FILE = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
_MELBAND_FILE = "mel_band_roformer_kim_ft2_bleedless_unwa.ckpt"
# setup_gptsovits.py의 v2 사전학습 repo(사실). 파일별 digest·license 미상 → unresolved.
_GPTSOVITS_REPO = "lj1995/GPT-SoVITS"


def _unresolved_files(paths):
    """path만 알고 sha256 미상인 필수 파일 목록(→ unresolved 유도)."""
    return [{"path": p, "sha256": None} for p in paths]


def build():
    """기본 manifest(dict). validate_manifest로 검증 가능한 형태."""
    components = [
        {
            "id": "bootstrap-python", "kind": "bootstrap", "version": "unresolved",
            "required": True, "dependsOn": [], "installPath": None,
            "displayLabel": "Python 런타임", "license": None,
        },
        {
            "id": "parent-runtime", "kind": "venv", "version": "unresolved",
            "required": True, "dependsOn": ["bootstrap-python"],
            "installPath": layout.RUNTIME_PARENT_VENV, "displayLabel": "AudioForge 실행 환경",
            "license": None,
        },
        {
            "id": "ffmpeg", "kind": "tool", "version": "unresolved",
            "required": True, "dependsOn": [],
            "installPath": layout.RUNTIME_TOOLS + "/" + layout.RUNTIME_TOOLS_FFMPEG,
            "displayLabel": "ffmpeg", "license": None,
        },
        {
            "id": "cache-area", "kind": "cache", "version": "1",
            "required": True, "dependsOn": [],
            "installPath": layout.CACHE_STAGING,
            "displayLabel": "다운로드 캐시",
            # cache-area는 우리 소유 저장영역 정의라 라이선스 개념이 없음 → 명시적 n/a로 resolved 가능.
            "license": {"code": "n/a", "weights": "n/a", "data": "n/a", "output": "n/a"},
        },
        {
            "id": "qwen-venv", "kind": "venv", "version": "unresolved",
            "required": False, "dependsOn": ["bootstrap-python"],
            "installPath": layout.RUNTIME_QWEN_VENV, "displayLabel": "Qwen TTS 환경",
            "license": None,
        },
        {
            "id": "gptsovits-venv", "kind": "venv", "version": "unresolved",
            "required": False, "dependsOn": ["bootstrap-python"],
            "installPath": layout.RUNTIME_GPTSOVITS_VENV, "displayLabel": "GPT-SoVITS 환경",
            "license": None,
        },
        {
            "id": "models.separator", "kind": "model", "version": "unresolved",
            "required": False, "dependsOn": [],
            "installPath": layout.SEPARATOR_MODELS, "displayLabel": "보컬 분리 모델",
            "repoId": None, "pinnedRevision": None, "totalSize": None,
            "requiredFiles": _unresolved_files([
                layout.SEPARATOR_ENGINE_ROFORMER + "/" + _ROFORMER_FILE,
                layout.SEPARATOR_ENGINE_MELBAND + "/" + _MELBAND_FILE,
            ]),
            "license": None,
        },
        {
            "id": "models.qwen3", "kind": "model", "version": _QWEN_REVISION[:12],
            "required": False, "dependsOn": ["qwen-venv"],
            "installPath": layout.QWEN_MODELS, "displayLabel": "Qwen3-TTS 모델",
            "repoId": _QWEN_REPO, "pinnedRevision": _QWEN_REVISION, "totalSize": None,
            "requiredFiles": _unresolved_files(_QWEN_REQUIRED),
            "license": None,
        },
        {
            "id": "models.gptsovits", "kind": "model", "version": "v2",
            "required": False, "dependsOn": ["gptsovits-venv"],
            "installPath": layout.GPTSOVITS_MODELS, "displayLabel": "GPT-SoVITS 사전학습 모델",
            "repoId": _GPTSOVITS_REPO, "pinnedRevision": None, "totalSize": None,
            "requiredFiles": [], "license": None,
        },
    ]
    return {"schemaVersion": mf.MANIFEST_SCHEMA_VERSION, "components": components}
