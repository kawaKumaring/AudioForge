// runtimeResolver 회귀 — 발견/랭킹/선택 순수 코어. 실 spawn/설치/fs 접근 없이 DI mock으로만 검증.
// reconcile v2: 3축 enum·ReasonCode·PolicyOutcome는 shared 계약에서만 가져온다(로컬 중복 0).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  resolveRuntime,
  discoverCandidates,
  verifyCandidates,
  selectRuntime,
  managedInterpreterPath,
  type RuntimeResolverIO,
  type InterpreterProbeResult,
  type RuntimeCandidate,
} from './runtimeResolver.ts'
// shared 계약 타입/헬퍼 — resolver가 소비하는 단일 소스.
import {
  isRuntimeOwnership,
  isCandidateSource,
  isCandidateStatus,
  isReasonCodeOrNull,
  isPolicyOutcome,
} from '../../shared/runtimeContract.ts'

// ── DI mock 팩토리 ───────────────────────────────────────────────────────────
interface MockCfg {
  existing?: string[]                              // 존재하는 경로
  realpaths?: Record<string, string | null>        // 경로→realpath(null=dangling). 없으면 identity.
  env?: Record<string, string>
  pathList?: string[]                               // discoverPath 반환
  preflight?: Record<string, InterpreterProbeResult | null> // realpath→probe(null=증거없음)
}

