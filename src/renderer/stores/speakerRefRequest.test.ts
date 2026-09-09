// 인물 목소리 슬롯의 **상태 전이**를 실제로 돌려 본다(모양 검사가 아니다).
//
// 왜 이 파일이 있는가(2026-09-09 관리자 검수): 목소리 교체의 판정이 안내 문구에 걸려 있었고,
// 새 목소리를 준비하기도 전에 이전 클립을 지웠고, 늦게 도착한 결과를 원본 경로로만 걸렀다.
// 세 가지 모두 "코드가 이렇게 생겼다" 로는 확인할 수 없다 — 순서대로 돌려 봐야 한다.
//
// 확인하는 것
//   1) 등록은 이전 클립을 지우지 않는다(성공 전 삭제 금지)
//   2) ready 는 phase 의 거울이다(둘이 어긋난 상태가 생기지 않는다)
//   3) 낡은 요청의 결과는 버려진다 — **같은 파일을 다시 고른 경우까지**
//   4) 다시 준비는 새 요청이며 클립·구간을 지우지 않는다
//   5) 해제는 그때 클립을 놓는다(반대쪽 회귀 가드)
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const released: (string | undefined)[] = []
;(globalThis as unknown as { window: unknown }).window = {
  api: { audio: { releaseReferenceClip: (clipKey?: string) => { released.push(clipKey) } } },
}

const { useAppStore, refPhaseOf } = await import('./app.store.ts')

const slot = (id = 'spk_a') => useAppStore.getState().ttsSpeakerRefState[id]

beforeEach(() => {
  released.length = 0
  useAppStore.setState({ ttsSpeakerRefState: {}, ttsSpeakerLabels: {}, ttsSpeakerInherit: null })
})

test('목소리 등록은 이전 클립을 지우지 않는다 — 새 준비가 성공하기 전이므로', () => {
  useAppStore.getState().registerSpeakerRef('spk_a', 'C:/voice/A.wav')
  const first = slot()!.reqId
  useAppStore.getState().setSpeakerRefState('spk_a', {
    clip: 'C:/clip/a.wav', phase: 'ready', region: { start: 1, duration: 7 }, reqId: first,
  })
  assert.equal(slot()!.ready, true)

  released.length = 0
  useAppStore.getState().registerSpeakerRef('spk_a', 'C:/voice/B.wav')
  assert.deepEqual(released, [], '이전 클립을 놓지 않았다 — 되돌릴 대상이 살아 있어야 한다')
  assert.equal(slot()!.source, 'C:/voice/B.wav')
  assert.equal(refPhaseOf(slot()), 'preparing')
  assert.notEqual(slot()!.reqId, first, '새 요청이다')
})

test('ready 는 phase 의 거울이다 — 따로 어긋나지 않는다', () => {
  useAppStore.getState().registerSpeakerRef('spk_a', 'C:/voice/A.wav')
  const r = slot()!.reqId
  for (const [phase, ready] of [['preparing', false], ['needs_region', false],
    ['failed', false], ['ready', true]] as const) {
    useAppStore.getState().setSpeakerRefState('spk_a', { phase, reqId: r })
    assert.equal(slot()!.ready, ready, phase)
    assert.equal(refPhaseOf(slot()), phase)
  }
})

test('낡은 요청의 결과는 버려진다 — 파일을 연달아 골랐을 때', () => {
  useAppStore.getState().registerSpeakerRef('spk_a', 'C:/voice/A.wav')
  const reqA = slot()!.reqId!
  useAppStore.getState().registerSpeakerRef('spk_a', 'C:/voice/B.wav')
  const reqB = slot()!.reqId!
  assert.notEqual(reqA, reqB)

  // A 의 분석이 뒤늦게 끝나 '준비됨' 을 올린다 — B 를 고른 상태를 덮으면 안 된다.
  useAppStore.getState().setSpeakerRefState('spk_a', { clip: 'C:/clip/a.wav', phase: 'ready', reqId: reqA })
  assert.equal(slot()!.ready, false, '낡은 결과가 준비됨으로 만들지 않았다')
  assert.equal(slot()!.clip, '', '낡은 클립이 들어오지 않았다')
  assert.equal(slot()!.source, 'C:/voice/B.wav')

  // B 의 결과는 반영된다.
  useAppStore.getState().setSpeakerRefState('spk_a', { clip: 'C:/clip/b.wav', phase: 'ready', reqId: reqB })
  assert.equal(slot()!.clip, 'C:/clip/b.wav')
  assert.equal(slot()!.ready, true)
})

test('★같은 파일을 다시 골라도 낡은 결과는 버려진다 — 경로 비교로는 못 걸렀던 경우', () => {
  useAppStore.getState().registerSpeakerRef('spk_a', 'C:/voice/A.wav')
  const req1 = slot()!.reqId!
  // 같은 파일을 다시 고른다(경로가 같다 — 예전 방식은 여기서 통과시켰다).
  useAppStore.getState().registerSpeakerRef('spk_a', 'C:/voice/A.wav')
  const req2 = slot()!.reqId!
  assert.notEqual(req1, req2, '같은 파일이어도 새 요청이다')

  useAppStore.getState().setSpeakerRefState('spk_a', { phase: 'failed', message: '옛 실패', reqId: req1 })
  assert.equal(refPhaseOf(slot()), 'preparing', '낡은 실패가 새 요청의 상태를 덮지 않았다')
  assert.equal(slot()!.message, '')
})

