# -*- coding: utf-8 -*-
"""provision 사유 코드 — 자유 문자열 금지. 공유 계약(src/shared/runtimeContract.ts)의
ReasonCode canonical union과 정합해야 하는 값만 여기 둔다.

경계(renderer/저장)로 나가는 코드는 계약 union에 존재해야 한다. 아래 두 묶음으로 나눈다:
  - REUSED_*: 계약에 이미 존재(재사용). 추가하지 않는다.
  - PROVISION_*: provisioner가 새로 도입(runtimeContract.ts REASON_CODES에도 추가됨).

parity: test_provision_reason_codes가 runtimeContract.ts REASON_CODES를 파싱해
아래 ALL이 그 부분집합인지 고정한다(불일치 시 실패).
"""

# ── 계약에 이미 존재하는(재사용) 코드 ────────────────────────────────────────
NO_RUNTIME_ROOT = "NO_RUNTIME_ROOT"
PATH_OUTSIDE_ROOT = "PATH_OUTSIDE_ROOT"
BORROWED_RUNTIME_READ_ONLY = "BORROWED_RUNTIME_READ_ONLY"
MODEL_MISSING = "MODEL_MISSING"
MODEL_CHECKSUM_MISMATCH = "MODEL_CHECKSUM_MISMATCH"
TOOL_MISSING = "TOOL_MISSING"
VENV_MISSING = "VENV_MISSING"

# ── provisioner 신규 코드(runtimeContract.ts REASON_CODES에도 추가) ──────────
PLAN_FINGERPRINT_MISMATCH = "PLAN_FINGERPRINT_MISMATCH"  # apply 토큰이 현재 plan fingerprint와 다름
UNRESOLVED_COMPONENT = "UNRESOLVED_COMPONENT"            # URL/checksum/license 미상 → apply 차단
BOOTSTRAP_PYTHON_UNRESOLVED = "BOOTSTRAP_PYTHON_UNRESOLVED"  # bootstrap python 획득 방식 미결정
APPLY_DISABLED = "APPLY_DISABLED"                        # 이번 단계 실제 설치 로직 미구현/차단
PROVISION_LOCK_HELD = "PROVISION_LOCK_HELD"              # 다른 provision 실행이 lock 보유(live)
PROVISION_LOCK_STALE = "PROVISION_LOCK_STALE"            # crash orphan lock(자동 탈취 금지 — 안내)
DEPENDENCY_MISSING = "DEPENDENCY_MISSING"                # dependsOn 대상이 manifest에 없음
DAG_CYCLE = "DAG_CYCLE"                                  # component 의존 그래프에 순환

# 계약 union에 반드시 존재해야 하는 provisioner 신규 코드 집합(parity 대상).
PROVISION_ADDED = (
    PLAN_FINGERPRINT_MISMATCH,
    UNRESOLVED_COMPONENT,
    BOOTSTRAP_PYTHON_UNRESOLVED,
    APPLY_DISABLED,
    PROVISION_LOCK_HELD,
    PROVISION_LOCK_STALE,
    DEPENDENCY_MISSING,
    DAG_CYCLE,
)

# provisioner가 사용하는 전체 코드(계약 subset이어야 함).
ALL = (
    NO_RUNTIME_ROOT,
    PATH_OUTSIDE_ROOT,
    BORROWED_RUNTIME_READ_ONLY,
    MODEL_MISSING,
    MODEL_CHECKSUM_MISMATCH,
    TOOL_MISSING,
    VENV_MISSING,
) + PROVISION_ADDED


class ProvisionError(RuntimeError):
    """provisioner 실패. code는 위 고정 코드 중 하나. detail은 비민감 식별자만(전체 경로 금지)."""

    def __init__(self, code, detail=""):
        self.code = code
        self.error_payload = {"code": code}
        super().__init__(f"{code}" + (f": {detail}" if detail else ""))
