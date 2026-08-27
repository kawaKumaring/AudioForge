// 취소 handshake 계약 회귀 — Node 내장 러너(node --test), 새 의존성 0. Electron/React 미참조(순수).
// 실행: node --test src/shared/cancelContract.test.ts
//
// 재현하는 결함(C2-P0.1): ProcessButton.handleCancel이 window.api.audio.cancel() 호출 '전에'
// beginCancelling()으로 낙관적 전환을 하고 반환값을 무시했다. main의 audio:cancel은 실행 중이 아니거나
// 이미 result/error로 정착했으면 아무 이벤트(cancelling/cancelled)도 보내지 않고 no-op을 반환한다.
// → 결과가 정착하는 찰나에 취소를 누르면 (a) onResult가 status==='cancelling'이라 결과를 버리고
//    (b) 어떤 터미널 이벤트도 오지 않아 UI가 영구 'cancelling'에 갇힌다(앱 재시작 외 탈출 불가).
// 계약: 'cancelling' 전환 권위는 오직 main의 audio:cancelling 이벤트. 렌더러는 낙관적 전환을 하지 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CANCEL_FAILED_CODE,
  type CancelUiStatus,
  interpretCancelResponse,
  isCancelAccepted,
  cancelJobId,
  cancelNoopReason,
  canRequestCancel,
  canBeginCancelling,
  isCancelCleanupBusy,
  acceptsSettlement,
  reduceCancelPhase,
  type CancelPhase,
  type CancelEvent,
} from './cancelContract.ts'

// ── 1. 응답 해석 ────────────────────────────────────────────────────────────
test('interpret: accepted 응답', () => {
  assert.equal(interpretCancelResponse({ accepted: true }), 'accepted')
  assert.equal(interpretCancelResponse({ accepted: true, jobId: 'job-7' }), 'accepted')
  assert.equal(isCancelAccepted({ accepted: true }), true)
  assert.equal(cancelJobId({ accepted: true, jobId: 'job-7' }), 'job-7')
  assert.equal(cancelJobId({ accepted: true }), null)             // jobId는 선택 — 없으면 null
  assert.equal(cancelJobId({ accepted: true, jobId: '' }), null)  // 빈 문자열은 상관관계로 쓰지 않는다
  assert.equal(cancelNoopReason({ accepted: true }), null)
})

test('interpret: {accepted:false, reasonCode:"NO_ACTIVE_JOB"} → noop', () => {
  const r = { accepted: false, reasonCode: 'NO_ACTIVE_JOB' }
  assert.equal(interpretCancelResponse(r), 'noop')
  assert.equal(isCancelAccepted(r), false)
  assert.equal(cancelNoopReason(r), 'NO_ACTIVE_JOB')
})

test('interpret: 다른 no-op 사유(ALREADY_SETTLED/ALREADY_CANCELLING)도 noop', () => {
  assert.equal(interpretCancelResponse({ accepted: false, reasonCode: 'ALREADY_SETTLED' }), 'noop')
  assert.equal(cancelNoopReason({ accepted: false, reasonCode: 'ALREADY_SETTLED' }), 'ALREADY_SETTLED')
  assert.equal(interpretCancelResponse({ accepted: false, reasonCode: 'ALREADY_CANCELLING' }), 'noop')
  assert.equal(cancelNoopReason({ accepted: false, reasonCode: 'ALREADY_CANCELLING' }), 'ALREADY_CANCELLING')
})

test('interpret: legacy {ok:true, noop:true} → noop(하위호환)', () => {
  assert.equal(interpretCancelResponse({ ok: true, noop: true }), 'noop')
  assert.equal(isCancelAccepted({ ok: true, noop: true }), false)
  assert.equal(cancelNoopReason({ ok: true, noop: true }), 'UNKNOWN_RESPONSE')
})

test('interpret: legacy 성공/실패 shape도 accepted로 오인하지 않는다', () => {
  // 구 main: 취소를 실제로 수락해도 {ok:true}만 반환했다. accepted 필드가 없으면 보수적으로 noop.
  // (안전한 이유: 이 경로에서 main은 audio:cancelling을 이미 보냈고, 전환은 그 이벤트가 담당한다.)
  assert.equal(interpretCancelResponse({ ok: true }), 'noop')
  assert.equal(interpretCancelResponse({ ok: false, childAlive: true, reason: 'timeout' }), 'noop')
  assert.equal(interpretCancelResponse({ ok: false, cleanupPending: true }), 'noop')
})

