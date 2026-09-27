import { test } from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097 — Node executes repository TypeScript tests directly.
import { useSynthesisCards } from './synthesisCards.store.ts'
// @ts-ignore TS5097
import { cardVoiceOf, voiceGenerateFault } from '../../shared/synthesisCardVoice.ts'

test('기본 목소리 복제는 모델을 유지하고 대사·생성본·채택은 새로 시작한다', () => {
  useSynthesisCards.setState({ cards: [], refs: {}, job: null })
  const voice = { engineId: 'piper', modelId: 'fixture', path: 'fixture.onnx', label: '시험 목소리', language: 'ko', sampleRate: 22050 }
  useSynthesisCards.getState().addBuiltin(voice)
  const first = useSynthesisCards.getState().cards[0]
  useSynthesisCards.getState().update(first.id, {
    text: '원래 대사', settings: { ...first.settings, speed: 1.15 }, adoptedId: 'old',
    takes: [{ id: 'old', path: 'fixture.wav', createdAt: 1, text: '원래 대사', source: { path: '', name: voice.label, duration: 0 }, settings: first.settings, applied: { speed: 1, pitch: 0, notes: [] } }],
  })
  useSynthesisCards.getState().clone(first.id)
  const [original, copy] = useSynthesisCards.getState().cards
  assert.equal(cardVoiceOf(copy).kind, 'builtin')
  assert.deepEqual(copy.builtin, voice)
  assert.notEqual(copy.builtin, original.builtin)
  assert.equal(copy.source, null)
  assert.equal(copy.settings.speed, 1.15)
  assert.notEqual(copy.settings, original.settings)
  assert.notEqual(copy.id, original.id)
  assert.equal(copy.text, '')
  assert.deepEqual(copy.takes, [])
  assert.equal(copy.adoptedId, null)
  assert.equal(original.text, '원래 대사')
  assert.equal(original.takes.length, 1)
  assert.equal(original.adoptedId, 'old')
  assert.equal(voiceGenerateFault({ voice: cardVoiceOf(copy), text: '새 대사', refReady: false, refMessage: '', busy: false, builtinUsable: true, builtinWhy: '' }), '')
})
