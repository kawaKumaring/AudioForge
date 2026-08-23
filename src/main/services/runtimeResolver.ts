// runtimeResolver — 런타임(파이썬 인터프리터) 후보 발견 + 랭킹/선택의 순수 코어.
//
// 목적: 기존 audio.ipc.ts `resolvePythonPath()`의 안티패턴
//   (① 절대경로 ComfyUI 상수  ② exists만으로 채택  ③ 마지막 'python' 조용한 fallback)
// 을 대체할, I/O를 전부 주입(DI)받는 검증 가능한 해석기.
//
// ── 계약(contract) 자립성 안내 ──────────────────────────────────────────────
// R2-A가 `src/shared/runtimeContract.ts`에 공식 계약 타입(ownership/status enum,
// result 필드명)을 만들 예정이나 **이 브랜치에는 아직 없다.** 그래서 이 모듈은
// 입출력 인터페이스를 자체 정의한다. A 계약과 **구조적으로 정렬**되도록
// enum 값·result 필드명을 맞췄으며, 통합 시 아래 타입들을 A의 shared 계약으로
// 대체(reconcile)한다. reconcile 지점은 각 타입에 `@reconcile` 주석으로 표시.
//
// 설계 규칙(강제):
//  - 발견(discovery)과 선택(select)을 분리. select는 포트 0개 = 완전 순수 함수.
//  - 모든 I/O(exists·realpath·env·preflight·PATH 탐색)는 주입된 포트로만.
//  - exists만으로 채택 금지 — preflight evidence 없으면 `unverified`(선택 불가).
//  - invalid/skip 후보는 이유(reason code) 기록.
//  - 절대경로 상수 0 · 드라이브/WinGet/ComfyUI 하드코딩 0 · 조용한 'python' fallback 0.
//  - symlink/junction은 realpath로 resolved target 기록, dangling → unavailable.
//  - 동일 인터프리터(정규화 realpath 동일)는 중복 제거.
//  - user-selected 불량이면 다른 외부로 **조용히 전환 금지** → 선택 실패를 결과에 명시.
//    managed로의 자동 전환도 **정책 결과(policy)로 명시** — 조용한 전환 아님.
//  - runtimeRoot 미주입 시 managed 후보를 만들지 않으며, 해석 불가 시 조용한 python 대신
//    **명시 오류(no-runtime-root)**. 이 코어는 setup/삭제/설치/쓰기를 하지 않는다(읽기·검증만).

// ── 계약 타입 (self-defined; @reconcile → src/shared/runtimeContract.ts) ──────

/** 후보의 소유권. managed만 쓰기(setup/삭제) 허용, 나머지는 읽기·검증만.
 *  @reconcile A의 RuntimeOwnership와 값 동일하게 유지 */
export type RuntimeOwnership =
  | 'managed'   // AudioForge 소유 venv(runtimeRoot 내) — 유일하게 쓰기 허용
  | 'borrowed'  // 빌린 외부(ComfyUI·AUDIOFORGE_PYTHON·PATH) — 읽기·검증만
  | 'legacy'    // 과거 externals 기록에서 발견 — 읽기만, 후보로만

/** 후보 출처(우선순위 = rank의 근거).
 *  @reconcile A의 CandidateSource와 값 동일하게 유지 */
export type CandidateSource =
  | 'user-selected'          // 1. 사용자가 고른 인터프리터
  | 'managed'                // 2. managed 런타임(runtimeRoot 내)
  | 'env-var'                // 3. AUDIOFORGE_PYTHON
  | 'user-selected-external' // 4. 사용자가 고른 외부/ComfyUI 인터프리터
  | 'path-discovery'         // 5. PATH / py launcher 탐색
  | 'legacy-detected'        // (참고) 과거 externals 기록 — 후보로만

/** 후보 상태. verified만 선택 대상.
 *  @reconcile A의 CandidateStatus와 값 동일하게 유지 */
export type CandidateStatus =
  | 'verified'    // exists + realpath + preflight evidence 통과
  | 'unverified'  // exists하나 preflight evidence 없음 → 채택 불가
  | 'invalid'     // preflight 실행됐으나 실패(core 부족 등)
  | 'unavailable' // 미존재 / dangling junction / 중복

/** skip·강등 사유 코드.
 *  @reconcile A의 SkipReason과 값 동일하게 유지 */
