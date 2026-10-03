// 준비 중에 계획이 바뀌면 **이전 미리듣기를 재생하지 않는다** (2026-09-27 검수 2항 [P2]).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { previewStale, previewStaleText, playbackStale } from './joinPreviewGate.ts'

const now = (over: Partial<{ gen: number; key: string; alive: boolean }> = {}) =>
  ({ gen: 1, key: 'plan-a', alive: true, ...over })

test('같은 세대·같은 계획이면 재생한다', () => {
  assert.equal(previewStale({ gen: 1, key: 'plan-a' }, now()), '')
})

// ★이것이 이 파일의 존재 이유다.
test('준비 중 계획이 바뀌면 이전 결과를 재생하지 않는다', () => {
  assert.equal(previewStale({ gen: 1, key: 'plan-a' }, now({ key: 'plan-b' })), 'changed')
})

test('그 사이 새 요청이 시작됐으면 지난 응답은 버린다', () => {
  assert.equal(previewStale({ gen: 1, key: 'plan-a' }, now({ gen: 2 })), 'newer')
})

test('화면이 사라졌으면 재생하지 않는다', () => {
  assert.equal(previewStale({ gen: 1, key: 'plan-a' }, now({ alive: false })), 'gone')
})

test('화면이 사라진 것이 먼저다 — 계획이 같아도 재생하지 않는다', () => {
  assert.equal(previewStale({ gen: 1, key: 'plan-a' }, now({ alive: false, key: 'plan-a' })), 'gone')
})

test('계획을 바꿨다가 되돌려도 세대가 다르면 지난 응답이다', () => {
  assert.equal(previewStale({ gen: 1, key: 'plan-a' }, now({ gen: 3, key: 'plan-a' })), 'newer')
})

test('바뀐 경우만 말한다 — 새 요청이 돌고 있으면 그 요청이 말한다', () => {
  assert.match(previewStaleText('changed'), /다시 들어/)
  assert.equal(previewStaleText('newer'), '')
  assert.equal(previewStaleText('gone'), '')
  assert.equal(previewStaleText(''), '')
})

test('울리는 중에 계획이 바뀌면 멈춘다', () => {
  assert.equal(playbackStale('plan-a', 'plan-b'), true)
  assert.equal(playbackStale('plan-a', 'plan-a'), false)
  assert.equal(playbackStale('', 'plan-b'), false, '울리는 것이 없으면 멈출 것도 없다')
})
