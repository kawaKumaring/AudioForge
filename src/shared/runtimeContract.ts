// 독립 실행(standalone) 런타임 위치·소유권·capability 계약 — 순수 shared 단일 소스.
// 이 모듈은 타입 정의 + 순수 헬퍼만 담는다(process/fs/GPU/미디어 접근 0).
// resolver(B)·capabilities(C)·runtime 통합 담당이 이 계약을 소비/생산하며,
// 실제 경로 값·probe 결과·타임스탬프는 통합 담당이 주입한다.
//
// 계약이 강제하는 불변식(단위테스트로 고정):
//   1) 상대경로는 managed root 내부에만 허용. 외부 interpreter는 canonical absolute path로만 기록.
//   2) renderer로 나가는 결과에는 전체 경로가 없다 — pathRefId·basename·reasonCode만.
//   3) 직렬화는 plain 객체만(Map/Set 금지) → JSON round-trip byte-stable.
//   4) fingerprint는 RuntimeFingerprint 구조(경로·venv 위치·사용자명 제외).
//   5) 민감정보(전체 경로·traceback·원문 stderr·사용자 내용)는 계약 타입에 포함하지 않는다.
//
// v2(reconcile): capability 상태를 status(5값)·freshness·supportLevel 3축으로 분리,
//   소유권을 ownership·source·status 3축으로 정규화, ReasonCode canonical union 도입,
//   RuntimeFingerprint·ValidationEvidence envelope 구조화.

// 계약 스키마 버전 — 필드 추가/변경 시 증가. 저장된 스냅샷 마이그레이션 판별에 사용.
export const RUNTIME_CONTRACT_SCHEMA_VERSION = 2 as const
export type RuntimeContractSchemaVersion = typeof RUNTIME_CONTRACT_SCHEMA_VERSION

// ── enum: reason code canonical union(§5) ──────────────────────────────────
// renderer/저장 사유는 자유 문자열이 아니라 이 고정 코드만(자유 문자열 저장 금지).
// 성공/사유 없음은 reasonCode=null로 표현한다(OK 코드 없음).
export const REASON_CODES = [
  'NO_RUNTIME_ROOT',
  'USER_SELECTION_FAILED',
  'INTERPRETER_NOT_FOUND',
  'DANGLING_JUNCTION',
  'DUPLICATE_CANDIDATE',
  'PREFLIGHT_FAILED',
  'PYTHON_VERSION_INCOMPATIBLE',
  'ARCHITECTURE_INCOMPATIBLE',
  'PACKAGE_MISSING',
  'PACKAGE_VERSION_INCOMPATIBLE',
  'PACKAGE_DRIFT',
  'PIP_CHECK_FAILED',
  'VENV_MISSING',
  'MODEL_MISSING',
  'MODEL_CHECKSUM_MISMATCH',
  'TOOL_MISSING',
  'GPU_UNAVAILABLE',
  'CPU_FALLBACK_AVAILABLE',
  'EVIDENCE_STALE',
  'BORROWED_RUNTIME_READ_ONLY',
] as const
export type ReasonCode = (typeof REASON_CODES)[number]

export function isReasonCode(v: unknown): v is ReasonCode {
  return typeof v === 'string' && (REASON_CODES as readonly string[]).includes(v)
}

// reasonCode 슬롯은 항상 ReasonCode 또는 null(자유 문자열 금지)만 허용됨을 확인.
export function isReasonCodeOrNull(v: unknown): v is ReasonCode | null {
  return v === null || isReasonCode(v)
}

// 정책 결과 — reasonCode가 아니다(진단 사유가 아니라 정책 분기 결과). §5 권고에 따라 분리.
export const POLICY_OUTCOMES = [
  'none',
  'no-fallback-external-by-policy',
  'switched-to-managed-explicit',
] as const
export type PolicyOutcome = (typeof POLICY_OUTCOMES)[number]

export function isPolicyOutcome(v: unknown): v is PolicyOutcome {
  return typeof v === 'string' && (POLICY_OUTCOMES as readonly string[]).includes(v)
}

