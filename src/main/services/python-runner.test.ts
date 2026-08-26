// python-runner 종료 전수(terminal totality) 회귀 — Electron·실제 프로세스 없이 spawn을 주입한다.
//
// 불변식: 한 번의 run()은 어떤 경로로 끝나든 'done'을 정확히 1회 방출한다.
//   정상 종료(0) / 비정상 종료(!=0) / 신호 종료(code null) / sync spawn throw / async spawn error / 취소 kill
// done의 1번째 인자는 기존 그대로 code(하위 호환), 2번째 인자가 구조화 RunEnd(reasonCode).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { PythonRunner } from './python-runner.ts'

function makeFakeChild(pid: number = 4242): any {
  const child: any = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = pid
  child.killed = false
  child.kill = () => { child.killed = true; return true }
  return child
}

// spawn 시임: 첫 호출 = python 자식, (Windows 취소 시) 두 번째 호출 = taskkill.
function makeSpawnFake(opts: { throwOnFirst?: boolean } = {}) {
  const children: any[] = []
  const calls: { cmd: string; args: string[] }[] = []
  const fn: any = (cmd: string, args: string[]) => {
    calls.push({ cmd, args })
    if (opts.throwOnFirst && calls.length === 1) throw new Error('EACCES 모의')
    const c = makeFakeChild()
    children.push(c)
    return c
  }
  return { fn, children, calls }
}

// 러너를 만들고 done/error 방출을 수집한다.
function setup(spawnFn: any) {
  const runner = new PythonRunner('python', { spawn: spawnFn })
  const dones: { code: unknown; end: any }[] = []
  const errors: unknown[] = []
  runner.on('done', (code: unknown, end: any) => dones.push({ code, end }))
  runner.on('error', (e: unknown) => errors.push(e))
  return { runner, dones, errors }
}

test('정상 종료(code 0) → done 1회, reasonCode=exit-ok, error 없음', () => {
  const sp = makeSpawnFake()
  const { runner, dones, errors } = setup(sp.fn)
  runner.run('script.py', ['--config', 'c.json'])
  sp.children[0].emit('close', 0, null)
  assert.equal(dones.length, 1)
  assert.equal(dones[0].code, 0, 'done 1번째 인자는 기존대로 code')
  assert.equal(dones[0].end.reasonCode, 'exit-ok')
  assert.equal(dones[0].end.killedByUs, false)
  assert.equal(errors.length, 0)
  assert.equal(runner.isRunning, false)
})

test('비정상 종료(code != 0) → error 1회 + done 1회, reasonCode=exit-nonzero', () => {
  const sp = makeSpawnFake()
  const { runner, dones, errors } = setup(sp.fn)
  runner.run('script.py', [])
  sp.children[0].stderr.emit('data', Buffer.from('RuntimeError: 모의 실패\n', 'utf-8'))
  sp.children[0].emit('close', 3, null)
  assert.equal(errors.length, 1)
  assert.equal(dones.length, 1)
  assert.equal(dones[0].code, 3)
  assert.equal(dones[0].end.reasonCode, 'exit-nonzero')
})

test('신호 종료(code null, 우리 요청 아님) → done 1회 reasonCode=signal (error는 기존대로 없음)', () => {
  const sp = makeSpawnFake()
  const { runner, dones, errors } = setup(sp.fn)
  runner.run('script.py', [])
  sp.children[0].emit('close', null, 'SIGKILL')
  assert.equal(dones.length, 1)
  assert.equal(dones[0].code, null)
  assert.equal(dones[0].end.reasonCode, 'signal')
  assert.equal(dones[0].end.signal, 'SIGKILL')
  assert.equal(dones[0].end.killedByUs, false)
  assert.equal(errors.length, 0, 'error 의미는 기존 동작 유지 — 종료 사실은 RunEnd가 나른다')
})

test('sync spawn throw → error 1회 + done 1회, reasonCode=spawn-error-sync', () => {
  const sp = makeSpawnFake({ throwOnFirst: true })
  const { runner, dones, errors } = setup(sp.fn)
  runner.run('script.py', [])
  assert.equal(errors.length, 1)
  assert.equal(dones.length, 1, '예전에는 done이 없어 소유자가 러너를 영원히 붙들었다')
  assert.equal(dones[0].end.reasonCode, 'spawn-error-sync')
  assert.equal(runner.isRunning, false)
})

