// 목소리 준비 실행부 — 화면 없이, 가짜 파이썬 통로로 시험한다.
//
// 여기서 지키는 것(전부 실측 결함의 흔적이다)
//   · 같은 요청은 한 번만 돈다 — 그 기억이 화면 밖에 있어 **다시 마운트돼도 되풀이되지 않는다**
//   · 파이썬 통로는 하나뿐이라 **겹쳐 부르지 않는다**(줄을 세운다)
//   · 늦게 온 결과는 버린다. 취소하면 그 자리는 다시 돌릴 수 있다
//   · 쓰고 있는 목소리가 있으면 '준비 중'으로 내리지 않는다
//   · 확정에 실패해도 쓰던 목소리는 그대로 둔다
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  cancelVoicePrep, forgetVoicePrep, runVoicePrep, voicePrepStarted,
  type VoicePrepJob,
} from './voicePrepRunner.ts'

// ── 가짜 파이썬 통로 ──────────────────────────────────────────────────────────
interface Call { kind: 'analyze' | 'trim'; args: unknown[]; at: number }
let calls: Call[] = []
let inFlight = 0
let maxInFlight = 0
let analyzeReply: (path: string) => unknown
let trimReply: (start: number, dur: number) => unknown
let holdAnalyze: (() => void) | null = null      // 분석을 붙잡아 둘 때 쓰는 손잡이

function installFakeApi() {
  const track = async <T>(kind: Call['kind'], args: unknown[], make: () => T | Promise<T>): Promise<T> => {
    calls.push({ kind, args, at: Date.now() })
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    try { return await make() } finally { inFlight -= 1 }
  }
  ;(globalThis as { window?: unknown }).window = {
    api: {
      audio: {
        analyzeReference: (path: string, clipKey: string, opts: unknown) =>
          track('analyze', [path, clipKey, opts], async () => {
            if (holdAnalyze) await new Promise<void>((r) => { holdAnalyze = r })
            return analyzeReply(path)
          }),
        trimReference: (path: string, start: number, dur: number, clipKey: string, opts: unknown) =>
          track('trim', [path, start, dur, clipKey, opts], () => trimReply(start, dur)),
      },
    },
  }
}

const policy = { engine: 'gptsovits', required: { min_sec: 3, max_sec: 10 }, recommended: { min_sec: 5, max_sec: 10 }, basis: '', recommended_basis: '' }
const wholeOk = { duration_sec: 8, sample_rate: 24000, channels: 1, needs_region: false, too_short: false, valid_whole: true, policy }
const needsRegion = { ...wholeOk, duration_sec: 40, needs_region: true, valid_whole: false, region_required: true, recommend: { ok: true, start_sec: 4, dur_sec: 7 } }
const trimOk = { clip_path: 'C:/out.wav', metrics: { ready: true, blocking: [], effective_region: { start_sec: 4, end_sec: 11, dur_sec: 7 } } }

function job(over: Partial<VoicePrepJob> = {}): VoicePrepJob & { reports: Record<string, unknown>[] } {
  const reports: Record<string, unknown>[] = []
  return {
    clipKey: 'lab', path: 'C:/voice.wav', reqId: 'r1', engine: 'gptsovits', refTargetSec: 0, plain: false,
    committedNow: () => null,
    report: (p) => { reports.push(p as Record<string, unknown>) },
    reports,
    ...over,
  } as VoicePrepJob & { reports: Record<string, unknown>[] }
}

beforeEach(() => {
  calls = []; inFlight = 0; maxInFlight = 0; holdAnalyze = null
  analyzeReply = () => wholeOk
  trimReply = () => trimOk
  installFakeApi()
  for (const k of ['lab', 'default', 'spk:A', 'spk:B']) cancelVoicePrep(k)
})

// ── 한 번만 ───────────────────────────────────────────────────────────────────

test('같은 (자리·파일·요청)은 한 번만 돈다 — 화면이 다시 떠도 되풀이되지 않는다', async () => {
  const j = job()
  assert.equal(await runVoicePrep(j), 'ready')
  assert.equal(await runVoicePrep(job()), 'skipped', '같은 요청은 건너뛴다')
  assert.equal(await runVoicePrep(job()), 'skipped')
  assert.equal(calls.filter((c) => c.kind === 'analyze').length, 1, '분석은 한 번만 불렀다')
  assert.equal(voicePrepStarted({ clipKey: 'lab', path: 'C:/voice.wav', reqId: 'r1', engine: 'gptsovits', refTargetSec: 0 }), true)
})

test('요청 식별자가 바뀌면 다시 돈다 — 다시 준비는 새 요청이다', async () => {
  await runVoicePrep(job())
  assert.equal(await runVoicePrep(job({ reqId: 'r2' })), 'ready')
  assert.equal(calls.filter((c) => c.kind === 'analyze').length, 2)
})

