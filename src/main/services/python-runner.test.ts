// python-runner 종료 전수(terminal totality) 회귀 — Electron·실제 프로세스 없이 spawn을 주입한다.
//
// 불변식: 한 번의 run()은 어떤 경로로 끝나든 'done'을 정확히 1회 방출한다.
//   정상 종료(0) / 비정상 종료(!=0) / 신호 종료(code null) / sync spawn throw / async spawn error / 취소 kill
// done의 1번째 인자는 기존 그대로 code(하위 호환), 2번째 인자가 구조화 RunEnd(reasonCode).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { PythonRunner } from './python-runner.ts'
import { validateSidecarEvent } from '../../shared/sidecarEvents.ts'

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

test('progress 의 job_restarted 는 감시기까지 전달된다(그 외 임의 필드는 버린다)', () => {
  // 참조 사용 방식 '자동'이 안정 방식으로 전환할 때 Python 이 싣는 기계용 선언.
  // 여기서 떨어뜨리면 longform 감시기가 2회차를 '재전송'으로만 보고 무진행으로 오판한다.
  const sp = makeSpawnFake()
  const runner = new PythonRunner('python', { spawn: sp.fn })
  const got: Record<string, unknown>[] = []
  runner.on('progress', (d: Record<string, unknown>) => got.push(d))
  runner.run('script.py', [])
  const c = sp.children[0]
  const feed = (o: unknown) =>
    c.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n', 'utf-8'))
  feed({ type: 'progress', percent: 5, message: '전환', job_restarted: true })
  feed({ type: 'progress', percent: 6, message: '보통', job_restarted: false, secret: 'x' })
  feed({ type: 'progress', percent: 7, message: '보통2', unrelated: 'y' })
  assert.deepEqual(got, [
    { percent: 5, message: '전환', job_restarted: true },
    { percent: 6, message: '보통' },
    { percent: 7, message: '보통2' },
  ])
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

// ── 사이드카(진단) 이벤트 배선 ───────────────────────────────────────────────
//
// 회귀 대상: handleLine 은 progress|status|result|error 만 분기했고, 그 밖의 JSON 은
// **정상 파싱되므로 catch(비-JSON 로그)로도 못 간 채** 완전 침묵으로 사라졌다.
// 이제 허용목록 검증을 통과한 것만 'sidecar' 로 재방출되고, 나머지는 카운터로 관측된다.

function sidecarSetup(spawnFn: any, withValidator: boolean = true) {
  const deps: any = { spawn: spawnFn }
  if (withValidator) deps.validateSidecar = validateSidecarEvent
  const runner = new PythonRunner('python', deps)
  const sidecars: any[] = []
  const errors: unknown[] = []
  runner.on('sidecar', (e: any) => sidecars.push(e))
  runner.on('error', (e: unknown) => errors.push(e))
  runner.run('script.py', [])
  return { runner, sidecars, errors }
}

function feed(child: any, obj: unknown): void {
  child.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n', 'utf-8'))
}

// 실제 Python 방출 형태를 그대로 본뜬 stdout 한 줄.
const DLG_LINE = {
  type: 'dialogueSidecar',
  schema: 'audioforge/dialogue-canonical',
  schemaVersion: '1.0.0',
  sidecar: {
    schema: 'audioforge/dialogue-canonical',
    schema_version: '1.0.0',
    speakers: ['화자 A', '화자 B'],
    source: { pipeline: 'argmax-mask', frame_rate: '50' },
    segments: [
      { start: 0, end: 1.2, speakers: ['화자 A'], posterior: { '화자 A': 1 }, confidence: 1, status: 'OK', is_backchannel: false, is_overlap: false, words: [] },
      { start: 1.2, end: 1.5, speakers: ['화자 B'], posterior: { '화자 B': 1 }, confidence: 1, status: 'OK', is_backchannel: true, is_overlap: false, words: [] }
    ]
  },
  speakerMeta: [
    { id: '화자 A', trackAvailable: true, trackIndex: 0, reviewRequired: false },
    { id: '화자 B', trackAvailable: false, trackIndex: null, reviewRequired: true }
  ],
  interpretation: {
    schemaVersion: '1.0.0', status: 'available', experimental: true, segments: [],
    summary: { overlapCount: 0, unknownCount: 0, reviewCount: 1 },
    thresholds: { reviewBelow: 0.5, unknownBelow: 0.25, overlapMinPosterior: 0.3, note: 'synthetic' },
    source: { pipeline: 'posterior-interpret', frameRate: '50' }
  },
  // Python 이 회귀해 경로/본문을 다시 실었다고 가정 — main 을 넘어가면 안 된다.
  outputDir: 'C:\\Users\\kawae\\AudioForge\\out',
  transcript: '안녕하세요 오늘 회의를 시작하겠습니다'
}

const MUSIC_LINE = {
  type: 'music_p1_shadow', status: 'OK', offsetFrames: 12, polarity: 1, gain: 0.998,
  baselineError: 0.031, candidateError: 0.012, improvement: 0.019,
  candidateEligible: true, elapsedMs: 8.4
}

const ASR_LINE = {
  type: 'asrTranscriptSidecar', schema: 'audioforge/asr-canonical', schemaVersion: '1.0.0',
  language: 'ko', segmentCount: 2,
  provenance: { hallucination_silence_threshold: '2.0', model: 'large-v3', rms_threshold: '0.01', task: 'transcribe' },
  segments: [{ start: 0, end: 1.5, confidence: 0.9, status: 'OK', has_words: true, words: [{ start: 0, end: 0.4, probability: 0.99 }] }],
  summary: { segment_count: 2, word_count: 7, total_duration_sec: 3.5, language: 'ko', status_counts: { OK: 2 }, has_provenance: true }
}

test('e2e(fake spawn): stdout 의 dialogueSidecar 한 줄이 검증된 envelope 로 sidecar 이벤트에 도달한다', () => {
  const sp = makeSpawnFake()
  const s = sidecarSetup(sp.fn)
  feed(sp.children[0], DLG_LINE)
  assert.equal(s.sidecars.length, 1, '예전에는 여기서 흔적 없이 사라졌다')
  const env = s.sidecars[0]
  assert.equal(env.kind, 'dialogueSidecar')
  assert.equal(env.schemaVersion, 1)
  assert.equal(env.payloadSchemaVersion, '1.0.0')
  assert.equal(env.status, 'ok')
  assert.equal(env.sequence, 1)
  assert.deepEqual(env.metrics.speakers, [
    { trackIndex: 0, trackAvailable: true, reviewRequired: false },
    { trackIndex: null, trackAvailable: false, reviewRequired: true }
  ])
  assert.equal(env.metrics.segmentCount, 2)
  assert.equal(env.metrics.backchannelCount, 1)
  const json = JSON.stringify(env)
  for (const needle of ['C:\\', 'Users', '화자', '안녕하세요', '.wav']) {
    assert.equal(json.includes(needle), false, '민감 문자열이 renderer 방향으로 샜다: ' + needle)
  }
  assert.equal(s.runner.sidecarForwardedCount, 1)
  assert.deepEqual(s.runner.unknownEventStats, {})
  assert.deepEqual(s.runner.sidecarRejectStats, {})
})

test('세 종류 모두 전달되고 sequence 는 1부터 단조 증가한다(시계 비의존)', () => {
  const sp = makeSpawnFake()
  const s = sidecarSetup(sp.fn)
  feed(sp.children[0], MUSIC_LINE)
  feed(sp.children[0], DLG_LINE)
  feed(sp.children[0], ASR_LINE)
  assert.deepEqual(s.sidecars.map((e: any) => e.kind),
    ['music_p1_shadow', 'dialogueSidecar', 'asrTranscriptSidecar'])
  assert.deepEqual(s.sidecars.map((e: any) => e.sequence), [1, 2, 3])
  assert.equal(s.runner.sidecarForwardedCount, 3)
})

test('허용목록 밖 type 은 전달되지 않고 타입명으로만 집계된다(조용한 손실 금지)', () => {
  const sp = makeSpawnFake()
  const s = sidecarSetup(sp.fn)
  const c = sp.children[0]
  // Python 이 실제로 내보내는 이웃 이벤트들 — 허용목록에 없다.
  feed(c, { type: 'dialogueSidecarError', message: 'canonical sidecar 생성 실패 C:\\tmp\\x.wav' })
  feed(c, { type: 'dialogueSidecarError', message: '또 실패' })
  feed(c, { type: 'asrTranscriptSidecarError', status: 'unavailable' })
  feed(c, { type: 'brandNewDiagnostic', v: 1 })
  assert.equal(s.sidecars.length, 0, '허용목록 밖은 절대 통과하지 않는다')
  assert.deepEqual(s.runner.unknownEventStats, {
    dialogueSidecarError: 2,
    asrTranscriptSidecarError: 1,
    brandNewDiagnostic: 1
  })
  assert.equal(JSON.stringify(s.runner.unknownEventStats).includes('C:'), false,
    '카운터에는 타입명과 개수만 남는다 — payload 는 담지 않는다')
})

test('type 이 없거나 문자열이 아니거나 경로처럼 생기면 버킷 키로 집계된다', () => {
  const sp = makeSpawnFake()
  const s = sidecarSetup(sp.fn)
  const c = sp.children[0]
  feed(c, { noType: 1 })
  feed(c, { type: 42 })
  feed(c, { type: 'C:\\Users\\kawae\\evil.wav' })
  feed(c, { type: '안녕하세요 아주 긴 전사 본문이 타입 자리에 들어온 경우' })
  assert.equal(s.sidecars.length, 0)
  assert.deepEqual(s.runner.unknownEventStats, { '(no-type)': 2, '(unsafe-type)': 2 })
})

test('허용목록 안이지만 payload 가 깨졌으면 reasonCode 로 집계하고 아무것도 보내지 않는다', () => {
  const sp = makeSpawnFake()
  const s = sidecarSetup(sp.fn)
  const c = sp.children[0]
  const noVer: any = { ...DLG_LINE }
  delete noVer.schemaVersion
  feed(c, noVer)                                    // schema-version-missing
  feed(c, { ...ASR_LINE, schemaVersion: '2.0.0' })  // schema-version-unsupported
  feed(c, { ...MUSIC_LINE, status: 'WAT' })         // metrics-invalid
  feed(c, { ...DLG_LINE, schemaVersion: 'v1' })     // schema-version-invalid
  assert.equal(s.sidecars.length, 0)
  assert.deepEqual(s.runner.sidecarRejectStats, {
    'schema-version-missing': 1,
    'schema-version-unsupported': 1,
    'metrics-invalid': 1,
    'schema-version-invalid': 1
  })
  assert.deepEqual(s.runner.unknownEventStats, {}, '거절은 unknown 이 아니다 — 사유별로 따로 센다')
  assert.equal(s.errors.length, 0, '거절이 run 을 실패시키면 안 된다')
})

test('검증기가 throw 해도 앱이 죽지 않고 validator-threw 로 집계된다', () => {
  const sp = makeSpawnFake()
  const runner = new PythonRunner('python', {
    spawn: sp.fn,
    validateSidecar: () => { throw new Error('검증기 폭발 모의') }
  })
  const sidecars: unknown[] = []
  runner.on('sidecar', (e: unknown) => sidecars.push(e))
  runner.run('script.py', [])
  feed(sp.children[0], DLG_LINE)
  assert.equal(sidecars.length, 0)
  assert.deepEqual(runner.sidecarRejectStats, { 'validator-threw': 1 })
  sp.children[0].emit('close', 0, null)   // 실행은 정상적으로 마감된다
})

test('검증기 미주입 → fail-closed: 아무것도 전달하지 않고 전부 unknown 으로 관측된다', () => {
  const sp = makeSpawnFake()
  const s = sidecarSetup(sp.fn, false)
  feed(sp.children[0], DLG_LINE)
  feed(sp.children[0], MUSIC_LINE)
  assert.equal(s.sidecars.length, 0)
  assert.deepEqual(s.runner.unknownEventStats, { dialogueSidecar: 1, music_p1_shadow: 1 })
})

test('사이드카 줄이 청크 경계로 쪼개져도 라인 버퍼링으로 온전히 도달한다', () => {
  const sp = makeSpawnFake()
  const s = sidecarSetup(sp.fn)
  const raw = JSON.stringify(MUSIC_LINE) + '\n'
  const cut = Math.floor(raw.length / 2)
  sp.children[0].stdout.emit('data', Buffer.from(raw.slice(0, cut), 'utf-8'))
  assert.equal(s.sidecars.length, 0, '아직 줄이 끝나지 않았다')
  sp.children[0].stdout.emit('data', Buffer.from(raw.slice(cut), 'utf-8'))
  assert.equal(s.sidecars.length, 1)
  assert.equal(s.sidecars[0].metrics.offsetFrames, 12)
})

test('개행 없이 끝난 마지막 사이드카 줄도 close 에서 flush 된다', () => {
  const sp = makeSpawnFake()
  const s = sidecarSetup(sp.fn)
  sp.children[0].stdout.emit('data', Buffer.from(JSON.stringify(ASR_LINE), 'utf-8'))
  assert.equal(s.sidecars.length, 0)
  sp.children[0].emit('close', 0, null)
  assert.equal(s.sidecars.length, 1)
  assert.equal(s.sidecars[0].kind, 'asrTranscriptSidecar')
})

test('sidecar 리스너가 throw 해도 run 은 정상 마감되고 원본 줄이 로그로 새지 않는다', () => {
  const sp = makeSpawnFake()
  const runner = new PythonRunner('python', { spawn: sp.fn, validateSidecar: validateSidecarEvent })
  const dones: unknown[] = []
  runner.on('done', (code: unknown) => dones.push(code))
  runner.on('sidecar', () => { throw new Error('소비자 폭발 모의') })
  runner.run('script.py', [])
  // 소비자 예외가 바깥 catch 로 새면 그쪽이 '비-JSON'으로 오해해 원본 줄을 통째로 찍는다.
  // 회귀한 payload 에는 경로·전사 본문이 들어있을 수 있으므로 그 경로를 막았는지 확인한다.
  const logged: string[] = []
  const realLog = console.log
  console.log = (...a: unknown[]) => { logged.push(a.map(String).join(' ')) }
  try {
    assert.doesNotThrow(() => feed(sp.children[0], DLG_LINE))
    sp.children[0].emit('close', 0, null)
  } finally {
    console.log = realLog
  }
  assert.deepEqual(dones, [0])
  assert.equal(runner.sidecarForwardedCount, 1, '전달 자체는 성공으로 집계된다')
  const all = logged.join('\n')
  for (const needle of ['C:\\', '안녕하세요', '화자 A', 'dialogueSidecar']) {
    assert.equal(all.includes(needle), false, `원본 줄이 로그로 샜다: ${needle}`)
  }
})

test('회귀: 검증기를 주입해도 progress/status/result/error 의미는 전혀 바뀌지 않는다', () => {
  const sp = makeSpawnFake()
  const runner = new PythonRunner('python', { spawn: sp.fn, validateSidecar: validateSidecarEvent })
  const got: Record<string, unknown[]> = { progress: [], result: [], error: [], sidecar: [] }
  runner.on('progress', (d: unknown) => got.progress.push(d))
  runner.on('result', (d: unknown) => got.result.push(d))
  runner.on('error', (d: unknown) => got.error.push(d))
  runner.on('sidecar', (d: unknown) => got.sidecar.push(d))
  runner.run('script.py', [])
  const c = sp.children[0]
  feed(c, { type: 'status', percent: 5, message: '시작' })
  feed(c, { type: 'progress', percent: 50, message: '반' })
  feed(c, { type: 'error', message: '모의', code: 'X' })
  feed(c, { type: 'result', tracks: [] })
  assert.deepEqual(got.progress, [{ percent: 5, message: '시작' }, { percent: 50, message: '반' }])
  assert.equal(got.result.length, 1)
  assert.deepEqual(got.result[0], { type: 'result', tracks: [] }, 'result 는 msg 원본 그대로')
  assert.equal(got.error.length, 1)
  assert.deepEqual(got.error[0], { type: 'error', message: '모의', code: 'X' }, '구조화 오류 원본 그대로')
  assert.equal(got.sidecar.length, 0, '핵심 네 종류는 사이드카 경로로 새지 않는다')
  assert.deepEqual(runner.unknownEventStats, {})
  assert.deepEqual(runner.sidecarRejectStats, {})
  c.emit('close', 0, null)
})

test('회귀: 비-JSON stdout 은 예전처럼 조용히 무시된다(카운터도 오르지 않는다)', () => {
  const sp = makeSpawnFake()
  const s = sidecarSetup(sp.fn)
  const c = sp.children[0]
  c.stdout.emit('data', Buffer.from('  50%|#####     | 5/10 [00:03<00:03]\n', 'utf-8'))
  c.stdout.emit('data', Buffer.from('\n', 'utf-8'))
  c.stdout.emit('data', Buffer.from('null\n', 'utf-8'))
  assert.equal(s.sidecars.length, 0)
  assert.deepEqual(s.runner.unknownEventStats, {})
  assert.deepEqual(s.runner.sidecarRejectStats, {})
})
