// runtimeResolver — 런타임(파이썬 인터프리터) 후보 발견 + 랭킹/선택의 순수 코어.
//
// 목적: 기존 audio.ipc.ts `resolvePythonPath()`의 안티패턴
//   (① 절대경로 ComfyUI 상수  ② exists만으로 채택  ③ 마지막 'python' 조용한 fallback)
// 을 대체할, I/O를 전부 주입(DI)받는 검증 가능한 해석기.
//
// ── 계약 정합(reconcile v2) ─────────────────────────────────────────────────
// 이 모듈은 더 이상 소유권/출처/상태/사유 enum을 로컬 정의하지 않는다.
// 3축(ownership·source·status) + ReasonCode + PolicyOutcome는 전부
// `src/shared/runtimeContract.ts`(계약 v2)에서 import한다. resolver의
// **동작(discovery/verify/select 로직·순수성·규칙)은 불변** — 타입 소스만 shared로 교체.
//
// 계약과의 잔여 정합 지점(통합 담당 확인 필요):
//  - 계약에는 resolver 전용의 경량 preflight 신호 타입이 없다(계약의 ValidationEvidence는
//    capability 계층 C가 생산하는 무거운 봉투). 그래서 DI 포트가 돌려주는 최소 신호는
//    아래 `InterpreterProbeResult`로 resolver-내부에 둔다(계약 duplicate 아님).
//    통합 시 C의 ValidationEvidence로 승격/대체 가능.
//  - managed 후보의 계약 표기는 runtimeRoot 기준 **상대경로**(InterpreterCandidate.path)이나,
//    resolver 내부 working path(resolvedPath)는 exists/realpath/probe를 위해 절대경로다.
//    renderer용 InterpreterCandidate DTO로 축약할 때 통합 담당이 상대경로로 변환한다.
//
// 설계 규칙(강제·불변):
//  - 발견(discovery)과 선택(select)을 분리. select는 포트 0개 = 완전 순수 함수.
//  - 모든 I/O(exists·realpath·env·preflight·PATH 탐색)는 주입된 포트로만.
//  - exists만으로 채택 금지 — probe 증거 없으면 `discovered`(validated 아님 → 선택 불가).
//  - reject/unavailable 후보는 canonical ReasonCode 기록.
//  - 절대경로 상수 0 · 드라이브/WinGet/ComfyUI 하드코딩 0 · 조용한 'python' fallback 0.
//  - symlink/junction은 realpath로 resolved target 기록, dangling → unavailable.
//  - 동일 인터프리터(정규화 realpath 동일)는 중복 제거.
//  - user-selected 불량이면 다른 외부로 **조용히 전환 금지** → USER_SELECTION_FAILED로 명시.
//    managed로의 자동 전환도 PolicyOutcome로 **명시** — 조용한 전환 아님.
//  - runtimeRoot 미주입 + 해석 불가 시 조용한 python 대신 **NO_RUNTIME_ROOT** 명시.
//    이 코어는 setup/삭제/설치/쓰기를 하지 않는다(borrowed 읽기·검증만).

import {
  type RuntimeOwnership,
  type CandidateSource,
  type CandidateStatus,
  type ReasonCode,
  type PolicyOutcome,
  isManagedRuntime,
} from '../../shared/runtimeContract.ts'

// ── resolver-내부 타입 (계약 duplicate 아님) ─────────────────────────────────

/** DI 포트가 돌려주는 최소 probe 신호. 계약의 ValidationEvidence(무거운 봉투, C 생산)와 별개.
 *  null 반환 = 증거 없음(→ discovered 유지). ok=false = 검증 실패(→ rejected). */
export interface InterpreterProbeResult {
  ok: boolean              // core 패키지 충족(env_check core_ok에 대응)
  coreMissing?: string[]   // 부족 core 패키지(진단용, renderer로 나가지 않음)
  ttsMissing?: string[]
  pythonVersion?: string
}

