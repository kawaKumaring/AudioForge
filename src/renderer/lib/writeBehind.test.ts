// 화면 밖 지연 저장기 — 화면 수명과 저장 수명 분리 · 순서 · 실패·재시도 · 미루기 · 지우기 · 닫는 순간.
// ★왜(2026-10-02 관리자 검수): 낭독 위치·서재 보기가 화면 안 effect 의 타이머라 화면을 떠나면 취소돼 디스크에 안 남았다.
import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 요구하는 명시적 .ts 확장자
import { createWriteBehind } from './writeBehind.ts'

/** 손으로 돌리는 타이머 — 시간을 흘려 보낸다. */
function fakeTimers() {
  let now = 0, id = 0
  const jobs = new Map<number, { at: number; fn: () => void }>()
  return {
    set: (fn: () => void, ms: number) => { jobs.set(++id, { at: now + ms, fn }); return id },
    clear: (t: unknown) => { jobs.delete(t as number) },
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...jobs].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        jobs.delete(due[0]); now = due[1].at; due[1].fn()
      }
      now = end
    },
    count: () => jobs.size,
  }
}
const tick = () => new Promise<void>((r) => setImmediate(r))
/** 디스크 대역 — 쓴 순서와 마지막 값을 본다. 지연·실패를 마음대로 건다. */
function fakeDisk() {
  const disk = new Map<string, number>()
  const log: Array<[string, number]> = []
  const gate: { wait: Promise<void> | null } = { wait: null }
  const failNext: { n: number; code: string } = { n: 0, code: 'DISK_FULL' }
  return {
    disk, log, gate, failNext,
    write: async (k: string, v: number) => {
      if (gate.wait) await gate.wait
      if (failNext.n > 0) { failNext.n--; return failNext.code }
      disk.set(k, v); log.push([k, v]); return ''
    },
  }
}

test('화면이 사라져도 예약한 저장은 산다 — 값은 쓰는 순간 읽는다', async () => {
  const t = fakeTimers(), d = fakeDisk()
  const s = createWriteBehind<number>({ delayMs: 600, write: d.write, timers: t })
  let position = 0
  s.queue('book', () => position)
  position = 25                       // 예약 뒤에 바뀐 값 — 화면(effect 정리)이 없어도 최신이 쓰인다
  t.advance(599); await tick()
  assert.equal(d.disk.has('book'), false)
  t.advance(1); await tick()
  assert.equal(d.disk.get('book'), 25)
  assert.equal(s.state('book').phase, 'saved')
})

test('여러 번 예약해도 멎은 뒤 한 번만 쓴다', async () => {
  const t = fakeTimers(), d = fakeDisk()
  const s = createWriteBehind<number>({ delayMs: 600, write: d.write, timers: t })
  let v = 0
  for (let i = 1; i <= 5; i++) { v = i; s.queue('k', () => v); t.advance(300) }
  t.advance(600); await tick()
  assert.deepEqual(d.log, [['k', 5]])
})

test('느린 앞 쓰기가 뒤 쓰기를 덮지 않는다(순서 보장)', async () => {
  const t = fakeTimers(), d = fakeDisk()
  const s = createWriteBehind<number>({ delayMs: 10, write: d.write, timers: t })
  let release!: () => void
  d.gate.wait = new Promise<void>((r) => { release = r })
  let v = 1
  s.queue('k', () => v); t.advance(10); await tick()        // 1 을 쓰는 중(느리다)
  v = 2; s.queue('k', () => v); t.advance(10); await tick()  // 2 가 예약됐지만 앞 쓰기가 아직이다
  assert.equal(d.log.length, 0)
  d.gate.wait = null; release(); await tick(); await tick()
  assert.deepEqual(d.log, [['k', 1], ['k', 2]], '앞이 먼저, 최신이 마지막')
  assert.equal(d.disk.get('k'), 2)
})

test('실패는 성공이 아니다 — 값을 남기고 다시 시도하고, 사람이 바로 다시 할 수도 있다', async () => {
  const t = fakeTimers(), d = fakeDisk()
  const s = createWriteBehind<number>({ delayMs: 10, write: d.write, retryDelays: [100, 200], timers: t })
  const seen: string[] = []
  s.onState((k, st) => seen.push(st.phase))
  d.failNext.n = 2
  s.queue('k', () => 7); t.advance(10); await tick()
  assert.equal(s.state('k').phase, 'failed'); assert.equal(s.state('k').code, 'DISK_FULL')
  assert.deepEqual(s.failed(), ['k']); assert.equal(d.disk.has('k'), false)
  t.advance(100); await tick()                              // 첫 재시도 — 또 실패
  assert.equal(s.state('k').phase, 'failed')
  t.advance(200); await tick()                              // 둘째 재시도 — 성공
  assert.equal(d.disk.get('k'), 7); assert.equal(s.state('k').phase, 'saved'); assert.deepEqual(s.failed(), [])
  assert.ok(seen.includes('failed') && seen.at(-1) === 'saved')
})

test('자동 재시도를 다 쓰면 멈추고 failed 로 남는다 — retry 로 다시 쓴다', async () => {
  const t = fakeTimers(), d = fakeDisk()
  const s = createWriteBehind<number>({ delayMs: 10, write: d.write, retryDelays: [50], timers: t })
  d.failNext.n = 5
  s.queue('k', () => 3); t.advance(10); await tick(); t.advance(50); await tick(); t.advance(1000); await tick()
  assert.equal(s.state('k').phase, 'failed'); assert.equal(t.count(), 0, '더는 자동으로 다시 시도하지 않는다')
  d.failNext.n = 0
  assert.equal(await s.retry('k'), ''); assert.equal(d.disk.get('k'), 3)
})

