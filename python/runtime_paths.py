"""runtime_paths — 주입된 root(runtimeRoot/modelRoot/cacheRoot) 기반 경로 해석 단일 소스.

worktree-relative externals 추측(dirname(dirname(__file__))/externals)을 대체한다.
Electron(A)이 config JSON의 `roots`(공유 계약 RuntimeRootConfig 1:1)로 주입 →
separate.py가 configure(roots)로 초기화 → 워커가 *_subdir()로 venv/모델 경로를 해석한다.

이 모듈이 하는 일: 경로 해석 · containment · 소유권(쓰기 권한) 판정. 순수 로직.
이 모듈이 하지 않는 일: 설치 · 다운로드 · junction 재생성/복구 · borrowed root 쓰기.
모델 존재/checksum은 model_manifest, 합성은 워커가 담당한다.

canonical-absolute 규칙은 공유 계약 src/shared/runtimeContract.ts의 isCanonicalAbsolutePath와
동일 규칙을 이식했다(parity 테스트 test_runtime_paths로 고정). 계약을 편집하지 않고 규칙만 미러링.
"""

import os
import re

# 계약 스키마 버전(RUNTIME_CONTRACT_SCHEMA_VERSION)과 대조. 불일치 시 roots 무효 취급.
SCHEMA_VERSION = 2

# ── 고정 사유 코드(자유문자열 금지) ──────────────────────────────────────────
# 통합 담당 확정 지시: containment 위반은 PATH_OUTSIDE_ROOT, realpath null은 DANGLING_JUNCTION,
# venv 부재는 VENV_MISSING. NO_RUNTIME_ROOT는 roots 미주입/무효 공통 코드.
NO_RUNTIME_ROOT = "NO_RUNTIME_ROOT"
PATH_OUTSIDE_ROOT = "PATH_OUTSIDE_ROOT"
DANGLING_JUNCTION = "DANGLING_JUNCTION"
VENV_MISSING = "VENV_MISSING"

_ROOT_KEYS = ("runtimeRoot", "modelRoot", "cacheRoot")
_OWNERSHIPS = ("audioforge-managed", "external-borrowed")

# 주입 상태(초기 미설정). configure()가 채우고 reset()이 비운다(테스트용).
_STATE = None

# realpath 해석 훅(테스트 주입 가능) — 실제 fs 없이 dangling/symlink-escape를 합성 검증하기 위함.
# None이면 _default_resolver 사용. 반환: 정규화 경로 문자열, 해석불가/dangling이면 None.
_PATH_RESOLVER = None


class RuntimeRootError(RuntimeError):
    """root 해석 실패. code는 위 고정 사유 코드 중 하나. error_payload는 separate.py가
    renderer로 forward(구조화 code 전달)한다 — 전체 경로·민감정보는 담지 않는다."""

    def __init__(self, code, detail=""):
        self.code = code
        # root_key 등 detail은 비민감 식별자만(전체 경로 금지).
        self.error_payload = {"code": code}
        super().__init__(f"{code}" + (f": {detail}" if detail else ""))


# ── canonical-absolute 규칙 이식(계약 isCanonicalAbsolutePath 동형) ──────────
_DRIVE_RE = re.compile(r"^[A-Za-z]:[\\/]")


def is_absolute_path(p):
    """POSIX(/...) · Windows 드라이브(C:\\·C:/) · UNC(\\\\host). 계약 isAbsolutePath 동형."""
    if not isinstance(p, str) or len(p) == 0:
        return False
    if p.startswith("/"):
        return True
    if p.startswith("\\\\"):  # UNC
        return True
    return bool(_DRIVE_RE.match(p))


def _path_segments(p):
    return [s for s in re.split(r"[\\/]+", p) if s and s != "."]


def is_canonical_absolute_path(p):
    """절대경로이면서 `..` 세그먼트가 없음(정규화된 형태). 계약 isCanonicalAbsolutePath 동형."""
    if not is_absolute_path(p):
        return False
    return ".." not in _path_segments(p)