/** 해석에 필요한 입력 명세(경로 문자열만; I/O 아님). */
export interface RuntimeResolveSpec {
  /** 1순위: 사용자가 설정에서 고른 인터프리터(user-settings). */
  userSelectedPath?: string
  /** 2순위: managed venv 루트. 미주입 시 managed 후보 없음 + 필요 시 NO_RUNTIME_ROOT. */
  runtimeRoot?: string
  /** 4순위: 사용자가 고른 외부/ComfyUI 인터프리터(user-selected-external). */
  userSelectedExternalPath?: string
  /** 과거 externals/env.json 기록 경로(stale 가능) → legacy-detected 후보. */
  legacyRecordPath?: string
  /** managed 인터프리터 경로 형태 결정. 기본 'win32'. */
  platform?: 'win32' | 'posix'
  /** 3순위 환경변수 이름. 기본 'AUDIOFORGE_PYTHON'. */
  envVarName?: string
}

/** 주입 포트 — 모든 I/O는 여기로만. 실제 fs/spawn/env 접근 없이 테스트한다. */
export interface RuntimeResolverIO {
  exists(path: string): boolean
  /** symlink/junction 해석. dangling/해석불가면 null. 일반 경로는 정규 절대경로. */
  realpath(path: string): string | null
  getEnv(name: string): string | undefined
  /** PATH·py launcher에서 발견한 파이썬들(검증 안 됨). */
  discoverPath(): string[]
  /** probe 검사. 증거 없거나 실행 불가면 null(→ discovered 유지). */
  preflight(pythonPath: string): InterpreterProbeResult | null
  /** 중복 제거·realpath 비교용 경로 정규화(대소문자·구분자). */
  normalize(path: string): string
  /** 쓰기 감시 스파이(선택). 이 코어는 **절대 호출하지 않는다** — 테스트가 미호출을 검증. */
  onWrite?(target: string): void
}

/** 후보 1건의 감사(audit) 레코드. 계약 InterpreterCandidate의 superset(내부 working 필드 포함). */
export interface RuntimeCandidate {
  source: CandidateSource
  rank: number
  rawPath: string
  resolvedPath: string | null
  ownership: RuntimeOwnership
  status: CandidateStatus
  /** skip/reject/unavailable 사유 — canonical ReasonCode만. */
  reasonCodes: ReasonCode[]
  probe?: InterpreterProbeResult | null
  /** 쓰기 허용 여부 = managed 소유일 때만 true(빌린 루트 쓰기 금지 계약). */
  canWrite: boolean
}

export interface RuntimeResolveResult {
  status: 'resolved' | 'unresolved'
  selected: RuntimeCandidate | null
  candidates: RuntimeCandidate[]
  /** 명시적 정책 분기 결과(조용한 전환 금지의 근거). 계약 PolicyOutcome union. */
  policyOutcomes: PolicyOutcome[]
  /** 사용자 선택이 있었으나 채택 실패했음을 UI에 표시하기 위한 플래그. */
  userSelectionFailed: boolean
  /** 결과 요약 사유(성공 시 null). 계약 ReasonCode canonical union. */
  reasonCode: ReasonCode | null
}

// ── 우선순위 랭크 (계약 CandidateSource 값 기준) ─────────────────────────────
const RANK: Record<CandidateSource, number> = {
  'user-settings': 1,
  'managed-runtime': 2,
  'environment-variable': 3,
  'user-selected-external': 4,
  'path-discovery': 5,
  'py-launcher-discovery': 6,
  'legacy-detected': 7,
}

// managed 부모 워커 venv 디렉터리명 — provisioner 고정 레이아웃(python/provision/layout.py
// RUNTIME_PARENT_VENV)과 반드시 동일해야 install 위치 == resolve 위치가 보장된다(단일 소스는 layout.py,
// 여기 리터럴은 그 미러; provision-layout-parity 테스트가 일치를 고정).
export const RUNTIME_PARENT_VENV = 'audioforge_venv'

/** runtimeRoot에서 managed 인터프리터 경로 도출(순수). 절대경로 상수 없음.
 * 부모 워커 venv는 runtimeRoot/audioforge_venv 아래에 있다(runtimeRoot 자체가 venv가 아님). */
