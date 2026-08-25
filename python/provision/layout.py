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
from provision import reason_codes as rc

_WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
_WINDOWS_FORBIDDEN = set('<>"|?*')

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

# ── borrowed(외부에서 빌려온) modelRoot의 레거시 레이아웃 별칭 ────────────────
# managed 설치는 위 고정 레이아웃을 쓴다. 그러나 기존 사용자 환경(externals)은 provisioner 이전에
# 만들어진 다른 배치를 갖는다: Qwen HF 캐시는 `qwen3_tts_hf`, separator 모델은 engine 서브디렉터리
# 없이 `separator_models` 평면에 놓여 있다. borrowed root를 managed 레이아웃으로 읽으면 기존 환경의
# 모델을 못 찾는다(설치 위치 == 읽기 위치 보장이 managed에만 성립).
# → ownership('modelRoot')로 **명시 분기**한다. fs 존재 탐색으로 추측하지 않는다(조용한 폴백 금지).
#   borrowed는 읽기 전용이므로 이 별칭이 빌린 트리에 무엇도 쓰지 않는다.
QWEN_MODELS_BORROWED = "qwen3_tts_hf"     # 레거시 externals/qwen3_tts_hf
#   separator: 레거시는 engine 서브디렉터리 없이 separator_models 평면 배치(별도 상수 불필요).


def _model_borrowed():
    """modelRoot가 external-borrowed면 True(레거시 레이아웃). roots 미주입이면 RuntimeRootError."""
    return runtime_paths.ownership("modelRoot") == "external-borrowed"

# ── cacheRoot 하위 ────────────────────────────────────────────────────────────
CACHE_DOWNLOADS = "downloads"
CACHE_STAGING = "staging"
CACHE_JOBS = "jobs"


def _path_id(value, label):
    """Identifiers used as directory names must remain exactly one segment."""
    if (not isinstance(value, str) or not value or value in (".", "..")
            or len(value) > 255 or "\x00" in value
            or "/" in value or "\\" in value or ":" in value
            or value != value.strip() or value.endswith(".")
            or value.split(".", 1)[0].upper() in _WINDOWS_RESERVED
            or any(ch in _WINDOWS_FORBIDDEN or ord(ch) < 0x20
                   for ch in value)):
        raise rc.ProvisionError(rc.PATH_OUTSIDE_ROOT, f"invalid {label}")
    return value


# ── modelRoot helper(runtime_paths 경유 — containment 검증) ──────────────────
def separator_engine_dir(engine, *parts):
    """separator_models/<engine>[/parts]. engine은 SEPARATOR_ENGINES 중 하나.
    borrowed modelRoot는 레거시 평면 배치라 engine 세그먼트를 넣지 않는다(engine 값은 여전히 검증)."""
    if engine not in SEPARATOR_ENGINES:
        raise ValueError(f"unknown separator engine: {engine!r}")
    if _model_borrowed():
        return runtime_paths.model_subdir(SEPARATOR_MODELS, *parts)
    return runtime_paths.model_subdir(SEPARATOR_MODELS, engine, *parts)


def qwen_model_home(*parts):
    """modelRoot/qwen3[/parts] — Qwen HF_HOME 및 스냅샷 경로의 베이스.
    borrowed modelRoot는 레거시 `qwen3_tts_hf`를 쓴다(기존 환경 스냅샷 위치 보존)."""
    base = QWEN_MODELS_BORROWED if _model_borrowed() else QWEN_MODELS
    return runtime_paths.model_subdir(base, *parts)


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
