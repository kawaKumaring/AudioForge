// 카드가 엔진에 **보낼 수 있는 것과 없는 것**을 정직하게 가르는가.
//
// ★이 검사가 지키는 약속은 하나다 — **조용히 무시하거나 적용된 척하지 않는다.**
//   관리자 지시(2026-09-26): "미지원 설정을 조용히 무시하거나 적용된 것처럼 표시하지 마세요."
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cardApplied, cardClipKey, isCardClipKey, cardRegionFault, cardGenerateFault, takeIsStale,
  cardEventFault, takeMark, CARD_PITCH_MIN, CARD_PITCH_MAX, type CardEngineSettings,
} from './synthesisCardJob.ts'

const base: CardEngineSettings = {
  speed: 1, pitch: 0, emotion: '자연스럽게', reference: 'auto', start: 0, end: 10,
}

test('범위 안의 값은 그대로 간다', () => {
  const r = cardApplied({ ...base, speed: 1.15, pitch: 1.5 })
  assert.equal(r.speed, 1.15)
  assert.equal(r.pitch, 1.5)
  assert.deepEqual(r.notes, [], '멀쩡한 값에 군더더기를 붙인다')
})

// ★실측: python/pitch_shift.py 가 [-2, +2] 로 자른다. 화면 슬라이더는 -4~+4 다.
test('음높이가 엔진 범위를 넘으면 깎고 **깎았다고 말한다**', () => {
  const r = cardApplied({ ...base, pitch: 4 })
  assert.equal(r.pitch, CARD_PITCH_MAX, '엔진이 못 받는 값을 그대로 보낸다')
  const note = r.notes.find((n) => n.field === 'pitch')
  assert.ok(note, '깎아 놓고 말하지 않는다 — 화면에는 +4 가 남는다')
  assert.match(note.reason, /범위 밖/)
  assert.equal(cardApplied({ ...base, pitch: -9 }).pitch, CARD_PITCH_MIN)
})

test('음높이는 0.5 단위로 맞춘다', () => {
  assert.equal(cardApplied({ ...base, pitch: 0.7 }).pitch, 0.5)
  assert.ok(cardApplied({ ...base, pitch: 0.7 }).notes.some((n) => n.field === 'pitch'),
    '반올림해 놓고 말하지 않는다')
})

// ★이것이 이 파일의 존재 이유다.
test('감정은 보내지 않고, **안 보낸다고 말한다**', () => {
  const r = cardApplied({ ...base, emotion: '기쁨' })
  const note = r.notes.find((n) => n.field === 'emotion')
  assert.ok(note, '감정을 조용히 버린다 — 사용자는 적용된 줄 안다')
  assert.match(note.reason, /Qwen 지정 목소리/, '왜 안 되는지(어느 목소리에서만 되는지) 말하지 않으면 고장으로 읽힌다')
})

test('기본 감정은 잔소리하지 않는다', () => {
  assert.deepEqual(cardApplied({ ...base, emotion: '자연스럽게' }).notes, [])
})

test('망가진 값이 들어와도 엔진에 쓰레기를 보내지 않는다', () => {
  const r = cardApplied({ ...base, speed: 0, pitch: Number.NaN })
  assert.equal(r.speed, 1)
  assert.equal(r.pitch, 0)
})

test('카드마다 파생 클립 자리가 다르다', () => {
  assert.notEqual(cardClipKey('a'), cardClipKey('b'))
  assert.ok(isCardClipKey(cardClipKey('a')))
  // ★'default'·'lab'·'spk:' 와 겹치면 공용 작업의 정리가 카드 파일을 지운다.
  for (const other of ['default', 'lab', 'spk:1', 'happy']) {
    assert.ok(!isCardClipKey(other), `${other} 를 카드 자리로 본다`)
    assert.notEqual(cardClipKey('1'), other)
  }
})

