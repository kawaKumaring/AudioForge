// 파형 불러오기 — 우리가 끊은 것은 조용히 'cancelled', 진짜 실패만 던진다(2026-10-03).
import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 요구하는 명시적 .ts 확장자
import { loadWave } from './waveLoad.ts'

const okFetch = (async () => new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 })) as unknown as typeof fetch

test('받아서 파형에 넣는다', async () => {
  const got: Blob[] = []
  const r = await loadWave({ loadBlob: async (b) => { got.push(b) } }, 'local-file://x', new AbortController().signal, okFetch)
  assert.equal(r, 'loaded'); assert.equal(got.length, 1); assert.equal(got[0].size, 3)
})

test('★우리가 끊으면(받는 중) 던지지 않고 cancelled — 파형에 넣지 않는다', async () => {
  const ctl = new AbortController()
  const slow = ((_u: string, init: RequestInit) => new Promise<Response>((_, rej) => {
    init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })) as unknown as typeof fetch
  let loaded = 0
  const p = loadWave({ loadBlob: async () => { loaded++ } }, 'u', ctl.signal, slow)
  ctl.abort()
  assert.equal(await p, 'cancelled'); assert.equal(loaded, 0)
})

test('받은 뒤 넣기 전에 끊겨도 cancelled', async () => {
  const ctl = new AbortController()
  const f = (async () => { ctl.abort(); return new Response(new Blob(['a']), { status: 200 }) }) as unknown as typeof fetch
  let loaded = 0
  assert.equal(await loadWave({ loadBlob: async () => { loaded++ } }, 'u', ctl.signal, f), 'cancelled'); assert.equal(loaded, 0)
})

test('진짜 실패(없는 파일 · 해독 실패)는 던진다 — 취소와 섞지 않는다', async () => {
  const notFound = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
  await assert.rejects(loadWave({ loadBlob: async () => {} }, 'u', new AbortController().signal, notFound), /404/)
  await assert.rejects(loadWave({ loadBlob: async () => { throw new Error('해독 실패') } }, 'u', new AbortController().signal, okFetch), /해독 실패/)
})
