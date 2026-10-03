import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import {
  writeRecord, readRecord, listRecords, deleteRecord, clearKind, migrateKind, sizeOfKind,
// @ts-ignore TS5097
} from './work-store.ts'

const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), 'af-works-'))
  let t = 1000
  return { root, now: () => (t += 10), _dir: root }
}
const drop = (h: { _dir: string }) => { try { rmSync(h._dir, { recursive: true, force: true }) } catch { /* noop */ } }

test('쓴 것을 그대로 읽는다', () => {
  const h = fresh()
  try {
    const w = writeRecord(h, 'transcript', 'C:/소리/말.wav\u001f본문', { edits: { 1: '고침' } })
    assert.ok(w.ok, '쓰지 못했다')
    const got = readRecord(h, 'transcript', 'C:/소리/말.wav\u001f본문')
    assert.deepEqual(got.data, { edits: { 1: '고침' } })
    assert.equal(got.key, 'C:/소리/말.wav\u001f본문')
    assert.ok(got.updatedAt > 0)
  } finally { drop(h) }
})

test('없는 기록은 null — 빈 것으로 꾸미지 않는다', () => {
  const h = fresh()
  try { assert.equal(readRecord(h, 'cards', '없음'), null) } finally { drop(h) }
})

test('★지우기는 그 파일 하나만 지운다', () => {
  const h = fresh()
  try {
    writeRecord(h, 'transcript', 'A', { v: 1 })
    writeRecord(h, 'transcript', 'B', { v: 2 })
    writeRecord(h, 'transcript', 'C', { v: 3 })
    const r = deleteRecord(h, 'transcript', 'B')
    assert.deepEqual(r, { ok: true, removed: true })
    const left = listRecords(h, 'transcript').records.map((x) => x.key).sort()
    assert.deepEqual(left, ['A', 'C'], '남의 기록이 함께 사라졌다')
    assert.equal(readRecord(h, 'transcript', 'B'), null)
  } finally { drop(h) }
})

test('없는 것을 지우라는 요청은 실패가 아니다', () => {
  const h = fresh()
  try {
    assert.deepEqual(deleteRecord(h, 'cards', '없음'), { ok: true, removed: false })
  } finally { drop(h) }
})

test('★지운 것이 목록에 되살아나지 않는다', () => {
  const h = fresh()
  try {
    writeRecord(h, 'dialogue', 'A', { v: 1 })
    deleteRecord(h, 'dialogue', 'A')
    assert.equal(listRecords(h, 'dialogue').records.length, 0)
    // 다른 기록을 써도 지운 것이 돌아오지 않는다 — 한 파일에 모여 있지 않기 때문이다.
    writeRecord(h, 'dialogue', 'B', { v: 2 })
    assert.deepEqual(listRecords(h, 'dialogue').records.map((r) => r.key), ['B'])
  } finally { drop(h) }
})

test('목록은 최근 손댄 순', () => {
  const h = fresh()
  try {
    writeRecord(h, 'transcript', '먼저', { v: 1 })
    writeRecord(h, 'transcript', '나중', { v: 2 })
    assert.deepEqual(listRecords(h, 'transcript').records.map((r) => r.key), ['나중', '먼저'])
  } finally { drop(h) }
})

test('★깨진 파일 하나가 나머지를 가리지 않는다', () => {
  const h = fresh()
  try {
    writeRecord(h, 'transcript', '성한것', { v: 1 })
    const dir = join(h.root, 'works', 'transcript')
    writeFileSync(join(dir, '깨짐.abc123.json'), '{ 이건 JSON 이 아니다', 'utf-8')
    const got = listRecords(h, 'transcript')
    assert.deepEqual(got.records.map((r) => r.key), ['성한것'])
    assert.deepEqual(got.broken, ['깨짐.abc123.json'], '깨진 것을 조용히 버렸다')
  } finally { drop(h) }
})

test('갈래를 비워도 남의 파일은 건드리지 않는다', () => {
  const h = fresh()
  try {
    writeRecord(h, 'cards', 'A', { v: 1 })
    const dir = join(h.root, 'works', 'cards')
    writeFileSync(join(dir, '메모.txt'), '남의 것', 'utf-8')
    assert.equal(clearKind(h, 'cards'), 1)
    assert.deepEqual(readdirSync(dir), ['메모.txt'])
  } finally { drop(h) }
})

