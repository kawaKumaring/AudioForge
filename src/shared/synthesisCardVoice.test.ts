// 카드가 **무엇으로 말하는가** 를 정직하게 가르는가.
//
// ★2026-09-27 지시: "빈 파일 경로를 가짜 참조로 쓰거나 임의의 사용자 음원으로 채우지 않습니다."
//   그리고 "기본 목소리에서 파일 경로가 없다는 이유로 막히지 않도록 전체 경로를 연결합니다."
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cardVoiceOf, cardVoiceLabel, needsReferencePrep, voiceSupports,
  voiceGenerateFault, builtinRequestFields, voiceSnapshot, sameVoice, cardScriptWithEmotion, CARD_EMOTIONS,
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

// ★2026-09-28 실측 — 참조 목소리 다섯 장을 한 번에 만들었더니 **넷이 튕겼다.**
//   본체는 파이썬을 하나만 돌리므로 남의 참조 트림이 도는 동안 생성을 거절한다.
//   화면이 그것을 모르면 단추가 열려 있고, 누른 뒤에야 거절을 본다.
test('★남이 목소리를 준비하는 중이면 누르기 전에 말한다', () => {
  const ready = {
    voice: cardVoiceOf({ source: src }), text: '안녕', refReady: true, refMessage: '',
    busy: false, builtinUsable: true, builtinWhy: '',
  }
  assert.equal(voiceGenerateFault(ready), '', '내 준비가 끝났으면 막지 않는다')
  assert.match(voiceGenerateFault({ ...ready, othersPreparing: true }), /다른 카드/,
    '남이 준비 중인데 단추를 열어 둔다 — 누르면 본체가 거절한다')
  assert.equal(voiceGenerateFault({ ...ready, othersPreparing: false }), '',
    '남의 준비가 끝나면 다시 만들 수 있다')
})

test('★고칠 수 있는 것을 먼저 말한다 — 남의 준비보다 내 대사가 앞이다', () => {
  const noText = {
    voice: cardVoiceOf({ source: src }), text: '   ', refReady: true, refMessage: '',
    busy: false, othersPreparing: true, builtinUsable: true, builtinWhy: '',
  }
  assert.match(voiceGenerateFault(noText), /대사/,
    '기다리라고만 하면, 대사를 비워 둔 것을 사용자가 못 알아챈다')
})

test('기본 목소리도 남의 준비에는 기다린다 — 실행기는 하나다', () => {
  const b = {
    voice: cardVoiceOf({ builtin: ko }), text: '안녕', refReady: false, refMessage: '',
    busy: false, othersPreparing: true, builtinUsable: true, builtinWhy: '',
  }
  assert.match(voiceGenerateFault(b), /다른 카드/)
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

// ── 카드 감정(2026-10-01) — Qwen 지정 목소리 + 1.7B 일 때만, 태그 없는 줄마다 ───────────────
const qwen = (emotion: boolean): BuiltinVoiceRef => ({ engineId: 'qwen-custom', modelId: 'sohee', label: 'Qwen 소희', language: 'ko', path: '/m/config.json', sampleRate: 24000, emotion })

test('★감정은 Qwen 지정 목소리 + 1.7B 일 때만 고를 수 있다 — 참조 목소리·Supertonic 은 아니다', () => {
  assert.equal(voiceSupports(cardVoiceOf({ builtin: qwen(true) })).emotion, true)
  assert.equal(voiceSupports(cardVoiceOf({ builtin: qwen(false) })).emotion, false, '1.7B 가 없으면 감정을 고르게 하지 않는다')
  assert.equal(voiceSupports(cardVoiceOf({ builtin: { ...qwen(true), engineId: 'supertonic' } })).emotion, false)
  assert.equal(voiceSupports(cardVoiceOf({ source: { path: '/a.wav', name: 'a.wav', duration: 5 } })).emotion, false,
    '참조 목소리 + 감정은 예전 실험에서 통과한 길이 없다')
})

test('★태그 없는 줄마다 [감정] 을 붙이고, 사용자가 쓴 태그 줄·빈 줄은 그대로 둔다', () => {
  const v = cardVoiceOf({ builtin: qwen(true) })
  assert.equal(cardScriptWithEmotion('첫 줄.\n\n  [슬픔] 둘째 줄.\n셋째 줄.', '기쁨', v),
    '[기쁨] 첫 줄.\n\n  [슬픔] 둘째 줄.\n[기쁨] 셋째 줄.')
  assert.equal(cardScriptWithEmotion('대사.', '자연스럽게', v), '대사.', '감정 없음은 그대로')
  assert.equal(cardScriptWithEmotion('대사.', '모르는감정', v), '대사.', '목록 밖 감정은 붙이지 않는다')
  assert.equal(cardScriptWithEmotion('대사.', '기쁨', cardVoiceOf({ builtin: qwen(false) })), '대사.', '받지 않는 목소리면 그대로')
  assert.ok(!CARD_EMOTIONS.some((e) => ['흥분(성적)', '절정', '신음', '황홀'].includes(e)), '지시로 옮기지 않는 감정은 싣지 않는다')
})
