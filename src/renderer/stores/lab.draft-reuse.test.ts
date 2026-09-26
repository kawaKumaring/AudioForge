import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { useLabStore } from './lab.store.ts'
import { emptyDoc, newLine } from '../../shared/labWorkspace.ts'

beforeEach(() => useLabStore.setState({ doc: emptyDoc(), job: null, loaded: true, notice: null }))

test('대본 추가는 채택한 생성본과 기존 목소리를 보존한다', () => {
  const original = newLine('먼저 만든 문장')
  const take = { id: 'kept', path: 'C:/takes/kept.wav', text: original.text, voiceKey: 'C:/voice.wav', createdAt: 1 }
  original.takes = [take]
  original.adoptedTakeId = take.id
  useLabStore.setState({ doc: { ...emptyDoc(), voicePath: 'C:/voice.wav', voiceLabel: '목소리', lines: [original] } })
  const incoming = '[기쁨] 첫 문장.\n[쉼 0.5] 두 번째 문장.'
  const addedId = useLabStore.getState().appendScript(incoming)
  const after = useLabStore.getState()
  assert.equal(after.doc.lines.length, 2)
  assert.deepEqual(after.doc.lines[0], original)
  assert.equal(after.doc.lines[1].id, addedId)
  assert.equal(after.doc.lines[1].text, incoming)
  assert.equal(after.doc.voicePath, 'C:/voice.wav')
  assert.equal(after.doc.lines[1].takes.length, 0)
})

test('처음의 빈 항목만 재사용하고 빈 원문이나 생성 중에는 추가하지 않는다', () => {
  useLabStore.getState().appendScript('가져온 문장')
  assert.equal(useLabStore.getState().doc.lines.length, 1)
  assert.equal(useLabStore.getState().appendScript('   '), null)
  const before = useLabStore.getState().doc
  useLabStore.setState({ job: { lineId: before.lines[0].id, text: '가져온 문장', voiceKey: '', startedAt: 1, queue: [] } })
  assert.equal(useLabStore.getState().appendScript('생성 중 새 문장'), null)
  assert.deepEqual(useLabStore.getState().doc, before)
})
