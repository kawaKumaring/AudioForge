// 진단(shadow) 사이드카 이벤트 계약 — Python stdout → main → (integrator) → renderer.
//
// 왜 필요한가: python-runner 의 handleLine 은 progress|status|result|error 네 종류만 분기하고,
// 그 밖의 JSON 은 **정상 파싱되므로 catch 로도 가지 못한 채** 완전 침묵으로 사라졌다. Python 이
// 매 실행마다 계산해 내보내는 진단 이벤트 세 종류가 거기서 죽고 있었다:
//   - music_p1_shadow      (python/music_worker.py         — 앙상블 P1 shadow 진단)
//   - dialogueSidecar      (python/conversation_worker.py  — canonical 대화 sidecar + posterior 해석)
//   - asrTranscriptSidecar (python/transcribe_worker.py    — canonical ASR sidecar, 본문 없음)
//
// 이 모듈의 계약(불변식):
//   1) 허용목록(allowlist) 밖의 type 은 절대 통과시키지 않는다. pass-through 없음.
//   2) **화이트리스트 필드만** 조립한다. 원본 payload 를 복사·전개하지 않는다 —
//      필드를 하나씩 명시적으로 뽑아 새 객체를 만든다. 목록에 없으면 그냥 사라진다.
//   3) 민감정보 금지: 파일 경로·오디오 샘플·전사/대본 본문·프롬프트가 건너오면 안 된다.
//      Python 이 회귀해서 본문을 다시 실어 보내더라도 **여기(TS)가 차단 지점**이다.
//      그래서 body 성격의 배열(segments/words/posterior)은 통째로 버리고 집계 수치만 남긴다.
//   4) 잘못된 payload 는 구조화된 reasonCode 로 거절한다. throw 하지 않는다(실행을 죽이지 않는다).
//   5) 전부 additive/shadow 관측이다 — 기존 출력·품질 동작에 어떤 영향도 주지 않는다.
//
// 순수 모듈: Electron·Node·React 의존 없음(main/renderer 양쪽 tsconfig 에서 컴파일된다).

// ─────────────────────────────────────────────────────────────────────────────
// 허용목록 · 버전
// ─────────────────────────────────────────────────────────────────────────────

/** 이 envelope 계약 자체의 버전(우리 것). Python payload 스키마 버전과 별개다. */
export const SIDECAR_ENVELOPE_VERSION = 1

/**
 * main → renderer 로 검증된 envelope 를 실어 보낼 IPC 채널 이름.
 * 채널 등록/전송은 integrator(audio.ipc.ts)의 몫이다 — 이 파일은 이름만 단일 소스로 고정한다.
 */
export const SIDECAR_IPC_CHANNEL = 'audio:sidecar'

/** PythonRunner 에 주입되는 검증기 시그니처. */
export type SidecarValidator = (raw: unknown, sequence: number) => SidecarValidation

/** 전달을 허용하는 Python 이벤트 type — 정확히 이 셋뿐. */
export const SIDECAR_KINDS = [
  'music_p1_shadow',
  'dialogueSidecar',
  'asrTranscriptSidecar'
] as const

export type SidecarKind = (typeof SIDECAR_KINDS)[number]

/** Python payload 가 스스로 선언하는 스키마 버전 중 우리가 이해하는 major. */
export const SUPPORTED_PAYLOAD_SCHEMA_MAJOR = 1

// music_p1_shadow 는 payload 에 schemaVersion 을 담지 않는다(python/music_worker.py 의
// _P1_SHADOW_KEYS 화이트리스트에 없음). 그래서 kind 별로 '선언 필수' 여부를 명시한다 —
// 없는 걸 요구해서 실제 이벤트를 전부 거절하는 사고를 막기 위함.
const KIND_REQUIRES_PAYLOAD_SCHEMA_VERSION: Readonly<Record<SidecarKind, boolean>> = {
  music_p1_shadow: false,
  dialogueSidecar: true,
  asrTranscriptSidecar: true
}

