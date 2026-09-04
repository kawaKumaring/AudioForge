import { test } from 'node:test'
import assert from 'node:assert/strict'

import { gateSpeakerEmotionRefs, emotionIdsForSpeaker, speakerOfKey, emotionOfKey } from './speakerEmotionGate.ts'

const US = String.fromCharCode(31)
const k = (s: string, e: string) => s + US + e

test('키 분해', () => {
  assert.equal(speakerOfKey(k('a', 'happy')), 'a')
  assert.equal(emotionOfKey(k('a', 'happy')), 'happy')
  assert.equal(emotionOfKey('a'), 'default')
})

test('기본 모드(아무도 켜지 않음): 감정별 참조는 하나도 나가지 않는다 — 기본 목소리를 덮지 않는다', () => {
  const refs = { [k('a', 'happy')]: 'C:/x.wav', [k('a', 'default')]: 'C:/y.wav', [k('b', 'sad')]: 'C:/z.wav' }
  assert.deepEqual(gateSpeakerEmotionRefs(refs, {}), {})
  assert.deepEqual(gateSpeakerEmotionRefs(refs, { a: false, b: false }), {})
})

test('켠 인물의 항목만, 다른 인물은 그대로 막힌다', () => {
  const refs = { [k('a', 'happy')]: 'C:/x.wav', [k('a', 'default')]: 'C:/y.wav', [k('b', 'sad')]: 'C:/z.wav' }
  assert.deepEqual(gateSpeakerEmotionRefs(refs, { a: true }), { [k('a', 'happy')]: 'C:/x.wav', [k('a', 'default')]: 'C:/y.wav' })
  assert.deepEqual(gateSpeakerEmotionRefs(refs, { b: true }), { [k('b', 'sad')]: 'C:/z.wav' })
  // 선택 토큰도 같은 게이트를 지난다.
  assert.deepEqual(gateSpeakerEmotionRefs({ [k('a', 'happy')]: 'ref_1', [k('b', 'happy')]: 'ref_2' }, { b: true }), { [k('b', 'happy')]: 'ref_2' })
})

test('게이트는 원본을 바꾸지 않는다(구성·후보 삭제 없음)', () => {
  const refs = { [k('a', 'happy')]: 'C:/x.wav' }
  const before = JSON.stringify(refs)
  gateSpeakerEmotionRefs(refs, {})
  assert.equal(JSON.stringify(refs), before)
})

test('인물별 보유 감정 목록은 켜짐과 무관하게 나온다(화면의 "있음(꺼짐)" 표시용)', () => {
  const refs = { [k('a', 'happy')]: 'C:/x.wav', [k('a', 'sad')]: '', [k('b', 'sad')]: 'C:/z.wav' }
  assert.deepEqual(emotionIdsForSpeaker(refs, 'a'), ['happy'])
  assert.deepEqual(emotionIdsForSpeaker(refs, 'c'), [])
})
