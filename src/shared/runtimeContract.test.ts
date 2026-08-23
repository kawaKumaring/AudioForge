// runtime contract 계약 회귀 테스트 — Node 내장 러너(node --test), 새 의존성 0.
// 실행: npm test  (또는 node --test src/shared/runtimeContract.test.ts)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RUNTIME_CONTRACT_SCHEMA_VERSION,
  INTERPRETER_OWNERSHIP,
  CAPABILITY_STATUS,
  RUNTIME_REASON_CODES,
  isInterpreterOwnership,
  isCapabilityStatus,
  isRuntimeReasonCode,
  isManagedOwnership,
  isAbsolutePath,
  isCanonicalAbsolutePath,
  isManagedRelativePath,
  basenameOf,
  validateInterpreterCandidate,
  makePackageFingerprint,
  toRendererInterpreterRef,
} from './runtimeContract.ts'
import type {
  RuntimeRootConfig,
  InterpreterCandidate,
  CapabilitySnapshot,
  ToolCapability,
  ModelCapability,
  ValidationEvidence,
  RuntimeResolutionResult,
  RendererInterpreterRef,
  PackageFingerprint,
} from './runtimeContract.ts'

// ── 공통 유틸: 직렬화 byte-stable round-trip ───────────────────────────────
function assertByteStableRoundTrip(obj: unknown): void {
  const s = JSON.stringify(obj)
  const reserialized = JSON.stringify(JSON.parse(s))
  assert.equal(reserialized, s, 'JSON round-trip이 byte-stable해야 한다')
}

// 객체 그래프의 모든 문자열 값을 수집(경로 누출 검사용).
function collectStringValues(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) collectStringValues(x, out)
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) collectStringValues((v as Record<string, unknown>)[k], out)
  return out
}

// 객체 그래프의 모든 키를 수집.
function collectKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) collectKeys(x, out)
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) { out.push(k); collectKeys((v as Record<string, unknown>)[k], out) }
  return out
}

// ── enum/코드 고정 ──────────────────────────────────────────────────────────
test('schema version은 고정 상수', () => {
  assert.equal(RUNTIME_CONTRACT_SCHEMA_VERSION, 1)
})

test('ownership enum 값이 계약대로 고정', () => {
  assert.deepEqual([...INTERPRETER_OWNERSHIP], [
    'audioforge-managed', 'user-selected', 'external-borrowed', 'legacy-detected',
  ])
})

test('capability status enum 값이 계약대로 고정', () => {
  assert.deepEqual([...CAPABILITY_STATUS], [
    'supported', 'unsupported', 'unavailable', 'incompatible', 'unverified',
  ])
})

test('reason code enum 값이 계약대로 고정', () => {
  assert.deepEqual([...RUNTIME_REASON_CODES], [
    'ok', 'not-found', 'version-mismatch', 'missing-package', 'checksum-mismatch',
    'permission-denied', 'unsupported-platform', 'probe-failed', 'not-verified', 'external-unmanaged',
  ])
})

test('enum 가드가 소속만 통과', () => {
  assert.ok(isInterpreterOwnership('audioforge-managed'))
  assert.ok(!isInterpreterOwnership('random'))
  assert.ok(isCapabilityStatus('supported'))
  assert.ok(!isCapabilityStatus('ok'))
  assert.ok(isRuntimeReasonCode('checksum-mismatch'))
  assert.ok(!isRuntimeReasonCode('supported'))
})

test('isManagedOwnership: managed만 true', () => {
  assert.ok(isManagedOwnership('audioforge-managed'))
  assert.ok(!isManagedOwnership('user-selected'))
  assert.ok(!isManagedOwnership('external-borrowed'))
  assert.ok(!isManagedOwnership('legacy-detected'))
})

// ── 경로 규칙 헬퍼(§1) ──────────────────────────────────────────────────────
test('isAbsolutePath: POSIX/Windows/UNC 판별', () => {
  assert.ok(isAbsolutePath('/usr/bin/python3'))
  assert.ok(isAbsolutePath('C:/Users/x/python.exe'))
  assert.ok(isAbsolutePath('C:\\Users\\x\\python.exe'))
  assert.ok(isAbsolutePath('\\\\host\\share\\p'))
  assert.ok(!isAbsolutePath('runtime/venv/bin/python'))
  assert.ok(!isAbsolutePath(''))
})

