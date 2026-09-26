// 카드가 **무엇으로 말하는가** 를 정직하게 가르는가.
//
// ★2026-09-27 지시: "빈 파일 경로를 가짜 참조로 쓰거나 임의의 사용자 음원으로 채우지 않습니다."
//   그리고 "기본 목소리에서 파일 경로가 없다는 이유로 막히지 않도록 전체 경로를 연결합니다."
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cardVoiceOf, cardVoiceLabel, needsReferencePrep, voiceSupports,
  voiceGenerateFault, builtinRequestFields, voiceSnapshot, sameVoice,
  type BuiltinVoiceRef,
} from './synthesisCardVoice.ts'

const src = { path: 'a.wav', name: 'a.wav', duration: 8 }
const ko: BuiltinVoiceRef = {
  engineId: 'piper', modelId: 'ko_KR-kss-medium', label: 'ko_KR-kss-medium',
  language: 'ko', path: 'C:/v/ko.onnx', sampleRate: 22050,
}

test('가진 것으로 종류를 읽는다', () => {
  assert.equal(cardVoiceOf({ source: src }).kind, 'reference')
  assert.equal(cardVoiceOf({ builtin: ko }).kind, 'builtin')
  assert.equal(cardVoiceOf({}).kind, 'none')
  // 기본 목소리가 있으면 그것이 이긴다 — 둘 다 들고 있어도 애매하지 않다.
  assert.equal(cardVoiceOf({ source: src, builtin: ko }).kind, 'builtin')
})

test('빈 경로를 목소리로 보지 않는다', () => {
  assert.equal(cardVoiceOf({ source: { path: '', name: '', duration: 0 } }).kind, 'none')
  assert.equal(cardVoiceOf({ builtin: { ...ko, path: '' } }).kind, 'none')
})

test('참조 목소리만 준비를 거친다', () => {
  assert.equal(needsReferencePrep(cardVoiceOf({ source: src })), true)
  assert.equal(needsReferencePrep(cardVoiceOf({ builtin: ko })), false)
})

// ★엔진이 받지 않는 손잡이를 그려 두면 적용된 것처럼 남는다.
test('기본 목소리에는 참조 구간을 내놓지 않는다', () => {
  const b = voiceSupports(cardVoiceOf({ builtin: ko }))
  assert.equal(b.region, false, '없는 참조의 구간을 고르게 한다')
  assert.equal(b.speed, true)
  assert.equal(b.pitch, true)
  assert.equal(voiceSupports(cardVoiceOf({ source: src })).region, true)
})

// ★이것이 이 파일의 존재 이유다 — 파일이 없다고 막히면 안 된다.
test('기본 목소리는 파일이 없다는 이유로 막히지 않는다', () => {
  const base = { text: '안녕', refReady: false, refMessage: '준비 안 됨', busy: false, builtinUsable: true, builtinWhy: '' }
  assert.equal(voiceGenerateFault({ ...base, voice: cardVoiceOf({ builtin: ko }) }), '',
    '참조가 없다는 이유로 기본 목소리를 막는다')
  assert.match(voiceGenerateFault({ ...base, voice: cardVoiceOf({ source: src }) }), /준비 안 됨/)
})

test('모델을 쓸 수 없으면 그 사유를 말한다', () => {
  const r = voiceGenerateFault({
    voice: cardVoiceOf({ builtin: ko }), text: '안녕', refReady: true, refMessage: '',
    busy: false, builtinUsable: false, builtinWhy: '모델 파일이 사라졌습니다',
  })
  assert.equal(r, '모델 파일이 사라졌습니다', '다른 목소리로 조용히 바꾸거나 이유를 숨긴다')
})

test('목소리가 없으면 먼저 고르라고 한다', () => {
  assert.match(voiceGenerateFault({
    voice: cardVoiceOf({}), text: '안녕', refReady: true, refMessage: '',
    busy: false, builtinUsable: true, builtinWhy: '',
  }), /목소리를 고르세요/)
})

test('요청에는 기본 목소리 식별자가 모두 실린다', () => {
  const f = builtinRequestFields(cardVoiceOf({ builtin: { ...ko, speakerId: '2' } }))
  assert.equal(f.ttsEngine, 'piper')
  assert.equal(f.ttsBuiltinModel, 'C:/v/ko.onnx')
  assert.equal(f.ttsBuiltinModelId, 'ko_KR-kss-medium')
  assert.equal(f.ttsBuiltinLanguage, 'ko')
  assert.equal(f.ttsBuiltinSpeaker, '2')
  assert.deepEqual(builtinRequestFields(cardVoiceOf({ source: src })), {},
    '참조 목소리인데 기본 목소리 값을 싣는다')
})

test('생성본에 그때 목소리가 남는다', () => {
  const b = voiceSnapshot(cardVoiceOf({ builtin: ko }))
  assert.equal(b.kind, 'builtin')
  assert.equal(b.modelId, 'ko_KR-kss-medium')
  assert.equal(b.language, 'ko')
  const r = voiceSnapshot(cardVoiceOf({ source: src }))
  assert.equal(r.kind, 'reference')
  assert.equal(r.sourcePath, 'a.wav')
})

test('목소리가 달라지면 수정 전으로 본다', () => {
  const a = voiceSnapshot(cardVoiceOf({ builtin: ko }))
  assert.equal(sameVoice(a, voiceSnapshot(cardVoiceOf({ builtin: ko }))), true)
  assert.equal(sameVoice(a, voiceSnapshot(cardVoiceOf({ builtin: { ...ko, modelId: '다른모델' } }))), false)
  assert.equal(sameVoice(a, voiceSnapshot(cardVoiceOf({ source: src }))), false)
  assert.equal(cardVoiceLabel(cardVoiceOf({ builtin: ko })), 'ko_KR-kss-medium')
})