test('다시 준비는 새 요청이고, 지금 쓰던 클립·구간을 지우지 않는다', () => {
  useAppStore.getState().registerSpeakerRef('spk_a', 'C:/voice/A.wav')
  const r = slot()!.reqId!
  useAppStore.getState().setSpeakerRefState('spk_a', {
    clip: 'C:/clip/a.wav', phase: 'ready', region: { start: 2, duration: 8 }, reqId: r,
  })
  released.length = 0

  useAppStore.getState().beginSpeakerRefRequest('spk_a')
  assert.notEqual(slot()!.reqId, r, '새 요청 식별자')
  assert.equal(refPhaseOf(slot()), 'preparing')
  assert.equal(slot()!.clip, 'C:/clip/a.wav', '쓰던 클립은 남는다 — 실패하면 되돌릴 것이다')
  assert.deepEqual(slot()!.region, { start: 2, duration: 8 }, '쓰던 구간도 남는다')
  assert.deepEqual(released, [], '다시 준비가 클립을 지우지 않는다')

  // 새 요청의 결과만 반영된다.
  useAppStore.getState().setSpeakerRefState('spk_a', { phase: 'ready', clip: 'C:/clip/a2.wav', reqId: r })
  assert.equal(slot()!.clip, 'C:/clip/a.wav', '낡은 요청 식별자로는 못 덮는다')
})

test('지정 해제는 그때 클립을 놓는다 — 반대쪽으로 새지 않았는지', () => {
  useAppStore.getState().registerSpeakerRef('spk_a', 'C:/voice/A.wav')
  released.length = 0
  useAppStore.getState().removeSpeakerRef('spk_a')
  assert.deepEqual(released, ['spk:spk_a'])
  assert.equal(slot(), undefined)
})

// ── 기본 목소리 슬롯 ────────────────────────────────────────────────────────
// 인물 슬롯과 **같은 규칙**을 쓴다(별도 체계를 만들지 않았다). 여러 명 화면에서 숨은 준비 구동과
// 기본 인물 카드의 편집기가 같은 슬롯을 갱신할 수 있던 자리다(2026-09-09 관리자 검수).

test('기본 목소리: ready 는 단계의 거울이고, 낡은 요청의 결과는 버려진다', () => {
  useAppStore.setState({ ttsRefReady: false, ttsRefPhase: 'idle', ttsRefReqId: '',
    ttsReferenceClip: '', ttsReferenceRegion: null, ttsRefMessage: '' })
  useAppStore.getState().beginTtsRefRequest()
  const r1 = useAppStore.getState().ttsRefReqId
  assert.ok(r1, '요청 식별자를 발급한다')
  assert.equal(useAppStore.getState().ttsRefPhase, 'preparing')

  useAppStore.getState().setTtsRefState({ clip: 'C:/clip/a.wav', phase: 'ready',
    region: { start: 1, duration: 7 }, reqId: r1 })
  assert.equal(useAppStore.getState().ttsRefReady, true)
  assert.equal(useAppStore.getState().ttsReferenceClip, 'C:/clip/a.wav')

  // 다시 준비 = 새 요청. 쓰던 클립·구간은 남는다(실패하면 그것을 계속 써야 한다).
  useAppStore.getState().beginTtsRefRequest()
  const r2 = useAppStore.getState().ttsRefReqId
  assert.notEqual(r1, r2)
  assert.equal(useAppStore.getState().ttsReferenceClip, 'C:/clip/a.wav', '클립 보존')
  assert.deepEqual(useAppStore.getState().ttsReferenceRegion, { start: 1, duration: 7 }, '구간 보존')
  assert.equal(useAppStore.getState().ttsRefReady, false)

  // 낡은 요청(r1)의 늦은 보고는 버린다 — 예전에는 두 보고자가 서로를 덮었다.
  useAppStore.getState().setTtsRefState({ clip: 'C:/clip/stale.wav', phase: 'ready', reqId: r1 })
  assert.equal(useAppStore.getState().ttsReferenceClip, 'C:/clip/a.wav', '낡은 보고가 덮지 않았다')
  assert.equal(useAppStore.getState().ttsRefReady, false)

  // 새 요청(r2)의 보고는 반영된다.
  useAppStore.getState().setTtsRefState({ clip: 'C:/clip/b.wav', phase: 'ready', reqId: r2 })
  assert.equal(useAppStore.getState().ttsReferenceClip, 'C:/clip/b.wav')
  assert.equal(useAppStore.getState().ttsRefReady, true)
})

test('기본 목소리: 단계를 싣지 않는 옛 보고(ready 만)도 그대로 받는다', () => {
  useAppStore.setState({ ttsRefReady: false, ttsRefPhase: 'idle', ttsRefReqId: '' })
  useAppStore.getState().setTtsRefState({ ready: true, clip: 'C:/clip/x.wav' })
  assert.equal(useAppStore.getState().ttsRefReady, true)
  assert.equal(useAppStore.getState().ttsRefPhase, 'ready', 'ready 로부터 단계를 맞춘다')
})

test('phase 가 없는 옛 슬롯은 ready 로부터 유추한다', () => {
  assert.equal(refPhaseOf(undefined), 'idle')
  assert.equal(refPhaseOf({ source: '', clip: '', region: null, ready: false, message: '' }), 'idle')
  assert.equal(refPhaseOf({ source: 'a.wav', clip: '', region: null, ready: false, message: '' }), 'preparing')
  assert.equal(refPhaseOf({ source: 'a.wav', clip: 'c.wav', region: null, ready: true, message: '' }), 'ready')
})
