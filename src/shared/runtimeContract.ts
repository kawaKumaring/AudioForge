// 독립 실행(standalone) 런타임 위치·소유권·capability 계약 — 순수 shared 단일 소스.
// 이 모듈은 타입 정의 + 순수 헬퍼만 담는다(process/fs/GPU/미디어 접근 0).
// resolver·capabilities·runtime 통합 담당이 이 계약을 소비/생산하며, 실제 경로 값·probe 결과는 주입한다.
//
// 계약이 강제하는 불변식(단위테스트로 고정):
//   1) 상대경로는 managed root 내부에만 허용. 외부 interpreter는 canonical absolute path로만 기록.
//   2) renderer로 나가는 결과에는 전체 경로가 없다 — pathRefId·basename·reason code만.
//   3) 직렬화는 plain 객체만(Map/Set 금지) → JSON round-trip byte-stable.
//   4) package fingerprint는 이름·version·lock hash 기반, 경로 제외.
//   5) 민감정보(전체 경로·traceback·사용자 내용)는 계약 타입에 포함하지 않는다.

// 계약 스키마 버전 — 필드 추가/변경 시 증가. 저장된 스냅샷 마이그레이션 판별에 사용.
export const RUNTIME_CONTRACT_SCHEMA_VERSION = 1 as const
export type RuntimeContractSchemaVersion = typeof RUNTIME_CONTRACT_SCHEMA_VERSION

// ── enum: interpreter/root 소유권 ──────────────────────────────────────────
//   audioforge-managed : AudioForge가 만든 관리형 venv/root(우리가 생성·삭제 가능)
//   user-selected      : 사용자가 명시 지정한 외부 interpreter
//   external-borrowed  : 시스템/타 앱 소유를 빌려 씀(우리가 소유 아님, 변경 금지)
//   legacy-detected    : 과거 버전/자동 탐지된 미확정 소유(마이그레이션 대상)
export const INTERPRETER_OWNERSHIP = [
  'audioforge-managed',
  'user-selected',
  'external-borrowed',
  'legacy-detected',
] as const
export type InterpreterOwnership = (typeof INTERPRETER_OWNERSHIP)[number]

export function isInterpreterOwnership(v: unknown): v is InterpreterOwnership {
  return typeof v === 'string' && (INTERPRETER_OWNERSHIP as readonly string[]).includes(v)
}

// 관리형(우리가 소유해 상대경로 허용) 소유권인가. managed만 runtimeRoot 상대경로 허용.
export function isManagedOwnership(o: InterpreterOwnership): boolean {
  return o === 'audioforge-managed'
}

// ── enum: capability 상태 ───────────────────────────────────────────────────
//   supported    : 검증 통과, 사용 가능
//   unsupported  : 이 플랫폼/구성에서 원리적으로 지원 안 됨
//   unavailable  : 지원되나 현재 미설치/미존재
//   incompatible : 존재하나 버전/구성 불일치
//   unverified   : 아직 검증(probe) 안 함
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

// ── enum: reason code (고정) ────────────────────────────────────────────────
// renderer로 나가는 사유는 자유 문자열이 아니라 이 고정 코드만. i18n·로깅·표시 안정성.
// 민감정보(경로·traceback·사용자 내용)를 사유로 흘리지 않기 위한 경계이기도 하다.
export const RUNTIME_REASON_CODES = [
  'ok',                    // 정상
  'not-found',             // 대상 없음(미설치/미존재)
  'version-mismatch',      // 버전 불일치
  'missing-package',       // 필수 패키지 없음
  'checksum-mismatch',     // lock/hash 불일치(무결성 실패)
  'permission-denied',     // 접근 권한 없음
  'unsupported-platform',  // 플랫폼 미지원
  'probe-failed',          // 검증 자체 실패(실행 오류)
  'not-verified',          // 아직 검증 안 함
  'external-unmanaged',    // 외부 소유라 관리 불가(경고성)
] as const
export type RuntimeReasonCode = (typeof RUNTIME_REASON_CODES)[number]

