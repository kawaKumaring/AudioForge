// 교정 보관 — **파일마다 따로**, 옛 한 칸의 기록도 버리지 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DRAFT_LIST_LIMIT, draftFor, draftKey, draftsOfSource, emptyStore, isBlankDraft, migrateLegacy,
  parseDraft, parseStore, putDraft, recentDrafts,
} from './dialogueDrafts.ts'
import { emptyDraft } from './dialogueWorkspace.ts'

const withEdit = (key: string, at = 1, run = 'R1') => ({
  ...emptyDraft(key, run), edits: { 0: { speaker: '화자 B' } }, updatedAt: at,
})

test('★다른 파일을 교정해도 앞 파일의 교정이 덮이지 않는다', () => {
  let s = emptyStore()
  s = putDraft(s, withEdit('C:/a.wav'))
  s = putDraft(s, withEdit('C:/b.wav'))
  assert.ok(draftFor(s, 'C:/a.wav', 'R1'), '앞 파일이 사라졌다')
  assert.ok(draftFor(s, 'C:/b.wav', 'R1'))
})

test('빈 교정은 담지 않고, 되돌리면 지운다 — 껍데기를 남기지 않는다', () => {
  let s = putDraft(emptyStore(), withEdit('C:/a.wav'))
  assert.ok(draftFor(s, 'C:/a.wav', 'R1'))
  s = putDraft(s, emptyDraft('C:/a.wav', 'R1'))
  assert.equal(draftFor(s, 'C:/a.wav', 'R1'), null)
  assert.equal(isBlankDraft(emptyDraft('x', 'y')), true)
})

test('★개수가 많아도 **자동으로 지우지 않는다** — 제한은 목록 표시에만', () => {
  let s = emptyStore()
  const n = DRAFT_LIST_LIMIT + 3
  for (let i = 0; i < n; i++) s = putDraft(s, withEdit(`C:/f${i}.wav`, i + 1))
  assert.equal(Object.keys(s.drafts).length, n, '보관본을 개수 때문에 버렸다')
  assert.ok(draftFor(s, 'C:/f0.wav', 'R1'), '가장 오래된 교정이 사라졌다')
  assert.equal(recentDrafts(s).length, DRAFT_LIST_LIMIT, '목록은 제한한다')
  assert.equal(recentDrafts(s)[0].sourceKey, `C:/f${n - 1}.wav`, '목록은 최근 순이다')
})

test('★같은 원본을 다시 분석해도 **이전 실행의 교정을 보관한다**', () => {
  let s = putDraft(emptyStore(), withEdit('C:/a.wav', 1, 'R1'))
  s = putDraft(s, withEdit('C:/a.wav', 2, 'R2'))
  assert.equal(draftsOfSource(s, 'C:/a.wav').length, 2, '앞 실행의 교정이 덮였다')
  assert.equal(draftsOfSource(s, 'C:/a.wav')[0].runId, 'R2', '최근 것이 앞에 온다')
})

test('★다른 실행의 교정을 **대신 돌려주지 않는다** — 구간이 달라졌을 수 있다', () => {
  const s = putDraft(emptyStore(), withEdit('C:/a.wav', 1, 'R1'))
  assert.ok(draftFor(s, 'C:/a.wav', 'R1'))
  assert.equal(draftFor(s, 'C:/a.wav', 'R2'), null)
})

test('실행 식별자가 없는 옛 기록은 어느 실행에서나 후보가 된다', () => {
  const s = migrateLegacy(emptyStore(), {
    sourcePath: 'C:/a.wav', segments: [1, 2], edits: { 0: { speaker: 'X' } }, updatedAt: 3,
  })
  assert.ok(draftFor(s, 'C:/a.wav', 'R9'), '옛 기록을 찾지 못했다')
  assert.equal(draftKey('C:/a.wav', ''), 'C:/a.wav')
})

test('모양이 어긋난 저장본은 지어내지 않는다', () => {
  assert.equal(parseDraft(null), null)
  assert.equal(parseDraft({ sourceKey: '' }), null)
  assert.deepEqual(parseDraft({ sourceKey: 'a' })!.edits, {})
})

test('열쇠와 문서가 서로 다른 원본을 가리키면 버린다', () => {
  const bad = parseStore({ version: 1, drafts: { 'C:/a.wav': { sourceKey: 'C:/b.wav' } } })
  assert.deepEqual(Object.keys(bad.drafts), [])
})

test('★옛 열쇠 형식(원본 경로만)으로 저장된 문서를 잃지 않는다', () => {
  // 열쇠 규칙을 바꾸면서 이 문서들이 통째로 사라졌다(1건 → 0건, 재현 확인).
  const s = parseStore({ version: 1, drafts: {
    'C:/a.wav': { sourceKey: 'C:/a.wav', runId: 'R1', edits: { 0: { speaker: 'X' } } },
  } })
  assert.equal(Object.keys(s.drafts).length, 1, '옛 형식 문서가 사라졌다')
  assert.deepEqual(Object.keys(s.drafts), [draftKey('C:/a.wav', 'R1')], '새 열쇠로 옮겨야 한다')
  assert.ok(draftFor(s, 'C:/a.wav', 'R1'))
})

test('★옮길 자리가 이미 차 있으면 원래 자리에 둔다 — 덮어쓰지 않는다', () => {
  const s = parseStore({ version: 1, drafts: {
    [draftKey('C:/a.wav', 'R1')]: { sourceKey: 'C:/a.wav', runId: 'R1', edits: { 0: { speaker: '새것' } } },
    'C:/a.wav': { sourceKey: 'C:/a.wav', runId: 'R1', edits: { 0: { speaker: '옛것' } } },
  } })
  assert.equal(Object.keys(s.drafts).length, 2, '하나가 사라졌다')
  assert.equal(s.drafts[draftKey('C:/a.wav', 'R1')].edits[0].speaker, '새것', '새 형식을 덮었다')
  assert.equal(s.drafts['C:/a.wav'].edits[0].speaker, '옛것', '옛 기록이 사라졌다')
})

test('지금 형식은 그대로 읽는다', () => {
  const good = parseStore({ version: 1, drafts: { [draftKey('C:/a.wav', 'R1')]: { sourceKey: 'C:/a.wav', runId: 'R1' } } })
  assert.deepEqual(Object.keys(good.drafts), [draftKey('C:/a.wav', 'R1')])
})

test('옛 한 칸에서 옮길 때 그때의 지문도 같이 만든다', () => {
  const s = migrateLegacy(emptyStore(), {
    sourcePath: 'C:/z.wav',
    segments: [{ start: 0, end: 1, speaker: '화자 A' }, { start: 1, end: 2, speaker: '화자 B' }],
    edits: { 1: { speaker: '화자 A' } }, updatedAt: 3,
  })
  const d = draftFor(s, 'C:/z.wav')!
  assert.equal(d.basis?.segmentCount, 2)
  assert.deepEqual(d.basis?.speakers, ['화자 A', '화자 B'])
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

test('★옛 기록과 새 실행의 교정은 **같이 산다** — 찾을 때 새 것이 이긴다', () => {
  const s = migrateLegacy(putDraft(emptyStore(), withEdit('C:/old.wav', 1, 'R1')), legacy)
  assert.equal(draftsOfSource(s, 'C:/old.wav').length, 2, '옛 기록을 버렸다')
  assert.equal(draftFor(s, 'C:/old.wav', 'R1')!.fromLegacy, undefined, '이 실행에는 새 것이 온다')
  assert.ok(draftFor(s, 'C:/old.wav')!.fromLegacy, '옛 기록도 그대로 찾을 수 있다')
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
