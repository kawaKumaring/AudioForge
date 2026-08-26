// 진단 미리듣기 타임라인 단위테스트 — 합성 데이터만. 오디오·파일·GPU 없음.
//
// 검증 축:
//   1) 앞 500ms · 뒤 500ms 가 정확하고, 원본 길이는 손대지 않는다
//   2) 진단 정적 구간에서는 소리가 나지 않는다
//   3) 이 값이 합성·캐시 키·최종 결과물로 새지 않는다(소스 대조로 고정)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  EMOTION_PREVIEW_SILENCE_MS,
  buildEmotionPreviewTimeline,
  emotionPreviewStageAt,
  emotionPreviewIsSilent,
} from './emotionSamplePreview.ts'
import {
  buildEmotionSampleCacheKey,
  canonicalEmotionSampleKeyPayload,
  EMOTION_SAMPLER_PARITY_INPUT,
  EMOTION_SAMPLER_PARITY_KEY,
  EMOTION_SAMPLER_PARITY_PAYLOAD,
} from './emotionSampler.ts'

const SRC_DIR = fileURLToPath(new URL('../', import.meta.url))
const PY_DIR = fileURLToPath(new URL('../../python/', import.meta.url))

function readSource(path: string): string {
  return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n')
}

// ── 1) 앞뒤 정적 길이 ────────────────────────────────────────────────────────

test('진단 무음: 앞 500ms 가 정확하다', () => {
  assert.equal(EMOTION_PREVIEW_SILENCE_MS, 500)
  const tl = buildEmotionPreviewTimeline(1234)
  assert.equal(tl.leadInMs, 500)
  assert.equal(tl.sampleStartMs, 500, '원본은 정확히 500ms 지점에서 시작한다')
})

test('진단 무음: 뒤 500ms 가 정확하다', () => {
  const tl = buildEmotionPreviewTimeline(1234)
  assert.equal(tl.tailOutMs, 500)
  assert.equal(tl.sampleEndMs, 500 + 1234)
  assert.equal(tl.totalMs - tl.sampleEndMs, 500, '원본이 끝난 뒤 정확히 500ms 가 남는다')
})

test('진단 무음: 원본 길이를 바꾸지 않는다(앞뒤로만 늘어난다)', () => {
  for (const dur of [0, 1, 250, 1000, 8_000, 123_456]) {
    const tl = buildEmotionPreviewTimeline(dur)
    assert.equal(tl.sampleDurationMs, dur, `${dur}: 원본 길이 그대로`)
    assert.equal(tl.totalMs, 500 + dur + 500, `${dur}: 총 길이 = 500 + 원본 + 500`)
    assert.equal(tl.sampleEndMs - tl.sampleStartMs, dur, `${dur}: 재생 구간 길이 = 원본 길이`)
  }
})

test('진단 무음: 잘못된 길이는 조용히 0 으로 넘어가지 않고 거부된다', () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => buildEmotionPreviewTimeline(bad as number), RangeError, String(bad))
  }
})

// ── 2) 단계 판정 ────────────────────────────────────────────────────────────

test('단계: 경계에서 정확히 갈린다', () => {
  const tl = buildEmotionPreviewTimeline(1000)   // 0..500 leadIn, 500..1500 sample, 1500..2000 tailOut
  assert.equal(emotionPreviewStageAt(tl, 0), 'leadIn')
  assert.equal(emotionPreviewStageAt(tl, 499), 'leadIn')
  assert.equal(emotionPreviewStageAt(tl, 500), 'sample')
  assert.equal(emotionPreviewStageAt(tl, 1499), 'sample')
  assert.equal(emotionPreviewStageAt(tl, 1500), 'tailOut')
  assert.equal(emotionPreviewStageAt(tl, 1999), 'tailOut')
  assert.equal(emotionPreviewStageAt(tl, 2000), 'done')
  assert.equal(emotionPreviewStageAt(tl, 99_999), 'done')
  assert.equal(emotionPreviewStageAt(tl, -1), 'idle')
})

test('단계: 진단 정적 구간에서는 소리가 나지 않는다', () => {
  assert.equal(emotionPreviewIsSilent('leadIn'), true)
  assert.equal(emotionPreviewIsSilent('tailOut'), true)
  assert.equal(emotionPreviewIsSilent('idle'), true)
  assert.equal(emotionPreviewIsSilent('done'), true)
  assert.equal(emotionPreviewIsSilent('sample'), false, '원본 구간에서만 소리가 난다')
})

// ── 3) 합성·캐시 키로 새지 않는다 ───────────────────────────────────────────

test('불변: 진단 무음은 캐시 키·직렬화 페이로드에 흔적을 남기지 않는다', () => {
  // 고정 벡터가 그대로다 — 이 브랜치의 어떤 변경도 키를 움직이지 않았다.
  assert.equal(buildEmotionSampleCacheKey(EMOTION_SAMPLER_PARITY_INPUT), EMOTION_SAMPLER_PARITY_KEY)
  const payload = canonicalEmotionSampleKeyPayload(EMOTION_SAMPLER_PARITY_INPUT)
  assert.equal(payload, EMOTION_SAMPLER_PARITY_PAYLOAD)
  for (const needle of ['preview', 'silence', 'lead_in', 'leadIn', 'diagnostic']) {
    assert.ok(!payload.includes(needle), `키 페이로드에 ${needle} 가 없다`)
  }
  // 꼬리 패딩(합성 결과물의 일부)은 여전히 키에 있다 — 진단 무음과 섞이지 않았다는 확인.
  assert.ok(payload.includes('tail_padding_ms'), '기존 tail_padding_ms 는 그대로 키에 남아 있다')
})

test('불변: 합성 경로와 캐시 키 모듈은 진단 무음 모듈을 import 하지 않는다', () => {
  const offenders: string[] = []
  for (const rel of readdirSync(SRC_DIR, { recursive: true, encoding: 'utf-8' })) {
    const p = rel.replace(/\\/g, '/')
    if (!/\.(ts|tsx)$/.test(p) || p.endsWith('.test.ts')) continue
    // 재생 계층 자신과, 재생을 소유할 renderer 만 이 모듈을 알아도 된다.
    if (p === 'shared/emotionSamplePreview.ts') continue
    if (p.startsWith('renderer/')) continue
    if (readSource(SRC_DIR + rel).includes('emotionSamplePreview')) offenders.push(p)
  }
  assert.deepEqual(offenders, [], '합성/메인/공유 계약 쪽에서 진단 무음을 참조하면 안 된다')
})

test('불변: 파이썬 합성 쪽에는 진단 무음이 존재하지 않는다', () => {
  // 진단 무음은 renderer 재생 전용이다. 워커가 이 값을 알게 되면 합성 결과물에 섞일 수 있다.
  for (const f of ['emotion_sampler.py', 'audio_finishing.py']) {
    const src = readSource(PY_DIR + f)
    for (const needle of ['PREVIEW_SILENCE', 'preview_silence', 'diagnostic_silence']) {
      assert.ok(!src.includes(needle), `${f}: ${needle} 없음`)
    }
  }
})

test('불변: 진단 무음 모듈은 파일을 쓰거나 오디오를 변환하지 않는다', () => {
  const src = readSource(SRC_DIR + 'shared/emotionSamplePreview.ts')
  for (const banned of ['writeFile', 'readFile', 'Buffer', 'AudioContext', 'AudioBuffer', 'decodeAudio']) {
    assert.ok(!src.includes(banned), `순수 타임라인 모듈에 ${banned} 가 있으면 안 된다`)
  }
})
