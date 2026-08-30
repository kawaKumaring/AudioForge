// 상주 분석 worker 계약 — 실제 Python 없이 가짜 프로세스로 고정한다.
//
// 지키는 것:
//   · 타이핑마다 프로세스를 새로 띄우지 않는다(한 번 띄우고 재사용)
//   · 늦게 온 이전 응답은 SUPERSEDED 로 버린다
//   · 멈춘 worker 는 타임아웃으로 놓아주고 다음 요청에서 새로 띄운다
//   · worker 가 죽어도 예외를 던지지 않는다 — 편집·합성을 막지 않는다(fail-open)
//   · 모드 전환·종료 시 대기 요청을 정리한다
//   · 되살리기는 유한하다
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AnalysisWorker, MAX_CONSECUTIVE_FAILURES, sha256Hex } from './analysis-worker.ts'

class FakeStream extends EventEmitter {
  written: string[] = []
  writable = true
  destroyed = false
  writableEnded = false
  /** 다음 write 를 이 오류로 실패시킨다(EPIPE 흉내 — callback 으로 온다). */
  failNext: NodeJS.ErrnoException | null = null
  /** write 를 동기 예외로 던진다. */
  throwOnWrite: Error | null = null
  setEncoding() { /* 실제 스트림 흉내 */ }
  write(s: string, cb?: (err?: Error | null) => void) {
    if (this.throwOnWrite) throw this.throwOnWrite
    this.written.push(s)
    const err = this.failNext
    this.failNext = null
    if (cb) queueMicrotask(() => cb(err ?? null))   // 실제 스트림처럼 비동기
    return true
  }
  end() { this.writableEnded = true }
  close() { this.writable = false; this.destroyed = true }
}

