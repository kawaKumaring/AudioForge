// 재사용 가능한 참조 클립 라이브러리 — 순수 로직(fs/Electron/React 없음, 의존성 0).
//
// 목적: 확정된 3~10초 참조 클립을 "재사용 가능한 자산"으로 만든다. 대본·속도·감정·피치를 바꿔도
// 지문(fingerprint)이 같으면 재분석 없이 그 클립을 그대로 쓴다.
//
// 권위 분담:
//   - 정규 직렬화(canonical serialization)의 단일 정의는 buildFingerprintPayload 하나뿐이고,
//     python/reference_library.py 의 build_fingerprint_payload 가 이를 바이트 단위로 미러링한다.
//     (양쪽 테스트가 같은 고정 벡터를 검증 → TS == Python)
//   - 이 파일은 파일 해시를 절대 스스로 계산하지 않는다. 원본 SHA-256은 '입력으로 받는다'
//     (main 프로세스/Python 이 계산). 렌더러가 사용자 미디어를 읽지 않도록 하기 위한 경계다.
//   - 원본 미디어는 절대 변경하지 않는다. 외부 전송 없음. 저장 구조에는 경로·전사 원문이 없다.
//   - 참조 동일성의 단일 권위는 '내용 해시'다. path|size|mtime 조합은 캐시 권위로 쓰지 않는다
//     (파일을 옮기면 틀리고, 이름·크기가 같은 채 내용만 바뀌어도 틀린다). referenceCacheKey 가 강제한다.
//   - 영속 저장(durable library): 확정 클립은 앱 소유 영속 디렉터리에 남아 재시작 후에도 재사용된다.
//     manifest 는 해시와 clipId 만 담고 경로는 영원히 담지 않는다.
//   - 승격(promote)은 PROMOTE_STEPS 순서를 promoteReferenceClip 이 고정한다(호출부가 틀릴 수 없다).
//   - 재탐색(rescan)은 기존 후보 구간을 명시적 제외 입력으로 받는다(rescanCandidates).

// ── 분석 버전 — 알고리즘/지표 정의가 바뀌면 올린다(= 기존 지문 전량 무효화). Python과 동일해야 한다. ──
export const REFERENCE_ANALYSIS_VERSION = 1

// ── 무효화 사유 코드 — 원인마다 서로 구분되는 고유 코드. Python REFERENCE_INVALIDATION_REASONS 와 동일 집합. ──
export const REFERENCE_INVALIDATION_REASONS = [
  'REF_SOURCE_CHANGED',            // 원본 파일이 다름(SHA-256 불일치)
  'REF_REGION_CHANGED',            // 확정 구간(start 또는 duration)이 다름
  'REF_TRANSCRIPT_CHANGED',        // 참조 전사문이 다름
  'REF_ANALYSIS_VERSION_CHANGED',  // 분석 버전 상향(알고리즘 변경)
] as const
export type ReferenceInvalidationReason = (typeof REFERENCE_INVALIDATION_REASONS)[number]

// ── 가드 코드 — 구조/선택 불변식 위반. Python REFERENCE_GUARD_CODES 와 동일 집합. ──
export const REFERENCE_GUARD_CODES = [
  'NO_REFERENCE_SELECTED',         // 선택된 참조가 0개
  'MULTIPLE_REFERENCES_SELECTED',  // 선택된 참조가 2개 이상(합성 경로 위반)
  'UNKNOWN_REFERENCE_SELECTED',    // 저장된 후보에 없는 id
  'OVERLAPPING_CANDIDATES',        // 저장 후보끼리 구간이 겹침
  'TOO_MANY_CANDIDATES',           // 후보 3개 초과
  'INVALID_FINGERPRINT_INPUT',     // 지문 입력이 규격 위반
  'UNKNOWN_REFERENCE_ASSET',       // manifest에 기록되지 않은 자산 조회/삭제
  'CROSS_DEVICE_PROMOTION',        // staging↔durable 볼륨이 달라 원자적 승격 불가
  'CLIP_CHECKSUM_MISMATCH',        // 저장된 클립 체크섬이 manifest와 불일치
  'MANIFEST_CONTAINS_PATH',        // manifest에 경로 문자열이 섞임(절대 금지)
  'PROMOTE_ORDER_VIOLATION',       // 승격 단계 순서 위반(건너뜀/재배열)
  'CLIP_VERIFICATION_FAILED',      // staging 클립 검증 실패(디코드/샘플/규격)
] as const
export type ReferenceGuardCode = (typeof REFERENCE_GUARD_CODES)[number]

// ── 재탐색(rescan) 결과 상태 — 예외가 아니라 구조화 상태. Python 과 동일 집합. ──
export const REFERENCE_SCAN_STATUSES = [
  'REFERENCE_CANDIDATES_FOUND',    // 새 후보를 1개 이상 찾음
  'NO_MORE_REFERENCE_CANDIDATES',  // 남은 유효 구간 없음(빈 배열을 조용히 주지 않는다)
] as const
export type ReferenceScanStatus = (typeof REFERENCE_SCAN_STATUSES)[number]

// ── 승격(promote) 결과 상태 — 예외가 아니라 구조화 상태. Python 과 동일 집합. ──
export const REFERENCE_PROMOTE_STATUSES = [
  'REFERENCE_PROMOTED',            // 6단계 전부 성공(manifest 교체까지)
  'REFERENCE_PROMOTE_FAILED',      // 중간 실패 — 기존 manifest/클립 불변
] as const
export type ReferencePromoteStatus = (typeof REFERENCE_PROMOTE_STATUSES)[number]

// ── 정책 상수(Python 과 동일 값) ──
export const MAX_AUTO_CANDIDATES = 3
export const MIN_REGION_MS = 3000
export const MAX_REGION_MS = 10000

// ── 영속(durable) 저장소 계약 — 디렉터리 해석/파일 이동은 main(통합 담당) 소유. ──
// 레이아웃:  <app userData>/reference-library/manifest.json           ← manifest(원자적 교체 대상)
//            <app userData>/reference-library/<clipId>.wav           ← 영속 자산
//            <app userData>/reference-library/staging/run-<runId>/   ← 이 실행(run) 전용 staging
//            <app userData>/reference-library/staging/run-<runId>.journal.json ← 이 run이 만든 clipId 목록
//
// OS temp 은 영속 위치가 아니다. staging 은 "캐시 어딘가"가 아니라 durable 대상의 부모와 같은
// 볼륨/파일시스템 아래에 만든 run 스코프 디렉터리여야 한다. C:\ staging + E:\ durable 조합은
// 승격 시점에 정확히 터진다(교차 볼륨 rename 은 Windows 에서 예외, 복사+삭제는 원자적이지 않다).
export const MANIFEST_VERSION = 1
export const REFERENCE_LIBRARY_DIR_NAME = 'reference-library'
export const REFERENCE_STAGING_DIR_NAME = 'staging'
export const MANIFEST_FILE_NAME = 'manifest.json'
export const CLIP_FILE_EXTENSION = '.wav'
/** manifest 레코드에 허용되는 필드 — 이 목록이 전부다(경로 필드는 영원히 없다). */
export const MANIFEST_RECORD_FIELDS = [
  'clip_id',
  'fingerprint',
  'source_sha256',
  'region_start_ms',
  'region_duration_ms',
  'transcript_sha256',
  'analysis_version',
  'clip_sha256',
] as const

