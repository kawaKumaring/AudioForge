// 인물별·감정별 후보 등록 구조의 불변식.
//
// 이 구조가 위험해지는 지점은 전부 "조용히 다른 것이 되는" 경우다.
//   · 한 인물의 후보가 다른 인물에게 쓰인다
//   · 고른 후보가 사라졌는데 다른 후보로 바뀐다
//   · 자동 제안이 사람의 선택을 덮는다
//   · 후보 하나를 지웠더니 남이 쓰는 파생 클립이 같이 지워진다
//   · 전역 감정 참조가 이름 있는 화자에게 슬며시 상속된다
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CANDIDATE_MAX_SEC, CANDIDATE_MIN_SEC, EMPTY_REGISTRY,
  autoRecommendable, candidatesFor, clipRefCount, effectivePathOf, evaluateLifecycle,
  makeCandidateId, pruneSelections, registerCandidate, removeCandidate, resolveSlot,
  selectionRecordFor, slotKey, toSpeakerEmotionRefs,
} from './emotionCandidateRegistry.ts'
import type {
  CandidateRegistry, EmotionCandidateRecord,
} from './emotionCandidateRegistry.ts'
import {
  USER_CHOICE_NO_EMOTION_REF, USER_CHOICE_SPEAKER_DEFAULT,
} from './emotionCandidateRegistry.ts'
import {
  USER_CHOICE_NO_EMOTION_REF as MIRROR_NONE,
  USER_CHOICE_SPEAKER_DEFAULT as MIRROR_DEFAULT,
} from './speakerReference.ts'

test('두 모듈의 사용자 선택 토큰이 같다 — 도구 제약으로 두 벌 있으나 값은 하나다', () => {
  assert.equal(USER_CHOICE_SPEAKER_DEFAULT, MIRROR_DEFAULT)
  assert.equal(USER_CHOICE_NO_EMOTION_REF, MIRROR_NONE)
})

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)

function rec(over: Partial<EmotionCandidateRecord> = {}): EmotionCandidateRecord {
  const region = over.region ?? null
  const sha = over.sourceSha256 ?? SHA_A
  return {
    candidateId: over.candidateId ?? makeCandidateId(sha, region),
    speakerId: 'minsu', emotionId: 'joy',
    sourcePath: 'C:/refs/민수_밝게.wav', sourceSha256: sha,
    sourceDurationSec: 5.0, sourceFormat: 'wav', region,
    effectiveClipId: null, profileId: null,
    qualityState: 'ok', qualityCodes: [], sourceKind: 'clean_speech',
    autoRecommendable: true, lifecycle: 'ready', lifecycleCode: null,
    ...over,
  }
}

function withRecords(...records: EmotionCandidateRecord[]): CandidateRegistry {
  return records.reduce(registerCandidate, EMPTY_REGISTRY)
}

// ── id ─────────────────────────────────────────────────────────────────────

test('후보 id 는 내용과 구간에서만 나온다 — 이름이 새지 않는다', () => {
  const whole = makeCandidateId(SHA_A, null)
  const cut = makeCandidateId(SHA_A, { start: 1.25, duration: 4.5 })
  assert.notEqual(whole, cut, '구간이 다르면 다른 후보다')
  assert.equal(makeCandidateId(SHA_A, null), whole, '같은 입력이면 같은 id')
  // 부동소수 표기 차이로 id 가 흔들리지 않는다.
  assert.equal(makeCandidateId(SHA_A, { start: 1.2500001, duration: 4.5 }), cut)
  for (const leak of ['민수', 'minsu', 'joy', '.wav', 'C:/']) {
    assert.equal(whole.includes(leak), false, leak)
    assert.equal(cut.includes(leak), false, leak)
  }
  assert.match(whole, /^cand_[0-9a-f]{12}_w$/)
})

test('같은 파일의 같은 구간은 어느 인물에게 등록해도 같은 id — 클립을 공유한다', () => {
  const a = rec({ speakerId: 'minsu', effectiveClipId: 'clip_1',
    region: { start: 0, duration: 4 } })
  const b = rec({ speakerId: 'jieun', emotionId: 'sad', effectiveClipId: 'clip_1',
    region: { start: 0, duration: 4 } })
  assert.equal(a.candidateId, b.candidateId)
  assert.equal(clipRefCount(withRecords(a, b), 'clip_1'), 2)
})

