// 분할 조각 규칙 — **보여 준 것과 저장되는 것이 같은가**.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPieces, safeLabel, selectedPieces } from './splitPieces.ts'

test('마커가 없으면 통째로 한 조각', () => {
  const p = buildPieces([], 30)
  assert.equal(p.length, 1)
  assert.deepEqual([p[0].start, p[0].end, p[0].duration], [0, 30, 30])
  assert.equal(p[0].name, '01_Track 01')
})

test('마커 사이가 한 조각이고, 마지막은 전체 길이까지다', () => {
  const p = buildPieces([10, 20], 30, ['첫곡', '둘째곡', '셋째곡'])
  assert.equal(p.length, 3)
  assert.deepEqual(p.map((x) => [x.start, x.end]), [[0, 10], [10, 20], [20, 30]])
  assert.deepEqual(p.map((x) => x.duration), [10, 10, 10])
  assert.deepEqual(p.map((x) => x.name), ['01_첫곡', '02_둘째곡', '03_셋째곡'])
})

test('이름 없는 조각은 Track NN — 파일 이름에 못 쓰는 글자는 뺀다', () => {
  const p = buildPieces([5], 10, ['a/b:c*d', ''])
  assert.equal(p[0].name, '01_abcd')
  assert.equal(p[1].name, '02_Track 02')
  assert.equal(safeLabel('x?y|z'), 'xyz')
  // 이름이 통째로 못 쓸 글자면 track_NN 으로 떨어진다
  assert.equal(buildPieces([], 10, ['///'])[0].name, 'track_01')
})

test('경계를 지우면 앞뒤 조각이 하나로 합쳐진다', () => {
  const three = buildPieces([10, 20], 30)
  const two = buildPieces([20], 30)          // 10초 경계를 지웠다
  assert.equal(three.length, 3)
  assert.equal(two.length, 2)
  assert.deepEqual([two[0].start, two[0].end], [0, 20], '앞 두 조각이 하나가 된다')
})

test('고른 조각만 저장하되 **번호는 밀리지 않는다**', () => {
  const p = buildPieces([10, 20], 30, ['가', '나', '다'])
  const keep = selectedPieces(p, [0, 2])
  assert.deepEqual(keep.map((x) => x.name), ['01_가', '03_다'],
    '가운데를 빼도 이름의 번호가 바뀌면 미리듣기와 저장본이 어긋난다')
  assert.deepEqual(keep.map((x) => [x.start, x.end]), [[0, 10], [20, 30]])
  assert.equal(selectedPieces(p, null).length, 3, '고르지 않으면 전부')
})

// ★2026-09-24: 두 쪽에 **똑같이 적혀 있었는데 읽히는 값이 달랐다.**
//   JS 는 '\\/' 를 '/' 한 글자로 읽어 역슬래시가 빠졌고 파이썬은 그대로 뒀다.
//   역슬래시는 윈도 파일 이름에 못 쓰므로 파이썬이 맞았다.
//   미러 검사에 역슬래시 예제가 **양쪽 다 없어서** 파리티 검사가 이 글자를 비워 뒀다.
assert.equal(safeLabel('AC' + String.fromCharCode(92) + 'DC'), 'ACDC', '역슬래시를 빼야 한다')
assert.equal(safeLabel(String.fromCharCode(92)), '', '역슬래시만 있으면 빈 이름이다')
