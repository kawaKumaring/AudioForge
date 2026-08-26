// 장문 TTS job 안정성 — 재현(현행 정책의 결함) + 신규 3축 계약.
//
// 실제 프로세스·GPU·Electron 없이 돈다. PythonRunner 에 spawn 을 주입해(deps.spawn) 느린/고착
// runner 를 만들고, 시계는 가상 시계를 주입한다. setTimeout 을 쓰지 않으므로 결정적이다.
//
// 이 파일의 앞부분(재현)은 **현행 audio.ipc.ts 의 감시 정책을 그대로 미러링**해서, 지금 코드가
// 무엇을 놓치는지 먼저 증명한다. 뒷부분이 신규 계약이다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { PythonRunner } from './python-runner.ts'
import { createTerminalGate } from './run-settlement.ts'
import {
  createJobWatchdog, createChunkLedger, createStagingGate, parseChunkPosition,
  jobBudgetMs, INACTIVITY_MS, STALL_MS, LOAD_BUDGET_MS, PER_CHUNK_BUDGET_MS, SELF_REPORT_GRACE_MS
} from './longform-job.ts'

// ── 가상 시계 ────────────────────────────────────────────────────────────────
function makeClock() {
  let t = 1_000_000
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

// ── fake runner: 실제 프로세스 없이 stdout JSON 라인을 밀어 넣는다 ───────────
function makeFakeChild(pid = 4242): any {
  const child: any = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = pid
  child.killed = false
  child.kill = () => { child.killed = true; return true }
  return child
}
function makeSpawnFake() {
  const children: any[] = []
  const fn: any = () => { const c = makeFakeChild(); children.push(c); return c }
  return { fn, children }
}
/** progress 이벤트를 수집하는 러너 한 대. */
function makeRunner() {
  const sp = makeSpawnFake()
  const runner = new PythonRunner('python', { spawn: sp.fn })
  const progress: { percent: number; message: string }[] = []
  const dones: any[] = []
  runner.on('progress', (p: any) => progress.push(p))
  runner.on('done', (_c: unknown, end: any) => dones.push(end))
  runner.run('tts_worker.py', ['--config', 'c.json'])
  const child = sp.children[0]
  const emitLine = (obj: unknown) => {
    child.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n', 'utf-8'))
  }
  return { runner, child, progress, dones, emitLine }
}

// python/qwen_bridge.py `_progress` 가 만드는 문구를 그대로 재현한다.
const chunkMsg = (seg: number, nSeg: number, ci: number, cc: number, phase: '시작' | '완료') =>
  `합성 중... (문장 ${seg + 1}/${nSeg}, 조각 ${ci + 1}/${cc} ${phase})`
// python/tts_worker.py 가 heartbeat 를 progress 로 옮길 때 쓰는 문구.
const loadMsg = (sec: number) => `모델 로딩 중... (${sec}초 경과 — 첫 실행은 오래 걸릴 수 있습니다)`

/**
 * 현행 정책 미러 — audio.ipc.ts 의 resetWatchdog 는 'progress' 이벤트가 오기만 하면
 * 무조건 5분 타이머를 다시 건다. setTimeout 대신 같은 판정을 순수 함수로 쓴다.
 */
function makeCurrentPolicy(clock: { now: () => number }) {
  let lastProgressAt = clock.now()
  const startedAt = clock.now()
  return {
    observe() { lastProgressAt = clock.now() },          // 신호 종류를 구분하지 않는다 ← 결함의 핵심
    fired() { return clock.now() - lastProgressAt >= 300_000 },
    elapsed() { return clock.now() - startedAt }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// A. 재현 — 현행 정책이 놓치는 것
// ═══════════════════════════════════════════════════════════════════════════

test('[재현] heartbeat 만 오는 고착 job 을 현행 정책은 영원히 못 잡는다 / 신규는 stall 로 잡는다', () => {
  const clock = makeClock()
  const current = makeCurrentPolicy(clock)
  const wd = createJobWatchdog({ now: clock.now })
  const { progress, emitLine } = makeRunner()

  // 브리지가 12s 간격 heartbeat(=progress 로 변환된 생존 신호)만 1시간 내내 보낸다.
  // 조각은 단 하나도 완료되지 않는다.
  let firstStallAt: number | null = null
  for (let i = 1; i <= 300; i++) {
    clock.advance(12_000)
    emitLine({ type: 'progress', percent: Math.min(24, 12 + i), message: loadMsg(i * 12) })
    current.observe()
    wd.observe(progress[progress.length - 1])
    if (firstStallAt === null && wd.evaluate() === 'no-forward-progress') {
      firstStallAt = clock.now() - wd.startedAtMs
    }
  }

  assert.equal(progress.length, 300, 'fake runner 가 실제로 300개의 progress 를 흘렸다')
  // 현행: 3600초가 지나도 절대 발화하지 않는다 → UI 는 'processing' 에 영원히 남는다.
  assert.equal(current.fired(), false, '현행 정책은 heartbeat 만으로 무한 연장된다(결함)')
  assert.equal(current.elapsed(), 3_600_000)
  // 신규: forward progress 가 0 이므로 stall 축이 반드시 발화한다.
  assert.equal(wd.evaluate(), 'no-forward-progress')
  assert.notEqual(firstStallAt, null)
  assert.ok(firstStallAt! >= STALL_MS, `stall 은 ${STALL_MS}ms 전에는 발화하지 않는다`)
  assert.ok(firstStallAt! < STALL_MS + 12_000, '발화가 한 heartbeat 주기 안에 일어난다')
  assert.equal(wd.ledger.completedCount, 0)
})

test('[재현] 조각 "시작" 알림만 반복되는 job — 현행은 무한, 신규는 stall(시작은 전진이 아니다)', () => {
  const clock = makeClock()
  const current = makeCurrentPolicy(clock)
  const wd = createJobWatchdog({ now: clock.now })
  const { progress, emitLine } = makeRunner()

  // 같은 조각의 '시작' 만 60초마다 계속 나온다(생성이 돌다 되감기는 회귀 상황).
  for (let i = 0; i < 20; i++) {
    clock.advance(60_000)
    emitLine({ type: 'progress', percent: 30, message: chunkMsg(0, 12, 0, 2, '시작') })
    current.observe()
    assert.equal(wd.observe(progress[progress.length - 1]), 'liveness',
      '조각 시작 알림은 blocking 생성 호출 직전에 나간다 — 전진이 아니다')
  }
  assert.equal(current.fired(), false, '현행 정책은 시작 알림만으로도 무한 연장된다(결함)')
  assert.equal(clock.now() - wd.startedAtMs, 1_200_000)
  assert.equal(wd.evaluate(), 'no-forward-progress')
  assert.equal(wd.ledger.completedCount, 0, '완료된 조각은 하나도 없다')
})

test('[재현] 40/50 조각 완료 후 프로세스 사망 — 현행은 기록이 남지 않고, 신규는 checkpoint 로 재개 가능', () => {
  const clock = makeClock()
  const wd = createJobWatchdog({ now: clock.now })
  const { progress, emitLine, child, dones } = makeRunner()

  // 25문장 × 2조각 중 20문장(=40조각)까지 완료한 뒤 프로세스가 신호로 죽는다.
  for (let seg = 0; seg < 20; seg++) {
    for (let ci = 0; ci < 2; ci++) {
      clock.advance(1_000)
      emitLine({ type: 'progress', percent: 30, message: chunkMsg(seg, 25, ci, 2, '시작') })
      wd.observe(progress[progress.length - 1])
      clock.advance(200_000)   // 조각 하나 생성에 200초(정상 범위 — 280s 계약 이내)
      emitLine({ type: 'progress', percent: 31, message: chunkMsg(seg, 25, ci, 2, '완료') })
      assert.equal(wd.observe(progress[progress.length - 1]), 'forward')
    }
  }
  child.emit('close', null, 'SIGKILL')

  assert.equal(dones.length, 1)
  assert.equal(dones[0].reasonCode, 'signal', '외부 kill 로 죽었다')
  // 현행 audio.ipc.ts 는 이 시점에 sweepQwenJobDirs 로 중간 산출물을 지우고 아무 것도 남기지 않는다.
  // 신규: 완료분 40개가 원장에 남고 재개 계획이 선다.
  assert.equal(wd.ledger.completedCount, 40)
  const plan = wd.ledger.resumePlan()
  assert.equal(plan.resumable, true)
  assert.equal(plan.reason, 'ok')
  assert.equal(plan.completed.length, 40)
  assert.equal(plan.remaining!.length, 0, '완료한 20문장 안에는 빠진 조각이 없다')
})

// ═══════════════════════════════════════════════════════════════════════════
// B. 세 축이 서로 다른 축이라는 것
// ═══════════════════════════════════════════════════════════════════════════

test('정상 heartbeat 가 있는 느린 콜드 로딩을 조기 종료하지 않는다(기존 보호 유지)', () => {
  const clock = makeClock()
  const wd = createJobWatchdog({ now: clock.now })
  // 12초 간격 heartbeat 로 500초 동안 로딩. Python 의 기동 deadline(600s) 안이다.
  for (let i = 1; i * 12_000 <= 500_000; i++) {
    clock.advance(12_000)
    wd.observe({ percent: Math.min(24, 12 + i), message: loadMsg(i * 12) })
    assert.equal(wd.evaluate(), 'ok', 'liveness 는 비활성 축을 갱신한다 — 죽이면 안 된다')
  }
  assert.ok(clock.now() - wd.startedAtMs >= 490_000)
})

test('liveness 는 비활성 축만 갱신하고 stall 축은 갱신하지 못한다', () => {
  const clock = makeClock()
  const wd = createJobWatchdog({ now: clock.now })
  // stall 직전까지 liveness 로만 버틴다.
  while (clock.now() - wd.startedAtMs < STALL_MS - 12_000) {
    clock.advance(12_000)
    wd.observe({ percent: 24, message: loadMsg(1) })
  }
  assert.equal(wd.evaluate(), 'ok')
  assert.ok(wd.report().sinceForwardMs >= STALL_MS - 24_000, 'forward 는 한 번도 없었다')
  clock.advance(12_000)
  wd.observe({ percent: 24, message: loadMsg(1) })
  assert.equal(wd.evaluate(), 'no-forward-progress', 'liveness 로는 stall 을 넘길 수 없다')
})

test('forward progress 는 stall 축을 갱신한다 — 조각이 계속 나오면 job 은 계속 산다', () => {
  const clock = makeClock()
  const wd = createJobWatchdog({ now: clock.now })
  for (let seg = 0; seg < 30; seg++) {
    clock.advance(250_000)   // stall(630s) 보다 짧은 간격으로 조각이 하나씩 나온다
    wd.observe({ percent: 40, message: chunkMsg(seg, 200, 0, 1, '완료') })
    assert.equal(wd.evaluate(), 'ok')
  }
  assert.equal(wd.ledger.completedCount, 30)
})

test('아무 신호도 없으면 비활성 축이 잡는다(기존 300000 그대로, 값 변경 없음)', () => {
  assert.equal(INACTIVITY_MS, 300_000, '기존 WATCHDOG_MS 와 같은 값이어야 한다')
  const clock = makeClock()
  const wd = createJobWatchdog({ now: clock.now })
  clock.advance(299_999)
  assert.equal(wd.evaluate(), 'ok')
  clock.advance(1)
  assert.equal(wd.evaluate(), 'inactivity-timeout')
})

test('job 예산은 아무 것도 갱신하지 못한다 — forward 가 계속 나와도 총량 상한에서 끝난다', () => {
  const clock = makeClock()
  const wd = createJobWatchdog({ now: clock.now })
  // 이 job 의 총 조각 수는 2로 확정됐다(결과 metadata 의 chunk_count 등).
  // 그런데 브리지가 멈추지 않고 계속 새 조각을 뱉는 폭주 상황이다 — 전진 신호는 끊이지 않는다.
  wd.setTotalChunks(2)
  const budget = jobBudgetMs(2)
  assert.equal(wd.budgetMs, budget)
  assert.equal(budget, LOAD_BUDGET_MS + 2 * PER_CHUNK_BUDGET_MS + SELF_REPORT_GRACE_MS)
  let seg = 0
  while (clock.now() - wd.startedAtMs < budget - 100_000) {
    clock.advance(100_000)
    // 매번 '새' 조각이므로 전부 forward 다 — stall 축은 절대 발화하지 않는다.
    assert.equal(wd.observe({ percent: 30, message: chunkMsg(seg, 400, 0, 1, '완료') }), 'forward')
    seg++
  }
  assert.equal(wd.evaluate(), 'ok')
  assert.ok(wd.ledger.completedCount > 2, '전진은 계속되고 있다')
  clock.advance(100_000)
  assert.equal(wd.evaluate(), 'job-budget-exhausted', 'forward 로도 총 예산은 연장되지 않는다')
})

test('조각 수를 모르면 job 예산은 없다(Infinity) — 모르는 것을 아는 척하지 않는다', () => {
  const clock = makeClock()
  const wd = createJobWatchdog({ now: clock.now })
  assert.equal(wd.budgetMs, Number.POSITIVE_INFINITY)
  assert.equal(jobBudgetMs(null), Number.POSITIVE_INFINITY)
  assert.equal(jobBudgetMs(0), Number.POSITIVE_INFINITY)
  assert.equal(jobBudgetMs(NaN), Number.POSITIVE_INFINITY)
})

test('장문(25문장×2조각, 조각당 200초)은 예산 안에서 끝난다 — 정상 장문을 죽이지 않는다', () => {
  const clock = makeClock()
  const wd = createJobWatchdog({ now: clock.now })
  clock.advance(120_000)                                    // 모델 로딩
  wd.observe({ percent: 25, message: '모델 로딩 완료' })
  for (let seg = 0; seg < 25; seg++) {
    for (let ci = 0; ci < 2; ci++) {
      clock.advance(200_000)
      wd.observe({ percent: 30, message: chunkMsg(seg, 25, ci, 2, '완료') })
      assert.equal(wd.evaluate(), 'ok', `seg ${seg} chunk ${ci} 에서 조기 종료됨`)
    }
  }
  assert.equal(wd.ledger.completedCount, 50)
  assert.equal(wd.report().estimatedTotalChunks, 50, '세그먼트 수 × 세그먼트당 조각 수')
  assert.equal(wd.budgetMs, LOAD_BUDGET_MS + 50 * PER_CHUNK_BUDGET_MS + SELF_REPORT_GRACE_MS)
})

test('stall 상한은 Python 기동 deadline(600s) + 자기보고 유예에서 유도된다 — Python 이 먼저 보고한다', () => {
  // 값을 지어내지 않았다는 것을 고정한다. Python 이 600s 에 QWEN_LOAD_TIMEOUT 을 구조화해
  // 보고할 기회를 갖고, Electron 은 그 뒤에야 개입한다.
  assert.equal(STALL_MS, 630_000)
  assert.equal(STALL_MS, LOAD_BUDGET_MS + SELF_REPORT_GRACE_MS)
  assert.ok(STALL_MS > INACTIVITY_MS, 'stall 은 비활성 축보다 길어야 한다(느린 로딩 보호)')
})

// ═══════════════════════════════════════════════════════════════════════════
// C. 진행 신호 해석
// ═══════════════════════════════════════════════════════════════════════════

test('브리지 진행 문구에서 조각 위치를 읽는다(qwen_bridge.py _progress 형식)', () => {
  const p = parseChunkPosition(chunkMsg(2, 12, 1, 3, '완료'))
  assert.deepEqual(p, { segIndex: 2, segCount: 12, chunkIndex: 1, chunkCount: 3, phase: 'complete' })
  const s = parseChunkPosition(chunkMsg(0, 1, 0, 1, '시작'))
  assert.equal(s!.phase, 'start')
})

test('해석 불가/이상 문구는 null → liveness 로 떨어진다(파싱이 깨져도 감시가 느슨해지지 않는다)', () => {
  for (const m of [null, undefined, 42, '', '모델 로딩 완료', '문장 0/0, 조각 0/0 완료',
                   '문장 5/3, 조각 1/2 완료', '문장 1/3, 조각 9/2 완료']) {
    assert.equal(parseChunkPosition(m as unknown), null, `${String(m)} 는 위치가 아니다`)
  }
  const clock = makeClock()
  const wd = createJobWatchdog({ now: clock.now })
  assert.equal(wd.observe({ percent: 50, message: '알 수 없는 문구' }), 'liveness')
})

test('같은 조각 완료가 두 번 오면 두 번째는 전진이 아니다(원장은 단조 증가)', () => {
  const clock = makeClock()
  const wd = createJobWatchdog({ now: clock.now })
  assert.equal(wd.observe({ percent: 30, message: chunkMsg(0, 4, 0, 2, '완료') }), 'forward')
  clock.advance(1000)
  assert.equal(wd.observe({ percent: 30, message: chunkMsg(0, 4, 0, 2, '완료') }), 'liveness')
  assert.equal(wd.ledger.completedCount, 1)
})

test('evaluate() 는 부수효과가 없다 — 판정을 여러 번 불러도 타이머가 갱신되지 않는다', () => {
  const clock = makeClock()
  const wd = createJobWatchdog({ now: clock.now })
  clock.advance(INACTIVITY_MS)
  assert.equal(wd.evaluate(), 'inactivity-timeout')
  assert.equal(wd.evaluate(), 'inactivity-timeout', '두 번째 호출도 같은 판정')
  clock.advance(1000)
  assert.equal(wd.evaluate(), 'inactivity-timeout')
})

// ═══════════════════════════════════════════════════════════════════════════
// D. checkpoint / resume 계약
// ═══════════════════════════════════════════════════════════════════════════

test('checkpoint 스냅샷 → 복원 → 남은 조각만 재개 계획에 남는다', () => {
  const led = createChunkLedger()
  led.recordComplete({ segIndex: 0, segCount: 2, chunkIndex: 0, chunkCount: 3, phase: 'complete' }, 10)
  led.recordComplete({ segIndex: 0, segCount: 2, chunkIndex: 2, chunkCount: 3, phase: 'complete' }, 20)
  const snap = led.snapshot(20)
  assert.equal(snap.version, 1)
  assert.equal(snap.completed.length, 2)

  const resumed = createChunkLedger(snap)
  const plan = resumed.resumePlan()
  assert.equal(plan.resumable, true)
  assert.deepEqual(plan.remaining, [{ segIndex: 0, chunkIndex: 1 }], '가운데 하나만 다시 만들면 된다')
})

test('완료분이 없으면 재개 불가 — 처음부터 다시(부분 결과를 지어내지 않는다)', () => {
  const plan = createChunkLedger().resumePlan()
  assert.equal(plan.resumable, false)
  assert.equal(plan.reason, 'nothing-completed')
  assert.equal(plan.remaining, null)
})

test('망가진 checkpoint 복원은 실행을 깨뜨리지 않고 완료분 0 으로 떨어진다', () => {
  for (const bad of [null, {}, { version: 2, completed: [{ segIndex: 0, chunkIndex: 0 }] },
                     { version: 1, completed: 'nope' },
                     { version: 1, completed: [null, { segIndex: -1, chunkIndex: 0 }, { segIndex: 'x' }] }]) {
    const led = createChunkLedger(bad as any)
    assert.equal(led.completedCount, 0, `${JSON.stringify(bad)} 는 안전하게 무시돼야 한다`)
  }
})

test('checkpoint 에는 정수 좌표만 담긴다 — 대사·전사·경로가 새지 않는다', () => {
  const led = createChunkLedger()
  led.recordComplete({ segIndex: 1, segCount: 2, chunkIndex: 0, chunkCount: 1, phase: 'complete' }, 5)
  const snap = led.snapshot(5)
  for (const k of snap.completed) {
    assert.deepEqual(Object.keys(k).sort(), ['chunkIndex', 'segIndex'])
    assert.equal(typeof k.segIndex, 'number')
    assert.equal(typeof k.chunkIndex, 'number')
  }
  assert.ok(!JSON.stringify(snap).includes('합성'), '문구가 스냅샷에 실리지 않는다')
})

test('시작 알림은 checkpoint 에 기록되지 않는다', () => {
  const led = createChunkLedger()
  assert.equal(led.recordComplete(
    { segIndex: 0, segCount: 1, chunkIndex: 0, chunkCount: 1, phase: 'start' }, 1), false)
  assert.equal(led.completedCount, 0)
})

// ═══════════════════════════════════════════════════════════════════════════
// E. staging 게이트 — staging 완료 전 final 비공개
// ═══════════════════════════════════════════════════════════════════════════

test('staging 이 끝나기 전에는 final 결과가 공개되지 않는다', () => {
  const published: unknown[] = []
  const gate = createStagingGate<string>((v) => published.push(v), createTerminalGate)
  gate.offerFinal('synthesized.wav')
  assert.equal(published.length, 0, 'staging 미완 — 공개 금지')
  assert.equal(gate.hasPending, true)
  assert.equal(gate.markStagingComplete(), true)
  assert.deepEqual(published, ['synthesized.wav'])
  assert.equal(gate.outcome, 'published')
})

test('staging 이 먼저 끝난 뒤 결과가 오면 즉시 공개된다', () => {
  const published: unknown[] = []
  const gate = createStagingGate<string>((v) => published.push(v), createTerminalGate)
  assert.equal(gate.markStagingComplete(), false, '아직 공개할 결과가 없다')
  gate.offerFinal('a.wav')
  assert.deepEqual(published, ['a.wav'])
})

test('취소·실패로 abandon 되면 보류 결과는 영원히 공개되지 않는다', () => {
  const published: unknown[] = []
  const gate = createStagingGate<string>((v) => published.push(v), createTerminalGate)
  gate.offerFinal('a.wav')
  gate.abandon()
  assert.equal(gate.markStagingComplete(), false)
  gate.offerFinal('b.wav')
  assert.equal(published.length, 0, '폐기 후에는 어떤 결과도 나가지 않는다')
  assert.equal(gate.outcome, 'abandoned')
})

test('공개는 정확히 1회 — 중복 offer/complete 가 결과를 두 번 내보내지 않는다', () => {
  const published: unknown[] = []
  const gate = createStagingGate<string>((v) => published.push(v), createTerminalGate)
  gate.offerFinal('a.wav')
  gate.markStagingComplete()
  gate.markStagingComplete()
  gate.offerFinal('b.wav')
  assert.deepEqual(published, ['a.wav'])
})

// ═══════════════════════════════════════════════════════════════════════════
// F. 진행 표시 계약
// ═══════════════════════════════════════════════════════════════════════════

test('진행 표시 계약: 현재 조각/전체 조각/경과/예상 잔여', () => {
  const clock = makeClock()
  const wd = createJobWatchdog({ now: clock.now })
  clock.advance(100_000)
  wd.observe({ percent: 30, message: chunkMsg(0, 10, 0, 2, '완료') })   // 1/20 완료, 100초 경과
  const r = wd.report()
  assert.equal(r.segIndex, 0)
  assert.equal(r.segCount, 10)
  assert.equal(r.chunkIndex, 0)
  assert.equal(r.chunkCount, 2)
  assert.equal(r.completedChunks, 1)
  assert.equal(r.estimatedTotalChunks, 20)
  assert.equal(r.elapsedMs, 100_000)
  assert.equal(r.etaMs, 1_900_000, '조각당 100초 × 남은 19조각')
  assert.equal(r.sinceForwardMs, 0)
})

test('완료 조각이 0 이면 예상 잔여는 null — 0 으로 위조하지 않는다', () => {
  const clock = makeClock()
  const wd = createJobWatchdog({ now: clock.now })
  clock.advance(50_000)
  wd.observe({ percent: 20, message: loadMsg(50) })
  const r = wd.report()
  assert.equal(r.completedChunks, 0)
  assert.equal(r.etaMs, null)
  assert.equal(r.estimatedTotalChunks, null)
  assert.equal(r.elapsedMs, 50_000)
})

test('sinceForwardMs 는 살아있지만 안 만드는 상태를 그대로 보여준다', () => {
  const clock = makeClock()
  const wd = createJobWatchdog({ now: clock.now })
  wd.observe({ percent: 30, message: chunkMsg(0, 3, 0, 1, '완료') })
  clock.advance(400_000)
  wd.observe({ percent: 30, message: loadMsg(1) })          // liveness 만
  const r = wd.report()
  assert.equal(r.sinceForwardMs, 400_000)
  assert.equal(r.completedChunks, 1)
})

test('setTotalChunks 로 확정 총량이 오면 추정 대신 그 값을 쓴다', () => {
  const clock = makeClock()
  const wd = createJobWatchdog({ now: clock.now })
  wd.observe({ percent: 30, message: chunkMsg(0, 10, 0, 2, '완료') })
  assert.equal(wd.report().estimatedTotalChunks, 20)
  wd.setTotalChunks(13)
  assert.equal(wd.report().estimatedTotalChunks, 13)
  assert.equal(wd.budgetMs, LOAD_BUDGET_MS + 13 * PER_CHUNK_BUDGET_MS + SELF_REPORT_GRACE_MS)
  wd.setTotalChunks(0)
  assert.equal(wd.report().estimatedTotalChunks, 13, '이상값은 확정값을 덮지 못한다')
})
