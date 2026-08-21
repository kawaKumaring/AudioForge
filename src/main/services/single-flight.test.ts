// single-flight 회귀 — 동시 요청 합치기, 완료 후 해제(재시도), 키별 격리.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSingleFlight, createKeyedSingleFlight } from './single-flight.ts'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('createSingleFlight: 동시 2회 → fn 1회, 같은 결과', async () => {
  const sf = createSingleFlight<number>()
  let calls = 0
  const d = deferred<number>()
  const fn = () => { calls++; return d.promise }
  const a = sf.run(fn)
  const b = sf.run(fn)
  assert.equal(sf.running, true)
  d.resolve(42)
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(calls, 1, 'fn은 1회만 호출')
  assert.equal(ra, 42); assert.equal(rb, 42)
  // 정착 후 해제되어 다음 run은 새로 실행
  await Promise.resolve()
  assert.equal(sf.running, false)
  const d2 = deferred<number>()
  const c = sf.run(() => { calls++; return d2.promise })
  d2.resolve(7); assert.equal(await c, 7); assert.equal(calls, 2)
})

test('createSingleFlight: 첫 요청 실패 → 해제 → 재시도 성공', async () => {
  const sf = createSingleFlight<string>()
  let calls = 0
  await assert.rejects(sf.run(async () => { calls++; throw new Error('boom') }), /boom/)
  await Promise.resolve()
  assert.equal(sf.running, false, '오류 후에도 해제')
  const r = await sf.run(async () => { calls++; return 'ok' })
  assert.equal(r, 'ok'); assert.equal(calls, 2, '재시도는 fn 재호출')
})

test('createKeyedSingleFlight: 같은 key 동시 → 1회, 다른 key는 격리', async () => {
  const sf = createKeyedSingleFlight<string>()
  const dA = deferred<string>()
  const dB = deferred<string>()
  let aCalls = 0, bCalls = 0
  const a1 = sf.run('A', () => { aCalls++; return dA.promise })
  const a2 = sf.run('A', () => { aCalls++; return dA.promise })
  const b1 = sf.run('B', () => { bCalls++; return dB.promise })
  assert.equal(sf.has('A'), true); assert.equal(sf.has('B'), true)
  dA.resolve('resA'); dB.resolve('resB')
  assert.equal(await a1, 'resA'); assert.equal(await a2, 'resA')
  assert.equal(await b1, 'resB')
  assert.equal(aCalls, 1, 'key A는 1회'); assert.equal(bCalls, 1, 'key B는 1회')
  // 서로 다른 파일(key)의 결과가 섞이지 않음
  assert.notEqual(await a1, await b1)
  await Promise.resolve()
  assert.equal(sf.has('A'), false); assert.equal(sf.has('B'), false)
})

test('createKeyedSingleFlight: key 실패 → 해제 → 같은 key 재시도 성공', async () => {
  const sf = createKeyedSingleFlight<string>()
  let calls = 0
  await assert.rejects(sf.run('K', async () => { calls++; throw new Error('x') }), /x/)
  await Promise.resolve()
  assert.equal(sf.has('K'), false)
  assert.equal(await sf.run('K', async () => { calls++; return 'ok' }), 'ok')
  assert.equal(calls, 2)
})
