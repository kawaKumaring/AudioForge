// 참조 클립 라이브러리 단위 테스트 — Node 내장 러너(node --test), 새 의존성 0.
// 실행: node --test "src/**/*.test.ts"
//
// 검증 범위: 지문 결정성 / 무효화 사유 4종 독립 / 대본·속도·감정 변경 시 재사용 유지 /
// 겹침 규칙(끝점 맞닿음 포함) / 선택은 다음 탐색에서 제외 / 단일 참조 가드 /
// 위생(경로·전사 원문 유출 금지) / Python 소스 파싱 parity.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  REFERENCE_ANALYSIS_VERSION, REFERENCE_INVALIDATION_REASONS, REFERENCE_GUARD_CODES,
  REFERENCE_SCAN_STATUSES, REFERENCE_PROMOTE_STATUSES, PROMOTE_STEPS, CLIP_VERIFICATION_CHECKS,
  MAX_AUTO_CANDIDATES, MIN_REGION_MS, MAX_REGION_MS, CLIP_ID_LENGTH,
  FINGERPRINT_PAYLOAD_HEADER, CLIP_ID_PAYLOAD_HEADER, VOLATILE_AXES,
  MANIFEST_RECORD_FIELDS, CLIP_FILE_EXTENSION, MANIFEST_VERSION, REFERENCE_LIBRARY_DIR_NAME,
  REFERENCE_STAGING_DIR_NAME, MANIFEST_FILE_NAME, RUN_SCOPE_PREFIX, RUN_JOURNAL_SUFFIX, MANIFEST_TEMP_SUFFIX,
  ReferenceLibraryError,
  buildFingerprintPayload, computeFingerprint, computeFingerprintFromRequest, deriveClipId,
  normalizeTranscript, secondsToMs, evaluateReuse,
  intervalsOverlap, selectBestCandidate, pickAutoCandidates, rescanCandidates,
  buildCandidate, buildLibraryEntry, assertCandidateSetValid, assertSingleReference,
  buildSynthesisReference, candidateFromPython, referenceCacheKey, referenceIdentity,
  findSensitiveStrings, isPathLike, sha256HexOfString,
  clipFileName, emptyManifest, buildManifestRecord, assertManifestRecordValid, assertManifestValid,
  upsertManifestRecord, findManifestRecord, planAssetDeletion, removeManifestRecord,
  verifyStoredClip, evaluateReuseAgainstRecord, resolveReusableClip,
  pathVolume, assertPromotionSameVolume, runScopedStagingDirName, runJournalFileName,
  manifestTempFileName, isRunScopedName, buildRunJournal, isOrphanOwnedByRun,
  evaluateClipVerification, assertPromoteOrder, promoteReferenceClip,
  type ScoredInterval, type ReferenceRequest, type StoredReferenceFingerprint,
} from './referenceLibrary.ts'
import { sha256HexOfString as grammarSha256 } from './ttsGrammar.ts'

const SRC_A = 'a'.repeat(64)
const SRC_B = 'b'.repeat(64)
const TRANSCRIPT = '  안녕하세요 참조 전사입니다.  '

// python/reference_library.py 로 산출·고정한 벡터. 같은 리터럴을 python/test_reference_library.py 도
// 검증하므로 TS == Python 이 transitively 증명된다.
const PINNED_PAYLOAD =
  'reflib-fp/1\n'
  + 'analysis_version=1\n'
  + 'source_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
  + 'region_start_ms=1250\n'
  + 'region_duration_ms=7000\n'
  + 'transcript_sha256=87f80df86af86d7d0a052dfd58a942906e1fac0ce3b80b55d98e15c771cbf5ea'
const PINNED_FINGERPRINT = '07e37b46741436efa866612ef925f853e13a44fa7994f89c21ae086b30368111'
const PINNED_FINGERPRINT_EMPTY_TX = 'b93c26b498a82c65852d24d3989bd792fc110ad0f53ffda56c2d0c3faa00d8c5'
const PINNED_CLIP_ID = 'abb0ff174ab6e56c'

const baseInput = (over: Partial<ReferenceRequest> = {}): ReferenceRequest => ({
  sourceSha256: SRC_A,
  region: { start: 1.25, duration: 7.0 },
  transcript: TRANSCRIPT,
  ...over,
})

// ─────────────────────────────────────────────────────────────────────────────
// 1) 지문 — 정규 직렬화 + 결정성
// ─────────────────────────────────────────────────────────────────────────────
test('정규 직렬화: 고정 payload 바이트 일치(= Python 동형)', () => {
  assert.equal(buildFingerprintPayload(baseInput()), PINNED_PAYLOAD)
  assert.equal(computeFingerprint(baseInput()), PINNED_FINGERPRINT)
  assert.equal(deriveClipId(SRC_A, 1.25, 7.0), PINNED_CLIP_ID)
  assert.equal(deriveClipId(SRC_A, 1.25, 7.0).length, CLIP_ID_LENGTH)
  assert.equal(
    computeFingerprint({ sourceSha256: SRC_A, region: { start: 0, duration: 3 }, transcript: '' }),
    PINNED_FINGERPRINT_EMPTY_TX,
  )
})

test('지문 결정성: 같은 입력 → 항상 같은 값(반복/키 순서/객체 신원 무관)', () => {
  const a = computeFingerprint(baseInput())
  for (let i = 0; i < 5; i++) assert.equal(computeFingerprint(baseInput()), a)
  // 필드를 다른 순서로 만든 객체도 동일
  const reordered = { transcript: TRANSCRIPT, region: { duration: 7.0, start: 1.25 }, sourceSha256: SRC_A }
  assert.equal(computeFingerprint(reordered), a)
  assert.match(a, /^[0-9a-f]{64}$/)
})

test('전사 정규화: 양끝 ASCII 공백 6종만 제거, 내부는 보존', () => {
  assert.equal(normalizeTranscript('\t\n\r\f\v 가운데  공백 \v\f\r\n\t'), '가운데  공백')
  assert.equal(normalizeTranscript(null), '')
  // 양끝 공백만 다른 전사는 같은 지문
  assert.equal(computeFingerprint(baseInput({ transcript: '안녕하세요 참조 전사입니다.' })), PINNED_FINGERPRINT)
})

test('초 → ms 반올림 규칙 floor(x*1000+0.5)', () => {
  assert.equal(secondsToMs(0), 0)
  assert.equal(secondsToMs(1.2345), 1235)
  assert.equal(secondsToMs(1.2344), 1234)
  assert.equal(secondsToMs(0.0005), 1)          // 정확히 .5 는 올림
  assert.throws(() => secondsToMs(-0.1), (e: unknown) => (e as ReferenceLibraryError).code === 'INVALID_FINGERPRINT_INPUT')
  assert.throws(() => secondsToMs(Number.NaN), (e: unknown) => (e as ReferenceLibraryError).code === 'INVALID_FINGERPRINT_INPUT')
})

