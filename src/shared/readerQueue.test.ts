import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import {
  emptyQueue, nextToMake, canPlayNow, waitReason, markMaking, markReady, markFailed,
  seek, advance, atEnd, changeVoice, acceptResult, readyPaths, retryFailed, DEFAULT_AHEAD,
// @ts-ignore TS5097
} from './readerQueue.ts'

const q0 = (n = 6, voice = 'piper:ko') => emptyQueue(n, voice)

test('처음에는 지금 자리부터 만든다', () => {
  assert.equal(nextToMake(q0()), 0)
  assert.equal(canPlayNow(q0()), false)
  assert.match(waitReason(q0()), /기다리는/)
})

test('★한 번에 하나만 만든다 — 본체가 파이썬을 하나만 돌린다', () => {
  const q = markMaking(q0(), 0)
  assert.equal(nextToMake(q), -1, '둘을 동시에 만들려 한다 — 하나는 반드시 거절당한다')
  assert.match(waitReason(q), /만드는 중/)
})

test('★앞선 것부터 만든다 — 뒤엣것을 먼저 만들면 소용없다', () => {
  let q = markReady(q0(), 0, 'a.wav')
  assert.equal(nextToMake(q), 1)
  q = markReady(q, 1, 'b.wav')
  assert.equal(nextToMake(q), 2)
})

test('★앞서 만들어 두는 양에 한계가 있다 — 옮기면 버리는 것이 커진다', () => {
  let q = q0(20)
  for (let i = 0; i <= DEFAULT_AHEAD; i++) q = markReady(q, i, `${i}.wav`)
  assert.equal(nextToMake(q), -1, `${DEFAULT_AHEAD} 개를 넘겨 미리 만든다`)
})

test('만들어 두면 바로 틀 수 있다', () => {
  const q = markReady(q0(), 0, 'a.wav')
  assert.equal(canPlayNow(q), true)
  assert.equal(waitReason(q), '', '틀 수 있는데 기다리라고 말한다')
  assert.deepEqual(readyPaths(q), ['a.wav'])
})

test('★실패는 사유를 그대로 말한다 — 조용히 멈추지 않는다', () => {
  const q = markFailed(markMaking(q0(), 0), 0, '목소리를 찾지 못했습니다')
  assert.equal(canPlayNow(q), false)
  assert.equal(waitReason(q), '목소리를 찾지 못했습니다')
  assert.equal(nextToMake(q), 1, '실패한 것을 붙들고 멈춰 있다')
})

test('사유가 없으면 그래도 실패라고 말한다', () => {
  assert.match(waitReason(markFailed(q0(), 0, '')), /만들지 못했/)
})

test('다음으로 넘어간다', () => {
  let q = markReady(q0(3), 0, 'a.wav')
  q = markReady(q, 1, 'b.wav')
  q = advance(q)
  assert.equal(q.at, 1)
  assert.equal(canPlayNow(q), true)
  assert.equal(atEnd(q), false)
  assert.equal(advance(advance(q)).at, 2, '끝을 넘어간다')
  assert.equal(atEnd(advance(advance(q))), true)
})

test('덩이가 없으면 끝으로 본다', () => {
  const q = q0(0)
  assert.equal(atEnd(q), true)
  assert.equal(nextToMake(q), -1)
  assert.equal(waitReason(q), '')
})

test('★자리를 옮기면 지나온 것은 버린다 — 긴 책에서 자리만 차지한다', () => {
  let q = q0(10)
  q = markReady(q, 0, 'a.wav')
  q = markReady(q, 1, 'b.wav')
  q = seek(q, 5)
  assert.equal(q.at, 5)
  assert.deepEqual(readyPaths(q), [], '지나온 것을 그대로 들고 있다')
  assert.equal(nextToMake(q), 5)
})

test('★만드는 중인 것은 건드리지 않는다 — 결과가 갈 곳을 잃는다', () => {
  let q = markMaking(q0(10), 0)
  q = seek(q, 5)
  assert.equal(q.items[0].state, 'making', '돌고 있는 작업의 자리를 지웠다')
  assert.equal(nextToMake(q), -1, '이미 하나가 돌고 있는데 또 만들려 한다')
})

