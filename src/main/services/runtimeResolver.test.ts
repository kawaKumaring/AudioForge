// runtimeResolver 회귀 — 발견/랭킹/선택 순수 코어. 실 spawn/설치/fs 접근 없이 DI mock으로만 검증.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveRuntime,
  discoverCandidates,
  verifyCandidates,
  selectRuntime,
  managedInterpreterPath,
  type RuntimeResolverIO,
  type PreflightEvidence,
  type RuntimeCandidate,
} from './runtimeResolver.ts'

// ── DI mock 팩토리 ───────────────────────────────────────────────────────────
interface MockCfg {
  existing?: string[]                         // 존재하는 경로
  realpaths?: Record<string, string | null>   // 경로→realpath(null=dangling). 없으면 identity.
  env?: Record<string, string>
  pathList?: string[]                          // discoverPath 반환
  preflight?: Record<string, PreflightEvidence | null> // realpath→evidence(null=증거없음)
}

function ok(pythonVersion = '3.12.0'): PreflightEvidence {
  return { ok: true, pythonVersion, ttsMissing: [] }
}
function fail(coreMissing: string[]): PreflightEvidence {
  return { ok: false, coreMissing }
}

function makeIO(cfg: MockCfg) {
  const existing = new Set(cfg.existing ?? [])
  const realpaths = cfg.realpaths ?? {}
  const env = cfg.env ?? {}
  const pathList = cfg.pathList ?? []
  const preflight = cfg.preflight ?? {}
  const writes: string[] = []

  const io: RuntimeResolverIO = {
    exists: (p) => existing.has(p),
    realpath: (p) => {
      if (Object.prototype.hasOwnProperty.call(realpaths, p)) return realpaths[p]
      return existing.has(p) ? p : null
    },
    getEnv: (name) => env[name],
    discoverPath: () => [...pathList],
    preflight: (p) => (Object.prototype.hasOwnProperty.call(preflight, p) ? preflight[p] : null),
    // Windows 스타일 정규화: 소문자 + 구분자 통일.
    normalize: (p) => p.toLowerCase().replace(/\\/g, '/'),
    onWrite: (t) => { writes.push(t) },
  }
  return { io, writes }
}

function findCand(r: { candidates: RuntimeCandidate[] }, source: string): RuntimeCandidate | undefined {
  return r.candidates.find((c) => c.source === source)
}

// ── managedInterpreterPath: 절대경로 상수 없이 root에서 도출 ────────────────
test('managedInterpreterPath: win32/posix 형태 도출 (하드코딩 상수 아님)', () => {
  assert.equal(managedInterpreterPath('C:/af/externals/audioforge_venv', 'win32'), 'C:/af/externals/audioforge_venv\\Scripts\\python.exe')
  assert.equal(managedInterpreterPath('/opt/af/venv', 'posix'), '/opt/af/venv/bin/python')
  // 후행 구분자 정리
  assert.equal(managedInterpreterPath('/opt/af/venv/', 'posix'), '/opt/af/venv/bin/python')
})

// ── 8) managed 정상 ─────────────────────────────────────────────────────────
test('managed 정상: runtimeRoot의 venv가 preflight 통과 → 선택, ownership=managed, canWrite', () => {
  const root = 'C:/af/externals/audioforge_venv'
  const mp = managedInterpreterPath(root, 'win32')
  const { io } = makeIO({ existing: [mp], preflight: { [mp]: ok() } })
  const r = resolveRuntime({ runtimeRoot: root, platform: 'win32' }, io)
  assert.equal(r.status, 'resolved')
  assert.equal(r.selected?.source, 'managed')
  assert.equal(r.selected?.ownership, 'managed')
  assert.equal(r.selected?.canWrite, true)
  assert.equal(r.selected?.status, 'verified')
  assert.equal(r.userSelectionFailed, false)
})

