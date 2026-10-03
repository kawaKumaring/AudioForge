// 최종 연결 파일이 **입력 생성본을 덮어쓰지 못하는가.**
//
// ★2026-09-27 검수 1항 [P1] 재현: A+B 를 이으면서 저장 자리를 A 로 고르니
//   ok=true 로 A 가 0.25초→0.5초가 됐다. 이름이 같은 경우뿐 아니라
//   **대소문자·구분자·상대 경로·하드링크 같은 별칭**까지 막아야 한다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  joinOutputFault, sameFileTarget, normalizePathForCompare, JOIN_TEMP_SUFFIX,
  type PathProbe,
} from './joinOutputGuard.ts'

/** 실제 파일 대신 표를 본다 — 무엇이 같은 파일인지 검사가 정한다. */
const probeOf = (ids: Record<string, string> = {}, real: Record<string, string> = {}): PathProbe => ({
  real: (p) => real[p] ?? p,
  fileId: (p) => ids[p] ?? null,
})

const A = { label: '첫째', path: 'C:/작업/take-a.wav' }
const B = { label: '둘째', path: 'C:/작업/take-b.wav' }

test('다른 자리에 저장하는 것은 막지 않는다', () => {
  assert.equal(joinOutputFault('C:/작업/최종.wav', [A, B], probeOf()), '')
})

test('입력 생성본을 그대로 고르면 막는다', () => {
  const why = joinOutputFault('C:/작업/take-a.wav', [A, B], probeOf())
  assert.match(why, /첫째/)
  assert.match(why, /저장할 수 없/)
})

test('대소문자만 다른 이름도 같은 파일로 본다', () => {
  assert.notEqual(joinOutputFault('C:/작업/TAKE-A.WAV', [A, B], probeOf()), '')
})

test('구분자만 다른 이름도 같은 파일로 본다', () => {
  const win = 'C:' + String.fromCharCode(92) + '작업' + String.fromCharCode(92) + 'take-a.wav'
  assert.notEqual(joinOutputFault(win, [A, B], probeOf()), '')
})

test('끝 구분자·중복 구분자에 속지 않는다', () => {
  assert.equal(normalizePathForCompare('C:/작업//take-a.wav'), 'c:/작업/take-a.wav')
  assert.equal(normalizePathForCompare('C:/작업/'), 'c:/작업')
})

// ★같은 파일을 다른 이름으로 부르는 경우 — 이름만 보면 놓친다.
test('상대 경로를 풀어 보고 같으면 막는다', () => {
  const probe = probeOf({}, { 'out/../작업/take-a.wav': 'C:/작업/take-a.wav' })
  assert.notEqual(joinOutputFault('out/../작업/take-a.wav', [A, B], probe), '')
})

test('이름이 달라도 파일 번호가 같으면 막는다(하드링크·단축 이름)', () => {
  const probe = probeOf({ 'C:/작업/다른이름.wav': 'dev1:99', 'C:/작업/take-b.wav': 'dev1:99' })
  const why = joinOutputFault('C:/작업/다른이름.wav', [A, B], probe)
  assert.match(why, /둘째/)
})

test('파일 번호가 서로 다르면 이름이 비슷해도 막지 않는다', () => {
  const probe = probeOf({ 'C:/작업/최종.wav': 'dev1:1', 'C:/작업/take-a.wav': 'dev1:2', 'C:/작업/take-b.wav': 'dev1:3' })
  assert.equal(joinOutputFault('C:/작업/최종.wav', [A, B], probe), '')
})

// ★임시 자리도 입력을 덮을 수 있다 — `<출력>.part` 로 쓴 뒤 자리를 바꾸기 때문이다.
test('작업 중 임시 자리가 입력과 겹쳐도 막는다', () => {
  const input = { label: '셋째', path: 'C:/작업/최종.wav' + JOIN_TEMP_SUFFIX }
  const why = joinOutputFault('C:/작업/최종.wav', [A, input], probeOf())
  assert.match(why, /임시 파일/)
})

test('저장 자리가 비면 만들지 않는다', () => {
  assert.match(joinOutputFault('', [A], probeOf()), /알 수 없/)
  assert.match(joinOutputFault('   ', [A], probeOf()), /알 수 없/)
})

test('입력에 빈 경로가 섞여도 넘어가지 않고 나머지를 본다', () => {
  const probe = probeOf()
  assert.equal(joinOutputFault('C:/작업/최종.wav', [{ path: '' }, A], probe), '')
  assert.notEqual(joinOutputFault('C:/작업/take-a.wav', [{ path: '' }, A], probe), '')
})

test('이름표가 없으면 이름표 없이 말한다', () => {
  const why = joinOutputFault('C:/작업/x.wav', [{ path: 'C:/작업/x.wav' }], probeOf())
  assert.match(why, /입력 카드의 생성본/)
})

test('같은 파일 판정 자체 — 번호가 하나만 있으면 이름으로 내려온다', () => {
  const probe = probeOf({ 'C:/x.wav': 'dev:1' })
  assert.equal(sameFileTarget('C:/x.wav', 'C:/y.wav', probe), false)
  assert.equal(sameFileTarget('C:/x.wav', 'C:/X.WAV', probe), true, '번호를 모르는 쪽은 이름으로 본다')
  assert.equal(sameFileTarget('', 'C:/x.wav', probe), false)
})
