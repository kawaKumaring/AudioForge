// provision IPC 응답 계약(Agent Q 소유) — main ↔ preload ↔ renderer 공유 타입.
// PlanResult/VerifyResult(P의 pure 계약)는 그대로 실어 나르고, "실행 자체가 가능했는가"를
// 판별하는 discriminated union만 여기서 정의한다. renderer로 전체 절대경로가 나가지 않도록
// main이 assertNoAbsolutePaths로 가드한 뒤에만 ok:true 응답을 만든다(§11).
//
// 순수 type-only 모듈 — process/fs 접근 0. 비-test shared 관례에 따라 type-only import는
// 확장자 없이(node/web 양쪽 tsc가 소비).
import type { PlanResult, VerifyResult } from './provisionContract'
import type { ReasonCode } from './runtimeContract'

// plan/verify가 실행되지 못한 경우(예: provisioner를 돌릴 Python이 주입되지 않음)의 사유.
// - BOOTSTRAP_PYTHON_UNRESOLVED: provisioner 실행용 Python이 명시 주입되지 않음(자동 채택 금지 —
//   env AUDIOFORGE_PROVISION_PYTHON / 사용자가 고른 인터프리터만 인정). production 해석은 STOP 표 항목.
// - 그 외 ReasonCode: CLI가 구조화 오류 봉투로 돌려준 provisioner 사유.
export interface ProvisionUnavailable {
  ok: false
  reasonCode: ReasonCode
  message?: string
}

export interface ProvisionPlanOk {
  ok: true
  plan: PlanResult
}

export interface ProvisionVerifyOk {
  ok: true
  verify: VerifyResult
}

export type ProvisionPlanResponse = ProvisionPlanOk | ProvisionUnavailable
export type ProvisionVerifyResponse = ProvisionVerifyOk | ProvisionUnavailable

// apply는 이번 단계 항상 차단 — 실제 설치 로직 없음. 사유 코드만 돌려준다(spawn·다운로드 0).
export interface ProvisionApplyResponse {
  ok: false
  reasonCode: ReasonCode
  message?: string
}