test('isCanonicalAbsolutePath: 절대 + .. 없음', () => {
  assert.ok(isCanonicalAbsolutePath('C:/Apps/AudioForge/py.exe'))
  assert.ok(!isCanonicalAbsolutePath('C:/Apps/../Apps/py.exe'))  // .. 포함 → 비정규
  assert.ok(!isCanonicalAbsolutePath('runtime/venv/python'))     // 상대 → 실패
})

test('isManagedRelativePath: 상대 + root 탈출 금지', () => {
  assert.ok(isManagedRelativePath('venv/bin/python'))
  assert.ok(isManagedRelativePath('venv\\Scripts\\python.exe'))
  assert.ok(!isManagedRelativePath('../outside/python'))   // 탈출
  assert.ok(!isManagedRelativePath('/abs/python'))          // 절대
  assert.ok(!isManagedRelativePath(''))
})

test('basenameOf: 전체 경로 노출 없이 파일명만', () => {
  assert.equal(basenameOf('C:/Apps/AudioForge/python.exe'), 'python.exe')
  assert.equal(basenameOf('/usr/local/bin/python3'), 'python3')
  assert.equal(basenameOf('venv\\Scripts\\python.exe'), 'python.exe')
})

// ── interpreter 후보 경로 규칙 강제(§1) ─────────────────────────────────────
test('managed 후보는 root 내부 상대경로만 허용', () => {
  assert.deepEqual(
    validateInterpreterCandidate({ ownership: 'audioforge-managed', path: 'venv/bin/python' }),
    { ok: true, reason: 'ok' },
  )
  // managed인데 절대경로 → 거부
  assert.equal(
    validateInterpreterCandidate({ ownership: 'audioforge-managed', path: 'C:/py/python.exe' }).ok,
    false,
  )
  // managed인데 root 탈출 → 거부
  assert.equal(
    validateInterpreterCandidate({ ownership: 'audioforge-managed', path: '../escape/python' }).ok,
    false,
  )
})

test('외부 소유 후보는 canonical absolute만 허용', () => {
  assert.deepEqual(
    validateInterpreterCandidate({ ownership: 'user-selected', path: 'C:/Python312/python.exe' }),
    { ok: true, reason: 'ok' },
  )
  assert.deepEqual(
    validateInterpreterCandidate({ ownership: 'external-borrowed', path: '/usr/bin/python3' }),
    { ok: true, reason: 'ok' },
  )
  // 외부인데 상대경로 → 거부
  assert.equal(
    validateInterpreterCandidate({ ownership: 'user-selected', path: 'venv/bin/python' }).ok,
    false,
  )
  // 외부인데 비정규(.. 포함) → 거부
  assert.equal(
    validateInterpreterCandidate({ ownership: 'legacy-detected', path: 'C:/a/../b/python.exe' }).ok,
    false,
  )
})

test('빈 경로는 not-found', () => {
  assert.deepEqual(
    validateInterpreterCandidate({ ownership: 'audioforge-managed', path: '' }),
    { ok: false, reason: 'not-found' },
  )
})

// ── package fingerprint(§4) ─────────────────────────────────────────────────
test('fingerprint는 name/version/lockHash만 — 경로 필드 부재', () => {
  const fp = makePackageFingerprint('demucs', '4.0.1', 'sha256:abc')
  assert.deepEqual(Object.keys(fp).sort(), ['lockHash', 'name', 'version'])
  const keys = collectKeys(fp)
  assert.ok(!keys.includes('path'), 'fingerprint에 path 키가 있으면 안 된다')
})

// ── renderer view 경로 부재(§2) ─────────────────────────────────────────────
test('renderer interpreter ref는 basename만 — 전체 경로 부재', () => {
  const ref: RendererInterpreterRef = toRendererInterpreterRef(
    { path: 'C:/Apps/AudioForge/runtime/venv/Scripts/python.exe' },
    'ref-01',
    'ok',
  )
  assert.deepEqual(Object.keys(ref).sort(), ['basename', 'pathRefId', 'reason'])
  assert.equal(ref.basename, 'python.exe')
  // 어떤 문자열 값도 절대경로면 안 된다.
  for (const s of collectStringValues(ref)) {
    assert.ok(!isAbsolutePath(s), `renderer ref에 절대경로 누출: ${s}`)
  }
  assert.ok(!collectKeys(ref).includes('path'))
})

