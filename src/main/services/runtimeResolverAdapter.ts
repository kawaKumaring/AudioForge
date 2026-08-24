// runtimeResolverAdapter — 순수 runtimeResolver 코어에 실제 fs/env/spawn/플랫폼을 주입하는 얇은 경계.
//
// 목적: audio.ipc.ts의 옛 `resolvePythonPath()` 안티패턴(① ComfyUI 절대경로 상수 ② exists만으로
//   채택 ③ 마지막 조용한 'python' fallback)을 제거하고, 검증 가능한 해석기를 배선한다.
//
// 경계 원칙:
//  - 이 모듈은 Electron/전역에 직접 접근하지 않는다 — 모든 I/O·환경·플랫폼·설정은 RuntimeAdapterDeps로 주입.
//    (audio.ipc가 실제 fs/execFile/app.getPath로 deps를 채워 넣는다. 그래서 이 파일은 node:test로 단위검증 가능.)
//  - resolver 코어(discovery/verify/select)는 그대로 소비만 한다(수정 금지).
//  - preflight는 비동기 subprocess(env_check.py --json)라 resolver의 sync preflight 포트와 맞지 않는다.
//    → discovery 후 후보를 async로 미리 probe해 캐시에 채우고, resolver에는 캐시를 읽는 sync 포트를 넘긴다.
//  - resolver는 절대 쓰기를 하지 않는다(borrowed 읽기 전용). onWrite가 불리면 즉시 throw로 계약을 런타임 보증.
//  - 관리형 저장 위치는 1) main이 marker/HMAC/volume을 재검증한 verifiedManagedRoots 또는
//    2) 명시 ops env만 인정한다. settings 원문 경로를 이 경계가 직접 신뢰하지 않는다.
//    Electron userData/Roaming은 설정·manifest 저장소일 뿐 대용량 runtime/model/cache 자동 대상이 아니다.

import { win32 as pathWin32, posix as pathPosix } from 'path'
import {
  discoverCandidates,
  verifyCandidates,
  selectRuntime,
  type RuntimeResolveSpec,
  type RuntimeResolverIO,
  type InterpreterProbeResult,
  type RuntimeResolveResult,
} from './runtimeResolver.ts'
import {
  RUNTIME_CONTRACT_SCHEMA_VERSION,
  basenameOf,
  type RuntimeRootConfig,
  type RuntimeOwnership,
  type ReasonCode,
} from '../../shared/runtimeContract.ts'

// ── 주입 타입 ────────────────────────────────────────────────────────────────

/** 사용자 설정에서 온 런타임 관련 값(전부 선택적, 절대경로 기대). */
export interface RuntimeSettings {
  /** 사용자가 명시 선택한 인터프리터(user-settings, 1순위). */
  pythonPath?: string
  /** 명시적 외부 인터프리터(user-selected-external, 4순위). */
  externalPythonPath?: string
  /** 관리형 런타임/모델/캐시 저장 루트(미설정 시 env → userData 파생). */
  runtimeRoot?: string
  modelRoot?: string
  cacheRoot?: string
  /** main-only 검증 API가 발급한 현재 접근용 roots. settings 원문으로 만들면 안 된다. */
  verifiedManagedRoots?: { runtimeRoot: string; modelRoot: string; cacheRoot: string }
  /** 옛 개별 root/legacy env.json 후보를 명시적으로 채택한 경우에만 true. */
  legacyRuntimeConsent?: boolean
}

/** 어댑터 주입 의존성 — 모든 I/O·환경·플랫폼은 여기로만(Electron/전역 접근 0). */
export interface RuntimeAdapterDeps {
  exists(path: string): boolean
  /** symlink/junction 해석. dangling/해석불가면 null. */
  realpath(path: string): string | null
  getEnv(name: string): string | undefined
  /** PATH·py launcher 발견 파이썬(미검증). 기본 구현은 빈 배열이어도 무방. */
  discoverPath(): string[]
  /** 중복 제거·realpath 비교용 정규화. */
  normalize(path: string): string
  /** 비동기 probe(env_check.py --json 등). 증거 없거나 실행 불가면 null. */
  probe(pythonPath: string): Promise<InterpreterProbeResult | null>
  /** 사용자 설정 스냅샷. */
  settings(): RuntimeSettings
  /** 과거 externals/env.json 기록 경로(legacy-detected 후보). 없으면 undefined. */
  legacyRecordPath(): string | undefined
  /** managed 저장 루트 기본값의 부모(Electron app.getPath('userData')). */
  userDataDir(): string
  /** 경로 형태 결정. 기본 'win32'. */
  platform?: 'win32' | 'posix'
}

/** 어댑터 해석 결과 — audio.ipc가 소비한다. interpreterPath는 spawn에 쓰는 절대 working path다. */
export interface AdapterResolution {
  resolved: boolean
  /** 선택된 인터프리터의 절대 working path(borrowed=canonical abs, managed=realpath abs). 미해석 시 null. */
  interpreterPath: string | null
  ownership: RuntimeOwnership | null
  /** 결과 요약 사유(성공 null). */
  reasonCode: ReasonCode | null
  /** 해석 성공 시에만. 계약 RuntimeRootConfig 1:1(Python config.roots로 직렬화). */
  roots: RuntimeRootConfig | null
  result: RuntimeResolveResult
}

// ── 저장 루트 해석(우선순위 + 정규화) ────────────────────────────────────────

function picker(deps: RuntimeAdapterDeps): typeof pathWin32 {
  return (deps.platform ?? 'win32') === 'win32' ? pathWin32 : pathPosix
}

