// 감정 샘플 생성 오케스트레이션 테스트 — 가짜 runner 와 합성 WAV 만 쓴다.
// 실제 모델·GPU·Electron 없음.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSamplerGenerator, createTerminalOnce,
  type SamplerRunOutcome, type SamplerJob,
} from './sampler-generation.ts'
import { createSamplerCache, writeStagedSample, SAMPLER_STAGING_DIR_NAME } from './sampler-cache.ts'
import { inspectWavContainer, wavSamplesAreFinite } from '../../shared/wavContainer.ts'
import type { SamplerRequestResolved } from './sampler-request.ts'

const CONTRACT = { inspectWavContainer, wavSamplesAreFinite }
const KEY = 'a'.repeat(64)

function pcmWav(frames = 2400, loud = true): Uint8Array {
  const dataSize = frames * 2
  const b = new Uint8Array(44 + dataSize)
  const dv = new DataView(b.buffer)
  const put = (s: string, at: number): void => { for (let i = 0; i < 4; i++) b[at + i] = s.charCodeAt(i) }
  put('RIFF', 0); dv.setUint32(4, 36 + dataSize, true); put('WAVE', 8)
  put('fmt ', 12); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, 24000, true); dv.setUint32(28, 48000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  put('data', 36); dv.setUint32(40, dataSize, true)
  if (loud) for (let i = 0; i < frames; i++) dv.setInt16(44 + i * 2, i % 2 ? 9000 : -9000, true)
  return b
}

const REQUEST: SamplerRequestResolved = {
  ok: true,
  cacheKey: KEY,
  filePath: 'X:/app/clip.wav',
  refText: '안녕하세요',
  language: 'ko',
  script: '[기쁨] 오늘은 좋은 날이에요.',
  expression: { family: 'emotion', rowId: 'emotion_happy', kind: 'emotionTransition', strength: 100 },
  voiceContentSha256: 'c'.repeat(64),
}

interface Harness {
  root: string
  jobs: SamplerJob[]
  generator: ReturnType<typeof createSamplerGenerator>
  cache: ReturnType<typeof createSamplerCache>
  stagingNames(): string[]
}

function harness(outcome: (job: SamplerJob) => Promise<SamplerRunOutcome> | SamplerRunOutcome): Harness {
  const root = join(mkdtempSync(join(tmpdir(), 'afgen-')), 'emotion-sampler-cache')
  const cache = createSamplerCache(CONTRACT, root)
  const jobs: SamplerJob[] = []
  let seq = 0
  const generator = createSamplerGenerator({
    cache,
    runner: { run: async (job) => { jobs.push(job); return outcome(job) } },
    makeRunId: () => { seq += 1; return seq.toString(16).padStart(8, '0') },
  })
  return {
    root, jobs, generator, cache,
    stagingNames: () => {
      try { return readdirSync(join(root, SAMPLER_STAGING_DIR_NAME)) } catch { return [] }
    },
  }
}

/** 성공 산출물을 staging 에 실제로 만들어 주는 가짜 runner. */
function successRunner(bytes: Uint8Array = pcmWav()) {
  return (job: SamplerJob): SamplerRunOutcome => ({
    kind: 'success', outputPath: writeStagedSample(job.stagingDir, 'sample.wav', bytes),
  })
}

// ── 성공 경로 ───────────────────────────────────────────────────────────────

test('성공: 검증을 통과한 결과만 캐시에 오르고 staging 은 남지 않는다', async () => {
  const h = harness(successRunner())
  const res = await h.generator.generate(REQUEST)

  assert.deepEqual(res, { status: 'ready', cacheKey: KEY, reused: false })
  assert.deepEqual(h.cache.inventory(), [KEY])
  assert.deepEqual(h.stagingNames(), [], '이번 run 의 staging 이 정리됐다')
  assert.equal(h.generator.inFlight, 0)
})

test('성공: 실행 job 에 참조 실체가 전달되고 결과에는 남지 않는다', async () => {
  const h = harness(successRunner())
  const res = await h.generator.generate(REQUEST)

  assert.equal(h.jobs.length, 1)
  assert.equal(h.jobs[0].referenceAudioPath, REQUEST.filePath, 'runner 는 실제 경로를 받는다')
  assert.equal(h.jobs[0].referenceText, REQUEST.refText)
  assert.equal(h.jobs[0].script, REQUEST.script)

  // 반환값에는 경로·전사·대본이 없다(그대로 renderer 로 나가도 안전해야 한다).
  const blob = JSON.stringify(res)
  for (const secret of [REQUEST.filePath, REQUEST.refText, REQUEST.script, 'X:', '/']) {
    assert.ok(!blob.includes(secret), `결과에 ${secret} 없음`)
  }
})

test('캐시 히트: 이미 있으면 실행하지 않는다', async () => {
  const h = harness(successRunner())
  await h.generator.generate(REQUEST)
  const again = await h.generator.generate(REQUEST)

  assert.deepEqual(again, { status: 'ready', cacheKey: KEY, reused: true })
  assert.equal(h.jobs.length, 1, '두 번째 요청은 runner 를 부르지 않는다')
})

// ── 실패 경로 — 어느 것도 캐시에 오르지 않는다 ──────────────────────────────

