// 저장 왕복에서 **무엇으로 만든 소리인가**가 살아남는가.
//
// ★2026-09-27 Codex 재현(`AudioForge-card-persistence-repro.mjs`):
//     beforeVoice: builtin → restoredVoice: none
//     beforeTakeVoice: true → restoredTakeVoice: false
//     beforeAppliedReference: {clip, region} → restoredAppliedReference: null
//   저장 형식에 자리가 없어 **기본 목소리 지정·생성본 목소리·실제 쓰인 참조 구간**이
//   통째로 사라졌다. 파서 단위 검사는 source 만 있는 fixture 를 써서 이것을 잡지 못했다.
//
// ★함께 지키는 것: **기록이 없던 값을 지어내지 않는다.**
//   옛 생성본에는 applied 도 voice 도 없다. 비어 있는 것은 비운 채로 돌아와야 한다 —
//   제품 기본값으로 채우면 "재지 않았다" 와 "1.0 이었다" 를 영영 구별할 수 없다.
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 모듈이 읽는 창구를 먼저 세운다(cardSynthesis 는 불러오는 순간 window 를 본다).
const presentImpl = { value: {} as Record<string, boolean> }
;(globalThis as Record<string, unknown>).window = {
  addEventListener: () => {},
  api: {
    settings: { set: async () => ({ ok: true }), get: async () => ({}) },
    audio: { sourcesPresent: async () => presentImpl.value, releaseReferenceClip: async () => {} },
    cards: { releaseMedia: async () => ({ ok: true }) },
  },
}

const { serializeWork, hydrateWork } = await import('./cardSynthesis.ts')
const { parseSavedWork } = await import('../../shared/synthesisCardSave.ts')
const { newCard } = await import('../stores/synthesisCards.store.ts')
const { cardVoiceOf, voiceSnapshot } = await import('../../shared/synthesisCardVoice.ts')

const BUILTIN = {
  engineId: 'piper', modelId: 'ko_KR-kss-medium', label: '한국어 기본',
  language: 'ko', path: 'C:/models/kss.onnx', sampleRate: 22050,
}
const joins = { gap: 0.35, level: true, edges: true, gaps: {} }

/** 저장 → JSON → 읽기 → 되살리기. 실제 경로 그대로다. */
async function roundTrip(cards: unknown[]) {
  const raw = JSON.parse(JSON.stringify(serializeWork(cards as never, joins)))
  const parsed = parseSavedWork(raw)
  assert.ok(parsed, '저장본을 읽지 못했다')
  return hydrateWork(parsed!)
}

function builtinCard() {
  const c = newCard(null, undefined, BUILTIN)
  c.text = '저장 확인'
  c.takes = [{
    id: 't1', path: 'made.wav', createdAt: 1, text: c.text,
    source: { path: '', name: BUILTIN.label, duration: 0 },
    settings: c.settings, applied: { speed: 1, pitch: 0, notes: [] },
    voice: voiceSnapshot(cardVoiceOf(c)),
  }]
  c.adoptedId = 't1'
  return c
}

function referenceCard() {
  const c = newCard({ path: 'ref.wav', name: '참조', duration: 8 })
  c.text = '참조 확인'
  c.takes = [{
    id: 't2', path: 'made2.wav', createdAt: 2, text: c.text,
    source: { path: 'ref.wav', name: '참조', duration: 8 },
    settings: c.settings,
    applied: { speed: 1, pitch: 0, notes: [], reference: { clip: 'clip.wav', region: { start: 2, duration: 4 } } },
    voice: voiceSnapshot(cardVoiceOf(c)),
  }]
  c.adoptedId = 't2'
  return c
}

// ★이것이 이 파일의 존재 이유다.
test('기본 목소리 카드가 되살아난다 — 목소리 없는 카드가 되지 않는다', async () => {
  const before = builtinCard()
  const { cards } = await roundTrip([before])
  assert.equal(cardVoiceOf(cards[0]).kind, 'builtin')
  assert.deepEqual(cards[0].builtin, BUILTIN, '엔진·모델·언어·경로·화자가 그대로여야 한다')
})

test('생성본의 목소리 기록이 되살아난다', async () => {
  const { cards } = await roundTrip([builtinCard()])
  const v = cards[0].takes[0].voice
  assert.ok(v, '생성본 목소리 기록이 사라졌다')
  assert.equal(v!.kind, 'builtin')
  assert.equal(v!.modelId, BUILTIN.modelId)
})

