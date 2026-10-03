import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plainDocument, markActing, editText, inferEdit, beginHistory, commitHistory, stepHistory, toCodePointRange } from './performanceDocument.ts'
const angry = { emotion: 'anger' }
const sad = { emotion: 'sadness' }
const marked = () => markActing(plainDocument('가나다라마바사'), { start: 2, end: 5 }, angry)
test('범위 앞 삽입은 감정을 이동한다', () => {
  assert.deepEqual(editText(marked(), { start: 0, end: 0, insert: '🙂' }).ranges, [{ start: 4, end: 7, acting: angry }])
})
test('범위 내부 삽입은 감정을 이어받는다', () => {
  assert.deepEqual(editText(marked(), { start: 3, end: 3, insert: '새' }).ranges, [{ start: 2, end: 6, acting: angry }])
})
test('양쪽 경계 삽입은 감정 밖이다', () => {
  assert.deepEqual(editText(marked(), { start: 2, end: 2, insert: '새' }).ranges, [{ start: 3, end: 6, acting: angry }])
  assert.deepEqual(editText(marked(), { start: 5, end: 5, insert: '새' }).ranges, marked().ranges)
})
test('일부 삭제와 전부 삭제', () => {
  assert.deepEqual(editText(marked(), { start: 3, end: 4, insert: '' }).ranges, [{ start: 2, end: 4, acting: angry }])
  assert.deepEqual(editText(marked(), { start: 1, end: 6, insert: '' }).ranges, [])
})
test('겹치는 감정 교체는 좌우를 보존한다', () => {
  assert.deepEqual(markActing(marked(), { start: 3, end: 4 }, sad).ranges, [
    { start: 2, end: 3, acting: angry }, { start: 3, end: 4, acting: sad }, { start: 4, end: 5, acting: angry },
  ])
})
test('일부 해제와 인접 동일 감정 합치기', () => {
  const cut = markActing(marked(), { start: 3, end: 4 }, null)
  assert.equal(cut.ranges.length, 2)
  assert.deepEqual(markActing(cut, { start: 3, end: 4 }, angry).ranges, marked().ranges)
})
test('전체 대사 교체는 기존 범위를 추측하지 않는다', () => {
  assert.deepEqual(editText(marked(), { start: 0, end: 7, insert: '새 대사' }).ranges, [])
})
test('텍스트와 감정은 함께 되돌리고 revision은 재사용하지 않는다', () => {
  const h = commitHistory(beginHistory(marked()), editText(marked(), { start: 0, end: 7, insert: '새 대사' }))
  const undo = stepHistory(h, 'undo')
  assert.equal(undo.present.text, marked().text)
  assert.deepEqual(undo.present.ranges, marked().ranges)
  assert.ok(undo.present.revision > h.present.revision)
  assert.equal(stepHistory(undo, 'redo').present.text, '새 대사')
})
test('같은 글자 반복은 선택 위치를 우선한다', () => {
  assert.deepEqual(inferEdit('가가가', '가가가가', { start: 1, end: 1 }), { start: 1, end: 1, insert: '가' })
})
test('한글 조합 결과 한 번의 교체로 적용', () => {
  const d = marked()
  const next = editText(d, inferEdit(d.text, '가나한라마바사', { start: 2, end: 3 }))
  assert.equal(next.text, '가나한라마바사')
  assert.equal(next.revision, d.revision + 1)
})
test('이모지 교체가 surrogate를 쪼개지 않는다', () => {
  assert.deepEqual(inferEdit('안🙂녕', '안🙃녕'), { start: 1, end: 3, insert: '🙃' })
  assert.throws(() => markActing(plainDocument('안🙂녕'), { start: 2, end: 3 }, angry))
})
test('Python 위치 변환과 오래된 revision 거부', () => {
  const doc = plainDocument('🙂 안녕')
  assert.deepEqual(toCodePointRange(doc, { start: 3, end: 5 }, 0), { start: 2, end: 4 })
  assert.throws(() => toCodePointRange(doc, { start: 3, end: 5 }, 1), /STALE/)
})
test('구간이 늘거나 줄어도 대사와 정렬 범위의 불변식을 지킨다', () => {
  for (let start = 0; start <= 7; start++) for (let end = start; end <= 7; end++) {
    const doc = editText(marked(), { start, end, insert: '새🙂' })
    assert.equal(doc.text, marked().text.slice(0, start) + '새🙂' + marked().text.slice(end))
    let last = 0
    for (const r of doc.ranges) { assert.ok(r.start >= last && r.end > r.start && r.end <= doc.text.length); last = r.end }
  }
})
