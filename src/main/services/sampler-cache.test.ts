// 감정 샘플 캐시 + 요청 해석 테스트 — 실제 파일시스템(격리 임시 루트)과 합성 WAV 만 쓴다.
// GPU·모델·Electron·사용자 미디어 없음.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSamplerCache, writeStagedSample, SAMPLER_STAGING_DIR_NAME } from './sampler-cache.ts'
import { resolveSamplerRequest, type SamplerRequestDeps } from './sampler-request.ts'
import { inspectWavContainer, wavSamplesAreFinite } from '../../shared/wavContainer.ts'
import {
  buildEmotionSampleScript, buildEmotionSampleCacheKey, capabilityForRow,
  isCapabilityUsable, emotionSampleExpressionFromTimeline, EMOTION_SAMPLER_DEFAULT_CONFIG,
} from '../../shared/emotionSampler.ts'
import { parseExpressiveTimeline } from '../../shared/expressiveTimeline.ts'
import type { ReferenceStore } from './reference-store.ts'

const CONTRACT = { inspectWavContainer, wavSamplesAreFinite }
const KEY_A = 'a'.repeat(64)
const RUN = 'abcdef01'
const CLIP_SHA = 'c'.repeat(64)

/** mono/24k/16bit 정수 PCM. loud=false 면 전부 0(무음). */
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

function freshCache() {
  const root = join(mkdtempSync(join(tmpdir(), 'afsc-')), 'emotion-sampler-cache')
  return { root, cache: createSamplerCache(CONTRACT, root) }
}

// ── 캐시 등록 ───────────────────────────────────────────────────────────────

test('publish: 검증을 통과한 것만 final 이름을 갖는다', () => {
  const { root, cache } = freshCache()
  const dir = cache.createStagingDir(RUN)
  const staged = writeStagedSample(dir, 'out.wav', pcmWav())

  assert.ok(!existsSync(join(root, `${KEY_A}.wav`)), '검증 전에는 final 이 없다')
  assert.deepEqual(cache.publish(KEY_A, staged), { ok: true, cacheKey: KEY_A })
  assert.ok(existsSync(join(root, `${KEY_A}.wav`)))
  assert.deepEqual(cache.inventory(), [KEY_A])
  assert.equal(cache.has(KEY_A), true)
})

test('publish: 무음 산출물은 캐시로 올리지 않는다', () => {
  const { root, cache } = freshCache()
  const staged = writeStagedSample(cache.createStagingDir(RUN), 'out.wav', pcmWav(2400, false))
  assert.deepEqual(cache.publish(KEY_A, staged), { ok: false, reason: 'CLIP_SILENT' })
  assert.deepEqual(cache.inventory(), [])
  assert.ok(!existsSync(join(root, `${KEY_A}.wav`)))
})

test('publish: 깨진 컨테이너와 잘못된 키를 거부한다', () => {
  const { cache } = freshCache()
  const dir = cache.createStagingDir(RUN)
  const broken = writeStagedSample(dir, 'b.wav', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))
  const res = cache.publish(KEY_A, broken)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.reason, 'CLIP_INVALID')
  assert.equal(res.wavCode, 'INVALID_WAV_CONTAINER')

  const good = writeStagedSample(dir, 'g.wav', pcmWav())
  for (const bad of ['', '../etc/passwd', 'A'.repeat(64) + 'x', 'a'.repeat(63), 'z'.repeat(64)]) {
    assert.deepEqual(cache.publish(bad, good), { ok: false, reason: 'INVALID_KEY' }, bad)
  }
  assert.deepEqual(cache.inventory(), [])
})

test('publish: 산출물이 없으면 실패로 마감하고 아무것도 남기지 않는다', () => {
  const { cache } = freshCache()
  const dir = cache.createStagingDir(RUN)
  assert.deepEqual(cache.publish(KEY_A, join(dir, 'nope.wav')), { ok: false, reason: 'PUBLISH_FAILED' })
  assert.deepEqual(cache.inventory(), [])
})

