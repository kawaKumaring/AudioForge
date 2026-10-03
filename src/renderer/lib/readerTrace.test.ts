// 낭독 관측 기록 — 제한된 개수만, 단조 시계, 비우기(2026-10-03).
import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 요구하는 명시적 .ts 확장자
import { trace, traceDump, traceClear, TRACE_MAX } from './readerTrace.ts'

test('최근 TRACE_MAX 개만 남기고 오래된 것부터 버린다 · 시각은 거꾸로 가지 않는다', () => {
  traceClear()
  for (let i = 0; i < TRACE_MAX + 120; i++) trace('x', { i })
  const d = traceDump()
  assert.equal(d.events.length, TRACE_MAX)
  assert.equal(d.events[0].i, 120, '오래된 것부터 버리지 않았다')
  assert.ok(d.events.every((e, k) => k === 0 || e.t >= d.events[k - 1].t), '시각이 거꾸로 간다')
  assert.equal(traceClear(), TRACE_MAX)
  assert.equal(traceDump().events.length, 0)
})
