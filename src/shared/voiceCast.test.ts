// 배역 세트(Voice Cast) — 확정된 durable scope 의 불변식.
//
// 이 구조가 막아야 하는 사고
//   · 다른 작업의 `[화자 민수]` 가 자동으로 같은 목소리를 쓴다
//   · 배역이 하나뿐이라는 이유로 새 작업에 조용히 적용된다
//   · 배역을 지웠더니 공유 자산이나 사용자 원본이 함께 사라진다
//   · 배역 한 건이 손상돼 나머지 배역과 다른 설정 키까지 잃는다
//   · run bundle 에 배역 이름·화자 표시 이름·경로가 새어 나간다
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ASSET_STORAGE_SCHEMA_VERSION, VOICE_CAST_SCHEMA_VERSION, VOICE_CAST_STORAGE_KEY,
  GLOBAL_ASSET_STORAGE_KEY, EMPTY_VOICE_CAST_STORE, NEUTRAL_EMOTION_ID,
  addVoiceCast, assetRefCountAcrossCasts, castCandidatesFor, castPayloadHasNoAssetFacts,
  castRecordForRun, castRegistry, createVoiceCast, deleteVoiceCast,
  deserializeVoiceCasts, findVoiceCast, joinCastRecords, makeAssetId, makeCandidateId,
  regionFromSeconds, registerCastCandidate, removeCastCandidate, renameVoiceCast,
  resolveSlot, serializeVoiceCasts, setCastSelection, setSpeakerDefault, slotKey,
  toSpeakerEmotionRefs,
} from './emotionCandidateRegistry.ts'
import type {
  ReferenceAsset, VoiceCast, VoiceCastStore,
} from './emotionCandidateRegistry.ts'
import { samplerSha256Hex as H } from './emotionSampler.ts'

const NOW = '2026-09-03T00:00:00.000Z'
const LATER = '2026-09-03T01:00:00.000Z'
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

function asset(sha: string, over: Partial<ReferenceAsset> = {}): ReferenceAsset {
  const region = over.region ?? null
  return {
    assetId: over.assetId ?? makeAssetId(sha, region),
    sourcePath: `C:/refs/${sha.slice(0, 4)}.wav`,
    sourceSha256: sha,
    sourceDurationSec: 5,
    sourceFormat: 'wav',
    region,
    effectiveClipId: null,
    profileId: null,
    qualityState: 'ok',
    qualityCodes: [],
    sourceKind: 'clean_speech',
    lifecycle: 'ready',
    lifecycleCode: null,
    ...over,
  }
}

function candOf(a: ReferenceAsset, speakerId: string, emotionId: string) {
  return {
    candidateId: makeCandidateId(a.assetId, speakerId, emotionId, H),
    assetId: a.assetId, speakerId, emotionId,
  }
}

function withCast(name: string, id: string): { store: VoiceCastStore; cast: VoiceCast } {
  const cast = createVoiceCast(name, id, NOW)
  return { store: addVoiceCast(EMPTY_VOICE_CAST_STORE, cast), cast }
}

// ── 생성·이름·삭제 ─────────────────────────────────────────────────────────

test('배역 세트는 주입된 id 로 만들어진다 — 이름에서 파생하지 않는다', () => {
  const cast = createVoiceCast('파일럿 민수', 'uuid-1111', NOW)
  assert.equal(cast.voiceCastId, 'uuid-1111')
  assert.equal(cast.schemaVersion, VOICE_CAST_SCHEMA_VERSION)
  assert.equal(cast.createdAt, NOW)
  // 이름은 identity 가 아니다 — 같은 이름으로 둘을 만들 수 있다.
  const twin = createVoiceCast('파일럿 민수', 'uuid-2222', NOW)
  assert.notEqual(cast.voiceCastId, twin.voiceCastId)
  assert.throws(() => createVoiceCast('x', '', NOW), /voiceCastId/)
})

test('이름 변경은 id 를 바꾸지 않는다', () => {
  const { store, cast } = withCast('처음', 'uuid-1')
  const next = renameVoiceCast(store, cast.voiceCastId, '바꾼 이름', LATER)
  const got = findVoiceCast(next, cast.voiceCastId)
  assert.equal(got?.castName, '바꾼 이름')
  assert.equal(got?.voiceCastId, 'uuid-1')
  assert.equal(got?.updatedAt, LATER)
  // 빈 이름으로 지우지 않는다.
  const kept = renameVoiceCast(next, cast.voiceCastId, '   ', LATER)
  assert.equal(findVoiceCast(kept, cast.voiceCastId)?.castName, '바꾼 이름')
})

