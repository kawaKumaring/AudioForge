// runtime contract 계약 회귀 테스트 — Node 내장 러너(node --test), 새 의존성 0.
// 실행: npm test  (또는 node --test src/shared/runtimeContract.test.ts)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RUNTIME_CONTRACT_SCHEMA_VERSION,
  REASON_CODES,
  POLICY_OUTCOMES,
  RESOLVER_REASON_CODE_MAP,
  RESOLVER_POLICY_OUTCOME_MAP,
  CAPABILITY_REASON_CODE_MAP,
  CAPABILITY_STATUS,
  CAPABILITY_FRESHNESS,
  CAPABILITY_SUPPORT_LEVEL,
  RUNTIME_OWNERSHIP,
  CANDIDATE_SOURCE,
  CANDIDATE_STATUS,
  EVIDENCE_KINDS,
  isReasonCode,
  isReasonCodeOrNull,
  isPolicyOutcome,
  isCapabilityStatus,
  isCapabilityFreshness,
  isCapabilitySupportLevel,
  isRuntimeOwnership,
  isCandidateSource,
  isCandidateStatus,
  isEvidenceKind,
  isManagedRuntime,
  isReadOnlyRuntime,
  isAbsolutePath,
  isCanonicalAbsolutePath,
  isManagedRelativePath,
  basenameOf,
  validateCapabilityState,
  makeStaleCapabilityState,
  makeCpuFallbackCapabilityState,
  makeSupportedCapabilityState,
  validateOwnershipSource,
  validateInterpreterCandidate,
  makeRuntimeFingerprint,
  toRendererInterpreterRef,
} from './runtimeContract.ts'
import type {
  RuntimeRootConfig,
  InterpreterCandidate,
  CapabilityState,
  CapabilitySnapshot,
  ToolCapability,
  ModelCapability,
  ValidationEvidence,
  ValidationEvidenceItem,
  RuntimeResolutionResult,
  RendererInterpreterRef,
  RuntimeFingerprint,
} from './runtimeContract.ts'

// ── 공통 유틸 ────────────────────────────────────────────────────────────────
function assertByteStableRoundTrip(obj: unknown): void {
  const s = JSON.stringify(obj)
  const reserialized = JSON.stringify(JSON.parse(s))
  assert.equal(reserialized, s, 'JSON round-trip이 byte-stable해야 한다')
}

function collectStringValues(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) collectStringValues(x, out)
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) collectStringValues((v as Record<string, unknown>)[k], out)
  return out
}

function collectKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) collectKeys(x, out)
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) { out.push(k); collectKeys((v as Record<string, unknown>)[k], out) }
  return out
}

function sampleFingerprint(): RuntimeFingerprint {
  return makeRuntimeFingerprint({
    digest: 'a1b2c3d4', pythonVersion: '3.12.4', architecture: 'x86_64',
    lockHash: 'sha256-lock', probeVersion: '1.0.0', packageCount: 42,
  })
}

function sampleEvidence(): ValidationEvidence {
  const item: ValidationEvidenceItem = {
    kind: 'python-version', status: 'supported', reasonCode: null,
    observedVersion: '3.12.4', requiredVersion: '3.12.0',
  }
  return {
    observedAt: '2026-08-24T00:00:00.000Z', probeVersion: '1.0.0', fingerprint: sampleFingerprint(),
    checks: [item],
    packageCheck: { kind: 'package', status: 'supported', reasonCode: null, observedVersion: null, requiredVersion: null },
    architectureCheck: { kind: 'architecture', status: 'supported', reasonCode: null, observedVersion: 'x86_64', requiredVersion: 'x86_64' },
    importCheck: { kind: 'import', status: 'supported', reasonCode: null, observedVersion: null, requiredVersion: null },
    gpuCheck: { kind: 'gpu', status: 'unavailable', reasonCode: 'GPU_UNAVAILABLE', observedVersion: null, requiredVersion: null },
    modelChecks: [{ kind: 'model', status: 'supported', reasonCode: null, observedVersion: null, requiredVersion: null }],
    toolChecks: [{ kind: 'tool', status: 'supported', reasonCode: null, observedVersion: '6.1', requiredVersion: null }],
  }
}

