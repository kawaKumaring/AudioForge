// 교정 보관 — **파일마다 따로**, 옛 한 칸의 기록도 버리지 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DRAFT_LIMIT, draftFor, emptyStore, isBlankDraft, migrateLegacy, parseDraft, parseStore, putDraft,
} from './dialogueDrafts.ts'
import { emptyDraft } from './dialogueWorkspace.ts'

const withEdit = (key: string, at = 1) => ({
  ...emptyDraft(key, 'R1'), edits: { 0: { speaker: '화자 B' } }, updatedAt: at,
})

test('★다른 파일을 교정해도 앞 파일의 교정이 덮이지 않는다', () => {
  let s = emptyStore()
  s = putDraft(s, withEdit('C:/a.wav'))
  s = putDraft(s, withEdit('C:/b.wav'))
  assert.ok(draftFor(s, 'C:/a.wav'), '앞 파일이 사라졌다')
  assert.ok(draftFor(s, 'C:/b.wav'))
})

test('빈 교정은 담지 않고, 되돌리면 지운다 — 껍데기를 남기지 않는다', () => {
  let s = putDraft(emptyStore(), withEdit('C:/a.wav'))
  assert.ok(draftFor(s, 'C:/a.wav'))
  s = putDraft(s, emptyDraft('C:/a.wav', 'R1'))
  assert.equal(draftFor(s, 'C:/a.wav'), null)
  assert.equal(isBlankDraft(emptyDraft('x', 'y')), true)
})

test('넘치면 가장 오래 손대지 않은 것부터 버린다', () => {
  let s = emptyStore()
  for (let i = 0; i < DRAFT_LIMIT + 3; i++) s = putDraft(s, withEdit(`C:/f${i}.wav`, i + 1))
  assert.equal(Object.keys(s.drafts).length, DRAFT_LIMIT)
  assert.equal(draftFor(s, 'C:/f0.wav'), null, '가장 오래된 것이 남았다')
  assert.ok(draftFor(s, `C:/f${DRAFT_LIMIT + 2}.wav`))
})

test('모양이 어긋난 저장본은 지어내지 않는다', () => {
  assert.equal(parseDraft(null), null)
  assert.equal(parseDraft({ sourceKey: '' }), null)
  assert.deepEqual(parseDraft({ sourceKey: 'a' })!.edits, {})
})

test('열쇠와 문서가 서로 다른 원본을 가리키면 버린다', () => {
  const s = parseStore({ version: 1, drafts: { 'C:/a.wav': { sourceKey: 'C:/b.wav' } } })
  assert.deepEqual(Object.keys(s.drafts), [])
})

test('구간 수정만 읽고, 없는 모양은 버린다', () => {
  const d = parseDraft({
    sourceKey: 'a',
    edits: { 0: { start: 1, speaker: '화자 B' }, 1: { nope: 1 }, x: { start: 2 } },
    names: { '화자 A': '민수', bad: 3 },
  })!
  assert.deepEqual(d.edits, { 0: { start: 1, speaker: '화자 B' } })
  assert.deepEqual(d.names, { '화자 A': '민수' })
})

// ── 옛 한 칸 옮기기 ─────────────────────────────────────────────────────────
const legacy = {
  sourcePath: 'C:/old.wav',
  segments: [{ start: 0, end: 1, speaker: '화자 A' }, { start: 1, end: 2, speaker: '화자 B' }],
  edits: { 1: { speaker: '화자 A' } },
  updatedAt: 42,
}

test('★옛 한 칸의 교정을 버리지 않고 옮겨 담는다', () => {
  const s = migrateLegacy(emptyStore(), legacy)
  const d = draftFor(s, 'C:/old.wav')!
  assert.deepEqual(d.edits, { 1: { speaker: '화자 A' } })
  assert.deepEqual(d.fromLegacy, { segmentCount: 2 }, '구간 수를 적어 둬야 이어 쓸지 판단한다')
  assert.equal(d.updatedAt, 42)
})

test('새 문서가 이미 있으면 옛 것으로 덮지 않는다', () => {
  const s = migrateLegacy(putDraft(emptyStore(), withEdit('C:/old.wav')), legacy)
  assert.equal(draftFor(s, 'C:/old.wav')!.fromLegacy, undefined, '새 것이 권위다')
})

test('옛 칸이 비어 있거나 고친 것이 없으면 아무것도 만들지 않는다', () => {
  assert.deepEqual(migrateLegacy(emptyStore(), null).drafts, {})
  assert.deepEqual(migrateLegacy(emptyStore(), { ...legacy, edits: {} }).drafts, {})
  assert.deepEqual(migrateLegacy(emptyStore(), { ...legacy, segments: [] }).drafts, {})
})

test('두 번 옮겨도 같다 — 옮긴 뒤에도 옛 칸은 지우지 않으므로', () => {
  const once = migrateLegacy(emptyStore(), legacy)
  const twice = migrateLegacy(once, legacy)
  assert.deepEqual(twice, once)
})
