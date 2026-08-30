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
import { AnalysisWorker, MAX_RESTARTS, sha256Hex } from './analysis-worker.ts'

class FakeStream extends EventEmitter {
  written: string[] = []
  setEncoding() { /* 실제 스트림 흉내 */ }
  write(s: string) { this.written.push(s); return true }
  end() { /* noop */ }
}

class FakeProc extends EventEmitter {
  stdin = new FakeStream()
  stdout = new FakeStream()
  stderr = new FakeStream()
  exitCode: number | null = null
  killed = false
  kill() { this.killed = true; this.exitCode = 1; this.emit('exit'); return true }
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

test('이전 요청의 늦은 응답은 SUPERSEDED 로 버린다', async () => {
  const { w, last } = make()
  const first = w.analyze({ requestId: 'old', text: '가' })
  const second = w.analyze({ requestId: 'new', text: '가나' })
  // worker 가 순서를 지켜 답해도, 그 사이 새 요청이 들어왔으면 옛 결과는 화면에 가면 안 된다.
  last().reply(ok('old', sha256Hex('가')))
  last().reply(ok('new', sha256Hex('가나')))
  const r1 = await first as Record<string, unknown>
  const r2 = await second as Record<string, unknown>
  assert.equal(r1.ok, false)
  assert.equal(r1.code, 'SUPERSEDED')
  assert.equal(r2.ok, true)
})

test('새 요청은 worker 에게도 옛 요청을 버리라고 알린다', async () => {
  const { w, last } = make()
  const p = w.analyze({ requestId: 'a', text: '가' })
  const drops = last().stdin.written.map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((m) => m.type === 'drop_before')
  assert.ok(drops.length >= 1, 'drop_before 를 보내지 않으면 worker 가 낡은 것을 계산한다')
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

test('되살리기는 유한하다', async () => {
  const { w } = make({ failSpawn: true })
  for (let i = 0; i <= MAX_RESTARTS + 2; i += 1) {
    await w.analyze({ requestId: `r${i}`, text: '가' })
  }
  assert.ok(w.restartCount > MAX_RESTARTS, '무한 재시작은 배터리를 태운다')
  const r = await w.analyze({ requestId: 'last', text: '가' }) as Record<string, unknown>
  assert.equal(r.code, 'WORKER_UNAVAILABLE')
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
