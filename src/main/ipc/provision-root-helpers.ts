import { createHash, createHmac } from 'node:crypto'
import { win32 as pathWin32, posix as pathPosix } from 'node:path'

export const MANAGED_ROOT_PROFILE = 'minimal-qwen' as const
export const MANAGED_ROOT_SCHEMA_VERSION = 1 as const
export const MANAGED_ROOT_KIND = 'audioforge-managed' as const
export const MANAGED_ROOT_MARKER = '.audioforge-root.json' as const

export interface ManagedRootRecord {
  schemaVersion: typeof MANAGED_ROOT_SCHEMA_VERSION
  baseRoot: string
  selectionNonce: string
  instanceId: string
  rootFingerprint: string
  volumeIdentity: string
  selectedAt: string
}
export interface ManagedRootPublicStatus { configured: boolean; displayLabel: string; approvalContext: string | null }
export interface ApprovalFingerprintInput { profile: string; planFingerprint: string; approvalContext: string }

const canonicalJson = (value: Record<string, string>): string => JSON.stringify(
  Object.keys(value).sort().reduce<Record<string, string>>((out, key) => { out[key] = value[key]; return out }, {}),
)
export function opaqueFingerprint(secret: string, domain: string, raw: string): string {
  return createHmac('sha256', secret).update(`${domain}\0${raw}`, 'utf8').digest('hex')
}
export function deriveManagedRoots(baseRoot: string, platform: 'win32' | 'posix' = 'win32') {
  const P = platform === 'win32' ? pathWin32 : pathPosix
  const base = P.normalize(baseRoot).replace(/[\\/]+$/, '') || P.normalize(baseRoot)
  return { runtimeRoot: P.join(base, 'runtime'), modelRoot: P.join(base, 'models'), cacheRoot: P.join(base, 'cache') }
}
export function rootApprovalContext(secret: string, record: ManagedRootRecord): string {
  return opaqueFingerprint(secret, 'managed-root-selection', canonicalJson({
    selectionNonce: record.selectionNonce, rootFingerprint: record.rootFingerprint, volumeIdentity: record.volumeIdentity,
  }))
}
export function publicRootStatus(secret: string | null, record: ManagedRootRecord | null): ManagedRootPublicStatus {
  return secret && record
    ? { configured: true, displayLabel: '사용자 선택 관리형 위치', approvalContext: rootApprovalContext(secret, record) }
    : { configured: false, displayLabel: '관리형 설치 위치를 선택하지 않음', approvalContext: null }
}
export function approvalFingerprint(input: ApprovalFingerprintInput): string {
  return createHash('sha256').update(canonicalJson({ profile: input.profile, planFingerprint: input.planFingerprint, approvalContext: input.approvalContext }), 'utf8').digest('hex')
}