// ── 격리 ───────────────────────────────────────────────────────────────────

test('후보는 그 인물 그 감정의 것만 조회된다', () => {
  const reg = withRecords(
    rec({ speakerId: 'minsu', emotionId: 'joy', sourceSha256: SHA_A }),
    rec({ speakerId: 'minsu', emotionId: 'sad', sourceSha256: SHA_B }),
    rec({ speakerId: 'jieun', emotionId: 'joy', sourceSha256: SHA_C }),
  )
  assert.equal(candidatesFor(reg, 'minsu', 'joy').length, 1)
  assert.equal(candidatesFor(reg, 'minsu', 'joy')[0].sourceSha256, SHA_A)
  assert.equal(candidatesFor(reg, 'jieun', 'joy')[0].sourceSha256, SHA_C)
  assert.equal(candidatesFor(reg, 'nobody', 'joy').length, 0)
})

test('한 후보를 지워도 다른 인물·감정의 후보와 선택은 그대로다', () => {
  const mine = rec({ speakerId: 'minsu', emotionId: 'joy', sourceSha256: SHA_A })
  const other = rec({ speakerId: 'jieun', emotionId: 'joy', sourceSha256: SHA_B })
  const another = rec({ speakerId: 'minsu', emotionId: 'sad', sourceSha256: SHA_C })
  const reg = withRecords(mine, other, another)
  const selections = {
    [slotKey('minsu', 'joy')]: mine.candidateId,
    [slotKey('jieun', 'joy')]: other.candidateId,
    [slotKey('minsu', 'sad')]: another.candidateId,
  }
  const { registry: next } = removeCandidate(reg, 'minsu', 'joy', mine.candidateId)
  assert.equal(candidatesFor(next, 'minsu', 'joy').length, 0)
  assert.equal(candidatesFor(next, 'jieun', 'joy').length, 1)
  assert.equal(candidatesFor(next, 'minsu', 'sad').length, 1)
  const pruned = pruneSelections(next, selections)
  // 지운 슬롯의 선택만 사라지고 나머지는 남는다.
  assert.equal(pruned[slotKey('minsu', 'joy')], undefined)
  assert.equal(pruned[slotKey('jieun', 'joy')], other.candidateId)
  assert.equal(pruned[slotKey('minsu', 'sad')], another.candidateId)
})

test('공유 중인 파생 클립은 한 후보를 지워도 지우지 않는다', () => {
  const a = rec({ speakerId: 'minsu', emotionId: 'joy', effectiveClipId: 'clip_1',
    region: { start: 0, duration: 4 } })
  const b = rec({ speakerId: 'jieun', emotionId: 'sad', effectiveClipId: 'clip_1',
    region: { start: 0, duration: 4 } })
  const reg = withRecords(a, b)
  const first = removeCandidate(reg, 'minsu', 'joy', a.candidateId)
  assert.deepEqual(first.releasableClipIds, [], '남이 쓰는 클립을 지우면 그 후보가 죽는다')
  const second = removeCandidate(first.registry, 'jieun', 'sad', b.candidateId)
  assert.deepEqual(second.releasableClipIds, ['clip_1'], '마지막 사용자가 사라지면 놓아 준다')
})

test('후보 해제는 원본 파일을 지우는 일이 아니다', () => {
  const only = rec({ effectiveClipId: null })
  const { registry: next, releasableClipIds } = removeCandidate(
    withRecords(only), 'minsu', 'joy', only.candidateId)
  assert.equal(next.records.length, 0)
  // 놓아 줄 파생 클립도 없고, 원본 경로에 대해 아무 지시도 내지 않는다.
  assert.deepEqual(releasableClipIds, [])
})

// ── 수명 ───────────────────────────────────────────────────────────────────

test('10초를 넘는 원본은 구간 확정이 필요하다', () => {
  const got = evaluateLifecycle(
    { sourceDurationSec: 42.0, region: null, effectiveClipId: null, qualityState: 'ok' },
    { sourcePresent: true, clipPresent: false })
  assert.deepEqual(got, { lifecycle: 'needs_region', lifecycleCode: 'SOURCE_TOO_LONG' })
})

