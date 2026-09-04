// 화자 참조 판정 — Python 권위와 같은 답을 내는지.
//
// 화면이 "준비됨" 이라고 했는데 생성이 막히거나, 화면은 막힌다는데 생성이 되는 것이 가장
// 나쁘다. `speakerReference.parity.json` 은 Python `speaker_refs.py` 로 구운 값이고,
// 같은 fixture 를 `python/test_speaker_refs_parity.py` 가 반대 방향으로 검사한다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  readinessFromSlots, multiSpeakerPreflight, speakerPreflightMessage, SPEAKER_PREFLIGHT_MESSAGE,
  REFERENCE_SOURCES, SPEAKER_REFERENCE_FAILURES, blockedDecisions,
  resolveReferenceDecision, sharedReferenceGroups, speakerEmotionKey,
} from './speakerReference.ts'
import type { ReferenceReadiness } from './speakerReference.ts'

const FX = JSON.parse(readFileSync(
  fileURLToPath(new URL('./speakerReference.parity.json', import.meta.url)), 'utf-8')) as {
    cases: {
      setup: string
      speakerId: string | null
      emotionId: string | null
      readiness: ReferenceReadiness
      expected: { ok: boolean; source?: string; code?: string }
    }[]
  }

test('Python 권위와 같은 판정을 낸다', () => {
  assert.ok(FX.cases.length >= 40, `fixture 가 너무 작다: ${FX.cases.length}`)
  const bad: string[] = []
  for (const c of FX.cases) {
    const got = resolveReferenceDecision(c.speakerId, c.emotionId, c.readiness)
    const same = got.ok === c.expected.ok
      && (got.ok ? got.source === c.expected.source : got.code === c.expected.code)
    if (!same) {
      bad.push(`${c.setup} speaker=${c.speakerId} emotion=${c.emotionId} `
        + `got=${JSON.stringify(got)} want=${JSON.stringify(c.expected)}`)
    }
  }
  assert.deepEqual(bad, [], `화면 판정과 생성 판정이 갈라졌다:\n${bad.join('\n')}`)
})

test('fixture 가 네 규칙과 세 차단 사유를 모두 지난다', () => {
  const sources = new Set<string>()
  const codes = new Set<string>()
  for (const c of FX.cases) {
    if (c.expected.ok) sources.add(c.expected.source as string)
    else codes.add(c.expected.code as string)
  }
  assert.deepEqual([...sources].sort(), [...REFERENCE_SOURCES].sort())
  assert.deepEqual([...codes].sort(), [...SPEAKER_REFERENCE_FAILURES].sort())
})

const readiness = (over: Partial<ReferenceReadiness> = {}): ReferenceReadiness => ({
  defaultReady: true,
  registeredSpeakers: [],
  speakerReady: {},
  speakerEmotionReady: {},
  emotionReady: {},
  ...over,
})

test('지정한 인물의 말에 감정 참조를 쓰지 않는다', () => {
  // 감정 참조는 다른 사람 목소리일 수 있다 — 내려가면 고르지 않은 인물이 말하게 된다.
  const r = readiness({
    registeredSpeakers: ['minsu'], emotionReady: { happy: true },
  })
  assert.deepEqual(resolveReferenceDecision('minsu', 'happy', r),
    { ok: false, code: 'SPEAKER_REFERENCE_NOT_READY' })
  // 같은 상태에서 화자 없는 발화는 감정 참조를 쓴다(기존 대본 동작).
  assert.deepEqual(resolveReferenceDecision(null, 'happy', r), { ok: true, source: 'emotion' })
})

test('등록하지 않은 화자와 준비되지 않은 화자를 다르게 말한다', () => {
  const r = readiness({ registeredSpeakers: ['minsu'] })
  assert.deepEqual(resolveReferenceDecision('minsu', null, r),
    { ok: false, code: 'SPEAKER_REFERENCE_NOT_READY' }, '등록됐지만 파일이 없다')
  assert.deepEqual(resolveReferenceDecision('younghee', null, r),
    { ok: false, code: 'SPEAKER_NOT_REGISTERED' }, '등록 자체가 없다')
})

test('우선순위대로 고른다', () => {
  const r = readiness({
    registeredSpeakers: ['minsu'],
    speakerReady: { minsu: true },
    speakerEmotionReady: { [speakerEmotionKey('minsu', 'happy')]: true },
    emotionReady: { happy: true },
  })
  assert.deepEqual(resolveReferenceDecision('minsu', 'happy', r),
    { ok: true, source: 'speaker_emotion' })
  assert.deepEqual(resolveReferenceDecision('minsu', 'sad', r), { ok: true, source: 'speaker' })
  assert.deepEqual(resolveReferenceDecision(null, 'happy', r), { ok: true, source: 'emotion' })
  assert.deepEqual(resolveReferenceDecision(null, 'sad', r), { ok: true, source: 'default' })
})