export function isSidecarKind(value: unknown): value is SidecarKind {
  return typeof value === 'string' && (SIDECAR_KINDS as readonly string[]).includes(value)
}

// ─────────────────────────────────────────────────────────────────────────────
// 상태 · 사유 코드
// ─────────────────────────────────────────────────────────────────────────────

/** envelope 수준 상태. Python 쪽 진단 상태 enum 은 metrics 안에 따로 보존한다. */
export type SidecarStatus = 'ok' | 'degraded' | 'unavailable'

/**
 * 구조화 사유 코드. 두 용도를 한 union 으로 둔다:
 *  - 거절 사유(ok:false) — 무엇이 계약을 어겼는지.
 *  - 수용했지만 상태가 ok 가 아닌 이유(envelope.reasonCode) — Python 이 스스로 알린 열화.
 * 어떤 코드도 자유 텍스트를 담지 않는다(로그·카운터에 그대로 실려도 안전).
 */
export type SidecarReasonCode =
  // 거절
  | 'not-an-object'
  | 'unknown-kind'
  | 'schema-version-missing'
  | 'schema-version-invalid'
  | 'schema-version-unsupported'
  | 'metrics-invalid'
  | 'bounds-exceeded'
  | 'unsafe-field'
  | 'validator-threw'
  // 수용 + 열화
  | 'probe-skipped'
  | 'probe-error'
  | 'probe-not-calibrated'
  | 'interpretation-unavailable'

// ─────────────────────────────────────────────────────────────────────────────
// 안전 원시값 파서 — 여기가 '경로·본문·샘플 차단'의 물리적 지점
// ─────────────────────────────────────────────────────────────────────────────

const SAFE_TOKEN_MAX_LEN = 64
// 영숫자로 시작하고 영숫자·마침표·밑줄·붙임표만. 결과적으로 다음이 전부 걸러진다:
//   Windows 경로 'C:\\Users\\...'   → ':' '\\' 불허
//   POSIX 경로 '/home/u/a.wav'      → '/' 불허(선두 '/' 도 불허)
//   전사/대본 본문                    → 공백·한글·구두점 불허 + 길이 상한
//   프롬프트/문장                     → 위와 동일
const SAFE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
// Python 이 문자열로 직렬화한 임계값('2.0','0.01') 만 숫자로 받아들인다.
const NUMERIC_STRING_RE = /^-?(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,9})?$/
// status_counts 의 키는 enum 이름(OK/REVIEW/LOW_CONFIDENCE/EMPTY…) 만 허용.
const ENUM_KEY_RE = /^[A-Z][A-Z0-9_]{0,31}$/
const SEMVER_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/

/** 집계 카운트 상한 — 말도 안 되는 수치는 계약 위반으로 본다. */
const MAX_COUNT = 1_000_000_000
/** 화자 슬롯 상한(실제 n_speakers 는 한 자릿수). 초과 = 방어적 거절. */
export const MAX_SPEAKER_SLOTS = 64
/** status_counts 키 개수 상한(enum 종류는 4~5개). 초과 = 데이터 밀반입 의심 → 버린다. */
export const MAX_STATUS_COUNT_KEYS = 16
/** audit 재귀 깊이 상한(정상 envelope 는 4 이하). */
const MAX_AUDIT_DEPTH = 6