const epipe = (): NodeJS.ErrnoException => {
  const e = new Error('write EPIPE') as NodeJS.ErrnoException
  e.code = 'EPIPE'
  return e
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

class FakeProc extends EventEmitter {
  stdin = new FakeStream()
  stdout = new FakeStream()
  stderr = new FakeStream()
  exitCode: number | null = null
  killed = false
  kill() {
    if (this.killed) return true
    this.killed = true
    this.exitCode = 1
    this.stdin.close()
    this.emit('exit')
    return true
  }
  /** 프로세스는 아직 살아 있다고 보이지만 파이프만 닫힌 상태. */
  breakPipe() { this.stdin.close() }
  /** worker 가 한 줄 응답을 보낸 것처럼 만든다. */
  reply(obj: Record<string, unknown>) { this.stdout.emit('data', JSON.stringify(obj) + '\n') }
  requests() {
    return this.stdin.written.map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((m) => m.type === 'analyze')
  }
}

function make(opts: { timeoutMs?: number; failSpawn?: boolean } = {}) {
  const procs: FakeProc[] = []
  const w = new AnalysisWorker({
    spawn: (() => {
      if (opts.failSpawn) throw new Error('spawn 실패')
      const p = new FakeProc()
      procs.push(p)
      return p as never
    }) as never,
    pythonPath: () => 'python',
    scriptPath: () => 'analysis_worker.py',
    timeoutMs: opts.timeoutMs ?? 30_000,
  })
  return { w, procs, last: () => procs[procs.length - 1] }
}

const ok = (id: string, sha: string) =>
  ({ type: 'analysis', request_id: id, ok: true, source_sha256: sha })

test('프로세스를 한 번만 띄우고 재사용한다', async () => {
  const { w, procs, last } = make()
  const a = w.analyze({ requestId: 'a', text: '가' })
  last().reply(ok('a', sha256Hex('가')))
  await a
  const b = w.analyze({ requestId: 'b', text: '나' })
  last().reply(ok('b', sha256Hex('나')))
  await b
  assert.equal(procs.length, 1, '요청마다 새 프로세스를 띄우면 안 된다')
  assert.equal(last().requests().length, 2)
})

test('요청 본문에 원문 SHA 를 함께 보낸다', async () => {
  const { w, last } = make()
  const p = w.analyze({ requestId: 'a', text: '가나다' })
  const req = last().requests()[0]
  assert.equal(req.source_sha256, sha256Hex('가나다'))
  assert.equal(req.request_id, 'a')
  last().reply(ok('a', sha256Hex('가나다')))
  await p
})

test('이미 계산된 낡은 응답은 SUPERSEDED 로 버린다', async () => {
  const { w, last } = make()
  const first = w.analyze({ requestId: 'old', text: '가' })
  const second = w.analyze({ requestId: 'new', text: '가나' })
  // 이미 계산에 들어간 요청은 중간에 끊기지 않는다 — 답이 와도 화면에 가면 안 된다.
  // 이 폐기는 drop_before 가 아니라 request_id/SHA 판정이 한다.
  last().reply(ok('old', sha256Hex('가')))
  last().reply(ok('new', sha256Hex('가나')))
  const r1 = await first as Record<string, unknown>
  const r2 = await second as Record<string, unknown>
  assert.equal(r1.ok, false)
  assert.equal(r1.code, 'SUPERSEDED')
  assert.equal(r2.ok, true)
})

test('새 요청은 worker 에게 아직 시작하지 않은 대기 요청을 건너뛰라고 알린다', async () => {
  // drop_before 는 **큐에 남은** 요청만 생략시킨다. 이미 계산 중인 것은 끝까지 가고,
  // 그 결과는 SUPERSEDED 판정에서 버려진다.
  const { w, last } = make()
  const p = w.analyze({ requestId: 'a', text: '가' })
  const drops = last().stdin.written.map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((m) => m.type === 'drop_before')
  assert.ok(drops.length >= 1, 'drop_before 가 없으면 대기 중인 낡은 요청까지 계산한다')
  last().reply(ok('a', sha256Hex('가')))
  await p
})

test('멈춘 worker 는 타임아웃으로 놓아주고 다음 요청에서 새로 띄운다', async () => {
  const { w, procs } = make({ timeoutMs: 20 })
  const r = await w.analyze({ requestId: 'a', text: '가' }) as Record<string, unknown>
  assert.equal(r.ok, false)
  assert.equal(r.code, 'WORKER_TIMEOUT')
  assert.equal(procs[0].killed, true, '멈춘 프로세스를 붙들면 안 된다')
  const p2 = w.analyze({ requestId: 'b', text: '나' })
  assert.equal(procs.length, 2, '다음 요청에서 새로 띄워야 한다')
  procs[1].reply(ok('b', sha256Hex('나')))
  assert.equal(((await p2) as Record<string, unknown>).ok, true)
})

test('worker 가 죽어도 예외 대신 구조화된 실패를 돌려준다', async () => {
  const { w, last } = make()
  const p = w.analyze({ requestId: 'a', text: '가' })
  last().emit('exit')
  const r = await p as Record<string, unknown>
  assert.equal(r.ok, false)
  assert.equal(r.code, 'WORKER_UNAVAILABLE')
})

test('프로세스를 못 띄워도 편집을 막지 않는다', async () => {
  const { w } = make({ failSpawn: true })
  const r = await w.analyze({ requestId: 'a', text: '가' }) as Record<string, unknown>
  assert.equal(r.ok, false)
  assert.equal(r.code, 'WORKER_UNAVAILABLE')
})

test('연속 실패가 상한에 닿으면 잠시 분석을 접는다', async () => {
  const { w } = make({ failSpawn: true })
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES + 2; i += 1) {
    await w.analyze({ requestId: `r${i}`, text: '가' })
  }
  assert.equal(w.consecutiveFailureCount >= MAX_CONSECUTIVE_FAILURES, true,
    '무한 재시작은 배터리를 태운다')
  const r = await w.analyze({ requestId: 'last', text: '가' }) as Record<string, unknown>
  assert.equal(r.code, 'WORKER_UNAVAILABLE')
})