export function managedInterpreterPath(runtimeRoot: string, platform: 'win32' | 'posix' = 'win32'): string {
  const sep = platform === 'win32' ? '\\' : '/'
  const parts = platform === 'win32'
    ? [RUNTIME_PARENT_VENV, 'Scripts', 'python.exe']
    : [RUNTIME_PARENT_VENV, 'bin', 'python']
  const root = runtimeRoot.replace(/[\\/]+$/, '')
  return [root, ...parts].join(sep)
}

// ── 1) 발견(discovery) — 포트로 exists/realpath/env/PATH 수집 + 중복 제거 ──────
// probe는 아직 안 함(상태 discovered|unavailable). 우선순위 순 정렬 반환.
export function discoverCandidates(spec: RuntimeResolveSpec, io: RuntimeResolverIO): RuntimeCandidate[] {
  const platform = spec.platform ?? 'win32'
  const envVarName = spec.envVarName ?? 'AUDIOFORGE_PYTHON'

  // 출처별 raw 후보 목록(순수 구성). 값 없으면 스킵.
  // ownership: managed-runtime만 audioforge-managed, 그 외 전부 external-borrowed(계약 §2).
  const specs: Array<{ source: CandidateSource; rawPath: string; ownership: RuntimeOwnership }> = []

  if (spec.userSelectedPath) {
    specs.push({ source: 'user-settings', rawPath: spec.userSelectedPath, ownership: 'external-borrowed' })
  }
  if (spec.runtimeRoot) {
    // managed 후보는 runtimeRoot가 주입됐을 때만 생성(위치 계약).
    specs.push({ source: 'managed-runtime', rawPath: managedInterpreterPath(spec.runtimeRoot, platform), ownership: 'audioforge-managed' })
  }
  const envPy = io.getEnv(envVarName)
  if (envPy) {
    specs.push({ source: 'environment-variable', rawPath: envPy, ownership: 'external-borrowed' })
  }
  if (spec.userSelectedExternalPath) {
    specs.push({ source: 'user-selected-external', rawPath: spec.userSelectedExternalPath, ownership: 'external-borrowed' })
  }
  for (const p of io.discoverPath()) {
    if (p) specs.push({ source: 'path-discovery', rawPath: p, ownership: 'external-borrowed' })
  }
  if (spec.legacyRecordPath) {
    specs.push({ source: 'legacy-detected', rawPath: spec.legacyRecordPath, ownership: 'external-borrowed' })
  }

  const candidates: RuntimeCandidate[] = specs.map(({ source, rawPath, ownership }) => {
    const c: RuntimeCandidate = {
      source,
      rank: RANK[source],
      rawPath,
      resolvedPath: null,
      ownership,
      status: 'discovered',
      reasonCodes: [],
      canWrite: isManagedRuntime(ownership),
    }
    if (!io.exists(rawPath)) {
      c.status = 'unavailable'
      c.reasonCodes.push('INTERPRETER_NOT_FOUND')
      return c
    }
    // 존재 → symlink/junction 해석. null이면 dangling.
    const real = io.realpath(rawPath)
    if (real === null) {
      c.status = 'unavailable'
      c.reasonCodes.push('DANGLING_JUNCTION')
      return c
    }
    c.resolvedPath = real
    // exists만으로는 discovered(채택 불가) — probe는 verify 단계에서.
    c.status = 'discovered'
    return c
  })

  // 안정 정렬(우선순위) — 이후 중복 제거가 상위 우선을 남기도록.
  candidates.sort((a, b) => a.rank - b.rank)

  // 동일 인터프리터(정규화 realpath 동일) 중복 제거: 상위 유지, 하위는 DUPLICATE_CANDIDATE.
  const seen = new Set<string>()
  for (const c of candidates) {
    if (c.resolvedPath === null) continue // unavailable은 중복 판정 제외
    const key = io.normalize(c.resolvedPath)
    if (seen.has(key)) {
      c.status = 'unavailable'
      if (!c.reasonCodes.includes('DUPLICATE_CANDIDATE')) c.reasonCodes.push('DUPLICATE_CANDIDATE')
    } else {
      seen.add(key)
    }
  }

  return candidates
}

