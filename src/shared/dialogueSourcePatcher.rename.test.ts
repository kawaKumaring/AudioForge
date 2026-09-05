// 인물 이름 변경 — 원문 표기 일괄 변경(패처, 순수) + 현재 작업의 별칭(저장 구성은 그대로, 읽을 때만 옮김).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renameSpeaker, speakerIdOfLabel, sliceOf } from './dialogueSourcePatcher.ts'
import type { UtteranceView } from './dialogueSourcePatcher.ts'
import { castSpeakerIdOf, applySpeakerRenames } from '../renderer/stores/app.store.ts'

function viewOf(text: string, index: number, slice: string, label: string | null, own: boolean, from = 0): UtteranceView {
  const start = text.indexOf(slice, from)
  assert.ok(start >= 0, slice)
  return { index, sourceStart: start, sourceEnd: start + slice.length, speakerId: label ? speakerIdOfLabel(label) : null,
    speakerLabel: label, emotionId: null, hasOwnSpeakerDirective: own, lineIndex: null }
}

const TEXT = '[화자 민수]\n첫째\n[화자 지은]\n둘째\n[화자 민수]\n[기쁨] 셋째\n넷째'
const V = [
  viewOf(TEXT, 0, '[화자 민수]\n첫째', '민수', true),
  viewOf(TEXT, 1, '[화자 지은]\n둘째', '지은', true),
  viewOf(TEXT, 2, '[화자 민수]\n[기쁨] 셋째', '민수', true, TEXT.indexOf('둘째')),
  viewOf(TEXT, 3, '넷째', '민수', false),
]

test('이름 변경은 그 인물의 모든 자기 표기를 바꾸고, 이어받는 발화·다른 인물·감정 태그·대사는 그대로다', () => {
  const out = renameSpeaker(TEXT, V, speakerIdOfLabel('민수'), '철수')
  assert.equal(out.changed, true)
  assert.equal(out.text, '[화자 철수]\n첫째\n[화자 지은]\n둘째\n[화자 철수]\n[기쁨] 셋째\n넷째')
  for (const u of V) assert.ok(sliceOf(TEXT, u).length > 0)
})

test('다른 기존 인물과 같은 이름이면 거부한다 — 자동 병합 없음', () => {
  const out = renameSpeaker(TEXT, V, speakerIdOfLabel('민수'), '지은')
  assert.equal(out.changed, false)
  assert.equal(out.refusedCode, 'SPEAKER_LABEL_DUPLICATE')
  assert.equal(out.text, TEXT)
  const t2 = '[화자 Tom]\n하나\n[화자 Ann]\n둘'
  const v2 = [viewOf(t2, 0, '[화자 Tom]\n하나', 'Tom', true), viewOf(t2, 1, '[화자 Ann]\n둘', 'Ann', true)]
  assert.equal(renameSpeaker(t2, v2, 'tom', 'ANN').refusedCode, 'SPEAKER_LABEL_DUPLICATE')
  assert.equal(renameSpeaker(t2, v2, 'tom', 'TOM').changed, true)
})

test('잘못된 이름·없는 인물·변화 없음은 거부 코드로 말한다', () => {
  assert.equal(renameSpeaker(TEXT, V, speakerIdOfLabel('민수'), '민 수').refusedCode, 'SPEAKER_LABEL_HAS_WHITESPACE')
  assert.equal(renameSpeaker(TEXT, V, speakerIdOfLabel('민수'), '기본').refusedCode, 'SPEAKER_LABEL_RESERVED_DEFAULT')
  assert.equal(renameSpeaker(TEXT, V, 'nobody', '철수').refusedCode, 'SPEAKER_NOT_FOUND')
  assert.equal(renameSpeaker(TEXT, V, speakerIdOfLabel('민수'), '민수').refusedCode, 'NO_CHANGE')
})

test('별칭: 저장 구성의 인물 id 는 그대로 두고, 현재 작업에서 읽을 때만 옮긴다(다른 구성의 같은 이름은 같은 사람으로 보지 않는다)', () => {
  const US = String.fromCharCode(31)
  const renames = { '민수': '철수' }               // 저장 구성 안의 '민수' 가 지금 작업에서는 '철수'
  assert.equal(castSpeakerIdOf(renames, '철수'), '민수')
  assert.equal(castSpeakerIdOf(renames, '지은'), '지은')
  const fromCast = { [`민수${US}happy`]: 'clip-a', [`민수${US}default`]: 'clip-b', [`지은${US}sad`]: 'clip-c' }
  assert.deepEqual(applySpeakerRenames(fromCast, renames), {
    [`철수${US}happy`]: 'clip-a', [`철수${US}default`]: 'clip-b', [`지은${US}sad`]: 'clip-c',
  })
  // 구성 표는 바뀌지 않았다(입력 객체 불변).
  assert.equal(fromCast[`민수${US}happy`], 'clip-a')
  // 별칭이 없으면 그대로.
  assert.deepEqual(applySpeakerRenames(fromCast, {}), fromCast)
})
