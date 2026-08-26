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
  MAX_AUTO_CANDIDATES, MIN_REGION_MS, MAX_REGION_MS, CLIP_ID_LENGTH,
  FINGERPRINT_PAYLOAD_HEADER, CLIP_ID_PAYLOAD_HEADER, VOLATILE_AXES,
  ReferenceLibraryError,
  buildFingerprintPayload, computeFingerprint, computeFingerprintFromRequest, deriveClipId,
  normalizeTranscript, secondsToMs, evaluateReuse,
  intervalsOverlap, selectBestCandidate, pickAutoCandidates,
  buildCandidate, buildLibraryEntry, assertCandidateSetValid, assertSingleReference,
  buildSynthesisReference, candidateFromPython,
  findSensitiveStrings, isPathLike, sha256HexOfString,
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
