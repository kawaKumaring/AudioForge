// 늦게 온 결과가 **바뀐 요청에 붙지 않는가.**
//
// ★2026-09-27 검수 재현(그대로 옮김)
//   NEW 요청이 돌고 있는 상태에서 OLD 요청의 결과 이벤트를 넣자,
//   **옛 결과 파일이 NEW 요청의 대사와 묶여** 생성본에 추가됐다.
//   화면이 '작업이 있는가' 만 보고 '누구의 것인가' 를 안 봤기 때문이다.
//
// 이 검사는 코드에 식별자가 있는지 보지 않는다. **실제로 버리는지**를 본다.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

;(globalThis as Record<string, unknown>).window = {
  addEventListener: () => {},
  api: {
    settings: { set: async () => ({ ok: true }), get: async () => ({}) },
    audio: { releaseReferenceClip: async () => {} },
    cards: { releaseMedia: async () => ({ ok: true }) },
  },
}
;(globalThis as Record<string, unknown>).crypto ??= { randomUUID: () => 'id-' + Math.random() }

const { useSynthesisCards } = await import('../stores/synthesisCards.store.ts')
const { useAppStore } = await import('../stores/app.store.ts')
const { acceptCardResult } = await import('./cardSynthesis.ts')

const card = {
  id: 'c1', label: 'A',
  source: { path: 'a.wav', name: 'a.wav', duration: 8 },
  text: '지금 대사', settings: { speed: 1, pitch: 0, emotion: '자연스럽게', reference: 'auto' as const, start: 0, end: 8 },
  takes: [], adoptedId: null,
}
const job = (reqId: string, text: string) => ({
  cardId: 'c1', reqId, text, source: card.source, settings: card.settings,
  applied: { speed: 1, pitch: 0, notes: [] },
  startedAt: 1, percent: 0, message: '', cancelling: false,
})
const takes = () => useSynthesisCards.getState().cards[0].takes

beforeEach(() => {
  useSynthesisCards.setState({ cards: [{ ...card, takes: [], adoptedId: null }], job: null, refs: {} })
  useAppStore.setState({ status: 'idle' })
})

// ★이것이 이 파일의 존재 이유다.
test('지난 요청의 결과가 지금 요청의 대사와 묶이지 않는다', () => {
  useSynthesisCards.getState().setJob(job('NEW', '지금 대사'))
  const r = acceptCardResult({ clientRequestId: 'OLD', tracks: [{ path: 'old.wav' }] })
  assert.ok(r.dropped, '옛 결과를 받아들였다')
  assert.equal(takes().length, 0, '옛 결과 파일이 지금 대사와 묶여 생성본에 붙었다')
  assert.ok(useSynthesisCards.getState().job, '남의 응답으로 내 작업을 끝냈다 — 내 결과는 아직 오는 중이다')
})

test('식별자가 없는 결과도 받지 않는다', () => {
  useSynthesisCards.getState().setJob(job('NEW', '지금 대사'))
  const r = acceptCardResult({ tracks: [{ path: 'nobody.wav' }] })
  assert.ok(r.dropped)
  assert.equal(takes().length, 0)
})

test('내 요청의 결과는 그때의 대사와 함께 붙는다', () => {
  useSynthesisCards.getState().setJob(job('R1', '요청 당시 대사'))
  // 도중에 카드 대사를 고쳤다 — 결과에는 **요청 당시** 값이 붙어야 한다.
  useSynthesisCards.getState().update('c1', { text: '나중에 고친 대사' })
  const r = acceptCardResult({ clientRequestId: 'R1', tracks: [{ path: 'mine.wav' }] })
  assert.ok(r.takeId, '내 결과를 버렸다')
  assert.equal(takes().length, 1)
  assert.equal(takes()[0].text, '요청 당시 대사', '결과에 지금 대사를 붙였다')
  assert.equal(takes()[0].path, 'mine.wav')
  assert.equal(useSynthesisCards.getState().job, null, '작업을 내리지 않았다')
})

test('다시 만들어도 이전 생성본을 지우지 않는다', () => {
  useSynthesisCards.getState().setJob(job('R1', '첫 번째'))
  acceptCardResult({ clientRequestId: 'R1', tracks: [{ path: 'one.wav' }] })
  useSynthesisCards.getState().setJob(job('R2', '두 번째'))
  acceptCardResult({ clientRequestId: 'R2', tracks: [{ path: 'two.wav' }] })
  assert.deepEqual(takes().map((t) => t.path), ['one.wav', 'two.wav'])
})

test('채택은 생성이 건드리지 않는다', () => {
  useSynthesisCards.getState().setJob(job('R1', '첫 번째'))
  acceptCardResult({ clientRequestId: 'R1', tracks: [{ path: 'one.wav' }] })
  const first = takes()[0].id
  useSynthesisCards.getState().update('c1', { adoptedId: first })
  useSynthesisCards.getState().setJob(job('R2', '두 번째'))
  acceptCardResult({ clientRequestId: 'R2', tracks: [{ path: 'two.wav' }] })
  assert.equal(useSynthesisCards.getState().cards[0].adoptedId, first,
    '재생성이 채택을 갈아 끼웠다')
})

// ★삭제→되돌리기로 준비 상태가 사라져 생성 단추가 잠긴 채였다(검수 재현 4).
test('되돌리기가 목소리 준비 상태까지 되살린다', () => {
  const st = useSynthesisCards.getState()
  st.setRef('c1', { phase: 'ready', clip: 'clip.wav', audio: 'a.wav', region: null, message: '', reqId: 'P1' })
  st.remove('c1')
  assert.equal(useSynthesisCards.getState().refs['c1'], undefined)
  useSynthesisCards.getState().undo()
  const back = useSynthesisCards.getState().refs['c1']
  assert.ok(back, '카드는 돌아왔는데 준비 상태가 없다 — 생성 단추가 잠긴 채가 된다')
  assert.equal(back.phase, 'ready')
  assert.equal(back.clip, 'clip.wav')
})