export type SkipReason =
  | 'not-found'          // 경로 미존재
  | 'dangling-junction'  // junction/symlink가 대상 없음
  | 'duplicate'          // 상위 후보와 동일 인터프리터
  | 'preflight-failed'   // preflight 실행 후 core 부족
  | 'preflight-missing'  // preflight evidence 없음(포트가 null 반환)
  | 'no-runtime-root'    // managed 필요하나 runtimeRoot 미주입

/** preflight 증거 — python/env_check.py --json 산출과 정렬(core_ok/core_missing/tts_missing).
 *  @reconcile A가 PreflightEvidence를 정의하면 그것으로 대체 */
export interface PreflightEvidence {
  ok: boolean              // env_check core_ok
  coreMissing?: string[]   // core_missing
  ttsMissing?: string[]    // tts_missing
  pythonVersion?: string
}

/** 해석에 필요한 입력 명세(경로 문자열만; I/O 아님). */
export interface RuntimeResolveSpec {
  /** 1순위: 사용자가 명시적으로 고른 인터프리터(managed든 외부든). */
  userSelectedPath?: string
  /** 2순위: managed venv 루트. 미주입 시 managed 후보 없음 + 필요 시 명시 오류. */
  runtimeRoot?: string
  /** 4순위: 사용자가 고른 외부/ComfyUI 인터프리터. */
  userSelectedExternalPath?: string
  /** 과거 externals/env.json에 기록됐던 경로(stale 가능) → legacy-detected 후보. */
  legacyRecordPath?: string
  /** managed 인터프리터 경로 형태 결정. 기본 'win32'. */
  platform?: 'win32' | 'posix'
  /** 3순위 환경변수 이름. 기본 'AUDIOFORGE_PYTHON'. */
  envVarName?: string
}

/** 주입 포트 — 모든 I/O는 여기로만. 실제 fs/spawn/env 접근 없이 테스트한다. */
export interface RuntimeResolverIO {
  /** 경로 존재 여부. */
  exists(path: string): boolean
  /** symlink/junction 해석. dangling/해석불가면 null. 일반 경로는 정규 절대경로. */
  realpath(path: string): string | null
  /** 환경변수 읽기. */
  getEnv(name: string): string | undefined
  /** PATH·py launcher에서 발견한 파이썬들(검증 안 됨). */
  discoverPath(): string[]
  /** preflight 검사. evidence 없거나 실행 불가면 null(→ unverified). */
  preflight(pythonPath: string): PreflightEvidence | null
  /** 중복 제거·realpath 비교용 경로 정규화(대소문자·구분자). */
  normalize(path: string): string
  /** 쓰기 감시 스파이(선택). 이 코어는 **절대 호출하지 않는다** — 테스트가 미호출을 검증. */
  onWrite?(target: string): void
}

/** 후보 1건의 감사(audit) 레코드. */
export interface RuntimeCandidate {
  source: CandidateSource
  rank: number
  rawPath: string
  resolvedPath: string | null
  ownership: RuntimeOwnership
  status: CandidateStatus
  reasons: SkipReason[]
  evidence?: PreflightEvidence | null
  /** 쓰기 허용 여부 = managed 소유일 때만 true(빌린 루트 쓰기 금지 계약). */
  canWrite: boolean
}

/** 명시적 정책 결정(조용한 전환 금지의 근거를 결과로 남김). */
export interface PolicyOutcome {
  code:
    | 'user-selection-failed'          // 사용자 선택 후보가 검증 실패
    | 'switched-to-managed-explicit'   // 그 결과 managed로 전환(명시적)
    | 'no-fallback-external-by-policy' // 조용한 외부 전환을 정책상 차단
    | 'no-verified-candidate'          // 검증된 후보 자체가 없음
  detail?: string
}

export interface RuntimeResolveResult {
  status: 'resolved' | 'unresolved'
  selected: RuntimeCandidate | null
  candidates: RuntimeCandidate[]
  policy: PolicyOutcome[]
  /** 사용자 선택이 있었으나 채택 실패했음을 UI에 표시하기 위한 플래그. */
  userSelectionFailed: boolean
  error?: { code: 'no-runtime-root'; message: string }
}

// ── 우선순위 랭크 ────────────────────────────────────────────────────────────
const RANK: Record<CandidateSource, number> = {
  'user-selected': 1,
  managed: 2,
  'env-var': 3,
  'user-selected-external': 4,
  'path-discovery': 5,
  'legacy-detected': 6,
}