// ── 승격 순서 — 이 순서가 계약이다. 건너뛰거나 재배열하면 PROMOTE_ORDER_VIOLATION. ──
//   1 staging 디렉터리 생성(durable 부모와 같은 볼륨, run 스코프)
//   2 staging 에 WAV 기록
//   3 검증: 디코드 / 전 샘플 유한 / 샘플레이트 / 채널 수 / 길이 / 체크섬
//   4 클립을 durable 로 원자적 승격
//   5 manifest 를 임시 파일에 기록하고 플랫폼이 허용하는 만큼 flush
//   6 manifest 를 마지막에 원자적으로 교체
export const PROMOTE_STEPS = [
  'CREATE_STAGING_DIR',
  'WRITE_STAGING_CLIP',
  'VERIFY_STAGING_CLIP',
  'PROMOTE_CLIP',
  'WRITE_MANIFEST_TEMP',
  'REPLACE_MANIFEST',
] as const
export type PromoteStep = (typeof PROMOTE_STEPS)[number]

/** 3단계에서 반드시 확인해야 하는 항목(하나라도 실패하면 승격하지 않는다). */
export const CLIP_VERIFICATION_CHECKS = [
  'decodable',
  'all_samples_finite',
  'sample_rate',
  'channel_count',
  'duration_ms',
  'clip_sha256',
] as const
export const RUN_SCOPE_PREFIX = 'run-'
export const RUN_JOURNAL_SUFFIX = '.journal.json'
export const MANIFEST_TEMP_SUFFIX = '.tmp'

const RUN_ID_RE = /^[0-9a-f]{8,32}$/

// ── 정규 직렬화 상수 — Python 과 문자 단위로 동일해야 한다. ──
export const FINGERPRINT_PAYLOAD_HEADER = 'reflib-fp/1'
export const FINGERPRINT_FIELD_SEPARATOR = '\n'
export const FINGERPRINT_FIELD_ORDER = [
  'analysis_version',
  'source_sha256',
  'region_start_ms',
  'region_duration_ms',
  'transcript_sha256',
] as const
export const CLIP_ID_PAYLOAD_HEADER = 'reflib-clip/1'
export const CLIP_ID_LENGTH = 16

// 지문에 절대 들어가지 않는 축 — 바뀌어도 재분석/무효화하지 않는다(요구 2).
export const VOLATILE_AXES = ['script', 'speed', 'emotionId', 'pitch'] as const

const SHA256_RE = /^[0-9a-f]{64}$/
// 정규화 시 양끝에서 제거하는 공백 — ASCII 6종으로 명시(언어별 trim/strip 차이 제거).
const TRIM_CHARS = ' \t\n\r\f\v'

export class ReferenceLibraryError extends Error {
  readonly code: ReferenceGuardCode
  readonly detail: string
  constructor(code: ReferenceGuardCode, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'ReferenceLibraryError'
    this.code = code
    this.detail = detail
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 타입 계약
// ─────────────────────────────────────────────────────────────────────────────
/** 확정 구간(초). app.store 의 ttsReferenceRegion / ttsEmotionRefState.region 과 같은 모양. */
export interface ReferenceRegionSec {
  start: number
  duration: number
}

/** 지문에 들어가는 입력 — 이 4가지가 전부다. */
export interface ReferenceFingerprintInput {
  /** 원본 파일의 SHA-256(소문자 hex 64). TS는 계산하지 않고 받기만 한다. */
  sourceSha256: string
  region: ReferenceRegionSec
  transcript: string
  analysisVersion?: number
}

/** 지문에 들어가지 않는 축. 계약에 명시해 "여기 있어도 무시된다"를 타입으로 남긴다. */
export interface ReferenceVolatileAxes {
  script?: string
  speed?: number
  emotionId?: string
  pitch?: number
}

/** 합성 요청 컨텍스트 = 지문 입력 + 무시되는 축. */
export type ReferenceRequest = ReferenceFingerprintInput & ReferenceVolatileAxes

/** 저장된 항목의 지문 입력(+ 이미 계산된 지문이 있으면 그것). */
export type StoredReferenceFingerprint = ReferenceFingerprintInput & { fingerprint?: string }

export interface ReferenceReuseVerdict {
  reusable: boolean
  reasons: ReferenceInvalidationReason[]
  fingerprint: string
  storedFingerprint: string
}

/** 후보 품질 지표 — 숫자만(UI가 "왜 추천됐는지" 보여주기 위한 값). */
export interface ReferenceQualityMetrics {
  silenceRatio: number
  clippingRatio: number
  rmsDbfs: number
  peak: number
  speechRatio: number
}

/** 저장/전송용 후보 1개 — 경로도 전사 원문도 없다. id는 불투명 클립 식별자. */
export interface ReferenceCandidate {
  id: string
  startMs: number
  durationMs: number
  score: number
  metrics: ReferenceQualityMetrics
}

/** 영속 저장 항목 — 파생 클립 메타데이터만. */
export interface ReferenceLibraryEntry {
  fingerprint: string
  analysisVersion: number
  sourceSha256: string
  transcriptSha256: string
  regionStartMs: number
  regionDurationMs: number
  candidates: ReferenceCandidate[]
  defaultCandidateId: string
}

/**
 * 합성/샘플러 경로로 넘기는 payload — 정확히 하나의 클립.
 * 샘플러는 여기 담긴 fingerprint/cacheKey 를 그대로 쓰고 자기 나름의 지문을 만들지 않는다.
 */
export interface SynthesisReference {
  clipId: string
  startMs: number
  durationMs: number
  fingerprint: string
  sourceSha256: string
  cacheKey: string
  analysisVersion: number
}

/** 캐시/샘플러가 소비하는 참조 동일성 묶음. 경로·크기·mtime 은 포함되지 않는다. */
export interface ReferenceIdentity {
  fingerprint: string
  cacheKey: string
  sourceSha256: string
  analysisVersion: number
}

/**
 * 영속 manifest 레코드 — 디스크에 저장되는 유일한 형태.
 * 필드명은 Python 과 바이트 동일한 snake_case(같은 JSON 파일을 양쪽이 읽는다).
 * 경로 필드는 없고, 앞으로도 추가하지 않는다.
 */
export interface ReferenceManifestRecord {
  clip_id: string
  fingerprint: string
  source_sha256: string
  region_start_ms: number
  region_duration_ms: number
  transcript_sha256: string
  analysis_version: number
  /** durable 에 실제로 저장된 클립 파일의 sha256 — 재시작 후 무결성 검증용. */
  clip_sha256: string
}

export interface ReferenceManifest {
  manifest_version: number
  records: ReferenceManifestRecord[]
}

/** 재시작 후 재사용 조회 결과. clipId → 실제 경로 변환은 main 소유. */
export interface ResolvedReferenceClip {
  reusable: boolean
  clipId: string | null
  fileName: string | null
  record: ReferenceManifestRecord | null
  fingerprint: string
  reasons: ReferenceInvalidationReason[]
}

/** 재탐색 결과 — 기존 후보는 순서 그대로 보존된다. */
export interface RescanResult {
  status: ReferenceScanStatus
  added: ScoredInterval[]
  candidates: ScoredInterval[]
  excludedCount: number
  room: number
}

/** 삭제 계획 — 그 레코드가 소유한 자산만. prefix 청소를 하지 않는다. */
export interface AssetDeletionPlan {
  clipId: string
  fileNames: string[]
}

/** 후보 탐색 입력(점수화된 구간). id는 선택적 — 동점 tie-break에만 쓰인다. */
export interface ScoredInterval {
  startMs: number
  durationMs: number
  score: number
  id?: string
  metrics?: Partial<ReferenceQualityMetrics>
}

// ─────────────────────────────────────────────────────────────────────────────
// 정규화 helper — Python 과 동일 규칙
// ─────────────────────────────────────────────────────────────────────────────
/** 전사 정규화: ASCII 공백 6종만 양끝에서 제거. 내부는 손대지 않는다. */
export function normalizeTranscript(text: string | null | undefined): string {
  if (text == null) return ''
  const s = String(text)
  let a = 0
  let b = s.length
  while (a < b && TRIM_CHARS.includes(s[a])) a++
  while (b > a && TRIM_CHARS.includes(s[b - 1])) b--
  return s.slice(a, b)
}

/** 초 → 정수 ms. floor(x*1000 + 0.5) — 반올림 규칙을 Python 과 동일하게 고정한다. */
export function secondsToMs(seconds: number): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    throw new ReferenceLibraryError('INVALID_FINGERPRINT_INPUT', 'seconds must be finite and >= 0')
  }
  return Math.floor(seconds * 1000 + 0.5)
}

