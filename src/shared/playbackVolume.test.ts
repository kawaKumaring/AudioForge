// 재생 음량 값의 해석 계약.
//
// 왜 이 파일이 있는가(2026-09-10): 이 값은 설정 파일(사람이 고칠 수 있다)과 슬라이더(문자열)에서
// 온다. NaN 이 요소의 volume 에 들어가면 브라우저가 예외를 던져 **재생 자체가 죽는다** —
// 음량 하나 때문에 소리를 못 듣는 일이 되면 안 되므로, 이상한 값의 처리를 여기서 못 박는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PLAYBACK_VOLUME_DEFAULT, PLAYBACK_VOLUME_STORAGE_KEY,
  normalizePlaybackVolume, playbackVolumePercent,
} from './playbackVolume.ts'

test('보관 열쇠와 기본값은 고정이다 — 기본은 최대(예전 동작)', () => {
  assert.equal(PLAYBACK_VOLUME_STORAGE_KEY, 'playbackVolume')
  assert.equal(PLAYBACK_VOLUME_DEFAULT, 1)
})

test('0~1 안의 값은 그대로 지나간다', () => {
  for (const v of [0, 0.25, 0.5, 0.75, 1]) assert.equal(normalizePlaybackVolume(v), v)
})

test('범위를 벗어난 값은 양 끝으로 잘린다 — 음수·1 초과 모두', () => {
  assert.equal(normalizePlaybackVolume(-0.5), 0)
  assert.equal(normalizePlaybackVolume(-999), 0)
  assert.equal(normalizePlaybackVolume(1.5), 1)
  assert.equal(normalizePlaybackVolume(1e9), 1)
})

test('슬라이더가 주는 문자열도 수로 읽는다', () => {
  assert.equal(normalizePlaybackVolume('0.4'), 0.4)
  assert.equal(normalizePlaybackVolume('0'), 0)
  assert.equal(normalizePlaybackVolume('100'), 1)
})

test('알 수 없는 값은 기본값으로 되돌린다 — 재생을 죽이지 않는다', () => {
  for (const v of [NaN, Infinity, -Infinity, undefined, null, {}, [], 'abc', '']) {
    const got = normalizePlaybackVolume(v as unknown)
    assert.ok(Number.isFinite(got), `유한한 수가 나와야 한다: ${String(v)}`)
    assert.ok(got >= 0 && got <= 1, `0~1 이어야 한다: ${String(v)}`)
  }
  assert.equal(normalizePlaybackVolume(NaN), PLAYBACK_VOLUME_DEFAULT)
  assert.equal(normalizePlaybackVolume('abc'), PLAYBACK_VOLUME_DEFAULT)
})

test('빈 문자열은 0 이 아니라 기본값이다 — Number("") = 0 함정', () => {
  // 설정 파일에 빈 값이 남아 있을 때 소리가 조용히 0 이 되면 사용자는 앱이 고장 난 줄 안다.
  assert.equal(normalizePlaybackVolume(''), PLAYBACK_VOLUME_DEFAULT)
})

test('백분율은 0~100 정수다', () => {
  assert.equal(playbackVolumePercent(0), 0)
  assert.equal(playbackVolumePercent(0.5), 50)
  assert.equal(playbackVolumePercent(1), 100)
  assert.equal(playbackVolumePercent(0.333), 33)
  assert.equal(playbackVolumePercent(NaN), 100)
  assert.equal(playbackVolumePercent(2), 100)
  assert.equal(playbackVolumePercent(-1), 0)
})

test('null·undefined 는 0 이 아니라 기본값이다 — Number(null) = 0 함정', () => {
  assert.equal(normalizePlaybackVolume(null), PLAYBACK_VOLUME_DEFAULT)
  assert.equal(normalizePlaybackVolume(undefined), PLAYBACK_VOLUME_DEFAULT)
})