// ── 1) ComfyUI 없음 ─────────────────────────────────────────────────────────
test('ComfyUI 없음: 외부 후보 미존재 → managed로 해석(조용한 전환 아님, 사용자 선택 없음)', () => {
  const root = 'C:/af/venv'
  const mp = managedInterpreterPath(root, 'win32')
  const comfy = 'E:/AI/ComfyUI/python_embeded/python.exe'
  const { io } = makeIO({ existing: [mp], preflight: { [mp]: ok() } })
  const r = resolveRuntime({ runtimeRoot: root, userSelectedExternalPath: comfy, platform: 'win32' }, io)
  assert.equal(r.status, 'resolved')
  assert.equal(r.selected?.source, 'managed')
  const ext = findCand(r, 'user-selected-external')
  assert.equal(ext?.status, 'unavailable')
  assert.ok(ext?.reasons.includes('not-found'))
})

// ── 2) stale env.json (legacy 기록이 더 이상 유효하지 않음) ───────────────────
test('stale env.json: legacy 기록 경로 미존재 → unavailable, 선택 안 됨', () => {
  const root = 'C:/af/venv'
  const mp = managedInterpreterPath(root, 'win32')
  const stale = 'E:/AI/OldComfy/python_embeded/python.exe' // 예전 기록, 지금은 없음
  const { io } = makeIO({ existing: [mp], preflight: { [mp]: ok() } })
  const r = resolveRuntime({ runtimeRoot: root, legacyRecordPath: stale, platform: 'win32' }, io)
  const legacy = findCand(r, 'legacy-detected')
  assert.equal(legacy?.ownership, 'legacy')
  assert.equal(legacy?.status, 'unavailable')
  assert.ok(legacy?.reasons.includes('not-found'))
  assert.equal(r.selected?.source, 'managed') // legacy로 조용히 안 감
})

test('stale env.json 변형: legacy 존재하나 preflight 실패 → invalid, 선택 안 됨', () => {
  const stale = 'E:/AI/OldComfy/python.exe'
  const { io } = makeIO({ existing: [stale], preflight: { [stale]: fail(['torch', 'numpy']) } })
  const r = resolveRuntime({ legacyRecordPath: stale }, io)
  const legacy = findCand(r, 'legacy-detected')
  assert.equal(legacy?.status, 'invalid')
  assert.ok(legacy?.reasons.includes('preflight-failed'))
  assert.equal(r.status, 'unresolved')
  // runtimeRoot 없음 → 명시 오류(아래 별도 케이스와 동일 계약)
  assert.equal(r.error?.code, 'no-runtime-root')
})

// ── 3) dangling junction → unavailable ──────────────────────────────────────
test('dangling junction: exists하나 realpath null → unavailable(dangling-junction), 복구/재생성 안 함', () => {
  const jp = 'C:/af/_af_worktrees/x/venv/Scripts/python.exe' // 삭제된 junction 경유
  const { io } = makeIO({ existing: [jp], realpaths: { [jp]: null } })
  const r = resolveRuntime({ userSelectedPath: jp }, io)
  const uc = findCand(r, 'user-selected')
  assert.equal(uc?.status, 'unavailable')
  assert.ok(uc?.reasons.includes('dangling-junction'))
  assert.equal(uc?.resolvedPath, null)
  // 사용자 선택이 dangling → 선택 실패 표시 + 조용한 외부 전환 없음
  assert.equal(r.userSelectionFailed, true)
})

// ── 4) app 폴더 이동: 절대경로 상수 없이 주입된 root로 해석 ──────────────────
test('app 폴더 이동: runtimeRoot만 바뀌면 managed 후보가 새 위치에서 해석(하드코딩 없음)', () => {
  const rootA = 'C:/old/loc/venv'
  const rootB = 'D:/new/loc/venv'
  const mpB = managedInterpreterPath(rootB, 'win32')
  const { io } = makeIO({ existing: [mpB], preflight: { [mpB]: ok() } })
  // 앱이 D:로 이동 → rootB 주입 → 옛 위치 참조 없이 해석
  const r = resolveRuntime({ runtimeRoot: rootB, platform: 'win32' }, io)
  assert.equal(r.status, 'resolved')
  assert.equal(r.selected?.resolvedPath, mpB)
  assert.ok(!JSON.stringify(r).includes(rootA)) // 옛 경로 흔적 없음
})

