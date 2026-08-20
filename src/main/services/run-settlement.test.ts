// settlement 가드 회귀 테스트 — Node 내장 러너(node --test), 새 의존성 0.
// 프로세스 종료 경로별로 UI가 processing에 남지 않고 오류가 중복되지 않음을 검증.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSettlementGuard } from './run-settlement.ts'

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