test('상한은 **연속** 실패 기준이다 — 성공하면 초기화된다', async () => {
  // 앱 수명 동안 드문드문 세 번 죽었다고 남은 세션 내내 분석이 꺼지면 안 된다.
  const procs: FakeProc[] = []
  let fail = false
  const w = new AnalysisWorker({
    spawn: (() => {
      if (fail) throw new Error('spawn 실패')
      const p = new FakeProc()
      procs.push(p)
      return p as never
    }) as never,
    pythonPath: () => 'python',
    scriptPath: () => 'analysis_worker.py',
    timeoutMs: 30_000,
  })
  for (let round = 0; round < 3; round += 1) {
    fail = true
    // 살아 있는 프로세스가 있으면 spawn 자체가 일어나지 않는다 — 한 번만 죽인다.
    // (죽은 프로세스에 exit 를 또 쏘면 실패가 두 번 세어진다.)
    if (procs.length) procs[procs.length - 1].emit('exit')
    let guard = 0
    while (w.consecutiveFailureCount < MAX_CONSECUTIVE_FAILURES - 1 && guard < 10) {
      guard += 1
      const r = await w.analyze({ requestId: `f${round}-${guard}`, text: '가' }) as Record<string, unknown>
      assert.equal(r.code, 'WORKER_UNAVAILABLE')
    }
    assert.equal(w.consecutiveFailureCount, MAX_CONSECUTIVE_FAILURES - 1,
      '상한 직전까지만 쌓았는지 확인')
    fail = false
    const p = w.analyze({ requestId: `ok${round}`, text: '가' })
    procs[procs.length - 1].reply(ok(`ok${round}`, sha256Hex('가')))
    assert.equal(((await p) as Record<string, unknown>).ok, true)
    assert.equal(w.consecutiveFailureCount, 0, '성공했는데 실패 기록이 남아 있다')
  }
  assert.ok(w.restartCount >= (MAX_CONSECUTIVE_FAILURES - 1) * 3,
    '총 재시작은 계속 세되 상한 판정에는 쓰지 않는다')
})

test('prewarm 은 사용자 텍스트 없이 tokenizer 만 데운다', async () => {
  const { w, last } = make()
  const p = w.prewarm(1000)
  const sent = last().stdin.written.map((l) => JSON.parse(l) as Record<string, unknown>)
  assert.deepEqual(sent.filter((m) => m.type === 'prewarm'), [{ type: 'prewarm' }],
    'prewarm 요청에 사용자 텍스트가 실리면 안 된다')
  assert.equal(sent.some((m) => m.type === 'analyze'), false)
  last().reply({ type: 'prewarm', ok: true, tokenizer: 'production' })
  assert.equal(await p, true)
})

test('prewarm 실패는 조용하고 이후 분석을 막지 않는다', async () => {
  const { w, last } = make()
  const p = w.prewarm(20)
  assert.equal(await p, false, '타임아웃이면 그냥 false 다')
  const a = w.analyze({ requestId: 'a', text: '가' })
  last().reply(ok('a', sha256Hex('가')))
  assert.equal(((await a) as Record<string, unknown>).ok, true)
})

test('handshake 는 연속 실패 기록을 지운다', async () => {
  const { w, last } = make()
  const p = w.analyze({ requestId: 'a', text: '가' })   // 여기서 프로세스가 떠 있다
  last().emit('exit')                                    // 한 번 죽어 실패가 하나 쌓인다
  await p
  assert.equal(w.consecutiveFailureCount, 1)
  const p2 = w.analyze({ requestId: 'b', text: '나' })   // 새로 띄운다
  last().reply({ type: 'ready', protocol_version: 1 })   // handshake 만 와도 살아 있는 것이다
  assert.equal(w.consecutiveFailureCount, 0)
  last().reply(ok('b', sha256Hex('나')))
  await p2
})

test('모드 전환·파일 변경은 대기 요청을 정리한다', async () => {
  const { w, last } = make()
  const p1 = w.analyze({ requestId: 'a', text: '가' })
  const p2 = w.analyze({ requestId: 'b', text: '나' })
  assert.equal(w.cancelPending(), 2)
  for (const r of [await p1, await p2] as Record<string, unknown>[]) {
    assert.equal(r.ok, false)
    assert.equal(r.code, 'CANCELLED')
  }
  // 취소 뒤에 도착한 응답은 아무 상태도 건드리지 않는다.
  last().reply(ok('a', sha256Hex('가')))
})

test('dispose 는 정중히 닫고 남은 요청을 취소로 답한다', async () => {
  const { w, last } = make()
  const p = w.analyze({ requestId: 'a', text: '가' })
  const proc = last()
  w.dispose()
  const r = await p as Record<string, unknown>
  assert.equal(r.code, 'CANCELLED')
  const sent = proc.stdin.written.map((l) => JSON.parse(l) as Record<string, unknown>)
  assert.ok(sent.some((m) => m.type === 'shutdown'), 'shutdown 을 보내지 않았다')
  assert.equal(proc.killed, true)
})

