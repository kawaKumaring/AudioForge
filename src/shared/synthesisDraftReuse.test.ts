import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendDraftText, sentenceDraftText } from './synthesisDraftReuse.ts'
import { parseTtsScript } from './ttsGrammar.ts'

test('대본 이어 쓰기는 기존 원문과 감정·쉼 표기를 보존한다', () => {
  const current = '[기쁨] 원래 대사입니다.  '
  const lines = [{ text: '  새 문장입니다.' }, { text: '' }, { text: '[슬픔] 잠깐[쉼 0.5] 기다려요.' }]
  const incoming = sentenceDraftText(lines)
  assert.equal(incoming, '  새 문장입니다.\n\n[슬픔] 잠깐[쉼 0.5] 기다려요.')
  assert.equal(appendDraftText(current, incoming), current + '\n\n' + incoming)
  assert.equal(lines[0].text, '  새 문장입니다.')
})

test('여러 배역 대본 뒤로 가져온 문장에 이전 화자가 번지지 않는다', () => {
  const next = appendDraftText('[화자 민수] 기존 발화입니다.', '새 발화입니다.', true)
  const parsed = parseTtsScript(next)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.plan.segments[0].speakerId, '민수')
  assert.equal(parsed.plan.segments.at(-1)?.speakerId, null)
  assert.ok(next.startsWith('[화자 민수] 기존 발화입니다.'))
})

test('빈 대본은 기존 작업을 바꾸지 않는다', () => {
  assert.equal(appendDraftText('그대로', ' \n '), '그대로')
  assert.equal(appendDraftText('', '[기쁨] 그대로'), '[기쁨] 그대로')
})
