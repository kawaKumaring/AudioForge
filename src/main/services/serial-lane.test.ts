import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSerialLane } from './serial-lane.ts'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

test('겹쳐 들어와도 거절하지 않고 차례로 실행한다', async () => {
  const lane = createSerialLane()
  const order: string[] = []
  let releaseA: (() => void) | null = null
  const a = lane.run(async () => {
    order.push('a-start')
    await new Promise<void>((r) => { releaseA = r })
    order.push('a-end')
    return 'A'
  })
  const b = lane.run(async () => { order.push('b-start'); return 'B' })
  await tick()
  assert.deepEqual(order, ['a-start'], 'b 는 a 가 끝나기 전에 시작하지 않는다')
  assert.equal(lane.pending, 2)
  releaseA!()
  assert.equal(await a, 'A')
  assert.equal(await b, 'B')
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start'])
  assert.equal(lane.running, false, '줄이 비면 running 이 내려간다')
})

test('앞 작업이 실패해도 뒤 작업은 실행된다 — 한 번의 실패가 이후를 막지 않는다', async () => {
  const lane = createSerialLane()
  const failed = lane.run(async () => { throw new Error('첫 작업 실패') })
  const after = lane.run(async () => 'ok')
  await assert.rejects(failed, /첫 작업 실패/)
  assert.equal(await after, 'ok')
  assert.equal(lane.running, false)
})

test('실행 중에는 running 이 true — 상위 계약(합성 차단)이 이 값을 읽는다', async () => {
  const lane = createSerialLane()
  assert.equal(lane.running, false)
  let release: (() => void) | null = null
  const p = lane.run(async () => { await new Promise<void>((r) => { release = r }) })
  assert.equal(lane.running, true, '대기·실행 중이면 true')
  await tick()          // 차선은 마이크로태스크 뒤에 fn 을 시작한다
  release!()
  await p
  assert.equal(lane.running, false)
})

test('오류는 삼키지 않고 부른 쪽으로 그대로 던진다', async () => {
  const lane = createSerialLane()
  await assert.rejects(lane.run(async () => { throw new Error('그대로') }), /그대로/)
})
