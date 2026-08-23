// capability evaluator 단위 테스트 — 전부 synthetic 주입(실 probe/설치/GPU/미디어 없음).
// 검증 축: capability 독립성 / 증거 분리 / GPU≠CPU / 모델·checksum·venv 구분 /
//          pip warning vs fatal / stale→unverified / borrowed drift / 계약 정합(로컬 중복 0).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  evaluateCapability,
  evaluateSnapshotSet,
  isUsable,
  interpreterProbeFromEnvCheck,
  systemProbeFromEnvCheck,
  DEFAULT_REQUIREMENTS,
  type CapabilityRequirement,
  type CapabilityId,
} from './capabilityEvaluator.ts'
import { fixtures, healthyProbe, PROBE_VERSION, OBSERVED_AT } from './capabilityEvaluator.fixtures.ts'
import {
  isReasonCode,
  isReasonCodeOrNull,
  isCapabilityStatus,
  validateCapabilityState,
  CAPABILITY_REASON_CODE_MAP,
} from '../../shared/runtimeContract.ts'

const NOW = Date.parse(OBSERVED_AT) + 1000

function reqOf(id: CapabilityId): CapabilityRequirement {
  return DEFAULT_REQUIREMENTS.find((r) => r.capability === id)!
}

function evalAll(probe = healthyProbe()) {
  return evaluateSnapshotSet(DEFAULT_REQUIREMENTS, probe, { now: NOW, expectedProbeVersion: PROBE_VERSION })
}

const ALL_IDS: CapabilityId[] = ['corePython', 'music', 'dialogue', 'asr', 'pitch', 'qwen', 'gptSovits', 'ffmpeg', 'gpu']

test('healthy: 모든 capability supported/full/current (기준선)', () => {
  const s = evalAll()
  for (const id of ALL_IDS) {
    assert.equal(s[id].state.status, 'supported', `${id}는 supported`)
    assert.equal(s[id].state.freshness, 'current')
    assert.equal(s[id].state.supportLevel, 'full')
    assert.equal(s[id].state.reasonCode, null)
    assert.ok(isUsable(s[id]))
  }
})

test('core만 가능: core는 supported, 나머지는 각자 실패 — 전체 unavailable 아님(killswitch 부재)', () => {
  const s = evalAll(fixtures.coreOnly())
  assert.equal(s.corePython.state.status, 'supported', 'core는 살아있음')
  assert.equal(s.music.state.status, 'unavailable')
  assert.equal(s.music.state.reasonCode, 'PACKAGE_MISSING')
  assert.equal(s.asr.state.status, 'unavailable')
  assert.equal(s.asr.state.reasonCode, 'PACKAGE_MISSING')
  assert.equal(s.qwen.state.reasonCode, 'VENV_MISSING')
  assert.equal(s.ffmpeg.state.reasonCode, 'TOOL_MISSING')
  // core가 살아있음 = 전체 앱 unavailable이 아님
  assert.ok(isUsable(s.corePython))
  assert.ok(!isUsable(s.music))
})

test('ASR만 불가: asr만 unavailable, music/dialogue/core는 supported (독립 판정)', () => {
  const s = evalAll(fixtures.asrOnlyBroken())
  assert.equal(s.asr.state.status, 'unavailable')
  assert.equal(s.asr.state.reasonCode, 'PACKAGE_MISSING')
  assert.equal(s.asr.evidence.importCheck?.reasonCode, 'PACKAGE_MISSING')
  assert.equal(s.music.state.status, 'supported')
  assert.equal(s.dialogue.state.status, 'supported')
  assert.equal(s.corePython.state.status, 'supported')
})

test('Qwen venv만 불가: VENV_MISSING(모델 없음과 구분), parent capability는 정상', () => {
  const s = evalAll(fixtures.qwenVenvMissing())
  assert.equal(s.qwen.state.status, 'unavailable')
  assert.equal(s.qwen.state.reasonCode, 'VENV_MISSING')
  assert.equal(s.qwen.evidence.modelChecks.length, 0, '모델 검사 도달 안 함')
  assert.equal(s.music.state.status, 'supported')
  assert.equal(s.corePython.state.status, 'supported')
})

