// 재생 음량 소유자의 **동작**을 실제로 돌려 본다(모양 검사가 아니다).
//
// 왜 이 파일이 있는가(2026-09-10 사용자 보고 "소리가 항상 최대"): 이 앱의 재생 지점은 네 곳이고
// 각자 자기 소리 요소를 만든다. 음량이 한 곳에서만 걸리면 나머지는 조용히 최대로 남는다 —
// 그게 바로 이번에 보고된 증상이었다. 그래서 확인해야 하는 것은 값의 계산이 아니라
// "만들어진 모든 요소가 지금 음량을 갖는가" 다.
//
// 확인하는 것
//   1) 등록하면 지금 음량이 즉시 걸린다
//   2) 음량을 바꾸면 **이미 있는** 요소들이 함께 따라온다
//   3) 바꾼 뒤에 **새로 만든** 요소도 최대가 아니라 지금 음량으로 나온다(증상의 핵심)
//   4) 보관은 실패를 삼키지 않는다
//   5) 보관된 값을 읽어 적용한다 / 읽기가 실패해도 재생을 막지 않는다
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

class FakeAudio {
  volume = 1
  src = ''
  preload = ''
  constructor(src?: string) { if (src) this.src = src }
}
let settingsGet: () => Promise<unknown> = async () => ({})
let settingsSet: (k: string, v: unknown) => Promise<unknown> = async () => ({ ok: true })
const setCalls: { key: string; value: unknown }[] = []

;(globalThis as unknown as { Audio: unknown }).Audio = FakeAudio
;(globalThis as unknown as { window: unknown }).window = {
  api: {
    settings: {
      get: () => settingsGet(),
      set: (k: string, v: unknown) => { setCalls.push({ key: k, value: v }); return settingsSet(k, v) },
    },
  },
}

const {
  attachPlaybackVolume, createManagedAudio, getPlaybackVolume, setPlaybackVolume,
  onPlaybackVolumeChange, loadPlaybackVolume, savePlaybackVolume,
} = await import('./playbackVolume.ts')
const { PLAYBACK_VOLUME_STORAGE_KEY } = await import('../../shared/playbackVolume.ts')

const el = () => new FakeAudio() as unknown as HTMLMediaElement

beforeEach(() => {
  setCalls.length = 0
  settingsGet = async () => ({})
  settingsSet = async () => ({ ok: true })
  setPlaybackVolume(1)
})

test('등록하면 지금 음량이 즉시 걸린다', () => {
  setPlaybackVolume(0.3)
  const a = el()
  attachPlaybackVolume(a)
  assert.equal(a.volume, 0.3)
})

test('음량을 바꾸면 이미 있는 요소들이 함께 따라온다', () => {
  const a = el(); const b = el()
  attachPlaybackVolume(a); attachPlaybackVolume(b)
  setPlaybackVolume(0.5)
  assert.equal(a.volume, 0.5)
  assert.equal(b.volume, 0.5)
  setPlaybackVolume(0)
  assert.equal(a.volume, 0)
  assert.equal(b.volume, 0)
})

test('바꾼 뒤 새로 만든 요소도 최대가 아니라 지금 음량이다 — 보고된 증상의 핵심', () => {
  setPlaybackVolume(0.2)
  const later = createManagedAudio()
  assert.equal(later.volume, 0.2, '새 요소가 1.0(최대)으로 나가면 증상이 그대로 남는다')
  const withSrc = createManagedAudio('local-file://x.wav')
  assert.equal(withSrc.volume, 0.2)
  assert.equal(withSrc.src, 'local-file://x.wav', '소스는 그대로 전달된다')
})

test('같은 요소를 여러 번 등록해도 값만 다시 걸린다(중복 등록 무해)', () => {
  const a = el()
  attachPlaybackVolume(a); attachPlaybackVolume(a); attachPlaybackVolume(a)
  setPlaybackVolume(0.4)
  assert.equal(a.volume, 0.4)
})

test('없는 요소를 등록해도 터지지 않는다', () => {
  attachPlaybackVolume(null)
  attachPlaybackVolume(undefined)
  assert.equal(getPlaybackVolume(), 1)
})

test('알 수 없는 값이 들어와도 요소의 volume 은 유한하다 — 재생이 죽지 않는다', () => {
  const a = el()
  attachPlaybackVolume(a)
  setPlaybackVolume('abc')
  assert.ok(Number.isFinite(a.volume) && a.volume >= 0 && a.volume <= 1)
})

test('음량 변경을 화면에 알린다 / 해제하면 더 오지 않는다', () => {
  const seen: number[] = []
  const off = onPlaybackVolumeChange((v) => seen.push(v))
  setPlaybackVolume(0.6)
  setPlaybackVolume(0.1)
  off()
  setPlaybackVolume(0.9)
  assert.deepEqual(seen, [0.6, 0.1], '해제 뒤의 변경은 오지 않는다')
})

test('보관은 지금 음량을 그 열쇠로 한 번 보낸다', async () => {
  setPlaybackVolume(0.35)
  const r = await savePlaybackVolume()
  assert.equal(r.ok, true)
  assert.deepEqual(setCalls, [{ key: PLAYBACK_VOLUME_STORAGE_KEY, value: 0.35 }])
})

test('보관 실패를 삼키지 않는다 — 거부 응답과 예외 모두', async () => {
  settingsSet = async () => ({ ok: false, code: 'DISK_FULL' })
  const bad = await savePlaybackVolume()
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'DISK_FULL')

  settingsSet = async () => { throw new Error('boom') }
  const thrown = await savePlaybackVolume()
  assert.equal(thrown.ok, false)
})

test('보관된 값을 읽어 적용한다 — 등록된 요소까지 함께 내려간다', async () => {
  const a = el()
  attachPlaybackVolume(a)
  settingsGet = async () => ({ [PLAYBACK_VOLUME_STORAGE_KEY]: 0.45 })
  const got = await loadPlaybackVolume()
  assert.equal(got, 0.45)
  assert.equal(getPlaybackVolume(), 0.45)
  assert.equal(a.volume, 0.45)
})

test('보관된 값이 없거나 읽기가 실패하면 지금 값을 그대로 둔다 — 재생을 막지 않는다', async () => {
  settingsGet = async () => ({})
  assert.equal(await loadPlaybackVolume(), 1)

  settingsGet = async () => ({ [PLAYBACK_VOLUME_STORAGE_KEY]: null })
  assert.equal(await loadPlaybackVolume(), 1)

  settingsGet = async () => { throw new Error('읽기 실패') }
  assert.equal(await loadPlaybackVolume(), 1)
})

test('보관된 값이 이상하면 0 으로 떨어지지 않는다 — 빈 값 함정', async () => {
  settingsGet = async () => ({ [PLAYBACK_VOLUME_STORAGE_KEY]: '' })
  assert.equal(await loadPlaybackVolume(), 1, '빈 값 때문에 소리가 조용히 꺼지면 고장으로 보인다')
})