// ── 2) 검증(verify) — probe 포트로 신호 부착 → validated/rejected/discovered ──
export function verifyCandidates(candidates: RuntimeCandidate[], io: RuntimeResolverIO): RuntimeCandidate[] {
  for (const c of candidates) {
    // 이미 unavailable(미존재/dangling/중복)은 검증 대상 아님.
    if (c.status === 'unavailable' || c.resolvedPath === null) continue
    const probe = io.preflight(c.resolvedPath)
    c.probe = probe
    if (probe === null) {
      // 증거 없음 → exists만으로 채택 금지 → discovered 유지(reasonCode 없음: reject 아님).
      c.status = 'discovered'
    } else if (probe.ok) {
      c.status = 'validated'
    } else {
      c.status = 'rejected'
      if (!c.reasonCodes.includes('PREFLIGHT_FAILED')) c.reasonCodes.push('PREFLIGHT_FAILED')
    }
  }
  return candidates
}

// ── 3) 선택(select) — 포트 0개, 완전 순수. 조용한 전환/fallback 금지 정책 포함. ─
export function selectRuntime(candidates: RuntimeCandidate[], spec: RuntimeResolveSpec): RuntimeResolveResult {
  const policyOutcomes: PolicyOutcome[] = []
  const ordered = [...candidates].sort((a, b) => a.rank - b.rank)
  const isSelectable = (c: RuntimeCandidate) => c.status === 'validated'

  const managedValidated = ordered.find((c) => c.source === 'managed-runtime' && isSelectable(c)) ?? null
  const userDeclared = spec.userSelectedPath !== undefined
  const userCand = ordered.find((c) => c.source === 'user-settings') ?? null

  // ── 사용자 선택이 선언된 경우: 조용한 외부 전환 금지 ──
  if (userDeclared) {
    if (userCand && isSelectable(userCand)) {
      return finalize('resolved', userCand, candidates, policyOutcomes, false, spec)
    }
    // 사용자 선택 실패 — 반드시 표시(USER_SELECTION_FAILED).
    // 다른 외부로 조용히 전환 금지. managed로의 전환만 명시적으로 허용.
    if (managedValidated) {
      policyOutcomes.push('switched-to-managed-explicit')
      return finalize('resolved', managedValidated, candidates, policyOutcomes, true, spec)
    }
    policyOutcomes.push('no-fallback-external-by-policy')
    return finalize('unresolved', null, candidates, policyOutcomes, true, spec)
  }

  // ── 사용자 선택 없음: 우선순위 순 첫 validated 채택 ──
  const picked = ordered.find(isSelectable) ?? null
  if (picked) {
    return finalize('resolved', picked, candidates, policyOutcomes, false, spec)
  }
  return finalize('unresolved', null, candidates, policyOutcomes, false, spec)
}

/** 최종 결과 조립 + reasonCode 요약(성공 null / 실패 canonical 코드). */
function finalize(
  status: 'resolved' | 'unresolved',
  selected: RuntimeCandidate | null,
  candidates: RuntimeCandidate[],
  policyOutcomes: PolicyOutcome[],
  userSelectionFailed: boolean,
  spec: RuntimeResolveSpec,
): RuntimeResolveResult {
  let reasonCode: ReasonCode | null = null
  if (status === 'unresolved') {
    // 사유 우선순위: 사용자 선택 실패 > runtimeRoot 미주입(managed setup 불가) > 일반 미발견.
    // (조용한 'python' fallback 대신 명시 사유를 항상 남긴다.)
    if (userSelectionFailed) reasonCode = 'USER_SELECTION_FAILED'
    else if (!spec.runtimeRoot) reasonCode = 'NO_RUNTIME_ROOT'
    else reasonCode = 'INTERPRETER_NOT_FOUND'
  }
  return { status, selected, candidates, policyOutcomes, userSelectionFailed, reasonCode }
}

// ── 오케스트레이터 — 발견 → 검증 → 선택 ──────────────────────────────────────
export function resolveRuntime(spec: RuntimeResolveSpec, io: RuntimeResolverIO): RuntimeResolveResult {
  const discovered = discoverCandidates(spec, io)
  const verified = verifyCandidates(discovered, io)
  return selectRuntime(verified, spec)
}