test('async spawn error → error 1회 + done 1회, reasonCode=spawn-error-async', () => {
  const sp = makeSpawnFake()
  const { runner, dones, errors } = setup(sp.fn)
  runner.run('script.py', [])
  sp.children[0].emit('error', new Error('ENOENT 모의'))
  assert.equal(errors.length, 1)
  assert.equal(dones.length, 1)
  assert.equal(dones[0].end.reasonCode, 'spawn-error-async')
})

test('async spawn error 뒤에 close가 따라와도 done은 여전히 1회(중복 터미널 금지)', () => {
  const sp = makeSpawnFake()
  const { runner, dones, errors } = setup(sp.fn)
  runner.run('script.py', [])
  sp.children[0].emit('error', new Error('ENOENT 모의'))
  sp.children[0].emit('close', null, null)
  assert.equal(dones.length, 1)
  assert.equal(errors.length, 1)
})

test('close 뒤에 error가 늦게 와도 done/error 중복 없음', () => {
  const sp = makeSpawnFake()
  const { runner, dones, errors } = setup(sp.fn)
  runner.run('script.py', [])
  sp.children[0].emit('close', 0, null)
  sp.children[0].emit('error', new Error('late 모의'))
  assert.equal(dones.length, 1)
  assert.equal(errors.length, 0)
})

test('취소 후 종료 → reasonCode=killed, killedByUs=true (cancelled와 error를 가른다)', async () => {
  const sp = makeSpawnFake()
  const { runner, dones } = setup(sp.fn)
  runner.run('script.py', [])
  const p = runner.cancel(50)
  assert.equal(runner.killRequested, true)
  sp.children[0].emit('close', null, 'SIGTERM')
  const tk = sp.children[1]           // Windows에서만 taskkill 자식이 생긴다
  if (tk) tk.emit('close', 0)
  await p
  assert.equal(dones.length, 1)
  assert.equal(dones[0].end.reasonCode, 'killed')
  assert.equal(dones[0].end.killedByUs, true)
})

test('취소 요청 뒤 코드 1로 죽어도 killed로 본다(Windows taskkill /F 종료 코드)', async () => {
  const sp = makeSpawnFake()
  const { runner, dones } = setup(sp.fn)
  runner.run('script.py', [])
  const p = runner.cancel(50)
  sp.children[0].emit('close', 1, null)
  const tk = sp.children[1]
  if (tk) tk.emit('close', 0)
  await p
  assert.equal(dones[0].end.reasonCode, 'killed')
})

test('실행 중이 아닐 때 cancel → no-process, 부수효과 없음', async () => {
  const sp = makeSpawnFake()
  const { runner, dones } = setup(sp.fn)
  const res = await runner.cancel(50)
  assert.equal(res.reason, 'no-process')
  assert.equal(res.treeKillConfirmed, true)
  assert.equal(dones.length, 0)
})

// ── run-scoped cleanup ──────────────────────────────────────────────────────

test('cleanup: run() 전에 등록한 정리가 정상 종료 시 done 직전에 1회 실행', () => {
  const sp = makeSpawnFake()
  const { runner, dones } = setup(sp.fn)
  const order: string[] = []
  runner.on('done', () => order.push('done'))
  runner.registerCleanup(() => order.push('cleanup'))
  runner.run('script.py', [])
  sp.children[0].emit('close', 0, null)
  assert.deepEqual(order, ['cleanup', 'done'], 'done을 볼 때 임시물은 이미 정리돼 있어야 한다')
  assert.equal(dones.length, 1)
})