test('source sha256 형식 강제(TS는 파일 해시를 스스로 계산하지 않는다)', () => {
  assert.throws(() => computeFingerprint(baseInput({ sourceSha256: 'nope' })),
    (e: unknown) => (e as ReferenceLibraryError).code === 'INVALID_FINGERPRINT_INPUT')
  // 대문자 hex 는 소문자로 정규화돼 같은 지문
  assert.equal(computeFingerprint(baseInput({ sourceSha256: SRC_A.toUpperCase() })), PINNED_FINGERPRINT)
})

// ─────────────────────────────────────────────────────────────────────────────
// 2) 재사용 — 대본/속도/감정/피치는 무효화하지 않는다
// ─────────────────────────────────────────────────────────────────────────────
test('재사용: 대본·속도·감정·피치가 바뀌어도 재분석 없음(reasons 비어 있음)', () => {
  const stored: StoredReferenceFingerprint = baseInput()
  const changed: ReferenceRequest = baseInput({
    script: '[기쁨] 완전히 다른 대본입니다.',
    speed: 1.6,
    emotionId: 'sad',
    pitch: -2,
  })
  const v = evaluateReuse(stored, changed)
  assert.equal(v.reusable, true)
  assert.deepEqual(v.reasons, [])
  assert.equal(v.fingerprint, v.storedFingerprint)
  assert.equal(v.fingerprint, PINNED_FINGERPRINT)
  // 축을 하나씩 바꿔도 지문 불변
  for (const axis of VOLATILE_AXES) {
    const one = baseInput({ [axis]: axis === 'speed' || axis === 'pitch' ? 9 : 'X' } as Partial<ReferenceRequest>)
    assert.equal(computeFingerprintFromRequest(one), PINNED_FINGERPRINT, `${axis} 는 지문 입력이 아니다`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 3) 무효화 — 4가지 사유가 각각 독립적으로, 고유 코드로
// ─────────────────────────────────────────────────────────────────────────────
test('무효화: 원본 파일 변경 → REF_SOURCE_CHANGED 단독', () => {
  const v = evaluateReuse(baseInput(), baseInput({ sourceSha256: SRC_B }))
  assert.deepEqual(v.reasons, ['REF_SOURCE_CHANGED'])
  assert.equal(v.reusable, false)
  assert.notEqual(v.fingerprint, v.storedFingerprint)
})

test('무효화: 구간 변경 → REF_REGION_CHANGED 단독(start/duration 각각)', () => {
  assert.deepEqual(evaluateReuse(baseInput(), baseInput({ region: { start: 1.5, duration: 7.0 } })).reasons,
    ['REF_REGION_CHANGED'])
  assert.deepEqual(evaluateReuse(baseInput(), baseInput({ region: { start: 1.25, duration: 6.0 } })).reasons,
    ['REF_REGION_CHANGED'])
  // 1ms 미만 차이는 같은 ms 로 접혀 무효화하지 않는다(반올림 규칙 고정의 효과)
  assert.deepEqual(evaluateReuse(baseInput(), baseInput({ region: { start: 1.25004, duration: 7.0 } })).reasons, [])
})

test('무효화: 전사 변경 → REF_TRANSCRIPT_CHANGED 단독', () => {
  const v = evaluateReuse(baseInput(), baseInput({ transcript: '다른 전사문입니다.' }))
  assert.deepEqual(v.reasons, ['REF_TRANSCRIPT_CHANGED'])
  assert.equal(v.reusable, false)
})

test('무효화: 분석 버전 상향 → REF_ANALYSIS_VERSION_CHANGED 단독', () => {
  const v = evaluateReuse(baseInput(), baseInput({ analysisVersion: REFERENCE_ANALYSIS_VERSION + 1 }))
  assert.deepEqual(v.reasons, ['REF_ANALYSIS_VERSION_CHANGED'])
  assert.equal(v.reusable, false)
})

test('무효화: 여러 원인 동시 → 정의 순서대로 모두 보고(결정적)', () => {
  const v = evaluateReuse(baseInput(), baseInput({
    sourceSha256: SRC_B, region: { start: 2, duration: 5 },
    transcript: '다른 전사', analysisVersion: 2,
  }))
  assert.deepEqual(v.reasons, [...REFERENCE_INVALIDATION_REASONS])
})

test('무효화 사유는 이 4가지뿐(다른 코드가 새지 않는다)', () => {
  assert.equal(REFERENCE_INVALIDATION_REASONS.length, 4)
  assert.equal(new Set(REFERENCE_INVALIDATION_REASONS).size, 4)
})

// ─────────────────────────────────────────────────────────────────────────────
// 4) 겹침 규칙 + 후보 선택
// ─────────────────────────────────────────────────────────────────────────────
test('겹침 규칙: 반열린 [start, start+dur) — 끝점 맞닿음은 겹치지 않음', () => {
  const a = { startMs: 0, durationMs: 3000 }
  const touching = { startMs: 3000, durationMs: 3000 }   // a.end === b.start → 겹치지 않음
  const overlapBy1 = { startMs: 2999, durationMs: 3000 } // 1ms 겹침 → 겹침
  assert.equal(intervalsOverlap(a, touching), false)
  assert.equal(intervalsOverlap(touching, a), false)
  assert.equal(intervalsOverlap(a, overlapBy1), true)
  assert.equal(intervalsOverlap(overlapBy1, a), true)
  assert.equal(intervalsOverlap(a, a), true)
})

test('후보 선택: taken 과 겹치지 않는 최고 점수 1개', () => {
  const scored: ScoredInterval[] = [
    { id: 'x', startMs: 0, durationMs: 4000, score: 0.9 },
    { id: 'y', startMs: 2000, durationMs: 4000, score: 0.95 },
    { id: 'z', startMs: 9000, durationMs: 4000, score: 0.5 },
  ]
  assert.equal(selectBestCandidate(scored)?.id, 'y')
  // y 를 이미 확보 → y 와 겹치는 x 는 제외, z 가 최선
  assert.equal(selectBestCandidate(scored, [scored[1]])?.id, 'z')
  assert.equal(selectBestCandidate(scored, [scored[1], scored[2]]), null)
  assert.equal(selectBestCandidate([]), null)
})

test('후보 선택: 끝점 맞닿은 구간은 taken 이어도 여전히 선택 가능(경계)', () => {
  const scored: ScoredInterval[] = [{ id: 'next', startMs: 3000, durationMs: 3000, score: 0.1 }]
  assert.equal(selectBestCandidate(scored, [{ startMs: 0, durationMs: 3000 }])?.id, 'next')
  assert.equal(selectBestCandidate(scored, [{ startMs: 0, durationMs: 3001 }]), null)
})

test('후보 선택: 3~10초 길이 정책 밖은 후보가 아니다', () => {
  const scored: ScoredInterval[] = [
    { id: 'short', startMs: 0, durationMs: MIN_REGION_MS - 1, score: 99 },
    { id: 'long', startMs: 20000, durationMs: MAX_REGION_MS + 1, score: 99 },
    { id: 'zero', startMs: 40000, durationMs: 0, score: 99 },
    { id: 'ok', startMs: 60000, durationMs: MIN_REGION_MS, score: 0.01 },
  ]
  assert.equal(selectBestCandidate(scored)?.id, 'ok')
})

test('자동 후보: 최대 3개, 서로 겹치지 않음, 선택된 것은 다음 탐색에서 제외', () => {
  const scored: ScoredInterval[] = [
    { id: 'a', startMs: 0, durationMs: 5000, score: 0.9 },
    { id: 'b', startMs: 3000, durationMs: 5000, score: 0.8 },   // a 와 겹침
    { id: 'c', startMs: 5000, durationMs: 5000, score: 0.7 },   // a 와 끝점 맞닿음 → 허용
    { id: 'd', startMs: 10000, durationMs: 5000, score: 0.6 },
    { id: 'e', startMs: 16000, durationMs: 5000, score: 0.5 },
  ]
  const picked = pickAutoCandidates(scored)
  assert.deepEqual(picked.map((p) => p.id), ['a', 'c', 'd'])
  assert.ok(picked.length <= MAX_AUTO_CANDIDATES)
  for (let i = 0; i < picked.length; i++) {
    for (let j = i + 1; j < picked.length; j++) assert.equal(intervalsOverlap(picked[i], picked[j]), false)
  }
  // 입력 배열은 변형되지 않는다(순수)
  assert.deepEqual(scored.map((s) => s.id), ['a', 'b', 'c', 'd', 'e'])
})

test('자동 후보: 동점이면 start → duration → id 순으로 결정적', () => {
  const scored: ScoredInterval[] = [
    { id: 'later', startMs: 20000, durationMs: 4000, score: 1 },
    { id: 'earlier', startMs: 0, durationMs: 4000, score: 1 },
  ]
  assert.equal(selectBestCandidate(scored)?.id, 'earlier')
  const sameStart: ScoredInterval[] = [
    { id: 'zz', startMs: 0, durationMs: 4000, score: 1 },
    { id: 'aa', startMs: 0, durationMs: 4000, score: 1 },
  ]
  assert.equal(selectBestCandidate(sameStart)?.id, 'aa')
})

// ─────────────────────────────────────────────────────────────────────────────
// 5) 저장 구조 + 6) 단일 참조 보증
// ─────────────────────────────────────────────────────────────────────────────
function entryWith3() {
  const extra = [
    buildCandidate(SRC_A, 12.0, 5.0, { silenceRatio: 0.1, clippingRatio: 0, rmsDbfs: -20, peak: 0.8, speechRatio: 0.9 }, 0.8),
    buildCandidate(SRC_A, 20.0, 4.0, { silenceRatio: 0.2, clippingRatio: 0.001, rmsDbfs: -24, peak: 0.7, speechRatio: 0.85 }, 0.6),
  ]
  return buildLibraryEntry(baseInput(), extra)
}

test('저장 항목: 확정 구간이 첫 후보 + 기본 참조, 지표는 숫자만', () => {
  const entry = entryWith3()
  assert.equal(entry.candidates.length, 3)
  assert.equal(entry.candidates[0].id, PINNED_CLIP_ID)
  assert.equal(entry.defaultCandidateId, PINNED_CLIP_ID)
  assert.equal(entry.fingerprint, PINNED_FINGERPRINT)
  assert.equal(entry.regionStartMs, 1250)
  assert.equal(entry.regionDurationMs, 7000)
  for (const c of entry.candidates) {
    for (const v of Object.values(c.metrics)) assert.equal(typeof v, 'number')
    assert.ok(Number.isFinite(c.score))
  }
})

test('저장 항목: 확정 구간 후보를 넘기면 그 지표가 보존된다(기본 참조 지표가 0으로 비지 않음)', () => {
  const confirmed = buildCandidate(SRC_A, 1.25, 7.0,
    { silenceRatio: 0.12, clippingRatio: 0.0004, rmsDbfs: -18.4, peak: 0.93, speechRatio: 0.91 }, 0.884)
  const entry = buildLibraryEntry(baseInput(), [confirmed, buildCandidate(SRC_A, 20.0, 4.0, {}, 0.6)])
  assert.equal(entry.candidates[0].id, confirmed.id)
  assert.equal(entry.candidates[0].id, entry.defaultCandidateId)
  assert.deepEqual(entry.candidates[0].metrics, confirmed.metrics)
  assert.equal(entry.candidates[0].score, 0.884)
  assert.equal(entry.candidates.length, 2, '같은 구간이 중복 저장되지 않는다')
})

test('저장 항목: 겹치는 후보 / 3개 초과는 구조화 오류', () => {
  assert.throws(() => assertCandidateSetValid([
    buildCandidate(SRC_A, 0, 5), buildCandidate(SRC_A, 3, 5),
  ]), (e: unknown) => (e as ReferenceLibraryError).code === 'OVERLAPPING_CANDIDATES')
  assert.throws(() => assertCandidateSetValid([
    buildCandidate(SRC_A, 0, 3), buildCandidate(SRC_A, 3, 3),
    buildCandidate(SRC_A, 6, 3), buildCandidate(SRC_A, 9, 3),
  ]), (e: unknown) => (e as ReferenceLibraryError).code === 'TOO_MANY_CANDIDATES')
  // 끝점 맞닿음 3개는 정상
  assert.equal(assertCandidateSetValid([
    buildCandidate(SRC_A, 0, 3), buildCandidate(SRC_A, 3, 3), buildCandidate(SRC_A, 6, 3),
  ]).length, 3)
})

test('단일 참조 가드: 정확히 1개만 합성 경로로 나간다', () => {
  const entry = entryWith3()
  const ids = entry.candidates.map((c) => c.id)
  const ref = buildSynthesisReference(entry, [ids[1]])
  assert.equal(ref.clipId, ids[1])
  assert.equal(Object.keys(ref).filter((k) => k === 'clipId').length, 1)
  assert.equal(typeof ref.clipId, 'string')
  assert.equal(Array.isArray((ref as unknown as { clipIds?: unknown }).clipIds), false)
  // 문자열 1개도 허용(편의), 중복 id 는 1개로 접힘
  assert.equal(assertSingleReference(entry, ids[0]).id, ids[0])
  assert.equal(assertSingleReference(entry, [ids[0], ids[0]]).id, ids[0])
})

test('단일 참조 가드: 0개 / 2개 / 미등록 id 는 각각 고유 코드로 거부', () => {
  const entry = entryWith3()
  const ids = entry.candidates.map((c) => c.id)
  assert.throws(() => buildSynthesisReference(entry, []),
    (e: unknown) => (e as ReferenceLibraryError).code === 'NO_REFERENCE_SELECTED')
  assert.throws(() => buildSynthesisReference(entry, [ids[0], ids[1]]),
    (e: unknown) => (e as ReferenceLibraryError).code === 'MULTIPLE_REFERENCES_SELECTED')
  assert.throws(() => buildSynthesisReference(entry, ['deadbeefdeadbeef']),
    (e: unknown) => (e as ReferenceLibraryError).code === 'UNKNOWN_REFERENCE_SELECTED')
})

test('IPC 경계: Python snake_case 후보 → camelCase 정규화', () => {
  const c = candidateFromPython({
    id: 'abc123', start_ms: 1250, duration_ms: 7000, score: 0.5,
    metrics: { silence_ratio: 0.1, clipping_ratio: 0.002, rms_dbfs: -18.5, peak: 0.9, speech_ratio: 0.88 },
  })
  assert.deepEqual(c, {
    id: 'abc123', startMs: 1250, durationMs: 7000, score: 0.5,
    metrics: { silenceRatio: 0.1, clippingRatio: 0.002, rmsDbfs: -18.5, peak: 0.9, speechRatio: 0.88 },
  })
  assert.deepEqual(candidateFromPython({}).metrics,
    { silenceRatio: 0, clippingRatio: 0, rmsDbfs: 0, peak: 0, speechRatio: 0 })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7) 위생 — 저장/전송 구조에 경로·전사 원문이 없다
// ─────────────────────────────────────────────────────────────────────────────
test('위생: 저장 항목·합성 payload 에 경로/전사 원문이 없다', () => {
  const entry = entryWith3()
  const ref = buildSynthesisReference(entry, [entry.defaultCandidateId])
  const forbidden = [TRANSCRIPT.trim(), '안녕하세요', '전사입니다']
  assert.deepEqual(findSensitiveStrings(entry, forbidden), [])
  assert.deepEqual(findSensitiveStrings(ref, forbidden), [])
  // 스키마에 전사/경로 키 자체가 없다
  for (const k of ['path', 'sourcePath', 'clip', 'transcript', 'text', 'file', 'url']) {
    assert.equal(Object.prototype.hasOwnProperty.call(entry, k), false, `entry.${k} 없어야 함`)
    assert.equal(Object.prototype.hasOwnProperty.call(ref, k), false, `ref.${k} 없어야 함`)
  }
})

test('위생: 탐지기가 실제 경로/전사 유출을 잡는다(음성 대조군)', () => {
  assert.equal(isPathLike('C:/Users/me/audio.wav'), true)
  assert.equal(isPathLike('C:\\Users\\me\\audio.wav'), true)
  assert.equal(isPathLike('file:///tmp/a.wav'), true)
  assert.equal(isPathLike('/home/me/a.wav'), true)
  assert.equal(isPathLike('abb0ff174ab6e56c'), false)
  assert.equal(isPathLike('REF_SOURCE_CHANGED'), false)
  const leaky = { a: { path: 'C:/x/y.wav' }, b: ['안녕하세요 참조 전사입니다.'] }
  const hits = findSensitiveStrings(leaky, ['안녕하세요'])
  assert.deepEqual(hits.map((h) => h.kind).sort(), ['forbidden_text', 'path_like'])
  assert.deepEqual(hits.map((h) => h.at).sort(), ['$.a.path', '$.b[0]'])
})

// ─────────────────────────────────────────────────────────────────────────────
// 10) 내용 기반 지문이 단일 권위 — 경로/크기/mtime 은 캐시 권위가 아니다
// ─────────────────────────────────────────────────────────────────────────────
// 원본 SHA-256 은 TS 가 계산하지 않고 받는다. 아래는 main/Python 이 넘겨줄 값을 흉내낸 것.
const SHA_CONTENT_1 = sha256HexOfString('the same audio bytes')
const SHA_CONTENT_2 = sha256HexOfString('different audio bytes')

test('내용 권위: 같은 파일이 다른 경로로 옮겨져도 재사용된다', () => {
  // 경로는 애초에 입력이 아니다 — 같은 내용 해시면 같은 지문.
  const stored: StoredReferenceFingerprint = {
    sourceSha256: SHA_CONTENT_1, region: { start: 1.25, duration: 7 }, transcript: TRANSCRIPT,
  }
  const movedFile: ReferenceRequest = {
    sourceSha256: SHA_CONTENT_1, region: { start: 1.25, duration: 7 }, transcript: TRANSCRIPT,
  }
  const v = evaluateReuse(stored, movedFile)
  assert.equal(v.reusable, true)
  assert.deepEqual(v.reasons, [])
})

test('내용 권위: 이름·크기가 같아도 내용이 바뀌면 무효화된다', () => {
  assert.notEqual(SHA_CONTENT_1, SHA_CONTENT_2)
  const v = evaluateReuse(
    { sourceSha256: SHA_CONTENT_1, region: { start: 0, duration: 5 }, transcript: '' },
    { sourceSha256: SHA_CONTENT_2, region: { start: 0, duration: 5 }, transcript: '' },
  )
  assert.deepEqual(v.reasons, ['REF_SOURCE_CHANGED'])
  assert.equal(v.reusable, false)
})

test('캐시 키: path|size|mtime 조합은 캐시 권위로 받아들이지 않는다', () => {
  for (const bad of ['C:/ref/a.wav|1234|1699999999999', 'a.wav|10|20', '', 'not-a-hash', SRC_A.slice(0, 63)]) {
    assert.throws(() => referenceCacheKey(bad),
      (e: unknown) => (e as ReferenceLibraryError).code === 'INVALID_FINGERPRINT_INPUT', bad)
  }
  assert.equal(referenceCacheKey(PINNED_FINGERPRINT), PINNED_FINGERPRINT)
  assert.equal(referenceCacheKey(PINNED_FINGERPRINT.toUpperCase()), PINNED_FINGERPRINT)
})

test('샘플러 소비 계약: 지문/캐시키를 스스로 만들지 않도록 내보낸다', () => {
  const entry = entryWith3()
  const ref = buildSynthesisReference(entry, [entry.defaultCandidateId])
  assert.equal(ref.cacheKey, entry.fingerprint)
  assert.equal(ref.sourceSha256, SRC_A)
  assert.deepEqual(referenceIdentity(entry), {
    fingerprint: entry.fingerprint, cacheKey: entry.fingerprint,
    sourceSha256: SRC_A, analysisVersion: REFERENCE_ANALYSIS_VERSION,
  })
  assert.deepEqual(findSensitiveStrings(ref), [])
  assert.deepEqual(findSensitiveStrings(referenceIdentity(entry)), [])
})

test('모듈 소스에 stat 기반 지문(경로|크기|mtime) 사용 흔적이 없다', () => {
  const tsSrc = readFileSync(fileURLToPath(new URL('./referenceLibrary.ts', import.meta.url)), 'utf-8')
  // 주석과 진단 메시지는 "그것을 쓰지 않는다"는 설명(산문)이므로 제외하고 실행 코드 식별자만 본다.
  const code = tsSrc
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // 블록 주석
    .replace(/(^|[^:])\/\/.*$/gm, '$1')          // 줄 주석
    // 공백을 포함한 문자열 리터럴(=산문 메시지)만 비운다. 리터럴 하나씩 정확히 매칭해야
    // 인접한 두 리터럴을 통째로 삼켜 그 사이 산문을 노출시키는 일이 없다.
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (lit) => (/\s/.test(lit) ? "''" : lit))
  for (const banned of ['mtime', 'statSync', 'sourceFingerprint', 'fingerprintReference', 'fileSize', 'st_size']) {
    assert.equal(code.includes(banned), false, `stat 기반 지문 흔적: ${banned}`)
  }
  // 대조군: 위 필터가 실제 코드 사용은 여전히 잡는다
  assert.equal("const x = stat.mtimeMs".replace(/\/\*[\s\S]*?\*\//g, ' ').includes('mtime'), true)
})

// ─────────────────────────────────────────────────────────────────────────────
// 11) 재탐색(rescan) — 기존 후보를 명시적으로 제외
// ─────────────────────────────────────────────────────────────────────────────
function rescanScored(): ScoredInterval[] {
  return [
    { id: 'a', startMs: 0, durationMs: 5000, score: 0.9 },
    { id: 'b', startMs: 3000, durationMs: 5000, score: 0.85 },
    { id: 'c', startMs: 5000, durationMs: 5000, score: 0.7 },
    { id: 'd', startMs: 10000, durationMs: 5000, score: 0.6 },
    { id: 'e', startMs: 16000, durationMs: 5000, score: 0.5 },
  ]
}

test('rescan: 기존 후보 구간을 명시적으로 제외한다(끝점 맞닿음은 허용)', () => {
  const first = rescanCandidates(rescanScored(), [], 1)
  assert.equal(first.status, 'REFERENCE_CANDIDATES_FOUND')
  assert.deepEqual(first.added.map((c) => c.id), ['a'])
  const second = rescanCandidates(rescanScored(), first.candidates, 2)
  assert.deepEqual(second.added.map((c) => c.id), ['c'])          // b 는 a 와 겹쳐 제외, c 는 맞닿음이라 허용
  assert.deepEqual(second.candidates.map((c) => c.id), ['a', 'c'])
})

test('rescan: 기존 후보를 교체·재정렬·삭제하지 않는다', () => {
  const existing: ScoredInterval[] = [
    { id: 'e', startMs: 16000, durationMs: 5000, score: 0.5 },
    { id: 'd', startMs: 10000, durationMs: 5000, score: 0.6 },   // 일부러 점수 역순
  ]
  const r = rescanCandidates(rescanScored(), existing, 3)
  assert.deepEqual(r.candidates.slice(0, 2).map((c) => c.id), ['e', 'd'])
  assert.equal(r.candidates[0], existing[0])                      // 객체 신원까지 그대로
  assert.equal(r.candidates[1], existing[1])
  assert.equal(r.candidates.length, 3)
  assert.equal(r.excludedCount, 2)
  assert.deepEqual(existing.map((c) => c.id), ['e', 'd'], '입력 배열 불변')
})

test('rescan: 남은 구간이 없으면 NO_MORE_REFERENCE_CANDIDATES(빈 배열을 조용히 주지 않는다)', () => {
  const r = rescanCandidates(rescanScored(), [{ id: 'all', startMs: 0, durationMs: 21000, score: 0 }], 3)
  assert.equal(r.status, 'NO_MORE_REFERENCE_CANDIDATES')
  assert.deepEqual(r.added, [])
  assert.ok((REFERENCE_SCAN_STATUSES as readonly string[]).includes(r.status))
  // 자리가 이미 다 찼을 때도 같은 상태
  const full = rescanCandidates(rescanScored(), [
    { id: 'a', startMs: 0, durationMs: 5000, score: 0.9 },
    { id: 'c', startMs: 5000, durationMs: 5000, score: 0.7 },
    { id: 'd', startMs: 10000, durationMs: 5000, score: 0.6 },
  ], 3)
  assert.equal(full.status, 'NO_MORE_REFERENCE_CANDIDATES')
  assert.equal(full.room, 0)
})

test('rescan: 겹치는 후보를 만들어내지 않는다 + 고정 제외 집합에서 결정적', () => {
  const excl: ScoredInterval[] = [{ id: 'a', startMs: 0, durationMs: 5000, score: 0.9 }]
  const r = rescanCandidates(rescanScored(), excl, 3)
  for (const added of r.added) assert.equal(intervalsOverlap(added, excl[0]), false)
  const runs = new Set<string>()
  for (let i = 0; i < 5; i++) runs.add(rescanCandidates(rescanScored(), excl, 3).added.map((c) => c.id).join(','))
  assert.equal(runs.size, 1, '같은 입력 + 같은 제외 집합 → 항상 같은 결과')
})

// ─────────────────────────────────────────────────────────────────────────────
// 12) 영속 저장소 — manifest / 재시작 / 삭제 / 승격 순서·실패 불변식
// ─────────────────────────────────────────────────────────────────────────────
const CLIP_SHA = 'c'.repeat(64)
const RUN_ID = 'deadbeef'
const durableEntry = () => buildLibraryEntry(baseInput())
const jsonCopy = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

test('manifest: 허용된 필드만 담고 경로는 절대 담지 않는다', () => {
  const rec = buildManifestRecord(durableEntry(), CLIP_SHA)
  assert.deepEqual(Object.keys(rec).sort(), [...MANIFEST_RECORD_FIELDS].sort())
  assert.equal(rec.clip_id, PINNED_CLIP_ID)
  assert.equal(rec.fingerprint, PINNED_FINGERPRINT)
  assert.equal(rec.clip_sha256, CLIP_SHA)
  assert.deepEqual(findSensitiveStrings(rec, [TRANSCRIPT.trim(), '안녕하세요']), [])
  const leaky = { ...rec, clip_path: 'C:/userData/reference-library/x.wav' } as unknown as typeof rec
  assert.throws(() => assertManifestRecordValid(leaky),
    (e: unknown) => (e as ReferenceLibraryError).code === 'MANIFEST_CONTAINS_PATH')
})

test('영속 자산 파일명은 clipId 뿐(경로 조각 불가)', () => {
  assert.equal(clipFileName(PINNED_CLIP_ID), `${PINNED_CLIP_ID}${CLIP_FILE_EXTENSION}`)
  assert.equal(isPathLike(clipFileName(PINNED_CLIP_ID)), false)
  assert.throws(() => clipFileName('../escape'),
    (e: unknown) => (e as ReferenceLibraryError).code === 'INVALID_FINGERPRINT_INPUT')
})

test('원자적 승격 전제: staging 과 durable 이 같은 볼륨이어야 한다', () => {
  assertPromotionSameVolume('E:\\ud\\reference-library\\staging\\run-deadbeef', 'E:\\ud\\reference-library')
  assertPromotionSameVolume('E:/ud/x', 'e:\\ud\\y')                 // 대소문자/구분자 무관
  assert.throws(() => assertPromotionSameVolume('C:\\Temp\\run-deadbeef', 'E:\\ud\\reference-library'),
    (e: unknown) => (e as ReferenceLibraryError).code === 'CROSS_DEVICE_PROMOTION')
  assert.equal(pathVolume('\\\\server\\share\\ud'), '\\\\server\\share')
})

test('삭제는 그 레코드가 소유한 자산만(광역/접두사 청소 금지)', () => {
  const m = upsertManifestRecord(emptyManifest(), buildManifestRecord(durableEntry(), CLIP_SHA))
  assert.deepEqual(planAssetDeletion(m, PINNED_CLIP_ID).fileNames, [`${PINNED_CLIP_ID}.wav`])
  const { manifest: after, plan } = removeManifestRecord(m, PINNED_CLIP_ID)
  assert.deepEqual(after.records, [])
  assert.equal(plan.clipId, PINNED_CLIP_ID)
  assert.throws(() => planAssetDeletion(after, '0123456789abcdef'),
    (e: unknown) => (e as ReferenceLibraryError).code === 'UNKNOWN_REFERENCE_ASSET')
})

test('저장된 클립 체크섬 불일치 감지', () => {
  const rec = buildManifestRecord(durableEntry(), CLIP_SHA)
  assert.equal(verifyStoredClip(rec, CLIP_SHA).clip_id, PINNED_CLIP_ID)
  assert.throws(() => verifyStoredClip(rec, 'd'.repeat(64)),
    (e: unknown) => (e as ReferenceLibraryError).code === 'CLIP_CHECKSUM_MISMATCH')
})

test('재시작 등가: manifest 를 직렬화→새 상태로 재파싱해도 같은 지문이 클립을 찾는다', () => {
  const written = JSON.stringify(upsertManifestRecord(emptyManifest(), buildManifestRecord(durableEntry(), CLIP_SHA)))
  // 프로세스 내 상태를 버리고 '디스크에서 다시 읽은' 것만 사용(재시작 등가)
  const reloaded = assertManifestValid(JSON.parse(written))
  const nextSession = baseInput({ script: '완전히 다른 대본', speed: 1.9, emotionId: 'angry' })
  const got = resolveReusableClip(reloaded, nextSession)
  assert.equal(got.reusable, true)
  assert.equal(got.clipId, PINNED_CLIP_ID)
  assert.equal(got.fileName, `${PINNED_CLIP_ID}.wav`)
  assert.equal(got.fingerprint, PINNED_FINGERPRINT)
  assert.equal(verifyStoredClip(got.record!, CLIP_SHA).clip_sha256, CLIP_SHA)
})

test('재시작 후: 원본 내용이 바뀌었으면 재사용되지 않는다', () => {
  const m = upsertManifestRecord(emptyManifest(), buildManifestRecord(durableEntry(), CLIP_SHA))
  const got = resolveReusableClip(m, baseInput({ sourceSha256: SRC_B }))
  assert.equal(got.reusable, false)
  assert.equal(got.clipId, null)
  const rec = findManifestRecord(m, PINNED_FINGERPRINT)!
  assert.deepEqual(evaluateReuseAgainstRecord(rec, baseInput({ sourceSha256: SRC_B })).reasons, ['REF_SOURCE_CHANGED'])
})

// ── 승격: 가짜 fs 로 순서·실패 불변식 검증(실제 오디오/파일 없음) ──
const MEASURED = {
  decodable: true, all_samples_finite: true, sample_rate: 24000,
  channel_count: 1, duration_ms: 7000, clip_sha256: CLIP_SHA,
}
const EXPECTED = { sample_rate: 24000, channel_count: 1, duration_ms: 7000 }

function fakeEffects(calls: string[], opts: { failAt?: string; staging?: string; measured?: typeof MEASURED } = {}) {
  const staging = opts.staging ?? 'E:/ud/reference-library/staging/run-deadbeef'
  const step = <T,>(name: string, ret: T) => (..._args: unknown[]): T => {
    if (name === opts.failAt) throw new Error(`injected failure at ${name}`)
    calls.push(name)
    return ret
  }
  return {
    createStagingDir: step('CREATE_STAGING_DIR', staging),
    writeStagingClip: step('WRITE_STAGING_CLIP', `${staging}/${PINNED_CLIP_ID}.wav`),
    verifyStagingClip: step('VERIFY_STAGING_CLIP', opts.measured ?? MEASURED),
    promoteClip: step('PROMOTE_CLIP', `E:/ud/reference-library/${PINNED_CLIP_ID}.wav`),
    writeManifestTemp: step('WRITE_MANIFEST_TEMP', 'E:/ud/reference-library/manifest.json.deadbeef.tmp'),
    replaceManifest: step('REPLACE_MANIFEST', undefined as void),
  }
}
const promoteRequest = (manifest = emptyManifest()) => ({
  runId: RUN_ID, entry: durableEntry(), durableDir: 'E:/ud/reference-library', manifest, expected: EXPECTED,
})

test('승격: 6단계가 계약 순서 그대로 실행된다', () => {
  const calls: string[] = []
  const r = promoteReferenceClip(fakeEffects(calls), promoteRequest())
  assert.equal(r.status, 'REFERENCE_PROMOTED')
  assert.deepEqual(calls, [...PROMOTE_STEPS])
  assert.deepEqual(r.steps, [...PROMOTE_STEPS])
  assert.equal(r.manifest.records.length, 1)
  assert.equal(r.record?.clip_sha256, CLIP_SHA)
  assert.deepEqual(r.orphanClipIds, [])
  // manifest 교체는 마지막, 승격은 검증 뒤
  assert.equal(calls.indexOf('REPLACE_MANIFEST'), PROMOTE_STEPS.length - 1)
  assert.ok(calls.indexOf('VERIFY_STAGING_CLIP') < calls.indexOf('PROMOTE_CLIP'))
  assert.ok(calls.indexOf('PROMOTE_CLIP') < calls.indexOf('WRITE_MANIFEST_TEMP'))
})

test('승격: 순서를 건너뛰거나 재배열한 열은 거부된다', () => {
  for (const bad of [['WRITE_STAGING_CLIP'], ['CREATE_STAGING_DIR', 'PROMOTE_CLIP'], [...PROMOTE_STEPS].reverse()]) {
    assert.throws(() => assertPromoteOrder(bad),
      (e: unknown) => (e as ReferenceLibraryError).code === 'PROMOTE_ORDER_VIOLATION')
  }
  assert.deepEqual(assertPromoteOrder([...PROMOTE_STEPS].slice(0, 3)), [...PROMOTE_STEPS].slice(0, 3))
})

test('승격: 2~6단계 어디서 실패해도 이전 manifest·클립이 그대로 남는다', () => {
  const prevEntry = buildLibraryEntry({
    sourceSha256: SRC_B, region: { start: 0, duration: 4 }, transcript: '이전 참조',
  })
  const prev = upsertManifestRecord(emptyManifest(), buildManifestRecord(prevEntry, 'e'.repeat(64)))
  const snapshot = jsonCopy(prev)

  PROMOTE_STEPS.slice(1).forEach((step, i) => {
    const calls: string[] = []
    const r = promoteReferenceClip(fakeEffects(calls, { failAt: step }), promoteRequest(prev))
    assert.equal(r.status, 'REFERENCE_PROMOTE_FAILED', step)
    assert.equal(r.failedStep, step)
    assert.deepEqual(calls, [...PROMOTE_STEPS].slice(0, i + 1), `실패 지점까지만 실행: ${step}`)
    assert.equal(calls.includes('REPLACE_MANIFEST'), false, `manifest 교체는 마지막에만: ${step}`)
    assert.deepEqual(jsonCopy(r.manifest), snapshot, `부분 manifest 노출 없음: ${step}`)
    assert.deepEqual(jsonCopy(prev), snapshot, `입력 manifest 원본 불변: ${step}`)
    // 기존 참조는 계속 쓸 수 있다
    const still = resolveReusableClip(r.manifest, {
      sourceSha256: SRC_B, region: { start: 0, duration: 4 }, transcript: '이전 참조',
    })
    assert.equal(still.reusable, true, `기존 참조 계속 사용 가능: ${step}`)
  })
})

test('승격: 클립은 승격됐는데 manifest 기록이 실패하면 고아가 되지만 기존 참조는 멀쩡하다', () => {
  const prevEntry = buildLibraryEntry({
    sourceSha256: SRC_B, region: { start: 0, duration: 4 }, transcript: '이전 참조',
  })
  const prev = upsertManifestRecord(emptyManifest(), buildManifestRecord(prevEntry, 'e'.repeat(64)))
  const calls: string[] = []
  const r = promoteReferenceClip(fakeEffects(calls, { failAt: 'REPLACE_MANIFEST' }), promoteRequest(prev))
  assert.equal(r.status, 'REFERENCE_PROMOTE_FAILED')
  assert.deepEqual(r.orphanClipIds, [PINNED_CLIP_ID])
  assert.equal(r.manifest.records.length, 1)
  const still = resolveReusableClip(r.manifest, {
    sourceSha256: SRC_B, region: { start: 0, duration: 4 }, transcript: '이전 참조',
  })
  assert.equal(still.reusable, true, '고아가 생겨도 기존 참조는 깨지지 않는다')
  assert.equal(isOrphanOwnedByRun(`${PINNED_CLIP_ID}.wav`, r.journal, r.manifest), true)
})

test('승격: 교차 볼륨 staging 은 아무것도 쓰기 전에 차단된다', () => {
  const calls: string[] = []
  const r = promoteReferenceClip(fakeEffects(calls, { staging: 'C:/Temp/run-deadbeef' }), promoteRequest())
  assert.equal(r.status, 'REFERENCE_PROMOTE_FAILED')
  assert.equal(r.errorCode, 'CROSS_DEVICE_PROMOTION')
  assert.deepEqual(r.steps, [], '볼륨이 다르면 아무것도 쓰지 않는다')
  assert.deepEqual(r.orphanClipIds, [])
})

test('승격: 검증 실패는 4단계(승격)로 넘어가지 않는다', () => {
  const broken: Partial<typeof MEASURED>[] = [
    { decodable: false }, { all_samples_finite: false }, { sample_rate: 16000 },
    { channel_count: 2 }, { duration_ms: 9000 }, { clip_sha256: 'nope' },
  ]
  for (const patch of broken) {
    const calls: string[] = []
    const r = promoteReferenceClip(fakeEffects(calls, { measured: { ...MEASURED, ...patch } }), promoteRequest())
    assert.equal(r.status, 'REFERENCE_PROMOTE_FAILED', JSON.stringify(patch))
    assert.equal(r.errorCode, 'CLIP_VERIFICATION_FAILED', JSON.stringify(patch))
    assert.equal(calls.includes('PROMOTE_CLIP'), false, `검증 실패면 승격하지 않는다: ${JSON.stringify(patch)}`)
    assert.deepEqual(r.orphanClipIds, [])
  }
})

test('승격 검증 항목 목록이 곧 계약', () => {
  const allBad = evaluateClipVerification(
    { decodable: false, all_samples_finite: false, sample_rate: 1, channel_count: 2, duration_ms: 3, clip_sha256: 'x' },
    EXPECTED)
  assert.deepEqual([...allBad].sort(), [...CLIP_VERIFICATION_CHECKS].sort())
  assert.deepEqual(evaluateClipVerification(MEASURED, EXPECTED), [])
})

test('run 스코프 이름 + 고아 소유 판정(접두사 일치만으로는 소유가 아니다)', () => {
  assert.equal(runScopedStagingDirName(RUN_ID), 'run-deadbeef')
  assert.equal(runJournalFileName(RUN_ID), 'run-deadbeef.journal.json')
  assert.equal(manifestTempFileName(RUN_ID), 'manifest.json.deadbeef.tmp')
  assert.equal(isRunScopedName('run-deadbeef', RUN_ID), true)
  assert.equal(isRunScopedName('run-deadbeefX', RUN_ID), false)
  assert.equal(isRunScopedName('run-cafebabe', RUN_ID), false)
  assert.throws(() => runScopedStagingDirName('nope'),
    (e: unknown) => (e as ReferenceLibraryError).code === 'INVALID_FINGERPRINT_INPUT')

  const journal = buildRunJournal(RUN_ID, [PINNED_CLIP_ID])
  const empty = emptyManifest()
  assert.equal(isOrphanOwnedByRun(`${PINNED_CLIP_ID}.wav`, journal, empty), true)
  for (const foreign of ['somebody-else.wav', `${PINNED_CLIP_ID}_old.wav`, `${PINNED_CLIP_ID.slice(0, 8)}.wav`,
    '0123456789abcdef.wav', 'manifest.json', '']) {
    assert.equal(isOrphanOwnedByRun(foreign, journal, empty), false, foreign)
  }
  // manifest 에 등재된 것은 고아가 아니다 → 절대 삭제 대상이 아니다
  const listed = upsertManifestRecord(empty, buildManifestRecord(durableEntry(), CLIP_SHA))
  assert.equal(isOrphanOwnedByRun(`${PINNED_CLIP_ID}.wav`, journal, listed), false)
  assert.equal(isOrphanOwnedByRun(`${PINNED_CLIP_ID}.wav`, { run_id: RUN_ID, clip_ids: [] }, empty), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// 8) PARITY — python/reference_library.py 소스를 파싱해 코드 집합·버전 대조
// ─────────────────────────────────────────────────────────────────────────────
const PY_SRC = readFileSync(
  fileURLToPath(new URL('../../python/reference_library.py', import.meta.url)), 'utf-8')

/** module-level `NAME = "literal"` 수집(주석 허용). 밑줄 시작 내부 상수는 제외. */
function pyStringConsts(src: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of src.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"\s*(?:#.*)?$/gm)) out[m[1]] = m[2]
  return out
}
function pyIntConst(src: string, name: string): number {
  const m = new RegExp(`^${name}\\s*=\\s*(\\d+)`, 'm').exec(src)
  assert.ok(m, `python 에서 ${name} 를 찾지 못함`)
  return Number(m![1])
}
/** `NAME = ( IDENT, IDENT, ... )` 튜플 멤버 식별자 목록. */
function pyTupleIdents(src: string, name: string): string[] {
  const m = new RegExp(`^${name}\\s*=\\s*\\(([\\s\\S]*?)\\)`, 'm').exec(src)
  assert.ok(m, `python 에서 ${name} 튜플을 찾지 못함`)
  return m![1].split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}
/** `NAME = ( "lit", "lit", ... )` 튜플의 문자열 리터럴 목록(선언 순서 그대로). */
function pyQuotedList(src: string, name: string, item: RegExp): string[] {
  const m = new RegExp(`^${name}\\s*=\\s*\\(([\\s\\S]*?)\\n\\)`, 'm').exec(src)
  assert.ok(m, `python 에서 ${name} 튜플을 찾지 못함`)
  return [...m![1].matchAll(item)].map((x) => x[1])
}

test('parity: 분석 버전 상수가 TS == Python', () => {
  assert.equal(pyIntConst(PY_SRC, 'REFERENCE_ANALYSIS_VERSION'), REFERENCE_ANALYSIS_VERSION)
})

test('parity: 무효화 사유 코드 집합이 TS == Python', () => {
  const consts = pyStringConsts(PY_SRC)
  const pyReasons = pyTupleIdents(PY_SRC, 'REFERENCE_INVALIDATION_REASONS').map((ident) => {
    assert.ok(ident in consts, `python 상수 ${ident} 의 리터럴을 찾지 못함`)
    assert.equal(consts[ident], ident, `python ${ident} 값은 이름과 같아야 한다`)
    return consts[ident]
  })
  assert.deepEqual([...pyReasons].sort(), [...REFERENCE_INVALIDATION_REASONS].sort())
})

test('parity: 가드 코드 집합이 TS == Python', () => {
  const consts = pyStringConsts(PY_SRC)
  const pyCodes = pyTupleIdents(PY_SRC, 'REFERENCE_GUARD_CODES').map((ident) => {
    assert.ok(ident in consts, `python 상수 ${ident} 의 리터럴을 찾지 못함`)
    return consts[ident]
  })
  assert.deepEqual([...pyCodes].sort(), [...REFERENCE_GUARD_CODES].sort())
})

test('parity: 재탐색/승격 상태 집합이 TS == Python', () => {
  const consts = pyStringConsts(PY_SRC)
  const resolve = (name: string) => pyTupleIdents(PY_SRC, name).map((ident) => {
    assert.ok(ident in consts, `python 상수 ${ident} 의 리터럴을 찾지 못함`)
    assert.equal(consts[ident], ident, `python ${ident} 값은 이름과 같아야 한다`)
    return consts[ident]
  })
  assert.deepEqual(resolve('REFERENCE_SCAN_STATUSES').sort(), [...REFERENCE_SCAN_STATUSES].sort())
  assert.deepEqual(resolve('REFERENCE_PROMOTE_STATUSES').sort(), [...REFERENCE_PROMOTE_STATUSES].sort())
})

test('parity: 승격 단계 순서와 검증 항목이 TS == Python(순서까지)', () => {
  // 순서 자체가 계약이므로 정렬하지 않는다.
  const pySteps = pyQuotedList(PY_SRC, 'PROMOTE_STEPS', /"([A-Z][A-Z0-9_]*)"/g)
  assert.deepEqual(pySteps, [...PROMOTE_STEPS])
  const pyChecks = pyQuotedList(PY_SRC, 'CLIP_VERIFICATION_CHECKS', /"([a-z0-9_]+)"/g)
  assert.deepEqual(pyChecks, [...CLIP_VERIFICATION_CHECKS])
  const pyFields = pyQuotedList(PY_SRC, 'MANIFEST_RECORD_FIELDS', /"([a-z0-9_]+)"/g)
  assert.deepEqual(pyFields, [...MANIFEST_RECORD_FIELDS])
})

test('parity: 영속 저장소 상수가 TS == Python', () => {
  const consts = pyStringConsts(PY_SRC)
  assert.equal(pyIntConst(PY_SRC, 'MANIFEST_VERSION'), MANIFEST_VERSION)
  assert.equal(consts.REFERENCE_LIBRARY_DIR_NAME, REFERENCE_LIBRARY_DIR_NAME)
  assert.equal(consts.REFERENCE_STAGING_DIR_NAME, REFERENCE_STAGING_DIR_NAME)
  assert.equal(consts.MANIFEST_FILE_NAME, MANIFEST_FILE_NAME)
  assert.equal(consts.CLIP_FILE_EXTENSION, CLIP_FILE_EXTENSION)
  assert.equal(consts.RUN_SCOPE_PREFIX, RUN_SCOPE_PREFIX)
  assert.equal(consts.RUN_JOURNAL_SUFFIX, RUN_JOURNAL_SUFFIX)
  assert.equal(consts.MANIFEST_TEMP_SUFFIX, MANIFEST_TEMP_SUFFIX)
})

test('parity: 정책/직렬화 상수가 TS == Python', () => {
  assert.equal(pyIntConst(PY_SRC, 'MAX_AUTO_CANDIDATES'), MAX_AUTO_CANDIDATES)
  assert.equal(pyIntConst(PY_SRC, 'MIN_REGION_MS'), MIN_REGION_MS)
  assert.equal(pyIntConst(PY_SRC, 'MAX_REGION_MS'), MAX_REGION_MS)
  assert.equal(pyIntConst(PY_SRC, 'CLIP_ID_LENGTH'), CLIP_ID_LENGTH)
  const consts = pyStringConsts(PY_SRC)
  assert.equal(consts.FINGERPRINT_PAYLOAD_HEADER, FINGERPRINT_PAYLOAD_HEADER)
  assert.equal(consts.CLIP_ID_PAYLOAD_HEADER, CLIP_ID_PAYLOAD_HEADER)
})

test('parity: 이 모듈의 sha256 이 ttsGrammar.sha256 과 동일 값', () => {
  for (const s of ['', 'abc', PINNED_PAYLOAD, '한글 전사 텍스트 🎧']) {
    assert.equal(sha256HexOfString(s), grammarSha256(s), `sha256 mismatch for length ${s.length}`)
  }
  assert.equal(sha256HexOfString('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('원본 미조작 계약: 이 모듈은 fs/네트워크 API 를 참조하지 않는다', () => {
  const tsSrc = readFileSync(fileURLToPath(new URL('./referenceLibrary.ts', import.meta.url)), 'utf-8')
  for (const banned of ['node:fs', "from 'fs'", 'require(', 'fetch(', 'XMLHttpRequest', 'electron', 'writeFile']) {
    assert.equal(tsSrc.includes(banned), false, `금지 참조: ${banned}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 9) 패널 계약 — props 전용(store/IPC 미사용) + 경로 미표시
// ─────────────────────────────────────────────────────────────────────────────
test('패널: store import·IPC 호출·절대경로 표시가 없다(소스 계약)', () => {
  const panel = readFileSync(
    fileURLToPath(new URL('../renderer/components/ReferenceLibraryPanel.tsx', import.meta.url)), 'utf-8')
  for (const banned of ['useAppStore', 'app.store', 'window.api', 'ipcRenderer', 'node:fs', 'electron']) {
    assert.equal(panel.includes(banned), false, `패널 금지 참조: ${banned}`)
  }
  // 콜백 3종을 props 로 받는다(미리듣기 / 기본 지정 / 재탐색)
  for (const cb of ['onAudition', 'onSetDefault', 'onRescan']) {
    assert.ok(panel.includes(`${cb}:`), `패널 props 에 ${cb} 없음`)
  }
  // 접근성: 실제 button + aria-label
  assert.ok(panel.includes('type="button"'))
  assert.ok((panel.match(/aria-label=/g) || []).length >= 4)
  // 렌더 텍스트에 경로가 들어갈 여지가 없다(경로 계열 prop 자체가 없음)
  for (const pathProp of ['path:', 'sourcePath', 'clipPath', 'filePath']) {
    assert.equal(panel.includes(pathProp), false, `패널에 경로 prop: ${pathProp}`)
  }
})
