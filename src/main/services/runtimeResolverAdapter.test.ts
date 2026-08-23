// runtimeResolverAdapter 회귀 — DI mock만으로 검증(실 fs/spawn/electron 접근 0).
// 계약: managed 정상 / 미해석(→앱 RUNTIME_NOT_CONFIGURED) / borrowed read-only / exists만으로 채택 금지 /
//       사용자 선택 실패 시 조용한 외부 fallback 금지 / roots는 canonical absolute + audioforge-managed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveRuntimeWithDeps,
  buildResolveSpec,
  resolveStorageRoots,
  buildRootConfig,
  type RuntimeAdapterDeps,
  type RuntimeSettings,
} from './runtimeResolverAdapter.ts'
import type { InterpreterProbeResult } from './runtimeResolver.ts'
import {
  RUNTIME_CONTRACT_SCHEMA_VERSION,
  isCanonicalAbsolutePath,
  isReasonCode,
} from '../../shared/runtimeContract.ts'

const okProbe = (): InterpreterProbeResult => ({ ok: true, pythonVersion: '3.12.0', coreMissing: [] })
const badProbe = (): InterpreterProbeResult => ({ ok: false, coreMissing: ['torch'] })

interface MockCfg {
  existing?: string[]
  realpaths?: Record<string, string | null>
  env?: Record<string, string>
  probe?: Record<string, InterpreterProbeResult | null>
  settings?: RuntimeSettings
  legacy?: string
  userData?: string
  writeSpy?: string[]
}

function makeDeps(cfg: MockCfg): RuntimeAdapterDeps {
  const existing = new Set(cfg.existing ?? [])
  const realpaths = cfg.realpaths ?? {}
  const env = cfg.env ?? {}
  const probe = cfg.probe ?? {}
  return {
    exists: (p) => existing.has(p),
    realpath: (p) => {
      if (Object.prototype.hasOwnProperty.call(realpaths, p)) return realpaths[p]
      return existing.has(p) ? p : null
    },
    getEnv: (n) => env[n],
    discoverPath: () => [],
    normalize: (p) => p.toLowerCase().replace(/\\/g, '/'),
    probe: (p) => Promise.resolve(Object.prototype.hasOwnProperty.call(probe, p) ? probe[p] : null),
    settings: () => cfg.settings ?? {},
    legacyRecordPath: () => cfg.legacy,
    userDataDir: () => cfg.userData ?? 'C:\\Users\\x\\AppData\\Roaming\\AudioForge',
    platform: 'win32',
  }
}

const MANAGED_ROOT = 'C:\\Users\\x\\AppData\\Roaming\\AudioForge\\runtime'
const MANAGED_PY = 'C:\\Users\\x\\AppData\\Roaming\\AudioForge\\runtime\\Scripts\\python.exe'

// ── managed 정상 ─────────────────────────────────────────────────────────────
test('managed 정상: runtimeRoot 내 인터프리터 존재+probe ok → 채택(audioforge-managed) + roots 생성', async () => {
  const deps = makeDeps({
    settings: { runtimeRoot: MANAGED_ROOT },
    existing: [MANAGED_PY],
    probe: { [MANAGED_PY]: okProbe() },
  })
  const r = await resolveRuntimeWithDeps(deps)
  assert.equal(r.resolved, true)
  assert.equal(r.ownership, 'audioforge-managed')
  assert.equal(r.interpreterPath, MANAGED_PY)
  assert.equal(r.reasonCode, null)
  assert.ok(r.roots, 'roots가 있어야 한다')
  assert.equal(r.roots!.schemaVersion, RUNTIME_CONTRACT_SCHEMA_VERSION)
  for (const key of ['runtimeRoot', 'modelRoot', 'cacheRoot'] as const) {
    assert.equal(r.roots![key].ownership, 'audioforge-managed')
    assert.ok(isCanonicalAbsolutePath(r.roots![key].path), `${key} canonical absolute여야 한다: ${r.roots![key].path}`)
  }
  // model/cache는 runtime의 형제 위치.
  assert.equal(r.roots!.runtimeRoot.path, MANAGED_ROOT)
  assert.equal(r.roots!.modelRoot.path, 'C:\\Users\\x\\AppData\\Roaming\\AudioForge\\models')
  assert.equal(r.roots!.cacheRoot.path, 'C:\\Users\\x\\AppData\\Roaming\\AudioForge\\cache')
})

// ── 미해석(runtime 없음) → 앱 레벨 RUNTIME_NOT_CONFIGURED ────────────────────
test('runtime 없음: 아무 후보도 validated 아님 → unresolved + roots 생략 + canonical reasonCode', async () => {
  const deps = makeDeps({ /* 설정 없음, 관리형 인터프리터도 미존재 */ })
  const r = await resolveRuntimeWithDeps(deps)
  assert.equal(r.resolved, false)
  assert.equal(r.interpreterPath, null)
  assert.equal(r.roots, null, '미해석 시 roots 생략')
  assert.ok(r.reasonCode && isReasonCode(r.reasonCode), 'canonical reasonCode여야 한다')
  // 관리형 루트는 항상 확보되므로(userData/runtime) NO_RUNTIME_ROOT가 아니라 미발견으로 귀결.
  assert.equal(r.reasonCode, 'INTERPRETER_NOT_FOUND')
})