test('배역 삭제가 공유 자산을 지우지 않는다', () => {
  const a = asset(SHA_A)
  let store = addVoiceCast(
    addVoiceCast(EMPTY_VOICE_CAST_STORE, createVoiceCast('X', 'uuid-x', NOW)),
    createVoiceCast('Y', 'uuid-y', NOW))
  store = registerCastCandidate(store, 'uuid-x', candOf(a, 'minsu', 'joy'), NOW)
  store = registerCastCandidate(store, 'uuid-y', candOf(a, 'minsu', 'joy'), NOW)
  assert.equal(assetRefCountAcrossCasts(store, a.assetId), 2)

  const first = deleteVoiceCast(store, 'uuid-x')
  assert.deepEqual(first.releasableAssetIds, [], '다른 배역이 쓰는 자산을 놓아 주면 안 된다')
  assert.equal(findVoiceCast(first.store, 'uuid-y')?.candidates.length, 1)
  const second = deleteVoiceCast(first.store, 'uuid-y')
  assert.deepEqual(second.releasableAssetIds, [a.assetId], '마지막 참조가 사라지면 알린다')
})

// ── scope 격리 ─────────────────────────────────────────────────────────────

test('Cast X 의 민수와 Cast Y 의 민수는 후보를 공유하지 않는다', () => {
  const a = asset(SHA_A)
  const b = asset(SHA_B)
  let store = addVoiceCast(
    addVoiceCast(EMPTY_VOICE_CAST_STORE, createVoiceCast('X', 'uuid-x', NOW)),
    createVoiceCast('Y', 'uuid-y', NOW))
  store = registerCastCandidate(store, 'uuid-x', candOf(a, 'minsu', 'joy'), NOW)
  store = registerCastCandidate(store, 'uuid-y', candOf(b, 'minsu', 'joy'), NOW)

  const x = castCandidatesFor(findVoiceCast(store, 'uuid-x'), 'minsu', 'joy')
  const y = castCandidatesFor(findVoiceCast(store, 'uuid-y'), 'minsu', 'joy')
  assert.equal(x.length, 1)
  assert.equal(y.length, 1)
  assert.equal(x[0].assetId, a.assetId)
  assert.equal(y[0].assetId, b.assetId)
  assert.notEqual(x[0].assetId, y[0].assetId)
})

test('선택도 배역 안에만 머문다', () => {
  const a = asset(SHA_A)
  const b = asset(SHA_B)
  let store = addVoiceCast(
    addVoiceCast(EMPTY_VOICE_CAST_STORE, createVoiceCast('X', 'uuid-x', NOW)),
    createVoiceCast('Y', 'uuid-y', NOW))
  const ca = candOf(a, 'minsu', 'joy')
  const cb = candOf(b, 'minsu', 'joy')
  store = registerCastCandidate(store, 'uuid-x', ca, NOW)
  store = registerCastCandidate(store, 'uuid-x', cb, NOW)
  store = registerCastCandidate(store, 'uuid-y', ca, NOW)
  store = setCastSelection(store, 'uuid-x', 'minsu', 'joy', cb.candidateId, LATER)

  assert.equal(findVoiceCast(store, 'uuid-x')?.selections[slotKey('minsu', 'joy')],
    cb.candidateId)
  assert.equal(findVoiceCast(store, 'uuid-y')?.selections[slotKey('minsu', 'joy')],
    undefined, '다른 배역의 선택이 따라왔다')
})

test('배역을 고르지 않으면 해석할 후보가 없다 — 자동 적용 0', () => {
  const a = asset(SHA_A)
  let store = withCast('X', 'uuid-x').store
  store = registerCastCandidate(store, 'uuid-x', candOf(a, 'minsu', 'joy'), NOW)
  // 활성 배역이 null 인 상태(새 작업)에서는 후보가 하나도 보이지 않는다.
  const none = castRegistry(findVoiceCast(store, null), { [a.assetId]: a })
  assert.equal(none.records.length, 0)
  assert.deepEqual(toSpeakerEmotionRefs(none, {}, {}, () => undefined), {})
  // 배역이 하나뿐이어도 마찬가지다 — 고르는 것은 사용자의 행위다.
  assert.equal(store.casts.length, 1)
  assert.equal(castRegistry(null, { [a.assetId]: a }).records.length, 0)
})

