// 여러 명 합성 전 인물 준비 검사 계약 — 소스를 읽어 고정한다.
//
// 실사용 결함: 한 명은 정상인데 여러 명에서 SPEAKER_NOT_REGISTERED 가 Python 에서 터졌다.
// renderer 에 여러 명 preflight 가 없어 카드 상태와 무관하게 config 가 나갔고, 오류는 내부 코드 그대로 보였다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const codeOf = (src: string) => src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')

const PB = codeOf(read('./ProcessButton.tsx'))
const SHELL = codeOf(read('./TTSEditor.tsx'))
const TL = codeOf(read('./TrackList.tsx'))

test('여러 명 모드는 합성 전에 명시 화자 준비를 검사하고 막히면 시작하지 않는다', () => {
  const i = PB.indexOf('multiSpeakerPreflight(')
  const j = PB.indexOf('window.api.audio.process(')
  assert.ok(i > 0 && j > i, 'preflight 가 IPC 호출보다 앞선다')
  const block = PB.slice(PB.indexOf("if (ttsSpeakerMode === 'multi') {"), i + 400)
  assert.ok(block.includes('readinessFromSlots({'), '판정 표는 공용 함수')
  assert.ok(block.includes('gateSpeakerEmotionRefs(ttsSpeakerEmotionRefs, ttsSpeakerEmotionEnabled)'), '전송과 같은 게이트')
  assert.ok(PB.includes('setError(speakerPreflightMessage(blocks, (id) => ttsSpeakerLabels[id] || id), { code: blocks[0].code })'))
  assert.ok(/if \(blocks\.length > 0\) \{[\s\S]{0,200}return\n/.test(PB), '막히면 return')
  // 한 명 모드에서는 검사하지 않는다(single 은 화자 표기를 무시한다).
  assert.ok(PB.includes("if (ttsSpeakerMode === 'multi') {"))
})

test('카드 판정 표와 preflight 판정 표는 같은 함수·같은 슬롯에서 나온다', () => {
  assert.ok(SHELL.includes('const speakerReadiness = readinessFromSlots({'))
  assert.ok(SHELL.includes('speakerSlots: ttsSpeakerRefState'))
  assert.ok(SHELL.includes('speakerEmotionRefs: gateSpeakerEmotionRefs(ttsSpeakerEmotionRefs, ttsSpeakerEmotionEnabled)'))
  assert.equal(SHELL.includes('registeredSpeakers: Object.keys(ttsSpeakerRefState)'), false, '셸이 표를 따로 만들지 않는다')
})

test('Python 이 막은 경우에도 화면은 내부 코드 대신 인물 카드로 안내한다', () => {
  assert.ok(TL.includes("errorInfo?.code === 'SPEAKER_NOT_REGISTERED'"))
  assert.ok(TL.includes("errorInfo?.code === 'SPEAKER_REFERENCE_NOT_READY'"))
  assert.ok(TL.includes('SPEAKER_PREFLIGHT_MESSAGE[errorInfo.code]'))
})

test('fallback 없음 — 준비 안 된 화자를 다른 인물·전역 기본으로 바꾸는 코드가 없다', () => {
  for (const forbidden of ["speakerId: null", 'global_default', 'fallbackSpeaker', 'defaultSpeakerFor']) {
    assert.equal(PB.includes(forbidden), false, forbidden)
  }
})
