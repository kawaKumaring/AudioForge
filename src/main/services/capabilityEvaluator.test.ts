// capability evaluator 단위 테스트 — 전부 synthetic 주입(실 probe/설치/GPU/미디어 없음).
// 검증 축: capability 독립성 / 증거 분리 / GPU≠CPU / 모델·checksum·venv 구분 /
//          pip warning vs fatal / stale 무효화 / borrowed drift.
import { test } from 'node:test'
import assert from 'node:assert/strict'
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

// probe의 observedAt 직후 시각(정상적으로 fresh하도록 stale 옵션에서 now 기준을 잡아줌).
const NOW = Date.parse(OBSERVED_AT) + 1000

function reqOf(id: CapabilityId): CapabilityRequirement {
  return DEFAULT_REQUIREMENTS.find((r) => r.capability === id)!
}

function evalAll(probe = healthyProbe()) {
  return evaluateSnapshotSet(DEFAULT_REQUIREMENTS, probe, { now: NOW, expectedProbeVersion: PROBE_VERSION })
}

test('healthy: 모든 capability supported (기준선)', () => {
  const s = evalAll()
  for (const id of ['corePython', 'music', 'dialogue', 'asr', 'pitch', 'qwen', 'gptSovits', 'ffmpeg', 'gpu'] as CapabilityId[]) {
    assert.equal(s[id].status, 'supported', `${id}는 supported여야 함`)
    assert.equal(s[id].reason, 'OK')
    assert.ok(isUsable(s[id]))
  }
})

test('core만 가능: core는 supported, 나머지는 각자 실패 — 전체 unavailable 아님', () => {
  const s = evalAll(fixtures.coreOnly())
  assert.equal(s.corePython.status, 'supported', 'core는 살아있음')
  // 다른 capability는 독립적으로 실패(하나의 killswitch로 전부 죽지 않음)
  assert.equal(s.music.status, 'unsupported')
  assert.equal(s.music.reason, 'PACKAGE_MISSING')
  assert.equal(s.asr.status, 'unsupported')
  assert.equal(s.asr.reason, 'PACKAGE_MISSING')
  assert.equal(s.qwen.reason, 'VENV_MISSING')
  assert.equal(s.ffmpeg.reason, 'FFMPEG_MISSING')
  // core가 살아있다는 것 = 전체 앱 unavailable이 아니라는 증거
  assert.ok(isUsable(s.corePython))
  assert.ok(!isUsable(s.music))
})

test('ASR만 불가: asr만 unsupported, music/dialogue/core는 그대로 supported (독립 판정)', () => {
  const s = evalAll(fixtures.asrOnlyBroken())
  assert.equal(s.asr.status, 'unsupported')
  assert.equal(s.asr.reason, 'PACKAGE_MISSING')
  assert.equal(s.asr.evidence.packageImport?.detail, 'whisper')
  // 다른 것들은 영향 없음
  assert.equal(s.music.status, 'supported')
  assert.equal(s.dialogue.status, 'supported')
  assert.equal(s.corePython.status, 'supported')
})

test('Qwen venv만 불가: VENV_MISSING(모델 없음과 구분), parent capability는 정상', () => {
  const s = evalAll(fixtures.qwenVenvMissing())
  assert.equal(s.qwen.status, 'unsupported')
  assert.equal(s.qwen.reason, 'VENV_MISSING')
  // 모델 관련 증거로 오판하지 않음
  assert.equal(s.qwen.evidence.model, undefined)
  // parent 기반 capability는 살아있음
  assert.equal(s.music.status, 'supported')
  assert.equal(s.corePython.status, 'supported')
})

test('Qwen venv와 parent는 서로 다른 interpreter 증거(분리 판정)', () => {
  const s = evalAll()
  assert.ok(s.qwen.interpreter && s.corePython.interpreter)
  assert.notEqual(s.qwen.interpreter!.id, s.corePython.interpreter!.id)
  assert.notEqual(s.qwen.packageFingerprint, s.corePython.packageFingerprint)
  // gptSovits도 또 다른 인터프리터
  assert.notEqual(s.gptSovits.interpreter!.id, s.qwen.interpreter!.id)
})

