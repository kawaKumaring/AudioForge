// provisionContract 계약 회귀 테스트 — Node 내장 러너(node --test), 새 의존성 0.
// 실행: npm test  (또는 node --test src/shared/provisionContract.test.ts)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isReasonCode } from './runtimeContract.ts'
import {
  PROVISION_CONTRACT_SCHEMA_VERSION,
  PROVISION_MANIFEST_SCHEMA_VERSION,
  DEFAULT_PROVISION_PROFILE,
  COMPONENT_KINDS,
  canonicalize,
  planIsApplicable,
  tokenMatchesPlan,
  estimateInstallBytes,
  displayRootLabel,
  displayComponentLabel,
  findAbsolutePath,
  assertNoAbsolutePaths,
  isSafeProvisionRelativePath,
  isImmutableArtifact,
  isExactHashedLock,
  manifestComponentIsResolved,
  type PlanResult,
  type ComponentView,
  type ImmutableArtifact,
  type ManifestComponent,
} from './provisionContract.ts'

function comp(over: Partial<ComponentView>): ComponentView {
  return {
    id: 'c', kind: 'model', version: '1', required: false, dependsOn: [],
    installPath: 'qwen3', displayLabel: 'Qwen3-TTS 모델', license: null,
    resolved: false, reasonCode: 'UNRESOLVED_COMPONENT',
    sizes: { compressed: null, installed: null, total: null },
    ...over,
  }
}

function plan(over: Partial<PlanResult> = {}): PlanResult {
  return {
    schemaVersion: PROVISION_CONTRACT_SCHEMA_VERSION,
    mode: 'plan',
    components: [comp({})],
    resolvedAll: false,
    blockingReasons: ['UNRESOLVED_COMPONENT'],
    planFingerprint: 'abc123',
    ...over,
  }
}

// ── canonicalize: Python provision.fingerprint.canonical_json과 동형 ─────────
test('canonicalize는 키를 사전순 정렬하고 공백 0으로 직렬화한다', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(canonicalize({ a: 2, b: 1 }), '{"a":2,"b":1}')
  assert.equal(canonicalize({ x: [1, 2, 3] }), '{"x":[1,2,3]}')
})

test('canonicalize는 비-ASCII를 보존하고 null/undefined를 정규화한다', () => {
  // Python json.dumps(ensure_ascii=False)와 동일하게 유니코드 리터럴 유지.
  assert.equal(canonicalize({ label: '보컬 분리' }), '{"label":"보컬 분리"}')
  assert.equal(canonicalize(null), 'null')
  // undefined 값 키는 생략(JSON 규칙).
  assert.equal(canonicalize({ a: undefined, b: 1 }), '{"b":1}')
})

test('canonicalize는 중첩 구조를 재귀 정렬한다', () => {
  const payload = [
    { id: 'bootstrap-python', kind: 'bootstrap', resolved: false },
    { id: 'ffmpeg', kind: 'tool', resolved: false },
  ]
  assert.equal(
    canonicalize(payload),
    '[{"id":"bootstrap-python","kind":"bootstrap","resolved":false},{"id":"ffmpeg","kind":"tool","resolved":false}]',
  )
})

// ── plan 해석 헬퍼 ────────────────────────────────────────────────────────────
test('planIsApplicable: 미해결이면 첫 blocking 사유로 불가', () => {
  const r = planIsApplicable(plan())
  assert.equal(r.ok, false)
  assert.equal(r.reasonCode, 'UNRESOLVED_COMPONENT')
})

test('planIsApplicable: 전부 resolved면 가능', () => {
  const r = planIsApplicable(plan({ resolvedAll: true, blockingReasons: [] }))
  assert.equal(r.ok, true)
  assert.equal(r.reasonCode, null)
})

test('tokenMatchesPlan: fingerprint 정확 일치만 승인', () => {
  const p = plan({ planFingerprint: 'deadbeef' })
  assert.equal(tokenMatchesPlan('deadbeef', p), true)
  assert.equal(tokenMatchesPlan('other', p), false)
  assert.equal(tokenMatchesPlan('', p), false)
  assert.equal(tokenMatchesPlan(null, p), false)
})

test('estimateInstallBytes: installed 우선, 미상은 hasUnknown', () => {
  const p = plan({
    components: [
      comp({ sizes: { compressed: null, installed: 100, total: 200 } }),
      comp({ sizes: { compressed: null, installed: null, total: 50 } }),
      comp({ sizes: { compressed: null, installed: null, total: null } }),
    ],
  })
  const e = estimateInstallBytes(p)
  assert.equal(e.bytes, 150) // 100 + 50
  assert.equal(e.hasUnknown, true)
})

// ── displayLabel 규약(전체 경로 노출 0) ──────────────────────────────────────
test('displayRootLabel: managed는 고정 라벨, borrowed는 사용자 선택 위치', () => {
  assert.equal(displayRootLabel('runtimeRoot', 'audioforge-managed'), 'AudioForge 앱 데이터/runtime')
  assert.equal(displayRootLabel('modelRoot', 'audioforge-managed'), 'AudioForge 앱 데이터/models')
  assert.equal(displayRootLabel('runtimeRoot', 'external-borrowed'), '사용자 선택 위치')
})

