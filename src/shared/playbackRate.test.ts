import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import { normalizePlaybackRate, playbackRateLabel, PLAYBACK_RATES, PLAYBACK_RATE_DEFAULT, PLAYBACK_RATE_STORAGE_KEY } from './playbackRate.ts'

test('보관 열쇠와 단계 — 기본은 만든 그대로(1배)', () => {
  assert.equal(PLAYBACK_RATE_STORAGE_KEY, 'playbackRate')
  assert.equal(PLAYBACK_RATE_DEFAULT, 1)
  assert.deepEqual([...PLAYBACK_RATES], [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2])
})

test('★이상한 값은 기본으로 — 재생이 죽거나 소리가 사라지지 않게', () => {
  for (const v of [null, undefined, '', '  ', 'abc', NaN, 0, -1, Infinity]) assert.equal(normalizePlaybackRate(v), 1, String(v))
})

test('범위 안의 값은 가장 가까운 단계로 · 넘치면 끝 단계로', () => {
  assert.equal(normalizePlaybackRate(1.3), 1.25)
  assert.equal(normalizePlaybackRate('1.5'), 1.5)
  assert.equal(normalizePlaybackRate(0.1), 0.5)
  assert.equal(normalizePlaybackRate(16), 2)
})

test('보여 줄 글', () => {
  assert.equal(playbackRateLabel(1), '1.0×')
  assert.equal(playbackRateLabel(2), '2.0×')
  assert.equal(playbackRateLabel(1.25), '1.25×')
  assert.equal(playbackRateLabel(0.75), '0.75×')
})