// ── schema version ───────────────────────────────────────────────────────────
test('schema version은 v2로 올랐다', () => {
  assert.equal(RUNTIME_CONTRACT_SCHEMA_VERSION, 2)
})

// ── ReasonCode canonical union 고정(§5) ─────────────────────────────────────
test('ReasonCode union이 계약대로 25개 고정(기존 20 + 통합 확장 5)', () => {
  assert.deepEqual([...REASON_CODES], [
    'NO_RUNTIME_ROOT', 'USER_SELECTION_FAILED', 'INTERPRETER_NOT_FOUND', 'DANGLING_JUNCTION',
    'DUPLICATE_CANDIDATE', 'PREFLIGHT_FAILED', 'PYTHON_VERSION_INCOMPATIBLE', 'ARCHITECTURE_INCOMPATIBLE',
    'PACKAGE_MISSING', 'PACKAGE_VERSION_INCOMPATIBLE', 'PACKAGE_DRIFT', 'PIP_CHECK_FAILED', 'VENV_MISSING',
    'MODEL_MISSING', 'MODEL_CHECKSUM_MISMATCH', 'TOOL_MISSING', 'GPU_UNAVAILABLE', 'CPU_FALLBACK_AVAILABLE',
    'EVIDENCE_STALE', 'BORROWED_RUNTIME_READ_ONLY',
    // v2.1 통합 확장(B·C 공유)
    'PATH_OUTSIDE_ROOT', 'PYTHON_PROCESS_ABNORMAL_EXIT', 'PYTHON_PROCESS_SIGNAL',
    'PYTHON_RUNTIME_ERROR', 'INPUT_FILE_MISSING',
  ])
  assert.equal(REASON_CODES.length, 25)
})

test('통합 확장 5종은 canonical ReasonCode로 인식되고 자유 문자열은 여전히 거부', () => {
  for (const c of ['PATH_OUTSIDE_ROOT', 'PYTHON_PROCESS_ABNORMAL_EXIT', 'PYTHON_PROCESS_SIGNAL', 'PYTHON_RUNTIME_ERROR', 'INPUT_FILE_MISSING']) {
    assert.ok(isReasonCode(c), `${c}는 canonical ReasonCode여야 한다`)
    assert.ok(isReasonCodeOrNull(c))
  }
  // 확장 후에도 자유 문자열/앱 레벨 에러코드(RUNTIME_NOT_CONFIGURED)는 ReasonCode가 아니다.
  assert.ok(!isReasonCode('RUNTIME_NOT_CONFIGURED'))
  assert.ok(!isReasonCode('python-process-abnormal-exit'))
})

test('reasonCode 가드: 자유 문자열 거부, null 허용', () => {
  assert.ok(isReasonCode('EVIDENCE_STALE'))
  assert.ok(!isReasonCode('stale'))            // 레거시 자유 문자열 거부
  assert.ok(!isReasonCode('ok'))               // 성공은 null로 표현(코드 없음)
  assert.ok(!isReasonCode(''))
  assert.ok(isReasonCodeOrNull(null))
  assert.ok(isReasonCodeOrNull('GPU_UNAVAILABLE'))
  assert.ok(!isReasonCodeOrNull('whatever'))
})

test('PolicyOutcome은 reasonCode와 분리된 union', () => {
  assert.deepEqual([...POLICY_OUTCOMES], ['none', 'no-fallback-external-by-policy', 'switched-to-managed-explicit'])
  assert.ok(isPolicyOutcome('switched-to-managed-explicit'))
  assert.ok(!isPolicyOutcome('EVIDENCE_STALE'))
  // 정책 결과는 ReasonCode가 아니다.
  assert.ok(!isReasonCode('no-fallback-external-by-policy'))
})