test('명시적으로 고른 배역만 resolver 로 간다', () => {
  const a = asset(SHA_A)
  const b = asset(SHA_B)
  const assets = { [a.assetId]: a, [b.assetId]: b }
  let store = addVoiceCast(
    addVoiceCast(EMPTY_VOICE_CAST_STORE, createVoiceCast('X', 'uuid-x', NOW)),
    createVoiceCast('Y', 'uuid-y', NOW))
  store = registerCastCandidate(store, 'uuid-x', candOf(a, 'minsu', 'joy'), NOW)
  store = registerCastCandidate(store, 'uuid-y', candOf(b, 'minsu', 'joy'), NOW)

  const chosen = castRegistry(findVoiceCast(store, 'uuid-y'), assets)
  const key = slotKey('minsu', 'joy')
  const cb = candOf(b, 'minsu', 'joy')
  const refs = toSpeakerEmotionRefs(chosen, { [key]: cb.candidateId }, {}, () => undefined)
  assert.equal(refs[key], b.sourcePath)
  assert.equal(Object.keys(refs).length, 1, '고르지 않은 배역의 후보가 섞였다')
})

// ── 자산 수명과 차단 ────────────────────────────────────────────────────────

test('자산이 만료·변경되면 그 binding 만 막힌다', () => {
  const gone = asset(SHA_A, { lifecycle: 'expired', lifecycleCode: 'SOURCE_FILE_MISSING' })
  const fine = asset(SHA_B)
  const assets = { [gone.assetId]: gone, [fine.assetId]: fine }
  let store = withCast('X', 'uuid-x').store
  const cGone = candOf(gone, 'minsu', 'joy')
  const cFine = candOf(fine, 'minsu', 'sad')
  store = registerCastCandidate(store, 'uuid-x', cGone, NOW)
  store = registerCastCandidate(store, 'uuid-x', cFine, NOW)
  const cast = findVoiceCast(store, 'uuid-x')
  const reg = castRegistry(cast, assets)

  const blocked = resolveSlot(reg, 'minsu', 'joy', { [slotKey('minsu', 'joy')]: cGone.candidateId }, {})
  assert.equal(blocked.candidateId, null)
  assert.equal(blocked.blockedCode, 'SOURCE_FILE_MISSING')
  // 다른 감정은 영향이 없다.
  const ok = resolveSlot(reg, 'minsu', 'sad', { [slotKey('minsu', 'sad')]: cFine.candidateId }, {})
  assert.equal(ok.candidateId, cFine.candidateId)
})

test('자산을 못 찾은 후보는 격리되고 목록에서 사라지지 않는다', () => {
  const a = asset(SHA_A)
  let store = withCast('X', 'uuid-x').store
  store = registerCastCandidate(store, 'uuid-x', candOf(a, 'minsu', 'joy'), NOW)
  const rows = joinCastRecords(findVoiceCast(store, 'uuid-x'), {}, 'minsu', 'joy')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].lifecycle, 'quarantined')
  assert.equal(rows[0].lifecycleCode, 'ASSET_NOT_FOUND')
  assert.equal(rows[0].autoRecommendable, false)
})

test('후보 해제는 같은 전이에서 선택을 풀고 다른 슬롯을 건드리지 않는다', () => {
  const a = asset(SHA_A)
  const b = asset(SHA_B)
  let store = withCast('X', 'uuid-x').store
  const ca = candOf(a, 'minsu', 'joy')
  const cb = candOf(b, 'minsu', 'sad')
  store = registerCastCandidate(store, 'uuid-x', ca, NOW)
  store = registerCastCandidate(store, 'uuid-x', cb, NOW)
  store = setCastSelection(store, 'uuid-x', 'minsu', 'joy', ca.candidateId, NOW)
  store = setCastSelection(store, 'uuid-x', 'minsu', 'sad', cb.candidateId, NOW)

  store = removeCastCandidate(store, 'uuid-x', 'minsu', 'joy', ca.candidateId, LATER)
  const cast = findVoiceCast(store, 'uuid-x')
  assert.equal(cast?.selections[slotKey('minsu', 'joy')], undefined, 'dangling 선택이 남았다')
  assert.equal(cast?.selections[slotKey('minsu', 'sad')], cb.candidateId)
  assert.equal(castCandidatesFor(cast, 'minsu', 'sad').length, 1)
})

test('중립 후보를 지워도 화자 기본 목소리는 남는다', () => {
  const base = asset(SHA_A)
  const neutral = asset(SHA_B)
  let store = withCast('X', 'uuid-x').store
  store = setSpeakerDefault(store, 'uuid-x', 'minsu', base.assetId, NOW)
  const cn = candOf(neutral, 'minsu', NEUTRAL_EMOTION_ID)
  store = registerCastCandidate(store, 'uuid-x', cn, NOW)
  store = removeCastCandidate(store, 'uuid-x', 'minsu', NEUTRAL_EMOTION_ID,
    cn.candidateId, LATER)
  const cast = findVoiceCast(store, 'uuid-x')
  assert.equal(cast?.speakerDefaults.minsu, base.assetId, '기본 목소리가 함께 사라졌다')
  assert.equal(castCandidatesFor(cast, 'minsu', NEUTRAL_EMOTION_ID).length, 0)
})