test('실패: error/cancel/limit/no-result 는 캐시에 등록되지 않는다', async () => {
  const cases: [SamplerRunOutcome, string, string | undefined][] = [
    [{ kind: 'error', code: 'ENGINE' }, 'failed', 'RUN_FAILED'],
    [{ kind: 'cancelled' }, 'cancelled', undefined],
    [{ kind: 'limit' }, 'limitExceeded', undefined],
    [{ kind: 'no-result' }, 'failed', 'NO_RESULT'],
  ]
  for (const [outcome, status, reason] of cases) {
    const h = harness(() => outcome)
    const res = await h.generator.generate(REQUEST)
    assert.equal(res.status, status, outcome.kind)
    assert.equal(res.reason, reason, outcome.kind)
    assert.equal(res.reused, false)
    assert.deepEqual(h.cache.inventory(), [], `${outcome.kind}: 캐시 미등록`)
    assert.deepEqual(h.stagingNames(), [], `${outcome.kind}: staging 정리`)
  }
})

test('실패: 성공을 주장해도 무음·깨진 WAV 는 캐시에 오르지 않는다', async () => {
  const silent = harness(successRunner(pcmWav(2400, false)))
  const a = await silent.generator.generate(REQUEST)
  assert.equal(a.status, 'failed')
  assert.equal(a.reason, 'CLIP_SILENT')
  assert.deepEqual(silent.cache.inventory(), [])

  const broken = harness((job) => ({
    kind: 'success', outputPath: writeStagedSample(job.stagingDir, 'x.wav', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])),
  }))
  const b = await broken.generator.generate(REQUEST)
  assert.equal(b.status, 'failed')
  assert.equal(b.reason, 'CLIP_INVALID')
  assert.deepEqual(broken.cache.inventory(), [])
  assert.deepEqual(broken.stagingNames(), [])
})

test('실패: runner 가 던져도 마감되고 staging 이 남지 않는다', async () => {
  const h = harness(() => { throw new Error('boom') })
  const res = await h.generator.generate(REQUEST)
  assert.equal(res.status, 'failed')
  assert.equal(res.reason, 'RUN_FAILED')
  assert.deepEqual(h.cache.inventory(), [])
  assert.deepEqual(h.stagingNames(), [])
})

test('실패: 산출물 경로가 없으면 성공으로 올리지 않는다', async () => {
  const h = harness((job) => ({ kind: 'success', outputPath: join(job.stagingDir, 'missing.wav') }))
  const res = await h.generator.generate(REQUEST)
  assert.equal(res.status, 'failed')
  assert.equal(res.reason, 'PUBLISH_FAILED')
  assert.deepEqual(h.cache.inventory(), [])
})

// ── 중복 실행 차단 ──────────────────────────────────────────────────────────

test('single-flight: 같은 키의 동시 요청은 한 번만 실행된다', async () => {
  let release: (() => void) | null = null
  const gate = new Promise<void>((r) => { release = r })
  const h = harness(async (job) => {
    await gate
    return { kind: 'success', outputPath: writeStagedSample(job.stagingDir, 's.wav', pcmWav()) }
  })

  const p1 = h.generator.generate(REQUEST)
  const p2 = h.generator.generate(REQUEST)
  const p3 = h.generator.generate(REQUEST)
  assert.equal(h.generator.inFlight, 1, '진행 중인 실행은 하나')
  release?.()

  const [r1, r2, r3] = await Promise.all([p1, p2, p3])
  assert.equal(h.jobs.length, 1, 'runner 는 한 번만 불린다')
  assert.deepEqual([r1.status, r2.status, r3.status], ['ready', 'ready', 'ready'])
  assert.deepEqual(h.cache.inventory(), [KEY])
  assert.equal(h.generator.inFlight, 0, '끝나면 해제된다')
})

test('single-flight: 다른 키는 각자 실행된다', async () => {
  const h = harness(successRunner())
  const other = { ...REQUEST, cacheKey: 'b'.repeat(64) }
  await Promise.all([h.generator.generate(REQUEST), h.generator.generate(other)])
  assert.equal(h.jobs.length, 2)
  assert.deepEqual(h.cache.inventory(), [KEY, 'b'.repeat(64)])
})

test('single-flight: 실패 후에는 다시 시도할 수 있다(자동 재시도는 아니다)', async () => {
  let attempt = 0
  const h = harness((job) => {
    attempt += 1
    return attempt === 1
      ? { kind: 'error' }
      : { kind: 'success', outputPath: writeStagedSample(job.stagingDir, 's.wav', pcmWav()) }
  })
  const first = await h.generator.generate(REQUEST)
  assert.equal(first.status, 'failed')
  assert.equal(h.jobs.length, 1, '스스로 다시 시도하지 않는다')

  const second = await h.generator.generate(REQUEST)   // 사용자가 다시 눌렀다
  assert.equal(second.status, 'ready')
  assert.equal(h.jobs.length, 2)
})

// ── terminal 1회 ────────────────────────────────────────────────────────────

test('terminal: 여러 번 마감을 시도해도 한 번만 확정된다', () => {
  const gate = createTerminalOnce<string>()
  assert.equal(gate.settle('result'), true)
  assert.equal(gate.settle('error'), false, '늦은 error 는 결과를 덮지 않는다')
  assert.equal(gate.settle('done'), false)
  assert.equal(gate.value, 'result')
  assert.equal(gate.settled, true)
  assert.equal(gate.count, 3, '중복 시도는 관측만 남는다')
})

test('terminal: 실행 한 번에 결과도 한 번이다', async () => {
  const gate = createTerminalOnce<string>()
  const h = harness(successRunner())
  const res = await h.generator.generate(REQUEST)
  gate.settle(res.status)
  gate.settle('late-done')
  assert.equal(gate.value, 'ready')
  assert.equal(h.jobs.length, 1)
})
