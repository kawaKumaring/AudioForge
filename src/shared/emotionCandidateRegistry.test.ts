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
  ASSET_STORAGE_SCHEMA_VERSION, CANDIDATE_MAX_SEC, CANDIDATE_MIN_SEC, EMPTY_REGISTRY,
  GLOBAL_ASSET_STORAGE_KEY, NEUTRAL_EMOTION_ID,
  assetOf, assetRefCount, autoRecommendable, bindingOf, candidatesFor,
  deserializeAssetStore, effectivePathOf, evaluateLifecycle, holdsOnlyEmotionCandidates,
  makeAssetId, makeCandidateId, payloadHasNoScopeData, pruneSelections, regionFromSeconds,
  registerCandidate, removeCandidate, resolveSlot, scopedSlotKey, selectionRecordFor,
  serializeAssetStore, slotKey, toSpeakerEmotionRefs,
} from './emotionCandidateRegistry.ts'
// 해시는 주입받는다(공용 모듈끼리 값 import 금지 규약) — 테스트는 실제 sha256 을 넣는다.
import { samplerSha256Hex } from './emotionSampler.ts'
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

const H = samplerSha256Hex

function rec(over: Partial<EmotionCandidateRecord> = {}): EmotionCandidateRecord {
  const region = over.region ?? null
  const sha = over.sourceSha256 ?? SHA_A
  const speakerId = over.speakerId ?? 'minsu'
  const emotionId = over.emotionId ?? 'joy'
  const assetId = over.assetId ?? makeAssetId(sha, region)
  return {
    candidateId: over.candidateId ?? makeCandidateId(assetId, speakerId, emotionId, H),
    assetId,
    speakerId, emotionId,
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

test('자산 id 는 내용과 frame 좌표에서만 나온다 — 이름이 새지 않는다', () => {
  const whole = makeAssetId(SHA_A, null)
  const cut = makeAssetId(SHA_A, regionFromSeconds(1.25, 4.5, 48000))
  assert.notEqual(whole, cut)
  assert.equal(makeAssetId(SHA_A, null), whole, '같은 입력이면 같은 자산')
  for (const leak of ['민수', 'minsu', 'joy', '.wav', 'C:/']) {
    assert.equal(whole.includes(leak), false, leak)
    assert.equal(cut.includes(leak), false, leak)
  }
  assert.match(whole, /^asset_[0-9a-f]{16}_whole$/)
})

test('frame 이 다른 두 구간은 자산 id 가 다르다 — 1ms 안도 접히지 않는다', () => {
  // 48kHz 에서 1 frame 차이 = 약 0.021ms. 초 반올림 토큰이면 같은 id 로 접혔다.
  const a = regionFromSeconds(1.0, 4.0, 48000)
  const b = { ...a, endFrame: a.endFrame + 1 }
  assert.notEqual(makeAssetId(SHA_A, a), makeAssetId(SHA_A, b))
  // 표본율이 다르면 같은 초 좌표라도 다른 PCM 구간이다.
  assert.notEqual(makeAssetId(SHA_A, regionFromSeconds(1.0, 4.0, 44100)),
    makeAssetId(SHA_A, a))
  // 같은 (초, 표본율)은 항상 같은 frame — 결정적이다.
  assert.deepEqual(regionFromSeconds(1.0, 4.0, 48000), a)
  assert.equal(a.startFrame, 48000)
  assert.equal(a.endFrame, 240000)
  assert.throws(() => regionFromSeconds(1, 4, 0), /sampleRate/)
})

test('같은 자산을 두 화자에 등록하면 후보 id 가 다르다', () => {
  const region = regionFromSeconds(0, 4, 48000)
  const asset = makeAssetId(SHA_A, region)
  const a = rec({ speakerId: 'minsu', emotionId: 'joy', region, assetId: asset })
  const b = rec({ speakerId: 'jieun', emotionId: 'joy', region, assetId: asset })
  assert.equal(a.assetId, b.assetId, '물리 자산은 같다')
  assert.notEqual(a.candidateId, b.candidateId, '등록은 서로 다른 것이다')
})

test('같은 자산을 두 감정에 등록하면 후보 id 가 다르다', () => {
  const asset = makeAssetId(SHA_A, null)
  const joy = rec({ emotionId: 'joy', assetId: asset })
  const sad = rec({ emotionId: 'sad', assetId: asset })
  assert.equal(joy.assetId, sad.assetId)
  assert.notEqual(joy.candidateId, sad.candidateId)
})

test('같은 슬롯에 같은 자산을 다시 등록하면 중복이 생기지 않는다', () => {
  const asset = makeAssetId(SHA_A, null)
  const first = rec({ assetId: asset })
  const again = rec({ assetId: asset, profileId: 'ep3_new' })
  assert.equal(first.candidateId, again.candidateId, '같은 슬롯 같은 자산 = 같은 후보')
  const reg = withRecords(first, again)
  assert.equal(candidatesFor(reg, 'minsu', 'joy').length, 1)
  assert.equal(candidatesFor(reg, 'minsu', 'joy')[0].profileId, 'ep3_new')
})

test('후보 id 입력에 표시 이름과 경로가 들어가지 않는다', () => {
  const asset = makeAssetId(SHA_A, null)
  const id = makeCandidateId(asset, 'minsu', 'joy', H)
  assert.match(id, /^cand_[0-9a-f]{16}$/)
  for (const leak of ['minsu', 'joy', 'asset_', '.wav']) {
    assert.equal(id.includes(leak), false, leak)
  }
})

test('파생 클립 수명은 자산이 소유한다 — 후보 수로 세지 않는다', () => {
  const region = regionFromSeconds(0, 4, 48000)
  const asset = makeAssetId(SHA_A, region)
  const a = rec({ speakerId: 'minsu', emotionId: 'joy', region, assetId: asset,
    effectiveClipId: 'clip_1' })
  const b = rec({ speakerId: 'jieun', emotionId: 'sad', region, assetId: asset,
    effectiveClipId: 'clip_1' })
  const reg = withRecords(a, b)
  assert.equal(assetRefCount(reg, asset), 2)
  assert.notEqual(a.candidateId, b.candidateId)
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
  const { registry: next, selections: prunedByRemoval } =
    removeCandidate(reg, 'minsu', 'joy', mine.candidateId, selections)
  assert.equal(candidatesFor(next, 'minsu', 'joy').length, 0)
  assert.equal(candidatesFor(next, 'jieun', 'joy').length, 1)
  assert.equal(candidatesFor(next, 'minsu', 'sad').length, 1)
  const pruned = pruneSelections(next, selections)
  assert.deepEqual(pruned, prunedByRemoval, '삭제 전이가 같은 정리를 이미 해 두었다')
  // 지운 슬롯의 선택만 사라지고 나머지는 남는다.
  assert.equal(pruned[slotKey('minsu', 'joy')], undefined)
  assert.equal(pruned[slotKey('jieun', 'joy')], other.candidateId)
  assert.equal(pruned[slotKey('minsu', 'sad')], another.candidateId)
})

test('공유 자산의 파생 클립은 한 후보를 지워도 지우지 않는다', () => {
  const region = regionFromSeconds(0, 4, 48000)
  const asset = makeAssetId(SHA_A, region)
  const a = rec({ speakerId: 'minsu', emotionId: 'joy', region, assetId: asset,
    effectiveClipId: 'clip_1' })
  const b = rec({ speakerId: 'jieun', emotionId: 'sad', region, assetId: asset,
    effectiveClipId: 'clip_1' })
  const reg = withRecords(a, b)
  const first = removeCandidate(reg, 'minsu', 'joy', a.candidateId)
  assert.deepEqual(first.releasableClipIds, [], '남이 쓰는 클립을 지우면 그 후보가 죽는다')
  // 다른 후보는 그대로 살아 있다.
  assert.equal(candidatesFor(first.registry, 'jieun', 'sad').length, 1)
  const second = removeCandidate(first.registry, 'jieun', 'sad', b.candidateId)
  assert.deepEqual(second.releasableClipIds, ['clip_1'], '마지막 참조가 사라지면 놓아 준다')
})

test('선택된 후보를 지우면 같은 전이에서 선택이 풀리고 클립이 놓인다', () => {
  // 이전 판은 "선택이 아직 가리키면 클립을 붙잡는다" 였다. 그 상태가 곧 dangling
  // 선택이므로 지금은 만들지 않는다 — 삭제와 해제가 한 전이다.
  const region = regionFromSeconds(0, 4, 48000)
  const only = rec({ region, effectiveClipId: 'clip_1' })
  const reg = withRecords(only)
  const key = slotKey('minsu', 'joy')
  const out = removeCandidate(reg, 'minsu', 'joy', only.candidateId,
    { [key]: only.candidateId })
  assert.equal(out.selections[key], undefined, 'dangling 선택이 남았다')
  assert.deepEqual(out.releasableClipIds, ['clip_1'])
  // 선택이 없던 경우도 같다.
  const bare = removeCandidate(reg, 'minsu', 'joy', only.candidateId, {})
  assert.deepEqual(bare.releasableClipIds, ['clip_1'])
})

test('구간 없는 후보는 놓아 줄 파생 클립이 없다 — 사용자 원본은 대상이 아니다', () => {
  const whole = rec({ region: null, effectiveClipId: null })
  const out = removeCandidate(withRecords(whole), 'minsu', 'joy', whole.candidateId)
  assert.deepEqual(out.releasableClipIds, [])
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
    { sourceDurationSec: 42.0, region: null, effectiveClipId: null,
      qualityState: 'ok', sourceSha256: SHA_A },
    { sourcePresent: true, clipPresent: false })
  assert.deepEqual(got, { lifecycle: 'needs_region', lifecycleCode: 'SOURCE_TOO_LONG' })
})

test('3~10초 원본은 그대로 쓸 수 있다 — 파생 클립을 강제로 만들지 않는다', () => {
  for (const sec of [CANDIDATE_MIN_SEC, 6.0, CANDIDATE_MAX_SEC]) {
    const got = evaluateLifecycle(
      { sourceDurationSec: sec, region: null, effectiveClipId: null,
        qualityState: 'ok', sourceSha256: SHA_A },
      { sourcePresent: true, clipPresent: false })
    assert.equal(got.lifecycle, 'ready', String(sec))
  }
})

test('원본이 사라지면 만료다 — 다른 후보로 바꿔 주지 않는다', () => {
  const got = evaluateLifecycle(
    { sourceDurationSec: 5, region: null, effectiveClipId: null,
      qualityState: 'ok', sourceSha256: SHA_A },
    { sourcePresent: false, clipPresent: true })
  assert.deepEqual(got, { lifecycle: 'expired', lifecycleCode: 'SOURCE_FILE_MISSING' })
})

test('구간을 확정했는데 파생 클립이 없으면 다시 만들어야 한다', () => {
  const got = evaluateLifecycle(
    { sourceDurationSec: 42, region: regionFromSeconds(3, 5, 48000),
      effectiveClipId: 'clip_1', qualityState: 'ok', sourceSha256: SHA_A },
    { sourcePresent: true, clipPresent: false })
  // 임시 경로만 남은 상태를 '복원됨'으로 가장하지 않는다.
  assert.deepEqual(got, { lifecycle: 'needs_region', lifecycleCode: 'DERIVED_CLIP_MISSING' })
})

test('참조로 쓸 수 없는 파일은 오류로 남는다', () => {
  assert.equal(evaluateLifecycle(
    { sourceDurationSec: 5, region: null, effectiveClipId: null,
      qualityState: 'invalid', sourceSha256: SHA_A },
    { sourcePresent: true, clipPresent: true }).lifecycle, 'error')
  assert.equal(evaluateLifecycle(
    { sourceDurationSec: 1.2, region: null, effectiveClipId: null,
      qualityState: 'ok', sourceSha256: SHA_A },
    { sourcePresent: true, clipPresent: true }).lifecycleCode, 'SOURCE_TOO_SHORT')
})

test('내용이 바뀐 원본은 같은 자산으로 쓰지 않는다', () => {
  const got = evaluateLifecycle(
    { sourceDurationSec: 5, region: null, effectiveClipId: null,
      qualityState: 'ok', sourceSha256: SHA_A },
    { sourcePresent: true, clipPresent: true, currentSourceSha256: SHA_B })
  assert.deepEqual(got, { lifecycle: 'changed', lifecycleCode: 'SOURCE_SHA_MISMATCH' })
  // 모름을 같음으로 보지 않는다 — SHA 를 주지 않으면 그 검사를 건너뛴다.
  assert.equal(evaluateLifecycle(
    { sourceDurationSec: 5, region: null, effectiveClipId: null,
      qualityState: 'ok', sourceSha256: SHA_A },
    { sourcePresent: true, clipPresent: true }).lifecycle, 'ready')
})

test('내용이 바뀐 후보를 고른 상태면 합성이 막힌다', () => {
  const changed = rec({ sourceSha256: SHA_A, lifecycle: 'changed',
    lifecycleCode: 'SOURCE_SHA_MISMATCH' })
  const fine = rec({ sourceSha256: SHA_B })
  const reg = withRecords(changed, fine)
  const key = slotKey('minsu', 'joy')
  const res = resolveSlot(reg, 'minsu', 'joy', { [key]: changed.candidateId }, {})
  assert.equal(res.candidateId, null)
  assert.equal(res.blockedCode, 'SOURCE_SHA_MISMATCH')
})

test('합성 경로는 준비된 후보에서만 나온다', () => {
  const clipOf = (id: string) => (id === 'clip_1' ? 'C:/tmp/clip.wav' : undefined)
  assert.equal(effectivePathOf(rec(), clipOf), 'C:/refs/민수_밝게.wav')
  assert.equal(effectivePathOf(
    rec({ region: regionFromSeconds(0, 4, 48000), effectiveClipId: 'clip_1' }), clipOf),
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
  const b = rec({ sourceSha256: SHA_B })
  const reg = withRecords(rec({ sourceSha256: SHA_A }), b)
  const refs = toSpeakerEmotionRefs(reg,
    { [slotKey('minsu', 'joy')]: b.candidateId }, {}, () => undefined)
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

// ── 중립 후보와 화자 기본 목소리 ────────────────────────────────────────────

test('중립 후보와 화자 기본 목소리는 수명이 독립이다', () => {
  // 등록부에는 감정 후보만 들어온다 — 화자 기본 목소리는 다른 상태(ttsSpeakerRefState)가
  // 소유하므로, 중립 후보를 지워도 기본 목소리가 사라질 통로가 없다.
  const neutral = rec({ emotionId: NEUTRAL_EMOTION_ID, sourceSha256: SHA_A })
  const joy = rec({ emotionId: 'joy', sourceSha256: SHA_B })
  const reg = withRecords(neutral, joy)
  assert.ok(holdsOnlyEmotionCandidates(reg))
  const { registry: next, releasableClipIds } = removeCandidate(
    reg, 'minsu', NEUTRAL_EMOTION_ID, neutral.candidateId)
  assert.equal(candidatesFor(next, 'minsu', NEUTRAL_EMOTION_ID).length, 0)
  assert.equal(candidatesFor(next, 'minsu', 'joy').length, 1, '다른 감정은 그대로다')
  assert.deepEqual(releasableClipIds, [], '기본 목소리 파일에 손대지 않는다')
  // 생성으로 나가는 표에도 화자 기본 목소리 항목이 생기지 않는다.
  assert.deepEqual(Object.keys(toSpeakerEmotionRefs(next, {}, {}, () => undefined)), [])
})

test('기본 목소리로 돌아가기는 중립 후보를 쓰는 것과 다르다', () => {
  const neutral = rec({ emotionId: NEUTRAL_EMOTION_ID, sourceSha256: SHA_A })
  const other = rec({ emotionId: NEUTRAL_EMOTION_ID, sourceSha256: SHA_B })
  const reg = withRecords(neutral, other)
  const key = slotKey('minsu', NEUTRAL_EMOTION_ID)
  const back = resolveSlot(reg, 'minsu', NEUTRAL_EMOTION_ID,
    { [key]: USER_CHOICE_SPEAKER_DEFAULT }, {})
  assert.equal(back.candidateId, null, '기본 목소리는 이 등록부의 후보가 아니다')
  const chosen = resolveSlot(reg, 'minsu', NEUTRAL_EMOTION_ID,
    { [key]: neutral.candidateId }, {})
  assert.equal(chosen.candidateId, neutral.candidateId)
})

// ── 전역 자산 저장과 scope 바인딩 ──────────────────────────────────────────

test('전역 저장 payload 에 화자·감정·선택이 섞이지 않는다', () => {
  const a = rec({ sourceSha256: SHA_A })
  const b = rec({ emotionId: 'sad', sourceSha256: SHA_B })
  const payload = serializeAssetStore([assetOf(a), assetOf(b)])
  assert.equal(payload.schemaVersion, ASSET_STORAGE_SCHEMA_VERSION)
  assert.ok(payloadHasNoScopeData(payload), JSON.stringify(payload).slice(0, 200))
  assert.equal(GLOBAL_ASSET_STORAGE_KEY, 'referenceAssets')
})

test('프로젝트 X 의 민수와 프로젝트 Y 의 민수는 자동 공유되지 않는다', () => {
  const shared = rec({ speakerId: 'minsu', emotionId: 'joy', sourceSha256: SHA_A })
  const x = bindingOf(shared, 'scope-X')
  const y = bindingOf(shared, 'scope-Y')
  // 같은 자산을 가리켜도 연결은 서로 다른 것이다.
  assert.equal(x.assetId, y.assetId)
  assert.notEqual(scopedSlotKey('scope-X', 'minsu', 'joy'),
    scopedSlotKey('scope-Y', 'minsu', 'joy'))
  // 전역 자산 저장만으로는 어느 scope 의 민수인지 알 수 없다 — 그래서 공유가 일어나지 않는다.
  const payload = serializeAssetStore([assetOf(shared)])
  assert.equal(JSON.stringify(payload).includes('minsu'), false)
})

test('명시적 scope 없이는 연결을 만들 수 없다', () => {
  assert.throws(() => bindingOf(rec(), ''), /scopeId/)
  assert.throws(() => scopedSlotKey('', 'minsu', 'joy'), /scopeId/)
})

test('후보 한 건이 손상돼도 정상 후보는 복원된다', () => {
  const good = assetOf(rec({ sourceSha256: SHA_A }))
  const alsoGood = assetOf(rec({ sourceSha256: SHA_B }))
  const raw = {
    schemaVersion: ASSET_STORAGE_SCHEMA_VERSION,
    assets: [good, { assetId: 'asset_broken' }, alsoGood],
  }
  const { assets, report } = deserializeAssetStore(raw)
  assert.equal(report.restored, 2, '정상 후보가 함께 버려졌다')
  assert.equal(report.quarantined, 1)
  assert.equal(report.rootError, null)
  const quarantined = assets.find((a) => a.lifecycle === 'quarantined')
  assert.equal(quarantined?.lifecycleCode, 'STORED_RECORD_MALFORMED')
  assert.equal(assets.filter((a) => a.lifecycle === 'ready').length, 2)
})

test('root 스키마 오류는 기존 파일을 빈 값으로 덮어쓰게 만들지 않는다', () => {
  for (const [raw, code] of [
    [null, 'ABSENT'],
    ['nope', 'MALFORMED_ROOT'],
    [{ schemaVersion: 999, assets: [] }, 'SCHEMA_VERSION_UNSUPPORTED'],
    [{ schemaVersion: ASSET_STORAGE_SCHEMA_VERSION, assets: 'x' }, 'MALFORMED_ROOT'],
  ] as [unknown, string][]) {
    const out = deserializeAssetStore(raw)
    assert.equal(out.report.rootError, code, JSON.stringify(raw))
    assert.equal(out.assets.length, 0)
    // rootError 가 있으면 호출부는 저장하지 않는다 — 이 값이 그 신호다.
    assert.equal(out.report.restored, 0)
    assert.equal(out.report.quarantined, 0)
  }
})

test('없어진 자산과 내용이 바뀐 자산만 각각 expired·changed 다', () => {
  const gone = assetOf(rec({ sourceSha256: SHA_A }))
  const moved = assetOf(rec({ sourceSha256: SHA_B }))
  const fine = assetOf(rec({ sourceSha256: SHA_C }))
  const raw = { schemaVersion: ASSET_STORAGE_SCHEMA_VERSION, assets: [gone, moved, fine] }
  const { assets, report } = deserializeAssetStore(raw, (asset) => {
    if (asset.sourceSha256 === SHA_A) {
      return { sourcePresent: false, clipPresent: false }
    }
    if (asset.sourceSha256 === SHA_B) {
      return { sourcePresent: true, clipPresent: true, currentSourceSha256: SHA_C }
    }
    return { sourcePresent: true, clipPresent: true, currentSourceSha256: SHA_C }
  })
  assert.equal(report.expired, 1)
  assert.equal(report.changed, 1)
  assert.equal(report.restored, 1, '나머지는 정상 유지된다')
  assert.equal(assets.length, 3)
})

test('복원 집계에 경로도 표시 이름도 없다', () => {
  const raw = {
    schemaVersion: ASSET_STORAGE_SCHEMA_VERSION,
    assets: [assetOf(rec({ sourceSha256: SHA_A }))],
  }
  const blob = JSON.stringify(deserializeAssetStore(raw).report)
  for (const leak of ['민수', '.wav', 'C:/', 'sourcePath']) {
    assert.equal(blob.includes(leak), false, leak)
  }
})

// ── SHA 무결성과 dangling 선택 ─────────────────────────────────────────────

test('SHA 가 없는 후보는 unverified 이며 추천도 생성도 되지 않는다', () => {
  const got = evaluateLifecycle(
    { sourceDurationSec: 5, region: null, effectiveClipId: null,
      qualityState: 'ok', sourceSha256: '' },
    { sourcePresent: true, clipPresent: true })
  assert.deepEqual(got, { lifecycle: 'unverified', lifecycleCode: 'SOURCE_SHA_ABSENT' })
  // 추천 대상에서 빠진다.
  assert.equal(autoRecommendable('clean_speech', 'ok', 'unverified'), false)
  assert.equal(autoRecommendable('clean_speech', 'ok', 'ready'), true)
  // 고른 상태여도 생성이 막힌다.
  const bad = rec({ sourceSha256: '', lifecycle: 'unverified',
    lifecycleCode: 'SOURCE_SHA_ABSENT', autoRecommendable: false })
  const fine = rec({ sourceSha256: SHA_B })
  const reg = withRecords(bad, fine)
  const key = slotKey('minsu', 'joy')
  const res = resolveSlot(reg, 'minsu', 'joy', { [key]: bad.candidateId }, {})
  assert.equal(res.candidateId, null)
  assert.equal(res.blockedCode, 'SOURCE_SHA_ABSENT')
  // 자동 제안으로도 올라오지 않는다.
  assert.equal(resolveSlot(reg, 'minsu', 'joy', {}, { [key]: bad.candidateId }).candidateId,
    null)
})

test('격리된 후보도 추천 대상이 아니다', () => {
  assert.equal(autoRecommendable('clean_speech', 'ok', 'quarantined'), false)
})

test('후보 삭제 후 dangling 선택이 남지 않는다', () => {
  const a = rec({ sourceSha256: SHA_A })
  const b = rec({ sourceSha256: SHA_B })
  const reg = withRecords(a, b)
  const key = slotKey('minsu', 'joy')
  const out = removeCandidate(reg, 'minsu', 'joy', a.candidateId, { [key]: a.candidateId })
  // 같은 전이에서 선택이 해제됐다.
  assert.equal(out.selections[key], undefined)
  // 다른 후보로 자동 교체되지 않았다.
  assert.notEqual(out.selections[key], b.candidateId)
  // 남은 선택이 존재하는 후보만 가리킨다.
  for (const [, v] of Object.entries(out.selections)) {
    assert.ok(out.registry.records.some((r) => r.candidateId === v), v)
  }
})

test('선택되지 않은 후보를 지우면 다른 선택은 그대로다', () => {
  const a = rec({ sourceSha256: SHA_A })
  const b = rec({ sourceSha256: SHA_B })
  const key = slotKey('minsu', 'joy')
  const out = removeCandidate(withRecords(a, b), 'minsu', 'joy', a.candidateId,
    { [key]: b.candidateId })
  assert.equal(out.selections[key], b.candidateId)
})

// ── 네 축의 독립 ───────────────────────────────────────────────────────────

test('기본 목소리·중립 후보·scope 연결·전역 자산은 서로를 지우지 않는다', () => {
  const neutral = rec({ emotionId: NEUTRAL_EMOTION_ID, sourceSha256: SHA_A })
  const joy = rec({ emotionId: 'joy', sourceSha256: SHA_B })
  const reg = withRecords(neutral, joy)
  const asset = assetOf(neutral)
  const binding = bindingOf(neutral, 'scope-X')

  // 중립 후보를 지운다 → scope 연결은 사라지지만 전역 자산 기록은 남는다.
  const out = removeCandidate(reg, 'minsu', NEUTRAL_EMOTION_ID, neutral.candidateId)
  assert.equal(candidatesFor(out.registry, 'minsu', NEUTRAL_EMOTION_ID).length, 0)
  assert.equal(candidatesFor(out.registry, 'minsu', 'joy').length, 1)
  assert.equal(asset.assetId, binding.assetId, '자산 기록은 삭제와 무관하게 유효하다')
  assert.deepEqual(out.releasableClipIds, [], '기본 목소리 파일에 손대지 않는다')
  // 등록부에는 여전히 감정 후보만 있다(기본 목소리는 다른 상태가 소유한다).
  assert.ok(holdsOnlyEmotionCandidates(out.registry))
})