// ── B(resolver)·C(capability) 레거시 코드 → canonical ReasonCode 매핑표(§5) ──
// 통합 담당이 기존 코드를 계약 union으로 정규화할 때 단일 소스. 값은 전부 유효한 ReasonCode.
// no-fallback-external-by-policy·switched-to-managed-explicit는 reasonCode가 아니라
// PolicyOutcome이므로 아래 RESOLVER_POLICY_OUTCOME_MAP로 분리한다.
export const RESOLVER_REASON_CODE_MAP = {
  'dangling-junction': 'DANGLING_JUNCTION',
  'duplicate': 'DUPLICATE_CANDIDATE',
  'preflight-failed': 'PREFLIGHT_FAILED',
  'not-found': 'INTERPRETER_NOT_FOUND',
  'no-runtime-root': 'NO_RUNTIME_ROOT',
  'user-selection-failed': 'USER_SELECTION_FAILED',
} as const satisfies Record<string, ReasonCode>

export const RESOLVER_POLICY_OUTCOME_MAP = {
  'no-fallback-external-by-policy': 'no-fallback-external-by-policy',
  'switched-to-managed-explicit': 'switched-to-managed-explicit',
} as const satisfies Record<string, PolicyOutcome>

export const CAPABILITY_REASON_CODE_MAP = {
  // 이름 동일(그대로 정규화)
  'VENV_MISSING': 'VENV_MISSING',
  'MODEL_MISSING': 'MODEL_MISSING',
  'GPU_UNAVAILABLE': 'GPU_UNAVAILABLE',
  // 이름 변경(중복 개념 통합)
  'CHECKSUM_MISMATCH': 'MODEL_CHECKSUM_MISMATCH',
  'STALE_SNAPSHOT': 'EVIDENCE_STALE',
  'ENV_DRIFT': 'PACKAGE_DRIFT',
  // PYTHON_MISSING은 interpreter 부재로 정규화. venv 자체 부재는 VENV_MISSING로 구분 유지.
  'PYTHON_MISSING': 'INTERPRETER_NOT_FOUND',
} as const satisfies Record<string, ReasonCode>

// ── enum: capability 상태 3축(§1) ───────────────────────────────────────────
// 축1 status(기존 5값 유지 — degraded/stale를 여기 넣지 않는다):
//   supported/unsupported/unavailable/incompatible/unverified
export const CAPABILITY_STATUS = [
  'supported',
  'unsupported',
  'unavailable',
  'incompatible',
  'unverified',
] as const
export type CapabilityStatus = (typeof CAPABILITY_STATUS)[number]

export function isCapabilityStatus(v: unknown): v is CapabilityStatus {
  return typeof v === 'string' && (CAPABILITY_STATUS as readonly string[]).includes(v)
}

// 축2 freshness: 증거의 신선도. stale = 재검증 필요(과거 결과 재사용 금지).
export const CAPABILITY_FRESHNESS = ['current', 'stale'] as const
export type CapabilityFreshness = (typeof CAPABILITY_FRESHNESS)[number]

export function isCapabilityFreshness(v: unknown): v is CapabilityFreshness {
  return typeof v === 'string' && (CAPABILITY_FRESHNESS as readonly string[]).includes(v)
}

// 축3 supportLevel: 지원 수준. degraded = 지원되나 성능 저하(예: GPU 없이 CPU fallback).
export const CAPABILITY_SUPPORT_LEVEL = ['full', 'degraded'] as const
export type CapabilitySupportLevel = (typeof CAPABILITY_SUPPORT_LEVEL)[number]

export function isCapabilitySupportLevel(v: unknown): v is CapabilitySupportLevel {
  return typeof v === 'string' && (CAPABILITY_SUPPORT_LEVEL as readonly string[]).includes(v)
}

// 3축을 묶은 상태값. tool/model capability와 resolution 결과가 공유한다.
export interface CapabilityState {
  status: CapabilityStatus
  freshness: CapabilityFreshness
  supportLevel: CapabilitySupportLevel
  reasonCode: ReasonCode | null
}

// 3축 상태의 정합성 검증(§1 규칙 강제). 순수·부작용 없음.
//   - stale이면 status는 반드시 unverified(과거 supported를 stale에서 재사용 금지).
//   - stale를 단순 supported로 두지 않는다(위 규칙에 포함).
//   - degraded를 unsupported로 접지 않는다(degraded는 여전히 supported).
export function validateCapabilityState(s: CapabilityState): { ok: boolean; violation: ReasonCode | null } {
  if (s.freshness === 'stale' && s.status !== 'unverified') {
    // stale인데 status가 unverified가 아님 → 과거 결과 재사용(금지)
    return { ok: false, violation: 'EVIDENCE_STALE' }
  }
  if (s.supportLevel === 'degraded' && s.status === 'unsupported') {
    // degraded를 unsupported로 접음(금지)
    return { ok: false, violation: 'CPU_FALLBACK_AVAILABLE' }
  }
  return { ok: true, violation: null }
}