test('막히는 발화를 미리 모은다 — 중복은 한 번만', () => {
  const r = readiness({ registeredSpeakers: ['minsu'], speakerReady: { minsu: true } })
  const blocked = blockedDecisions([
    { speakerId: 'minsu', emotionId: null },
    { speakerId: 'younghee', emotionId: null },
    { speakerId: 'younghee', emotionId: null },
    { speakerId: 'younghee', emotionId: 'happy' },
  ], r)
  assert.deepEqual(blocked.map((b) => [b.speakerId, b.emotionId, b.code]), [
    ['younghee', null, 'SPEAKER_NOT_REGISTERED'],
    ['younghee', 'happy', 'SPEAKER_NOT_REGISTERED'],
  ])
  assert.deepEqual(blockedDecisions([{ speakerId: null, emotionId: null }], r), [],
    '기존 대본은 막히지 않는다')
})

test('같은 파일을 여러 화자에게 쓰면 묶어서 알려 준다', () => {
  const groups = sharedReferenceGroups({ minsu: 'sha-a', younghee: 'sha-a', chulsoo: 'sha-b' })
  assert.deepEqual(groups, { 'sha-a': ['minsu', 'younghee'] })
  assert.deepEqual(sharedReferenceGroups({ minsu: 'sha-a' }), {}, '혼자면 중복이 아니다')
  assert.deepEqual(sharedReferenceGroups({ minsu: '', younghee: '' }), {},
    '준비되지 않은 화자는 묶지 않는다')
})

test('경로를 다루지 않는다', () => {
  // 이 모듈이 아는 것은 준비 여부뿐이다 — 내부 경로가 화면 코드로 흘러갈 통로가 없다.
  const src = readFileSync(fileURLToPath(new URL('./speakerReference.ts', import.meta.url)), 'utf-8')
  const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  // `source` 는 "어느 규칙이 쓰였나" 라는 뜻이고 파일이 아니다 — 실제 경로 개념만 본다.
  for (const forbidden of ['filePath', 'readFile', 'dirname', 'basename', '.wav', 'clipPath']) {
    assert.equal(code.includes(forbidden), false, `경로/파일 개념이 들어왔다: ${forbidden}`)
  }
})

// ── 준비 판정 단일 파생 + 여러 명 preflight ──────────────────────────────────

test('readinessFromSlots: 카드·config·preflight 가 같은 표를 본다', () => {
  const r = readinessFromSlots({
    defaultReady: true,
    speakerSlots: { a: { ready: true }, b: { ready: false } },
    emotionSlots: { happy: { ready: true } },
    speakerEmotionRefs: { ['a' + String.fromCharCode(31) + 'happy']: 'C:/x.wav', ['b' + String.fromCharCode(31) + 'sad']: '' },
  })
  assert.deepEqual(r.registeredSpeakers, ['a', 'b'])
  assert.deepEqual(r.speakerReady, { a: true, b: false })
  assert.deepEqual(Object.keys(r.speakerEmotionReady), ['a' + String.fromCharCode(31) + 'happy'])
  assert.deepEqual(r.emotionReady, { happy: true })
})

test('multiSpeakerPreflight: 미등록·미준비 인물은 첫 발화 번호와 함께 막히고, 준비된 인물·기본 인물은 통과', () => {
  const r = readinessFromSlots({ defaultReady: true, speakerSlots: { a: { ready: true }, b: { ready: false } }, emotionSlots: {}, speakerEmotionRefs: {} })
  const segs = [
    { speakerId: 'a', emotionId: null }, { speakerId: null, emotionId: 'happy' },
    { speakerId: 'b', emotionId: null }, { speakerId: 'zed', emotionId: 'sad' }, { speakerId: 'b', emotionId: 'sad' },
  ]
  const blocks = multiSpeakerPreflight(segs, r)
  assert.deepEqual(blocks, [
    { speakerId: 'b', code: 'SPEAKER_REFERENCE_NOT_READY', firstSegmentIndex: 2 },
    { speakerId: 'zed', code: 'SPEAKER_NOT_REGISTERED', firstSegmentIndex: 3 },
  ])
  // 전부 준비되면 비어 있다 — 다른 인물·전역 기본으로 대체하는 경로가 없다.
  const ok = readinessFromSlots({ defaultReady: true, speakerSlots: { a: { ready: true }, b: { ready: true }, zed: { ready: true } }, emotionSlots: {}, speakerEmotionRefs: {} })
  assert.deepEqual(multiSpeakerPreflight(segs, ok), [])
  // 기본 참조가 없어도 명시 화자 판정은 그것에 기대지 않는다(기본 인물 발화만 막힌다: 별도 코드).
  const noDefault = readinessFromSlots({ defaultReady: false, speakerSlots: { a: { ready: true } }, emotionSlots: {}, speakerEmotionRefs: {} })
  assert.deepEqual(multiSpeakerPreflight([{ speakerId: 'a', emotionId: null }], noDefault), [])
})

test('speakerPreflightMessage: 내부 코드 없이 인물 카드 위치를 말한다', () => {
  const m = speakerPreflightMessage([{ speakerId: 'b', code: 'SPEAKER_NOT_REGISTERED', firstSegmentIndex: 2 }], (id) => (id === 'b' ? '영희' : id))
  assert.equal(m, SPEAKER_PREFLIGHT_MESSAGE.SPEAKER_NOT_REGISTERED + ' (3번 대사: 영희)')
  assert.equal(/SPEAKER_|reference|clip|SHA/.test(m), false)
  assert.equal(speakerPreflightMessage([], () => ''), '')
})