test('자리를 범위 밖으로 옮겨도 무너지지 않는다', () => {
  assert.equal(seek(q0(4), -3).at, 0)
  assert.equal(seek(q0(4), 99).at, 3)
  assert.equal(seek(q0(0), 5).at, 0)
})

test('★목소리를 바꾸면 만들어 둔 것을 전부 버린다', () => {
  let q = q0(5)
  q = markReady(q, 0, 'a.wav')
  q = markReady(q, 1, 'b.wav')
  q = seek(q, 1)
  const next = changeVoice(q, 'ref:B')
  assert.equal(next.at, 1, '★듣던 자리를 잃었다 — 사용자가 다시 찾아야 한다')
  assert.deepEqual(readyPaths(next), [], '옛 목소리로 만든 것을 그대로 쓴다')
  assert.equal(nextToMake(next), 1)
})

test('같은 목소리면 아무것도 버리지 않는다', () => {
  const q = markReady(q0(), 0, 'a.wav')
  assert.equal(changeVoice(q, q.voiceKey), q, '같은 목소리인데 다시 만들게 한다')
})

test('★늦게 온 결과가 새 목소리의 자리를 덮지 않는다', () => {
  let q = markMaking(q0(), 0)
  assert.equal(acceptResult(q, 0, 'piper:ko'), true)
  q = changeVoice(q, 'ref:B')
  assert.equal(acceptResult(q, 0, 'piper:ko'), false,
    '옛 목소리로 만든 결과를 받아들인다 — 무엇으로 만든 소리인지 알 수 없게 된다')
})

test('만들라고 하지 않은 자리의 결과는 받지 않는다', () => {
  const q = q0()
  assert.equal(acceptResult(q, 0, 'piper:ko'), false, '부르지도 않은 결과를 받아들인다')
  assert.equal(acceptResult(markReady(q, 0, 'a.wav'), 0, 'piper:ko'), false,
    '이미 만들어 둔 자리를 덮어쓴다')
})

test('★다시 누르면 굳은 실패가 풀린다 — 없으면 그 자리에 갇힌다', () => {
  // 다른 작업이 돌아 거절당하면 '실패' 로 굳는다. 그 작업이 끝나도 스스로 풀리지 않는다.
  let q = markFailed(markMaking(q0(4), 0), 0, '다른 작업이 끝난 뒤에 만들 수 있습니다')
  q = markFailed(q, 1, '같은 사유')
  const back = retryFailed(q)
  assert.equal(nextToMake(back), 0, '풀리지 않아 처음부터 다시 만들지 못한다')
  assert.equal(waitReason(back), '차례를 기다리는 중입니다')
})

test('★다시 시도해도 만드는 중인 것은 건드리지 않는다', () => {
  let q = markMaking(q0(4), 0)
  q = markFailed(q, 1, '실패')
  const back = retryFailed(q)
  assert.equal(back.items[0].state, 'making', '돌고 있는 것의 결과가 갈 곳을 잃는다')
  assert.equal(back.items[1].state, 'idle')
})

test('풀 것이 없으면 그대로 둔다', () => {
  const q = markReady(q0(), 0, 'a.wav')
  assert.equal(retryFailed(q), q)
})

// ★GPU 로 느린 목소리 — 누르기 전엔 앞서 만들지 않고, 만드는 동안 다른 화면이 비킨다(2026-09-30).
test('GPU 목소리 판단 — 참조와 Qwen 지정 목소리만', async () => {
  // @ts-ignore TS5097
  const { usesGpu } = await import('./readerQueue.ts')
  assert.equal(usesGpu({ kind: 'reference' }), true)
  assert.equal(usesGpu({ kind: 'builtin', engineId: 'qwen-custom' }), true)
  assert.equal(usesGpu({ kind: 'builtin', engineId: 'supertonic' }), false)
  assert.equal(usesGpu({ kind: 'builtin', engineId: 'piper' }), false)
  assert.equal(usesGpu({ kind: 'builtin' }), false)
  assert.equal(usesGpu(null), false)
})