test('직접 지정 구간은 따지고, 자동은 따지지 않는다', () => {
  assert.equal(cardRegionFault({ ...base, reference: 'auto', start: 9, end: 1 }, 10), '')
  assert.match(cardRegionFault({ ...base, reference: 'manual', start: 5, end: 3 }, 10), /뒤여야/)
  assert.match(cardRegionFault({ ...base, reference: 'manual', start: 0, end: 99 }, 10), /넘습니다/)
  assert.equal(cardRegionFault({ ...base, reference: 'manual', start: 1, end: 4 }, 10), '')
})

test('못 만들면 그 이유를 말한다', () => {
  const ok = { hasSource: true, text: '안녕', refReady: true, refMessage: '', busy: false }
  assert.equal(cardGenerateFault(ok), '')
  assert.match(cardGenerateFault({ ...ok, busy: true }), /다른 작업/)
  assert.match(cardGenerateFault({ ...ok, hasSource: false }), /음원/)
  assert.match(cardGenerateFault({ ...ok, text: '   ' }), /대사/)
  assert.match(cardGenerateFault({ ...ok, refReady: false, refMessage: '분석 실패' }), /분석 실패/)
})

test('대사·원본·설정이 달라지면 수정 전으로 본다', () => {
  const snap = {
    text: '안녕', sourcePath: 'a.wav', settings: { ...base },
    applied: { speed: 1, pitch: 0, notes: [] },
  }
  const now = { text: '안녕', sourcePath: 'a.wav', settings: { ...base } }
  assert.equal(takeIsStale(snap, now), false)
  assert.equal(takeIsStale(snap, { ...now, text: '잘 가' }), true)
  assert.equal(takeIsStale(snap, { ...now, sourcePath: 'b.wav' }), true)
  assert.equal(takeIsStale(snap, { ...now, settings: { ...base, speed: 1.2 } }), true)
  assert.equal(takeIsStale(snap, { ...now, settings: { ...base, start: 2 } }), true)
})

// ★2026-09-27 검수 재현: NEW 요청이 도는데 OLD 결과를 넣자 옛 파일이 지금 대사와 묶였다.
test('다른 요청의 응답을 받지 않는다', () => {
  assert.equal(cardEventFault({ clientRequestId: 'R1' }, 'R1'), '', '내 응답을 버린다')
  assert.match(cardEventFault({ clientRequestId: 'OLD' }, 'NEW'), /지난 요청/)
})

test('식별자 없는 이벤트는 내 것이 아니다', () => {
  // 본체는 이 화면의 실행이면 반드시 식별자를 싣는다. 없으면 남의 것이거나 바깥에서 온 것이다.
  assert.match(cardEventFault({ tracks: [{ path: 'x.wav' }] }, 'R1'), /식별자 없음/)
  assert.match(cardEventFault(null, 'R1'), /식별자 없음/)
  assert.match(cardEventFault(undefined, 'R1'), /식별자 없음/)
})

test('기다리는 요청이 없으면 아무것도 받지 않는다', () => {
  assert.match(cardEventFault({ clientRequestId: 'R1' }, ''), /기다리는 요청이 없/)
})
test('기본 목소리 모델·화자 변경은 경로가 비어도 수정 전으로 구분한다', () => {
  const settings = { speed: 1, pitch: 0, emotion: '자연스럽게', reference: 'auto' as const, start: 0, end: 0 }
  const voice = { kind: 'builtin' as const, label: '기본 목소리', engineId: 'piper', modelId: 'A', speakerId: '0' }
  const snap = { text: '같은 대사', sourcePath: '', settings, applied: cardApplied(settings), voice }
  const now = { text: snap.text, sourcePath: '', settings, voice: { ...voice } }
  assert.equal(takeIsStale(snap, now), false)
  assert.equal(takeIsStale(snap, { ...now, voice: { ...voice, modelId: 'B' } }), true)
  assert.equal(takeIsStale(snap, { ...now, voice: { ...voice, speakerId: '1' } }), true)
  assert.equal(takeIsStale(snap, { ...now, voice: { ...voice, engineId: 'other' } }), true)
  assert.equal(takeIsStale(snap, { ...now, voice: { ...voice, label: '이름만 변경' } }), false)
  assert.equal(takeIsStale({ ...snap, voice: undefined }, now), false)
})