test('Qwen venv와 parent는 서로 다른 interpreter 증거(지문 digest 분리)', () => {
  const s = evalAll()
  assert.ok(s.qwen.interpreter && s.corePython.interpreter)
  assert.notEqual(s.qwen.interpreter!.id, s.corePython.interpreter!.id)
  assert.notEqual(s.qwen.interpreter!.fingerprint!.digest, s.corePython.interpreter!.fingerprint!.digest)
  assert.notEqual(s.qwen.evidence.fingerprint.digest, s.corePython.evidence.fingerprint.digest)
  assert.notEqual(s.gptSovits.interpreter!.id, s.qwen.interpreter!.id)
})

test('모델 없음 vs venv 없음 vs checksum mismatch 구분 + canonical reasonCode 매핑', () => {
  const missingModel = evalAll(fixtures.qwenModelMissing())
  assert.equal(missingModel.qwen.state.reasonCode, 'MODEL_MISSING')
  assert.equal(missingModel.qwen.evidence.checks.some((c) => c.kind === 'venv' && c.status === 'supported'), true)

  const badChecksum = evalAll(fixtures.qwenChecksumMismatch())
  assert.equal(badChecksum.qwen.state.reasonCode, 'MODEL_CHECKSUM_MISMATCH')
  // 계약 map을 통한 reconcile: 구 CHECKSUM_MISMATCH → canonical MODEL_CHECKSUM_MISMATCH
  assert.equal(badChecksum.qwen.state.reasonCode, CAPABILITY_REASON_CODE_MAP['CHECKSUM_MISMATCH'])
  assert.equal(badChecksum.qwen.evidence.modelChecks.length, 2, '모델 존재 + checksum 두 항목')

  const noVenv = evalAll(fixtures.qwenVenvMissing())
  assert.equal(noVenv.qwen.state.reasonCode, 'VENV_MISSING')
  // 세 사유 모두 다른 코드
  assert.notEqual(missingModel.qwen.state.reasonCode, badChecksum.qwen.state.reasonCode)
  assert.notEqual(missingModel.qwen.state.reasonCode, noVenv.qwen.state.reasonCode)
})

test('CUDA 없음 ≠ CPU 불가: 연산 capability=supported+degraded+current(CPU_FALLBACK), gpu capability만 unavailable', () => {
  const s = evalAll(fixtures.noCudaCpuOk())
  // gpu capability 자체는 unavailable
  assert.equal(s.gpu.state.status, 'unavailable')
  assert.equal(s.gpu.state.reasonCode, 'GPU_UNAVAILABLE')
  assert.ok(!isUsable(s.gpu))
  // 연산 capability는 CPU로 여전히 사용 가능 — status=supported, supportLevel=degraded, freshness=current
  for (const id of ['music', 'asr', 'dialogue'] as CapabilityId[]) {
    assert.equal(s[id].state.status, 'supported', `${id} status=supported`)
    assert.equal(s[id].state.supportLevel, 'degraded', `${id} supportLevel=degraded`)
    assert.equal(s[id].state.freshness, 'current', `${id} freshness=current`)
    assert.equal(s[id].state.reasonCode, 'CPU_FALLBACK_AVAILABLE')
    assert.ok(isUsable(s[id]), `${id}는 여전히 사용 가능`)
    assert.equal(s[id].acceleration.gpuAvailable, false)
    assert.equal(s[id].acceleration.cpuFallback, true, `${id}는 CPU 폴백 가능(별도 필드)`)
  }
  // pitch는 gpuEligible=false → GPU 없어도 full supported
  assert.equal(s.pitch.state.status, 'supported')
  assert.equal(s.pitch.state.supportLevel, 'full')
})

test('pip check: warning은 supported+degraded(사용 가능), fatal은 unavailable — 구분', () => {
  const warn = evalAll(fixtures.pipCheckWarning())
  assert.equal(warn.corePython.state.status, 'supported')
  assert.equal(warn.corePython.state.supportLevel, 'degraded')
  assert.equal(warn.corePython.state.reasonCode, 'PIP_CHECK_FAILED')
  assert.ok(isUsable(warn.corePython), 'warning은 여전히 사용 가능')

  const fatal = evalAll(fixtures.pipCheckFatal())
  assert.equal(fatal.corePython.state.status, 'unavailable')
  assert.equal(fatal.corePython.state.reasonCode, 'PIP_CHECK_FAILED')
  assert.ok(!isUsable(fatal.corePython))
})