test('interpret: undefined/null/쓰레기 → 절대 accepted 아님', () => {
  const garbage: unknown[] = [undefined, null, 0, 1, '', 'accepted', 'true', true, false, NaN, [], [1, 2], () => {}, {}, { accepted: 'true' }, { accepted: 1 }, { accepted: null }]
  for (const bad of garbage) {
    assert.equal(interpretCancelResponse(bad), 'noop', `garbage가 accepted로 해석됨: ${String(bad)}`)
    assert.equal(isCancelAccepted(bad), false)
    assert.equal(cancelJobId(bad), null)
  }
})

// ── 2. store가 공유하는 순수 술어 ───────────────────────────────────────────
test('canRequestCancel: processing에서만 취소 요청', () => {
  assert.equal(canRequestCancel('processing'), true)
  for (const s of ['idle', 'loading', 'cancelling', 'done', 'error'] as const) assert.equal(canRequestCancel(s), false)
})

test('canBeginCancelling: processing 또는 CANCEL_FAILED 재취소만', () => {
  assert.equal(canBeginCancelling('processing'), true)
  assert.equal(canBeginCancelling('error', CANCEL_FAILED_CODE), true)
  assert.equal(canBeginCancelling('error', 'GENERATION_LIMIT_EXCEEDED'), false)
  assert.equal(canBeginCancelling('error', null), false)
  for (const s of ['idle', 'loading', 'cancelling', 'done'] as const) assert.equal(canBeginCancelling(s), false)
})

test('isCancelCleanupBusy / acceptsSettlement: cancelling에서만 정착 거부', () => {
  assert.equal(isCancelCleanupBusy('cancelling'), true)
  assert.equal(acceptsSettlement('cancelling'), false)
  for (const s of ['idle', 'loading', 'processing', 'done', 'error'] as const) {
    assert.equal(isCancelCleanupBusy(s), false)
    assert.equal(acceptsSettlement(s), true)
  }
})

// ── 3. 순수 상태 머신 ───────────────────────────────────────────────────────
const PROCESSING: CancelPhase = { status: 'processing', errorCode: null }
const run = (start: CancelPhase, ...events: CancelEvent[]): CancelPhase => events.reduce(reduceCancelPhase, start)

test('상태머신: 클릭만으로는 전환하지 않는다(낙관적 cancelling 금지 — 이 결함의 원인)', () => {
  assert.equal(run(PROCESSING, { type: 'cancelClicked' }).status, 'processing')
})

test('상태머신: processing --(noop 취소)--> processing (상태 불변)', () => {
  const noops: unknown[] = [
    { accepted: false, reasonCode: 'NO_ACTIVE_JOB' },
    { accepted: false, reasonCode: 'ALREADY_SETTLED' },
    { ok: true, noop: true },   // legacy
    undefined, null, 'garbage',
  ]
  for (const resp of noops) {
    const after = run(PROCESSING, { type: 'cancelClicked' }, { type: 'cancelResponse', response: resp })
    assert.deepEqual(after, PROCESSING, `noop 응답이 상태를 바꿈: ${String(resp)}`)
  }
})

test('상태머신: accepted 응답도 스스로 전환하지 않는다(권위는 audio:cancelling 이벤트)', () => {
  const after = run(PROCESSING, { type: 'cancelClicked' }, { type: 'cancelResponse', response: { accepted: true, jobId: 'j1' } })
  assert.equal(after.status, 'processing')
  assert.equal(run(after, { type: 'cancellingEvent' }).status, 'cancelling')
})

test('상태머신: processing --(audio:cancelling)--> cancelling --(audio:cancelled)--> idle', () => {
  const cancelling = run(PROCESSING, { type: 'cancelClicked' }, { type: 'cancelResponse', response: { accepted: true } }, { type: 'cancellingEvent' })
  assert.equal(cancelling.status, 'cancelling')
  assert.equal(run(cancelling, { type: 'cancelledEvent' }).status, 'idle')
})