test('실제로 쓰인 참조 구간이 되살아난다', async () => {
  const { cards } = await roundTrip([referenceCard()])
  assert.deepEqual(cards[0].takes[0].applied.reference,
    { clip: 'clip.wav', region: { start: 2, duration: 4 } })
})

test('참조 카드도 그대로 돌아온다', async () => {
  const { cards } = await roundTrip([referenceCard()])
  assert.equal(cardVoiceOf(cards[0]).kind, 'reference')
  assert.equal(cards[0].source?.duration, 8)
  assert.equal(cards[0].takes[0].source.duration, 8, '생성본 원본 길이도 남아야 한다')
})

// ★없는 것을 만들어 내지 않는다.
test('기록이 없던 적용값을 기본값으로 지어내지 않는다', async () => {
  const c = builtinCard()
  c.takes[0].applied = { notes: [] } as never          // 옛 생성본: 잰 적이 없다
  delete (c.takes[0] as { voice?: unknown }).voice     // 옛 생성본: 목소리 기록도 없다
  const { cards } = await roundTrip([c])
  const t = cards[0].takes[0]
  assert.equal((t.applied as { speed?: number }).speed, undefined, '재지 않은 속도를 채웠다')
  assert.equal((t.applied as { pitch?: number }).pitch, undefined, '재지 않은 음높이를 채웠다')
  assert.equal(t.voice, undefined, '없던 목소리 기록을 지어냈다')
})

test('모양이 모자란 기본 목소리는 되살리지 않는다 — 다른 목소리로 바꾸지도 않는다', async () => {
  const c = builtinCard()
  const raw = JSON.parse(JSON.stringify(serializeWork([c] as never, joins)))
  delete raw.cards[0].builtin.path                     // 모델 자리가 사라진 경우
  const { cards } = await hydrateWork(parseSavedWork(raw)!)
  assert.equal(cards[0].builtin, undefined, '반쯤 채운 지정을 되살렸다')
  assert.equal(cardVoiceOf(cards[0]).kind, 'none', '자동으로 다른 목소리를 넣었다')
})

test('파일이 사라진 생성본은 표시만 하고 지우지 않는다', async () => {
  presentImpl.value = { 'made.wav': false }
  const { cards } = await roundTrip([builtinCard()])
  presentImpl.value = {}
  assert.equal(cards[0].takes.length, 1, '생성본을 지웠다')
  assert.equal(cards[0].takes[0].missing, true)
  assert.ok(cards[0].takes[0].voice, '파일이 없어도 목소리 기록은 남아야 한다')
})

test('보관 칸(kept)의 작업도 같은 형식으로 돌아온다', async () => {
  const { adoptFromKept, parseSavedFile } = await import('../../shared/synthesisCardSave.ts')
  const current = JSON.parse(JSON.stringify(serializeWork([referenceCard()] as never, joins)))
  const kept = JSON.parse(JSON.stringify(serializeWork([builtinCard()] as never, joins)))
  const file = parseSavedFile({ current, kept: [kept] })
  const picked = adoptFromKept(file, 0)
  const { cards } = await hydrateWork(picked.current!)
  assert.equal(cardVoiceOf(cards[0]).kind, 'builtin', '보관본의 기본 목소리가 사라졌다')
  assert.ok(cards[0].takes[0].voice)
  // 치워 둔 자리에 있던 현재 작업도 형식이 같아야 한다.
  const back = await hydrateWork(picked.kept[0])
  assert.deepEqual(back.cards[0].takes[0].applied.reference,
    { clip: 'clip.wav', region: { start: 2, duration: 4 } })
})

test('두 번 왕복해도 값이 닳지 않는다', async () => {
  const once = await roundTrip([builtinCard(), referenceCard()])
  const twice = await roundTrip(once.cards)
  assert.deepEqual(twice.cards[0].builtin, BUILTIN)
  assert.deepEqual(twice.cards[1].takes[0].applied.reference,
    { clip: 'clip.wav', region: { start: 2, duration: 4 } })
  assert.equal(twice.cards[0].takes[0].voice?.modelId, BUILTIN.modelId)
})
