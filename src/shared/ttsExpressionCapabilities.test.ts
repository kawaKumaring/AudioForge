// I5-c capability·범위 단일 권위 단위테스트 — 값(120/8/200)·경계(min/max/±1)·capability를 고정한다.
// 실행: npm test (node --test). 새 의존성 0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TTS_TAIL_PADDING_MS, TTS_TAIL_FADE_MS, TTS_EMOTION_PAUSE_MS,
  TTS_TAIL_MODE_NEW_DEFAULT, TTS_TAIL_MODE_LEGACY_DEFAULT, TTS_EMOTION_MODE_DEFAULT,
  inRange, isTailMode, isEmotionMode, resolveExpressionCapability,
} from './ttsExpressionCapabilities.ts'
import { buildTtsConfig } from './ttsConfig.ts'

test('범위·기본값 = 계약/ config/ audio_finishing 확정값(120/8/200, 0~300/0~20/0~1000)', () => {
  assert.deepEqual(TTS_TAIL_PADDING_MS, { min: 0, max: 300, def: 120 })
  assert.deepEqual(TTS_TAIL_FADE_MS, { min: 0, max: 20, def: 8 })
  assert.deepEqual(TTS_EMOTION_PAUSE_MS, { min: 0, max: 1000, def: 200 })
})

test('세션 기본값: new=auto/pause, legacy tail=off', () => {
  assert.equal(TTS_TAIL_MODE_NEW_DEFAULT, 'auto')
  assert.equal(TTS_TAIL_MODE_LEGACY_DEFAULT, 'off')
  assert.equal(TTS_EMOTION_MODE_DEFAULT, 'pause')
})

test('inRange: min/max 통과, min-1/max+1 차단(조용한 clamp 아님)', () => {
  for (const r of [TTS_TAIL_PADDING_MS, TTS_TAIL_FADE_MS, TTS_EMOTION_PAUSE_MS]) {
    assert.equal(inRange(r.min, r), true, `min ${r.min}`)
    assert.equal(inRange(r.max, r), true, `max ${r.max}`)
    assert.equal(inRange(r.min - 1, r), false, `min-1 ${r.min - 1}`)
    assert.equal(inRange(r.max + 1, r), false, `max+1 ${r.max + 1}`)
    assert.equal(inRange(r.def, r), true, `def ${r.def}`)
  }
  assert.equal(inRange(NaN, TTS_TAIL_PADDING_MS), false)
  assert.equal(inRange('120', TTS_TAIL_PADDING_MS), false)  // 문자열 차단
})

test('mode 가드', () => {
  assert.equal(isTailMode('auto'), true); assert.equal(isTailMode('off'), true)
  assert.equal(isTailMode('smooth'), false); assert.equal(isTailMode(''), false)
  assert.equal(isEmotionMode('immediate'), true); assert.equal(isEmotionMode('pause'), true)
  assert.equal(isEmotionMode('smooth'), false)
})

test('capability selector: 통합 빌드 지원 / 미탑재는 false+사유(가짜 활성화 금지)', () => {
  const on = resolveExpressionCapability(true)
  assert.deepEqual(on, { tail: true, emotionBoundary: true })
  const off = resolveExpressionCapability(false)
  assert.equal(off.tail, false); assert.equal(off.emotionBoundary, false)
  assert.ok(typeof off.reason === 'string' && off.reason.length > 0, '비활성 사유 존재')
})

test('드리프트 가드: buildTtsConfig 기본값 == 범위 단일 권위 def', () => {
  const c = buildTtsConfig({})
  assert.equal(c.ttsTailPaddingMs, TTS_TAIL_PADDING_MS.def)   // 120
  assert.equal(c.ttsTailFadeMs, TTS_TAIL_FADE_MS.def)         // 8
  assert.equal(c.ttsEmotionBoundaryPauseMs, TTS_EMOTION_PAUSE_MS.def)  // 200
})
