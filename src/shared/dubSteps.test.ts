// 더빙 화면이 **무엇부터 해야 하는지 말하는가.**
//
// ★2026-09-26 신고: "구조적으로 이게 대체 뭘 하려는건지 근본없이 누더기처럼 붙여놨다."
//   단추가 평평하게 깔려 있어 순서가 없었고, 잠긴 단추는 고장으로 읽혔다.
//   이 검사가 지키는 것은 **화면이 거짓 순서를 만들지 않는다**는 약속이다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dubSteps, type DubProgress } from './dubSteps.ts'

const nothing: DubProgress = { video: false, voice: false, front: false, made: 0, lines: 0 }
const at = (p: DubProgress) => dubSteps(p).find((s) => s.active)?.key
const step = (p: DubProgress, key: string) => dubSteps(p).find((s) => s.key === key)!

test('아무것도 안 했으면 영상부터', () => {
  assert.equal(at(nothing), 'video')
})

test('차례는 한 번에 하나만 켜진다', () => {
  for (const p of [nothing, { ...nothing, video: true }, { ...nothing, video: true, front: true }]) {
    assert.equal(dubSteps(p).filter((s) => s.active).length, 1, '차례가 여럿이면 어디를 볼지 모른다')
  }
})

// ★이것이 이 파일의 존재 이유다 — 거짓 순서를 만들지 않는다.
test('목소리 고르기는 말 꺼내기를 기다리지 않는다', () => {
  const p = { ...nothing, video: true }
  assert.equal(step(p, 'voice').blocked, '', '할 수 있는 일을 못 하게 막는다')
})

test('영상을 안 골랐으면 말을 못 꺼낸다 — 이유를 말한다', () => {
  assert.match(step(nothing, 'front').blocked, /영상/, '막아 놓고 이유를 말하지 않는다')
})

test('소리 만들기는 말과 목소리 **둘 다** 있어야 한다', () => {
  const noVoice = { ...nothing, video: true, front: true, lines: 10 }
  assert.match(step(noVoice, 'synth').blocked, /목소리/)
  const noFront = { ...nothing, video: true, voice: true, lines: 10 }
  assert.match(step(noFront, 'synth').blocked, /말/)
  const both = { ...nothing, video: true, voice: true, front: true, lines: 10 }
  assert.equal(step(both, 'synth').blocked, '', '둘 다 있는데도 막는다')
})

test('만든 줄이 하나도 없으면 영상을 못 만든다', () => {
  const p = { ...nothing, video: true, voice: true, front: true, lines: 10, made: 0 }
  assert.match(step(p, 'render').blocked, /없습니다/)
  assert.equal(step({ ...p, made: 1 }, 'render').blocked, '', '한 줄이라도 있으면 내보낼 수 있다')
})

test('줄을 다 만들면 소리 만들기는 끝난 것으로 본다', () => {
  const p = { ...nothing, video: true, voice: true, front: true, lines: 3, made: 3 }
  assert.equal(step(p, 'synth').done, true)
  assert.equal(at(p), 'render', '다 만들었는데도 다음을 가리키지 않는다')
})

test('막힌 단계를 차례라고 부르지 않는다', () => {
  const p = { ...nothing, video: true, front: true, lines: 5 }
  const a = dubSteps(p).find((s) => s.active)!
  assert.equal(a.blocked, '', '못 하는 일을 지금 하라고 말한다')
})

test('번호는 보이는 순서대로 1부터', () => {
  assert.deepEqual(dubSteps(nothing).map((s) => s.no), [1, 2, 3, 4, 5])
})