// ── 5) 한글·공백 경로 ───────────────────────────────────────────────────────
test('한글·공백 경로: 정상 발견/검증/선택', () => {
  const root = 'D:/사용자 폴더/오디오 포지/audioforge_venv'
  const mp = managedInterpreterPath(root, 'win32')
  const { io } = makeIO({ existing: [mp], preflight: { [mp]: ok() } })
  const r = resolveRuntime({ runtimeRoot: root, platform: 'win32' }, io)
  assert.equal(r.status, 'resolved')
  assert.equal(r.selected?.resolvedPath, mp)
})

// ── 6) 동일 Python 중복 제거 ────────────────────────────────────────────────
test('중복 제거: user-selected와 env-var가 동일 realpath → 하위(env-var) duplicate 처리', () => {
  const real = 'C:/Python312/python.exe'
  const viaLink = 'C:/link/python.exe'
  const { io } = makeIO({
    existing: [viaLink, real],
    realpaths: { [viaLink]: real, [real]: real },
    env: { AUDIOFORGE_PYTHON: real },
    preflight: { [real]: ok() },
  })
  // user-selected는 심링크 경유, env-var는 실경로 — realpath 동일.
  const r = resolveRuntime({ userSelectedPath: viaLink }, io)
  const user = findCand(r, 'user-selected')
  const envc = findCand(r, 'env-var')
  assert.equal(user?.status, 'verified')     // 상위 유지
  assert.equal(user?.source, 'user-selected')
  assert.equal(envc?.status, 'unavailable')  // 하위 중복 제거
  assert.ok(envc?.reasons.includes('duplicate'))
  assert.equal(r.selected?.source, 'user-selected')
})

// ── 7) user-selected 불량 → 선택 실패 표시, 타 외부 미전환 ────────────────────
test('user-selected 불량: 다른 외부(env/comfy/path)로 조용히 전환 금지 → 선택 실패 명시', () => {
  const bad = 'C:/broken/python.exe'
  const envPy = 'E:/AI/ComfyUI/python.exe'
  const { io } = makeIO({
    existing: [bad, envPy],
    env: { AUDIOFORGE_PYTHON: envPy },
    preflight: { [bad]: fail(['torch']), [envPy]: ok() }, // env는 멀쩡하지만 조용히 쓰면 안 됨
  })
  const r = resolveRuntime({ userSelectedPath: bad, platform: 'win32' }, io)
  assert.equal(r.userSelectionFailed, true)
  assert.equal(r.status, 'unresolved') // runtimeRoot 없고 managed 없음 → 외부로 전환 안 함
  assert.ok(r.policy.some((p) => p.code === 'user-selection-failed'))
  assert.ok(r.policy.some((p) => p.code === 'no-fallback-external-by-policy'))
  assert.notEqual(r.selected?.source, 'env-var') // 조용한 전환 없음
  assert.equal(r.selected, null)
})

test('user-selected 불량 + managed 정상: managed로 "명시적" 전환(조용한 전환 아님)', () => {
  const bad = 'C:/broken/python.exe'
  const root = 'C:/af/venv'
  const mp = managedInterpreterPath(root, 'win32')
  const { io } = makeIO({
    existing: [bad, mp],
    preflight: { [bad]: fail(['numpy']), [mp]: ok() },
  })
  const r = resolveRuntime({ userSelectedPath: bad, runtimeRoot: root, platform: 'win32' }, io)
  assert.equal(r.userSelectionFailed, true)
  assert.equal(r.status, 'resolved')
  assert.equal(r.selected?.source, 'managed')
  assert.ok(r.policy.some((p) => p.code === 'user-selection-failed'))
  assert.ok(r.policy.some((p) => p.code === 'switched-to-managed-explicit'))
})

// ── 9) PATH 후보 미검증 → unverified(채택 금지) ─────────────────────────────
test('PATH 후보 미검증: preflight 증거 없음 → unverified, 조용한 python fallback 금지', () => {
  const pathPy = 'C:/Windows/py.exe'
  const { io } = makeIO({ existing: [pathPy], pathList: [pathPy] /* preflight 미정의 → null */ })
  const r = resolveRuntime({}, io)
  const pc = findCand(r, 'path-discovery')
  assert.equal(pc?.status, 'unverified')
  assert.ok(pc?.reasons.includes('preflight-missing'))
  assert.equal(r.status, 'unresolved')   // 검증 안 됐으면 채택 안 함
  assert.equal(r.selected, null)
})