test('3~10초 원본은 그대로 쓸 수 있다 — 파생 클립을 강제로 만들지 않는다', () => {
  for (const sec of [CANDIDATE_MIN_SEC, 6.0, CANDIDATE_MAX_SEC]) {
    const got = evaluateLifecycle(
      { sourceDurationSec: sec, region: null, effectiveClipId: null, qualityState: 'ok' },
      { sourcePresent: true, clipPresent: false })
    assert.equal(got.lifecycle, 'ready', String(sec))
  }
})

test('원본이 사라지면 만료다 — 다른 후보로 바꿔 주지 않는다', () => {
  const got = evaluateLifecycle(
    { sourceDurationSec: 5, region: null, effectiveClipId: null, qualityState: 'ok' },
    { sourcePresent: false, clipPresent: true })
  assert.deepEqual(got, { lifecycle: 'expired', lifecycleCode: 'SOURCE_FILE_MISSING' })
})

test('구간을 확정했는데 파생 클립이 없으면 다시 만들어야 한다', () => {
  const got = evaluateLifecycle(
    { sourceDurationSec: 42, region: { start: 3, duration: 5 },
      effectiveClipId: 'clip_1', qualityState: 'ok' },
    { sourcePresent: true, clipPresent: false })
  // 임시 경로만 남은 상태를 '복원됨'으로 가장하지 않는다.
  assert.deepEqual(got, { lifecycle: 'needs_region', lifecycleCode: 'DERIVED_CLIP_MISSING' })
})

test('참조로 쓸 수 없는 파일은 오류로 남는다', () => {
  assert.equal(evaluateLifecycle(
    { sourceDurationSec: 5, region: null, effectiveClipId: null, qualityState: 'invalid' },
    { sourcePresent: true, clipPresent: true }).lifecycle, 'error')
  assert.equal(evaluateLifecycle(
    { sourceDurationSec: 1.2, region: null, effectiveClipId: null, qualityState: 'ok' },
    { sourcePresent: true, clipPresent: true }).lifecycleCode, 'SOURCE_TOO_SHORT')
})

test('합성 경로는 준비된 후보에서만 나온다', () => {
  const clipOf = (id: string) => (id === 'clip_1' ? 'C:/tmp/clip.wav' : undefined)
  assert.equal(effectivePathOf(rec(), clipOf), 'C:/refs/민수_밝게.wav')
  assert.equal(effectivePathOf(
    rec({ region: { start: 0, duration: 4 }, effectiveClipId: 'clip_1' }), clipOf),
    'C:/tmp/clip.wav')
  assert.equal(effectivePathOf(rec({ lifecycle: 'expired' }), clipOf), '',
    '만료 후보가 경로를 내면 조용히 합성된다')
})

// ── 추천과 선택 ─────────────────────────────────────────────────────────────

test('음악 분리 음원과 품질 부적합은 자동 추천 대상이 아니다', () => {
  assert.equal(autoRecommendable('separated_stem', 'ok'), false)
  assert.equal(autoRecommendable('clean_speech', 'invalid'), false)
  assert.equal(autoRecommendable('clean_speech', 'ok'), true)
  assert.equal(autoRecommendable('unknown', 'warning'), true)
})

test('후보가 하나뿐이면 추천이 성립하지 않는다', () => {
  const only = rec()
  const reg = withRecords(only)
  const res = resolveSlot(reg, 'minsu', 'joy', {},
    { [slotKey('minsu', 'joy')]: only.candidateId })
  assert.equal(res.insufficientCandidates, true)
  assert.equal(res.candidateId, null, '고를 여지가 없는 것을 자동으로 쓰지 않는다')
  assert.equal(res.reason, null)
})

test('후보가 여럿이면 제안이 쓰인다', () => {
  const a = rec({ sourceSha256: SHA_A })
  const b = rec({ sourceSha256: SHA_B })
  const reg = withRecords(a, b)
  const res = resolveSlot(reg, 'minsu', 'joy', {},
    { [slotKey('minsu', 'joy')]: b.candidateId })
  assert.equal(res.candidateId, b.candidateId)
  assert.equal(res.reason, 'AUTO_PROVISIONAL_RECOMMENDATION')
  assert.equal(res.insufficientCandidates, false)
})