function requireSha256(value: string | null | undefined, field: string): string {
  const v = String(value ?? '').trim().toLowerCase()
  if (!SHA256_RE.test(v)) {
    throw new ReferenceLibraryError('INVALID_FINGERPRINT_INPUT', `${field} must be 64 lowercase hex chars`)
  }
  return v
}

// ─────────────────────────────────────────────────────────────────────────────
// 지문(fingerprint) — 정규 직렬화의 단일 권위
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 지문 계산에 쓰이는 정규 문자열(이 포맷이 곧 계약). 끝 개행 없음:
 *
 *   reflib-fp/1
 *   analysis_version=<정수>
 *   source_sha256=<소문자 hex 64>
 *   region_start_ms=<정수>
 *   region_duration_ms=<정수>
 *   transcript_sha256=<소문자 hex 64>
 *
 * - 필드 순서는 FINGERPRINT_FIELD_ORDER 고정, 구분자는 개행 1개, 각 줄은 key=value.
 * - 초는 floor(sec*1000+0.5)로 정수 ms 변환 후 10진 표기(부호·자릿수 구분자 없음).
 * - 전사는 normalizeTranscript 후 UTF-8 sha256(원문은 payload에 담기지 않는다).
 */
export function buildFingerprintPayload(input: ReferenceFingerprintInput): string {
  const analysisVersion = input.analysisVersion ?? REFERENCE_ANALYSIS_VERSION
  if (!Number.isInteger(analysisVersion) || analysisVersion < 0) {
    throw new ReferenceLibraryError('INVALID_FINGERPRINT_INPUT', 'analysisVersion must be a non-negative int')
  }
  const values: Record<string, string> = {
    analysis_version: String(analysisVersion),
    source_sha256: requireSha256(input.sourceSha256, 'source_sha256'),
    region_start_ms: String(secondsToMs(input.region?.start ?? 0)),
    region_duration_ms: String(secondsToMs(input.region?.duration ?? 0)),
    transcript_sha256: sha256HexOfString(normalizeTranscript(input.transcript)),
  }
  const lines = [FINGERPRINT_PAYLOAD_HEADER as string]
  for (const key of FINGERPRINT_FIELD_ORDER) lines.push(`${key}=${values[key]}`)
  return lines.join(FINGERPRINT_FIELD_SEPARATOR)
}

/** 정규 문자열의 sha256 hex(64자). 같은 입력이면 항상 같은 값(프로세스/OS 무관). */
export function computeFingerprint(input: ReferenceFingerprintInput): string {
  return sha256HexOfString(buildFingerprintPayload(input))
}

/** 합성 요청에서 지문 계산 — VOLATILE_AXES(script/speed/emotionId/pitch)는 읽지도 않는다. */
export function computeFingerprintFromRequest(request: ReferenceRequest): string {
  return computeFingerprint({
    sourceSha256: request.sourceSha256,
    region: request.region,
    transcript: request.transcript,
    analysisVersion: request.analysisVersion,
  })
}

/** 파생 클립의 불투명 id(hex 16자). 경로가 아니다 — 경로 매핑은 main 프로세스 소유. */
export function deriveClipId(sourceSha256: string, startSec: number, durationSec: number): string {
  const payload = [
    CLIP_ID_PAYLOAD_HEADER,
    `source_sha256=${requireSha256(sourceSha256, 'source_sha256')}`,
    `start_ms=${secondsToMs(startSec)}`,
    `duration_ms=${secondsToMs(durationSec)}`,
  ].join(FINGERPRINT_FIELD_SEPARATOR)
  return sha256HexOfString(payload).slice(0, CLIP_ID_LENGTH)
}

// ─────────────────────────────────────────────────────────────────────────────
// 재사용 / 무효화
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 저장된 항목을 요청에 재사용할 수 있는지 판정한다.
 * reasons 는 REFERENCE_INVALIDATION_REASONS 순서로 정렬돼 결정적이다.
 * 대본/속도/감정/피치가 아무리 바뀌어도 reasons 는 비어 있다(요구 2).
 */
