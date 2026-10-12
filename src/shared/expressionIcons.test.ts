import test from 'node:test'
import assert from 'node:assert/strict'
import { EXPRESSION_ICONS, expressionParts, expressionIconFault, expressionScript } from './expressionIcons.ts'
import { parseTtsScript } from './ttsGrammar.ts'

test('아이콘의 저장 표시와 한국어 원문을 손실 없이 왕복한다', () => {
  const text = '일곱 번째!\n' + EXPRESSION_ICONS.map(c => c.token + '안녕하세요.').join('')
  const parts = expressionParts(text)
  assert.equal(parts.map(p => p.text).join(''), text)
  assert.equal(parts.filter(p => p.cue).length, EXPRESSION_ICONS.length)
})
test('이스케이프와 알려지지 않은 표시는 원문으로 남는다', () => {
  const text = String.raw`\[기쁨] [새로운 표시] 안녕♥`
  assert.deepEqual(expressionParts(text), [{ text }])
})
test('미지원 목소리의 감정은 차단하고 쉼과 평문은 허용한다', () => {
  assert.match(expressionIconFault('안녕[화남]다시', false), /지원하지/)
  assert.equal(expressionIconFault('[쉼 0.7] 안녕', false), '')
  assert.equal(expressionIconFault('[기쁨] 안녕', true), '')
  assert.equal(expressionIconFault('안녕', false), '')
})
test('아이콘 저장본이 실제 합성 문법에서 대사와 쉼으로 해석된다', () => {
  const original = '안녕.[기쁨]반가워.[쉼 0.7][슬픔]잘 가.'
  const result = parseTtsScript(expressionScript(original))
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('합성 문법 해석 실패')
  assert.equal(result.plan.segments.map(s => s.spokenText).join(''), '안녕.반가워.잘 가.')
  assert.deepEqual(result.plan.segments.map(s => s.emotionId), ['default', 'happy', 'sad'])
  assert.equal(result.plan.summary.totalPauseMs, 700)
})