// ── borrowed read-only ───────────────────────────────────────────────────────
test('borrowed: 사용자 지정 외부 인터프리터 probe ok → 채택(external-borrowed, canWrite=false) + 쓰기 시도 0', async () => {
  const EXT = 'C:\\ComfyUI\\python_embeded\\python.exe'
  const deps = makeDeps({
    settings: { pythonPath: EXT },
    existing: [EXT],
    probe: { [EXT]: okProbe() },
  })
  const r = await resolveRuntimeWithDeps(deps)
  assert.equal(r.resolved, true)
  assert.equal(r.ownership, 'external-borrowed')
  assert.equal(r.interpreterPath, EXT)
  assert.ok(isCanonicalAbsolutePath(r.interpreterPath!), 'borrowed working path는 canonical absolute')
  // 선택 후보는 쓰기 금지(빌린 런타임).
  assert.equal(r.result.selected?.canWrite, false)
  // resolver가 쓰기를 시도했다면 어댑터 onWrite가 throw → 여기 도달 못 함. 정상 도달 = 쓰기 0.
})

// ── exists만으로 채택 금지 ───────────────────────────────────────────────────
test('exists하지만 probe 증거 없음(null) → discovered 유지, 채택 안 함(unresolved)', async () => {
  const deps = makeDeps({
    settings: { runtimeRoot: MANAGED_ROOT },
    existing: [MANAGED_PY],
    // probe 없음 → null 반환 → 증거 없음
  })
  const r = await resolveRuntimeWithDeps(deps)
  assert.equal(r.resolved, false)
  const managed = r.result.candidates.find((c) => c.source === 'managed-runtime')
  assert.equal(managed?.status, 'discovered', 'probe 증거 없으면 validated 아님')
})

// ── 사용자 선택 실패 → 조용한 외부 fallback 금지 ─────────────────────────────
test('사용자 선택 실패: probe 실패면 다른 외부로 조용히 전환하지 않고 USER_SELECTION_FAILED', async () => {
  const USER = 'C:\\bad\\python.exe'
  const OTHER = 'C:\\other\\python.exe'
  const deps = makeDeps({
    settings: { pythonPath: USER },
    existing: [USER, OTHER],
    probe: { [USER]: badProbe(), [OTHER]: okProbe() }, // OTHER는 discoverPath에 없으니 후보 아님이지만 방어
  })
  const r = await resolveRuntimeWithDeps(deps)
  assert.equal(r.resolved, false)
  assert.equal(r.reasonCode, 'USER_SELECTION_FAILED')
  assert.equal(r.roots, null)
})

// ── 순수 헬퍼 ────────────────────────────────────────────────────────────────
test('resolveStorageRoots 우선순위: settings > env > userData', () => {
  const bySettings = resolveStorageRoots(makeDeps({ settings: { runtimeRoot: 'C:\\S\\rt' } }))
  assert.equal(bySettings.runtimeRoot, 'C:\\S\\rt')

  const byEnv = resolveStorageRoots(makeDeps({ env: { AUDIOFORGE_RUNTIME_ROOT: 'C:\\E\\rt' } }))
  assert.equal(byEnv.runtimeRoot, 'C:\\E\\rt')

  const byUserData = resolveStorageRoots(makeDeps({ userData: 'C:\\U\\data' }))
  assert.equal(byUserData.runtimeRoot, 'C:\\U\\data\\runtime')
})

test('buildResolveSpec: 항상 runtimeRoot 확보 + envVarName 고정 + 사용자/legacy 반영', () => {
  const spec = buildResolveSpec(makeDeps({
    settings: { pythonPath: 'C:\\u\\py.exe' },
    legacy: 'C:\\legacy\\py.exe',
    userData: 'C:\\U\\data',
  }))
  assert.equal(spec.envVarName, 'AUDIOFORGE_PYTHON')
  assert.equal(spec.runtimeRoot, 'C:\\U\\data\\runtime')
  assert.equal(spec.userSelectedPath, 'C:\\u\\py.exe')
  assert.equal(spec.legacyRecordPath, 'C:\\legacy\\py.exe')
})

test('buildRootConfig: 세 루트 모두 audioforge-managed + canonical absolute', () => {
  const cfg = buildRootConfig(makeDeps({ settings: { runtimeRoot: 'C:\\a\\..\\b\\rt' } }))
  // '..' 정규화 확인
  assert.equal(cfg.runtimeRoot.path, 'C:\\b\\rt')
  for (const key of ['runtimeRoot', 'modelRoot', 'cacheRoot'] as const) {
    assert.equal(cfg[key].ownership, 'audioforge-managed')
    assert.ok(isCanonicalAbsolutePath(cfg[key].path))
  }
})
