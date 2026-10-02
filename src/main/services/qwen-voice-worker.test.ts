// Qwen 지정 목소리 상주 실행기 관리자 — 실제 파이썬 없이 가짜 프로세스로 고정한다.
//
// 지키는 것
//   · 한 번 띄우고 재사용한다(조각마다 새로 띄우지 않는다 — 그것이 이 관리자의 이유다)
//   · 답은 id 로 짝짓는다 — 라이브러리가 찍는 다른 줄·늦게 온 다른 답은 무시한다
//   · 실패 답은 사유를 그대로 돌려준다
//   · 죽은 파이프·종료·타임아웃은 기다리던 요청을 **한 번만** 끝내고 main 을 터뜨리지 않는다
//   · 한동안 안 쓰면 내린다(그래픽카드 메모리를 돌려준다) · 다음 요청에서 다시 띄운다
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
// @ts-ignore TS5097
import { QwenVoiceWorker } from './qwen-voice-worker.ts'

class FakeStream extends EventEmitter {
  written: string[] = []
  writable = true
  destroyed = false
  writableEnded = false
  failNext: Error | null = null
  setEncoding() { /* 흉내 */ }
  write(s: string, cb?: (err?: Error | null) => void) {
    this.written.push(s)
    const err = this.failNext
    this.failNext = null
    if (cb) queueMicrotask(() => cb(err))
    return true
  }
  end() { this.writableEnded = true }
}
class FakeProc extends EventEmitter {
  stdin = new FakeStream()
  stdout = new FakeStream()
  stderr = new FakeStream()
  killed = false
  kill() { if (!this.killed) { this.killed = true; this.emit('exit') } return true }
  /** 받은 마지막 요청의 id 로 답한다. */
  answer(extra: Record<string, unknown>) {
    const last = JSON.parse(this.stdin.written.at(-1) as string)
    this.stdout.emit('data', JSON.stringify({ id: last.id, ...extra }) + '\n')
  }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0))
const REQ = { model: 'M', speaker: 'sohee', language: 'korean', textFile: 't.txt', out: 'o.wav' }

function make(opts: { idleMs?: number; timeoutMs?: number } = {}) {
  const procs: FakeProc[] = []
  const events: string[] = []
  const w = new QwenVoiceWorker({
    spawn: () => { const p = new FakeProc(); procs.push(p); return p as never },
    pythonPath: () => 'py', scriptPath: () => 'server.py',
    idleMs: opts.idleMs ?? 60_000, timeoutMs: opts.timeoutMs ?? 60_000,
    onEvent: (e) => events.push(e),
  })
  return { w, procs, events }
}

test('★한 번 띄우고 재사용한다 · 답은 id 로 짝짓고 다른 줄은 무시한다', async () => {
  const { w, procs } = make()
  const a = w.speak(REQ)
  await tick()
  procs[0].stdout.emit('data', '경고 문구 한 줄\n{"type":"stage","stage":"code_predictor"}\n{"id":"다른것","ok":true}\n')
  procs[0].answer({ ok: true, seconds: 10.6, sample_rate: 24000, gen_sec: 9.8, loaded_now: true })
  assert.deepEqual(await a, { seconds: 10.6, sampleRate: 24000, genSec: 9.8, loadedNow: true })
  const b = w.speak(REQ)
  await tick()
  procs[0].answer({ ok: true, seconds: 5, sample_rate: 24000, gen_sec: 4.6, loaded_now: false })
  await b
  assert.equal(procs.length, 1, '조각마다 새로 띄웠다')
  const sent = JSON.parse(procs[0].stdin.written[0])
  assert.deepEqual(Object.keys(sent).sort(), ['id', 'language', 'model', 'out', 'seed', 'speaker', 'text_file'])
  w.stop()
})

test('실패 답은 사유를 그대로 돌려준다', async () => {
  const { w, procs } = make()
  const a = w.speak(REQ)
  await tick()
  procs[0].answer({ ok: false, error: 'RuntimeError: 읽을 글이 없습니다' })
  await assert.rejects(a, /읽을 글이 없습니다/)
  w.stop()
})

test('★실행기가 죽으면 기다리던 요청이 곧바로 끝나고, 다음 요청은 새로 띄운다', async () => {
  const { w, procs } = make()
  const a = w.speak(REQ)
  await tick()
  procs[0].kill()
  await assert.rejects(a, /끝났습니다/)
  const b = w.speak(REQ)
  await tick()
  assert.equal(procs.length, 2)
  procs[1].answer({ ok: true, seconds: 1, sample_rate: 24000 })
  await b
  w.stop()
})