// ── 저장과 복원 ────────────────────────────────────────────────────────────

test('배역 저장 키는 자산 키와 다르고 payload 에 파일 사실이 없다', () => {
  assert.equal(VOICE_CAST_STORAGE_KEY, 'voiceCasts')
  assert.notEqual(VOICE_CAST_STORAGE_KEY, GLOBAL_ASSET_STORAGE_KEY)
  const a = asset(SHA_A)
  let store = withCast('파일럿', 'uuid-x').store
  store = registerCastCandidate(store, 'uuid-x', candOf(a, 'minsu', 'joy'), NOW)
  const payload = serializeVoiceCasts(store)
  assert.ok(castPayloadHasNoAssetFacts(payload), JSON.stringify(payload).slice(0, 200))
})

test('배역 한 건 손상은 그 배역만 격리한다', () => {
  const a = asset(SHA_A)
  let store = withCast('정상', 'uuid-ok').store
  store = registerCastCandidate(store, 'uuid-ok', candOf(a, 'minsu', 'joy'), NOW)
  const raw = {
    schemaVersion: VOICE_CAST_SCHEMA_VERSION,
    casts: [...serializeVoiceCasts(store).casts, { castName: 'id 없는 배역' }],
  }
  const { store: got, report } = deserializeVoiceCasts(raw)
  assert.equal(report.restoredCasts, 1)
  assert.equal(report.quarantinedCasts, 1)
  assert.equal(report.rootError, null)
  assert.equal(findVoiceCast(got, 'uuid-ok')?.candidates.length, 1, '정상 배역이 함께 버려졌다')
  assert.equal(got.casts.filter((c) => c.lifecycle === 'quarantined').length, 1)
})

test('후보 한 건 손상은 그 후보만 격리하고 나머지는 복원한다', () => {
  const a = asset(SHA_A)
  let store = withCast('정상', 'uuid-ok').store
  store = registerCastCandidate(store, 'uuid-ok', candOf(a, 'minsu', 'joy'), NOW)
  const serialized = serializeVoiceCasts(store)
  const raw = {
    schemaVersion: VOICE_CAST_SCHEMA_VERSION,
    casts: [{
      ...serialized.casts[0],
      candidates: [...serialized.casts[0].candidates, { candidateId: 'broken' }],
    }],
  }
  const { store: got, report } = deserializeVoiceCasts(raw)
  assert.equal(report.quarantinedCandidates, 1)
  assert.equal(report.restoredCasts, 1)
  assert.equal(findVoiceCast(got, 'uuid-ok')?.candidates.length, 1)
})

test('root 손상은 이 키만 중지시키고 자산 키에 영향을 주지 않는다', () => {
  for (const [raw, code] of [
    [null, 'ABSENT'],
    ['nope', 'MALFORMED_ROOT'],
    [{ schemaVersion: 999, casts: [] }, 'SCHEMA_VERSION_UNSUPPORTED'],
    [{ schemaVersion: VOICE_CAST_SCHEMA_VERSION, casts: 'x' }, 'MALFORMED_ROOT'],
  ] as [unknown, string][]) {
    const out = deserializeVoiceCasts(raw)
    assert.equal(out.report.rootError, code, JSON.stringify(raw))
    assert.equal(out.store.casts.length, 0)
    assert.equal(out.report.restoredCasts, 0)
  }
  // 자산 저장은 별 키·별 스키마다 — 배역 root 오류가 여기에 닿을 통로가 없다.
  assert.notEqual(ASSET_STORAGE_SCHEMA_VERSION, undefined)
  assert.notEqual(GLOBAL_ASSET_STORAGE_KEY, VOICE_CAST_STORAGE_KEY)
})

// ── 기록 누출 ──────────────────────────────────────────────────────────────

test('run 기록에는 voiceCastId 만 남고 이름·경로·후보 목록이 없다', () => {
  const a = asset(SHA_A)
  let store = withCast('민수 파일럿', 'uuid-x').store
  store = registerCastCandidate(store, 'uuid-x', candOf(a, 'minsu', 'joy'), NOW)
  const rec = castRecordForRun(findVoiceCast(store, 'uuid-x'))
  assert.equal(rec.voiceCastId, 'uuid-x')
  assert.equal(rec.candidateCount, 1)
  const blob = JSON.stringify(rec)
  for (const leak of ['민수', '파일럿', '.wav', 'C:/', 'candidates', 'sourcePath']) {
    assert.equal(blob.includes(leak), false, leak)
  }
  assert.deepEqual(castRecordForRun(null),
    { voiceCastId: null, schemaVersion: null, candidateCount: 0 })
})