test('모델 없음 vs venv 없음 vs checksum mismatch 구분', () => {
  const missingModel = evalAll(fixtures.qwenModelMissing())
  assert.equal(missingModel.qwen.reason, 'MODEL_MISSING')
  assert.equal(missingModel.qwen.evidence.interpreter?.ok, true, 'venv/인터프리터는 정상')
  assert.equal(missingModel.qwen.evidence.checksum, undefined, 'checksum 단계 도달 안 함')

  const badChecksum = evalAll(fixtures.qwenChecksumMismatch())
  assert.equal(badChecksum.qwen.reason, 'CHECKSUM_MISMATCH')
  assert.equal(badChecksum.qwen.evidence.model?.ok, true, '모델 파일은 존재')
  assert.equal(badChecksum.qwen.evidence.checksum?.ok, false)

  const noVenv = evalAll(fixtures.qwenVenvMissing())
  assert.equal(noVenv.qwen.reason, 'VENV_MISSING')
  // 세 사유는 모두 다른 코드
  assert.notEqual(missingModel.qwen.reason, badChecksum.qwen.reason)
  assert.notEqual(missingModel.qwen.reason, noVenv.qwen.reason)
})

test('CUDA 없음 ≠ CPU 불가: 연산 capability는 degraded지만 사용 가능, gpu capability만 unsupported', () => {
  const s = evalAll(fixtures.noCudaCpuOk())
  // gpu capability 자체는 unsupported
  assert.equal(s.gpu.status, 'unsupported')
  assert.equal(s.gpu.reason, 'GPU_UNAVAILABLE')
  // 연산 capability(music/asr/dialogue)는 CPU로 여전히 사용 가능
  for (const id of ['music', 'asr', 'dialogue'] as CapabilityId[]) {
    assert.equal(s[id].status, 'degraded', `${id}는 CPU 폴백으로 degraded`)
    assert.ok(isUsable(s[id]), `${id}는 여전히 사용 가능`)
    assert.equal(s[id].acceleration.gpuAvailable, false)
    assert.equal(s[id].acceleration.cpuFallback, true, `${id}는 CPU 폴백 가능(별도 필드)`)
    assert.ok(s[id].warnings.includes('GPU_UNAVAILABLE'))
  }
  // pitch는 gpuEligible=false → GPU 없어도 warning 없이 supported
  assert.equal(s.pitch.status, 'supported')
})

test('pip check: warning은 degraded(사용 가능), fatal은 unsupported — 구분', () => {
  const warn = evalAll(fixtures.pipCheckWarning())
  assert.equal(warn.corePython.status, 'degraded')
  assert.ok(warn.corePython.warnings.includes('PIP_CHECK_WARNING'))
  assert.ok(isUsable(warn.corePython), 'warning은 여전히 사용 가능')

  const fatal = evalAll(fixtures.pipCheckFatal())
  assert.equal(fatal.corePython.status, 'unsupported')
  assert.equal(fatal.corePython.reason, 'PIP_CHECK_FATAL')
  assert.ok(!isUsable(fatal.corePython))
})

test('증거 분리(ValidationEvidence): import·version·pipcheck·arch·pythonVersion이 각각 별도 항목', () => {
  const s = evalAll()
  const e = s.music.evidence
  // music은 import+pipcheck+interpreter 증거를 가진다(각각 분리 보관)
  assert.ok(e.interpreter, 'interpreter 증거')
  assert.ok(e.packageImport, 'packageImport 증거')
  assert.ok(e.pipCheck, 'pipCheck 증거')
  // pythonVersion 증거도 분리(정상)
  assert.ok(s.corePython.evidence.pythonVersion, 'pythonVersion 증거 분리')

  // arch mismatch 시 architecture 증거만 fatal, packageImport는 정상으로 분리 유지
  const arch = evalAll(fixtures.archMismatch())
  assert.equal(arch.corePython.reason, 'ARCH_MISMATCH')
  assert.equal(arch.corePython.evidence.architecture?.ok, false)
  assert.equal(arch.corePython.evidence.packageImport?.ok, true, '패키지 증거는 여전히 분리·정상')

  // python 버전 미충족 시 pythonVersion 증거만 fatal
  const old = evalAll(fixtures.pythonTooOld())
  assert.equal(old.corePython.reason, 'PYTHON_VERSION_UNSUPPORTED')
  assert.equal(old.corePython.evidence.pythonVersion?.ok, false)
})

