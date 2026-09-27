// 받아쓴 대본 얹기 — **시간축이 같을 때만.**
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assignCues, checkTimeline, parseTimestampLines, rawTimestampFile, TIMELINE_MATCH_MIN,
} from './dialogueTranscript.ts'

test('받아쓴 그대로가 남는 파일을 읽는다 — 자막(.srt)이 아니다', () => {
  // ★.srt 는 `subtitle_cues.build_cues` 가 읽기 쉽게 **시각을 다시 매긴다**.
  //   그대로 합치면 말한 시각이 아니다.
  assert.equal(rawTimestampFile('speaker_a'), 'speaker_a_timestamps.txt')
})

test('구간 파일을 읽는다. 읽지 못한 줄은 버리고 센다', () => {
  const { cues, skipped } = parseTimestampLines(
    '[0:03 → 0:07] 안녕하세요\n\n뭔가 다른 줄\n[1:00 → 1:04] 그래서 말인데\n[0:05 → 0:04] 뒤집힘')
  assert.equal(cues.length, 2)
  assert.deepEqual(cues[0], { start: 3, end: 7, text: '안녕하세요' })
  assert.deepEqual(cues[1], { start: 60, end: 64, text: '그래서 말인데' })
  assert.equal(skipped, 2)
})

const segs = [{ start: 3, end: 8 }, { start: 20, end: 26 }, { start: 40, end: 44 }]

test('구간 안에 들어가면 얹는다', () => {
  const cues = [{ start: 3, end: 7, text: 'a' }, { start: 21, end: 25, text: 'b' }, { start: 41, end: 43, text: 'c' }]
  const v = checkTimeline(cues, segs, 60)
  assert.equal(v.ok, true)
  assert.equal(v.matched, 3)
})

test('★무음 제거 등으로 시간이 당겨진 대본은 얹지 않는다 — 끝나는 자리로 안다', () => {
  // 원본에서는 3·20·40초에 말했는데, 무음을 걷어낸 파일을 받아쓰면 앞으로 몰린다.
  // 말한 총량(15초)만큼만 남으므로 마지막 줄이 44초가 아니라 15초쯤에서 끝난다.
  const shifted = [{ start: 0, end: 5, text: 'a' }, { start: 5, end: 11, text: 'b' }, { start: 11, end: 15, text: 'c' }]
  const v = checkTimeline(shifted, segs, 60)
  assert.equal(v.ok, false)
  assert.match(v.reason, /당겨진/)
})

test('★발언이 많을수록 어긋남이 분명해진다 — 자리 비율로도 걸린다', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ start: i * 15, end: i * 15 + 6 }))
  const packed = many.map((_s, i) => ({ start: i * 6, end: i * 6 + 5, text: `t${i}` }))
  const v = checkTimeline(packed, many, 130)
  assert.equal(v.ok, false)
  assert.ok(v.matched / v.total < TIMELINE_MATCH_MIN || /당겨진/.test(v.reason))
})

test('뒷말 한 마디를 못 알아들은 정도는 막지 않는다', () => {
  const ok = [{ start: 3, end: 7, text: 'a' }, { start: 21, end: 25, text: 'b' }, { start: 40, end: 42, text: 'c' }]
  assert.equal(checkTimeline(ok, segs, 60).ok, true)
})

test('원본 길이를 넘는 줄이 있으면 얹지 않는다', () => {
  const v = checkTimeline([{ start: 61, end: 70, text: 'x' }], segs, 60)
  assert.equal(v.ok, false)
  assert.match(v.reason, /원본 길이를 넘는/)
})

test('받아쓴 것이 없거나 구간이 없으면 사유를 말한다 — 조용히 넘어가지 않는다', () => {
  assert.match(checkTimeline([], segs, 60).reason, /받아쓴 내용이 없/)
  assert.match(checkTimeline([{ start: 1, end: 2, text: 'a' }], [], 60).reason, /구간이 없/)
})

test('겹친 시간이 가장 긴 구간 하나에만 붙는다', () => {
  const placed = assignCues(
    [{ start: 20, end: 25, text: '가운데' }],
    [{ index: 0, start: 3, end: 8 }, { index: 1, start: 20, end: 26 }])
  assert.deepEqual(placed.text, { 1: '가운데' })
  assert.equal(placed.unplaced, 0)
})

test('★어디에도 붙지 못한 줄은 조용히 사라지지 않는다', () => {
  const placed = assignCues([{ start: 100, end: 104, text: '멀리' }], [{ index: 0, start: 3, end: 8 }])
  assert.deepEqual(placed.text, {})
  assert.equal(placed.unplaced, 1)
})

test('★겹쳐 말한 자리도 각자의 줄에 남는다 — 한 사람에게 몰지 않는다', () => {
  // A 와 B 가 3~5 초를 겹쳐 말했다. 각자의 받아쓰기를 **각자의 구간**에만 붙인다.
  const a = assignCues([{ start: 3, end: 5, text: 'A 의 말' }], [{ index: 0, start: 0, end: 5 }])
  const b = assignCues([{ start: 3, end: 5, text: 'B 의 말' }], [{ index: 1, start: 3, end: 8 }])
  assert.deepEqual(a.text, { 0: 'A 의 말' })
  assert.deepEqual(b.text, { 1: 'B 의 말' })
})

test('한 구간에 여러 줄이 들어가면 이어 붙인다', () => {
  const placed = assignCues(
    [{ start: 3, end: 5, text: '앞' }, { start: 5, end: 8, text: '뒤' }],
    [{ index: 0, start: 3, end: 8 }])
  assert.equal(placed.text[0], '앞 뒤')
})