/** 절대경로를 정규화(.. 제거)하고 후행 구분자를 제거해 canonical 형태로. */
function canon(P: typeof pathWin32, p: string): string {
  const norm = P.normalize(p)
  // 루트 자체가 아니면 후행 구분자 제거.
  const trimmed = norm.replace(/[\\/]+$/, '')
  return trimmed.length ? trimmed : norm
}

/** runtimeRoot/modelRoot/cacheRoot 해석. 값은 canonical absolute. */
export function resolveStorageRoots(deps: RuntimeAdapterDeps): {
  runtimeRoot: string
  modelRoot: string
  cacheRoot: string
} | null {
  const P = picker(deps)
  const s = deps.settings()
  if (s.verifiedManagedRoots) {
    return {
      runtimeRoot: canon(P, s.verifiedManagedRoots.runtimeRoot),
      modelRoot: canon(P, s.verifiedManagedRoots.modelRoot),
      cacheRoot: canon(P, s.verifiedManagedRoots.cacheRoot),
    }
  }
  // ops/E2E의 명시 환경 주입은 folder picker와 동급의 의도된 입력이다.
  const envRuntime = deps.getEnv('AUDIOFORGE_RUNTIME_ROOT')
  if (envRuntime) {
    const rt = canon(P, envRuntime)
    const base = P.dirname(rt)
    return {
      runtimeRoot: rt,
      modelRoot: canon(P, deps.getEnv('AUDIOFORGE_MODEL_ROOT') ?? P.join(base, 'models')),
      cacheRoot: canon(P, deps.getEnv('AUDIOFORGE_CACHE_ROOT') ?? P.join(base, 'cache')),
    }
  }
  // 기존 개별 root 설정은 사용자 동의가 저장된 경우에만 채택한다.
  if (!s.legacyRuntimeConsent || !s.runtimeRoot) return null
  const rt = s.runtimeRoot
  const base = P.dirname(rt)
  const mr = s.modelRoot ?? P.join(base, 'models')
  const cr = s.cacheRoot ?? P.join(base, 'cache')
  return { runtimeRoot: canon(P, rt), modelRoot: canon(P, mr), cacheRoot: canon(P, cr) }
}

/** 계약 RuntimeRootConfig 생성. 세 루트 모두 audioforge-managed(우리 소유 저장 위치). */
export function buildRootConfig(deps: RuntimeAdapterDeps): RuntimeRootConfig | null {
  const r = resolveStorageRoots(deps)
  if (!r) return null
  const ownership: RuntimeOwnership = 'audioforge-managed'
  return {
    schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
    runtimeRoot: { path: r.runtimeRoot, ownership },
    modelRoot: { path: r.modelRoot, ownership },
    cacheRoot: { path: r.cacheRoot, ownership },
  }
}

// ── resolver 입력·포트 구성 ──────────────────────────────────────────────────

/** deps → resolver spec(경로 문자열만; I/O 아님). */
export function buildResolveSpec(deps: RuntimeAdapterDeps): RuntimeResolveSpec {
  const s = deps.settings()
  const spec: RuntimeResolveSpec = {
    platform: deps.platform ?? 'win32',
    envVarName: 'AUDIOFORGE_PYTHON',
  }
  const roots = resolveStorageRoots(deps)
  if (roots) spec.runtimeRoot = roots.runtimeRoot
  if (s.pythonPath) spec.userSelectedPath = s.pythonPath
  if (s.externalPythonPath) spec.userSelectedExternalPath = s.externalPythonPath
  const legacy = deps.legacyRecordPath()
  if (s.legacyRuntimeConsent && legacy) spec.legacyRecordPath = legacy
  return spec
}

/** resolver IO 포트. preflight는 사전 채운 캐시를 sync로 읽는다. onWrite는 계약 위반이므로 throw. */
function makeResolverIO(deps: RuntimeAdapterDeps, cache: Map<string, InterpreterProbeResult | null>): RuntimeResolverIO {
  return {
    exists: (p) => deps.exists(p),
    realpath: (p) => deps.realpath(p),
    getEnv: (n) => deps.getEnv(n),
    discoverPath: () => deps.discoverPath(),
    normalize: (p) => deps.normalize(p),
    preflight: (p) => (cache.has(p) ? (cache.get(p) ?? null) : null),
    onWrite: (t) => {
      // resolver는 절대 쓰기를 하지 않는다(borrowed 읽기 전용 계약). 불리면 즉시 실패로 노출.
      throw new Error(`runtime resolver attempted a write (forbidden): ${basenameOf(t)}`)
    },
  }
}

// ── 오케스트레이션 ────────────────────────────────────────────────────────────

/** 발견 → (async probe) → 검증 → 선택. subprocess는 async, resolver 코어는 sync 유지. */
export async function resolveRuntimeWithDeps(deps: RuntimeAdapterDeps): Promise<AdapterResolution> {
  const spec = buildResolveSpec(deps)
  const cache = new Map<string, InterpreterProbeResult | null>()
  const io = makeResolverIO(deps, cache)

  const discovered = discoverCandidates(spec, io)
  // 존재·해석된 후보만 비동기 probe(exists만으로 채택 금지 — 증거가 있어야 validated).
  for (const c of discovered) {
    if (c.status === 'discovered' && c.resolvedPath && !cache.has(c.resolvedPath)) {
      cache.set(c.resolvedPath, await deps.probe(c.resolvedPath))
    }
  }
  const verified = verifyCandidates(discovered, io)
  const result = selectRuntime(verified, spec)

  const sel = result.selected
  const resolved = result.status === 'resolved' && sel != null
  return {
    resolved,
    interpreterPath: resolved && sel ? sel.resolvedPath : null,
    ownership: sel ? sel.ownership : null,
    reasonCode: result.reasonCode,
    roots: resolved ? buildRootConfig(deps) : null,
    result,
  }
}