test('수동 선택이 제안보다 우선한다', () => {
  const a = rec({ sourceSha256: SHA_A })
  const b = rec({ sourceSha256: SHA_B })
  const reg = withRecords(a, b)
  const key = slotKey('minsu', 'joy')
  const res = resolveSlot(reg, 'minsu', 'joy', { [key]: a.candidateId },
    { [key]: b.candidateId })
  assert.equal(res.candidateId, a.candidateId)
  assert.equal(res.reason, 'USER_CHANGED_CANDIDATE')
  assert.equal(res.recommended, b.candidateId, '제안이 무엇이었는지도 함께 남는다')
})

test('제안을 그대로 고른 것과 바꾼 것을 구분한다', () => {
  const a = rec({ sourceSha256: SHA_A })
  const b = rec({ sourceSha256: SHA_B })
  const reg = withRecords(a, b)
  const key = slotKey('minsu', 'joy')
  assert.equal(resolveSlot(reg, 'minsu', 'joy', { [key]: b.candidateId },
    { [key]: b.candidateId }).reason, 'USER_KEPT_RECOMMENDATION')
})

test('기본 목소리로 돌아가기와 감정 참조 안 쓰기는 다른 사유다', () => {
  const reg = withRecords(rec({ sourceSha256: SHA_A }), rec({ sourceSha256: SHA_B }))
  const key = slotKey('minsu', 'joy')
  const back = resolveSlot(reg, 'minsu', 'joy', { [key]: USER_CHOICE_SPEAKER_DEFAULT }, {})
  const none = resolveSlot(reg, 'minsu', 'joy', { [key]: USER_CHOICE_NO_EMOTION_REF }, {})
  assert.equal(back.reason, 'USER_CHOSE_SPEAKER_DEFAULT')
  assert.equal(none.reason, 'USER_DECLINED_EMOTION_REFERENCE')
  // 둘 다 감정 후보를 쓰지 않는다 — 기본 화자 참조와 감정 후보를 같은 것으로 보지 않는다.
  assert.equal(back.candidateId, null)
  assert.equal(none.candidateId, null)
})

test('고른 후보가 준비되지 않으면 막는다 — 다른 후보로 넘어가지 않는다', () => {
  const broken = rec({ sourceSha256: SHA_A, lifecycle: 'expired',
    lifecycleCode: 'SOURCE_FILE_MISSING' })
  const fine = rec({ sourceSha256: SHA_B })
  const reg = withRecords(broken, fine)
  const key = slotKey('minsu', 'joy')
  const res = resolveSlot(reg, 'minsu', 'joy', { [key]: broken.candidateId },
    { [key]: fine.candidateId })
  assert.equal(res.candidateId, null)
  assert.equal(res.blockedCode, 'SOURCE_FILE_MISSING')
})

test('고른 후보가 이 슬롯에 없으면 남의 후보로 대체하지 않는다', () => {
  const mine = rec({ speakerId: 'minsu', sourceSha256: SHA_A })
  const foreign = rec({ speakerId: 'jieun', sourceSha256: SHA_B })
  const reg = withRecords(mine, foreign)
  const key = slotKey('minsu', 'joy')
  const res = resolveSlot(reg, 'minsu', 'joy', { [key]: foreign.candidateId }, {})
  assert.equal(res.candidateId, null)
  assert.equal(res.reason, 'USER_SELECTION_NOT_A_CANDIDATE')
})

test('추천이 자동 추천 대상이 아니면 쓰이지 않는다', () => {
  const stem = rec({ sourceSha256: SHA_A, sourceKind: 'separated_stem',
    autoRecommendable: false })
  const other = rec({ sourceSha256: SHA_B })
  const reg = withRecords(stem, other)
  const key = slotKey('minsu', 'joy')
  const res = resolveSlot(reg, 'minsu', 'joy', {}, { [key]: stem.candidateId })
  assert.equal(res.candidateId, null, 'stem 이 자동으로 쓰이면 안 된다')
  // 사용자가 직접 고르는 것은 막지 않는다.
  assert.equal(resolveSlot(reg, 'minsu', 'joy', { [key]: stem.candidateId }, {}).candidateId,
    stem.candidateId)
})