test('증거 분리(ValidationEvidence envelope): import·package·architecture·pipcheck·python-version 각각 별도 항목', () => {
  const s = evalAll()
  const e = s.music.evidence
  assert.ok(e.importCheck, 'importCheck 봉투 필드')
  assert.ok(e.checks.some((c) => c.kind === 'pip-check'), 'pip-check 항목')
  assert.ok(e.checks.some((c) => c.kind === 'venv'), 'venv/interpreter 항목')
  assert.ok(s.corePython.evidence.checks.some((c) => c.kind === 'python-version'), 'python-version 항목 분리')

  // arch mismatch: architecture만 fatal(incompatible), import는 별도로 정상 유지
  const arch = evalAll(fixtures.archMismatch())
  assert.equal(arch.corePython.state.reasonCode, 'ARCHITECTURE_INCOMPATIBLE')
  assert.equal(arch.corePython.state.status, 'incompatible')
  assert.equal(arch.corePython.evidence.architectureCheck?.status, 'incompatible')
  assert.equal(arch.corePython.evidence.importCheck?.status, 'supported', '패키지 증거는 분리·정상')

  // python 버전 미충족: python-version만 fatal(incompatible)
  const old = evalAll(fixtures.pythonTooOld())
  assert.equal(old.corePython.state.reasonCode, 'PYTHON_VERSION_INCOMPATIBLE')
  assert.equal(old.corePython.state.status, 'incompatible')
  const pv = old.corePython.evidence.checks.find((c) => c.kind === 'python-version')
  assert.equal(pv?.status, 'incompatible')
})

test('stale 무효화(probeVersion): freshness=stale + status=unverified, 과거 supported 재사용 금지', () => {
  const s = evaluateSnapshotSet(DEFAULT_REQUIREMENTS, healthyProbe(), {
    now: NOW,
    expectedProbeVersion: 'DIFFERENT-VERSION',
  })
  for (const id of ALL_IDS) {
    assert.equal(s[id].state.freshness, 'stale', `${id} freshness=stale`)
    assert.equal(s[id].state.status, 'unverified', `${id} status=unverified`)
    assert.equal(s[id].state.reasonCode, 'EVIDENCE_STALE')
    assert.equal(s[id].state.reasonCode, CAPABILITY_REASON_CODE_MAP['STALE_SNAPSHOT'])
    assert.ok(!isUsable(s[id]), 'stale은 usable 아님(재사용 금지)')
    // 계약 정합: stale이면 반드시 unverified
    assert.equal(validateCapabilityState(s[id].state).ok, true)
  }
})

test('stale 무효화(maxAge): observedAt이 maxAge보다 오래되면 stale→unverified', () => {
  const wayLater = Date.parse(OBSERVED_AT) + 10 * 60 * 1000
  const snap = evaluateCapability(reqOf('corePython'), healthyProbe(), { now: wayLater, maxAgeMs: 60 * 1000 })
  assert.equal(snap.state.freshness, 'stale')
  assert.equal(snap.state.status, 'unverified')
  assert.ok(!isUsable(snap))

  const fresh = evaluateCapability(reqOf('corePython'), healthyProbe(), {
    now: Date.parse(OBSERVED_AT) + 30 * 1000,
    maxAgeMs: 60 * 1000,
  })
  assert.equal(fresh.state.status, 'supported')
  assert.equal(fresh.state.freshness, 'current')
})

test('borrowed drift: fingerprint digest 불일치 → PACKAGE_DRIFT unavailable', () => {
  const s = evalAll(fixtures.borrowedDrift())
  assert.equal(s.corePython.state.status, 'unavailable')
  assert.equal(s.corePython.state.reasonCode, 'PACKAGE_DRIFT')
  assert.equal(s.corePython.state.reasonCode, CAPABILITY_REASON_CODE_MAP['ENV_DRIFT'])
})

test('evidence envelope 메타: observedAt·probeVersion·fingerprint(RuntimeFingerprint w/ digest)', () => {
  const s = evalAll()
  assert.equal(s.corePython.evidence.observedAt, OBSERVED_AT)
  assert.equal(s.corePython.evidence.probeVersion, PROBE_VERSION)
  assert.equal(s.corePython.evidence.fingerprint.algorithm, 'sha256')
  assert.equal(s.corePython.evidence.fingerprint.digest, 'fp-parent-abc')
})