/** 소유권으로 쓰기 가능 여부 도출 — managed만 true. */
function writable(ownership: RuntimeOwnership): boolean {
  return ownership === 'managed'
}

/** runtimeRoot에서 managed 인터프리터 경로 도출(순수). 절대경로 상수 없음. */
export function managedInterpreterPath(runtimeRoot: string, platform: 'win32' | 'posix' = 'win32'): string {
  const sep = platform === 'win32' ? '\\' : '/'
  const parts = platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']
  const root = runtimeRoot.replace(/[\\/]+$/, '')
  return [root, ...parts].join(sep)
}

// ── 1) 발견(discovery) — 포트로 exists/realpath/env/PATH 수집 + 중복 제거 ──────
// preflight는 아직 안 함(상태는 unverified|unavailable). 우선순위 순 정렬 반환.
export function discoverCandidates(spec: RuntimeResolveSpec, io: RuntimeResolverIO): RuntimeCandidate[] {
  const platform = spec.platform ?? 'win32'
  const envVarName = spec.envVarName ?? 'AUDIOFORGE_PYTHON'

  // 출처별 raw 후보 목록(순수 구성). 값 없으면 스킵.
  const specs: Array<{ source: CandidateSource; rawPath: string; ownership: RuntimeOwnership }> = []

  if (spec.userSelectedPath) {
    specs.push({ source: 'user-selected', rawPath: spec.userSelectedPath, ownership: 'borrowed' })
  }
  if (spec.runtimeRoot) {
    // managed 후보는 runtimeRoot가 주입됐을 때만 생성(위치 계약).
    specs.push({ source: 'managed', rawPath: managedInterpreterPath(spec.runtimeRoot, platform), ownership: 'managed' })
  }
  const envPy = io.getEnv(envVarName)
  if (envPy) {
    specs.push({ source: 'env-var', rawPath: envPy, ownership: 'borrowed' })
  }
  if (spec.userSelectedExternalPath) {
    specs.push({ source: 'user-selected-external', rawPath: spec.userSelectedExternalPath, ownership: 'borrowed' })
  }
  for (const p of io.discoverPath()) {
    if (p) specs.push({ source: 'path-discovery', rawPath: p, ownership: 'borrowed' })
  }
  if (spec.legacyRecordPath) {
    specs.push({ source: 'legacy-detected', rawPath: spec.legacyRecordPath, ownership: 'legacy' })
  }

  const candidates: RuntimeCandidate[] = specs.map(({ source, rawPath, ownership }) => {
    const c: RuntimeCandidate = {
      source,
      rank: RANK[source],
      rawPath,
      resolvedPath: null,
      ownership,
      status: 'unverified',
      reasons: [],
      canWrite: writable(ownership),
    }
    if (!io.exists(rawPath)) {
      c.status = 'unavailable'
      c.reasons.push('not-found')
      return c
    }
    // 존재 → symlink/junction 해석. null이면 dangling.
    const real = io.realpath(rawPath)
    if (real === null) {
      c.status = 'unavailable'
      c.reasons.push('dangling-junction')
      return c
    }
    c.resolvedPath = real
    // exists만으로는 unverified(채택 불가) — preflight는 verify 단계에서.
    c.status = 'unverified'
    return c
  })

  // 안정 정렬(우선순위) — 이후 중복 제거가 상위 우선을 남기도록.
  candidates.sort((a, b) => a.rank - b.rank)

  // 동일 인터프리터(정규화 realpath 동일) 중복 제거: 상위 유지, 하위는 'duplicate'.
  const seen = new Set<string>()
  for (const c of candidates) {
    if (c.resolvedPath === null) continue // unavailable은 중복 판정 제외
    const key = io.normalize(c.resolvedPath)
    if (seen.has(key)) {
      c.status = 'unavailable'
      if (!c.reasons.includes('duplicate')) c.reasons.push('duplicate')
    } else {
      seen.add(key)
    }
  }

  return candidates
}