test('갈래가 없으면 비울 것도 없다', () => {
  const h = fresh()
  try {
    assert.equal(clearKind(h, 'lab'), 0)
    assert.deepEqual(listRecords(h, 'lab'), { records: [], broken: [] })
    assert.equal(sizeOfKind(h, 'lab'), 0)
  } finally { drop(h) }
})

// ── 옮기기 ────────────────────────────────────────────────────────────────
test('옛 한 덩어리를 기록 여럿으로 옮기고 옛 열쇠를 지운다', () => {
  const h = fresh()
  try {
    const bag: Record<string, unknown> = {
      transcriptDrafts: { version: 1, drafts: { 'A': { e: 1 }, 'B': { e: 2 } } },
    }
    const r = migrateKind(h, 'transcript', (k) => bag[k], (k) => { delete bag[k]; return true })
    assert.equal(r.moved, 2)
    assert.deepEqual(r.failed, [])
    assert.deepEqual(r.clearedKeys, ['transcriptDrafts'])
    assert.equal(bag.transcriptDrafts, undefined, '옛 열쇠가 남아 있다 — 다음에 되살아난다')
    assert.deepEqual(listRecords(h, 'transcript').records.map((x) => x.key).sort(), ['A', 'B'])
  } finally { drop(h) }
})

test('★두 번 옮기지 않는다 — 지운 기록이 되살아난다', () => {
  const h = fresh()
  try {
    const bag: Record<string, unknown> = { transcriptDrafts: { drafts: { 'A': { e: 1 } } } }
    migrateKind(h, 'transcript', (k) => bag[k], (k) => { delete bag[k]; return true })
    deleteRecord(h, 'transcript', 'A')
    writeRecord(h, 'transcript', 'Z', { e: 9 })     // 갈래에 무언가는 남아 있다
    bag.transcriptDrafts = { drafts: { 'A': { e: 1 } } }   // 옛 열쇠가 되돌아왔다 치자
    const again = migrateKind(h, 'transcript', (k) => bag[k], (k) => { delete bag[k]; return true })
    assert.equal(again.moved, 0, '다시 옮겼다 — 사용자가 지운 A 가 되살아난다')
    assert.equal(readRecord(h, 'transcript', 'A'), null)
  } finally { drop(h) }
})

test('★옮기다 실패하면 옛 열쇠를 지우지 않는다', () => {
  const h = fresh()
  try {
    // 갈래 폴더 자리에 **파일**을 두어 쓰기를 실패시킨다.
    mkdirSync(join(h.root, 'works'), { recursive: true })
    writeFileSync(join(h.root, 'works', 'lab'), '폴더가 아니다', 'utf-8')
    const bag: Record<string, unknown> = { labWorkspace: { drafts: { 'A': { e: 1 } } } }
    const r = migrateKind(h, 'lab', (k) => bag[k], (k) => { delete bag[k]; return true })
    assert.equal(r.moved, 0)
    assert.ok(r.failed.length >= 1, '실패를 조용히 삼켰다')
    assert.deepEqual(r.clearedKeys, [], '반쯤 옮기고 옛 자리를 지웠다 — 기록이 사라진다')
    assert.ok(bag.labWorkspace, '옛 기록이 사라졌다')
  } finally { drop(h) }
})

test('가를 수 없는 덩어리는 통째로 한 기록이 된다', () => {
  const h = fresh()
  try {
    const bag: Record<string, unknown> = { synthesisCards: { current: { cards: [] }, kept: [] } }
    const r = migrateKind(h, 'cards', (k) => bag[k], (k) => { delete bag[k]; return true })
    // {current, kept} 는 두 칸으로 갈린다 — 그것도 기록 둘이다.
    assert.ok(r.moved >= 1)
    assert.deepEqual(r.failed, [])
    assert.ok(listRecords(h, 'cards').records.length >= 1)
  } finally { drop(h) }
})

test('옮길 것이 없으면 아무것도 하지 않는다', () => {
  const h = fresh()
  try {
    const r = migrateKind(h, 'drafts', () => undefined, () => true)
    assert.deepEqual(r, { kind: 'drafts', moved: 0, failed: [], clearedKeys: [] })
    assert.ok(!existsSync(join(h.root, 'works', 'drafts')), '빈 폴더를 만들었다')
  } finally { drop(h) }
})