// ── 조회 / 삭제 / 정리 ──────────────────────────────────────────────────────

test('inventory: 우리가 만든 이름만 목록에 오르고 순서가 결정적이다', () => {
  const { root, cache } = freshCache()
  const dir = cache.createStagingDir(RUN)
  const k2 = 'b'.repeat(64)
  cache.publish(k2, writeStagedSample(dir, '1.wav', pcmWav()))
  cache.publish(KEY_A, writeStagedSample(dir, '2.wav', pcmWav()))
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'notes.txt'), 'x')
  writeFileSync(join(root, 'short.wav'), 'x')

  assert.deepEqual(cache.inventory(), [KEY_A, k2], '사전순 고정, 남의 파일 제외')
})

test('remove: 논리 키 밖 입력은 파일시스템에 닿기 전에 막힌다', () => {
  const { root, cache } = freshCache()
  cache.publish(KEY_A, writeStagedSample(cache.createStagingDir(RUN), 'o.wav', pcmWav()))
  const outside = join(root, '..', 'victim.wav')
  writeFileSync(outside, 'keep')

  for (const bad of ['../victim.wav', '..\\victim.wav', '', 'zz', 'a'.repeat(65)]) {
    assert.deepEqual(cache.remove(bad), { ok: false, reason: 'INVALID_KEY' }, bad)
  }
  assert.equal(readdirSync(root).filter((n) => n.endsWith('.wav')).length, 1)
  assert.equal(existsSync(outside), true, '바깥 파일 불변')

  assert.deepEqual(cache.remove(KEY_A), { ok: true })
  assert.deepEqual(cache.inventory(), [])
  assert.deepEqual(cache.remove(KEY_A), { ok: false, reason: 'NOT_FOUND' })
})

test('staging: 이 run 것만 정리하고 다른 run 은 건드리지 않는다', () => {
  const { root, cache } = freshCache()
  const mine = cache.createStagingDir(RUN)
  const other = cache.createStagingDir('99998888')
  writeStagedSample(mine, 'a.wav', pcmWav())
  writeStagedSample(other, 'b.wav', pcmWav())

  assert.equal(cache.sweepStaging(RUN), true)
  assert.ok(!existsSync(mine))
  assert.ok(existsSync(other))
  assert.ok(existsSync(join(root, SAMPLER_STAGING_DIR_NAME)))
})

test('경로 노출: 목록은 키만 준다', () => {
  const { cache } = freshCache()
  cache.publish(KEY_A, writeStagedSample(cache.createStagingDir(RUN), 'o.wav', pcmWav()))
  const blob = cache.inventory().join('|')
  for (const needle of ['/', '\\', ':', '.wav']) assert.ok(!blob.includes(needle), needle)
})

// ── 요청 해석 ───────────────────────────────────────────────────────────────

const SETTINGS = {
  engineId: 'qwen',
  modelId: 'qwen3-omni-flash',
  config: { ...EMOTION_SAMPLER_DEFAULT_CONFIG },
}

function requestDeps(store: Partial<ReferenceStore>): SamplerRequestDeps {
  return {
    referenceStore: store as ReferenceStore,
    buildEmotionSampleScript,
    parseExpressiveTimeline: (script, opts) => parseExpressiveTimeline(script, opts as never),
    emotionSampleExpressionFromTimeline,
    buildEmotionSampleCacheKey,
    capabilityForRow, isCapabilityUsable,
  }
}

function okStore(over: Partial<ReferenceStore> = {}): Partial<ReferenceStore> {
  return {
    resolveClipFile: () => ({ ok: true, filePath: 'X:/app/clip.wav', clipSha256: CLIP_SHA }),
    resolveTranscript: () => ({
      ok: true,
      sidecar: { schemaVersion: 1, clipId: 'a'.repeat(16), transcriptSha256: 'd'.repeat(64), text: '안녕하세요', language: 'ko' },
    }),
    ...over,
  }
}