function ok(pythonVersion = '3.12.0'): InterpreterProbeResult {
  return { ok: true, pythonVersion, ttsMissing: [] }
}
function fail(coreMissing: string[]): InterpreterProbeResult {
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

// ── 계약 정합: 로컬 중복 타입 선언 0 + shared import 사용 ─────────────────────
test('reconcile: runtimeResolver.ts는 3축/ReasonCode/PreflightEvidence를 로컬 선언하지 않고 shared에서 import', () => {
  const srcPath = fileURLToPath(new URL('./runtimeResolver.ts', import.meta.url))
  const src = readFileSync(srcPath, 'utf-8')
  // 로컬 중복 선언 0 (import 라인은 `= ` 없이 콤마로 끝나므로 매칭되지 않음).
  assert.ok(!/(export\s+)?type\s+RuntimeOwnership\s*=/.test(src), 'RuntimeOwnership 로컬 선언 발견')
  assert.ok(!/(export\s+)?type\s+CandidateSource\s*=/.test(src), 'CandidateSource 로컬 선언 발견')
  assert.ok(!/(export\s+)?type\s+CandidateStatus\s*=/.test(src), 'CandidateStatus 로컬 선언 발견')
  assert.ok(!/(export\s+)?type\s+SkipReason\s*=/.test(src), 'SkipReason 로컬 선언 발견')
  // 선언만 매칭(type X = / interface X { | <) — import 라인(`type X,`)은 매칭 제외.
  assert.ok(!/(export\s+)?type\s+PreflightEvidence\s*=/.test(src) && !/(export\s+)?interface\s+PreflightEvidence\s*[<{]/.test(src), 'PreflightEvidence 로컬 선언 발견')
  assert.ok(!/(export\s+)?type\s+ReasonCode\s*=/.test(src) && !/(export\s+)?interface\s+ReasonCode\s*[<{]/.test(src), 'ReasonCode 로컬 선언 발견')
  assert.ok(!/(export\s+)?type\s+PolicyOutcome\s*=/.test(src) && !/(export\s+)?interface\s+PolicyOutcome\s*[<{]/.test(src), 'PolicyOutcome 로컬 선언 발견')
  // shared 계약에서 import 하는지 확인.
  assert.ok(/from ['"]\.\.\/\.\.\/shared\/runtimeContract\.ts['"]/.test(src), 'shared 계약 import 없음')
})

test('reconcile: 산출 후보/결과 값이 계약 3축·ReasonCode·PolicyOutcome union에 속함', () => {
  const root = 'C:/af/venv'
  const mp = managedInterpreterPath(root, 'win32')
  const bad = 'C:/broken/python.exe'
  const { io } = makeIO({ existing: [mp, bad], preflight: { [mp]: ok(), [bad]: fail(['torch']) } })
  const r = resolveRuntime({ userSelectedExternalPath: bad, runtimeRoot: root, platform: 'win32' }, io)
  for (const c of r.candidates) {
    assert.ok(isRuntimeOwnership(c.ownership), `ownership 계약 밖: ${c.ownership}`)
    assert.ok(isCandidateSource(c.source), `source 계약 밖: ${c.source}`)
    assert.ok(isCandidateStatus(c.status), `status 계약 밖: ${c.status}`)
    for (const rc of c.reasonCodes) assert.ok(isReasonCodeOrNull(rc), `reasonCode 계약 밖: ${rc}`)
  }
  assert.ok(isReasonCodeOrNull(r.reasonCode))
  for (const p of r.policyOutcomes) assert.ok(isPolicyOutcome(p), `policyOutcome 계약 밖: ${p}`)
})

// ── managedInterpreterPath: 절대경로 상수 없이 root에서 도출 ────────────────
test('managedInterpreterPath: win32/posix 형태 도출 (하드코딩 상수 아님)', () => {
  assert.equal(managedInterpreterPath('C:/af/runtime', 'win32'), 'C:/af/runtime\\audioforge_venv\\Scripts\\python.exe')
  assert.equal(managedInterpreterPath('/opt/af/runtime', 'posix'), '/opt/af/runtime/audioforge_venv/bin/python')
  assert.equal(managedInterpreterPath('/opt/af/runtime/', 'posix'), '/opt/af/runtime/audioforge_venv/bin/python')
})

// ── managed 정상 ────────────────────────────────────────────────────────────
test('managed 정상: runtimeRoot의 venv가 probe 통과 → 선택, ownership=audioforge-managed, canWrite', () => {
  const root = 'C:/af/externals/audioforge_venv'
  const mp = managedInterpreterPath(root, 'win32')
  const { io } = makeIO({ existing: [mp], preflight: { [mp]: ok() } })
  const r = resolveRuntime({ runtimeRoot: root, platform: 'win32' }, io)
  assert.equal(r.status, 'resolved')
  assert.equal(r.selected?.source, 'managed-runtime')
  assert.equal(r.selected?.ownership, 'audioforge-managed')
  assert.equal(r.selected?.canWrite, true)
  assert.equal(r.selected?.status, 'validated')
  assert.equal(r.userSelectionFailed, false)
  assert.equal(r.reasonCode, null)
})

// ── ComfyUI 없음 ────────────────────────────────────────────────────────────
test('ComfyUI 없음: 외부 후보 미존재 → managed로 해석(조용한 전환 아님, 사용자 선택 없음)', () => {
  const root = 'C:/af/venv'
  const mp = managedInterpreterPath(root, 'win32')
  const comfy = 'E:/AI/ComfyUI/python_embeded/python.exe'
  const { io } = makeIO({ existing: [mp], preflight: { [mp]: ok() } })
  const r = resolveRuntime({ runtimeRoot: root, userSelectedExternalPath: comfy, platform: 'win32' }, io)
  assert.equal(r.status, 'resolved')
  assert.equal(r.selected?.source, 'managed-runtime')
  const ext = findCand(r, 'user-selected-external')
  assert.equal(ext?.status, 'unavailable')
  assert.ok(ext?.reasonCodes.includes('INTERPRETER_NOT_FOUND'))
})

// ── stale env.json ──────────────────────────────────────────────────────────
test('stale env.json: legacy 기록 경로 미존재 → unavailable, 선택 안 됨', () => {
  const root = 'C:/af/venv'
  const mp = managedInterpreterPath(root, 'win32')
  const stale = 'E:/AI/OldComfy/python_embeded/python.exe'
  const { io } = makeIO({ existing: [mp], preflight: { [mp]: ok() } })
  const r = resolveRuntime({ runtimeRoot: root, legacyRecordPath: stale, platform: 'win32' }, io)
  const legacy = findCand(r, 'legacy-detected')
  assert.equal(legacy?.ownership, 'external-borrowed')
  assert.equal(legacy?.status, 'unavailable')
  assert.ok(legacy?.reasonCodes.includes('INTERPRETER_NOT_FOUND'))
  assert.equal(r.selected?.source, 'managed-runtime') // legacy로 조용히 안 감
})

test('stale env.json 변형: legacy 존재하나 probe 실패 → rejected, 선택 안 됨', () => {
  const stale = 'E:/AI/OldComfy/python.exe'
  const { io } = makeIO({ existing: [stale], preflight: { [stale]: fail(['torch', 'numpy']) } })
  const r = resolveRuntime({ legacyRecordPath: stale }, io)
  const legacy = findCand(r, 'legacy-detected')
  assert.equal(legacy?.status, 'rejected')
  assert.ok(legacy?.reasonCodes.includes('PREFLIGHT_FAILED'))
  assert.equal(r.status, 'unresolved')
  assert.equal(r.reasonCode, 'NO_RUNTIME_ROOT') // runtimeRoot 없음 → 명시 사유
})

// ── dangling junction → unavailable ─────────────────────────────────────────
test('dangling junction: exists하나 realpath null → unavailable(DANGLING_JUNCTION), 복구/재생성 안 함', () => {
  const jp = 'C:/af/_af_worktrees/x/venv/Scripts/python.exe'
  const { io } = makeIO({ existing: [jp], realpaths: { [jp]: null } })
  const r = resolveRuntime({ userSelectedPath: jp }, io)
  const uc = findCand(r, 'user-settings')
  assert.equal(uc?.status, 'unavailable')
  assert.ok(uc?.reasonCodes.includes('DANGLING_JUNCTION'))
  assert.equal(uc?.resolvedPath, null)
  assert.equal(r.userSelectionFailed, true)
})

// ── app 폴더 이동: 절대경로 상수 없이 주입된 root로 해석 ─────────────────────
test('app 폴더 이동: runtimeRoot만 바뀌면 managed 후보가 새 위치에서 해석(하드코딩 없음)', () => {
  const rootA = 'C:/old/loc/venv'
  const rootB = 'D:/new/loc/venv'
  const mpB = managedInterpreterPath(rootB, 'win32')
  const { io } = makeIO({ existing: [mpB], preflight: { [mpB]: ok() } })
  const r = resolveRuntime({ runtimeRoot: rootB, platform: 'win32' }, io)
  assert.equal(r.status, 'resolved')
  assert.equal(r.selected?.resolvedPath, mpB)
  assert.ok(!JSON.stringify(r).includes(rootA)) // 옛 경로 흔적 없음
})

// ── 한글·공백 경로 ──────────────────────────────────────────────────────────
test('한글·공백 경로: 정상 발견/검증/선택', () => {
  const root = 'D:/사용자 폴더/오디오 포지/audioforge_venv'
  const mp = managedInterpreterPath(root, 'win32')
  const { io } = makeIO({ existing: [mp], preflight: { [mp]: ok() } })
  const r = resolveRuntime({ runtimeRoot: root, platform: 'win32' }, io)
  assert.equal(r.status, 'resolved')
  assert.equal(r.selected?.resolvedPath, mp)
})

// ── 동일 Python 중복 제거 ───────────────────────────────────────────────────
test('중복 제거: user-settings와 environment-variable가 동일 realpath → 하위 DUPLICATE_CANDIDATE', () => {
  const real = 'C:/Python312/python.exe'
  const viaLink = 'C:/link/python.exe'
  const { io } = makeIO({
    existing: [viaLink, real],
    realpaths: { [viaLink]: real, [real]: real },
    env: { AUDIOFORGE_PYTHON: real },
    preflight: { [real]: ok() },
  })
  const r = resolveRuntime({ userSelectedPath: viaLink }, io)
  const user = findCand(r, 'user-settings')
  const envc = findCand(r, 'environment-variable')
  assert.equal(user?.status, 'validated')   // 상위 유지
  assert.equal(envc?.status, 'unavailable') // 하위 중복 제거
  assert.ok(envc?.reasonCodes.includes('DUPLICATE_CANDIDATE'))
  assert.equal(r.selected?.source, 'user-settings')
})

// ── user-selected 불량 → 선택 실패 표시, 타 외부 미전환 ──────────────────────
test('user-selected 불량: 다른 외부로 조용히 전환 금지 → USER_SELECTION_FAILED 명시', () => {
  const bad = 'C:/broken/python.exe'
  const envPy = 'E:/AI/ComfyUI/python.exe'
  const { io } = makeIO({
    existing: [bad, envPy],
    env: { AUDIOFORGE_PYTHON: envPy },
    preflight: { [bad]: fail(['torch']), [envPy]: ok() }, // env는 멀쩡하지만 조용히 쓰면 안 됨
  })
  const r = resolveRuntime({ userSelectedPath: bad, platform: 'win32' }, io)
  assert.equal(r.userSelectionFailed, true)
  assert.equal(r.status, 'unresolved')
  assert.equal(r.reasonCode, 'USER_SELECTION_FAILED')
  assert.ok(r.policyOutcomes.includes('no-fallback-external-by-policy'))
  assert.notEqual(r.selected?.source, 'environment-variable') // 조용한 전환 없음
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
  assert.equal(r.selected?.source, 'managed-runtime')
  assert.ok(r.policyOutcomes.includes('switched-to-managed-explicit'))
})

// ── PATH 후보 미검증 → discovered(채택 금지) ────────────────────────────────
test('PATH 후보 미검증: probe 증거 없음 → discovered(validated 아님), 조용한 python fallback 금지', () => {
  const pathPy = 'C:/Windows/py.exe'
  const { io } = makeIO({ existing: [pathPy], pathList: [pathPy] /* preflight 미정의 → null */ })
  const r = resolveRuntime({}, io)
  const pc = findCand(r, 'path-discovery')
  assert.equal(pc?.status, 'discovered')
  assert.equal(pc?.reasonCodes.length, 0) // 단순 미검증은 reject 사유 아님
  assert.equal(r.status, 'unresolved')     // 검증 안 됐으면 채택 안 함
  assert.equal(r.selected, null)
  assert.equal(r.reasonCode, 'NO_RUNTIME_ROOT') // root도 없음 → 명시 사유(조용한 python 아님)
})

test('PATH 후보 검증 통과 시에는 채택(단, 사용자 선택 없을 때만)', () => {
  const pathPy = 'C:/Python312/python.exe'
  const { io } = makeIO({ existing: [pathPy], pathList: [pathPy], preflight: { [pathPy]: ok() } })
  const r = resolveRuntime({ runtimeRoot: 'C:/af/venv' /* managed 미존재 */ }, io)
  assert.equal(r.status, 'resolved')
  assert.equal(r.selected?.source, 'path-discovery')
  assert.equal(r.selected?.ownership, 'external-borrowed')
  assert.equal(r.selected?.canWrite, false)
  assert.equal(r.reasonCode, null)
})

// ── runtime root 없음 → NO_RUNTIME_ROOT 명시 ───────────────────────────────
test('runtime root 없음 + 해석 불가 → NO_RUNTIME_ROOT 명시(조용한 python 아님)', () => {
  const { io } = makeIO({}) // 아무 후보도 없음
  const r = resolveRuntime({}, io)
  assert.equal(r.status, 'unresolved')
  assert.equal(r.selected, null)
  assert.equal(r.reasonCode, 'NO_RUNTIME_ROOT')
})

test('runtime root 있으나 미존재 + 다른 후보 없음 → unresolved, NO_RUNTIME_ROOT 아님(설치 가능 위치 존재)', () => {
  const root = 'C:/af/venv'
  const { io } = makeIO({}) // managed 인터프리터 미존재
  const r = resolveRuntime({ runtimeRoot: root, platform: 'win32' }, io)
  assert.equal(r.status, 'unresolved')
  assert.equal(r.reasonCode, 'INTERPRETER_NOT_FOUND') // root 있으니 setup 가능 → NO_RUNTIME_ROOT 아님
})

// ── borrowed root 쓰기 금지 ─────────────────────────────────────────────────
test('borrowed root 쓰기 금지: 빌린 외부는 canWrite=false, 코어는 onWrite를 절대 호출하지 않음', () => {
  const envPy = 'E:/AI/ComfyUI/python.exe'
  const { io, writes } = makeIO({ existing: [envPy], env: { AUDIOFORGE_PYTHON: envPy }, preflight: { [envPy]: ok() } })
  const r = resolveRuntime({}, io)
  assert.equal(r.selected?.source, 'environment-variable')
  assert.equal(r.selected?.ownership, 'external-borrowed')
  assert.equal(r.selected?.canWrite, false)
  assert.equal(writes.length, 0)
})

test('borrowed root 쓰기 금지(전체 후보): 발견~검증~선택 어디서도 onWrite 미호출', () => {
  const root = 'C:/af/venv'
  const mp = managedInterpreterPath(root, 'win32')
  const comfy = 'E:/AI/ComfyUI/python.exe'
  const { io, writes } = makeIO({
    existing: [mp, comfy],
    preflight: { [mp]: ok(), [comfy]: ok() },
  })
  const cands = verifyCandidates(
    discoverCandidates({ runtimeRoot: root, userSelectedExternalPath: comfy, platform: 'win32' }, io),
    io,
  )
  selectRuntime(cands, { runtimeRoot: root, userSelectedExternalPath: comfy, platform: 'win32' })
  assert.equal(writes.length, 0)
})

// ── 순수성 확인: select는 포트 없이 동작 ────────────────────────────────────
test('selectRuntime은 순수(포트 없음): 동일 입력 → 동일 결과', () => {
  const cands: RuntimeCandidate[] = [
    { source: 'managed-runtime', rank: 2, rawPath: 'm', resolvedPath: 'm', ownership: 'audioforge-managed', status: 'validated', reasonCodes: [], canWrite: true },
    { source: 'environment-variable', rank: 3, rawPath: 'e', resolvedPath: 'e', ownership: 'external-borrowed', status: 'validated', reasonCodes: [], canWrite: false },
  ]
  const a = selectRuntime(cands, {})
  const b = selectRuntime(cands, {})
  assert.equal(a.selected?.source, 'managed-runtime') // 낮은 rank 우선
  assert.deepEqual(a.policyOutcomes, b.policyOutcomes)
})