test('쓰다 던져도 실패로 센다', async () => {
  const t = fakeTimers()
  const s = createWriteBehind<number>({ delayMs: 1, write: async () => { throw new Error('IPC 끊김') }, timers: t })
  s.queue('k', () => 1); t.advance(1); await tick()
  assert.equal(s.state('k').phase, 'failed'); assert.equal(s.state('k').code, 'IPC 끊김')
})

test('hold 동안은 미루고, 풀리면 최신 값으로 쓴다 — flush 는 미룬 상태에서도 쓴다', async () => {
  const t = fakeTimers(), d = fakeDisk()
  const s = createWriteBehind<number>({ delayMs: 10, write: d.write, timers: t })
  let v = 1
  const release = s.hold()
  s.queue('k', () => v); t.advance(10); await tick()
  assert.equal(d.log.length, 0, '미뤘다')
  v = 2; release(); await tick()
  assert.deepEqual(d.log, [['k', 2]], '풀리면 그 시점의 최신 값')
  const r2 = s.hold(); v = 3; s.queue('k', () => v)
  assert.equal(await s.flush('k'), ''); assert.equal(d.disk.get('k'), 3, 'flush 는 미룬 것도 쓴다'); r2()
})

test('writeNow 는 쓰던 것 뒤에 서서 쓰고 예약을 대신한다', async () => {
  const t = fakeTimers(), d = fakeDisk()
  const s = createWriteBehind<number>({ delayMs: 10, write: d.write, timers: t })
  let release!: () => void
  d.gate.wait = new Promise<void>((r) => { release = r })
  s.queue('k', () => 1); t.advance(10); await tick()
  const done = s.writeNow('k', 9)
  d.gate.wait = null; release()
  assert.equal(await done, '')
  assert.deepEqual(d.log, [['k', 1], ['k', 9]])
})

test('지우는 기록은 더 쓰지 않는다 — 쓰던 것은 기다리고, 예약은 버린다', async () => {
  const t = fakeTimers(), d = fakeDisk()
  const s = createWriteBehind<number>({ delayMs: 10, write: d.write, timers: t })
  s.queue('k', () => 1); t.advance(10); await tick()
  s.queue('k', () => 2)
  await s.discard('k')
  t.advance(1000); await tick()
  assert.deepEqual(d.log, [['k', 1]], '지운 뒤 예약은 쓰이지 않는다')
  s.queue('k', () => 3); t.advance(1000); await tick()
  assert.equal(d.log.length, 1, '지우는 중에는 새 예약도 받지 않는다')
  s.restore('k'); s.queue('k', () => 4); t.advance(10); await tick()
  assert.equal(d.disk.get('k'), 4, '지우기가 실패하면 되돌려 다시 쓴다')
})

test('쓰는 중에 지우면 그 결과를 올리지 않는다', async () => {
  const t = fakeTimers(), d = fakeDisk()
  const s = createWriteBehind<number>({ delayMs: 1, write: d.write, timers: t })
  let release!: () => void
  d.gate.wait = new Promise<void>((r) => { release = r })
  s.queue('k', () => 1); t.advance(1); await tick()
  const gone = s.discard('k'); d.gate.wait = null; release(); await gone
  assert.equal(s.failed().length, 0)
})

test('닫는 순간(flushSync)에는 기다리는 값을 동기 통로로 남긴다', async () => {
  const t = fakeTimers(), d = fakeDisk()
  const sync: Array<[string, number]> = []
  const s = createWriteBehind<number>({ delayMs: 600, write: d.write, writeSync: (k, v) => { sync.push([k, v]); return '' }, timers: t })
  s.queue('a', () => 5); s.queue('b', () => 6)
  s.flushSync()
  assert.deepEqual(sync.sort(), [['a', 5], ['b', 6]])
  assert.equal(s.pending().length, 0, '남긴 것은 더는 기다리지 않는다')
  t.advance(1000); await tick()
  assert.equal(d.log.length, 0, '이중으로 쓰지 않는다')
})

test('getter 가 undefined 를 돌려주면(기록이 사라짐) 쓰지 않는다', async () => {
  const t = fakeTimers(), d = fakeDisk()
  const s = createWriteBehind<number>({ delayMs: 1, write: d.write, timers: t })
  s.queue('k', () => undefined); t.advance(1); await tick()
  assert.equal(d.log.length, 0)
})

test('writeNow: 쓰는 사이 들어온 예약을 잃지 않는다', async () => {
  const t = fakeTimers(), d = fakeDisk()
  const s = createWriteBehind<number>({ delayMs: 10, write: d.write, timers: t })
  let release!: () => void
  d.gate.wait = new Promise<void>((r) => { release = r })
  const done = s.writeNow('k', 9)             // 느리게 쓰는 중
  await tick()
  let latest = 5
  s.queue('k', () => latest)                   // 그 사이 들어온 예약
  d.gate.wait = null; release(); await done
  t.advance(10); await tick()
  assert.deepEqual(d.log, [['k', 9], ['k', 5]], '맡겨 둔 예약은 그다음에 쓰인다')
})

test('writeNow 가 실패하면 그 값을 남기지 않는다 — 몰래 다시 쓰지 않는다', async () => {
  const t = fakeTimers(), d = fakeDisk()
  const s = createWriteBehind<number>({ delayMs: 10, write: d.write, retryDelays: [50, 50], timers: t })
  d.failNext.n = 1
  assert.equal(await s.writeNow('k', 9), 'DISK_FULL')
  t.advance(1000); await tick()
  assert.equal(d.log.length, 0, '실패한 일이 나중에 이뤄지지 않는다')
  assert.deepEqual(s.failed(), [], '다시 시도할 것이 없으니 실패 상태로 두지 않는다')
})