test('cleanup: 모든 종료 경로에서 정확히 1회', () => {
  const paths: Array<(sp: any, child: any) => void> = [
    (_sp, c) => c.emit('close', 0, null),
    (_sp, c) => c.emit('close', 7, null),
    (_sp, c) => c.emit('close', null, 'SIGKILL'),
    (_sp, c) => { c.emit('error', new Error('x')); c.emit('close', null, null) }
  ]
  for (const drive of paths) {
    const sp = makeSpawnFake()
    const runner = new PythonRunner('python', { spawn: sp.fn })
    runner.on('error', () => {})
    let n = 0
    runner.registerCleanup(() => { n++ })
    runner.run('script.py', [])
    drive(sp, sp.children[0])
    assert.equal(n, 1)
  }
})

test('cleanup: sync spawn 실패에서도 실행된다(설정 파일이 새지 않게)', () => {
  const sp = makeSpawnFake({ throwOnFirst: true })
  const runner = new PythonRunner('python', { spawn: sp.fn })
  runner.on('error', () => {})
  let n = 0
  runner.registerCleanup(() => { n++ })
  runner.run('script.py', [])
  assert.equal(n, 1)
})

test('cleanup: 종료 뒤 등록하면 즉시 실행(등록 시점 때문에 정리가 새지 않게)', () => {
  const sp = makeSpawnFake()
  const runner = new PythonRunner('python', { spawn: sp.fn })
  runner.run('script.py', [])
  sp.children[0].emit('close', 0, null)
  let n = 0
  runner.registerCleanup(() => { n++ })
  assert.equal(n, 1)
})

test('cleanup: 하나가 throw해도 나머지가 실행되고 done은 정상 방출', () => {
  const sp = makeSpawnFake()
  const { runner, dones } = setup(sp.fn)
  const ran: string[] = []
  runner.registerCleanup(() => { ran.push('a'); throw new Error('삭제 실패 모의') })
  runner.registerCleanup(() => { ran.push('b') })
  runner.run('script.py', [])
  sp.children[0].emit('close', 0, null)
  assert.deepEqual(ran, ['a', 'b'])
  assert.equal(dones.length, 1)
})

test('cleanup: 이전 실행의 정리가 다음 실행으로 새지 않는다', () => {
  const sp = makeSpawnFake()
  const runner = new PythonRunner('python', { spawn: sp.fn })
  let n = 0
  runner.registerCleanup(() => { n++ })
  runner.run('script.py', [])
  sp.children[0].emit('close', 0, null)
  assert.equal(n, 1)
  runner.run('script.py', [])       // 두 번째 실행
  sp.children[1].emit('close', 0, null)
  assert.equal(n, 1, '두 번째 실행이 이전 cleanup을 다시 돌리면 안 된다')
})

// ── 기존 stdout 파싱 의미 유지 ───────────────────────────────────────────────

test('stdout 파싱 의미 유지: progress/status/result/error', () => {
  const sp = makeSpawnFake()
  const runner = new PythonRunner('python', { spawn: sp.fn })
  const got: Record<string, unknown[]> = { progress: [], result: [], error: [] }
  runner.on('progress', (d: unknown) => got.progress.push(d))
  runner.on('result', (d: unknown) => got.result.push(d))
  runner.on('error', (d: unknown) => got.error.push(d))
  runner.run('script.py', [])
  const c = sp.children[0]
  c.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'status', percent: 5, message: '시작' }) + '\n', 'utf-8'))
  c.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'progress', percent: 50, message: '반' }) + '\n', 'utf-8'))
  c.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'error', message: '모의', code: 'X' }) + '\n', 'utf-8'))
  c.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', tracks: [] }) + '\n', 'utf-8'))
  assert.equal(got.progress.length, 2)
  assert.equal(got.result.length, 1)
  assert.equal(got.error.length, 1)
  assert.equal((got.error[0] as { code?: string }).code, 'X', '구조화 오류는 그대로 전달')
  c.emit('close', 0, null)
})

test('마지막 개행 없는 줄도 close에서 flush된다(기존 동작 유지)', () => {
  const sp = makeSpawnFake()
  const runner = new PythonRunner('python', { spawn: sp.fn })
  const results: unknown[] = []
  runner.on('result', (d: unknown) => results.push(d))
  runner.run('script.py', [])
  const c = sp.children[0]
  c.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', tracks: [1] }), 'utf-8'))  // 개행 없음
  c.emit('close', 0, null)
  assert.equal(results.length, 1)
})
