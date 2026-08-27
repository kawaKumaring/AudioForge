// 취소 handshake 계약(C2-P0.1) — main/preload/renderer가 공유하는 '순수' 모듈.
// Electron·React·zustand를 import하지 않는다(노드 테스트에서 그대로 실행 가능해야 하므로).
//
// ── 왜 필요한가(결함) ───────────────────────────────────────────────────────
// 기존 렌더러는 window.api.audio.cancel()을 호출하기 '전에' beginCancelling()으로 상태를 낙관적으로
// 'cancelling'으로 바꾸고 반환값을 무시했다. 그런데 main의 audio:cancel은 (a) 실행 중이 아니거나
// (b) 이미 result/error로 정착했거나 (c) 이미 취소가 진행 중이면 아무 이벤트도 보내지 않고 no-op으로 끝난다.
// 결과가 정착하는 찰나에 취소를 누르면 렌더러만 'cancelling'이 되어
//   · onResult/onError가 'cancelling'이라는 이유로 결과를 폐기하고,
//   · cancelled/cancel-failed 중 어느 터미널 이벤트도 오지 않아
// UI가 영구히 'cancelling'에 갇힌다(앱 재시작 외 탈출 불가).
//
// ── 계약 ───────────────────────────────────────────────────────────────────
// 1) 렌더러는 취소를 '요청'만 한다. 낙관적 전환 금지.
// 2) 취소 수락 여부의 권위는 main이다.
// 3) main의 반환값은 { accepted:true, jobId? } 또는 { accepted:false, reasonCode }.
// 4) 'cancelling' 전환의 권위는 오직 audio:cancelling 이벤트다(반환값이 아니다).
// 5) no-op 취소는 상태를 전혀 건드리지 않는다 → 직후 도착한 result/error가 정상 채택된다.
// 6) 반복 클릭은 멱등(ALREADY_CANCELLING no-op).
// 7) 수락된 취소는 정확히 하나의 터미널(cancelled | cancel-failed→error | 늦은 result 억제)로 끝난다.
// 8) no-op에서는 영구 'cancelling'에 도달할 수 없다.
//
// 하위호환: 구 main은 { ok:true, noop:true } / { ok:true } / { ok:false, childAlive } 등을 돌려준다.
// accepted 필드가 없는 shape는 '보수적으로' no-op으로 해석한다 — 즉 상태를 건드리지 않는다.
// 구 main이 취소를 실제로 수락한 경우에도 audio:cancelling 이벤트는 이미 보내므로(권위는 이벤트)
// 보수적 해석이 UI를 멈추게 하지 않는다.

/** app.store의 status와 동일 집합. 취소 계약이 판정하는 유일한 상태 축. */
export type CancelUiStatus = 'idle' | 'loading' | 'processing' | 'cancelling' | 'done' | 'error'

/** 취소 실패(트리 종료 미확인/정리 미완) 오류 코드 — store·UI·재취소 게이팅의 단일 상수. */
export const CANCEL_FAILED_CODE = 'CANCEL_FAILED'

/** main이 취소를 수락하지 않은 사유. UI 전환에는 쓰지 않고(모두 '상태 불변') 로깅·진단용이다. */
export const CANCEL_NOOP_REASONS = ['NO_ACTIVE_JOB', 'ALREADY_SETTLED', 'ALREADY_CANCELLING'] as const
export type CancelNoopReason = (typeof CANCEL_NOOP_REASONS)[number]

/** 취소 수락 — main이 audio:cancelling을 보냈고 정확히 하나의 터미널 이벤트로 끝낼 책임을 진다. */
export interface CancelAccepted {
  accepted: true
  /** 선택. main이 줄 수 있으면 상관관계(로그 대조)용으로만 쓴다. 없어도 계약은 성립한다. */
  jobId?: string
}

/** 취소 미수락 — main은 어떤 이벤트도 보내지 않는다. 렌더러는 상태를 그대로 둔다. */
export interface CancelRejected {
  accepted: false
  reasonCode: CancelNoopReason
}

export type CancelResponse = CancelAccepted | CancelRejected

/**
 * IPC 경계에서 실제로 돌아올 수 있는 값 전부(신 계약 + legacy + 미지 shape).
 * preload가 이 타입으로 노출해 소비자가 반드시 interpretCancelResponse를 거치게 만든다.
 */
export type CancelResponseLike = CancelResponse | Record<string, unknown> | null | undefined

export type CancelInterpretation = 'accepted' | 'noop'

/** 타입 가드. accepted === true 인 객체만 수락으로 본다(문자열 'true'·1·truthy 전부 불가). */
export function isCancelAccepted(resp: unknown): resp is CancelAccepted {
  return typeof resp === 'object' && resp !== null && !Array.isArray(resp)
    && (resp as { accepted?: unknown }).accepted === true
}

