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
] as const
export type ReferenceGuardCode = (typeof REFERENCE_GUARD_CODES)[number]

// ── 정책 상수(Python 과 동일 값) ──
export const MAX_AUTO_CANDIDATES = 3
export const MIN_REGION_MS = 3000
export const MAX_REGION_MS = 10000

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

/** 합성 경로로 넘기는 payload — 정확히 하나의 클립. */
export interface SynthesisReference {
  clipId: string
  startMs: number
  durationMs: number
  fingerprint: string
  analysisVersion: number
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

/** 합성 경로에 넘기는 payload — 정확히 하나의 클립. 경로/전사 원문 없음. */
export function buildSynthesisReference(
  entry: ReferenceLibraryEntry,
  selectedIds: readonly string[] | string,
): SynthesisReference {
  const c = assertSingleReference(entry, selectedIds)
  return {
    clipId: c.id,
    startMs: c.startMs,
    durationMs: c.durationMs,
    fingerprint: entry?.fingerprint ?? '',
    analysisVersion: entry?.analysisVersion ?? REFERENCE_ANALYSIS_VERSION,
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
