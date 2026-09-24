// 텍스트 교정의 **판정 규칙**을 실제로 돌려 본다.
//
// 여기서 지키는 것: 최초 인식 결과가 지워지지 않는가, 시간을 지어내지 않는가,
// 번역이 자동으로 맞춰졌다고 하지 않는가.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCorrectedSrt, buildCorrectedTxt, editedCount, effectiveText, exportLines,
  isEdited, parseTranscriptDoc, saveNoteText, saveNotes,
  type TranscriptDoc,
} from './transcriptEdit.ts'

function doc(over: Partial<TranscriptDoc> = {}): TranscriptDoc {
  return {
    sourcePath: 'C:/in/a.wav', base: 'a', language: 'ko',
    segments: [
      { start: 0, end: 2.5, text: '첫 문장입니다.' },
      { start: 2.5, end: 5, text: '둘째 문장입니다.' },
    ],
    edits: {}, updatedAt: 0, ...over,
  }
}

test('고치기 전에는 처음 인식한 글자를 그대로 보여 준다', () => {
  const d = doc()
  assert.equal(effectiveText(d, 0), '첫 문장입니다.')
  assert.equal(isEdited(d, 0), false)
  assert.equal(editedCount(d), 0)
})

test('고치면 그 글자를 보여 주되 **처음 인식 결과는 남아 있다**', () => {
  const d = doc({ edits: { 0: '첫 번째 문장입니다.' } })
  assert.equal(effectiveText(d, 0), '첫 번째 문장입니다.')
  assert.equal(d.segments[0].text, '첫 문장입니다.', '원본이 덮이면 되돌릴 수 없다')
  assert.equal(isEdited(d, 0), true)
  assert.equal(editedCount(d), 1)
})

test('앞뒤 공백만 다른 것은 고친 것으로 세지 않는다', () => {
  assert.equal(isEdited(doc({ edits: { 0: '  첫 문장입니다.  ' } }), 0), false)
})

test('되돌리면 처음 인식한 글자로 돌아온다', () => {
  const d = doc({ edits: { 0: 'x' } })
  const back = { ...d, edits: {} }
  assert.equal(effectiveText(back, 0), '첫 문장입니다.')
})

test('시간은 처음 인식한 구간 그대로다 — 고친 글자에 맞춰 다시 계산하지 않는다', () => {
  const d = doc({ edits: { 0: '아주 길게 늘여 쓴 첫 번째 문장입니다 정말로 깁니다' } })
  const lines = exportLines(d)
  assert.equal(lines[0].start, 0)
  assert.equal(lines[0].end, 2.5, '글자가 길어졌다고 끝 시간을 늘리지 않는다')
  assert.equal(lines[1].start, 2.5)
})

test('교정본 TXT·SRT 는 고친 글자를 쓴다', () => {
  const d = doc({ edits: { 1: '두 번째 문장입니다.' } })
  assert.equal(buildCorrectedTxt(d), '첫 문장입니다.\n두 번째 문장입니다.')
  const srt = buildCorrectedSrt(d)
  assert.ok(srt.includes('첫 문장입니다.'))
  assert.ok(srt.includes('두 번째 문장입니다.'))
})

// ★2026-09-24 감사: 자막 만드는 자리가 **넷**인데 여기만 손질을 건너뛰고 있었다.
//   그래서 같은 폴더에 손질된 <base>.srt 와 손질 안 된 <base>_corrected.srt 가
//   나란히 생겼고, **고친 쪽이** 더 읽기 나빴다. 이 검사는 예전에 '손질 없음' 을
//   고정하고 있었다 — 이제 **손질을 거친다**는 새 약속을 고정한다.
test('교정본 SRT 도 자막 손질을 거친다', () => {
  const d = doc({ edits: { 1: '두 번째 문장입니다.' } })
  const srt = buildCorrectedSrt(d)
  // 앞 자막이 뒤 자막과 맞닿지 않게 끝을 당긴다(예전에는 2.500 에서 맞닿았다).
  assert.ok(srt.includes('00:00:00,000 --> 00:00:02,420'), srt)
  assert.ok(srt.includes('00:00:02,500 --> 00:00:05,000'), srt)
  // 시작 시각은 인식 결과 그대로다 — 손질은 정렬을 다시 하지 않는다.
  assert.ok(srt.startsWith('1\n00:00:00,000'), srt)
})

test('교정본 SRT 는 긴 줄을 나눈다', () => {
  const d = doc({ edits: { 0: '가'.repeat(35) } })
  const body = buildCorrectedSrt(d)
  const textLines = body.split('\n').filter((l) => l && !l.includes('-->') && !/^\d+$/.test(l))
  assert.ok(textLines.some((l) => l.length <= 20), body)
})

test('내용을 비운 문장은 저장본에서 빠지되 **몇 개인지 알린다**', () => {
  const d = doc({ edits: { 0: '   ' } })
  assert.equal(buildCorrectedTxt(d), '둘째 문장입니다.')
  const n = saveNotes(d, false)
  assert.equal(n.emptiedCount, 1)
  assert.ok(saveNoteText(n).some((s) => s.includes('빠집니다')), '조용히 빼지 않는다')
})

test('번역문이 원문 교정에 자동으로 맞춰졌다고 하지 않는다', () => {
  const withEdit = saveNotes(doc({ edits: { 0: '고친 말' } }), true)
  assert.equal(withEdit.translationStale, true)
  assert.ok(saveNoteText(withEdit).some((s) => s.includes('자동으로 반영되지 않습니다')))
  // 고친 것이 없으면 번역이 어긋날 일도 없다.
  assert.equal(saveNotes(doc(), true).translationStale, false)
  // 번역 파일이 없으면 말할 것이 없다.
  assert.equal(saveNotes(doc({ edits: { 0: 'x' } }), false).translationStale, false)
})

test('저장본 복원 — 모양이 맞으면 되살리고 어긋나면 지어내지 않는다', () => {
  const d = doc({ edits: { 1: '고친 말' } })
  const back = parseTranscriptDoc(JSON.parse(JSON.stringify(d)))
  assert.ok(back)
  assert.equal(back!.edits[1], '고친 말')
  assert.equal(back!.segments.length, 2)
  assert.equal(parseTranscriptDoc(null), null)
  assert.equal(parseTranscriptDoc({ segments: [] }), null, 'sourcePath 없이는 어느 파일 것인지 모른다')
  assert.equal(parseTranscriptDoc({ sourcePath: 'a', segments: [{ start: 0 }] }), null)
})

test('저장본 복원 — 없는 문장을 가리키는 교정은 버린다', () => {
  const back = parseTranscriptDoc({
    sourcePath: 'C:/in/a.wav', base: 'a', language: 'ko',
    segments: [{ start: 0, end: 1, text: 'x' }],
    edits: { 0: '고침', 5: '엉뚱한 줄', '-1': '음수' },
  })
  assert.ok(back)
  assert.deepEqual(Object.keys(back!.edits), ['0'], '엉뚱한 줄에 붙으면 안 된다')
})