// ── 생성으로 나가는 것 ──────────────────────────────────────────────────────

test('생성기에는 슬롯마다 고른 하나만 간다 — 후보 목록은 가지 않는다', () => {
  const a = rec({ sourceSha256: SHA_A, sourcePath: 'C:/refs/a.wav' })
  const b = rec({ sourceSha256: SHA_B, sourcePath: 'C:/refs/b.wav' })
  const sadOnly = rec({ emotionId: 'sad', sourceSha256: SHA_C, sourcePath: 'C:/refs/c.wav' })
  const reg = withRecords(a, b, sadOnly)
  const refs = toSpeakerEmotionRefs(reg,
    { [slotKey('minsu', 'joy')]: b.candidateId }, {}, () => undefined)
  assert.deepEqual(Object.keys(refs), [slotKey('minsu', 'joy')])
  assert.equal(refs[slotKey('minsu', 'joy')], 'C:/refs/b.wav')
  // 후보가 하나뿐인 슬롯은 사용자가 고르지 않았으면 나가지 않는다.
  assert.equal(refs[slotKey('minsu', 'sad')], undefined)
})

test('전역 감정 참조가 이름 있는 화자에게 상속되지 않는다', () => {
  // 등록부는 (화자, 감정) 키만 만든다 — 화자 없는 전역 감정 참조 키는 나오지 않는다.
  const reg = withRecords(rec({ sourceSha256: SHA_A }), rec({ sourceSha256: SHA_B }))
  const refs = toSpeakerEmotionRefs(reg,
    { [slotKey('minsu', 'joy')]: makeCandidateId(SHA_B, null) }, {}, () => undefined)
  for (const key of Object.keys(refs)) {
    assert.ok(key.startsWith('minsu'), `화자 없는 키가 생겼다: ${JSON.stringify(key)}`)
  }
})

test('기록에는 요청·제안·선택·결과가 서로 다른 필드로 남는다', () => {
  const a = rec({ sourceSha256: SHA_A })
  const b = rec({ sourceSha256: SHA_B })
  const reg = withRecords(a, b)
  const key = slotKey('minsu', 'joy')
  const out = selectionRecordFor(reg, 'minsu', 'joy',
    { [key]: a.candidateId }, { [key]: b.candidateId })
  assert.equal(out.requestedEmotion, 'joy')
  assert.equal(out.recommendedCandidate, b.candidateId)
  assert.equal(out.userSelectedCandidate, a.candidateId)
  assert.equal(out.resolvedCandidate, a.candidateId)
  assert.equal(out.selectionReason, 'USER_CHANGED_CANDIDATE')
  assert.equal(out.candidateCount, 2)
  assert.equal(out.insufficientCandidates, false)
})

test('기록에 경로도 표시 이름도 담기지 않는다', () => {
  const a = rec({ sourceSha256: SHA_A })
  const reg = withRecords(a, rec({ sourceSha256: SHA_B }))
  const key = slotKey('minsu', 'joy')
  const blob = JSON.stringify(selectionRecordFor(reg, 'minsu', 'joy',
    { [key]: a.candidateId }, {}))
  for (const leak of ['민수', '.wav', 'C:/', 'refs']) {
    assert.equal(blob.includes(leak), false, leak)
  }
})

test('등록은 같은 슬롯의 같은 후보만 덮어쓴다', () => {
  const first = rec({ sourceSha256: SHA_A, profileId: null })
  const reg = withRecords(first)
  const updated = { ...first, profileId: 'ep3_abc' }
  const next = registerCandidate(reg, updated)
  assert.equal(next.records.length, 1)
  assert.equal(candidatesFor(next, 'minsu', 'joy')[0].profileId, 'ep3_abc')
  // 같은 파일을 다른 감정에 등록하면 별개 후보다.
  const otherEmotion = registerCandidate(next, { ...first, emotionId: 'sad' })
  assert.equal(otherEmotion.records.length, 2)
})