// ── 직렬화 round-trip: 각 타입 ──────────────────────────────────────────────
test('RuntimeRootConfig round-trip byte-stable', () => {
  const cfg: RuntimeRootConfig = {
    schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
    runtimeRoot: { path: 'C:/Users/x/AppData/Roaming/AudioForge/runtime', ownership: 'audioforge-managed' },
    modelRoot: { path: 'C:/Users/x/AppData/Roaming/AudioForge/models', ownership: 'audioforge-managed' },
    cacheRoot: { path: 'C:/Users/x/AppData/Roaming/AudioForge/cache', ownership: 'audioforge-managed' },
  }
  assertByteStableRoundTrip(cfg)
})

test('InterpreterCandidate round-trip byte-stable', () => {
  const c: InterpreterCandidate = {
    schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
    ownership: 'user-selected',
    path: 'C:/Python312/python.exe',
    version: '3.12.4',
  }
  assertByteStableRoundTrip(c)
})

test('ValidationEvidence round-trip byte-stable', () => {
  const e: ValidationEvidence = {
    checkId: 'torch-import',
    status: 'incompatible',
    reason: 'version-mismatch',
    observedVersion: '2.1.0',
    expectedVersion: '2.4.0',
  }
  assertByteStableRoundTrip(e)
})

test('CapabilitySnapshot(+tool/model) round-trip byte-stable', () => {
  const tool: ToolCapability = {
    name: 'ffmpeg', status: 'supported', version: '6.1', reason: 'ok',
    evidence: [{ checkId: 'ffmpeg-probe', status: 'supported', reason: 'ok', observedVersion: '6.1', expectedVersion: null }],
  }
  const model: ModelCapability = {
    name: 'htdemucs', status: 'unavailable',
    fingerprint: makePackageFingerprint('htdemucs', '4.0.0', 'sha256:def'),
    reason: 'not-found', evidence: [],
  }
  const snap: CapabilitySnapshot = {
    schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
    ownership: 'audioforge-managed',
    tools: [tool], models: [model],
  }
  assertByteStableRoundTrip(snap)
})

test('RuntimeResolutionResult round-trip byte-stable + 경로 완전 부재(§2)', () => {
  const result: RuntimeResolutionResult = {
    schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
    resolved: true,
    ownership: 'audioforge-managed',
    status: 'supported',
    reason: 'ok',
    interpreter: { pathRefId: 'ref-42', basename: 'python.exe', reason: 'ok' },
    capabilities: {
      schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
      ownership: 'audioforge-managed',
      tools: [{ name: 'ffmpeg', status: 'supported', version: '6.1', reason: 'ok', evidence: [] }],
      models: [{
        name: 'htdemucs', status: 'supported',
        fingerprint: makePackageFingerprint('htdemucs', '4.0.0', 'sha256:def'),
        reason: 'ok', evidence: [],
      }],
    },
  }
  assertByteStableRoundTrip(result)
  // renderer 소비 대상 → 절대경로/ path 키가 그래프 어디에도 없어야 한다.
  for (const s of collectStringValues(result)) {
    assert.ok(!isAbsolutePath(s), `resolution result에 절대경로 누출: ${s}`)
  }
  assert.ok(!collectKeys(result).includes('path'), 'resolution result에 path 키 누출')
})

test('Map/Set 없이 plain 객체만 — 컬렉션은 배열', () => {
  const snap: CapabilitySnapshot = {
    schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
    ownership: 'audioforge-managed', tools: [], models: [],
  }
  assert.ok(Array.isArray(snap.tools))
  assert.ok(Array.isArray(snap.models))
  // JSON round-trip 후에도 동일 형태(Map/Set이면 {}로 소실되어 깨짐).
  const rt = JSON.parse(JSON.stringify(snap)) as CapabilitySnapshot
  assert.deepEqual(rt, snap)
})

test('민감정보 키 부재 — traceback 등 계약 타입에 없음', () => {
  const result: RuntimeResolutionResult = {
    schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
    resolved: false, ownership: 'legacy-detected', status: 'unverified', reason: 'not-verified',
    interpreter: { pathRefId: 'r', basename: 'python', reason: 'not-verified' },
    capabilities: { schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION, ownership: 'legacy-detected', tools: [], models: [] },
  }
  const keys = collectKeys(result)
  for (const forbidden of ['traceback', 'stack', 'stderr', 'homedir', 'username']) {
    assert.ok(!keys.includes(forbidden), `민감정보 키 누출: ${forbidden}`)
  }
})