// stale 상태 생성 — 반드시 unverified. 과거 supported를 재사용하지 않는다(§1).
export function makeStaleCapabilityState(reasonCode: ReasonCode | null = 'EVIDENCE_STALE'): CapabilityState {
  return { status: 'unverified', freshness: 'stale', supportLevel: 'full', reasonCode }
}

// GPU 없음 + CPU fallback 가능 → supported·degraded·current(§1).
export function makeCpuFallbackCapabilityState(): CapabilityState {
  return { status: 'supported', freshness: 'current', supportLevel: 'degraded', reasonCode: 'CPU_FALLBACK_AVAILABLE' }
}

// 정상(완전 지원) 상태.
export function makeSupportedCapabilityState(): CapabilityState {
  return { status: 'supported', freshness: 'current', supportLevel: 'full', reasonCode: null }
}

// ── enum: 소유권 3축 정규화(§2) ──────────────────────────────────────────────
// 축1 ownership: 실제 소유. managed venv만 audioforge-managed, 그 외 전부 external-borrowed.
//   user-selected·legacy-detected는 ownership이 아니라 source다(아래 CandidateSource).
export const RUNTIME_OWNERSHIP = ['audioforge-managed', 'external-borrowed'] as const
export type RuntimeOwnership = (typeof RUNTIME_OWNERSHIP)[number]

export function isRuntimeOwnership(v: unknown): v is RuntimeOwnership {
  return typeof v === 'string' && (RUNTIME_OWNERSHIP as readonly string[]).includes(v)
}

// managed(우리 소유, 상대경로 허용)인가.
export function isManagedRuntime(o: RuntimeOwnership): boolean {
  return o === 'audioforge-managed'
}

// external-borrowed는 읽기 전용(우리가 수정·삭제 금지) — BORROWED_RUNTIME_READ_ONLY 사유의 근거.
export function isReadOnlyRuntime(o: RuntimeOwnership): boolean {
  return o === 'external-borrowed'
}

// 축2 source: 후보의 출처. user-selected·legacy-detected가 여기 속한다.
export const CANDIDATE_SOURCE = [
  'user-settings',
  'managed-runtime',
  'environment-variable',
  'user-selected-external',
  'path-discovery',
  'py-launcher-discovery',
  'legacy-detected',
] as const
export type CandidateSource = (typeof CANDIDATE_SOURCE)[number]

export function isCandidateSource(v: unknown): v is CandidateSource {
  return typeof v === 'string' && (CANDIDATE_SOURCE as readonly string[]).includes(v)
}

// 축3 status: 후보의 검증 진행 상태.
export const CANDIDATE_STATUS = ['discovered', 'probing', 'validated', 'rejected', 'unavailable'] as const
export type CandidateStatus = (typeof CANDIDATE_STATUS)[number]

export function isCandidateStatus(v: unknown): v is CandidateStatus {
  return typeof v === 'string' && (CANDIDATE_STATUS as readonly string[]).includes(v)
}

// ownership ↔ source 정합성(§2 규칙):
//   managed-runtime source ⇔ ownership=audioforge-managed. 그 외 source는 external-borrowed.
//   (예: 사용자가 지정한 ComfyUI Python = user-selected-external → external-borrowed)
export function validateOwnershipSource(
  ownership: RuntimeOwnership,
  source: CandidateSource,
): { ok: boolean; reasonCode: ReasonCode | null } {
  const managedSource = source === 'managed-runtime'
  const managedOwner = ownership === 'audioforge-managed'
  if (managedSource !== managedOwner) {
    return { ok: false, reasonCode: 'PREFLIGHT_FAILED' }
  }
  return { ok: true, reasonCode: null }
}

// ── 경로 규칙 헬퍼(§1) ──────────────────────────────────────────────────────
// 경로는 fs 접근 없이 문자열 형태만으로 계약을 강제한다(순수·mock 가능).

// 절대경로 여부: POSIX(`/...`), Windows 드라이브(`C:\`·`C:/`), UNC(`\\host`).
export function isAbsolutePath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false
  if (p.startsWith('/')) return true
  if (p.startsWith('\\\\')) return true // UNC
  return /^[A-Za-z]:[\\/]/.test(p)
}

