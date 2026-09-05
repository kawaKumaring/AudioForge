// 인물 이름 변경 — 원문 표기 일괄 변경(패처) + 목소리 구성 안의 인물 id 이동(등록부). 순수 함수.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renameSpeaker, speakerIdOfLabel, sliceOf } from './dialogueSourcePatcher.ts'
import type { UtteranceView } from './dialogueSourcePatcher.ts'
import { renameSpeakerInCasts, makeCandidateId, slotKey } from './emotionCandidateRegistry.ts'
import type { VoiceCastStore } from './emotionCandidateRegistry.ts'
import { samplerSha256Hex } from './emotionSampler.ts'

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
  // 대소문자·NFC 만 다른 이름도 같은 인물이다.
  const t2 = '[화자 Tom]\n하나\n[화자 Ann]\n둘'
  const v2 = [viewOf(t2, 0, '[화자 Tom]\n하나', 'Tom', true), viewOf(t2, 1, '[화자 Ann]\n둘', 'Ann', true)]
  assert.equal(renameSpeaker(t2, v2, 'tom', 'ANN').refusedCode, 'SPEAKER_LABEL_DUPLICATE')
  // 같은 인물의 표기만 바꾸는 것(대소문자)은 허용된다.
  assert.equal(renameSpeaker(t2, v2, 'tom', 'TOM').changed, true)
})

test('잘못된 이름·없는 인물·변화 없음은 거부 코드로 말한다', () => {
  assert.equal(renameSpeaker(TEXT, V, speakerIdOfLabel('민수'), '민 수').refusedCode, 'SPEAKER_LABEL_HAS_WHITESPACE')
  assert.equal(renameSpeaker(TEXT, V, speakerIdOfLabel('민수'), '기본').refusedCode, 'SPEAKER_LABEL_RESERVED_DEFAULT')
  assert.equal(renameSpeaker(TEXT, V, 'nobody', '철수').refusedCode, 'SPEAKER_NOT_FOUND')
  assert.equal(renameSpeaker(TEXT, V, speakerIdOfLabel('민수'), '민수').refusedCode, 'NO_CHANGE')
})

test('목소리 구성: 모든 배역에서 그 인물의 기본 목소리·감정 후보·선택이 새 id 로 옮겨지고, 후보 id 는 다시 만들어진다', () => {
  const hash = samplerSha256Hex
  const cand = { candidateId: makeCandidateId('asset_a', '민수', 'happy', hash), assetId: 'asset_a', speakerId: '민수', emotionId: 'happy' }
  const other = { candidateId: makeCandidateId('asset_b', '지은', 'sad', hash), assetId: 'asset_b', speakerId: '지은', emotionId: 'sad' }
  const store = {
    schemaVersion: 1, activeVoiceCastId: 'vc1',
    casts: [{ voiceCastId: 'vc1', castName: 'x', schemaVersion: 1, createdAt: 't', updatedAt: 't',
      speakerDefaults: { '민수': 'asset_a', '지은': 'asset_b' }, candidates: [cand, other],
      selections: { [slotKey('민수', 'happy')]: cand.candidateId, [slotKey('지은', 'sad')]: other.candidateId } }],
  } as unknown as VoiceCastStore
  const res = renameSpeakerInCasts(store, '민수', '철수', 'now', hash)
  assert.equal(res.refused, null)
  assert.equal(res.changed, true)
  const c = res.store.casts[0]
  assert.deepEqual(c.speakerDefaults, { '철수': 'asset_a', '지은': 'asset_b' })
  const moved = c.candidates.find((k) => k.speakerId === '철수')!
  assert.equal(moved.assetId, 'asset_a', '자산은 그대로')
  assert.equal(moved.candidateId, makeCandidateId('asset_a', '철수', 'happy', hash))
  assert.equal(c.selections[slotKey('철수', 'happy')], moved.candidateId)
  assert.equal(c.selections[slotKey('지은', 'sad')], other.candidateId, '다른 인물은 무변경')
  assert.equal(c.updatedAt, 'now')
  // 충돌 = 거부, 병합 없음. 무관한 배역은 객체 그대로.
  assert.equal(renameSpeakerInCasts(store, '민수', '지은', 'now', hash).refused, 'SPEAKER_LABEL_DUPLICATE')
  assert.equal(renameSpeakerInCasts(store, '없음', '철수', 'now', hash).changed, false)
})
