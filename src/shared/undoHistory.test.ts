// 되돌리기 — 걸음의 크기.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canRedo, canUndo, emptyHistory, HISTORY_LIMIT, pushHistory, redo, sealHistory, undo,
} from './undoHistory.ts'

interface S { v: number }
const clone = (s: S): S => ({ ...s })
const NAME = ['name:'] as const

test('되돌릴 것이 없으면 null', () => {
  assert.equal(undo(emptyHistory<S>(), { v: 1 }, clone), null)
  assert.equal(redo(emptyHistory<S>(), { v: 1 }, clone), null)
  assert.equal(canUndo(emptyHistory<S>()), false)
})

test('한 걸음 쌓고 되돌린다', () => {
  const h = pushHistory(emptyHistory<S>(), { v: 1 }, 'merge', clone, NAME)
  assert.equal(canUndo(h), true)
  const r = undo(h, { v: 2 }, clone)!
  assert.deepEqual(r.snap, { v: 1 })
  assert.equal(canRedo(r.history), true)
  assert.deepEqual(redo(r.history, r.snap, clone)!.snap, { v: 2 })
})

test('★묶을 종류는 이어 치는 동안 한 걸음이다', () => {
  let h = emptyHistory<S>()
  h = pushHistory(h, { v: 1 }, 'name:A', clone, NAME)
  h = pushHistory(h, { v: 2 }, 'name:A', clone, NAME)
  h = pushHistory(h, { v: 3 }, 'name:A', clone, NAME)
  assert.equal(h.past.length, 1, '글자마다 걸음을 쌓지 않는다')
  assert.deepEqual(undo(h, { v: 4 }, clone)!.snap, { v: 1 }, '치기 시작 전으로 한 번에 돌아간다')
})

test('★손을 떼면 묶기를 끊는다 — 다음 것은 새 걸음이다', () => {
  let h = emptyHistory<S>()
  h = pushHistory(h, { v: 1 }, 'name:A', clone, NAME)
  h = sealHistory(h)
  h = pushHistory(h, { v: 2 }, 'name:A', clone, NAME)
  assert.equal(h.past.length, 2)
})

test('다른 대상이면 묶지 않는다', () => {
  let h = emptyHistory<S>()
  h = pushHistory(h, { v: 1 }, 'name:A', clone, NAME)
  h = pushHistory(h, { v: 2 }, 'name:B', clone, NAME)
  assert.equal(h.past.length, 2)
})

test('묶지 않는 종류는 늘 새 걸음이다', () => {
  let h = emptyHistory<S>()
  h = pushHistory(h, { v: 1 }, 'merge', clone, NAME)
  h = pushHistory(h, { v: 2 }, 'merge', clone, NAME)
  assert.equal(h.past.length, 2)
})

test('새로 바꾸면 다시 적용은 사라진다', () => {
  let h = pushHistory(emptyHistory<S>(), { v: 1 }, 'a', clone, NAME)
  const r = undo(h, { v: 2 }, clone)!
  assert.equal(canRedo(r.history), true)
  h = pushHistory(r.history, { v: 1 }, 'b', clone, NAME)
  assert.equal(canRedo(h), false)
})

test('장면은 복사해 둔다 — 원본이 바뀌어도 이력이 따라 바뀌지 않는다', () => {
  const live: S = { v: 1 }
  const h = pushHistory(emptyHistory<S>(), live, 'a', clone, NAME)
  live.v = 99
  assert.deepEqual(h.past[0].snap, { v: 1 })
})

test('상한을 넘으면 오래된 것부터 버린다', () => {
  let h = emptyHistory<S>()
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) h = pushHistory(h, { v: i }, `k${i}`, clone, NAME)
  assert.equal(h.past.length, HISTORY_LIMIT)
  assert.equal(h.past[0].snap.v, 5)
})
