import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import { estimateHeight, offsetsOf, indexAt, visibleRange, scrollTopFor, WINDOW_FROM } from './readerWindow.ts'

const G = { fontSize: 16, contentWidth: 640, lineHeight: 1.95, chrome: 32 }

test('어림 높이 — 글이 길면 줄이 늘고, 빈 문단도 한 줄은 된다', () => {
  const one = estimateHeight(10, G), three = estimateHeight(40 * 3, G)
  assert.equal(one, Math.round(16 * 1.95 + 32))
  // 한 줄 40자(640 / 15.7) — 120자는 세 줄. 여백(chrome)은 한 번만 붙는다.
  assert.equal(three, Math.round(3 * 16 * 1.95 + 32), `${one} → ${three}`)
  assert.equal(estimateHeight(0, G), one)
})

test('자리 — 누적 합 · 전체 높이가 마지막 칸', () => {
  const o = offsetsOf([10, 20, 30])
  assert.deepEqual([...o], [0, 10, 30, 60])
})

test('이 자리를 품은 문단 — 경계는 아래 문단 몫', () => {
  const o = offsetsOf([10, 20, 30])
  assert.equal(indexAt(o, 0), 0)
  assert.equal(indexAt(o, 9.9), 0)
  assert.equal(indexAt(o, 10), 1)
  assert.equal(indexAt(o, 59), 2)
  assert.equal(indexAt(o, 999), 2)
})

test('★그릴 범위 — 3만 문단에서도 보이는 칸 근처만', () => {
  const o = offsetsOf(new Array(30000).fill(100))
  const r = visibleRange(o, 1_000_000, 500, 1000)
  assert.equal(r.start, 9990)                      // (1,000,000 - 1000) / 100
  assert.equal(r.end, 10016)                       // (1,000,000 + 500 + 1000) / 100 + 1
  assert.ok(r.end - r.start < 40)
  // 맨 앞 · 맨 끝에서도 범위를 벗어나지 않는다
  assert.deepEqual(visibleRange(o, 0, 500, 1000), { start: 0, end: 16 })
  assert.equal(visibleRange(o, 5_000_000, 500, 1000).end, 30000)
})

test('문단을 가운데로 — 칸보다 긴 문단은 머리를 맞추고, 끝을 넘지 않는다', () => {
  const o = offsetsOf([100, 100, 1000, 100, 100])
  assert.equal(scrollTopFor(o, 1, 500, 'center'), Math.max(0, 100 - 200))     // 가운데
  assert.equal(scrollTopFor(o, 2, 500, 'center'), 200 - 16)                   // 칸보다 긴 문단
  assert.equal(scrollTopFor(o, 4, 500, 'center'), 1400 - 500)                 // 끝을 넘지 않는다
})

test('창을 쓰는 기준 — 3천 문단은 전부 그려도 빨랐다(실측)', () => {
  assert.equal(WINDOW_FROM, 3000)
})
