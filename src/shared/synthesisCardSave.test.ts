// 카드 작업을 저장하고 **물어보고 나서** 되살리는가.
//
// ★관리자 지시(2026-09-26): 묵시적 복원 금지 · 거절해도 저장본 보존 ·
//   기존 문장별/대본 작업을 이관 계획 없이 덮지 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CARD_STORAGE_KEY, parseSavedWork, savedWorkHasContent, restoreAsk, declineRestore,
  parseSavedFile, keepAside, adoptFromKept, savedChoices,
} from './synthesisCardSave.ts'
import { LAB_STORAGE_KEY } from './labWorkspace.ts'

const work = (over: Record<string, unknown> = {}) => ({
  cards: [{
    id: 'c1', label: '인물 A', sourcePath: 'a.wav', sourceName: 'a.wav', sourceDuration: 12,
    text: '안녕하세요', settings: { speed: 1 },
    takes: [{ id: 't1', path: 'out/t1.wav', createdAt: 1, text: '안녕하세요', sourcePath: 'a.wav', sourceName: 'a.wav', settings: {}, applied: {} }],
    adoptedId: 't1',
  }],
  joins: { gap: 0.35 },
  savedAt: 1758800000000,
  ...over,
})

// ★이것이 가장 중요한 한 줄이다. 두 자리가 같으면 카드가 문장별 작업을 덮는다.
test('카드 저장 자리는 문장별 작업과 **다르다**', () => {
  assert.notEqual(CARD_STORAGE_KEY, LAB_STORAGE_KEY, '기존 작업을 덮어쓴다')
})

test('저장본을 그대로 읽는다', () => {
  const w = parseSavedWork(work())
  assert.ok(w)
  assert.equal(w.cards.length, 1)
  assert.equal(w.cards[0].takes.length, 1)
  assert.equal(w.cards[0].adoptedId, 't1')
  assert.equal(w.joins.gap, 0.35)
})

test('모양이 아니면 없는 것으로 본다 — 반쯤 되살리지 않는다', () => {
  assert.equal(parseSavedWork(null), null)
  assert.equal(parseSavedWork('아무 글자'), null)
  assert.equal(parseSavedWork({}), null)
  assert.equal(parseSavedWork({ cards: [{ label: '아이디 없음' }] }), null)
})

test('채택한 생성본이 사라졌으면 채택도 비운다', () => {
  const w = parseSavedWork(work({
    cards: [{ ...work().cards[0], takes: [], adoptedId: 't1' }],
  }))
  assert.equal(w?.cards[0].adoptedId, null, '없는 것을 가리키면 최종 연결이 헛돈다')
})

test('파일 경로 없는 생성본은 되살리지 않는다', () => {
  const c = work().cards[0]
  const w = parseSavedWork(work({
    cards: [{ ...c, takes: [{ id: 't9', createdAt: 1 }], adoptedId: null }],
  }))
  assert.equal(w?.cards[0].takes.length, 0)
})

test('빈 껍데기로는 묻지 않는다', () => {
  assert.equal(savedWorkHasContent(null), false)
  assert.equal(savedWorkHasContent(parseSavedWork({ cards: [] })), false)
  const empty = parseSavedWork(work({
    cards: [{ id: 'c1', label: '', sourcePath: '', sourceName: '', sourceDuration: 0, text: '', settings: {}, takes: [], adoptedId: null }],
  }))
  assert.equal(savedWorkHasContent(empty), false)
})

// ★묵시적 복원 금지 — 이 함수가 돌려주는 것은 '묻는다' 뿐이고 되살리는 길은 없다.
test('되살릴 것이 있으면 **묻는다**', () => {
  const r = restoreAsk({ saved: parseSavedWork(work()), asked: false, dirty: false })
  assert.equal(r.ask, true)
  assert.match(r.summary, /카드 1장/)
  assert.match(r.summary, /생성본 1개/)
})

test('한 번 물었으면 다시 묻지 않는다', () => {
  assert.equal(restoreAsk({ saved: parseSavedWork(work()), asked: true, dirty: false }).ask, false)
})

test('하던 일이 있으면 질문으로 끊지 않는다', () => {
  assert.equal(restoreAsk({ saved: parseSavedWork(work()), asked: false, dirty: true }).ask, false)
})

test('거절해도 저장본은 지우지 않는다', () => {
  const r = declineRestore()
  assert.equal(r.deleted, false, '거절을 되돌릴 수 없게 만든다')
  assert.equal(r.asked, true)
})

// ── 2026-09-27 2차 검수 ────────────────────────────────────────────────
const wk = (text: string, at = 1) => ({
  savedAt: at, joins: {},
  cards: [{ id: 'c-' + text, label: text, sourcePath: 'a.wav', sourceName: 'a.wav', sourceDuration: 8, text, settings: {}, takes: [], adoptedId: null }],
})
const texts = (f: { current: unknown; kept: unknown[] }) => ({
  current: (f.current as { cards: { text: string }[] } | null)?.cards[0].text ?? null,
  kept: (f.kept as { cards: { text: string }[] }[]).map((w) => w.cards[0].text),
})

// ★재현: current=A, kept=[B] 에서 B 를 꺼냈더니 A 가 사라졌다.
test('보관본을 꺼낼 때 하던 작업을 잃지 않는다', () => {
  const f = parseSavedFile({ current: wk('A'), kept: [wk('B')] })
  const after = adoptFromKept(f, 0)
  assert.deepEqual(texts(after), { current: 'B', kept: ['A'] },
    '고른 것을 꺼내면서 하던 작업을 버렸다')
})

test('하던 작업이 비어 있으면 그냥 꺼낸다', () => {
  const f = parseSavedFile({ current: null, kept: [wk('B')] })
  assert.deepEqual(texts(adoptFromKept(f, 0)), { current: 'B', kept: [] })
})

test('없는 자리를 고르면 아무것도 바뀌지 않는다', () => {
  const f = parseSavedFile({ current: wk('A'), kept: [wk('B')] })
  assert.deepEqual(texts(adoptFromKept(f, 9)), texts(f))
})

// ★재현: 다섯 개가 넘으면 사용자가 지운 적 없는 문서가 조용히 사라졌다.
test('여섯 번째 작업을 조용히 버리지 않는다', () => {
  let f = parseSavedFile({ current: null, kept: [] })
  for (const n of ['1', '2', '3', '4', '5', '6']) {
    f = { current: parseSavedWork(wk(n)), kept: f.kept }
    f = keepAside(f)
  }
  assert.equal(f.kept.length, 6, '보관 개수를 잘라 작업을 버렸다')
  assert.deepEqual(texts(f).kept, ['6', '5', '4', '3', '2', '1'])
})

test('읽을 때도 자르지 않는다', () => {
  const many = Array.from({ length: 8 }, (_, i) => wk('k' + i))
  assert.equal(parseSavedFile({ current: null, kept: many }).kept.length, 8,
    '읽는 김에 버리면 되살릴 길이 영영 사라진다')
})

test('고를 수 있는 목록에 보관본이 모두 들어간다', () => {
  const f = parseSavedFile({ current: wk('지금'), kept: [wk('보관1'), wk('보관2')] })
  const c = savedChoices(f)
  assert.equal(c.length, 3)
  assert.equal(c[0].slot, 'current')
  assert.deepEqual(c.slice(1).map((x) => x.index), [0, 1])
})