// ── B/C 레거시 매핑표(§5) ────────────────────────────────────────────────────
test('resolver(B) 매핑표 값은 전부 유효한 ReasonCode', () => {
  assert.deepEqual(RESOLVER_REASON_CODE_MAP, {
    'dangling-junction': 'DANGLING_JUNCTION',
    'duplicate': 'DUPLICATE_CANDIDATE',
    'preflight-failed': 'PREFLIGHT_FAILED',
    'not-found': 'INTERPRETER_NOT_FOUND',
    'no-runtime-root': 'NO_RUNTIME_ROOT',
    'user-selection-failed': 'USER_SELECTION_FAILED',
  })
  for (const v of Object.values(RESOLVER_REASON_CODE_MAP)) assert.ok(isReasonCode(v))
})

test('resolver 정책 결과는 PolicyOutcome으로 분리 매핑', () => {
  for (const v of Object.values(RESOLVER_POLICY_OUTCOME_MAP)) assert.ok(isPolicyOutcome(v))
  // 정책 결과가 reasonCode로 새지 않는다.
  for (const v of Object.values(RESOLVER_POLICY_OUTCOME_MAP)) assert.ok(!isReasonCode(v))
})

test('capability(C) 매핑표: 중복 이름 통합 + 전부 유효한 ReasonCode', () => {
  assert.equal(CAPABILITY_REASON_CODE_MAP['CHECKSUM_MISMATCH'], 'MODEL_CHECKSUM_MISMATCH')
  assert.equal(CAPABILITY_REASON_CODE_MAP['STALE_SNAPSHOT'], 'EVIDENCE_STALE')
  assert.equal(CAPABILITY_REASON_CODE_MAP['ENV_DRIFT'], 'PACKAGE_DRIFT')
  assert.equal(CAPABILITY_REASON_CODE_MAP['PYTHON_MISSING'], 'INTERPRETER_NOT_FOUND')
  assert.equal(CAPABILITY_REASON_CODE_MAP['VENV_MISSING'], 'VENV_MISSING')  // venv 부재는 별도 유지
  for (const v of Object.values(CAPABILITY_REASON_CODE_MAP)) assert.ok(isReasonCode(v))
})

// ── capability 3축 enum 고정(§1) ─────────────────────────────────────────────
test('CapabilityStatus 5값 유지 — degraded/stale 미포함', () => {
  assert.deepEqual([...CAPABILITY_STATUS], ['supported', 'unsupported', 'unavailable', 'incompatible', 'unverified'])
  assert.ok(!isCapabilityStatus('degraded'))
  assert.ok(!isCapabilityStatus('stale'))
})

test('freshness / supportLevel 별도 축', () => {
  assert.deepEqual([...CAPABILITY_FRESHNESS], ['current', 'stale'])
  assert.deepEqual([...CAPABILITY_SUPPORT_LEVEL], ['full', 'degraded'])
  assert.ok(isCapabilityFreshness('stale'))
  assert.ok(isCapabilitySupportLevel('degraded'))
  assert.ok(!isCapabilityFreshness('full'))
})

test('evidence kind union 고정', () => {
  assert.deepEqual([...EVIDENCE_KINDS], [
    'python-version', 'architecture', 'import', 'package', 'pip-check', 'gpu', 'model', 'tool', 'venv', 'runtime-root',
  ])
  assert.ok(isEvidenceKind('gpu'))
  assert.ok(!isEvidenceKind('cpu'))
})

// ── capability state 규칙(§1) ────────────────────────────────────────────────
test('stale이면 status=unverified — 과거 supported 재사용 금지', () => {
  const stale = makeStaleCapabilityState()
  assert.deepEqual(stale, { status: 'unverified', freshness: 'stale', supportLevel: 'full', reasonCode: 'EVIDENCE_STALE' })
  assert.ok(validateCapabilityState(stale).ok)
  // stale인데 과거 supported를 그대로 둠 → 규칙 위반
  const bad: CapabilityState = { status: 'supported', freshness: 'stale', supportLevel: 'full', reasonCode: null }
  const r = validateCapabilityState(bad)
  assert.equal(r.ok, false)
  assert.equal(r.violation, 'EVIDENCE_STALE')
})