test('요청: 논리 ID 만으로 캐시 키·경로·전사를 main 이 해석한다', () => {
  const res = resolveSamplerRequest(requestDeps(okStore()), {
    referenceId: 'a'.repeat(16), rowId: 'emotion_happy', settings: SETTINGS,
  })
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.match(res.cacheKey, /^[0-9a-f]{64}$/)
  assert.equal(res.voiceContentSha256, CLIP_SHA, 'clip_sha256 이 목소리 신원이다')
  assert.equal(res.refText, '안녕하세요')
  assert.equal(res.language, 'ko')
  assert.ok(res.script.length > 0)
})

test('요청: 저장된 클립 바이트가 다르면 캐시 키도 달라진다', () => {
  const a = resolveSamplerRequest(requestDeps(okStore()), {
    referenceId: 'a'.repeat(16), rowId: 'emotion_happy', settings: SETTINGS,
  })
  const b = resolveSamplerRequest(requestDeps(okStore({
    resolveClipFile: () => ({ ok: true, filePath: 'X:/app/clip.wav', clipSha256: 'e'.repeat(64) }),
  })), { referenceId: 'a'.repeat(16), rowId: 'emotion_happy', settings: SETTINGS })
  assert.ok(a.ok && b.ok)
  if (!(a.ok && b.ok)) return
  assert.notEqual(a.cacheKey, b.cacheKey)
})

test('요청: 참조가 없거나 준비되지 않으면 구조화 사유로 막힌다', () => {
  assert.deepEqual(
    resolveSamplerRequest(requestDeps(okStore()), { referenceId: null, rowId: 'emotion_happy', settings: SETTINGS }),
    { ok: false, reason: 'NO_REFERENCE_SELECTED' },
  )
  for (const [reason, expected] of [
    ['NOT_FOUND', 'REFERENCE_NOT_FOUND'], ['CHECKSUM_MISMATCH', 'REFERENCE_NOT_READY'],
    ['NOT_OWNED', 'REFERENCE_NOT_READY'],
  ] as const) {
    const res = resolveSamplerRequest(requestDeps(okStore({
      resolveClipFile: () => ({ ok: false, reason }),
    })), { referenceId: 'a'.repeat(16), rowId: 'emotion_happy', settings: SETTINGS })
    assert.deepEqual(res, { ok: false, reason: expected }, reason)
  }
})

test('요청: 전사 부재·손상·불일치는 각각 다른 사유이고 자동 대체가 없다', () => {
  for (const [reason, expected] of [
    ['TRANSCRIPT_MISSING', 'TRANSCRIPT_MISSING'],
    ['TRANSCRIPT_CORRUPT', 'TRANSCRIPT_CORRUPT'],
    ['TRANSCRIPT_HASH_MISMATCH', 'TRANSCRIPT_HASH_MISMATCH'],
  ] as const) {
    const res = resolveSamplerRequest(requestDeps(okStore({
      resolveTranscript: () => ({ ok: false, reason }),
    })), { referenceId: 'a'.repeat(16), rowId: 'emotion_happy', settings: SETTINGS })
    assert.deepEqual(res, { ok: false, reason: expected }, reason)
  }
})

test('요청: 엔진이 못 하는 행은 요청을 만들지 않는다', () => {
  for (const rowId of ['laugh_chuckle', 'punct_vowel_extend']) {
    const res = resolveSamplerRequest(requestDeps(okStore()), {
      referenceId: 'a'.repeat(16), rowId, settings: SETTINGS,
    })
    assert.deepEqual(res, { ok: false, reason: 'CAPABILITY_NOT_USABLE' }, rowId)
  }
  const bogus = resolveSamplerRequest(requestDeps(okStore()), {
    referenceId: 'a'.repeat(16), rowId: 'no_such_row', settings: SETTINGS,
  })
  assert.deepEqual(bogus, { ok: false, reason: 'INVALID_ROW' })
})