// ── 기록 없음 vs 자동 (2026-09-27 지시) ─────────────────────────────────
//
// 카드의 `reference: 'auto'` 는 **다음 생성**에 쓸 설정이다.
// 그것을 옛 생성본에 옮겨 적으면 '그때 자동 구간을 썼다' 는 하지 않은 기록이 된다.
test('기록이 없는 생성본은 수정 전도 지금 것도 아니다', () => {
  const settings = { speed: 1, pitch: 0, emotion: '자연스럽게', reference: 'auto' as const, start: 0, end: 0 }
  const now = { text: '지금 대사', sourcePath: 'E:/a.wav', settings }
  // 값이 모두 같아도 '지금 것' 이라고 말하지 않는다 — 비교할 기록이 없다.
  assert.equal(takeMark({
    text: '지금 대사', sourcePath: 'E:/a.wav', settings, applied: cardApplied(settings),
    settingsUnknown: true,
  }, now), 'unknown')
  // 표시 없이 같은 값이면 '지금 것'
  assert.equal(takeMark({
    text: '지금 대사', sourcePath: 'E:/a.wav', settings, applied: cardApplied(settings),
  }, now), 'same')
  // 다르면 '수정 전'
  assert.equal(takeMark({
    text: '옛 대사', sourcePath: 'E:/a.wav', settings, applied: cardApplied(settings),
  }, now), 'stale')
})

// ★감정 표시 = 실제 요청(2026-10-03 관리자 검수). 보내는 판정(cardScriptWithEmotion)과 '미적용' 표시가 같은 근거여야 한다.
test('감정 — 실제로 보내는 목소리에는 미적용 표시가 없고, 안 보내는 목소리에는 있다', async () => {
  const { cardScriptWithEmotion } = await import('./synthesisCardVoice.ts')
  const qwen = { kind: 'builtin' as const, voice: { engineId: 'qwen-custom', modelId: 'sohee', label: 'Qwen 소희', language: 'ko', path: '/m/config.json', sampleRate: 24000, emotion: true } }
  const qwenNoEmo = { ...qwen, voice: { ...qwen.voice, emotion: false } }
  const supertonic = { kind: 'builtin' as const, voice: { engineId: 'supertonic', modelId: 'F1', label: '여성 1', language: 'ko', path: '/m/F1.json', sampleRate: 44100 } }
  const ref = { kind: 'reference' as const, source: { path: 'E:/a.wav', name: 'a.wav', duration: 5 } }
  const s = { ...base, emotion: '기쁨' }
  for (const [name, v, sent] of [['Qwen+1.7B', qwen, true], ['Qwen 1.7B 없음', qwenNoEmo, false], ['Supertonic', supertonic, false], ['참조', ref, false]] as const) {
    const script = cardScriptWithEmotion('안녕하세요.', s.emotion, v as never)
    const tagged = script.startsWith('[기쁨]')
    const noted = cardApplied(s, v as never).notes.some((n) => n.field === 'emotion')
    assert.equal(tagged, sent, `${name}: 요청에 감정이 ${sent ? '실려야' : '없어야'} 한다`)
    assert.equal(noted, !sent, `${name}: 요청 ${tagged ? '보냄' : '안 보냄'} — '미적용' 표시는 ${tagged ? '없어야' : '있어야'} 한다`)
  }
  // 목록에 없는 옛 감정 값은 보내지 않는다 — 받는 목소리라도 미적용으로 말한다.
  assert.ok(cardApplied({ ...base, emotion: '옛감정' }, qwen as never).notes.some((n) => n.field === 'emotion'))
})