/** 렌더러가 쓰는 유일한 해석기. 미지/legacy/undefined는 전부 'noop'(= 상태 불변). */
export function interpretCancelResponse(resp: unknown): CancelInterpretation {
  return isCancelAccepted(resp) ? 'accepted' : 'noop'
}

/** 수락 응답의 jobId(로그 상관관계용). 없거나 빈 문자열이면 null — 새 상태 축을 만들지 않는다. */
export function cancelJobId(resp: unknown): string | null {
  if (!isCancelAccepted(resp)) return null
  const id = (resp as CancelAccepted).jobId
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** no-op 사유(로깅용). 수락이면 null, 계약 밖 shape이면 'UNKNOWN_RESPONSE'. */
export function cancelNoopReason(resp: unknown): CancelNoopReason | 'UNKNOWN_RESPONSE' | null {
  if (isCancelAccepted(resp)) return null
  if (typeof resp === 'object' && resp !== null) {
    const rc = (resp as { reasonCode?: unknown }).reasonCode
    if (typeof rc === 'string' && (CANCEL_NOOP_REASONS as readonly string[]).includes(rc)) {
      return rc as CancelNoopReason
    }
  }
  return 'UNKNOWN_RESPONSE'
}

// ── store/UI가 공유하는 순수 술어 (app.store.ts·ProcessButton.tsx가 그대로 소비) ──

/** 취소 '요청'을 보낼 수 있는 상태. processing에서만(중복 클릭·엉뚱한 상태 방지). */
export function canRequestCancel(status: CancelUiStatus): boolean {
  return status === 'processing'
}

/**
 * 'cancelling'으로 전환해도 되는 상태. audio:cancelling 이벤트 수신 시에만 평가한다.
 * processing, 또는 취소 실패(CANCEL_FAILED)로 멈춘 error에서의 '다시 취소' 재진입만 허용.
 */
export function canBeginCancelling(status: CancelUiStatus, errorCode?: string | null): boolean {
  return status === 'processing' || (status === 'error' && errorCode === CANCEL_FAILED_CODE)
}

/** 취소 정리 중(child 종료 확인 전) — setFile/reset/재시도 등 상태 교체를 막는 구간. */
export function isCancelCleanupBusy(status: CancelUiStatus): boolean {
  return status === 'cancelling'
}

/** result/error 정착을 채택해도 되는가. 취소가 먼저 정착(cancelling)했으면 늦은 결과는 버린다(계약 4-A). */
export function acceptsSettlement(status: CancelUiStatus): boolean {
  return !isCancelCleanupBusy(status)
}

// ── 순수 상태 머신 (app.store의 취소 관련 전이를 그대로 모델링) ──────────────
// 목적: 전이 규칙을 테스트 가능한 순수 함수로 고정하는 것. 실제 상태 보관은 계속 store가 한다.
// store와 이 리듀서는 위 술어(canBeginCancelling/acceptsSettlement)를 '공유'하므로 판정이 갈라지지 않는다.

export interface CancelPhase {
  status: CancelUiStatus
  /** errorInfo.code — CANCEL_FAILED 재취소 게이팅에만 쓴다. */
  errorCode?: string | null
}

export type CancelEvent =
  | { type: 'cancelClicked' }                        // 사용자 클릭(요청만 — 전환 없음)
  | { type: 'cancelResponse'; response: unknown }    // audio:cancel invoke 반환값
  | { type: 'cancellingEvent' }                      // main: audio:cancelling (전환 권위)
  | { type: 'cancelledEvent' }                       // main: audio:cancelled  (터미널)
  | { type: 'cancelFailedEvent' }                    // main: audio:cancel-failed (터미널)
  | { type: 'resultEvent' }                          // main: audio:result
  | { type: 'errorEvent'; code?: string }            // main: audio:error

export function reduceCancelPhase(state: CancelPhase, event: CancelEvent): CancelPhase {
  switch (event.type) {
    // 계약 1: 클릭도, 반환값(accepted 포함)도 스스로 전환하지 않는다.
    // accepted라도 전환은 뒤따르는 audio:cancelling이 한다(계약 4) → 여기선 상태 불변.
    // no-op이면 더더욱 불변이라 직후 도착한 result/error가 정상 채택된다(계약 5·8).
    case 'cancelClicked':
    case 'cancelResponse':
      return state
    case 'cancellingEvent':
      return canBeginCancelling(state.status, state.errorCode)
        ? { status: 'cancelling', errorCode: null }
        : state
    case 'cancelledEvent':
      return { status: 'idle', errorCode: null }
    case 'cancelFailedEvent':
      return { status: 'error', errorCode: CANCEL_FAILED_CODE }
    case 'resultEvent':
      return acceptsSettlement(state.status) ? { status: 'done', errorCode: null } : state
    case 'errorEvent':
      return acceptsSettlement(state.status) ? { status: 'error', errorCode: event.code ?? null } : state
    default:
      return state
  }
}