test('displayComponentLabel: displayLabel → basename → id 순', () => {
  assert.equal(displayComponentLabel({ displayLabel: '보컬 분리 모델', installPath: 'separator_models', id: 'x' }), '보컬 분리 모델')
  assert.equal(displayComponentLabel({ displayLabel: null, installPath: 'separator_models/roformer', id: 'x' }), 'roformer')
  assert.equal(displayComponentLabel({ displayLabel: null, installPath: null, id: 'models.qwen3' }), 'models.qwen3')
})

// ── renderer-safety: 절대경로 검출 ───────────────────────────────────────────
test('findAbsolutePath: 드라이브/POSIX/UNC 절대경로를 그래프에서 검출', () => {
  assert.equal(findAbsolutePath({ a: { b: ['C:\\af\\rt'] } }), 'C:\\af\\rt')
  assert.equal(findAbsolutePath({ a: '/usr/local/x' }), '/usr/local/x')
  assert.equal(findAbsolutePath({ a: '\\\\host\\share' }), '\\\\host\\share')
  assert.equal(findAbsolutePath({ installPath: 'separator_models/roformer' }), null)
})

test('assertNoAbsolutePaths: 정상 plan은 통과, 절대경로 섞이면 throw', () => {
  assert.doesNotThrow(() => assertNoAbsolutePaths(plan()))
  assert.throws(() => assertNoAbsolutePaths(plan({
    components: [comp({ installPath: 'C:/leak/models' })],
  })))
})

// ── 계약 정합: component kind / reasonCode ──────────────────────────────────
test('COMPONENT_KINDS 고정 + reasonCode 슬롯은 계약 ReasonCode', () => {
  assert.deepEqual([...COMPONENT_KINDS], ['bootstrap', 'venv', 'tool', 'model', 'cache'])
  const p = plan()
  for (const c of p.components) {
    if (c.reasonCode !== null) assert.ok(isReasonCode(c.reasonCode), `${c.reasonCode}는 계약 ReasonCode여야 함`)
  }
  for (const rcode of p.blockingReasons) assert.ok(isReasonCode(rcode))
})

const H = 'a'.repeat(64)
const artifact = (over: Partial<ImmutableArtifact> = {}): ImmutableArtifact => ({
  url: 'https://example.invalid/release/demo.zip', revision: 'v1.0.0', filename: 'demo.zip',
  sha256: H, compressedBytes: 10, installedBytes: 20,
  license: { code: 'MIT', weights: 'n/a', data: 'n/a', output: 'n/a' },
  noticeSha256: 'b'.repeat(64), sbomSha256: 'c'.repeat(64), ...over,
})

const manifestComp = (over: Partial<ManifestComponent> = {}): ManifestComponent => ({
  id: 'tool', kind: 'tool', version: '1', required: true, dependsOn: [],
  installPath: 'tools/demo', displayLabel: 'demo', license: null, artifact: artifact(), ...over,
})

test('manifest schema v2와 minimal-qwen 기본 profile을 고정한다', () => {
  assert.equal(PROVISION_MANIFEST_SCHEMA_VERSION, 2)
  assert.equal(DEFAULT_PROVISION_PROFILE, 'minimal-qwen')
})

test('portable install path는 절대경로·역슬래시·dot segment를 거부한다', () => {
  assert.equal(isSafeProvisionRelativePath('tools/ffmpeg'), true)
  for (const bad of ['../x', 'a/../x', 'C:/x', '/x', '\\\\host\\x', 'a\\b', 'a//b', 'a/stream:name', 'a/trailing.']) {
    assert.equal(isSafeProvisionRelativePath(bad), false, bad)
  }
})

test('immutable artifact는 완전한 SHA/크기/license/notice/SBOM만 허용한다', () => {
  assert.equal(isImmutableArtifact(artifact()), true)
  assert.equal(isImmutableArtifact(artifact({ sha256: 'd0' })), false)
  assert.equal(isImmutableArtifact(artifact({ revision: 'latest' })), false)
  assert.equal(isImmutableArtifact(artifact({ compressedBytes: 0 })), false)
  assert.equal(isImmutableArtifact(artifact({ noticeSha256: null })), false)
})

test('venv는 exact hashed lock 없이는 false-resolved 되지 않는다', () => {
  const exact = {
    format: 'pip-requirements-hashes' as const, sha256: 'd'.repeat(64),
    entries: [{ name: 'numpy', version: '2.2.0', filename: 'numpy.whl', sha256: 'e'.repeat(64) }],
  }
  assert.equal(isExactHashedLock(exact), true)
  assert.equal(manifestComponentIsResolved(manifestComp({ kind: 'venv', lock: exact })), true)
  assert.equal(manifestComponentIsResolved(manifestComp({ kind: 'venv', lock: null })), false)
  assert.equal(isExactHashedLock({ ...exact, entries: [{ ...exact.entries[0], version: '>=2' }] }), false)
})

test('model required file SHA와 path 중복도 resolved를 차단한다', () => {
  const base = manifestComp({ kind: 'model', requiredFiles: [{ path: 'a.bin', sha256: H }] })
  assert.equal(manifestComponentIsResolved(base), true)
  assert.equal(manifestComponentIsResolved({ ...base, requiredFiles: [{ path: '../a', sha256: H }] }), false)
  assert.equal(manifestComponentIsResolved({ ...base, requiredFiles: [
    { path: 'a.bin', sha256: H }, { path: 'a.bin', sha256: H },
  ] }), false)
})