// 경로를 세그먼트로 분해(양쪽 구분자 지원, 빈/현재 세그먼트 제거).
function pathSegments(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.')
}

// canonical absolute: 절대경로이면서 `..` 상대 세그먼트가 없음(정규화된 형태).
export function isCanonicalAbsolutePath(p: string): boolean {
  if (!isAbsolutePath(p)) return false
  return !pathSegments(p).includes('..')
}

// managed 상대경로: 절대경로가 아니고, `..`로 root 밖으로 탈출하지 않으며, 비어있지 않음.
export function isManagedRelativePath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false
  if (isAbsolutePath(p)) return false
  return !pathSegments(p).includes('..')
}

// 구분자 무관 basename(전체 경로 노출 없이 표시용 파일명만 추출).
export function basenameOf(p: string): string {
  const segs = p.split(/[\\/]+/).filter((s) => s.length > 0)
  return segs.length ? segs[segs.length - 1] : ''
}

// ── RuntimeFingerprint(§3) ──────────────────────────────────────────────────
// 문자열 단독 fingerprint 폐기. 경로·venv 위치·사용자명은 절대 포함하지 않는다.
export interface RuntimeFingerprint {
  algorithm: 'sha256'
  digest: string
  pythonVersion: string
  architecture: string
  lockHash: string | null
  probeVersion: string
  packageCount: number
}

// fingerprint 생성 — 경로가 흘러들지 않도록 필드를 명시적으로 고정한다.
export function makeRuntimeFingerprint(params: {
  digest: string
  pythonVersion: string
  architecture: string
  lockHash: string | null
  probeVersion: string
  packageCount: number
}): RuntimeFingerprint {
  return {
    algorithm: 'sha256',
    digest: params.digest,
    pythonVersion: params.pythonVersion,
    architecture: params.architecture,
    lockHash: params.lockHash,
    probeVersion: params.probeVersion,
    packageCount: params.packageCount,
  }
}

// ── ValidationEvidence envelope(§4) ─────────────────────────────────────────
// 검증 증거 봉투. traceback·전체경로·원문 stderr는 절대 담지 않는다.
// observedAt은 ISO 8601 문자열(비민감). 판단 근거는 짧은 버전 문자열·reasonCode로만.
export const EVIDENCE_KINDS = [
  'python-version',
  'architecture',
  'import',
  'package',
  'pip-check',
  'gpu',
  'model',
  'tool',
  'venv',
  'runtime-root',
] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

export function isEvidenceKind(v: unknown): v is EvidenceKind {
  return typeof v === 'string' && (EVIDENCE_KINDS as readonly string[]).includes(v)
}

export interface ValidationEvidenceItem {
  kind: EvidenceKind
  status: CapabilityStatus
  reasonCode: ReasonCode | null
  observedVersion: string | null
  requiredVersion: string | null
}

export interface ValidationEvidence {
  observedAt: string
  probeVersion: string
  fingerprint: RuntimeFingerprint
  checks: ValidationEvidenceItem[]
  packageCheck: ValidationEvidenceItem | null
  architectureCheck: ValidationEvidenceItem | null
  importCheck: ValidationEvidenceItem | null
  gpuCheck: ValidationEvidenceItem | null
  modelChecks: ValidationEvidenceItem[]
  toolChecks: ValidationEvidenceItem[]
}

// ── interpreter candidate(§2) ───────────────────────────────────────────────
// 후보 interpreter 1건. 경로 표기 규칙은 ownership에 종속(§1):
//   managed(audioforge-managed) → path는 runtimeRoot 기준 상대경로.
//   external-borrowed           → path는 canonical absolute path.
export interface InterpreterCandidate {
  schemaVersion: RuntimeContractSchemaVersion
  ownership: RuntimeOwnership
  source: CandidateSource
  status: CandidateStatus
  path: string
  version: string | null
}