// ── 2) 검증(verify) — preflight 포트로 evidence 부착 → verified/invalid/unverified ─
export function verifyCandidates(candidates: RuntimeCandidate[], io: RuntimeResolverIO): RuntimeCandidate[] {
  for (const c of candidates) {
    // 이미 unavailable(미존재/dangling/중복)은 검증 대상 아님.
    if (c.status === 'unavailable' || c.resolvedPath === null) continue
    const evidence = io.preflight(c.resolvedPath)
    c.evidence = evidence
    if (evidence === null) {
      // 증거 없음 → exists만으로 채택 금지 → unverified.
      c.status = 'unverified'
      if (!c.reasons.includes('preflight-missing')) c.reasons.push('preflight-missing')
    } else if (evidence.ok) {
      c.status = 'verified'
    } else {
      c.status = 'invalid'
      if (!c.reasons.includes('preflight-failed')) c.reasons.push('preflight-failed')
    }
  }
  return candidates
}

// ── 3) 선택(select) — 포트 0개, 완전 순수. 조용한 전환/ fallback 금지 정책 포함. ─
const EXTERNAL_SOURCES: ReadonlySet<CandidateSource> = new Set<CandidateSource>([
  'env-var',
  'user-selected-external',
  'path-discovery',
  'legacy-detected',
])

export function selectRuntime(candidates: RuntimeCandidate[], spec: RuntimeResolveSpec): RuntimeResolveResult {
  const policy: PolicyOutcome[] = []
  const ordered = [...candidates].sort((a, b) => a.rank - b.rank)
  const isSelectable = (c: RuntimeCandidate) => c.status === 'verified'

  const managedVerified = ordered.find((c) => c.source === 'managed' && isSelectable(c)) ?? null
  const userDeclared = spec.userSelectedPath !== undefined
  const userCand = ordered.find((c) => c.source === 'user-selected') ?? null

  // ── 사용자 선택이 선언된 경우: 조용한 외부 전환 금지 ──
  if (userDeclared) {
    if (userCand && isSelectable(userCand)) {
      return finalize('resolved', userCand, candidates, policy, false, spec)
    }
    // 사용자 선택 실패 — 반드시 표시.
    const why = userCand ? userCand.reasons.join(',') || userCand.status : 'not-found'
    policy.push({ code: 'user-selection-failed', detail: `user-selected 후보 채택 실패(${why})` })
    // 다른 외부로 조용히 전환 금지. managed로의 전환만 명시적으로 허용.
    if (managedVerified) {
      policy.push({ code: 'switched-to-managed-explicit', detail: 'user 선택 실패 → managed 런타임으로 명시 전환' })
      return finalize('resolved', managedVerified, candidates, policy, true, spec)
    }
    policy.push({ code: 'no-fallback-external-by-policy', detail: 'user 선택 실패 시 외부 자동 전환 차단' })
    return finalize('unresolved', null, candidates, policy, true, spec)
  }

  // ── 사용자 선택 없음: 우선순위 순 첫 verified 채택 ──
  const picked = ordered.find(isSelectable) ?? null
  if (picked) {
    return finalize('resolved', picked, candidates, policy, false, spec)
  }
  policy.push({ code: 'no-verified-candidate', detail: '검증된 후보 없음' })
  return finalize('unresolved', null, candidates, policy, false, spec)
}

/** 최종 결과 조립 + runtimeRoot 미주입 명시 오류 판정. */
function finalize(
  status: 'resolved' | 'unresolved',
  selected: RuntimeCandidate | null,
  candidates: RuntimeCandidate[],
  policy: PolicyOutcome[],
  userSelectionFailed: boolean,
  spec: RuntimeResolveSpec,
): RuntimeResolveResult {
  const result: RuntimeResolveResult = { status, selected, candidates, policy, userSelectionFailed }
  // 해석 불가 + runtimeRoot 미주입 → 조용한 'python' 대신 명시 오류.
  // (managed로 회복하려면 runtimeRoot가 필요한데 없으므로 setup/install 불가.)
  if (status === 'unresolved' && !spec.runtimeRoot) {
    result.error = {
      code: 'no-runtime-root',
      message: 'runtimeRoot 미주입 — managed 런타임 setup/설치 불가. 조용한 fallback 금지.',
    }
  }
  return result
}

// ── 오케스트레이터 — 발견 → 검증 → 선택 ──────────────────────────────────────
export function resolveRuntime(spec: RuntimeResolveSpec, io: RuntimeResolverIO): RuntimeResolveResult {
  const discovered = discoverCandidates(spec, io)
  const verified = verifyCandidates(discovered, io)
  return selectRuntime(verified, spec)
}
