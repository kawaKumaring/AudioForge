// 엔진 미리 데우기 계약 — **앱을 막지 않고, GPU 를 건드리지 않고, 조용히 안 하지 않는다.**
//
// ★왜(2026-09-25 실측): 합성 준비 8.4초 중 5.8초가 라이브러리 읽기인데, 그 5.8초는
//   **데워진 값**이고 처음에는 25.9초다. 사용자가 겪는 "처음이 유독 느리다" 가 그것이다.
//   처음 한 번을 배경으로 옮긴다.
//
// ★이것이 매 작업의 5.8초를 줄이지는 **못한다**. 그 값은 파일 읽기가 아니라 파이썬이
//   프로세스마다 하는 일이다(더운 상태 3회 측정 5.83초, 편차 0.01초).
//   과장하지 않는 것이 이 파일의 계약이기도 하다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DISABLE_ENV, WARMUP_SNIPPET, WARMUP_TIMEOUT_MS,
  bridgePython, skipReason, warmUpBridge,
} from './bridge-warmup.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 실제로 띄우지 않는 가짜. 무엇을 어떻게 띄우려 했는지만 본다. */
function fakeSpawn() {
  const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = []
  const handlers: Record<string, ((...a: unknown[]) => void)[]> = {}
  let killed = 0
  const child = {
    once: (ev: string, fn: (...a: unknown[]) => void) => {
      (handlers[ev] ||= []).push(fn)
      return child
    },
    kill: () => { killed += 1; return true },
  }
  const fn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts })
    return child
  }) as unknown as typeof import('child_process').spawn
  return { fn, calls, fire: (ev: string, ...a: unknown[]) => (handlers[ev] || []).forEach((h) => h(...a)), killed: () => killed }
}

const ROOT = 'E:\\앱'
/** 가짜 디스크 — 엔진 파이썬이 있다고 본다(실제 파일을 만들지 않는다). */
const HAS = () => true

test('합성이 실제로 쓰는 파이썬으로 데운다 — 다른 것으로 데우면 뜻이 없다', () => {
  const p = bridgePython(ROOT)
  assert.ok(p.includes('qwen3_tts_venv'), '격리 venv 가 아니다')
  const worker = readFileSync(path.resolve(HERE, '..', '..', '..', 'python', 'tts_worker.py'), 'utf-8')
  assert.ok(worker.includes('qwen3_tts_venv'), '합성 쪽이 쓰는 이름과 갈라졌다')
})

test('모델을 올리지 않는다 — GPU 를 건드릴 통로가 없다', () => {
  assert.ok(WARMUP_SNIPPET.includes('import torch, qwen_tts'))
  for (const forbidden of ['from_pretrained', 'cuda', 'device', 'generate']) {
    assert.ok(!WARMUP_SNIPPET.includes(forbidden),
      `데우기가 ${forbidden} 를 건드린다 — GPU 를 쓰면 양보 정책이 깨진다`)
  }
})

test('아무것도 만들지 않는다 — 읽기만 한다', () => {
  for (const forbidden of ['open(', 'write', 'mkdir', 'remove']) {
    assert.ok(!WARMUP_SNIPPET.includes(forbidden), `데우기가 ${forbidden} 를 한다`)
  }
})

// ★"조용히 안 함" 을 만들지 않는다 — 안 했으면 왜 안 했는지 말한다.
test('건너뛸 때는 사유를 남긴다', () => {
  const said: string[] = []
  const h = warmUpBridge({
    root: ROOT, env: { [DISABLE_ENV]: '1' }, log: (m) => said.push(m),
    spawnFn: fakeSpawn().fn, exists: HAS,
  })
  assert.equal(h.started, false)
  assert.equal(h.reason, '꺼져 있음')
  assert.ok(said.some((s) => s.includes('건너뜀')), '건너뛴 사실을 말하지 않는다')
})

test('검사 실행에서는 돌지 않는다 — 검사를 느리게 만들면 안 된다', () => {
  assert.equal(skipReason({ root: ROOT, env: { AF_E2E: '1' }, exists: HAS }), '검사 실행')
})

test('엔진 파이썬이 없으면 시도하지 않는다', () => {
  assert.equal(skipReason({ root: 'Z:\\없는곳', env: {} }), '합성 엔진 파이썬 없음')
})

test('되돌리는 스위치가 있다', () => {
  assert.equal(DISABLE_ENV, 'AUDIOFORGE_NO_WARMUP')
})

test('배경으로 띄운다 — 앱 기동을 막지 않는다', () => {
  const sp = fakeSpawn()
  const h = warmUpBridge({ root: ROOT, env: {}, spawnFn: sp.fn, exists: HAS })
  assert.equal(h.started, true, '띄우지 않았다')
  const c = sp.calls[0]
  assert.equal(c.opts.detached, false, '앱이 닫혀도 남는다 — 좀비가 된다')
  assert.equal(c.opts.stdio, 'ignore', '출력을 붙들면 부모가 막힐 수 있다')
  assert.equal(c.opts.windowsHide, true, '검은 창이 떠오른다')
})

// ★배경 일이 영원히 남으면 안 된다.
test('시간이 지나면 스스로 접는다', () => {
  assert.ok(WARMUP_TIMEOUT_MS > 0 && WARMUP_TIMEOUT_MS <= 300_000,
    '상한이 없거나 너무 길다')
})

test('멈추라면 멈춘다', () => {
  const sp = fakeSpawn()
  const h = warmUpBridge({ root: ROOT, env: {}, spawnFn: sp.fn, exists: HAS })
  h.stop()
  assert.equal(sp.killed(), 1, '멈추지 않았다')
})

test('실패해도 던지지 않는다 — 데우기 실패가 합성을 막으면 안 된다', () => {
  const boom = (() => { throw new Error('못 띄움') }) as unknown as typeof import('child_process').spawn
  const said: string[] = []
  const h = warmUpBridge({ root: ROOT, env: {}, spawnFn: boom, log: (m) => said.push(m), exists: HAS })
  assert.equal(h.started, false)
  assert.ok(said.some((s) => s.includes('못 시작')))
})

test('끝나면 걸린 시간을 남긴다 — 다음에 값어치를 다시 잴 수 있게', () => {
  const sp = fakeSpawn()
  const said: string[] = []
  let t = 1000
  warmUpBridge({ root: ROOT, env: {}, spawnFn: sp.fn, log: (m) => said.push(m),
    now: () => t, exists: HAS })
  t = 26_900
  sp.fire('exit', 0)
  assert.ok(said.some((s) => s.includes('25.9초')), `시간을 안 남겼다: ${said.join(' / ')}`)
})

// ★과장하지 않는다 — 이것은 "처음 한 번" 만 판다.
test('문서가 매 작업 이득을 약속하지 않는다', () => {
  const src = readFileSync(path.join(HERE, 'bridge-warmup.ts'), 'utf-8')
  assert.ok(src.includes('매 작업의 5.8초를 줄이지는 못한다'),
    '이 한계를 적어 두지 않으면 다음 사람이 과장한다')
})

// ★만들어 두고 **안 부르면** 아무것도 달라지지 않는다.
test('본체가 기동 때 실제로 부른다', () => {
  const index = readFileSync(path.resolve(HERE, '..', 'index.ts'), 'utf-8')
  assert.ok(index.includes('warmUpBridge('), '기동에 배선되지 않았다')
  // 창을 만든 **뒤**여야 한다 — 앞이면 첫 화면이 늦어진다.
  assert.ok(index.indexOf('createWindow()') < index.indexOf('warmUpBridge('),
    '창보다 먼저 데우면 첫 화면이 늦어진다')
})
