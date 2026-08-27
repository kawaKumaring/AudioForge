// settlement 가드 회귀 테스트 — Node 내장 러너(node --test), 새 의존성 0.
// 프로세스 종료 경로별로 UI가 processing에 남지 않고 오류가 중복되지 않음을 검증.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSettlementGuard,
  createTerminalGate,
  createRunSettlement,
  createRunnerSlot,
  terminalForEnd
} from './run-settlement.ts'
import type { RunEnd, RunTerminal } from './run-settlement.ts'

test('result → done: 추가 오류 없음', () => {
  const errs: string[] = []
  const g = createSettlementGuard(m => errs.push(m))
  g.markSettled()        // result 핸들러
  g.finish(0)            // done
  assert.equal(errs.length, 0)
})

test('error → done: done이 오류를 중복 전송하지 않음', () => {
  const errs: string[] = []
  const g = createSettlementGuard(m => errs.push(m))
  g.markSettled()        // error 핸들러(자체 sendError는 가드 밖)
  g.finish(1)
  assert.equal(errs.length, 0)
})

test('watchdog → done(kill, code null): done 중복 없음', () => {
  const errs: string[] = []
  const g = createSettlementGuard(m => errs.push(m))
  g.markSettled()        // watchdog 핸들러(자체 timeout sendError는 가드 밖)
  g.finish(null)         // 프로세스 kill → close code null
  assert.equal(errs.length, 0)
})

test('result/error/watchdog 없이 done → 완료 신호 없음 오류 1회', () => {
  const errs: string[] = []
  const g = createSettlementGuard(m => errs.push(m))
  g.finish(0)
  assert.equal(errs.length, 1)
  assert.match(errs[0], /완료 신호 없이/)
})

test('동일 종료 경로에서 done 중복 호출 → 오류 1회', () => {
  const errs: string[] = []
  const g = createSettlementGuard(m => errs.push(m))
  g.finish(1)
  g.finish(1)
  assert.equal(errs.length, 1)
})

test('markSettled 후 finish는 오류를 내지 않고, settled 플래그가 반영됨', () => {
  const errs: string[] = []
  const g = createSettlementGuard(m => errs.push(m))
  assert.equal(g.settled, false)
  g.markSettled()
  assert.equal(g.settled, true)
  g.finish(0)
  assert.equal(errs.length, 0)
})

// ────────────────────────────────────────────────────────────────────────────
// createTerminalGate — '정확히 한 번' 원시
// ────────────────────────────────────────────────────────────────────────────

test('gate: 첫 settle만 emit, 두 번째는 무시(false)', () => {
  const out: string[] = []
  const gate = createTerminalGate<string>(v => out.push(v))
  assert.equal(gate.settle('a'), true)
  assert.equal(gate.settle('b'), false)
  assert.deepEqual(out, ['a'])
  assert.equal(gate.settled, true)
})

test('gate: markSettled 후 settle은 emit하지 않는다', () => {
  const out: string[] = []
  const gate = createTerminalGate<string>(v => out.push(v))
  assert.equal(gate.markSettled(), true)
  assert.equal(gate.markSettled(), false)
  assert.equal(gate.settle('x'), false)
  assert.deepEqual(out, [])
})

test('gate: emit 안에서의 재진입 settle도 차단(무한 루프/중복 금지)', () => {
  const out: string[] = []
  const gate = createTerminalGate<string>(v => {
    out.push(v)
    gate.settle('reentrant')   // 재진입
  })
  gate.settle('first')
  assert.deepEqual(out, ['first'])
})

// ────────────────────────────────────────────────────────────────────────────
// terminalForEnd — 종료 사실 → 터미널 매핑(순수)
// ────────────────────────────────────────────────────────────────────────────

const END = (over: Partial<RunEnd>): RunEnd => ({
  reasonCode: 'exit-ok', code: 0, signal: null, killedByUs: false, ...over
})

test('terminalForEnd: killed → cancelled', () => {
  const t = terminalForEnd(END({ reasonCode: 'killed', code: null, killedByUs: true }))
  assert.equal(t.kind, 'cancelled')
  assert.equal(t.reasonCode, 'cancelled-by-request')
})

test('terminalForEnd: signal(우리 요청 아님) → error/signal-terminated', () => {
  const t = terminalForEnd(END({ reasonCode: 'signal', code: null, signal: 'SIGKILL' }))
  assert.equal(t.kind, 'error')
  assert.equal(t.reasonCode, 'signal-terminated')
})

test('terminalForEnd: exit-nonzero → error/exit-nonzero', () => {
  const t = terminalForEnd(END({ reasonCode: 'exit-nonzero', code: 3 }))
  assert.equal(t.kind, 'error')
  assert.equal(t.reasonCode, 'exit-nonzero')
  assert.match(t.message ?? '', /3/)
})

test('terminalForEnd: exit-ok(무결과) → error/no-terminal-signal', () => {
  const t = terminalForEnd(END({ reasonCode: 'exit-ok', code: 0 }))
  assert.equal(t.kind, 'error')
  assert.equal(t.reasonCode, 'no-terminal-signal')
  assert.match(t.message ?? '', /완료 신호 없이/)
})

test('terminalForEnd: spawn 실패(sync/async) → error/spawn-failed', () => {
  for (const rc of ['spawn-error-sync', 'spawn-error-async'] as const) {
    const t = terminalForEnd(END({ reasonCode: rc, code: -1 }))
    assert.equal(t.kind, 'error')
    assert.equal(t.reasonCode, 'spawn-failed')
  }
})

