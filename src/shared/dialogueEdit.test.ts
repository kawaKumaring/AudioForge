// 대화 구간 수정의 **판정 규칙**.
//
// 지키는 것: 최초 분석 결과가 지워지지 않는가, 시간 범위 오류를 잡는가,
// 배정한 것과 갈라낸 것을 혼동하지 않는가(문구는 화면 쪽 검사가 본다).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  editedSegmentCount, effectiveSegment, exportSegments, isSegmentEdited,
  parseDialogueDoc, segmentProblem,
  type DialogueDoc,
} from './dialogueEdit.ts'

function doc(over: Partial<DialogueDoc> = {}): DialogueDoc {
  return {
    sourcePath: 'C:/in/a.wav',
    segments: [
      { start: 0, end: 5, speaker: '화자 A' },
      { start: 5, end: 11, speaker: '화자 B' },
      { start: 11, end: 18, speaker: '화자 A' },
    ],
    speakers: ['화자 A', '화자 B'], edits: {}, updatedAt: 0, ...over,
  }
}

test('고치기 전에는 최초 분석 결과 그대로', () => {
  const d = doc()
  assert.deepEqual(effectiveSegment(d, 1), { start: 5, end: 11, speaker: '화자 B' })
  assert.equal(isSegmentEdited(d, 1), false)
  assert.equal(editedSegmentCount(d), 0)
})

test('배정을 고쳐도 **최초 분석 결과는 남아 있다**', () => {
  const d = doc({ edits: { 1: { speaker: '화자 A' } } })
  assert.equal(effectiveSegment(d, 1).speaker, '화자 A')
  assert.equal(d.segments[1].speaker, '화자 B', '원본이 덮이면 되돌릴 수 없다')
  assert.equal(isSegmentEdited(d, 1), true)
  assert.equal(editedSegmentCount(d), 1)
})

test('경계만 고쳐도 고친 것으로 센다', () => {
  const d = doc({ edits: { 0: { end: 4.2 } } })
  assert.deepEqual(effectiveSegment(d, 0), { start: 0, end: 4.2, speaker: '화자 A' })
  assert.equal(editedSegmentCount(d), 1)
})

test('시간 범위 오류를 고치는 순간 잡는다', () => {
  assert.equal(segmentProblem({ start: 5, end: 3, speaker: 'A' }, 18), 'END_BEFORE_START')
  assert.equal(segmentProblem({ start: 20, end: 25, speaker: 'A' }, 18), 'OUT_OF_RANGE')
  assert.equal(segmentProblem({ start: 0, end: 5, speaker: 'A' }, 18), null)
  // 겹침은 오류가 아니다 — 두 사람이 동시에 말할 수 있다.
  assert.equal(segmentProblem({ start: 4, end: 7, speaker: 'B' }, 18), null)
})

test('내보낼 구간 — 문제가 있는 것만 빼고 알린다', () => {
  const d = doc({ edits: { 1: { end: 2 } } })      // 끝이 시작보다 앞
  const r = exportSegments(d, 18)
  assert.equal(r.segments.length, 2)
  assert.deepEqual(r.blocked, [{ index: 1, problem: 'END_BEFORE_START' }])
})

test('내보낼 구간은 시작 순서대로 나간다', () => {
  const d = doc({ edits: { 0: { start: 12, end: 14 } } })
  const r = exportSegments(d, 18)
  assert.deepEqual(r.segments.map((s) => s.start), [5, 11, 12])
})

test('저장본 복원 — 없는 구간을 가리키는 수정은 버린다', () => {
  const back = parseDialogueDoc({
    sourcePath: 'C:/in/a.wav',
    segments: [{ start: 0, end: 1, speaker: 'A' }],
    edits: { 0: { speaker: 'B' }, 9: { speaker: 'C' } },
  })
  assert.ok(back)
  assert.deepEqual(Object.keys(back!.edits), ['0'])
  assert.equal(parseDialogueDoc(null), null)
  assert.equal(parseDialogueDoc({ segments: [] }), null, 'sourcePath 없이는 어느 파일 것인지 모른다')
})