export function evaluateReuse(stored: StoredReferenceFingerprint, requested: ReferenceRequest): ReferenceReuseVerdict {
  const sVersion = stored.analysisVersion ?? REFERENCE_ANALYSIS_VERSION
  const rVersion = requested.analysisVersion ?? REFERENCE_ANALYSIS_VERSION
  const storedFingerprint = stored.fingerprint || computeFingerprint(stored)
  const fingerprint = computeFingerprintFromRequest(requested)

  const reasons: ReferenceInvalidationReason[] = []
  if (requireSha256(stored.sourceSha256, 'source_sha256') !== requireSha256(requested.sourceSha256, 'source_sha256')) {
    reasons.push('REF_SOURCE_CHANGED')
  }
  if (secondsToMs(stored.region?.start ?? 0) !== secondsToMs(requested.region?.start ?? 0)
    || secondsToMs(stored.region?.duration ?? 0) !== secondsToMs(requested.region?.duration ?? 0)) {
    reasons.push('REF_REGION_CHANGED')
  }
  if (normalizeTranscript(stored.transcript) !== normalizeTranscript(requested.transcript)) {
    reasons.push('REF_TRANSCRIPT_CHANGED')
  }
  if (sVersion !== rVersion) reasons.push('REF_ANALYSIS_VERSION_CHANGED')

  reasons.sort((a, b) => REFERENCE_INVALIDATION_REASONS.indexOf(a) - REFERENCE_INVALIDATION_REASONS.indexOf(b))
  return {
    reusable: reasons.length === 0 && storedFingerprint === fingerprint,
    reasons,
    fingerprint,
    storedFingerprint,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 자동 후보 선택 — 순수 구간 연산
// ─────────────────────────────────────────────────────────────────────────────
export function intervalEndMs(iv: { startMs: number; durationMs: number }): number {
  return iv.startMs + iv.durationMs
}

/**
 * 겹침 규칙: 구간은 반열린 [start, start+duration).
 * 끝점이 맞닿는 경우(a.end === b.start)는 "겹치지 않음"으로 본다.
 * 즉 겹침 ⇔ a.start < b.end AND b.start < a.end.
 */
export function intervalsOverlap(
  a: { startMs: number; durationMs: number },
  b: { startMs: number; durationMs: number },
): boolean {
  return a.startMs < intervalEndMs(b) && b.startMs < intervalEndMs(a)
}

// 점수 내림차순 → start 오름차순 → duration 오름차순 → id 오름차순(완전 결정적)
function betterThan(a: ScoredInterval, b: ScoredInterval): boolean {
  if (a.score !== b.score) return a.score > b.score
  if (a.startMs !== b.startMs) return a.startMs < b.startMs
  if (a.durationMs !== b.durationMs) return a.durationMs < b.durationMs
  return String(a.id ?? '') < String(b.id ?? '')
}

export interface CandidateSearchOptions {
  minDurationMs?: number
  maxDurationMs?: number
}

/**
 * 점수화된 구간들 중, 이미 확보된 구간(taken) 어느 것과도 겹치지 않는 최고 점수 구간 1개.
 * 없으면 null. 순수 함수 — 입력 배열을 변형하지 않는다.
 * 길이 정책([min,max] ms) 밖이거나 durationMs<=0 인 구간은 애초에 후보가 아니다.
 */
export function selectBestCandidate(
  scored: readonly ScoredInterval[],
  taken: readonly { startMs: number; durationMs: number }[] = [],
  options: CandidateSearchOptions = {},
): ScoredInterval | null {
  const minMs = options.minDurationMs ?? MIN_REGION_MS
  const maxMs = options.maxDurationMs ?? MAX_REGION_MS
  let best: ScoredInterval | null = null
  for (const iv of scored ?? []) {
    if (iv.durationMs <= 0 || iv.durationMs < minMs || iv.durationMs > maxMs) continue
    if (iv.startMs < 0) continue
    if (taken.some((t) => intervalsOverlap(iv, t))) continue
    if (best === null || betterThan(iv, best)) best = iv
  }
  return best
}

/**
 * 서로 겹치지 않는 자동 추천 후보를 최대 maxCount 개 고른다.
 * 한 후보가 선택되면 다음 탐색의 taken 에 들어가 제외된다(요구 4).
 */
export function pickAutoCandidates(
  scored: readonly ScoredInterval[],
  maxCount: number = MAX_AUTO_CANDIDATES,
  taken: readonly { startMs: number; durationMs: number }[] = [],
  options: CandidateSearchOptions = {},
): ScoredInterval[] {
  const picked: ScoredInterval[] = []
  const acc: { startMs: number; durationMs: number }[] = [...taken]
  for (let i = 0; i < Math.max(0, maxCount); i++) {
    const best = selectBestCandidate(scored, acc, options)
    if (best === null) break
    picked.push(best)
    acc.push(best)
  }
  return picked
}

// ─────────────────────────────────────────────────────────────────────────────
// 저장 구조 + 단일 참조 보증
// ─────────────────────────────────────────────────────────────────────────────
function metric(value: unknown): number {
  const v = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(v) ? v : 0
}

/** 저장/전송용 후보 1개. 경로·전사 원문 없음, 지표는 숫자만. */
export function buildCandidate(
  sourceSha256: string,
  startSec: number,
  durationSec: number,
  metrics: Partial<ReferenceQualityMetrics> = {},
  score = 0,
): ReferenceCandidate {
  return {
    id: deriveClipId(sourceSha256, startSec, durationSec),
    startMs: secondsToMs(startSec),
    durationMs: secondsToMs(durationSec),
    score: metric(score),
    metrics: {
      silenceRatio: metric(metrics.silenceRatio),
      clippingRatio: metric(metrics.clippingRatio),
      rmsDbfs: metric(metrics.rmsDbfs),
      peak: metric(metrics.peak),
      speechRatio: metric(metrics.speechRatio),
    },
  }
}

/** 저장 후보 집합 불변식: 3개 이하 + 서로 겹치지 않음. */
export function assertCandidateSetValid(candidates: readonly ReferenceCandidate[]): ReferenceCandidate[] {
  const list = [...(candidates ?? [])]
  if (list.length > MAX_AUTO_CANDIDATES) {
    throw new ReferenceLibraryError('TOO_MANY_CANDIDATES', `${list.length} > ${MAX_AUTO_CANDIDATES}`)
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (intervalsOverlap(list[i], list[j])) {
        throw new ReferenceLibraryError('OVERLAPPING_CANDIDATES', `index ${i} and ${j}`)
      }
    }
  }
  return list
}

/**
 * 영속 저장 항목. 원본 경로·전사 원문은 담지 않는다(해시 + 불투명 id + 숫자만).
 * 확정 구간은 항상 첫 후보로 포함되며, 기본값 미지정이면 그것이 기본 참조가 된다.
 */
export function buildLibraryEntry(
  input: ReferenceFingerprintInput,
  candidates: readonly ReferenceCandidate[] = [],
  defaultCandidateId?: string,
): ReferenceLibraryEntry {
  const src = requireSha256(input.sourceSha256, 'source_sha256')
  const analysisVersion = input.analysisVersion ?? REFERENCE_ANALYSIS_VERSION
  // 확정 구간은 항상 첫 후보. 호출부가 같은 구간의 후보(지표 포함)를 이미 줬다면 그쪽을 쓴다
  // — 그렇지 않으면 기본 참조만 지표가 0으로 비어 UI가 "왜 추천됐는지"를 보여줄 수 없다.
  const confirmedId = deriveClipId(src, input.region?.start ?? 0, input.region?.duration ?? 0)
  const supplied = (candidates ?? []).find((c) => c.id === confirmedId)
  const confirmed = supplied ?? buildCandidate(src, input.region?.start ?? 0, input.region?.duration ?? 0)
  const list: ReferenceCandidate[] = [confirmed]
  for (const c of candidates ?? []) {
    if (!list.some((x) => x.id === c.id)) list.push(c)
  }
  const trimmed = assertCandidateSetValid(list.slice(0, MAX_AUTO_CANDIDATES))
  const defaultId = defaultCandidateId || confirmed.id
  if (!trimmed.some((c) => c.id === defaultId)) {
    throw new ReferenceLibraryError('UNKNOWN_REFERENCE_SELECTED', 'default id not in candidates')
  }
  return {
    fingerprint: computeFingerprint({ ...input, sourceSha256: src, analysisVersion }),
    analysisVersion,
    sourceSha256: src,
    transcriptSha256: sha256HexOfString(normalizeTranscript(input.transcript)),
    regionStartMs: secondsToMs(input.region?.start ?? 0),
    regionDurationMs: secondsToMs(input.region?.duration ?? 0),
    candidates: trimmed,
    defaultCandidateId: defaultId,
  }
}

/**
 * 합성에 넘길 참조가 정확히 1개임을 강제한다(요구 6 — UI 편의가 아니라 정확성 요구).
 * 여러 후보를 저장·미리듣기하는 것은 허용되지만 "선택"은 언제나 1개여야 한다.
 */
export function assertSingleReference(
  entry: ReferenceLibraryEntry,
  selectedIds: readonly string[] | string,
): ReferenceCandidate {
  const list = assertCandidateSetValid(entry?.candidates ?? [])
  const raw = typeof selectedIds === 'string' ? [selectedIds] : (selectedIds ?? [])
  const uniq: string[] = []
  for (const id of raw) if (id && !uniq.includes(id)) uniq.push(id)
  if (uniq.length === 0) throw new ReferenceLibraryError('NO_REFERENCE_SELECTED', '0 selected')
  if (uniq.length > 1) throw new ReferenceLibraryError('MULTIPLE_REFERENCES_SELECTED', `${uniq.length} selected`)
  const found = list.find((c) => c.id === uniq[0])
  if (!found) throw new ReferenceLibraryError('UNKNOWN_REFERENCE_SELECTED', 'id not in candidates')
  return found
}

/** 합성/샘플러 경로에 넘기는 payload — 정확히 하나의 클립. 경로/전사 원문 없음. */
export function buildSynthesisReference(
  entry: ReferenceLibraryEntry,
  selectedIds: readonly string[] | string,
): SynthesisReference {
  const c = assertSingleReference(entry, selectedIds)
  const fp = entry?.fingerprint ?? ''
  return {
    clipId: c.id,
    startMs: c.startMs,
    durationMs: c.durationMs,
    fingerprint: fp,
    sourceSha256: entry?.sourceSha256 ?? '',
    cacheKey: fp ? referenceCacheKey(fp) : '',
    analysisVersion: entry?.analysisVersion ?? REFERENCE_ANALYSIS_VERSION,
  }
}

/**
 * 재사용 캐시 키 = 내용 기반 지문 그 자체(소문자 hex 64).
 *
 * `path|size|mtimeMs` 같은 경로/스탯 조합은 캐시 권위가 아니다 — 파일을 옮기기만 해도 달라지고,
 * 이름·크기가 같은 채 내용만 바뀌면 그대로여서 둘 다 틀린다. 규격 위반은 즉시 거부한다.
 */
export function referenceCacheKey(fingerprint: string): string {
  const v = String(fingerprint ?? '').trim().toLowerCase()
  if (!SHA256_RE.test(v)) {
    throw new ReferenceLibraryError(
      'INVALID_FINGERPRINT_INPUT',
      'cache key must be a content fingerprint (64 hex), not a path/size/mtime tuple',
    )
  }
  return v
}

/** 샘플러/캐시가 소비하는 참조 동일성 묶음. 스스로 지문을 만들지 않도록 이 값을 그대로 넘긴다. */
export function referenceIdentity(entry: ReferenceLibraryEntry | ReferenceManifestRecord): ReferenceIdentity {
  const e = entry as Partial<ReferenceLibraryEntry> & Partial<ReferenceManifestRecord>
  const fp = referenceCacheKey(e.fingerprint ?? '')
  return {
    fingerprint: fp,
    cacheKey: fp,
    sourceSha256: requireSha256(e.sourceSha256 ?? e.source_sha256, 'source_sha256'),
    analysisVersion: e.analysisVersion ?? e.analysis_version ?? REFERENCE_ANALYSIS_VERSION,
  }
}

/** Python(snake_case) 후보 dict → TS(camelCase) 후보. IPC 경계 정규화. 미지정 값은 0. */
export function candidateFromPython(raw: unknown): ReferenceCandidate {
  const o = (raw ?? {}) as Record<string, unknown>
  const m = (o.metrics ?? {}) as Record<string, unknown>
  return {
    id: String(o.id ?? ''),
    startMs: metric(o.start_ms ?? o.startMs),
    durationMs: metric(o.duration_ms ?? o.durationMs),
    score: metric(o.score),
    metrics: {
      silenceRatio: metric(m.silence_ratio ?? m.silenceRatio),
      clippingRatio: metric(m.clipping_ratio ?? m.clippingRatio),
      rmsDbfs: metric(m.rms_dbfs ?? m.rmsDbfs),
      peak: metric(m.peak),
      speechRatio: metric(m.speech_ratio ?? m.speechRatio),
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 위생(hygiene) 검사 — 저장/전송 구조에 경로·전사 원문이 새지 않는지
// ─────────────────────────────────────────────────────────────────────────────
const PATHLIKE_RE = /[/\\]|^[A-Za-z]:|^file:/i

/** 경로처럼 보이는 문자열인가: 슬래시/역슬래시 포함, 드라이브 문자로 시작, file: 스킴. */
export function isPathLike(text: unknown): boolean {
  return typeof text === 'string' && text.length > 0 && PATHLIKE_RE.test(text)
}

export interface SensitiveHit {
  at: string
  kind: 'path_like' | 'forbidden_text'
}

/**
 * 구조 안에서 (a) 경로처럼 보이는 문자열, (b) 금지 문자열(전사 원문 등) 포함을 찾아
 * 위치와 종류만 돌려준다. 값 자체는 반환하지 않는다(로그 유출 방지).
 */
export function findSensitiveStrings(value: unknown, forbidden: readonly string[] = [], at = '$'): SensitiveHit[] {
  const hits: SensitiveHit[] = []
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findSensitiveStrings(v, forbidden, `${at}[${i}]`)))
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      hits.push(...findSensitiveStrings((value as Record<string, unknown>)[k], forbidden, `${at}.${k}`))
    }
  } else if (typeof value === 'string') {
    if (isPathLike(value)) hits.push({ at, kind: 'path_like' })
    for (const f of forbidden) {
      if (f && value.includes(f)) { hits.push({ at, kind: 'forbidden_text' }); break }
    }
  }
  return hits
}

