// TTS config 직렬화 회귀 테스트 — Node 내장 러너(node --test), 새 의존성 0.
// 실행: npm test  (또는 node --test src/shared/ttsConfig.test.ts)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTtsConfig } from './ttsConfig.ts'

test('ttsEmotionRefs가 config에 전달된다 (전달 경로 끊김 회귀)', () => {
  const refs = { happy: 'C:/ref/happy.wav', sad: 'C:/ref/sad.wav' }
  const c = buildTtsConfig({ ttsEmotionRefs: refs })
  assert.deepEqual(c.ttsEmotionRefs, refs)
})

test('ttsSilenceGap=0 이 0.5로 변질되지 않는다 (|| → ?? 회귀)', () => {
  const c = buildTtsConfig({ ttsSilenceGap: 0 })
  assert.equal(c.ttsSilenceGap, 0)
})

test('ttsSpeed=0 도 ??로 보존된다', () => {
  const c = buildTtsConfig({ ttsSpeed: 0 })
  assert.equal(c.ttsSpeed, 0)
})

test('미지정(undefined) 필드에는 기본값이 적용된다', () => {
  const c = buildTtsConfig(undefined)
  assert.equal(c.ttsText, '')
  assert.equal(c.ttsSpeed, 1.0)
  assert.equal(c.ttsSilenceGap, 0.5)
  assert.deepEqual(c.ttsEmotionRefs, {})
  assert.equal(c.ttsEngine, 'auto')
})

test('지정한 값은 그대로 통과한다', () => {
  const c = buildTtsConfig({
    ttsText: '안녕하세요', ttsSpeed: 1.2, ttsSilenceGap: 0.3,
    ttsEmotionRefs: { neutral: 'n.wav' }, ttsEngine: 'gptsovits'
  })
  assert.equal(c.ttsText, '안녕하세요')
  assert.equal(c.ttsSpeed, 1.2)
  assert.equal(c.ttsSilenceGap, 0.3)
  assert.deepEqual(c.ttsEmotionRefs, { neutral: 'n.wav' })
  assert.equal(c.ttsEngine, 'gptsovits')
})

test('직렬화 형태에 5개 TTS 키가 모두 존재한다 (필드 누락 방지)', () => {
  const c = buildTtsConfig({})
  assert.deepEqual(
    Object.keys(c).sort(),
    ['ttsEmotionRefs', 'ttsEngine', 'ttsSilenceGap', 'ttsSpeed', 'ttsText']
  )
})