test('깨진 줄과 모르는 메시지는 조용히 버린다', async () => {
  const { w, last } = make()
  const p = w.analyze({ requestId: 'a', text: '가' })
  last().stdout.emit('data', '{ this is not json\n')
  last().stdout.emit('data', JSON.stringify({ type: 'log', message: 'x' }) + '\n')
  last().reply(ok('a', sha256Hex('가')))
  assert.equal(((await p) as Record<string, unknown>).ok, true)
})

test('여러 줄이 한 번에 와도 나눠 읽는다', async () => {
  const { w, last } = make()
  const p1 = w.analyze({ requestId: 'a', text: '가' })
  const p2 = w.analyze({ requestId: 'b', text: '나' })
  last().stdout.emit('data',
    JSON.stringify(ok('a', sha256Hex('가'))) + '\n' + JSON.stringify(ok('b', sha256Hex('나'))) + '\n')
  assert.equal(((await p1) as Record<string, unknown>).code, 'SUPERSEDED')
  assert.equal(((await p2) as Record<string, unknown>).ok, true)
})

// ── 죽은 파이프 경쟁 조건 회귀 ────────────────────────────────────────────────
// 실제 앱에서 `Uncaught Exception: Error: write EPIPE` 로 main 이 터졌다. 아래가 그 경로들이다.
// 어느 경우에도 예외가 밖으로 나가지 않고, 요청은 유한 시간 안에 구조화 응답으로 끝나야 한다.

test('1. spawn 직후 종료된 worker 에 써도 예외가 나가지 않는다', async () => {
  const { w, last } = make()
  const p1 = w.analyze({ requestId: 'a', text: '가' })
  last().emit('exit')                       // 첫 요청 도중 죽는다
  assert.equal(((await p1) as Record<string, unknown>).code, 'WORKER_UNAVAILABLE')
  const before = last()
  const p2 = w.analyze({ requestId: 'b', text: '나' })
  assert.notEqual(last(), before, '죽은 worker 에 요청을 다시 썼다')
  last().reply(ok('b', sha256Hex('나')))
  assert.equal(((await p2) as Record<string, unknown>).ok, true)
})

test('2. prewarm 전송 중 stdin 이 닫혀도 조용히 끝난다', async () => {
  const { w, last } = make()
  const started = w.prewarm(60_000)
  last().breakPipe()                        // 파이프만 닫히고 exit 는 아직 안 온다
  last().emit('close')                      // 뒤늦게 close 가 온다
  assert.equal(await started, false, 'prewarm 이 타임아웃까지 매달리면 준비 상태가 안 풀린다')
})

test('3. analyze 전송 직전 파이프가 닫혀도 즉시 fail-open 으로 끝난다', async () => {
  const { w, last } = make()
  const p0 = w.analyze({ requestId: 'warm', text: '가' })
  last().reply(ok('warm', sha256Hex('가')))
  await p0
  last().breakPipe()                        // 쓰기 직전에 파이프가 닫혔다
  const t0 = Date.now()
  const r = await w.analyze({ requestId: 'a', text: '나' }) as Record<string, unknown>
  assert.equal(r.ok, false)
  assert.equal(r.code, 'WORKER_UNAVAILABLE')
  assert.ok(Date.now() - t0 < 1000, '타임아웃(30초)을 기다리면 UI 가 붙잡힌다')
})

test('4. write callback 으로 오는 EPIPE 를 실패로 다룬다', async () => {
  const { w, last } = make()
  const p0 = w.analyze({ requestId: 'warm', text: '가' })
  last().reply(ok('warm', sha256Hex('가')))
  await p0
  last().stdin.failNext = epipe()           // 동기 예외가 아니라 callback 오류로 온다
  const p = w.analyze({ requestId: 'a', text: '나' })
  await tick()
  const r = await p as Record<string, unknown>
  assert.equal(r.ok, false)
  assert.equal(w.alive, false, 'EPIPE 를 받고도 살아 있다고 보면 계속 쓰게 된다')
})

test('4b. write 가 동기 예외를 던져도 예외가 밖으로 나가지 않는다', async () => {
  const { w, last } = make()
  const p0 = w.analyze({ requestId: 'warm', text: '가' })
  last().reply(ok('warm', sha256Hex('가')))
  await p0
  last().stdin.throwOnWrite = epipe()
  const r = await w.analyze({ requestId: 'a', text: '나' }) as Record<string, unknown>
  assert.equal(r.code, 'WORKER_UNAVAILABLE')
})