// 후보의 경로 표기 + ownership/source 정합성을 검증(§1·§2). 순수·fs 무접근.
export function validateInterpreterCandidate(
  c: Pick<InterpreterCandidate, 'ownership' | 'source' | 'path'>,
): { ok: boolean; reasonCode: ReasonCode | null } {
  if (typeof c.path !== 'string' || c.path.length === 0) {
    return { ok: false, reasonCode: 'INTERPRETER_NOT_FOUND' }
  }
  const os = validateOwnershipSource(c.ownership, c.source)
  if (!os.ok) return os
  if (isManagedRuntime(c.ownership)) {
    return isManagedRelativePath(c.path)
      ? { ok: true, reasonCode: null }
      : { ok: false, reasonCode: 'PREFLIGHT_FAILED' }
  }
  return isCanonicalAbsolutePath(c.path)
    ? { ok: true, reasonCode: null }
    : { ok: false, reasonCode: 'PREFLIGHT_FAILED' }
}

// ── root descriptor & RuntimeRootConfig ─────────────────────────────────────
// 각 root는 경로 + 소유권 마커를 함께 가진다. 경로 값은 통합 담당이 주입한다.
export interface RuntimeRootDescriptor {
  // canonical absolute path. managed root는 워크트리 밖 stable root여야 한다(주석 참고).
  path: string
  ownership: RuntimeOwnership
}

// 3개 root 분리 계약.
//   runtimeRoot : venv·lock·capability cache. managed일 때 워크트리 밖 stable root
//                 (예: userData/runtime)여야 한다 — 워크트리는 브랜치 전환/삭제로 사라지므로
//                 관리형 런타임을 여기 두면 안 된다. 실제 경로 값은 주입.
//   modelRoot   : 다운로드된 모델 저장소.
//   cacheRoot   : 다운로드 staging(부분 파일·임시).
export interface RuntimeRootConfig {
  schemaVersion: RuntimeContractSchemaVersion
  runtimeRoot: RuntimeRootDescriptor
  modelRoot: RuntimeRootDescriptor
  cacheRoot: RuntimeRootDescriptor
}

// ── tool / model capability ─────────────────────────────────────────────────
// 3축 상태(CapabilityState)를 그대로 편다(status·freshness·supportLevel·reasonCode).
export interface ToolCapability {
  name: string
  status: CapabilityStatus
  freshness: CapabilityFreshness
  supportLevel: CapabilitySupportLevel
  reasonCode: ReasonCode | null
}

export interface ModelCapability {
  name: string
  status: CapabilityStatus
  freshness: CapabilityFreshness
  supportLevel: CapabilitySupportLevel
  reasonCode: ReasonCode | null
}

// capability 스냅샷 — 도구·모델을 plain 배열로(Map/Set 금지). fingerprint·evidence 봉투 포함.
export interface CapabilitySnapshot {
  schemaVersion: RuntimeContractSchemaVersion
  ownership: RuntimeOwnership
  fingerprint: RuntimeFingerprint
  evidence: ValidationEvidence
  tools: ToolCapability[]
  models: ModelCapability[]
}

// ── renderer view(§2) ───────────────────────────────────────────────────────
// renderer로 보내는 interpreter 참조 — 전체 경로 대신 pathRefId·basename·reasonCode만.
// 실제 경로는 main 프로세스가 pathRefId로 보관한다(renderer는 경로를 알 수 없음).
export interface RendererInterpreterRef {
  pathRefId: string
  basename: string
  reasonCode: ReasonCode | null
}

// 해결 결과 — renderer 소비 대상이므로 전체 경로가 없어야 한다(§2).
// 3축 상태(status/freshness/supportLevel) + 3축 소유(ownership/source/candidateStatus)
// + policyOutcome(정책 분기 결과)을 담는다. capabilities 스냅샷도 경로 없음.
export interface RuntimeResolutionResult {
  schemaVersion: RuntimeContractSchemaVersion
  resolved: boolean
  ownership: RuntimeOwnership
  source: CandidateSource
  candidateStatus: CandidateStatus
  status: CapabilityStatus
  freshness: CapabilityFreshness
  supportLevel: CapabilitySupportLevel
  reasonCode: ReasonCode | null
  policyOutcome: PolicyOutcome
  interpreter: RendererInterpreterRef
  capabilities: CapabilitySnapshot
}

// interpreter 후보 → renderer 참조로 축약(전체 경로 제거, basename만 노출).
// pathRefId는 main이 실제 경로를 되찾기 위한 불투명 키(경로 자체가 아님) — 통합 담당이 주입.
export function toRendererInterpreterRef(
  candidate: Pick<InterpreterCandidate, 'path'>,
  pathRefId: string,
  reasonCode: ReasonCode | null,
): RendererInterpreterRef {
  return {
    pathRefId,
    basename: basenameOf(candidate.path),
    reasonCode,
  }
}