test('엔진이나 목표 길이가 바뀌면 다시 돈다 — 추천 구간이 달라지므로 다시 물어야 한다', async () => {
  await runVoicePrep(job())
  assert.equal(await runVoicePrep(job({ engine: 'qwen3' })), 'ready')
  assert.equal(await runVoicePrep(job({ refTargetSec: 20 })), 'ready')
  assert.equal(calls.filter((c) => c.kind === 'analyze').length, 3)
})

test('파일이 바뀌면 다시 돈다', async () => {
  await runVoicePrep(job())
  assert.equal(await runVoicePrep(job({ path: 'C:/other.wav' })), 'ready')
  assert.equal(calls.filter((c) => c.kind === 'analyze').length, 2)
})

test('잊으면 같은 요청도 다시 돈다 — 손으로 다시 준비를 누를 길', async () => {
  await runVoicePrep(job())
  forgetVoicePrep('lab')
  assert.equal(await runVoicePrep(job()), 'ready')
  assert.equal(calls.filter((c) => c.kind === 'analyze').length, 2)
})

// ── 줄 세우기 ─────────────────────────────────────────────────────────────────

test('파이썬 통로는 하나 — 두 자리를 동시에 불러도 겹치지 않는다', async () => {
  const a = runVoicePrep(job({ clipKey: 'spk:A', path: 'C:/a.wav' }))
  const b = runVoicePrep(job({ clipKey: 'spk:B', path: 'C:/b.wav' }))
  await Promise.all([a, b])
  assert.equal(maxInFlight, 1, `동시에 돈 호출이 ${maxInFlight}건 — 1이어야 한다`)
  assert.equal(calls.filter((c) => c.kind === 'analyze').length, 2, '둘 다 돌긴 한다')
})

test('앞 작업이 실패해도 뒷 작업은 돈다', async () => {
  analyzeReply = (p) => (p === 'C:/a.wav' ? { bad: true } : wholeOk)
  const a = runVoicePrep(job({ clipKey: 'spk:A', path: 'C:/a.wav' }))
  const b = runVoicePrep(job({ clipKey: 'spk:B', path: 'C:/b.wav' }))
  assert.equal(await a, 'failed')
  assert.equal(await b, 'ready')
})

// ── 취소·늦은 결과 ────────────────────────────────────────────────────────────

test('취소하면 늦게 온 결과를 보고하지 않고, 그 자리는 다시 돌릴 수 있다', async () => {
  holdAnalyze = () => {}                       // 분석을 붙잡는다
  const j = job()
  const p = runVoicePrep(j)
  await new Promise((r) => setTimeout(r, 10))
  cancelVoicePrep('lab')
  ;(holdAnalyze as unknown as () => void)?.()  // 이제 분석이 끝난다
  holdAnalyze = null
  assert.equal(await p, 'cancelled')
  assert.ok(!j.reports.some((r) => r.phase === 'ready'), '준비됐다고 보고하지 않는다')
  assert.equal(await runVoicePrep(job()), 'ready', '취소한 자리는 다시 돌릴 수 있다')
})

// ── 보고 내용 ─────────────────────────────────────────────────────────────────

test('모든 보고에 요청 식별자가 붙는다 — store 가 낡은 보고를 버릴 수 있게', async () => {
  const j = job({ reqId: 'req-77' })
  await runVoicePrep(j)
  assert.ok(j.reports.length > 0)
  for (const r of j.reports) assert.equal(r.reqId, 'req-77')
})

test('쓰고 있는 목소리가 있으면 준비 중으로 내리지 않는다', async () => {
  const j = job({ committedNow: () => ({ clip: 'C:/old.wav', region: { start: 1, duration: 7 } }) })
  await runVoicePrep(j)
  assert.ok(!j.reports.some((r) => r.phase === 'preparing'), '준비 중을 올리지 않는다')
})

test('쓰던 것이 없으면 준비 중을 먼저 알린다 — 쉬운 말 화면은 다른 문구로', async () => {
  const j = job()
  await runVoicePrep(j)
  assert.equal(j.reports[0].phase, 'preparing')
  assert.equal(j.reports[0].message, '참조 음성을 분석 중입니다...')

  const plain = job({ clipKey: 'default', plain: true })
  await runVoicePrep(plain)
  assert.equal(plain.reports[0].message, '목소리를 살펴보는 중입니다…')
})

// ── 자동 확정 ─────────────────────────────────────────────────────────────────

test('구간이 필요하면 추천 구간으로 대신 확정하고 준비됨을 알린다', async () => {
  analyzeReply = () => needsRegion
  const j = job()
  assert.equal(await runVoicePrep(j), 'ready')
  const trim = calls.find((c) => c.kind === 'trim')
  assert.ok(trim, '구간을 잘랐다')
  assert.deepEqual(trim?.args.slice(0, 4), ['C:/voice.wav', 4, 7, 'lab'], '추천 구간·자기 자리로 자른다')
  const last = j.reports[j.reports.length - 1]
  assert.equal(last.phase, 'ready')
  assert.equal(last.clip, 'C:/out.wav')
  assert.deepEqual(last.region, { start: 4, duration: 7 }, '실제로 잘린 구간을 저장한다')
})

