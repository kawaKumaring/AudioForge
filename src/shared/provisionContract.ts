// provisionContract — managed provisioner의 pure TS 계약(타입 + fingerprint/manifest 해석 + plan 요약).
//
// 이 모듈은 순수하다: process/fs/crypto/네트워크 접근 0. Electron/UI(Agent Q)는 이 타입과 해석
// 헬퍼만 소비해 IPC(provision:plan/verify)와 RuntimeProvisionPanel을 붙인다. Q는 별도 staging/
// fingerprint 구현을 만들지 않는다 — Python provision 코어(단일 소스)가 산출한 JSON을 그대로 실어
// 나른다. 이 계약은 그 JSON의 형태·해석·displayLabel 규약을 고정한다.
//
// 불변식(단위테스트로 고정):
//   1) plan/verify 결과에는 전체 절대경로가 없다 — installPath(레이아웃 상대경로)·displayLabel·
//      basename·ownership·reasonCode만. assertNoAbsolutePaths가 런타임 가드.
//   2) reasonCode 슬롯은 계약 ReasonCode(runtimeContract) 또는 null만(자유 문자열 금지).
//   3) canonicalize는 Python provision.fingerprint.canonical_json과 동형(byte-stable) — planFingerprint
//      는 Python이 발급하고 TS는 동일 canonical 규칙으로 재현·대조만 한다(해시는 main에서).

import type { ReasonCode } from './runtimeContract'

export const PROVISION_CONTRACT_SCHEMA_VERSION = 1 as const
export type ProvisionContractSchemaVersion = typeof PROVISION_CONTRACT_SCHEMA_VERSION
// Python provision.manifest schema (plan envelope schema와 별개).
export const PROVISION_MANIFEST_SCHEMA_VERSION = 2 as const
export const DEFAULT_PROVISION_PROFILE = 'minimal-qwen' as const

// ── component 종류 ───────────────────────────────────────────────────────────
export const COMPONENT_KINDS = ['bootstrap', 'venv', 'tool', 'model', 'cache'] as const
export type ComponentKind = (typeof COMPONENT_KINDS)[number]

export function isComponentKind(v: unknown): v is ComponentKind {
  return typeof v === 'string' && (COMPONENT_KINDS as readonly string[]).includes(v)
}

// license는 코드/가중치/데이터/산출물 구분 보관(§10). null이면 미상(→ unresolved 근거).
export interface LicenseInfo {
  code: string
  weights: string
  data: string
  output: string
}

export interface ImmutableArtifact {
  url: string | null
  revision: string | null
  filename: string | null
  sha256: string | null
  compressedBytes: number | null
  installedBytes: number | null
  license: LicenseInfo | null
  noticeSha256: string | null
  sbomSha256: string | null
}

export interface HashedLockEntry {
  name: string
  version: string
  filename: string
  sha256: string
}

export interface ExactHashedLock {
  format: 'pip-requirements-hashes'
  sha256: string | null
  entries: HashedLockEntry[]
}

// model kind 필수 파일 1건 — 상대 path + 파일별 sha256(미상이면 null → unresolved).
export interface RequiredFile {
  path: string
  sha256: string | null
}

export interface ComponentSizes {
  compressed: number | null
  installed: number | null
  total: number | null
}

// plan이 실어 나르는 renderer-safe component 요약(절대경로 0).
export interface ComponentView {
  id: string
  kind: ComponentKind
  version: string | null
  required: boolean
  dependsOn: string[]
  installPath: string | null // 레이아웃 상대경로. 전체 절대경로 아님.
  displayLabel: string | null
  license: LicenseInfo | null
  resolved: boolean
  reasonCode: ReasonCode | null
  sizes: ComponentSizes
  // model kind에만 존재.
  repoId?: string | null
  pinnedRevision?: string | null
  requiredFiles?: RequiredFile[]
  artifact?: ImmutableArtifact | null
  lock?: ExactHashedLock | null
}

export interface ManifestComponent extends Omit<ComponentView, 'resolved' | 'reasonCode' | 'sizes'> {
  artifact?: ImmutableArtifact | null
  lock?: ExactHashedLock | null
}

export interface ProvisionProfile {
  componentIds: string[]
  excludedComponentIds: string[]
}

export interface ProvisionManifestV2 {
  schemaVersion: typeof PROVISION_MANIFEST_SCHEMA_VERSION
  profile: typeof DEFAULT_PROVISION_PROFILE
  profiles: Record<string, ProvisionProfile>
  components: ManifestComponent[]
}

