// 되돌리기 — **걸음의 크기가 맞는가.**
//
// ★2026-09-27 지시 4: "경계 이동은 드래그 한 번이 undo 한 번이 되게 한다.
//   이름 입력은 글자마다 과도하게 이력이 쌓이지 않게 묶는다. 전체 삭제도 되돌릴 수 있어야 한다."
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyHistory, pushHistory, sealHistory, undo, redo, canUndo, canRedo,
  coalescable, HISTORY_LIMIT,
} from './splitHistory.ts'

type M = { id: string; time: number; label: string }
const snap = (markers: M[], firstLabel = 'Track 01') => ({ markers, firstLabel })
const m = (id: string, time: number, label = id) => ({ id, time, label })

test('되돌릴 것이 없으면 못 한다', () => {
  const h = emptyHistory<M>()
  assert.equal(canUndo(h), false)
  assert.equal(canRedo(h), false)
  assert.equal(undo(h, snap([])), null)
  assert.equal(redo(h, snap([])), null)
})

test('추가 한 번은 한 걸음이다', () => {
  let h = emptyHistory<M>()
  const before = snap([])
  h = pushHistory(h, before, 'add')
  const after = snap([m('a', 10)])
  const back = undo(h, after)
  assert.ok(back)
  assert.deepEqual(back!.snap.markers, [], '추가 전으로 돌아가야 한다')
})

// ★드래그 한 번 = 되돌리기 한 번.
test('경계를 끄는 동안은 한 걸음으로 묶인다', () => {
  let h = emptyHistory<M>()
  const start = snap([m('a', 10)])
  // 끄는 동안 여러 번 바뀐다 — 같은 종류(drag:a)로 이어서 쌓는다.
  h = pushHistory(h, start, 'drag:a')
  h = pushHistory(h, snap([m('a', 12)]), 'drag:a')
  h = pushHistory(h, snap([m('a', 15)]), 'drag:a')
  assert.equal(h.past.length, 1, '드래그 한 번인데 걸음이 여러 개 쌓였다')
  const back = undo(h, snap([m('a', 20)]))
  assert.equal(back!.snap.markers[0].time, 10, '끌기 시작 자리로 한 번에 돌아가야 한다')
})

test('다른 경계를 끌면 새 걸음이다', () => {
  let h = emptyHistory<M>()
  h = pushHistory(h, snap([m('a', 10), m('b', 20)]), 'drag:a')
  h = pushHistory(h, snap([m('a', 15), m('b', 20)]), 'drag:b')
  assert.equal(h.past.length, 2)
})

test('드래그를 놓으면 묶기가 끊긴다', () => {
  let h = emptyHistory<M>()
  h = pushHistory(h, snap([m('a', 10)]), 'drag:a')
  h = sealHistory(h)                       // 놓았다
  h = pushHistory(h, snap([m('a', 15)]), 'drag:a')   // 다시 끌기 시작
  assert.equal(h.past.length, 2, '다시 끌면 새 걸음이어야 한다')
})

// ★이름은 글자마다 쌓지 않는다.
test('이름을 이어 치면 한 걸음으로 묶인다', () => {
  let h = emptyHistory<M>()
  const start = snap([m('a', 10, '')])
  for (const t of ['ㄱ', '가', '가나', '가나다']) {
    h = pushHistory(h, snap([m('a', 10, t)]), 'label:a')
  }
  void start
  assert.equal(h.past.length, 1, '글자마다 걸음이 쌓였다')
})

test('다른 대상의 이름은 새 걸음이다', () => {
  let h = emptyHistory<M>()
  h = pushHistory(h, snap([m('a', 10)]), 'label:a')
  h = pushHistory(h, snap([m('b', 20)]), 'label:b')
  assert.equal(h.past.length, 2)
})

// ★전체 삭제도 되돌릴 수 있어야 한다.
test('전체 삭제를 되돌린다', () => {
  let h = emptyHistory<M>()
  const many = snap([m('a', 10), m('b', 20), m('c', 30)], '첫 트랙')
  h = pushHistory(h, many, 'clear')
  const back = undo(h, snap([], 'Track 01'))
  assert.equal(back!.snap.markers.length, 3, '지운 것이 전부 돌아와야 한다')
  assert.equal(back!.snap.firstLabel, '첫 트랙', '이름도 함께 돌아와야 한다')
})

test('전체 삭제는 묶이지 않는다', () => {
  assert.equal(coalescable('clear'), false)
  assert.equal(coalescable('add'), false)
  assert.equal(coalescable('drag:a'), true)
  assert.equal(coalescable('label:a'), true)
})

test('되돌린 뒤 다시 적용할 수 있다', () => {
  let h = emptyHistory<M>()
  h = pushHistory(h, snap([]), 'add')
  const after = snap([m('a', 10)])
  const back = undo(h, after)!
  assert.equal(canRedo(back.history), true)
  const again = redo(back.history, back.snap)!
  assert.deepEqual(again.snap.markers.map((x) => x.id), ['a'], '다시 적용하면 되돌리기 전으로')
})

test('새로 바꾸면 다시 적용은 사라진다', () => {
  let h = emptyHistory<M>()
  h = pushHistory(h, snap([]), 'add')
  const back = undo(h, snap([m('a', 10)]))!
  assert.equal(canRedo(back.history), true)
  const h2 = pushHistory(back.history, back.snap, 'add')
  assert.equal(canRedo(h2), false, '갈라진 미래를 남겨 두면 사용자가 혼란스럽다')
})

test('이력이 무한히 쌓이지 않는다', () => {
  let h = emptyHistory<M>()
  for (let i = 0; i < HISTORY_LIMIT + 20; i++) h = pushHistory(h, snap([m('a', i)]), `add${i}`)
  assert.equal(h.past.length, HISTORY_LIMIT)
})

test('쌓아 둔 장면은 뒤에 바뀌어도 그대로다', () => {
  let h = emptyHistory<M>()
  const live = [m('a', 10)]
  h = pushHistory(h, snap(live), 'add')
  live[0].time = 999                         // 화면 쪽 배열이 바뀌어도
  const back = undo(h, snap([]))!
  assert.equal(back.snap.markers[0].time, 10, '이력이 따라 바뀌면 되돌리기가 거짓말이 된다')
})