test('terminalForEnd: 메시지에 경로/명령줄이 섞이지 않는다(비민감)', () => {
  const codes = ['exit-ok', 'exit-nonzero', 'signal', 'killed', 'spawn-error-sync', 'spawn-error-async'] as const
  for (const rc of codes) {
    const msg = terminalForEnd(END({ reasonCode: rc, code: 1 })).message ?? ''
    assert.ok(!msg.includes('/') && !msg.includes('\\'), `경로 유출 의심: ${msg}`)
  }
})

// ────────────────────────────────────────────────────────────────────────────
// createRunSettlement — 트랙/메인 러너 공용: 실행당 터미널 정확히 1개
// ────────────────────────────────────────────────────────────────────────────

test('runSettlement: result 1회 → terminal 1개(kind=result)', () => {
  const out: RunTerminal[] = []
  const s = createRunSettlement(t => out.push(t))
  assert.equal(s.settleResult({ tracks: [] }), true)
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'result')
  assert.deepEqual(out[0].data, { tracks: [] })
})

test('runSettlement: result 이후 done(exit-ok) → 두 번째 터미널 없음', () => {
  const out: RunTerminal[] = []
  const s = createRunSettlement(t => out.push(t))
  s.settleResult({ ok: 1 })
  assert.equal(s.finishFromEnd(END({ reasonCode: 'exit-ok' })), false)
  assert.equal(out.length, 1)
})

test('runSettlement: 코드 0인데 result 없음 → error 터미널 1개(고착 방지)', () => {
  const out: RunTerminal[] = []
  const s = createRunSettlement(t => out.push(t))
  assert.equal(s.finishFromEnd(END({ reasonCode: 'exit-ok', code: 0 })), true)
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'error')
  assert.equal(out[0].reasonCode, 'no-terminal-signal')
})

test('runSettlement: 신호 종료(code null, 우리 요청 아님) → error 터미널 1개', () => {
  const out: RunTerminal[] = []
  const s = createRunSettlement(t => out.push(t))
  s.finishFromEnd(END({ reasonCode: 'signal', code: null }))
  assert.equal(out.length, 1)
  assert.equal(out[0].reasonCode, 'signal-terminated')
})

test('runSettlement: 우리 취소로 종료 → cancelled 터미널', () => {
  const out: RunTerminal[] = []
  const s = createRunSettlement(t => out.push(t))
  s.finishFromEnd(END({ reasonCode: 'killed', code: null, killedByUs: true }))
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'cancelled')
})

test('runSettlement: watchdog timeout은 error/timeout으로 선점, 이후 done은 무시', () => {
  const out: RunTerminal[] = []
  const s = createRunSettlement(t => out.push(t))
  assert.equal(s.settleError('처리 시간이 초과되었습니다.', 'timeout'), true)
  assert.equal(s.finishFromEnd(END({ reasonCode: 'killed', killedByUs: true })), false)
  assert.equal(out.length, 1)
  assert.equal(out[0].reasonCode, 'timeout')
})

test('runSettlement: error 2회 → 터미널 1개', () => {
  const out: RunTerminal[] = []
  const s = createRunSettlement(t => out.push(t))
  s.settleError('첫 오류')
  s.settleError('둘째 오류')
  assert.equal(out.length, 1)
  assert.equal(out[0].message, '첫 오류')
  assert.equal(out[0].reasonCode, 'error-reported')
})

test('runSettlement: finish(code)는 end 없이도 터미널을 만든다', () => {
  const out: RunTerminal[] = []
  const s = createRunSettlement(t => out.push(t))
  s.finish(2)
  assert.equal(out.length, 1)
  assert.equal(out[0].reasonCode, 'exit-nonzero')
})

// ────────────────────────────────────────────────────────────────────────────
// createRunnerSlot — 신원 가드(늦은 해제가 새 실행을 지우지 않음)
// ────────────────────────────────────────────────────────────────────────────

test('slot: 현재 러너만 해제된다', () => {
  const slot = createRunnerSlot<{ id: string }>()
  const a = slot.set({ id: 'a' })
  assert.equal(slot.current, a)
  assert.equal(slot.release(a), true)
  assert.equal(slot.current, null)
})

test('slot: 취소된 A의 늦은 done이 새로 시작한 B를 지우지 못한다', () => {
  const slot = createRunnerSlot<{ id: string }>()
  const a = slot.set({ id: 'a' })
  const b = slot.set({ id: 'b' })          // A 취소 후 B 시작
  assert.equal(slot.release(a), false)     // A의 늦은 done
  assert.equal(slot.current, b, 'B가 살아있어야 앱 종료 kill 목록/중복 실행 가드가 유효')
  assert.equal(slot.isCurrent(b), true)
  assert.equal(slot.isCurrent(a), false)
})

test('slot: 이미 해제된 뒤의 재해제는 false(부수효과 없음)', () => {
  const slot = createRunnerSlot<{ id: string }>()
  const a = slot.set({ id: 'a' })
  assert.equal(slot.release(a), true)
  assert.equal(slot.release(a), false)
  assert.equal(slot.isCurrent(null), false)
})

test('slot: clear는 신원 무관 강제 해제', () => {
  const slot = createRunnerSlot<{ id: string }>()
  slot.set({ id: 'a' })
  slot.clear()
  assert.equal(slot.current, null)
})