test('PATH 후보 검증 통과 시에는 채택(단, 사용자 선택 없을 때만)', () => {
  const pathPy = 'C:/Python312/python.exe'
  const { io } = makeIO({ existing: [pathPy], pathList: [pathPy], preflight: { [pathPy]: ok() } })
  const r = resolveRuntime({ runtimeRoot: 'C:/af/venv' /* managed 미존재 */ }, io)
  assert.equal(r.status, 'resolved')
  assert.equal(r.selected?.source, 'path-discovery')
  assert.equal(r.selected?.ownership, 'borrowed')
})

// ── 10) runtime root 없음 → 명시 오류 ───────────────────────────────────────
test('runtime root 없음 + 해석 불가 → no-runtime-root 명시 오류(조용한 python 아님)', () => {
  const { io } = makeIO({}) // 아무 후보도 없음
  const r = resolveRuntime({}, io)
  assert.equal(r.status, 'unresolved')
  assert.equal(r.selected, null)
  assert.equal(r.error?.code, 'no-runtime-root')
  assert.ok(r.policy.some((p) => p.code === 'no-verified-candidate'))
})

test('runtime root 있으나 미존재 + 다른 후보 없음 → unresolved, 단 no-runtime-root 아님(설치 가능 위치 존재)', () => {
  const root = 'C:/af/venv' // 경로 주입됐으나 아직 venv 미생성
  const { io } = makeIO({}) // managed 인터프리터 미존재
  const r = resolveRuntime({ runtimeRoot: root, platform: 'win32' }, io)
  assert.equal(r.status, 'unresolved')
  assert.equal(r.error, undefined) // root 있으니 setup 가능 → 명시 오류 아님
})

// ── 11) borrowed root 쓰기 금지 ─────────────────────────────────────────────
test('borrowed root 쓰기 금지: 빌린 외부는 canWrite=false, 코어는 onWrite를 절대 호출하지 않음', () => {
  const envPy = 'E:/AI/ComfyUI/python.exe'
  const { io, writes } = makeIO({ existing: [envPy], env: { AUDIOFORGE_PYTHON: envPy }, preflight: { [envPy]: ok() } })
  const r = resolveRuntime({}, io)
  assert.equal(r.selected?.source, 'env-var')
  assert.equal(r.selected?.ownership, 'borrowed')
  assert.equal(r.selected?.canWrite, false) // 빌린 루트 쓰기 불가
  assert.equal(writes.length, 0)            // 해석 중 어떤 쓰기도 없음(setup/삭제/설치 0)
})

test('borrowed root 쓰기 금지(전체 후보): 발견~검증~선택 어디서도 onWrite 미호출', () => {
  const root = 'C:/af/venv'
  const mp = managedInterpreterPath(root, 'win32')
  const comfy = 'E:/AI/ComfyUI/python.exe'
  const { io, writes } = makeIO({
    existing: [mp, comfy],
    preflight: { [mp]: ok(), [comfy]: ok() },
  })
  discoverCandidates({ runtimeRoot: root, userSelectedExternalPath: comfy, platform: 'win32' }, io)
  const cands = verifyCandidates(discoverCandidates({ runtimeRoot: root, userSelectedExternalPath: comfy, platform: 'win32' }, io), io)
  selectRuntime(cands, { runtimeRoot: root, userSelectedExternalPath: comfy, platform: 'win32' })
  assert.equal(writes.length, 0)
})

// ── 순수성 확인: select는 포트 없이 동작 ────────────────────────────────────
test('selectRuntime은 순수(포트 없음): 동일 입력 → 동일 결과', () => {
  const cands: RuntimeCandidate[] = [
    { source: 'managed', rank: 2, rawPath: 'm', resolvedPath: 'm', ownership: 'managed', status: 'verified', reasons: [], canWrite: true },
    { source: 'env-var', rank: 3, rawPath: 'e', resolvedPath: 'e', ownership: 'borrowed', status: 'verified', reasons: [], canWrite: false },
  ]
  const a = selectRuntime(cands, {})
  const b = selectRuntime(cands, {})
  assert.equal(a.selected?.source, 'managed') // 우선순위 낮은 rank 우선
  assert.deepEqual(a.policy, b.policy)
})
