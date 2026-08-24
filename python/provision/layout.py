# -*- coding: utf-8 -*-
"""provision.layout — 고정 managed 런타임 레이아웃의 단일 소스(순수).

PROVISIONER-PLAN §1이 고정한 레이아웃을 코드 상수로 못박는다. provisioner(설치 대상)와
R3 워커(읽기 경로)가 동일한 이 상수를 참조해야 install 위치 == read 위치가 보장된다.

경로 해석은 전부 runtime_paths.*_subdir()로만 한다(직접 join·추측 금지). 이 모듈 자체는
문자열 상수 + subdir 경유 helper만 제공하며 어떤 fs 부작용도 내지 않는다(subdir 호출은
containment 검증만 수행하고 디렉터리를 만들지 않는다).

레이아웃(고정):
  runtimeRoot/
    audioforge_venv/  qwen3_tts_venv/  gptsovits_venv/  GPT-SoVITS/  tools/ffmpeg/  manifests/  locks/
  modelRoot/
    separator_models/roformer/   separator_models/melband/
    qwen3/<hf-cache>              gptsovits/<component-id>/
  cacheRoot/
    downloads/<job-id>/  staging/<job-id>/  jobs/<job-id>/
"""

import runtime_paths

# ── runtimeRoot 하위 ──────────────────────────────────────────────────────────
RUNTIME_PARENT_VENV = "audioforge_venv"
RUNTIME_QWEN_VENV = "qwen3_tts_venv"
RUNTIME_GPTSOVITS_VENV = "gptsovits_venv"
RUNTIME_GPTSOVITS_CODE = "GPT-SoVITS"
RUNTIME_TOOLS = "tools"
RUNTIME_TOOLS_FFMPEG = "ffmpeg"
RUNTIME_MANIFESTS = "manifests"
RUNTIME_LOCKS = "locks"
PROVISION_LOCK_FILE = "provision.lock"

# ── modelRoot 하위 ────────────────────────────────────────────────────────────
SEPARATOR_MODELS = "separator_models"
SEPARATOR_ENGINE_ROFORMER = "roformer"   # BS-RoFormer(_ROFORMER_MODEL)
SEPARATOR_ENGINE_MELBAND = "melband"     # Mel-Band(_MELBAND_ENSEMBLE_MODEL)
SEPARATOR_ENGINES = (SEPARATOR_ENGINE_ROFORMER, SEPARATOR_ENGINE_MELBAND)
QWEN_MODELS = "qwen3"                     # HF 캐시 루트(HF_HOME)를 여기 둔다
GPTSOVITS_MODELS = "gptsovits"

# ── cacheRoot 하위 ────────────────────────────────────────────────────────────
CACHE_DOWNLOADS = "downloads"
CACHE_STAGING = "staging"
CACHE_JOBS = "jobs"


def _path_id(value, label):
    """Identifiers used as directory names must remain exactly one segment."""
    if (not isinstance(value, str) or not value or value in (".", "..")
            or len(value) > 255 or "\x00" in value
            or "/" in value or "\\" in value or ":" in value
            or any(ord(ch) < 0x20 for ch in value)):
        raise ValueError(f"invalid {label}")
    return value


# ── modelRoot helper(runtime_paths 경유 — containment 검증) ──────────────────
def separator_engine_dir(engine, *parts):
    """separator_models/<engine>[/parts]. engine은 SEPARATOR_ENGINES 중 하나."""
    if engine not in SEPARATOR_ENGINES:
        raise ValueError(f"unknown separator engine: {engine!r}")
    return runtime_paths.model_subdir(SEPARATOR_MODELS, engine, *parts)


def qwen_model_home(*parts):
    """modelRoot/qwen3[/parts] — Qwen HF_HOME 및 스냅샷 경로의 베이스."""
    return runtime_paths.model_subdir(QWEN_MODELS, *parts)


def gptsovits_model_dir(*parts):
    """modelRoot/gptsovits[/parts]. (주: 현행 GPT-SoVITS 엔진은 모델을 repo 트리 안에서 읽는다 —
    아래 gptsovits_repo_dir 참고. 이 경로는 provisioner 배치 대상 슬롯으로만 예약.)"""
    return runtime_paths.model_subdir(GPTSOVITS_MODELS, *parts)


# ── runtimeRoot helper ────────────────────────────────────────────────────────
def parent_venv_dir(*parts):
    return runtime_paths.runtime_subdir(RUNTIME_PARENT_VENV, *parts)


def qwen_venv_dir(*parts):
    return runtime_paths.runtime_subdir(RUNTIME_QWEN_VENV, *parts)


def gptsovits_venv_dir(*parts):
    return runtime_paths.runtime_subdir(RUNTIME_GPTSOVITS_VENV, *parts)


def gptsovits_repo_dir(*parts):
    return runtime_paths.runtime_subdir(RUNTIME_GPTSOVITS_CODE, *parts)


def tools_ffmpeg_dir(*parts):
    return runtime_paths.runtime_subdir(RUNTIME_TOOLS, RUNTIME_TOOLS_FFMPEG, *parts)


def manifests_dir(*parts):
    return runtime_paths.runtime_subdir(RUNTIME_MANIFESTS, *parts)


def provision_lock_path():
    return runtime_paths.runtime_subdir(RUNTIME_LOCKS, PROVISION_LOCK_FILE)


# ── cacheRoot helper(staging은 managed cacheRoot에서만) ──────────────────────
def downloads_dir(job_id, *parts):
    return runtime_paths.cache_subdir(
        CACHE_DOWNLOADS, _path_id(job_id, "jobId"), *parts)


def staging_dir(job_id, *parts):
    return runtime_paths.cache_subdir(
        CACHE_STAGING, _path_id(job_id, "jobId"), *parts)


def jobs_dir(job_id, *parts):
    return runtime_paths.cache_subdir(
        CACHE_JOBS, _path_id(job_id, "jobId"), *parts)