test('상태머신: noop 취소 직후 도착한 결과는 정상 채택된다(결함의 핵심 증상)', () => {
  const after = run(
    PROCESSING,
    { type: 'cancelClicked' },
    { type: 'cancelResponse', response: { accepted: false, reasonCode: 'ALREADY_SETTLED' } },
    { type: 'resultEvent' },
  )
  assert.equal(after.status, 'done')   // 낙관적 전환이 있었다면 여기서 결과가 버려지고 cancelling에 갇혔다
})

test('상태머신: noop 취소 직후 도착한 오류도 정상 채택된다', () => {
  const after = run(
    PROCESSING,
    { type: 'cancelResponse', response: { ok: true, noop: true } },
    { type: 'errorEvent', code: 'GENERATION_LIMIT_EXCEEDED' },
  )
  assert.equal(after.status, 'error')
  assert.equal(after.errorCode, 'GENERATION_LIMIT_EXCEEDED')
})

test('상태머신: no-op으로는 영구 cancelling에 도달할 수 없다', () => {
  const noopResponses: unknown[] = [
    { accepted: false, reasonCode: 'NO_ACTIVE_JOB' },
    { accepted: false, reasonCode: 'ALREADY_SETTLED' },
    { accepted: false, reasonCode: 'ALREADY_CANCELLING' },
    { ok: true, noop: true }, { ok: true }, undefined, null, 42,
  ]
  for (const resp of noopResponses) {
    // 몇 번을 눌러도(클릭 연타) 상태는 processing 그대로 — 탈출 불가 상태가 생기지 않는다.
    let s = PROCESSING
    for (let i = 0; i < 5; i++) s = run(s, { type: 'cancelClicked' }, { type: 'cancelResponse', response: resp })
    assert.equal(s.status, 'processing')
    assert.equal(run(s, { type: 'resultEvent' }).status, 'done')   // 여전히 정상 종료 가능
  }
})

test('상태머신: 취소 수락 후 터미널은 정확히 하나(늦은 result는 무시, cancelled가 승자)', () => {
  const cancelling = run(PROCESSING, { type: 'cancellingEvent' })
  const lateResult = run(cancelling, { type: 'resultEvent' })
  assert.equal(lateResult.status, 'cancelling')             // 늦은 결과 미채택(계약 4-A)
  const lateError = run(cancelling, { type: 'errorEvent', code: 'X' })
  assert.equal(lateError.status, 'cancelling')              // 늦은 오류도 미채택
  assert.equal(run(lateResult, { type: 'cancelledEvent' }).status, 'idle')
})

test('상태머신: 취소 실패 → error(CANCEL_FAILED) → 다시 취소 가능 → cancelled → idle', () => {
  const failed = run(PROCESSING, { type: 'cancellingEvent' }, { type: 'cancelFailedEvent' })
  assert.equal(failed.status, 'error')
  assert.equal(failed.errorCode, CANCEL_FAILED_CODE)
  const again = run(failed, { type: 'cancelClicked' }, { type: 'cancelResponse', response: { accepted: true } }, { type: 'cancellingEvent' })
  assert.equal(again.status, 'cancelling')                  // 재취소 진입 허용(공용 마감 K)
  assert.equal(run(again, { type: 'cancelledEvent' }).status, 'idle')
})

test('상태머신: cancelling 중 중복 클릭은 멱등(ALREADY_CANCELLING은 상태 불변)', () => {
  const cancelling = run(PROCESSING, { type: 'cancellingEvent' })
  const after = run(cancelling,
    { type: 'cancelClicked' },
    { type: 'cancelResponse', response: { accepted: false, reasonCode: 'ALREADY_CANCELLING' } },
    { type: 'cancelClicked' },
    { type: 'cancelResponse', response: { accepted: false, reasonCode: 'ALREADY_CANCELLING' } },
  )
  assert.deepEqual(after, cancelling)
  assert.equal(run(after, { type: 'cancelledEvent' }).status, 'idle')
})

// ── 4. 실제 store 정합(계약 ↔ app.store) ────────────────────────────────────
// 리듀서는 '모델'이고 상태를 실제로 보관하는 것은 store다. 둘이 갈라지면 계약이 무의미하므로
// 실제 store를 그대로 불러 같은 술어로 검증한다(store도 같은 함수를 import해 쓴다 — 중복 로직 없음).
// zustand만 쓰는 순수 모듈이라 Electron 없이 로드된다(store의 window 접근은 전부 try/catch).
const { useAppStore } = await import('../renderer/stores/app.store.ts')