test('5. stdin error 와 process close 가 겹쳐도 무효화는 한 번뿐이다', async () => {
  const events: string[] = []
  const procs: FakeProc[] = []
  const w = new AnalysisWorker({
    spawn: (() => { const p = new FakeProc(); procs.push(p); return p as never }) as never,
    pythonPath: () => 'python', scriptPath: () => 's.py', timeoutMs: 5000,
    onEvent: (e) => { if (e === 'worker_invalidated') events.push(e) },
  })
  const p = w.analyze({ requestId: 'a', text: '가' })
  const proc = procs[0]
  proc.stdin.emit('error', epipe())
  proc.emit('exit')
  proc.emit('close')
  const r = await p as Record<string, unknown>
  assert.equal(r.code, 'WORKER_UNAVAILABLE')
  assert.equal(events.length, 1, '무효화가 여러 번 돌면 실패 횟수가 부풀려진다')
  assert.equal(w.consecutiveFailureCount, 1)
})

test('6. pending 여러 개가 있을 때 죽으면 전부 끝난다', async () => {
  const { w, last } = make()
  const a = w.analyze({ requestId: 'a', text: '가' })
  const b = w.analyze({ requestId: 'b', text: '나' })
  const c = w.analyze({ requestId: 'c', text: '다' })
  last().emit('exit')
  for (const r of [await a, await b, await c] as Record<string, unknown>[]) {
    assert.equal(r.ok, false)
    assert.equal(r.code, 'WORKER_UNAVAILABLE')
  }
})

test('7. 실패 뒤 새 worker 로 복구해 warm 분석이 성공한다', async () => {
  const { w, last, procs } = make()
  const p1 = w.analyze({ requestId: 'a', text: '가' })
  last().emit('exit')
  await p1
  const p2 = w.analyze({ requestId: 'b', text: '나' })
  assert.equal(procs.length, 2, '새 worker 를 띄우지 않았다')
  last().reply({ type: 'ready', protocol_version: 1 })
  last().reply(ok('b', sha256Hex('나')))
  assert.equal(((await p2) as Record<string, unknown>).ok, true)
  assert.equal(w.consecutiveFailureCount, 0, '성공했으면 실패 기록이 없어야 한다')
})

test('8. 모든 실패 경로에서 대기 상태가 유한 시간에 풀린다', async () => {
  const { w, last } = make({ timeoutMs: 60_000 })
  const warm = w.prewarm(60_000)
  const a = w.analyze({ requestId: 'a', text: '가' })
  const t0 = Date.now()
  last().emit('exit')
  assert.equal(await warm, false)
  assert.equal(((await a) as Record<string, unknown>).code, 'WORKER_UNAVAILABLE')
  assert.ok(Date.now() - t0 < 1000, 'UI 가 준비 중에 매달린다')
})

test('닫힌 stdin 에는 아예 쓰지 않는다', async () => {
  const { w, last } = make()
  const p0 = w.analyze({ requestId: 'warm', text: '가' })
  last().reply(ok('warm', sha256Hex('가')))
  await p0
  const proc = last()
  const before = proc.stdin.written.length
  proc.breakPipe()
  await w.analyze({ requestId: 'a', text: '나' })
  assert.equal(proc.stdin.written.length, before, '닫힌 파이프에 썼다')
})

test('dispose 는 실패 횟수를 올리지 않는다', async () => {
  const { w, last } = make()
  const p = w.analyze({ requestId: 'a', text: '가' })
  w.dispose()
  assert.equal(((await p) as Record<string, unknown>).code, 'CANCELLED')
  last().emit('exit')
  await tick()
  assert.equal(w.consecutiveFailureCount, 0, '의도한 종료를 실패로 세면 안 된다')
})

test('진단 훅에 사용자 원문이 넘어가지 않는다', async () => {
  const seen: Record<string, unknown>[] = []
  const procs: FakeProc[] = []
  const w = new AnalysisWorker({
    spawn: (() => { const p = new FakeProc(); procs.push(p); return p as never }) as never,
    pythonPath: () => 'python', scriptPath: () => 's.py', timeoutMs: 5000,
    onEvent: (e, f) => seen.push({ e, ...f }),
  })
  const p = w.analyze({ requestId: 'a', text: '비밀 대사입니다' })
  procs[0].emit('exit')
  await p
  assert.equal(JSON.stringify(seen).includes('비밀 대사'), false, '진단 로그로 원문이 샜다')
  assert.ok(seen.length > 0)
})
