// 낭독 서재 — 작품 묶음·폴더 가져오기·중복/변경 판정 규칙(2026-10-03).
import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 요구하는 명시적 .ts 확장자
import { naturalCompare, classifyIncoming, mapPosition, sortGroup, groupResume, moveInGroup, pushHistory, suggestGroupName, samePath, planDrop, type LibBook } from './readerLibrary.ts'

const book = (o: Partial<LibBook> & { id: string }): LibBook => ({ name: o.id, paragraphs: ['가'], position: 0, ...o })

test('자연 정렬 — 1화 → 2화 → 10화', () => {
  assert.deepEqual(['10화.txt', '2화.txt', '1화.txt', '1권 3화.txt'].sort(naturalCompare), ['1권 3화.txt', '1화.txt', '2화.txt', '10화.txt'])
})

test('같은 지문이면 이름이 달라도 중복, 파일 이름만 같다고 중복이 아니다', () => {
  const lib = [book({ id: 'a', name: '1화', source: { path: 'D:/x/1화.txt', size: 1, mtimeMs: 1, sha256: 'H1' } })]
  assert.deepEqual(classifyIncoming({ path: 'E:/y/다른이름.txt', sha256: 'H1', name: '다른이름', paragraphs: ['나'] }, lib), { kind: 'duplicate', id: 'a' })
  assert.deepEqual(classifyIncoming({ path: 'E:/y/1화.txt', sha256: 'H2', name: '1화', paragraphs: ['가'] }, lib), { kind: 'new' }, '다른 자리의 같은 이름은 새 책')
})

test('같은 원본 자리인데 내용이 바뀌면 \'변경\' — 조용히 덮지 않는다', () => {
  const lib = [book({ id: 'a', source: { path: 'D:\\x\\1화.txt', size: 1, mtimeMs: 1, sha256: 'H1' } })]
  assert.deepEqual(classifyIncoming({ path: 'd:/X/1화.TXT', sha256: 'H9', name: '1화', paragraphs: ['다'] }, lib), { kind: 'changed', id: 'a' })
})

test('지문 없는 예전 책은 이름 + 본문 전체가 같을 때만 중복', () => {
  const lib = [book({ id: 'old', name: '책', paragraphs: ['가', '나'] })]
  assert.equal(classifyIncoming({ sha256: 'Z', name: '책', paragraphs: ['가', '나'] }, lib).kind, 'duplicate')
  assert.equal(classifyIncoming({ sha256: 'Z', name: '책', paragraphs: ['가', '다'] }, lib).kind, 'new')
})

test('교체 뒤 자리 — 같은 문단 글이 있을 때만 그 자리(가장 가까운 것), 없으면 처음', () => {
  assert.deepEqual(mapPosition(['a', 'b', 'c'], 2, ['x', 'a', 'b', 'c']), { position: 3, kept: true })
  assert.deepEqual(mapPosition(['a', 'b', 'c'], 1, ['b', 'q', 'q', 'b']), { position: 0, kept: true }, '같은 거리면 앞의 것')
  assert.deepEqual(mapPosition(['a', 'b', 'c'], 2, ['x', 'y']), { position: 0, kept: false }, '없으면 단정하지 않는다')
  assert.deepEqual(mapPosition(['a'], 0, ['z']), { position: 0, kept: true })
})

test('묶음 차례 — order, 없으면 자연 정렬 / 이어 읽기 — 마지막으로 읽은 책, 없으면 첫 책', () => {
  const g = [book({ id: 'c', name: '10화' }), book({ id: 'a', name: '1화' }), book({ id: 'b', name: '2화' })]
  assert.deepEqual(sortGroup(g).map((b) => b.id), ['a', 'b', 'c'])
  assert.equal(groupResume(g)?.id, 'a')
  assert.equal(groupResume(g.map((b) => b.id === 'c' ? { ...b, readAt: 5 } : b))?.id, 'c', '읽은 기록이 있으면 그 책')
  assert.deepEqual(sortGroup([book({ id: 'x', name: '1화', order: 2 }), book({ id: 'y', name: '9화', order: 0 })]).map((b) => b.id), ['y', 'x'])
})

test('한 칸 앞/뒤로 — 끝에서는 움직이지 않는다', () => {
  const g = [book({ id: 'a', name: '1화' }), book({ id: 'b', name: '2화' }), book({ id: 'c', name: '3화' })]
  assert.deepEqual(moveInGroup(g, 'c', -1), [{ id: 'a', order: 0 }, { id: 'c', order: 1 }, { id: 'b', order: 2 }])
  assert.equal(moveInGroup(g, 'a', -1), null)
  assert.equal(moveInGroup(g, 'c', 1), null)
})

test('교체 이력은 최근 것부터 5개', () => {
  let b = book({ id: 'a', position: 3, source: { path: 'p', size: 1, mtimeMs: 1, sha256: 'H0' } })
  for (let i = 0; i < 7; i++) b = { ...b, history: pushHistory(b, i) }
  assert.equal(b.history!.length, 5); assert.equal(b.history![0].at, 6); assert.equal(b.history![0].sha256, 'H0')
})

test('묶음 이름 — 같은 이름의 다른 폴더면 부모 폴더 이름을 붙인다', () => {
  const lib = [book({ id: 'a', group: '1권', source: { path: 'D:/A/1권/x.txt', root: 'D:/A/1권', size: 1, mtimeMs: 1, sha256: 'h' } })]
  assert.equal(suggestGroupName({ root: 'D:/A/1권', name: '1권' }, lib), '1권', '같은 폴더면 그대로(다시 가져오기)')
  assert.equal(suggestGroupName({ root: 'D:/B/1권', name: '1권' }, lib), '1권 (B)')
  assert.equal(suggestGroupName({ root: 'D:/C/새 작품', name: '새 작품' }, lib), '새 작품')
  assert.ok(samePath('C:\\a\\B', 'c:/A/b'))
})

test('끌어 놓기 — 받지 못하면 사유를 돌려준다(조용히 버리지 않는다)', () => {
  assert.equal(planDrop([{ path: 'D:/a', dir: true }], true).kind, 'refuse', '작업 중')
  assert.equal(planDrop([], false).kind, 'refuse', '빈 끌기(글 조각·링크)')
  const miss = planDrop([{ path: 'D:/소설 모음', dir: true }, { path: '', dir: true }], false)
  assert.ok(miss.kind === 'refuse' && /1개 항목의 위치/.test(miss.reason), '폴더 위치를 못 읽으면 일부만 가져오지 않는다')
  assert.deepEqual(planDrop([{ path: 'D:/소설 모음', dir: true }, { path: 'D:/낱권.txt', dir: false }], false), { kind: 'paths', paths: ['D:/소설 모음', 'D:/낱권.txt'] })
  assert.deepEqual(planDrop([{ path: '', dir: false }], false), { kind: 'files' }, '파일만이면 내용으로 읽는다(위치 없어도 됨)')
})