test('★죽은 파이프에 쓰면 터지지 않고 실패로 끝난다(EPIPE 는 callback 으로 온다)', async () => {
  const { w, procs } = make()
  const first = w.speak(REQ)
  await tick()
  procs[0].answer({ ok: true, seconds: 1, sample_rate: 24000 })
  await first
  procs[0].stdin.failNext = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
  await assert.rejects(w.speak(REQ), /쓰지 못했습니다/)
  // stdin 의 error 이벤트도 받아 준다(리스너가 없으면 main 전역 예외가 된다)
  assert.ok(procs[0].stdin.listenerCount('error') > 0)
  w.stop()
})

test('멈춘 실행기는 시간 상한에서 놓아준다', async () => {
  const { w, procs } = make({ timeoutMs: 20 })
  await assert.rejects(w.speak(REQ), /너무 오래/)
  assert.equal(procs[0].killed, true)
  w.stop()
})

test('★한동안 안 쓰면 내린다 — 그래픽카드 메모리를 돌려준다', async () => {
  const { w, procs, events } = make({ idleMs: 30 })
  const a = w.speak(REQ)
  await tick()
  procs[0].answer({ ok: true, seconds: 1, sample_rate: 24000 })
  await a
  assert.equal(w.running, true)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(w.running, false)
  assert.equal(procs[0].killed, true)
  assert.ok(events.includes('stop'))
})

test('겹쳐 와도 차례로 보낸다(한 번에 하나)', async () => {
  const { w, procs } = make()
  const a = w.speak(REQ)
  const b = w.speak({ ...REQ, out: 'b.wav' })
  await tick()
  assert.equal(procs[0].stdin.written.length, 1, '앞 답을 받기 전에 둘째를 보냈다')
  procs[0].answer({ ok: true, seconds: 1, sample_rate: 24000 })
  await a
  await tick()
  assert.equal(procs[0].stdin.written.length, 2)
  procs[0].answer({ ok: true, seconds: 1, sample_rate: 24000 })
  await b
  w.stop()
})

// ── 파이프 입구(2026-10-01 생성 카드) — 요청 없이 띄우고 준비를 기다린다 · 파이프로 일하는 동안 내리지 않는다 ──
test('★요청 없이 띄우고, 실행기가 준비를 알릴 때까지 기다린다 — 늦으면 기다리지 않고 false', async () => {
  const { w, procs } = make()
  const ready = w.ensure(1000)
  await tick()
  assert.equal(procs.length, 1, '띄우지 않았다')
  assert.equal(procs[0].stdin.written.length, 0, '띄우기만 해야 하는데 요청을 보냈다')
  procs[0].stdout.emit('data', JSON.stringify({ id: '', ok: true, ready: true, pipe: true }) + '\n')
  assert.equal(await ready, true)
  assert.equal(await w.ensure(1000), true, '이미 준비된 실행기는 곧바로')
  assert.equal(procs.length, 1, '두 번 띄웠다')
  w.stop()
  const { w: w2 } = make()
  assert.equal(await w2.ensure(20), false, '준비 알림이 없으면 기다림을 끝내고 false')
  w2.stop()
})

test('★파이프로 일하는 동안(activity)은 한동안 안 씀으로 내리지 않는다', async (t) => {
  // ★가짜 시계로 잰다 — 진짜 시계(25ms 간격 · 40ms 상한)는 검사가 몰릴 때 타이머가 늦어 가끔 내려졌다(2026-10-03, 전량 단위 검사 2회 중 1회).
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { w, procs } = make({ idleMs: 40 })
  void w.ensure(10)
  await new Promise<void>((r) => setImmediate(r))        // 가짜 시계와 무관한 한 박자(tick() 은 setTimeout 이라 멈춘다)
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(25)
    procs[0].stdout.emit('data', JSON.stringify({ id: '', activity: true }) + '\n')
  }
  assert.equal(w.running, true, '일하는 중인데 내렸다(상한 40ms 를 넘는 100ms 동안 일했다)')
  t.mock.timers.tick(39)
  assert.equal(w.running, true, '마지막 일 뒤 상한 전에는 내리지 않는다')
  t.mock.timers.tick(2)
  assert.equal(w.running, false, '일이 끝난 뒤에는 내린다')
})