# ── 초기화 ──────────────────────────────────────────────────────────────────
def configure(roots):
    """공유 계약 RuntimeRootConfig(dict) 소비. 실패 시 RuntimeRootError(NO_RUNTIME_ROOT).
    검증: schemaVersion==2, 각 root {path: canonical absolute, ownership∈2값}.
    상대경로/비정규 경로/미지원 ownership은 모두 무효 → 워크트리 폴백 금지(명시 오류)."""
    global _STATE
    if not isinstance(roots, dict):
        raise RuntimeRootError(NO_RUNTIME_ROOT, "roots 누락")
    if roots.get("schemaVersion") != SCHEMA_VERSION:
        raise RuntimeRootError(NO_RUNTIME_ROOT, "schemaVersion 불일치")
    parsed = {}
    for key in _ROOT_KEYS:
        desc = roots.get(key)
        if not isinstance(desc, dict):
            raise RuntimeRootError(NO_RUNTIME_ROOT, f"{key} 서술자 누락")
        path = desc.get("path")
        ownership = desc.get("ownership")
        if not is_canonical_absolute_path(path):
            # 경계로 넘어오는 값은 항상 canonical absolute(계약 §1). 상대/비정규 거부.
            raise RuntimeRootError(NO_RUNTIME_ROOT, f"{key} 경로 비정규/상대")
        if ownership not in _OWNERSHIPS:
            raise RuntimeRootError(NO_RUNTIME_ROOT, f"{key} ownership 불명")
        parsed[key] = {"path": os.path.normpath(path), "ownership": ownership}
    _STATE = parsed


def reset():
    """테스트/재실행용 상태 초기화."""
    global _STATE
    _STATE = None


def is_configured():
    return _STATE is not None


def set_path_resolver(fn):
    """테스트 전용: realpath 해석 훅 주입. None으로 되돌리면 기본 fs 해석 사용."""
    global _PATH_RESOLVER
    _PATH_RESOLVER = fn


# ── 경로 해석 + containment ───────────────────────────────────────────────────
def _default_resolver(path):
    """symlink/junction 해석. 링크인데 최종 대상이 없으면(dangling) None.
    존재하지 않는 '일반' 경로는 dangling이 아니다(모델 미설치 != junction 끊김)."""
    try:
        real = os.path.realpath(path)
    except (OSError, ValueError):
        return None
    if os.path.islink(path) and not os.path.exists(real):
        return None
    return os.path.normcase(os.path.normpath(real))


def _resolve(path):
    fn = _PATH_RESOLVER if _PATH_RESOLVER is not None else _default_resolver
    return fn(path)


def _lexically_within(child, parent):
    c = os.path.normcase(os.path.normpath(child))
    p = os.path.normcase(os.path.normpath(parent))
    if c == p:
        return True
    return c.startswith(p + os.sep) or c.startswith(p + "/")


def _root(root_key):
    if _STATE is None:
        raise RuntimeRootError(NO_RUNTIME_ROOT, "roots 미주입")
    return _STATE[root_key]


def _within(root_key, *parts):
    """root_key 밑 parts 경로를 해석하고 containment를 강제한 절대경로를 반환.
    반환값은 join 결과(정규화)로, runtimeRoot가 과거 base와 같으면 과거 경로와 동일하다(출력 불변).
    - 어휘적으로 root 밖(`..` 등) → PATH_OUTSIDE_ROOT
    - realpath null(dangling junction) → DANGLING_JUNCTION
    - realpath가 root 밖(symlink escape) → PATH_OUTSIDE_ROOT
    """
    root = _root(root_key)
    root_path = root["path"]
    candidate = os.path.normpath(os.path.join(root_path, *parts))
    # 1) 어휘적 containment (순수) — `..` 탈출 방지
    if not _lexically_within(candidate, root_path):
        raise RuntimeRootError(PATH_OUTSIDE_ROOT, root_key)
    # 2) realpath 해석 — dangling 판정
    real = _resolve(candidate)
    if real is None:
        raise RuntimeRootError(DANGLING_JUNCTION, root_key)
    root_real = _resolve(root_path)
    if root_real is None:
        raise RuntimeRootError(DANGLING_JUNCTION, root_key)
    # 3) 해석된 실제 경로도 root 안이어야 함(symlink/junction escape 차단)
    if not _lexically_within(real, root_real):
        raise RuntimeRootError(PATH_OUTSIDE_ROOT, root_key)
    return candidate


def runtime_subdir(*parts):
    """runtimeRoot(venv·lock·cache) 밑 경로."""
    return _within("runtimeRoot", *parts)


def model_subdir(*parts):
    """modelRoot(다운로드 모델) 밑 경로."""
    return _within("modelRoot", *parts)


def cache_subdir(*parts):
    """cacheRoot(다운로드 staging) 밑 경로."""
    return _within("cacheRoot", *parts)


def can_write(root_key):
    """managed root만 쓰기 허용(borrowed는 읽기 전용 — junction 재생성/makedirs 금지)."""
    return _root(root_key)["ownership"] == "audioforge-managed"


def ownership(root_key):
    return _root(root_key)["ownership"]