const SHA256_RE = /^[0-9a-f]{64}$/i
const MUTABLE_REVISIONS = new Set(['latest', 'main', 'master', 'head', 'tip', 'stable'])

export function isSafeProvisionRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return false
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'
    && !part.includes('\0') && !part.includes(':') && part.trim() === part && !part.endsWith('.'))
}

function validLicense(value: unknown): value is LicenseInfo {
  if (!value || typeof value !== 'object') return false
  const lic = value as Record<string, unknown>
  return ['code', 'weights', 'data', 'output'].every((key) => typeof lic[key] === 'string' && (lic[key] as string).trim().length > 0)
}

export function isImmutableArtifact(value: unknown): value is ImmutableArtifact {
  if (!value || typeof value !== 'object') return false
  const a = value as Record<string, unknown>
  let parsed: URL
  try { parsed = new URL(String(a.url)) } catch { return false }
  const revision = typeof a.revision === 'string' ? a.revision.trim() : ''
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password
    && revision.length > 0 && !MUTABLE_REVISIONS.has(revision.toLowerCase())
    && isSafeProvisionRelativePath(a.filename) && !(a.filename as string).includes('/')
    && typeof a.sha256 === 'string' && SHA256_RE.test(a.sha256)
    && Number.isSafeInteger(a.compressedBytes) && (a.compressedBytes as number) > 0
    && Number.isSafeInteger(a.installedBytes) && (a.installedBytes as number) > 0
    && validLicense(a.license)
    && typeof a.noticeSha256 === 'string' && SHA256_RE.test(a.noticeSha256)
    && typeof a.sbomSha256 === 'string' && SHA256_RE.test(a.sbomSha256)
}

export function isExactHashedLock(value: unknown): value is ExactHashedLock {
  if (!value || typeof value !== 'object') return false
  const lock = value as Record<string, unknown>
  if (lock.format !== 'pip-requirements-hashes' || typeof lock.sha256 !== 'string' || !SHA256_RE.test(lock.sha256)) return false
  if (!Array.isArray(lock.entries) || lock.entries.length === 0) return false
  const names = new Set<string>()
  for (const raw of lock.entries) {
    if (!raw || typeof raw !== 'object') return false
    const e = raw as Record<string, unknown>
    const name = typeof e.name === 'string' ? e.name : ''
    const version = typeof e.version === 'string' ? e.version : ''
    if (!name || names.has(name.toLowerCase()) || !version || /[<>=!~* ,@]/.test(version)) return false
    if (!isSafeProvisionRelativePath(e.filename) || (e.filename as string).includes('/')) return false
    if (typeof e.sha256 !== 'string' || !SHA256_RE.test(e.sha256)) return false
    names.add(name.toLowerCase())
  }
  return true
}

export function manifestComponentIsResolved(component: ManifestComponent): boolean {
  if (!isSafeProvisionRelativePath(component.installPath)) return false
  if (component.kind === 'cache') return typeof component.version === 'string' && component.version.length > 0
  if (!isImmutableArtifact(component.artifact)) return false
  if (component.kind === 'venv' && !isExactHashedLock(component.lock)) return false
  if (component.kind === 'model') {
    if (!Array.isArray(component.requiredFiles) || component.requiredFiles.length === 0) return false
    const paths = new Set<string>()
    for (const file of component.requiredFiles) {
      if (!isSafeProvisionRelativePath(file.path)) return false
      const pathKey = file.path.toLocaleLowerCase('en-US')
      if (paths.has(pathKey) || typeof file.sha256 !== 'string' || !SHA256_RE.test(file.sha256)) return false
      paths.add(pathKey)
    }
  }
  return true
}

// provision:plan / provision:dry-run 반환 형태(Python state.plan/dry_run과 1:1).
export interface PlanResult {
  schemaVersion: ProvisionContractSchemaVersion
  mode: 'plan' | 'dry-run'
  components: ComponentView[]
  resolvedAll: boolean
  blockingReasons: ReasonCode[]
  planFingerprint: string
}

// provision:verify 항목/반환 형태(Python state.verify와 1:1).
export interface VerifyItem {
  id: string
  kind: ComponentKind
  displayLabel: string | null
  resolved: boolean
  present: boolean
  reasonCode: ReasonCode | null
}

export interface VerifyResult {
  schemaVersion: ProvisionContractSchemaVersion
  mode: 'verify'
  components: VerifyItem[]
}

