// 참조 전사 미리보기 제어 회귀 테스트 — node:test, fake runner + 주입 타이머.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPreviewGuard, runPreview } from './preview-transcribe.ts'

class FakeRunner {
  handlers: Record<string, ((arg?: unknown) => void)[]> = {}
  runCalled = false
  cancelCalled = false
  on(ev: string, cb: (arg?: unknown) => void) { (this.handlers[ev] ||= []).push(cb) }
  emit(ev: string, arg?: unknown) { (this.handlers[ev] || []).forEach(cb => cb(arg)) }
  run() { this.runCalled = true }
  cancel() { this.cancelCalled = true }
}

// 타이머를 수동 제어하기 위한 주입 헬퍼
function manualTimers() {
  let fn: (() => void) | null = null
  let cleared = false
  return {
    setT: (f: () => void) => { fn = f; return 'TID' },
    clrT: (_h: unknown) => { cleared = true },
    fire: () => { if (fn) fn() },
    get cleared() { return cleared }
  }
}

test('guard: 중복 begin은 throw, end 후 재시작 가능', () => {
  const g = createPreviewGuard()
  assert.equal(g.running, false)
  g.begin()
  assert.equal(g.running, true)
  assert.throws(() => g.begin())
  g.end()
  assert.equal(g.running, false)
  g.begin()  // 재시작 가능
  g.end()
})

test('result → done: transcript payload로 resolve, cleanup 1회', async () => {
  const r = new FakeRunner()
  const t = manualTimers()
  let cleanups = 0
  const p = runPreview({
    runner: r, scriptPath: 's', args: [], timeoutMs: 1000,
    cleanup: () => { cleanups++ }, setTimeoutFn: t.setT, clearTimeoutFn: t.clrT
  })
  assert.equal(r.runCalled, true)
  r.emit('result', { transcript: { status: 'ok', text: '안녕', language: 'ko' } })
  r.emit('done', 0)
  const res = await p
  assert.equal(res.status, 'ok')
  assert.equal(res.text, '안녕')
  assert.equal(cleanups, 1)
  assert.equal(t.cleared, true)  // 타임아웃 타이머 해제됨
})

test('error → done: failed로 resolve(오류 메시지 포함)', async () => {
  const r = new FakeRunner()
  const t = manualTimers()
  const p = runPreview({
    runner: r, scriptPath: 's', args: [], timeoutMs: 1000,
    cleanup: () => {}, setTimeoutFn: t.setT, clearTimeoutFn: t.clrT
  })
  r.emit('error', '전사 폭발')
  r.emit('done', 1)
  const res = await p
  assert.equal(res.status, 'failed')
  assert.match(res.error_message || '', /전사 폭발/)
})

test('result/error 없이 done → failed로 마감(UI 안 멈춤)', async () => {
  const r = new FakeRunner()
  const t = manualTimers()
  const p = runPreview({
    runner: r, scriptPath: 's', args: [], timeoutMs: 1000,
    cleanup: () => {}, setTimeoutFn: t.setT, clearTimeoutFn: t.clrT
  })
  r.emit('done', 0)
  const res = await p
  assert.equal(res.status, 'failed')
})

test('timeout: cancel 호출 + failed resolve + cleanup', async () => {
  const r = new FakeRunner()
  const t = manualTimers()
  let cleanups = 0
  const p = runPreview({
    runner: r, scriptPath: 's', args: [], timeoutMs: 500,
    cleanup: () => { cleanups++ }, setTimeoutFn: t.setT, clearTimeoutFn: t.clrT
  })
  t.fire()  // 타임아웃 발생
  const res = await p
  assert.equal(res.status, 'failed')
  assert.match(res.error_message || '', /시간 초과/)
  assert.equal(r.cancelCalled, true)
  assert.equal(cleanups, 1)
})

test('단일 resolve: done 후 timeout이 또 와도 cleanup 중복 없음', async () => {
  const r = new FakeRunner()
  const t = manualTimers()
  let cleanups = 0
  const p = runPreview({
    runner: r, scriptPath: 's', args: [], timeoutMs: 500,
    cleanup: () => { cleanups++ }, setTimeoutFn: t.setT, clearTimeoutFn: t.clrT
  })
  r.emit('result', { transcript: { status: 'ok', text: 'x' } })
  r.emit('done', 0)
  t.fire()  // 이미 정착됨 → 무시되어야 함
  await p
  assert.equal(cleanups, 1)
})