test('stale 무효화: probeVersion 불일치면 stale, supported로 재사용 금지', () => {
  const s = evaluateSnapshotSet(DEFAULT_REQUIREMENTS, healthyProbe(), {
    now: NOW,
    expectedProbeVersion: 'DIFFERENT-VERSION',
  })
  for (const id of Object.keys(s) as CapabilityId[]) {
    assert.equal(s[id].status, 'stale', `${id}는 stale`)
    assert.equal(s[id].reason, 'STALE_SNAPSHOT')
    assert.ok(!isUsable(s[id]), 'stale은 usable 아님(재사용 금지)')
  }
})

test('stale 무효화: observedAt이 maxAge보다 오래되면 stale', () => {
  const wayLater = Date.parse(OBSERVED_AT) + 10 * 60 * 1000 // 10분 후
  const snap = evaluateCapability(reqOf('corePython'), healthyProbe(), {
    now: wayLater,
    maxAgeMs: 60 * 1000, // 1분
  })
  assert.equal(snap.status, 'stale')
  assert.ok(!isUsable(snap))

  // maxAge 이내면 정상
  const fresh = evaluateCapability(reqOf('corePython'), healthyProbe(), {
    now: Date.parse(OBSERVED_AT) + 30 * 1000,
    maxAgeMs: 60 * 1000,
  })
  assert.equal(fresh.status, 'supported')
})

test('borrowed drift: fingerprint 불일치 → ENV_DRIFT unsupported', () => {
  const s = evalAll(fixtures.borrowedDrift())
  assert.equal(s.corePython.status, 'unsupported')
  assert.equal(s.corePython.reason, 'ENV_DRIFT')
  assert.equal(s.corePython.evidence.drift?.ok, false)
})

test('snapshot 메타: observedAt·probeVersion·packageFingerprint 존재', () => {
  const s = evalAll()
  assert.equal(s.corePython.observedAt, OBSERVED_AT)
  assert.equal(s.corePython.probeVersion, PROBE_VERSION)
  assert.equal(s.corePython.packageFingerprint, 'fp-parent-abc')
})

test('reason code·detail에 전체 경로·traceback 없음(비민감)', () => {
  const s = evalAll(fixtures.coreOnly())
  const collect: string[] = []
  for (const id of Object.keys(s) as CapabilityId[]) {
    for (const item of Object.values(s[id].evidence)) {
      if (item?.detail) collect.push(item.detail)
    }
  }
  for (const d of collect) {
    assert.ok(!d.includes('\\') && !d.includes('/'), `detail에 경로 없음: ${d}`)
    assert.ok(!/Traceback|File "/.test(d), `detail에 traceback 없음: ${d}`)
  }
})

test('env_check --json 어댑터: parent probe + system probe 매핑', () => {
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
  const parent = interpreterProbeFromEnvCheck(envJson, { id: 'parent', fingerprint: 'fp1', minPythonVersion: '3.9.0' })
  const system = systemProbeFromEnvCheck(envJson)
  const probe = {
    probeVersion: PROBE_VERSION,
    observedAt: OBSERVED_AT,
    interpreters: { parent },
    models: {},
    system,
  }
  const core = evaluateCapability(reqOf('corePython'), probe, { now: NOW })
  assert.equal(core.status, 'supported', 'core 3종 충족')
  const asr = evaluateCapability(reqOf('asr'), probe, { now: NOW })
  assert.equal(asr.reason, 'PACKAGE_MISSING', 'whisper 없음 → asr 불가')
  // env_check가 제공 안 하는 축(pip check/arch)은 증거 없음 → fatal 오판 안 함
  assert.equal(core.evidence.pipCheck, undefined)
  assert.equal(core.evidence.architecture, undefined)
})