test('GPU 없음 + CPU fallback → supported·degraded·current', () => {
  const s = makeCpuFallbackCapabilityState()
  assert.deepEqual(s, { status: 'supported', freshness: 'current', supportLevel: 'degraded', reasonCode: 'CPU_FALLBACK_AVAILABLE' })
  assert.ok(validateCapabilityState(s).ok)
})

test('degraded를 unsupported로 접지 않는다', () => {
  const bad: CapabilityState = { status: 'unsupported', freshness: 'current', supportLevel: 'degraded', reasonCode: null }
  const r = validateCapabilityState(bad)
  assert.equal(r.ok, false)
  assert.equal(r.violation, 'CPU_FALLBACK_AVAILABLE')
})

test('정상 supported 상태는 통과', () => {
  const s = makeSupportedCapabilityState()
  assert.deepEqual(s, { status: 'supported', freshness: 'current', supportLevel: 'full', reasonCode: null })
  assert.ok(validateCapabilityState(s).ok)
})

// ── 소유권 3축(§2) ──────────────────────────────────────────────────────────
test('RuntimeOwnership은 2값 — user-selected/legacy-detected는 ownership 아님', () => {
  assert.deepEqual([...RUNTIME_OWNERSHIP], ['audioforge-managed', 'external-borrowed'])
  assert.ok(!isRuntimeOwnership('user-selected'))
  assert.ok(!isRuntimeOwnership('legacy-detected'))
  // 그것들은 source 축에 속한다.
  assert.ok(isCandidateSource('user-selected-external'))
  assert.ok(isCandidateSource('legacy-detected'))
})

test('CandidateSource / CandidateStatus 고정', () => {
  assert.deepEqual([...CANDIDATE_SOURCE], [
    'user-settings', 'managed-runtime', 'environment-variable', 'user-selected-external',
    'path-discovery', 'py-launcher-discovery', 'legacy-detected',
  ])
  assert.deepEqual([...CANDIDATE_STATUS], ['discovered', 'probing', 'validated', 'rejected', 'unavailable'])
  assert.ok(isCandidateStatus('validated'))
  assert.ok(!isCandidateStatus('done'))
})

test('managed / read-only 판별', () => {
  assert.ok(isManagedRuntime('audioforge-managed'))
  assert.ok(!isManagedRuntime('external-borrowed'))
  assert.ok(isReadOnlyRuntime('external-borrowed'))
  assert.ok(!isReadOnlyRuntime('audioforge-managed'))
})

test('ownership↔source 정합: managed-runtime ⇔ audioforge-managed', () => {
  assert.ok(validateOwnershipSource('audioforge-managed', 'managed-runtime').ok)
  assert.ok(validateOwnershipSource('external-borrowed', 'user-selected-external').ok)
  // 사용자 지정 ComfyUI Python = external-borrowed(관리 소유 아님)
  assert.ok(validateOwnershipSource('external-borrowed', 'py-launcher-discovery').ok)
  // 불일치 → PREFLIGHT_FAILED
  assert.deepEqual(validateOwnershipSource('audioforge-managed', 'user-selected-external'), { ok: false, reasonCode: 'PREFLIGHT_FAILED' })
  assert.deepEqual(validateOwnershipSource('external-borrowed', 'managed-runtime'), { ok: false, reasonCode: 'PREFLIGHT_FAILED' })
})