export function isRuntimeReasonCode(v: unknown): v is RuntimeReasonCode {
  return typeof v === 'string' && (RUNTIME_REASON_CODES as readonly string[]).includes(v)
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

// canonical absolute: 절대경로이면서 `..`/`.` 상대 세그먼트가 없음(정규화된 형태).
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

// ── root descriptor & RuntimeRootConfig ─────────────────────────────────────
// 각 root는 경로 + 소유권 마커를 함께 가진다. 경로 값은 통합 담당이 주입한다.
export interface RuntimeRootDescriptor {
  // canonical absolute path. managed root는 워크트리 밖 stable root여야 한다(주석 참고).
  path: string
  ownership: InterpreterOwnership
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

// ── interpreter candidate ───────────────────────────────────────────────────
// 후보 interpreter 1건. 경로 표기 규칙은 ownership에 종속(§1):
//   managed  → path는 runtimeRoot 기준 상대경로.
//   그 외    → path는 canonical absolute path.
export interface InterpreterCandidate {
  schemaVersion: RuntimeContractSchemaVersion
  ownership: InterpreterOwnership
  path: string
  version: string | null
}

// 후보의 경로 표기가 소유권 규칙에 맞는지 검증(§1). 순수·fs 무접근.
// 반환: ok=true면 규칙 충족. 실패 시 reason code로 사유.
export function validateInterpreterCandidate(
  c: Pick<InterpreterCandidate, 'ownership' | 'path'>,
): { ok: boolean; reason: RuntimeReasonCode } {
  if (typeof c.path !== 'string' || c.path.length === 0) {
    return { ok: false, reason: 'not-found' }
  }
  if (isManagedOwnership(c.ownership)) {
    // managed는 반드시 root 내부 상대경로.
    return isManagedRelativePath(c.path)
      ? { ok: true, reason: 'ok' }
      : { ok: false, reason: 'external-unmanaged' }
  }
  // 외부 소유는 canonical absolute만 허용.
  return isCanonicalAbsolutePath(c.path)
    ? { ok: true, reason: 'ok' }
    : { ok: false, reason: 'external-unmanaged' }
}

// ── package fingerprint(§4) ─────────────────────────────────────────────────
// 이름·version·lock hash만으로 구성. 경로 필드 없음(환경 독립 재현·비교용).
export interface PackageFingerprint {
  name: string
  version: string
  lockHash: string
}

// fingerprint 생성 — 경로가 흘러들지 않도록 필드를 명시적으로 고정한다.
export function makePackageFingerprint(name: string, version: string, lockHash: string): PackageFingerprint {
  return { name, version, lockHash }
}

// ── validation evidence ─────────────────────────────────────────────────────
// 검증 1건의 증거. 표시/로깅 안전 — traceback·전체 경로·사용자 내용은 담지 않는다.
// 버전 비교 등 판단 근거는 짧은 값으로만.
export interface ValidationEvidence {
  checkId: string
  status: CapabilityStatus
  reason: RuntimeReasonCode
  observedVersion: string | null
  expectedVersion: string | null
}

// ── tool / model capability ─────────────────────────────────────────────────
export interface ToolCapability {
  name: string
  status: CapabilityStatus
  version: string | null
  reason: RuntimeReasonCode
  evidence: ValidationEvidence[]
}

export interface ModelCapability {
  name: string
  status: CapabilityStatus
  fingerprint: PackageFingerprint
  reason: RuntimeReasonCode
  evidence: ValidationEvidence[]
}

// capability 스냅샷 — 도구·모델을 plain 배열로(Map/Set 금지). 직렬화·비교 안정.
export interface CapabilitySnapshot {
  schemaVersion: RuntimeContractSchemaVersion
  ownership: InterpreterOwnership
  tools: ToolCapability[]
  models: ModelCapability[]
}

// ── renderer view(§2) ───────────────────────────────────────────────────────
// renderer로 보내는 interpreter 참조 — 전체 경로 대신 pathRefId·basename·reason만.
// 실제 경로는 main 프로세스가 pathRefId로 보관한다(renderer는 경로를 알 수 없음).
export interface RendererInterpreterRef {
  pathRefId: string
  basename: string
  reason: RuntimeReasonCode
}

// 해결 결과 — renderer 소비 대상이므로 전체 경로가 없어야 한다(§2).
// capabilities 스냅샷도 경로를 담지 않으므로 그대로 포함 가능.
export interface RuntimeResolutionResult {
  schemaVersion: RuntimeContractSchemaVersion
  resolved: boolean
  ownership: InterpreterOwnership
  status: CapabilityStatus
  reason: RuntimeReasonCode
  interpreter: RendererInterpreterRef
  capabilities: CapabilitySnapshot
}

// interpreter 후보 → renderer 참조로 축약(전체 경로 제거, basename만 노출).
// pathRefId는 main이 실제 경로를 되찾기 위한 불투명 키(경로 자체가 아님) — 통합 담당이 주입.
export function toRendererInterpreterRef(
  candidate: Pick<InterpreterCandidate, 'path'>,
  pathRefId: string,
  reason: RuntimeReasonCode,
): RendererInterpreterRef {
  return {
    pathRefId,
    basename: basenameOf(candidate.path),
    reason,
  }
}