// ── canonical JSON(Python canonical_json 동형) ──────────────────────────────
// 규칙: dict 키 사전순 정렬(재귀), 공백 0, 비-ASCII 보존(JSON.stringify 기본), undefined 키 생략.
// 정수/문자열/불리언/null만 fingerprint 입력에 쓴다(float 금지 — 크기는 정수).
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  const t = typeof value
  if (t === 'number') {
    if (!Number.isFinite(value as number)) throw new Error('canonicalize: 비유한 숫자 금지')
    return String(value)
  }
  if (t === 'boolean') return (value as boolean) ? 'true' : 'false'
  if (t === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalize(v)).join(',') + ']'
  if (t === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}'
  }
  throw new Error(`canonicalize: 직렬화 불가 타입 ${t}`)
}

// ── plan 해석 헬퍼(순수) ─────────────────────────────────────────────────────

// plan이 apply 가능한 상태인가(이번 단계 apply는 어차피 비활성이나, UI가 버튼 활성/사유 표시에 사용).
// 미해결 component가 하나라도 있으면 apply 불가 + 첫 blocking 사유를 돌려준다.
export function planIsApplicable(plan: PlanResult): { ok: boolean; reasonCode: ReasonCode | null } {
  if (!plan.resolvedAll || plan.blockingReasons.length > 0) {
    return { ok: false, reasonCode: plan.blockingReasons[0] ?? 'UNRESOLVED_COMPONENT' }
  }
  return { ok: true, reasonCode: null }
}

// 승인 토큰(사용자가 승인한 fingerprint)이 현재 plan과 일치하는가. manifest/경로/버전 변경 시
// plan.planFingerprint가 달라지므로 과거 토큰은 자동 무효.
export function tokenMatchesPlan(token: string | null | undefined, plan: PlanResult): boolean {
  return typeof token === 'string' && token.length > 0 && token === plan.planFingerprint
}

// 설치 예상 총 용량(installed 우선, 없으면 total). 미상(null)은 합산에서 제외하되 hasUnknown로 표시.
export function estimateInstallBytes(plan: PlanResult): { bytes: number; hasUnknown: boolean } {
  let bytes = 0
  let hasUnknown = false
  for (const c of plan.components) {
    const v = c.sizes.installed ?? c.sizes.total
    if (typeof v === 'number') bytes += v
    else hasUnknown = true
  }
  return { bytes, hasUnknown }
}

// ── displayLabel 규약(§11) — renderer에 전체 경로 노출 0 ─────────────────────
export type RootKey = 'runtimeRoot' | 'modelRoot' | 'cacheRoot'
export type RootOwnership = 'audioforge-managed' | 'external-borrowed'

const MANAGED_ROOT_LABEL: Record<RootKey, string> = {
  runtimeRoot: 'AudioForge 앱 데이터/runtime',
  modelRoot: 'AudioForge 앱 데이터/models',
  cacheRoot: 'AudioForge 앱 데이터/cache',
}

// root 표시 라벨: managed는 고정 라벨, borrowed는 "사용자 선택 위치". 절대경로를 절대 반환하지 않는다.
export function displayRootLabel(rootKey: RootKey, ownership: RootOwnership): string {
  return ownership === 'audioforge-managed' ? MANAGED_ROOT_LABEL[rootKey] : '사용자 선택 위치'
}

// component 표시 라벨: manifest displayLabel 우선, 없으면 installPath basename, 그것도 없으면 id.
export function displayComponentLabel(c: Pick<ComponentView, 'displayLabel' | 'installPath' | 'id'>): string {
  if (c.displayLabel) return c.displayLabel
  if (c.installPath) {
    const segs = c.installPath.split(/[\\/]+/).filter((s) => s.length > 0)
    if (segs.length) return segs[segs.length - 1]
  }
  return c.id
}

// ── renderer-safety 가드: plan/verify 어디에도 절대경로가 없는지 검사(순수) ──
function looksAbsolute(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false
  if (p.startsWith('/')) return true
  if (p.startsWith('\\\\')) return true
  return /^[A-Za-z]:[\\/]/.test(p)
}

// 객체 그래프의 모든 문자열 값을 훑어 절대경로 형태가 있으면 그 경로를 반환(없으면 null).
// plan/verify를 renderer로 보내기 전 main에서 호출해 계약 위반을 조기 검출.
export function findAbsolutePath(value: unknown): string | null {
  if (typeof value === 'string') return looksAbsolute(value) ? value : null
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findAbsolutePath(v)
      if (hit) return hit
    }
    return null
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const hit = findAbsolutePath(v)
      if (hit) return hit
    }
  }
  return null
}

export function assertNoAbsolutePaths(value: unknown): void {
  const hit = findAbsolutePath(value)
  if (hit) throw new Error('provision 결과에 전체 절대경로가 포함됨(renderer 노출 금지)')
}
