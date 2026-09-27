// 받아쓴 대본 얹기 — **원문을 버리지 않는다.**
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  linkCues, parseTimestampLines, rawTimestampFile, timelineNote,
} from './dialogueTranscript.ts'

test('받아쓴 그대로가 남는 파일을 읽는다 — 자막(.srt)이 아니다', () => {
  // ★.srt 는 `subtitle_cues.build_cues` 가 읽기 쉽게 **시각을 다시 매긴다**.
  assert.equal(rawTimestampFile('speaker_a'), 'speaker_a_timestamps.txt')
})

test('구간 파일을 읽는다. 읽지 못한 줄은 버리고 센다', () => {
  const { cues, skipped } = parseTimestampLines(
    '[0:03 → 0:07] 안녕하세요\n\n뭔가 다른 줄\n[1:00 → 1:04] 그래서 말인데\n[0:05 → 0:04] 뒤집힘')
  assert.equal(cues.length, 2)
  assert.deepEqual(cues[0], { start: 3, end: 7, text: '안녕하세요' })
  assert.equal(skipped, 2)
})

const segs = [{ index: 0, start: 3, end: 8 }, { index: 1, start: 20, end: 26 }, { index: 2, start: 40, end: 44 }]
const times = segs.map((s) => ({ start: s.start, end: s.end }))

test('자리가 분명한 줄은 그 발언에 붙는다', () => {
  const cues = [{ start: 3, end: 7, text: 'a' }, { start: 21, end: 25, text: 'b' }, { start: 41, end: 43, text: 'c' }]
  const r = linkCues(cues, segs)
  assert.deepEqual(r.text, { 0: 'a', 1: 'b', 2: 'c' })
  assert.deepEqual(r.unsure, {})
  assert.deepEqual(r.orphans, [])
  assert.equal(timelineNote(cues, r, times, 60).trusted, true)
})

test('★겹침이 모자란 줄은 버리지 않고 **확인 필요**로 남긴다', () => {
  // 6초짜리 줄인데 발언과 겹치는 것은 앞 1초뿐 — 확정하지 않는다.
  const cues = [{ start: 7, end: 13, text: '애매한 말' }]
  const r = linkCues(cues, segs)
  assert.deepEqual(r.text, {}, '확정으로 섞으면 안 된다')
  assert.equal(r.unsure[0], '애매한 말', '글이 사라졌다')
})

test('★어디에도 못 붙은 줄도 원문을 들고 있는다', () => {
  const cues = [{ start: 100, end: 104, text: '멀리 있는 말' }]
  const r = linkCues(cues, segs)
  assert.equal(r.orphans.length, 1)
  assert.equal(r.orphans[0].text, '멀리 있는 말')
})

test('★시간축이 어긋나도 **글을 전부 숨기지 않는다** — 확인 필요로 알린다', () => {
  // 무음을 걷어낸 파일을 받아쓰면 앞으로 몰린다(총 15초).
  const shifted = [{ start: 0, end: 5, text: 'a' }, { start: 5, end: 11, text: 'b' }, { start: 11, end: 15, text: 'c' }]
  const r = linkCues(shifted, segs)
  const kept = Object.keys(r.text).length + Object.keys(r.unsure).length + r.orphans.length
  assert.ok(kept > 0, '글이 통째로 사라졌다')
  const note = timelineNote(shifted, r, times, 60)
  assert.equal(note.trusted, false)
  assert.match(note.reason, /당겨진/)
})

test('원본 길이를 넘는 줄이 있으면 믿을 수 없다고 말한다 — 그래도 글은 남는다', () => {
  const cues = [{ start: 61, end: 70, text: 'x' }]
  const r = linkCues(cues, segs)
  assert.equal(r.orphans.length, 1)
  assert.match(timelineNote(cues, r, times, 60).reason, /원본 길이를 넘는/)
})

test('★겹쳐 말한 자리도 각자의 줄에 남는다 — 한 사람에게 몰지 않는다', () => {
  const a = linkCues([{ start: 3, end: 5, text: 'A 의 말' }], [{ index: 0, start: 0, end: 5 }])
  const b = linkCues([{ start: 3, end: 5, text: 'B 의 말' }], [{ index: 1, start: 3, end: 8 }])
  assert.deepEqual(a.text, { 0: 'A 의 말' })
  assert.deepEqual(b.text, { 1: 'B 의 말' })
})

test('한 발언에 여러 줄이 들어가면 이어 붙인다', () => {
  const r = linkCues(
    [{ start: 3, end: 5, text: '앞' }, { start: 5, end: 8, text: '뒤' }],
    [{ index: 0, start: 3, end: 8 }])
  assert.equal(r.text[0], '앞 뒤')
})

test('확인이 필요한 줄이 있으면 그 수를 말한다', () => {
  const cues = [{ start: 3, end: 7, text: 'a' }, { start: 100, end: 104, text: 'z' }]
  const r = linkCues(cues, segs)
  const note = timelineNote(cues, r, times, 200)
  assert.equal(note.trusted, true)
  assert.match(note.reason, /확인이 필요한 줄 1개/)
})