test('계약 정합: emit되는 status/reasonCode 전부 canonical + 로컬 CapabilityStatus/ReasonCode 선언 0', () => {
  // 모든 fixture를 돌려 emit되는 값이 계약 union에만 속하는지 확인.
  const probes = [
    healthyProbe(), fixtures.coreOnly(), fixtures.asrOnlyBroken(), fixtures.qwenVenvMissing(),
    fixtures.qwenModelMissing(), fixtures.qwenChecksumMismatch(), fixtures.noCudaCpuOk(),
    fixtures.pipCheckWarning(), fixtures.pipCheckFatal(), fixtures.borrowedDrift(),
    fixtures.archMismatch(), fixtures.pythonTooOld(), fixtures.ffmpegMissing(),
  ]
  for (const p of probes) {
    const s = evaluateSnapshotSet(DEFAULT_REQUIREMENTS, p, { now: NOW })
    for (const id of ALL_IDS) {
      const snap = s[id]
      assert.ok(isCapabilityStatus(snap.state.status), `${id} status canonical`)
      assert.ok(isReasonCodeOrNull(snap.state.reasonCode), `${id} reasonCode canonical|null`)
      assert.equal(validateCapabilityState(snap.state).ok, true, `${id} 3축 정합`)
      for (const c of snap.evidence.checks) {
        assert.ok(isCapabilityStatus(c.status))
        assert.ok(isReasonCodeOrNull(c.reasonCode))
        if (c.reasonCode !== null) assert.ok(isReasonCode(c.reasonCode))
      }
    }
  }
  // 소스에 로컬 CapabilityStatus/ReasonCode 타입 선언이 없어야 한다(계약에서 import).
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'capabilityEvaluator.ts'), 'utf-8')
  // 선언(=/{)만 잡고 import 목록의 `type X,`는 제외한다.
  assert.ok(!/\b(export\s+)?type\s+CapabilityStatus\s*=/.test(src), '로컬 CapabilityStatus 선언 0')
  assert.ok(!/\b(export\s+)?type\s+ReasonCode\s*=/.test(src), '로컬 ReasonCode 선언 0')
  assert.ok(!/\b(export\s+)?type\s+CapabilityState\s*=/.test(src), '로컬 CapabilityState 선언 0')
  assert.ok(!/\b(export\s+)?(type|interface)\s+ValidationEvidence(Item)?\s*[={]/.test(src), '로컬 ValidationEvidence 선언 0')
  assert.ok(!/\b(export\s+)?(type|interface)\s+RuntimeFingerprint\s*[={]/.test(src), '로컬 RuntimeFingerprint 선언 0')
  assert.ok(/from '\.\.\/\.\.\/shared\/runtimeContract\.ts'/.test(src), '계약에서 import')
})

test('env_check --json 어댑터: parent probe + system probe 매핑(canonical, 미제공 축 없음)', () => {
  const envJson = {
    python: 'X:/some/python.exe',
    python_version: '3.12.4',
    packages: [
      { pip: 'torch', import: 'torch', installed: true, version: '2.3.0', tier: 'core' },
      { pip: 'numpy', import: 'numpy', installed: true, version: '1.26.0', tier: 'core' },
      { pip: 'soundfile', import: 'soundfile', installed: true, version: '0.12.1', tier: 'core' },
      { pip: 'openai-whisper', import: 'whisper', installed: false, tier: 'core' },
    ],
    ffmpeg: true,
    cuda: { available: false, device: null, torch: '2.3.0' },
  }
  const parent = interpreterProbeFromEnvCheck(envJson, { id: 'parent', probeVersion: PROBE_VERSION, digest: 'fp1', minPythonVersion: '3.9.0' })
  const system = systemProbeFromEnvCheck(envJson)
  const probe = { probeVersion: PROBE_VERSION, observedAt: OBSERVED_AT, interpreters: { parent }, models: {}, system }
  const core = evaluateCapability(reqOf('corePython'), probe, { now: NOW })
  assert.equal(core.state.status, 'supported', 'core 3종 충족')
  assert.equal(core.evidence.fingerprint.digest, 'fp1')
  const asr = evaluateCapability(reqOf('asr'), probe, { now: NOW })
  assert.equal(asr.state.reasonCode, 'PACKAGE_MISSING', 'whisper 없음 → asr 불가')
  // env_check가 제공 안 하는 축(pip check/arch)은 증거 없음 → fatal 오판 안 함
  assert.equal(core.evidence.checks.some((c) => c.kind === 'pip-check'), false)
  assert.equal(core.evidence.architectureCheck, null)
})