// ─────────────────────────────────────────────────────────────────────────────
// 재탐색(rescan) — 기존 후보 구간을 명시적 제외 입력으로 받는다(요구 3)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 이미 가진 후보(existing)의 반열린 구간과 겹치는 것을 전부 제외하고 새 후보를 찾는다.
 *
 * - existing 은 명시적 입력이다(한 번의 스캔이 3개를 고르는 것으로 끝내지 않는다).
 *   끝점이 맞닿는 구간은 여전히 허용한다([start, start+duration) 규칙 유지).
 * - 기존 후보를 교체·재정렬·삭제하지 않는다. candidates 는 existing 을 원래 순서 그대로 앞에 둔다.
 * - 남은 유효 구간이 없으면 빈 배열을 조용히 주지 않고 NO_MORE_REFERENCE_CANDIDATES 상태를 준다.
 * - 같은 입력 + 같은 제외 집합이면 항상 같은 결과.
 */
export function rescanCandidates(
  scored: readonly ScoredInterval[],
  existing: readonly ScoredInterval[] = [],
  maxCount: number = MAX_AUTO_CANDIDATES,
  options: CandidateSearchOptions = {},
): RescanResult {
  const kept = [...(existing ?? [])]
  const room = Math.max(0, maxCount - kept.length)
  const added = room > 0 ? pickAutoCandidates(scored, room, kept, options) : []
  return {
    status: added.length > 0 ? 'REFERENCE_CANDIDATES_FOUND' : 'NO_MORE_REFERENCE_CANDIDATES',
    added,
    candidates: [...kept, ...added],   // 기존은 순서 그대로 보존
    excludedCount: kept.length,
    room,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 영속 저장소(durable library) — manifest 는 순수 데이터, 파일 이동은 main 소유
// ─────────────────────────────────────────────────────────────────────────────
// Windows 볼륨 토큰(드라이브 문자 또는 UNC \\server\share). fs 접근 없이 문자열만 본다.
const VOLUME_RE = /^(?:([A-Za-z]:)|(\\\\[^\\]+\\[^\\]+))/

/** 경로의 볼륨 토큰(소문자). 판정 불가면 빈 문자열. */
export function pathVolume(path: string): string {
  const s = String(path ?? '').replace(/\//g, '\\')
  const m = VOLUME_RE.exec(s)
  if (!m) return ''
  return (m[1] || m[2]).toLowerCase()
}

/**
 * 원자적 승격 전제: staging 과 durable 이 같은 볼륨이어야 한다.
 * 교차 볼륨 rename 은 Windows 에서 실패하고, 복사+삭제는 원자적이지 않다 —
 * 다르면 승격을 시도조차 하지 않는다.
 */
export function assertPromotionSameVolume(stagingPath: string, durablePath: string): true {
  if (pathVolume(stagingPath) !== pathVolume(durablePath)) {
    throw new ReferenceLibraryError('CROSS_DEVICE_PROMOTION', 'staging and durable volumes differ')
  }
  return true
}

/** 영속 자산 파일명 — clipId + 확장자. 디렉터리는 붙이지 않는다(경로 해석은 main 소유). */
export function clipFileName(clipId: string): string {
  const cid = String(clipId ?? '').trim().toLowerCase()
  if (!new RegExp(`^[0-9a-f]{${CLIP_ID_LENGTH}}$`).test(cid)) {
    throw new ReferenceLibraryError('INVALID_FINGERPRINT_INPUT', `clip_id must be ${CLIP_ID_LENGTH} hex chars`)
  }
  return cid + CLIP_FILE_EXTENSION
}

/** 빈 manifest(신규 설치/최초 실행). */
export function emptyManifest(): ReferenceManifest {
  return { manifest_version: MANIFEST_VERSION, records: [] }
}

/** 레코드 불변식: 허용 필드만, 해시 형식 정상, 경로 문자열 0. */
export function assertManifestRecordValid(record: ReferenceManifestRecord): ReferenceManifestRecord {
  const r = { ...(record ?? {}) } as Record<string, unknown>
  const allowed = new Set<string>(MANIFEST_RECORD_FIELDS as readonly string[])
  const extra = Object.keys(r).filter((k) => !allowed.has(k)).sort()
  if (extra.length) throw new ReferenceLibraryError('MANIFEST_CONTAINS_PATH', `unexpected fields: ${extra.join(',')}`)
  const missing = MANIFEST_RECORD_FIELDS.filter((f) => !(f in r))
  if (missing.length) {
    throw new ReferenceLibraryError('INVALID_FINGERPRINT_INPUT', `missing fields: ${missing.join(',')}`)
  }
  clipFileName(String(r.clip_id))                      // clip_id 형식 검증(부수효과 없음)
  referenceCacheKey(String(r.fingerprint))
  requireSha256(String(r.source_sha256), 'source_sha256')
  requireSha256(String(r.transcript_sha256), 'transcript_sha256')
  requireSha256(String(r.clip_sha256), 'clip_sha256')
  const hits = findSensitiveStrings(r)
  if (hits.length) throw new ReferenceLibraryError('MANIFEST_CONTAINS_PATH', `at ${hits[0].at}`)
  return r as unknown as ReferenceManifestRecord
}

/** manifest 전체 불변식. 경로가 한 글자라도 섞이면 즉시 거부한다. */
export function assertManifestValid(manifest: ReferenceManifest): ReferenceManifest {
  const m = manifest ?? emptyManifest()
  if (Number(m.manifest_version) !== MANIFEST_VERSION) {
    throw new ReferenceLibraryError('INVALID_FINGERPRINT_INPUT', 'unsupported manifest_version')
  }
  const records = [...(m.records ?? [])]
  for (const r of records) assertManifestRecordValid(r)
  const ids = records.map((r) => r.clip_id)
  if (new Set(ids).size !== ids.length) {
    throw new ReferenceLibraryError('INVALID_FINGERPRINT_INPUT', 'duplicate clip_id in manifest')
  }
  return { manifest_version: MANIFEST_VERSION, records }
}

/**
 * 영속 항목 1건. MANIFEST_RECORD_FIELDS 외의 필드는 만들지 않는다(경로 필드는 영원히 없다).
 * clipSha256 은 durable 에 실제로 저장된 클립 파일의 sha256(재시작 후 무결성 검증용).
 */
export function buildManifestRecord(
  entry: ReferenceLibraryEntry,
  clipSha256: string,
  clipId?: string,
): ReferenceManifestRecord {
  const e = entry ?? ({} as ReferenceLibraryEntry)
  return assertManifestRecordValid({
    clip_id: String(clipId || e.defaultCandidateId || '').trim().toLowerCase(),
    fingerprint: referenceCacheKey(e.fingerprint),
    source_sha256: requireSha256(e.sourceSha256, 'source_sha256'),
    region_start_ms: Math.trunc(e.regionStartMs ?? 0),
    region_duration_ms: Math.trunc(e.regionDurationMs ?? 0),
    transcript_sha256: requireSha256(e.transcriptSha256, 'transcript_sha256'),
    analysis_version: Math.trunc(e.analysisVersion ?? REFERENCE_ANALYSIS_VERSION),
    clip_sha256: requireSha256(clipSha256, 'clip_sha256'),
  })
}

/** 레코드 추가/갱신(clip_id 기준). 원본 manifest 를 변형하지 않고 새 객체를 돌려준다. */
export function upsertManifestRecord(manifest: ReferenceManifest, record: ReferenceManifestRecord): ReferenceManifest {
  const m = assertManifestValid(manifest ?? emptyManifest())
  const rec = assertManifestRecordValid(record)
  return {
    manifest_version: MANIFEST_VERSION,
    records: [...m.records.filter((r) => r.clip_id !== rec.clip_id), rec],
  }
}

/** 지문으로 영속 레코드를 찾는다(재시작 후 재사용 조회 경로). 없으면 null. */
export function findManifestRecord(manifest: ReferenceManifest, fingerprint: string): ReferenceManifestRecord | null {
  const fp = referenceCacheKey(fingerprint)
  return (manifest?.records ?? []).find((r) => r.fingerprint === fp) ?? null
}

export function findManifestRecordByClipId(manifest: ReferenceManifest, clipId: string): ReferenceManifestRecord | null {
  const cid = String(clipId ?? '').trim().toLowerCase()
  return (manifest?.records ?? []).find((r) => r.clip_id === cid) ?? null
}

/**
 * 삭제 계획 — 그 manifest 레코드가 소유한 자산만. prefix 청소를 하지 않는다.
 * 기록에 없는 id 는 UNKNOWN_REFERENCE_ASSET 으로 거부한다(기록하지 않은 것은 절대 지우지 않는다).
 */
export function planAssetDeletion(manifest: ReferenceManifest, clipId: string): AssetDeletionPlan {
  const rec = findManifestRecordByClipId(manifest, clipId)
  if (!rec) throw new ReferenceLibraryError('UNKNOWN_REFERENCE_ASSET', 'clip_id not in manifest')
  return { clipId: rec.clip_id, fileNames: [clipFileName(rec.clip_id)] }
}

/** 사용자가 그 참조를 제거할 때만 호출. 새 manifest + 삭제 계획. */
export function removeManifestRecord(
  manifest: ReferenceManifest,
  clipId: string,
): { manifest: ReferenceManifest; plan: AssetDeletionPlan } {
  const plan = planAssetDeletion(manifest, clipId)
  const m = assertManifestValid(manifest)
  return {
    manifest: { manifest_version: MANIFEST_VERSION, records: m.records.filter((r) => r.clip_id !== plan.clipId) },
    plan,
  }
}

/** 재시작 후 무결성 검증 — 저장된 클립의 실제 sha256 이 레코드와 같아야 한다. */
export function verifyStoredClip(record: ReferenceManifestRecord, actualClipSha256: string): ReferenceManifestRecord {
  const rec = assertManifestRecordValid(record)
  if (rec.clip_sha256 !== requireSha256(actualClipSha256, 'clip_sha256')) {
    throw new ReferenceLibraryError('CLIP_CHECKSUM_MISMATCH', 'stored clip checksum differs')
  }
  return rec
}

/**
 * 영속 레코드(전사 원문 없음, 해시만)와 요청을 비교한다 — 재시작 직후 경로.
 * evaluateReuse 와 같은 반환 모양/같은 사유 코드. 전사는 해시로만 비교하므로
 * manifest 에 원문을 담을 필요가 없다.
 */
export function evaluateReuseAgainstRecord(
  record: ReferenceManifestRecord,
  requested: ReferenceRequest,
): ReferenceReuseVerdict {
  const rec = assertManifestRecordValid(record)
  const rVersion = requested.analysisVersion ?? REFERENCE_ANALYSIS_VERSION
  const fingerprint = computeFingerprintFromRequest(requested)

  const reasons: ReferenceInvalidationReason[] = []
  if (rec.source_sha256 !== requireSha256(requested.sourceSha256, 'source_sha256')) reasons.push('REF_SOURCE_CHANGED')
  if (rec.region_start_ms !== secondsToMs(requested.region?.start ?? 0)
    || rec.region_duration_ms !== secondsToMs(requested.region?.duration ?? 0)) {
    reasons.push('REF_REGION_CHANGED')
  }
  if (rec.transcript_sha256 !== sha256HexOfString(normalizeTranscript(requested.transcript))) {
    reasons.push('REF_TRANSCRIPT_CHANGED')
  }
  if (rec.analysis_version !== rVersion) reasons.push('REF_ANALYSIS_VERSION_CHANGED')

  reasons.sort((a, b) => REFERENCE_INVALIDATION_REASONS.indexOf(a) - REFERENCE_INVALIDATION_REASONS.indexOf(b))
  return {
    reusable: reasons.length === 0 && rec.fingerprint === fingerprint,
    reasons,
    fingerprint,
    storedFingerprint: rec.fingerprint,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 승격(promote) — 순서·검증·실패 불변식. 실제 fs 호출은 effects 로 주입받는다(여긴 순수).
// ─────────────────────────────────────────────────────────────────────────────
export interface ClipVerificationResult {
  decodable: boolean
  all_samples_finite: boolean
  sample_rate: number
  channel_count: number
  duration_ms: number
  clip_sha256: string
}

export interface ClipVerificationExpectation {
  sample_rate?: number
  channel_count?: number
  duration_ms?: number
}

/** run 저널 — 이 실행이 durable 에 새로 넣으려 한 clipId 목록. 경로는 담지 않는다. */
export interface RunJournal {
  run_id: string
  clip_ids: string[]
}

/** PROMOTE_STEPS 와 1:1 인 fs 작업. 전부 main 이 구현해 주입한다. */
export interface PromotionEffects {
  createStagingDir: (runId: string) => string
  writeStagingClip: (stagingDir: string, fileName: string) => string
  verifyStagingClip: (stagedPath: string) => ClipVerificationResult
  promoteClip: (stagedPath: string, durableFileName: string) => string
  writeManifestTemp: (manifest: ReferenceManifest, tempName: string) => string
  replaceManifest: (tempPath: string) => void
}

export interface PromotionRequest {
  runId: string
  entry: ReferenceLibraryEntry
  durableDir: string
  manifest: ReferenceManifest
  expected?: ClipVerificationExpectation
  clipId?: string
}

export interface PromotionResult {
  status: ReferencePromoteStatus
  steps: PromoteStep[]
  manifest: ReferenceManifest
  record: ReferenceManifestRecord | null
  orphanClipIds: string[]
  journal: RunJournal
  failedStep?: PromoteStep
  errorCode?: ReferenceGuardCode | null
}

function requireRunId(runId: string): string {
  const v = String(runId ?? '').trim().toLowerCase()
  if (!RUN_ID_RE.test(v)) throw new ReferenceLibraryError('INVALID_FINGERPRINT_INPUT', 'run_id must be 8~32 hex chars')
  return v
}

/** 이 실행 전용 staging 디렉터리명. durable 부모와 같은 볼륨 아래에 만들어야 한다. */
export function runScopedStagingDirName(runId: string): string {
  return RUN_SCOPE_PREFIX + requireRunId(runId)
}

/** 이 run 이 만든 clipId 목록 파일명. 고아 정리의 유일한 근거. */
export function runJournalFileName(runId: string): string {
  return RUN_SCOPE_PREFIX + requireRunId(runId) + RUN_JOURNAL_SUFFIX
}

/** 5단계 manifest 임시 파일명(같은 디렉터리에서 원자적 교체가 가능해야 한다). */
export function manifestTempFileName(runId: string): string {
  return `${MANIFEST_FILE_NAME}.${requireRunId(runId)}${MANIFEST_TEMP_SUFFIX}`
}

/** 이름이 그 run 소유의 staging 산출물인가. 접두사 일치만으로는 인정하지 않는다. */
export function isRunScopedName(name: string, runId: string): boolean {
  const n = String(name ?? '').trim().toLowerCase()
  return n === runScopedStagingDirName(runId)
    || n === runJournalFileName(runId)
    || n === manifestTempFileName(runId)
}

export function buildRunJournal(runId: string, clipIds: readonly string[]): RunJournal {
  const ids: string[] = []
  for (const raw of clipIds ?? []) {
    const c = String(raw ?? '').trim().toLowerCase()
    clipFileName(c)                       // 형식 검증
    if (!ids.includes(c)) ids.push(c)
  }
  return { run_id: requireRunId(runId), clip_ids: ids }
}

/**
 * durable 디렉터리의 파일 하나가 "이 run 이 남긴 고아"인가.
 * True 조건(전부 만족): 저널에 적힌 clipId 의 정식 파일명과 완전히 같고(접두사 일치 불인정),
 * 그 clipId 가 현재 manifest 에 없다(등재된 것은 고아가 아니며 절대 지우지 않는다).
 */
export function isOrphanOwnedByRun(fileName: string, journal: RunJournal, manifest: ReferenceManifest): boolean {
  const ids = journal?.clip_ids ?? []
  if (ids.length === 0) return false
  const name = String(fileName ?? '').trim().toLowerCase()
  for (const raw of ids) {
    const c = String(raw ?? '').trim().toLowerCase()
    let owned: string
    try { owned = clipFileName(c) } catch { continue }
    if (name === owned) return findManifestRecordByClipId(manifest, c) === null
  }
  return false
}

/** 3단계 검증 — 실패한 항목 이름 목록(빈 목록이면 통과). */
export function evaluateClipVerification(
  measured: Partial<ClipVerificationResult> | null | undefined,
  expected: ClipVerificationExpectation = {},
): string[] {
  const m = measured ?? {}
  const failed: string[] = []
  if (!m.decodable) failed.push('decodable')
  if (!m.all_samples_finite) failed.push('all_samples_finite')
  for (const key of ['sample_rate', 'channel_count', 'duration_ms'] as const) {
    if (expected[key] != null && Math.trunc(Number(m[key] ?? -1)) !== Math.trunc(Number(expected[key]))) {
      failed.push(key)
    }
  }
  if (!SHA256_RE.test(String(m.clip_sha256 ?? '').trim().toLowerCase())) failed.push('clip_sha256')
  return failed
}

/** 검증 실패면 승격하지 않는다(4단계로 넘어가지 않음). */
export function assertClipVerified(
  measured: Partial<ClipVerificationResult> | null | undefined,
  expected: ClipVerificationExpectation = {},
): ClipVerificationResult {
  const failed = evaluateClipVerification(measured, expected)
  if (failed.length) throw new ReferenceLibraryError('CLIP_VERIFICATION_FAILED', failed.join(','))
  return measured as ClipVerificationResult
}

/** 관찰된 단계 열이 PROMOTE_STEPS 의 접두사인지(건너뜀/재배열 없음) 확인한다. */
export function assertPromoteOrder(observed: readonly string[]): string[] {
  const obs = [...(observed ?? [])]
  const expected = PROMOTE_STEPS.slice(0, obs.length) as readonly string[]
  if (obs.length > PROMOTE_STEPS.length || obs.some((s, i) => s !== expected[i])) {
    throw new ReferenceLibraryError('PROMOTE_ORDER_VIOLATION', obs.join('->'))
  }
  return obs
}

/**
 * 확정 클립을 영속 저장소로 승격한다 — 순서를 호출부가 틀릴 수 없게 여기서 고정한다.
 * 실패 시 manifest 를 변형하지 않고 원본 객체를 그대로 돌려준다. 5·6단계 전에 실패하면
 * replaceManifest 는 호출조차 되지 않으므로 기존 manifest 는 불변이다.
 */
export function promoteReferenceClip(effects: PromotionEffects, request: PromotionRequest): PromotionResult {
  const runId = requireRunId(request?.runId)
  const entry = request?.entry ?? ({} as ReferenceLibraryEntry)
  const manifest = request?.manifest ?? emptyManifest()
  const clipId = String(request?.clipId || entry.defaultCandidateId || '').trim().toLowerCase()
  const fileName = clipFileName(clipId)
  const journal = buildRunJournal(runId, [clipId])

  const steps: PromoteStep[] = []
  let failedStep: PromoteStep = 'CREATE_STAGING_DIR'
  let errorCode: ReferenceGuardCode | null = null
  let newManifest: ReferenceManifest | null = null
  let record: ReferenceManifestRecord | null = null
  try {
    const stagingDir = effects.createStagingDir(runId)
    // staging 은 durable 부모와 같은 볼륨이어야 한다 — 아니면 4단계에서 터진다. 여기서 미리 막는다.
    assertPromotionSameVolume(stagingDir, request?.durableDir ?? '')
    steps.push('CREATE_STAGING_DIR')

    failedStep = 'WRITE_STAGING_CLIP'
    const staged = effects.writeStagingClip(stagingDir, fileName)
    steps.push('WRITE_STAGING_CLIP')

    failedStep = 'VERIFY_STAGING_CLIP'
    const measured = effects.verifyStagingClip(staged)
    assertClipVerified(measured, request?.expected ?? {})
    steps.push('VERIFY_STAGING_CLIP')

    failedStep = 'PROMOTE_CLIP'
    effects.promoteClip(staged, fileName)
    steps.push('PROMOTE_CLIP')

    failedStep = 'WRITE_MANIFEST_TEMP'
    record = buildManifestRecord(entry, measured.clip_sha256, clipId)
    newManifest = upsertManifestRecord(manifest, record)
    const tempPath = effects.writeManifestTemp(newManifest, manifestTempFileName(runId))
    steps.push('WRITE_MANIFEST_TEMP')

    failedStep = 'REPLACE_MANIFEST'
    effects.replaceManifest(tempPath)
    steps.push('REPLACE_MANIFEST')
  } catch (e) {
    errorCode = e instanceof ReferenceLibraryError ? e.code : null
  }

  assertPromoteOrder(steps)
  if (steps.length === PROMOTE_STEPS.length) {
    return {
      status: 'REFERENCE_PROMOTED',
      steps,
      manifest: newManifest as ReferenceManifest,
      record,
      orphanClipIds: [],
      journal,
    }
  }
  // 4단계를 넘겼다면 클립은 durable 에 있는데 manifest 에는 없다 → 이 run 소유의 고아.
  return {
    status: 'REFERENCE_PROMOTE_FAILED',
    steps,
    manifest,                                   // 원본 그대로 — 기존 참조는 계속 쓸 수 있다
    record: null,
    orphanClipIds: steps.includes('PROMOTE_CLIP') ? [clipId] : [],
    journal,
    failedStep,
    errorCode,
  }
}

/**
 * 재시작 후 재사용 조회: 요청 → 지문 → 영속 레코드 → clipId.
 * 라이브러리에 없으면 reusable false + clipId null(사유 없음 — 무효화가 아니라 부재).
 * clipId 를 실제 파일 경로로 바꾸는 일은 main 소유다(여기서는 파일명까지만).
 */
export function resolveReusableClip(manifest: ReferenceManifest, requested: ReferenceRequest): ResolvedReferenceClip {
  const fingerprint = computeFingerprintFromRequest(requested)
  const record = findManifestRecord(manifest, fingerprint)
  if (!record) return { reusable: false, clipId: null, fileName: null, record: null, fingerprint, reasons: [] }
  const verdict = evaluateReuseAgainstRecord(record, requested)
  return {
    reusable: verdict.reusable,
    clipId: verdict.reusable ? record.clip_id : null,
    fileName: verdict.reusable ? clipFileName(record.clip_id) : null,
    record,
    fingerprint,
    reasons: verdict.reasons,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHA-256 — 의존성 0(브라우저·node 동일). ttsGrammar.sha256Hex 와 동일 알고리즘이며
// referenceLibrary.test.ts 가 두 구현이 같은 값을 내는지 고정 검증한다.
// (shared 모듈끼리 확장자 없는 import 는 node --test 의 ESM 해석과 충돌하므로 자립 구현으로 둔다.)
// ─────────────────────────────────────────────────────────────────────────────
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** UTF-8 바이트 → sha256 hex(소문자 64자). */
export function sha256Hex(input: Uint8Array): string {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const len = input.length
  const bitLen = len * 8
  // padding: 0x80 + zeros + 64bit big-endian bit length, 64바이트 블록 정렬
  const total = ((len + 9 + 63) >> 6) << 6
  const buf = new Uint8Array(total)
  buf.set(input)
  buf[len] = 0x80
  const hi = Math.floor(bitLen / 0x100000000)
  const lo = bitLen >>> 0
  buf[total - 8] = (hi >>> 24) & 0xff
  buf[total - 7] = (hi >>> 16) & 0xff
  buf[total - 6] = (hi >>> 8) & 0xff
  buf[total - 5] = hi & 0xff
  buf[total - 4] = (lo >>> 24) & 0xff
  buf[total - 3] = (lo >>> 16) & 0xff
  buf[total - 2] = (lo >>> 8) & 0xff
  buf[total - 1] = lo & 0xff

  const w = new Uint32Array(64)
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (buf[off + i * 4] << 24) | (buf[off + i * 4 + 1] << 16) | (buf[off + i * 4 + 2] << 8) | buf[off + i * 4 + 3]
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]
      const y = w[i - 2]
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }
  let hex = ''
  for (let i = 0; i < 8; i++) hex += H[i].toString(16).padStart(8, '0')
  return hex
}

/** 문자열(UTF-8) → sha256 hex. */
export function sha256HexOfString(text: string): string {
  return sha256Hex(new TextEncoder().encode(text ?? ''))
}