// ── 경로 규칙(§1) ────────────────────────────────────────────────────────────
test('경로 판별 헬퍼', () => {
  assert.ok(isAbsolutePath('/usr/bin/python3'))
  assert.ok(isAbsolutePath('C:\\Python312\\python.exe'))
  assert.ok(isAbsolutePath('\\\\host\\share\\p'))
  assert.ok(!isAbsolutePath('venv/bin/python'))
  assert.ok(isCanonicalAbsolutePath('C:/Python312/python.exe'))
  assert.ok(!isCanonicalAbsolutePath('C:/a/../b/python.exe'))
  assert.ok(isManagedRelativePath('venv/bin/python'))
  assert.ok(!isManagedRelativePath('../escape/python'))
  assert.equal(basenameOf('C:/Apps/AudioForge/python.exe'), 'python.exe')
  assert.equal(basenameOf('venv\\Scripts\\python.exe'), 'python.exe')
})

test('managed 후보는 root 내부 상대경로 + managed-runtime source만', () => {
  assert.deepEqual(
    validateInterpreterCandidate({ ownership: 'audioforge-managed', source: 'managed-runtime', path: 'venv/bin/python' }),
    { ok: true, reasonCode: null },
  )
  // managed인데 절대경로 → PREFLIGHT_FAILED
  assert.equal(validateInterpreterCandidate({ ownership: 'audioforge-managed', source: 'managed-runtime', path: 'C:/py/python.exe' }).reasonCode, 'PREFLIGHT_FAILED')
  // managed인데 source 불일치 → PREFLIGHT_FAILED
  assert.equal(validateInterpreterCandidate({ ownership: 'audioforge-managed', source: 'user-settings', path: 'venv/bin/python' }).reasonCode, 'PREFLIGHT_FAILED')
})

test('external-borrowed 후보는 canonical absolute만', () => {
  assert.deepEqual(
    validateInterpreterCandidate({ ownership: 'external-borrowed', source: 'user-selected-external', path: 'C:/ComfyUI/python_embeded/python.exe' }),
    { ok: true, reasonCode: null },
  )
  assert.deepEqual(
    validateInterpreterCandidate({ ownership: 'external-borrowed', source: 'path-discovery', path: '/usr/bin/python3' }),
    { ok: true, reasonCode: null },
  )
  // 외부인데 상대경로 → PREFLIGHT_FAILED
  assert.equal(validateInterpreterCandidate({ ownership: 'external-borrowed', source: 'path-discovery', path: 'venv/bin/python' }).reasonCode, 'PREFLIGHT_FAILED')
  // 외부인데 비정규(.. 포함) → PREFLIGHT_FAILED
  assert.equal(validateInterpreterCandidate({ ownership: 'external-borrowed', source: 'legacy-detected', path: 'C:/a/../b/python.exe' }).reasonCode, 'PREFLIGHT_FAILED')
  // 빈 경로 → INTERPRETER_NOT_FOUND
  assert.equal(validateInterpreterCandidate({ ownership: 'external-borrowed', source: 'path-discovery', path: '' }).reasonCode, 'INTERPRETER_NOT_FOUND')
})

// ── RuntimeFingerprint(§3) ──────────────────────────────────────────────────
test('fingerprint 구조 + 경로/venv/사용자명 부재', () => {
  const fp = sampleFingerprint()
  assert.deepEqual(Object.keys(fp).sort(), ['algorithm', 'architecture', 'digest', 'lockHash', 'packageCount', 'probeVersion', 'pythonVersion'])
  assert.equal(fp.algorithm, 'sha256')
  const keys = collectKeys(fp)
  for (const forbidden of ['path', 'venvPath', 'location', 'username', 'homedir']) {
    assert.ok(!keys.includes(forbidden), `fingerprint에 ${forbidden} 누출`)
  }
  // lockHash는 null 허용
  const noLock = makeRuntimeFingerprint({ digest: 'd', pythonVersion: '3.12', architecture: 'arm64', lockHash: null, probeVersion: '1', packageCount: 0 })
  assert.equal(noLock.lockHash, null)
})

