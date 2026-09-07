// 쉼 표기와 카드 행 — 계획의 발화 구간은 `[쉼 N]` 을 포함하지 않는다(실측, python/script_plan.build_structure).
// 발화와 같은 줄의 쉼(앞·끝)은 행에 흡수되어 카드가 유지되고, 쉼 전용 줄은 흡수하지 않는다(원문 편집기 몫).
// 구간 좌표는 2026-09-05 실측값(build_structure 출력)을 그대로 옮겼다.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { groupUtteranceRows, structurable, sliceOf, utteranceContentParts } from './dialogueSourcePatcher.ts'
import type { PlanUtteranceLike } from './dialogueSourcePatcher.ts'

const u = (index: number, sourceStart: number, sourceEnd: number, lineIndex: number, speakerId = '주인공'): PlanUtteranceLike =>
  ({ index, speakerId, speakerLabel: speakerId, emotionId: null, sourceStart, sourceEnd, lineIndex })

function verdictOf(text: string, views: ReturnType<typeof groupUtteranceRows>) {
  return structurable({ text, textSha256: 'x', planSourceSha256: 'x', parserAuthority: true, utterances: views,
    offsetsExact: views.map(() => true), hasBlockingWarning: false })
}

test('줄 끝의 쉼(카드 + 감정·쉼 의 기본 모양)은 그 행에 들어가고 카드 편집이 유지된다', () => {
  const text = '[화자 주인공]\n첫 번째 대사입니다 [쉼 0.3]\n[화자 주인공]\n둘'
  const rows = groupUtteranceRows(text, [u(0, 9, 20, 1), u(1, 37, 38, 3)])
  assert.equal(rows.length, 2)
  assert.equal(sliceOf(text, rows[0]), '[화자 주인공]\n첫 번째 대사입니다 [쉼 0.3]')
  assert.equal(utteranceContentParts(sliceOf(text, rows[0])).content, '첫 번째 대사입니다 [쉼 0.3]')
  assert.equal(sliceOf(text, rows[1]), '[화자 주인공]\n둘')
  assert.deepEqual(verdictOf(text, rows).blockers, [])
})

test('줄 앞의 쉼(커서가 맨 앞일 때)도 같은 줄이면 행에 들어간다', () => {
  const text = '[화자 주인공]\n[쉼 0.3]첫 번째 대사입니다\n[화자 주인공]\n둘'
  const rows = groupUtteranceRows(text, [u(0, 16, 26, 1), u(1, 36, 37, 3)])
  assert.equal(rows.length, 2)
  assert.equal(sliceOf(text, rows[0]), '[화자 주인공]\n[쉼 0.3]첫 번째 대사입니다')
  assert.equal(rows[0].hasOwnSpeakerDirective, true)
  assert.equal(utteranceContentParts(sliceOf(text, rows[0])).content, '[쉼 0.3]첫 번째 대사입니다')
  assert.deepEqual(verdictOf(text, rows).blockers, [])
})

test('줄 가운데·연속 쉼은 기존처럼 같은 줄 조각을 잇고, 마지막 쉼까지 행에 들어간다', () => {
  const t1 = '[화자 주인공]\n첫 [쉼 0.3] 번째\n둘'
  const r1 = groupUtteranceRows(t1, [u(0, 9, 11, 1), u(1, 18, 21, 1), u(2, 22, 23, 2)])
  assert.equal(r1.length, 2)
  assert.equal(sliceOf(t1, r1[0]), '[화자 주인공]\n첫 [쉼 0.3] 번째')
  const t2 = '[화자 A]\n하나 [쉼 0.3] [쉼 0.5]\n둘'
  const r2 = groupUtteranceRows(t2, [u(0, 7, 10, 1, 'a'), u(1, 17, 18, 1, 'a'), u(2, 26, 27, 2, 'a')])
  assert.equal(r2.length, 2)
  assert.equal(sliceOf(t2, r2[0]), '[화자 A]\n하나 [쉼 0.3] [쉼 0.5]')
  assert.equal(sliceOf(t2, r2[1]), '둘')
  assert.deepEqual(verdictOf(t2, r2).blockers, [])
})

test('쉼 전용 줄은 흡수하지 않는다 — 구간 밖으로 남아 구조 편집이 정직하게 잠긴다', () => {
  const text = '[화자 A]\n하나\n[쉼 1.0]\n둘'
  const rows = groupUtteranceRows(text, [u(0, 7, 9, 1, 'a'), u(1, 18, 19, 3, 'a')])
  assert.equal(sliceOf(text, rows[0]), '[화자 A]\n하나')
  assert.equal(sliceOf(text, rows[1]), '둘')
  assert.equal(rows[1].hasOwnSpeakerDirective, false)
  assert.ok(verdictOf(text, rows).blockers.includes('NON_WHITESPACE_OUTSIDE'))
})

test('감정 태그는 계획 구간 안에 있으므로 달라지는 것이 없다(회귀 없음)', () => {
  const text = '[화자 A]\n[기쁨] 셋째 [쉼 0.5]\n넷째'
  const rows = groupUtteranceRows(text, [u(0, 7, 15, 1, 'a'), u(1, 23, 25, 2, 'a')])
  assert.equal(sliceOf(text, rows[0]), '[화자 A]\n[기쁨] 셋째 [쉼 0.5]')
  assert.equal(sliceOf(text, rows[1]), '넷째')
  assert.deepEqual(verdictOf(text, rows).blockers, [])
})