/** 안전 토큰(짧은 식별자/enum/언어코드)만 통과. 아니면 null → 필드는 그냥 사라진다. */
export function safeToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.length === 0 || value.length > SAFE_TOKEN_MAX_LEN) return null
  if (!SAFE_TOKEN_RE.test(value)) return null
  return value
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function finiteNumber(value: unknown): number | null {
  // 강제 변환하지 않는다: 배열('[0.1, 0.2]' 같은 오디오 샘플)이나 숫자형 문자열이
  // Number() 로 슬쩍 통과하는 일이 없도록 typeof 로 못박는다.
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nonNegativeInt(value: unknown): number | null {
  const n = finiteNumber(value)
  if (n === null || !Number.isInteger(n) || n < 0 || n > MAX_COUNT) return null
  return n
}

function boundedInt(value: unknown): number | null {
  const n = finiteNumber(value)
  if (n === null || !Number.isInteger(n) || Math.abs(n) > MAX_COUNT) return null
  return n
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function enumOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null
}

function enumOfNumber<T extends number>(value: unknown, allowed: readonly T[]): T | null {
  const n = finiteNumber(value)
  return n !== null && (allowed as readonly number[]).includes(n) ? (n as T) : null
}

/** 숫자 또는 '엄격한 숫자 문자열'. Python 이 threshold 를 str() 로 담는 자리에만 쓴다. */
function numberLike(value: unknown): number | null {
  const direct = finiteNumber(value)
  if (direct !== null) return direct
  if (typeof value !== 'string' || value.length > 24) return null
  if (!NUMERIC_STRING_RE.test(value)) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

/** 배열 원소 중 obj[key] === true 인 개수. 원소 자체는 절대 밖으로 나가지 않는다. */
function countFlag(list: unknown[], key: string): number {
  let n = 0
  for (const item of list) {
    const o = plainObject(item)
    if (o !== null && o[key] === true) n++
  }
  return n
}

/** enum키→개수 맵만 재구성. 키가 enum 형태가 아니거나 값이 정수가 아니면 그 항목을 버린다. */
function statusCountMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  const src = plainObject(value)
  if (src === null) return out
  const keys = Object.keys(src).sort()
  if (keys.length > MAX_STATUS_COUNT_KEYS) return out
  for (const k of keys) {
    if (!ENUM_KEY_RE.test(k)) continue
    const n = nonNegativeInt(src[k])
    if (n === null) continue
    out[k] = n
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// metrics 타입 — 전부 수치/enum/index. 본문·배열 body 없음.
// ─────────────────────────────────────────────────────────────────────────────

export const MUSIC_PROBE_STATUSES = [
  'OK',
  'P1_SHADOW_SKIPPED',
  'P1_SHADOW_ERROR',
  'MUSIC_P1_NOT_CALIBRATED'
] as const
export type MusicProbeStatus = (typeof MUSIC_PROBE_STATUSES)[number]

/** music_worker._P1_SHADOW_KEYS 와 1:1. status 는 envelope.status 와 겹치지 않게 probeStatus 로 받는다. */
export interface MusicP1ShadowMetrics {
  readonly probeStatus: MusicProbeStatus
  readonly candidateEligible: boolean
  readonly offsetFrames?: number
  readonly polarity?: -1 | 0 | 1
  readonly gain?: number
  readonly baselineError?: number
  readonly candidateError?: number
  readonly improvement?: number
  readonly elapsedMs?: number
}

/** 화자 1명분 — 라벨('화자 A')은 담지 않는다. 인덱스·불리언만. */
export interface DialogueSpeakerSlot {
  readonly trackIndex: number | null
  readonly trackAvailable: boolean
  readonly reviewRequired: boolean
}

export const DIALOGUE_INTERPRETATION_STATUSES = ['available', 'unavailable'] as const
export type DialogueInterpretationStatus = (typeof DIALOGUE_INTERPRETATION_STATUSES)[number]

export interface DialogueInterpretationMetrics {
  readonly status: DialogueInterpretationStatus
  readonly experimental: boolean
  readonly overlapCount: number
  readonly unknownCount: number
  readonly reviewCount: number
  readonly reviewBelow: number | null
  readonly unknownBelow: number | null
  readonly overlapMinPosterior: number | null
  readonly errorCode?: string
}

/**
 * sidecar.segments / speakers 라벨 / posterior / words 는 **통째로 버린다** —
 * words[].text 는 전사 본문이고 speakers 는 표시용 한글 라벨이다. 집계만 남긴다.
 */
export interface DialogueSidecarMetrics {
  readonly speakerCount: number
  readonly segmentCount: number
  readonly backchannelCount: number
  readonly overlapCount: number
  readonly frameRate: number | null
  readonly speakers: readonly DialogueSpeakerSlot[]
  readonly interpretation: DialogueInterpretationMetrics | null
}

/**
 * segments[] 는 body-free 라도 그대로 넘기지 않는다: word 타임스탬프 배열은 오디오
 * 표본처럼 보이는 float 배열이고, Python 이 회귀하면 text 가 되돌아올 자리다. 요약만 남긴다.
 */
export interface AsrTranscriptSidecarMetrics {
  readonly language: string | null
  readonly segmentCount: number
  readonly wordCount: number
  readonly totalDurationSec: number
  readonly statusCounts: Readonly<Record<string, number>>
  readonly hasProvenance: boolean
  readonly model: string | null
  readonly task: string | null
  readonly hallucinationSilenceSec: number | null
  readonly rmsThreshold: number | null
}

// ─────────────────────────────────────────────────────────────────────────────
// envelope
// ─────────────────────────────────────────────────────────────────────────────

interface SidecarEnvelopeBase {
  /** 이 envelope 계약의 버전(SIDECAR_ENVELOPE_VERSION). */
  readonly schemaVersion: number
  readonly kind: SidecarKind
  /** Python payload 가 선언한 스키마 버전. music_p1_shadow 는 선언이 없어 null. */
  readonly payloadSchemaVersion: string | null
  readonly status: SidecarStatus
  /** 단조 증가 순번. Date.now() 를 쓰지 않는다 — 테스트 결정성 + 시계 역행 무관. */
  readonly sequence: number
  readonly jobId?: string
  readonly reasonCode?: SidecarReasonCode
}

export interface MusicP1ShadowEnvelope extends SidecarEnvelopeBase {
  readonly kind: 'music_p1_shadow'
  readonly metrics: MusicP1ShadowMetrics
}

export interface DialogueSidecarEnvelope extends SidecarEnvelopeBase {
  readonly kind: 'dialogueSidecar'
  readonly metrics: DialogueSidecarMetrics
}

export interface AsrTranscriptSidecarEnvelope extends SidecarEnvelopeBase {
  readonly kind: 'asrTranscriptSidecar'
  readonly metrics: AsrTranscriptSidecarMetrics
}

export type SidecarEnvelope =
  | MusicP1ShadowEnvelope
  | DialogueSidecarEnvelope
  | AsrTranscriptSidecarEnvelope

export type SidecarValidation<E extends SidecarEnvelope = SidecarEnvelope> =
  | { readonly ok: true; readonly envelope: E }
  | { readonly ok: false; readonly reasonCode: SidecarReasonCode }

function reject(reasonCode: SidecarReasonCode): { ok: false; reasonCode: SidecarReasonCode } {
  return { ok: false, reasonCode }
}

// ─────────────────────────────────────────────────────────────────────────────
// 공통 전처리
// ─────────────────────────────────────────────────────────────────────────────

interface Preflight {
  readonly raw: Record<string, unknown>
  readonly payloadSchemaVersion: string | null
  readonly jobId?: string
  readonly sequence: number
}

function preflight(
  raw: unknown,
  kind: SidecarKind,
  sequence: number
): Preflight | { ok: false; reasonCode: SidecarReasonCode } {
  const obj = plainObject(raw)
  if (obj === null) return reject('not-an-object')
  if (enumOf(obj.type, SIDECAR_KINDS) !== kind) return reject('unknown-kind')

  const declared = obj.schemaVersion
  let payloadSchemaVersion: string | null = null
  if (declared === undefined || declared === null) {
    if (KIND_REQUIRES_PAYLOAD_SCHEMA_VERSION[kind]) return reject('schema-version-missing')
  } else {
    const token = safeToken(declared)
    if (token === null) return reject('schema-version-invalid')
    const m = SEMVER_RE.exec(token)
    if (m === null) return reject('schema-version-invalid')
    if (Number(m[1]) !== SUPPORTED_PAYLOAD_SCHEMA_MAJOR) return reject('schema-version-unsupported')
    payloadSchemaVersion = token
  }

  // jobId 는 현재 Python 이 담지 않는다(선택). 담기더라도 안전 토큰이 아니면 버린다.
  const jobId = safeToken(obj.jobId)
  const seq = nonNegativeInt(sequence) ?? 0
  return jobId === null
    ? { raw: obj, payloadSchemaVersion, sequence: seq }
    : { raw: obj, payloadSchemaVersion, jobId, sequence: seq }
}

function isRejection(v: unknown): v is { ok: false; reasonCode: SidecarReasonCode } {
  const o = plainObject(v)
  return o !== null && o.ok === false
}

// ─────────────────────────────────────────────────────────────────────────────
// 최종 감사(audit) — 조립이 끝난 envelope 를 한 번 더 훑는다.
// 필드를 명시 조립하므로 원칙적으로 통과가 보장되지만, 나중에 누가 필드를 추가했을 때
// 경로·본문이 새는 걸 막는 2차 방어선이다. 실패하면 '수용'을 취소하고 거절한다.
// ─────────────────────────────────────────────────────────────────────────────

function auditValue(value: unknown, depth: number): boolean {
  if (depth > MAX_AUDIT_DEPTH) return false
  if (value === null || value === undefined) return true
  if (typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return safeToken(value) !== null
  if (Array.isArray(value)) {
    for (const item of value) if (!auditValue(item, depth + 1)) return false
    return true
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (safeToken(k) === null) return false
      if (!auditValue(v, depth + 1)) return false
    }
    return true
  }
  return false
}

/** envelope 안에 안전 토큰이 아닌 문자열/비유한 수가 하나라도 있으면 false. */
export function auditEnvelope(envelope: SidecarEnvelope): boolean {
  return auditValue(envelope, 0)
}

function finish<E extends SidecarEnvelope>(envelope: E): SidecarValidation<E> {
  if (!auditEnvelope(envelope)) return reject('unsafe-field')
  return { ok: true, envelope }
}

// ─────────────────────────────────────────────────────────────────────────────
// kind 별 검증기
// ─────────────────────────────────────────────────────────────────────────────

const MUSIC_STATUS_MAP: Readonly<
  Record<MusicProbeStatus, { status: SidecarStatus; reasonCode?: SidecarReasonCode }>
> = {
  OK: { status: 'ok' },
  P1_SHADOW_SKIPPED: { status: 'unavailable', reasonCode: 'probe-skipped' },
  P1_SHADOW_ERROR: { status: 'degraded', reasonCode: 'probe-error' },
  MUSIC_P1_NOT_CALIBRATED: { status: 'unavailable', reasonCode: 'probe-not-calibrated' }
}

export function validateMusicP1Shadow(
  raw: unknown,
  sequence: number
): SidecarValidation<MusicP1ShadowEnvelope> {
  const pre = preflight(raw, 'music_p1_shadow', sequence)
  if (isRejection(pre)) return pre
  const src = pre.raw

  const probeStatus = enumOf(src.status, MUSIC_PROBE_STATUSES)
  if (probeStatus === null) return reject('metrics-invalid')

  // 선택 수치는 '있고 유효할 때만' 담는다. 유효하지 않으면 조용히 사라진다(strip).
  const metrics: { -readonly [K in keyof MusicP1ShadowMetrics]: MusicP1ShadowMetrics[K] } = {
    probeStatus,
    candidateEligible: bool(src.candidateEligible) ?? false
  }
  const offsetFrames = boundedInt(src.offsetFrames)
  if (offsetFrames !== null) metrics.offsetFrames = offsetFrames
  const polarity = enumOfNumber(src.polarity, [-1, 0, 1] as const)
  if (polarity !== null) metrics.polarity = polarity
  const gain = finiteNumber(src.gain)
  if (gain !== null) metrics.gain = gain
  const baselineError = finiteNumber(src.baselineError)
  if (baselineError !== null) metrics.baselineError = baselineError
  const candidateError = finiteNumber(src.candidateError)
  if (candidateError !== null) metrics.candidateError = candidateError
  const improvement = finiteNumber(src.improvement)
  if (improvement !== null) metrics.improvement = improvement
  const elapsedMs = finiteNumber(src.elapsedMs)
  if (elapsedMs !== null && elapsedMs >= 0) metrics.elapsedMs = elapsedMs

  const mapped = MUSIC_STATUS_MAP[probeStatus]
  const envelope: MusicP1ShadowEnvelope = {
    schemaVersion: SIDECAR_ENVELOPE_VERSION,
    kind: 'music_p1_shadow',
    payloadSchemaVersion: pre.payloadSchemaVersion,
    status: mapped.status,
    sequence: pre.sequence,
    ...(pre.jobId !== undefined ? { jobId: pre.jobId } : {}),
    ...(mapped.reasonCode !== undefined ? { reasonCode: mapped.reasonCode } : {}),
    metrics
  }
  return finish(envelope)
}

function buildInterpretation(value: unknown): DialogueInterpretationMetrics | null {
  const src = plainObject(value)
  if (src === null) return null
  const status = enumOf(src.status, DIALOGUE_INTERPRETATION_STATUSES)
  if (status === null) return null
  const summary = plainObject(src.summary) ?? {}
  const thresholds = plainObject(src.thresholds) ?? {}
  const errorCode = safeToken(src.errorCode)
  const out: {
    -readonly [K in keyof DialogueInterpretationMetrics]: DialogueInterpretationMetrics[K]
  } = {
    status,
    experimental: bool(src.experimental) ?? false,
    overlapCount: nonNegativeInt(summary.overlapCount) ?? 0,
    unknownCount: nonNegativeInt(summary.unknownCount) ?? 0,
    reviewCount: nonNegativeInt(summary.reviewCount) ?? 0,
    // thresholds.note 는 자유 텍스트 — 화이트리스트에 없으므로 여기서 사라진다.
    reviewBelow: numberLike(thresholds.reviewBelow),
    unknownBelow: numberLike(thresholds.unknownBelow),
    overlapMinPosterior: numberLike(thresholds.overlapMinPosterior)
  }
  if (errorCode !== null) out.errorCode = errorCode
  return out
}

export function validateDialogueSidecar(
  raw: unknown,
  sequence: number
): SidecarValidation<DialogueSidecarEnvelope> {
  const pre = preflight(raw, 'dialogueSidecar', sequence)
  if (isRejection(pre)) return pre
  const src = pre.raw

  const sidecar = plainObject(src.sidecar)
  if (sidecar === null) return reject('metrics-invalid')
  const segments = asArray(sidecar.segments)
  if (segments === null) return reject('metrics-invalid')
  const speakerLabels = asArray(sidecar.speakers)
  if (speakerLabels === null) return reject('metrics-invalid')
  const speakerMeta = asArray(src.speakerMeta)
  if (speakerMeta === null) return reject('metrics-invalid')
  if (speakerMeta.length > MAX_SPEAKER_SLOTS || speakerLabels.length > MAX_SPEAKER_SLOTS) {
    return reject('bounds-exceeded')
  }

  // 화자 라벨('화자 A')·segments 본문은 읽기만 하고 집계만 내보낸다.
  const speakers: DialogueSpeakerSlot[] = []
  for (const item of speakerMeta) {
    const o = plainObject(item)
    if (o === null) return reject('metrics-invalid')
    const trackIndex = nonNegativeInt(o.trackIndex)
    speakers.push({
      trackIndex,
      trackAvailable: bool(o.trackAvailable) ?? false,
      reviewRequired: bool(o.reviewRequired) ?? false
    })
  }

  const source = plainObject(sidecar.source) ?? {}
  const metrics: DialogueSidecarMetrics = {
    speakerCount: speakerLabels.length,
    segmentCount: segments.length,
    backchannelCount: countFlag(segments, 'is_backchannel'),
    overlapCount: countFlag(segments, 'is_overlap'),
    frameRate: numberLike(source.frame_rate),
    speakers,
    interpretation: buildInterpretation(src.interpretation)
  }

  // 해석 블록이 없거나 unavailable 이면 열화로 표시한다(조용한 손실 금지).
  const degraded = metrics.interpretation === null || metrics.interpretation.status !== 'available'
  const envelope: DialogueSidecarEnvelope = {
    schemaVersion: SIDECAR_ENVELOPE_VERSION,
    kind: 'dialogueSidecar',
    payloadSchemaVersion: pre.payloadSchemaVersion,
    status: degraded ? 'degraded' : 'ok',
    sequence: pre.sequence,
    ...(pre.jobId !== undefined ? { jobId: pre.jobId } : {}),
    ...(degraded ? { reasonCode: 'interpretation-unavailable' as const } : {}),
    metrics
  }
  return finish(envelope)
}

export function validateAsrTranscriptSidecar(
  raw: unknown,
  sequence: number
): SidecarValidation<AsrTranscriptSidecarEnvelope> {
  const pre = preflight(raw, 'asrTranscriptSidecar', sequence)
  if (isRejection(pre)) return pre
  const src = pre.raw

  const segmentCount = nonNegativeInt(src.segmentCount)
  if (segmentCount === null) return reject('metrics-invalid')
  const summary = plainObject(src.summary)
  if (summary === null) return reject('metrics-invalid')
  const provenance = plainObject(src.provenance) ?? {}

  // segments[] 는 여기서 완전히 버린다 — word 타임스탬프 float 배열/본문 회귀의 진입로.
  const metrics: AsrTranscriptSidecarMetrics = {
    language: safeToken(src.language),
    segmentCount,
    wordCount: nonNegativeInt(summary.word_count) ?? 0,
    totalDurationSec: finiteNumber(summary.total_duration_sec) ?? 0,
    statusCounts: statusCountMap(summary.status_counts),
    hasProvenance: bool(summary.has_provenance) ?? false,
    model: safeToken(provenance.model),
    task: safeToken(provenance.task),
    hallucinationSilenceSec: numberLike(provenance.hallucination_silence_threshold),
    rmsThreshold: numberLike(provenance.rms_threshold)
  }

  const envelope: AsrTranscriptSidecarEnvelope = {
    schemaVersion: SIDECAR_ENVELOPE_VERSION,
    kind: 'asrTranscriptSidecar',
    payloadSchemaVersion: pre.payloadSchemaVersion,
    status: 'ok',
    sequence: pre.sequence,
    ...(pre.jobId !== undefined ? { jobId: pre.jobId } : {}),
    metrics
  }
  return finish(envelope)
}

// ─────────────────────────────────────────────────────────────────────────────
// 단일 진입점 — python-runner 가 부르는 곳
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 파싱된 stdout 이벤트 1건을 검증해 정규화 envelope 또는 구조화 거절을 돌려준다.
 * 절대 throw 하지 않는다. 허용목록 밖 type 은 'unknown-kind' 로 거절된다(통과 없음).
 */
export function validateSidecarEvent(raw: unknown, sequence: number): SidecarValidation {
  const obj = plainObject(raw)
  if (obj === null) return reject('not-an-object')
  const kind = enumOf(obj.type, SIDECAR_KINDS)
  if (kind === null) return reject('unknown-kind')
  switch (kind) {
    case 'music_p1_shadow':
      return validateMusicP1Shadow(obj, sequence)
    case 'dialogueSidecar':
      return validateDialogueSidecar(obj, sequence)
    case 'asrTranscriptSidecar':
      return validateAsrTranscriptSidecar(obj, sequence)
  }
}
