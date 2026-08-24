// managed provision root의 순수 계약. 전체 경로는 main 프로세스 안에서만 소비하며,
// renderer에는 이 모듈이 만든 opaque token/fingerprint + 고정 displayLabel만 전달한다.
import { createHash, createHmac } from 'node:crypto'
import { win32 as pathWin32, posix as pathPosix } from 'node:path'

export const MANAGED_ROOT_PROFILE = 'minimal-qwen' as const

export interface ManagedRootRecord {
  baseRoot: string
  token: string
  rootFingerprint: string
  volumeIdentity: string
  selectedAt: string
}

export interface ManagedRootPublicStatus {
  configured: boolean
  displayLabel: string
  token: string | null
  rootFingerprint: string | null
  volumeIdentity: string | null
}

export interface ApprovalFingerprintInput {
  profile: string
  planFingerprint: string
  rootFingerprint: string
  volumeIdentity: string
}

const canonicalJson = (value: Record<string, string>): string => {
  const ordered = Object.keys(value).sort().reduce<Record<string, string>>((out, key) => {
    out[key] = value[key]
    return out
  }, {})
  return JSON.stringify(ordered)
}

/** 경로 원문을 복구할 수 없는 HMAC. secret과 전체 경로는 userData 설정(main)에만 둔다. */
export function opaqueFingerprint(secret: string, domain: string, raw: string): string {
  return createHmac('sha256', secret).update(`${domain}\0${raw}`, 'utf8').digest('hex')
}

/** 사용자 선택 base root 아래의 고정 managed 레이아웃. renderer로 반환하면 안 된다. */
export function deriveManagedRoots(baseRoot: string, platform: 'win32' | 'posix' = 'win32'): {
  runtimeRoot: string
  modelRoot: string
  cacheRoot: string
} {
  const P = platform === 'win32' ? pathWin32 : pathPosix
  const base = P.normalize(baseRoot).replace(/[\\/]+$/, '') || P.normalize(baseRoot)
  return {
    runtimeRoot: P.join(base, 'runtime'),
    modelRoot: P.join(base, 'models'),
    cacheRoot: P.join(base, 'cache'),
  }
}

export function publicRootStatus(record: ManagedRootRecord | null): ManagedRootPublicStatus {
  return record
    ? {
        configured: true,
        displayLabel: '사용자 선택 관리형 위치',
        token: record.token,
        rootFingerprint: record.rootFingerprint,
        volumeIdentity: record.volumeIdentity,
      }
    : {
        configured: false,
        displayLabel: '관리형 설치 위치를 선택하지 않음',
        token: null,
        rootFingerprint: null,
        volumeIdentity: null,
      }
}

/** plan 자체 fingerprint와 설치 대상 identity를 묶는다. 실제 승인 토큰은 아직 발급하지 않는다. */
export function approvalFingerprint(input: ApprovalFingerprintInput): string {
  return createHash('sha256').update(canonicalJson({
    profile: input.profile,
    planFingerprint: input.planFingerprint,
    rootFingerprint: input.rootFingerprint,
    volumeIdentity: input.volumeIdentity,
  }), 'utf8').digest('hex')
}