const ALL_STATUSES: CancelUiStatus[] = ['idle', 'loading', 'processing', 'cancelling', 'done', 'error']

test('store 정합: beginCancelling은 canBeginCancelling이 참인 상태에서만 전이', () => {
  for (const status of ALL_STATUSES) {
    for (const code of [null, CANCEL_FAILED_CODE, 'GENERATION_LIMIT_EXCEEDED']) {
      useAppStore.setState({ status, errorInfo: code ? { code } : null })
      useAppStore.getState().beginCancelling()
      const expected = canBeginCancelling(status, code) ? 'cancelling' : status
      assert.equal(useAppStore.getState().status, expected, `${status}/${code}에서 전이 불일치`)
    }
  }
})

test('store 정합: 취소 정리 중(cancelling)에는 reset/재시도가 차단된다', () => {
  useAppStore.setState({ status: 'cancelling', errorInfo: null, retryNonce: 0 })
  useAppStore.getState().reset()
  assert.equal(useAppStore.getState().status, 'cancelling')      // isCancelCleanupBusy → 차단
  useAppStore.getState().bumpRetry()
  assert.equal(useAppStore.getState().status, 'cancelling')
  assert.equal(useAppStore.getState().retryNonce, 0)             // 재시도 nonce도 오르지 않는다
})

test('store 정합: setCancelFailed는 계약 상수 코드를 쓰고, 그 상태에서 재취소가 열린다', () => {
  useAppStore.setState({ status: 'processing', errorInfo: null })
  useAppStore.getState().setCancelFailed(true)
  assert.equal(useAppStore.getState().status, 'error')
  assert.equal(useAppStore.getState().errorInfo?.code, CANCEL_FAILED_CODE)
  assert.equal(canBeginCancelling('error', useAppStore.getState().errorInfo?.code), true)
  useAppStore.getState().beginCancelling()                        // main의 audio:cancelling 재수신 상황
  assert.equal(useAppStore.getState().status, 'cancelling')
})

test('store 정합(회귀): 취소 클릭 → no-op 응답 → 도착한 결과가 실제 store에서 채택된다', () => {
  // 수정된 handleCancel 시퀀스 그대로: 클릭해도 store를 건드리지 않고, no-op이면 아무 것도 하지 않는다.
  useAppStore.setState({ status: 'processing', errorInfo: null, tracks: [], outputDir: null })
  assert.equal(canRequestCancel(useAppStore.getState().status), true)
  const resp = { ok: true, noop: true }                           // main: 이미 정착 → 이벤트 없음
  assert.equal(interpretCancelResponse(resp), 'noop')
  // (여기서 beginCancelling()을 부르던 것이 결함이었다 — 지금은 부르지 않는다.)
  assert.equal(useAppStore.getState().status, 'processing')
  // 곧바로 도착한 결과: ProcessButton의 가드는 acceptsSettlement이므로 통과해야 한다.
  assert.equal(acceptsSettlement(useAppStore.getState().status), true)
  useAppStore.getState().setResult([], 'C:/out', null)
  assert.equal(useAppStore.getState().status, 'done')
})

test('store 정합(결함 재현): 낙관적 beginCancelling을 먼저 부르면 결과가 버려지고 갇힌다', () => {
  // 수정 전 코드가 하던 일 그대로 재현 — 이 시퀀스가 왜 금지인지 고정한다.
  useAppStore.setState({ status: 'processing', errorInfo: null, tracks: [], outputDir: null })
  useAppStore.getState().beginCancelling()                        // ← 결함: 클릭 시점 낙관적 전환
  assert.equal(useAppStore.getState().status, 'cancelling')
  const resp = { ok: true, noop: true }                           // main은 no-op — 어떤 터미널 이벤트도 없음
  assert.equal(interpretCancelResponse(resp), 'noop')
  assert.equal(acceptsSettlement(useAppStore.getState().status), false)  // → onResult가 결과를 폐기
  assert.equal(useAppStore.getState().status, 'cancelling')       // → 탈출구 없는 영구 'cancelling'
})
