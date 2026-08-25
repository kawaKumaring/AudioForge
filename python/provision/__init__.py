# -*- coding: utf-8 -*-
"""provision — managed runtime provisioner의 순수 코어(pure core).

부작용(다운로드/pip/venv 생성/모델 복사/GPU 실행) 없음. 이 패키지는
  - component DAG(순수 데이터 + 위상정렬)                     : provision.dag
  - manifest 스키마 로더/검증(resolved 판정, HF snapshot 형태) : provision.manifest
  - plan/dry-run/verify state machine(apply는 차단)          : provision.state
  - canonical JSON → SHA-256 planFingerprint                 : provision.fingerprint
  - lock 순수 로직 + crash orphan stale 판정                  : provision.lock
  - staging/verify/atomic pointer(주입 경로에서만 동작)       : provision.staging
  - ownership 강제(managed 쓰기 / borrowed read-only)         : provision.ownership
  - 고정 managed 레이아웃 단일 소스                            : provision.layout
  - provisioner 사유 코드(계약 ReasonCode subset)             : provision.reason_codes
만 담는다.

경로 해석은 전부 runtime_paths.configure(roots) + *_subdir()만 사용한다(직접 join 금지).
root는 명시 인자로만 수신하며 cwd/HOME/__file__/worktree로 추측하지 않는다.

apply(실제 설치)는 이 단계에서 비활성이다 — state.apply()는 승인 토큰(plan fingerprint)이
없거나 unresolved component가 있으면 거부하고, 그 외에도 설치 로직 미구현으로 APPLY_DISABLED를 낸다.
"""
