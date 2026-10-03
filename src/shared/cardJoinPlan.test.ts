// 최종 음성 연결 계획 — **조용히 건너뛰지 않는가**, 그리고 **미리듣기와 저장이 같은 계획인가.**
//
// ★2026-09-27 지시:
//   "채택 누락·파일 없음은 조용히 건너뛰지 않습니다."
//   "이어 듣기와 파일 저장은 같은 연결 계획·처리 결과를 사용합니다."
//   "순서·채택·옵션을 바꾸면 이전 미리듣기 결과를 무효화합니다."
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildJoinPlan, cardJoinFault, clampGap, joinPlanKey, joinBlockText,
  GAP_MAX, type JoinCardInput,
} from './cardJoinPlan.ts'

const card = (id: string, path = `${id}.wav`, over: Partial<JoinCardInput> = {}): JoinCardInput => ({
  id, label: `카드 ${id}`, adopted: { id: `t-${id}`, path }, ...over,
})
const opts = { gap: 0.35, gaps: {}, level: true, edges: true }

test('카드 순서 그대로 잇는다', () => {
  const r = buildJoinPlan([card('a'), card('b'), card('c')], opts)
  assert.ok(r.plan)
  assert.deepEqual(r.plan.steps.map((s) => s.cardId), ['a', 'b', 'c'])
  assert.equal(r.plan.steps[0].gapBefore, 0, '첫 조각 앞에 빈 자리를 둔다')
  assert.equal(r.plan.steps[1].gapBefore, 0.35)
})

test('쌍별 간격이 기본을 이긴다', () => {
  const r = buildJoinPlan([card('a'), card('b')], { ...opts, gaps: { 'a:b': 1.2 } })
  assert.equal(r.plan?.steps[1].gapBefore, 1.2)
})

// ★이것이 이 파일의 존재 이유다.
test('채택이 없으면 **계획을 만들지 않는다**', () => {
  const r = buildJoinPlan([card('a'), card('b', '', { adopted: null })], opts)
  assert.equal(r.plan, null, '채택 없는 카드를 조용히 건너뛰고 이어 붙인다')
  assert.equal(r.blocks.length, 1)
  assert.match(r.blocks[0].why, /최종 음성에 넣을 결과를 골라/)
  assert.equal(r.blocks[0].cardId, 'b')
})

test('파일이 사라진 생성본도 막는다', () => {
  const gone = card('b')
  gone.adopted = { id: 't', path: 'b.wav', missing: true }
  const r = buildJoinPlan([card('a'), gone], opts)
  assert.equal(r.plan, null)
  assert.match(r.blocks[0].why, /파일을 찾을 수 없/)
})

test('막힌 것이 여럿이면 모두 센다', () => {
  const r = buildJoinPlan([card('a', '', { adopted: null }), card('b', '', { adopted: null })], opts)
  assert.equal(r.blocks.length, 2)
  assert.match(joinBlockText(r.blocks), /외 1개/)
})

test('카드가 없으면 만들지 않는다', () => {
  assert.equal(buildJoinPlan([], opts).plan, null)
})

test('낄 수 없는 이유를 하나씩 말한다', () => {
  assert.equal(cardJoinFault(card('a')), '')
  assert.match(cardJoinFault({ ...card('a'), adopted: null }), /최종 음성/)
  assert.match(cardJoinFault({ id: 'a', label: 'A', adopted: { id: 't', path: '', } }), /파일이 없/)
})

test('간격은 소리가 아니라 빈 자리다 — 범위 밖은 자른다', () => {
  assert.equal(clampGap(-1), 0)
  assert.equal(clampGap(99), GAP_MAX)
  assert.equal(clampGap('없는 값' as unknown), 0)
  assert.equal(clampGap(0.3333333), 0.333)
})

// ★미리듣기와 저장이 같은 계획을 쓴다 — 지문이 같으면 같은 결과여야 한다.
test('같은 입력이면 같은 계획·같은 지문', () => {
  const a = buildJoinPlan([card('a'), card('b')], opts).plan!
  const b = buildJoinPlan([card('a'), card('b')], opts).plan!
  assert.equal(joinPlanKey(a), joinPlanKey(b))
})

test('순서·채택·간격·옵션이 바뀌면 지문이 달라진다', () => {
  const base = buildJoinPlan([card('a'), card('b')], opts).plan!
  const key = joinPlanKey(base)
  assert.notEqual(key, joinPlanKey(buildJoinPlan([card('b'), card('a')], opts).plan!), '순서')
  assert.notEqual(key, joinPlanKey(buildJoinPlan([card('a'), card('b', 'other.wav')], opts).plan!), '채택 파일')
  assert.notEqual(key, joinPlanKey(buildJoinPlan([card('a'), card('b')], { ...opts, gap: 1 }).plan!), '기본 간격')
  assert.notEqual(key, joinPlanKey(buildJoinPlan([card('a'), card('b')], { ...opts, gaps: { 'a:b': 2 } }).plan!), '쌍별 간격')
  assert.notEqual(key, joinPlanKey(buildJoinPlan([card('a'), card('b')], { ...opts, level: false }).plan!), '음량 맞추기')
  assert.notEqual(key, joinPlanKey(buildJoinPlan([card('a'), card('b')], { ...opts, edges: false }).plan!), '경계 다듬기')
})