test('원본을 그대로 쓸 수 있으면 자르지 않는다', async () => {
  const j = job()
  assert.equal(await runVoicePrep(j), 'ready')
  assert.equal(calls.filter((c) => c.kind === 'trim').length, 0)
  assert.equal(j.reports[j.reports.length - 1].phase, 'ready')
})

test('추천이 없으면 임의로 자르지 않고 사용자 차례임을 알린다', async () => {
  analyzeReply = () => ({ ...needsRegion, recommend: { ok: false, start_sec: 0, dur_sec: 0 } })
  const j = job()
  assert.equal(await runVoicePrep(j), 'needs_region')
  assert.equal(calls.filter((c) => c.kind === 'trim').length, 0, '자르지 않는다')
  assert.ok(j.reports.some((r) => r.phase === 'needs_region'))
  assert.ok(!j.reports.some((r) => r.phase === 'preparing' && r === j.reports[j.reports.length - 1]),
    '준비 중으로 끝나지 않는다 — 끝나지 않는 상태를 남기지 않는다')
})

// ── 실패 ──────────────────────────────────────────────────────────────────────

test('분석이 실패하면 사유를 알리고 자르지 않는다', async () => {
  analyzeReply = () => { throw new Error('파이썬 없음') }
  const j = job()
  assert.equal(await runVoicePrep(j), 'failed')
  assert.equal(calls.filter((c) => c.kind === 'trim').length, 0)
  const last = j.reports[j.reports.length - 1]
  assert.equal(last.phase, 'failed')
  assert.ok(String(last.message).includes('파이썬 없음'))
})

test('분석 응답이 형식에 맞지 않으면 실패로 본다 — 빈 화면 대신 사유', async () => {
  analyzeReply = () => ({ reason: '읽을 수 없는 파일' })
  const j = job()
  assert.equal(await runVoicePrep(j), 'failed')
  assert.ok(String(j.reports[j.reports.length - 1].message).includes('읽을 수 없는 파일'))
})

test('이미 쓰고 있는 목소리가 있으면 자르지 않고 끝낸다 — 준비는 이미 된 것이다', async () => {
  analyzeReply = () => needsRegion
  const j = job({ committedNow: () => ({ clip: 'C:/old.wav', region: { start: 1, duration: 7 } }) })
  assert.equal(await runVoicePrep(j), 'ready')
  assert.equal(calls.filter((c) => c.kind === 'trim').length, 0, '다시 자르지 않는다')
  assert.deepEqual(j.reports, [], '아무것도 내리지 않는다')
})

test('★자르는 동안 다른 길로 목소리가 준비되면, 자르기 실패가 그것을 내리지 않는다', async () => {
  // 실제로 일어나는 경쟁이다 — 첫 인물 이어받기·작업 복원이 같은 슬롯을 채울 수 있다.
  analyzeReply = () => needsRegion
  trimReply = () => ({ status: 'failed', error_message: '무음이 너무 많습니다' })
  let seen = 0
  const j = job({
    // 자르기 결과를 판정하는 시점(네 번째 조회)부터 '쓰고 있다'가 된다.
    committedNow: () => (++seen >= 4 ? { clip: 'C:/late.wav', region: { start: 1, duration: 7 } } : null),
  })
  assert.equal(await runVoicePrep(j), 'kept')
  assert.ok(!j.reports.some((r) => r.phase === 'failed'), '실패로 내리지 않는다')
})

test('쓰던 것이 없을 때 확정이 실패하면 사유를 알린다', async () => {
  analyzeReply = () => needsRegion
  trimReply = () => ({ status: 'failed', error_message: '무음이 너무 많습니다' })
  const j = job()
  assert.equal(await runVoicePrep(j), 'failed')
  assert.equal(j.reports[j.reports.length - 1].message, '무음이 너무 많습니다')
})

test('자르기가 통로째 끊겨도, 그 사이 준비된 목소리가 있으면 지킨다', async () => {
  analyzeReply = () => needsRegion
  trimReply = () => { throw new Error('통로 끊김') }
  let seen = 0
  const j = job({ committedNow: () => (++seen >= 4 ? { clip: 'C:/late.wav', region: { start: 1, duration: 7 } } : null) })
  assert.equal(await runVoicePrep(j), 'kept')
  assert.ok(!j.reports.some((r) => r.phase === 'failed'))
})

test('정책 요약을 호출부에 넘긴다 — 카드·자산이 같은 값을 본다', async () => {
  let got: unknown = null
  await runVoicePrep(job({ onPolicy: (p) => { got = p } }))
  assert.deepEqual((got as { required: unknown })?.required, { min_sec: 3, max_sec: 10 })
})