// ── renderer view 경로 부재(§2) ─────────────────────────────────────────────
test('renderer interpreter ref는 pathRefId/basename/reasonCode만 — 전체 경로 부재', () => {
  const ref: RendererInterpreterRef = toRendererInterpreterRef(
    { path: 'C:/Apps/AudioForge/runtime/venv/Scripts/python.exe' }, 'ref-01', null,
  )
  assert.deepEqual(Object.keys(ref).sort(), ['basename', 'pathRefId', 'reasonCode'])
  assert.equal(ref.basename, 'python.exe')
  for (const s of collectStringValues(ref)) assert.ok(!isAbsolutePath(s), `renderer ref 절대경로 누출: ${s}`)
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
    ownership: 'external-borrowed', source: 'user-selected-external', status: 'validated',
    path: 'C:/ComfyUI/python_embeded/python.exe', version: '3.12.4',
  }
  assertByteStableRoundTrip(c)
})

test('RuntimeFingerprint / ValidationEvidence round-trip byte-stable', () => {
  assertByteStableRoundTrip(sampleFingerprint())
  assertByteStableRoundTrip(sampleEvidence())
})

test('CapabilitySnapshot round-trip byte-stable', () => {
  const tool: ToolCapability = { name: 'ffmpeg', status: 'supported', freshness: 'current', supportLevel: 'full', reasonCode: null }
  const model: ModelCapability = { name: 'htdemucs', status: 'unavailable', freshness: 'current', supportLevel: 'full', reasonCode: 'MODEL_MISSING' }
  const snap: CapabilitySnapshot = {
    schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION, ownership: 'audioforge-managed',
    fingerprint: sampleFingerprint(), evidence: sampleEvidence(), tools: [tool], models: [model],
  }
  assertByteStableRoundTrip(snap)
})

test('RuntimeResolutionResult round-trip + 경로/민감정보 완전 부재(§2·§5)', () => {
  const result: RuntimeResolutionResult = {
    schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
    resolved: true, ownership: 'external-borrowed', source: 'user-selected-external', candidateStatus: 'validated',
    status: 'supported', freshness: 'current', supportLevel: 'degraded', reasonCode: 'CPU_FALLBACK_AVAILABLE',
    policyOutcome: 'switched-to-managed-explicit',
    interpreter: { pathRefId: 'ref-42', basename: 'python.exe', reasonCode: null },
    capabilities: {
      schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION, ownership: 'external-borrowed',
      fingerprint: sampleFingerprint(), evidence: sampleEvidence(),
      tools: [{ name: 'ffmpeg', status: 'supported', freshness: 'current', supportLevel: 'full', reasonCode: null }],
      models: [{ name: 'htdemucs', status: 'supported', freshness: 'current', supportLevel: 'full', reasonCode: null }],
    },
  }
  assertByteStableRoundTrip(result)
  for (const s of collectStringValues(result)) assert.ok(!isAbsolutePath(s), `resolution result 절대경로 누출: ${s}`)
  const keys = collectKeys(result)
  for (const forbidden of ['path', 'traceback', 'stack', 'stderr', 'homedir', 'username', 'venvPath']) {
    assert.ok(!keys.includes(forbidden), `민감정보/경로 키 누출: ${forbidden}`)
  }
})

test('Map/Set 없이 plain 객체·배열만', () => {
  const snap: CapabilitySnapshot = {
    schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION, ownership: 'audioforge-managed',
    fingerprint: sampleFingerprint(), evidence: sampleEvidence(), tools: [], models: [],
  }
  assert.ok(Array.isArray(snap.tools) && Array.isArray(snap.models))
  assert.ok(Array.isArray(snap.evidence.checks) && Array.isArray(snap.evidence.modelChecks))
  const rt = JSON.parse(JSON.stringify(snap)) as CapabilitySnapshot
  assert.deepEqual(rt, snap)  // Map/Set이면 {}로 소실되어 깨짐
})
