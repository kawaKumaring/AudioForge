// 시간 목록 — **조용히 버리지 않는가, 앞 구간을 잃지 않는가.**
//
// ★2026-09-27 지시 2: "첫 시각이 0보다 크면 앞 구간을 버리지 말라.
//   0부터 첫 시각까지를 첫 트랙으로 보존하는 규칙을 적용하라.
//   잘못된 줄이 있으면 기존 편집을 유지하고 전체 적용을 막아라."
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTimeList, issuesSummary, clockOf, MAX_LINES } from './splitTimeList.ts'

test('평범한 목록을 읽는다 — 첫 줄이 0이면 그 줄은 첫 트랙 이름이다', () => {
  const r = parseTimeList('0:00 서곡\n1:30 두 번째\n3:00 세 번째', 600)
  assert.equal(r.ok, true)
  assert.equal(r.firstLabel, '서곡')
  assert.deepEqual(r.marks, [{ seconds: 90, label: '두 번째' }, { seconds: 180, label: '세 번째' }])
})

// ★이것이 이 파일의 존재 이유 하나.
test('첫 시각이 0보다 크면 앞 구간을 버리지 않는다', () => {
  const r = parseTimeList('1:30 두 번째\n3:00 세 번째', 600)
  assert.equal(r.ok, true)
  assert.equal(r.marks.length, 2, '첫 줄을 이름으로만 쓰고 버리면 경계가 하나가 된다')
  assert.equal(r.marks[0].seconds, 90)
  assert.equal(r.firstLabel, '', '첫 트랙 이름은 화면 기본값이 채운다')
})

test('시:분:초도 읽는다', () => {
  const r = parseTimeList('0:00 시작\n1:02:03 뒤쪽', 7200)
  assert.equal(r.marks[0].seconds, 3723)
})

test('대괄호·구분자·이름 없음을 받아들인다', () => {
  const r = parseTimeList('[0:00] 첫\n[2:00] - 둘\n4:00', 600)
  assert.equal(r.ok, true)
  assert.equal(r.marks.length, 2)
  assert.equal(r.marks[1].label, '', '이름이 없으면 비운다(화면이 기본 이름을 준다)')
})

// ★조용히 버리지 않는다.
test('읽을 수 없는 줄이 있으면 **아무것도 적용하지 않는다**', () => {
  const r = parseTimeList('0:00 첫\n여기는 시간이 아니다\n2:00 둘', 600)
  assert.equal(r.ok, false)
  assert.deepEqual(r.marks, [], '부분 적용하면 무엇이 들어갔는지 알 수 없다')
  assert.equal(r.issues.length, 1)
  assert.equal(r.issues[0].line, 2, '줄 번호를 단다')
  assert.match(r.issues[0].message, /2행/)
})

test('같은 시각이 두 번 오면 막는다', () => {
  const r = parseTimeList('0:00 첫\n2:00 둘\n2:00 셋', 600)
  assert.equal(r.ok, false)
  assert.equal(r.issues[0].code, 'duplicate')
  assert.match(r.issues[0].message, /3행/)
  assert.match(r.issues[0].message, /2행/, '어느 줄과 겹치는지 말한다')
})

test('원본 길이를 넘으면 막는다', () => {
  const r = parseTimeList('0:00 첫\n10:00 넘음', 300)
  assert.equal(r.ok, false)
  assert.equal(r.issues[0].code, 'out_of_range')
  assert.match(r.issues[0].message, /범위 초과/)
})

test('길이를 모르면 범위 검사를 하지 않는다', () => {
  const r = parseTimeList('0:00 첫\n10:00 뒤', 0)
  assert.equal(r.ok, true)
})

test('초가 60 이상이면 표기 오류다', () => {
  const r = parseTimeList('0:00 첫\n1:75 이상함', 600)
  assert.equal(r.ok, false)
  assert.equal(r.issues[0].code, 'bad_line')
})

test('빈 줄은 오류가 아니다', () => {
  const r = parseTimeList('0:00 첫\n\n\n2:00 둘\n', 600)
  assert.equal(r.ok, true)
  assert.equal(r.marks.length, 1)
})

test('읽을 것이 하나도 없으면 말한다', () => {
  const r = parseTimeList('   \n\n', 600)
  assert.equal(r.ok, false)
  assert.equal(r.issues[0].code, 'empty')
})

test('줄이 너무 많으면 거절한다', () => {
  const many = Array.from({ length: MAX_LINES + 5 }, (_, i) => `0:${String(i % 60).padStart(2, '0')} x`).join('\n')
  const r = parseTimeList(many, 100000)
  assert.equal(r.ok, false)
  assert.ok(r.issues.some((i) => i.code === 'too_many'))
})

test('순서가 뒤섞여 있어도 정렬해 준다', () => {
  const r = parseTimeList('0:00 첫\n3:00 셋\n2:00 둘', 600)
  assert.deepEqual(r.marks.map((m) => m.seconds), [120, 180])
})

test('간추린 한 줄에 건수를 적는다', () => {
  const r = parseTimeList('아니다\n또 아니다', 600)
  assert.match(issuesSummary(r.issues), /외 1건/)
  assert.equal(issuesSummary([]), '')
})

test('시간 표기는 사람이 읽는 꼴이다', () => {
  assert.equal(clockOf(0), '0:00')
  assert.equal(clockOf(95), '1:35')
  assert.equal(clockOf(3723), '1:02:03')
})
