// 끌기 중 끝자리 굴림 — 속도 규칙(2026-10-03). 화면 동작은 synthesis-cards.e2e 가 실제 앱에서 본다.
import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 요구하는 명시적 .ts 확장자
import { edgeVelocity } from './useDragEdgeScroll.ts'

test('칸 가운데에서는 굴리지 않는다', () => {
  assert.equal(edgeVelocity(400, 150, 750), 0)
})

test('아래 끝에 가까울수록 빠르게 아래로, 위 끝은 위로', () => {
  const near = edgeVelocity(750 - 10, 150, 750), far = edgeVelocity(750 - 60, 150, 750)
  assert.ok(near > far && far > 0, `${near} > ${far} > 0`)
  assert.ok(edgeVelocity(150 + 10, 150, 750) < 0)
})

test('칸 밖(아래 고정 막대 위·위 머리)은 최대 속도로 그쪽', () => {
  assert.equal(edgeVelocity(800, 150, 750), 22)
  assert.equal(edgeVelocity(100, 150, 750), -22)
})

test('아주 낮은 칸에서도 가운데에는 멈춘 자리가 있다', () => {
  assert.equal(edgeVelocity(200, 150, 250), 0)
  assert.ok(edgeVelocity(245, 150, 250) > 0)
})
