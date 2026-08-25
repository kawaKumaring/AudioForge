// 순수 capability evaluator — probe 결과(증거)를 소비해 capability별 독립 판정을 만든다.
//
// 목적/경계:
//   - 부수효과·I/O·서브프로세스 없음. 입력은 "probe 결과"(누군가 이미 측정해 넘긴 증거)뿐,
//     출력은 capability별 CapabilityEvaluation이다. 실제 측정(env_check.py --json 실행,
//     venv 존재 확인, checksum 계산 등)은 production이 하고 evaluator는 *해석*만 한다.
//   - production(audio.ipc.ts / setup_env.py / python/env_check.py)은 수정하지 않는다.
//     env_check.REQUIRED(패키지 설치·버전 단일 소스)를 여기서 재정의하지 않고, 아래
//     `CapabilityProbe`가 adapter 경계다 — env_check --json은 fromEnvCheck 어댑터가 매핑한다.
//
// v2 reconcile(계약 채택):
//   상태·사유·지문·증거의 타입/표현을 src/shared/runtimeContract.ts(계약 v2)에서 import한다.
//   - 로컬 CapabilityStatus/ReasonCode/fingerprint 문자열/evidence 구조 정의를 전부 삭제.
//   - 상태는 3축(status 5값 / freshness / supportLevel) + reasonCode(canonical union|null).
//     degraded → supportLevel=degraded(status는 supported 유지),
//     stale     → freshness=stale + status=unverified(과거 supported 재사용 금지),
//     GPU 없음+CPU 가능 → status=supported·supportLevel=degraded·freshness=current.
//   - 지문은 RuntimeFingerprint(digest 필드), 증거는 ValidationEvidence envelope +
//     ValidationEvidenceItem. reasonCode는 CAPABILITY_REASON_CODE_MAP canonical만(자유 문자열 금지).
//   ※ 판정 로직 자체(9 독립 capability·killswitch 부재·증거 분리·GPU/CPU·모델/checksum/venv
//     구분·stale/drift·env_check adapter)는 v1과 동일 — 타입·표현만 계약으로 이관했다.

import {
  type CapabilityStatus,
  type CapabilityState,
  type ReasonCode,
  type RuntimeFingerprint,
  type ValidationEvidence,
  type ValidationEvidenceItem,
  type EvidenceKind,
  makeRuntimeFingerprint,
  makeSupportedCapabilityState,
  makeStaleCapabilityState,
  makeCpuFallbackCapabilityState,
} from '../../shared/runtimeContract.ts'

// ── capability 목록 (각각 독립 판정) ──────────────────────────────────────────
export type CapabilityId =
  | 'corePython'
  | 'music'
  | 'dialogue'
  | 'asr'
  | 'pitch'
  | 'qwen'
  | 'gptSovits'
  | 'ffmpeg'
  | 'gpu'

// 내부 심각도 — 계약 타입이 아니다(evaluator 전용 판정 보조). ValidationEvidenceItem에는
// severity가 없으므로 항목을 만들 때 severity를 별도로 들고 다닌다.
type Severity = 'ok' | 'warning' | 'fatal'

// GPU와 CPU를 분리 — "GPU 없음"이 "CPU 불가"를 의미하지 않는다(별도 필드).
// 계약의 supportLevel(degraded)·CPU_FALLBACK_AVAILABLE와 정합하는 파생 편의 필드.
export interface Acceleration {
  gpuAvailable: boolean
  cpuFallback: boolean
}

// 어느 인터프리터로 판정했는지 — qwen venv와 parent python은 서로 다른 id/지문을 가진다.
export interface InterpreterRef {
  id: string
  pythonVersion?: string
  fingerprint?: RuntimeFingerprint
}

// capability 1건의 판정 결과. (계약의 CapabilitySnapshot은 runtime 전체 tools+models 봉투로
// 의미가 다르므로 이름 충돌을 피해 CapabilityEvaluation으로 둔다.)
export interface CapabilityEvaluation {
  capability: CapabilityId
  state: CapabilityState          // status(5값)·freshness·supportLevel·reasonCode
  evidence: ValidationEvidence    // observedAt·probeVersion·fingerprint·checks 봉투
  acceleration: Acceleration
  interpreter?: InterpreterRef
}

// ── probe 입력(adapter 경계) ───────────────────────────────────────────────────
export interface PackageProbe {
  import: string
  pip: string
  installed: boolean
  version?: string
  requiredVersion?: string
  versionSatisfied?: boolean      // 제약 판정은 production/adapter가 수행(evaluator는 결과만 소비)
}

export interface PipCheckProbe {
  ran: boolean
  fatalConflicts: number
  warningConflicts: number
}

export interface InterpreterProbe {
  id: string
  present: boolean
  isVenv?: boolean
  pythonVersion?: string
  minPythonVersion?: string
  pythonVersionSatisfied?: boolean
  architecture?: string
  architectureOk?: boolean
  packages: PackageProbe[]
  pipCheck?: PipCheckProbe
  fingerprint?: RuntimeFingerprint           // 현재 지문(digest 비교로 drift 판정)
  expectedFingerprint?: RuntimeFingerprint    // attach 시점 baseline(빌린 환경 drift)
}

export interface ModelProbe {
  present: boolean
  expectedChecksum?: string
  actualChecksum?: string
}

export interface SystemProbe {
  ffmpeg: boolean
  gpu: { cudaAvailable: boolean; device?: string }
}

export interface CapabilityProbe {
  probeVersion: string
  observedAt: string
  interpreters: Record<string, InterpreterProbe>
  models: Record<string, ModelProbe>
  system: SystemProbe
}

// ── capability 요구 스펙 (capability 축; env_check import 이름과 정렬) ──────────────
// env_check.REQUIRED의 tier 축(core/tts/hub)이 아니라 capability 축이다. 패키지 설치·버전
// 단일 소스는 여전히 probe(어댑터가 env_check --json에서 채움)이며 여기선 관계만 선언한다.
export interface CapabilityRequirement {
  capability: CapabilityId
  interpreterKey?: string
  requiredImports?: string[]
  modelKey?: string
  gpuEligible?: boolean
  system?: 'ffmpeg' | 'gpu'
}

export interface EvaluateOptions {
  now?: number
  expectedProbeVersion?: string
  maxAgeMs?: number
}

// ── helpers ────────────────────────────────────────────────────────────────────

// 실패 reasonCode → status 축. version/architecture 불일치는 incompatible, 그 외는 unavailable.
// (계약의 *_INCOMPATIBLE 코드가 CapabilityStatus 'incompatible'와 대응한다.)
function statusForReason(rc: ReasonCode | null): CapabilityStatus {
  if (rc === 'PYTHON_VERSION_INCOMPATIBLE' || rc === 'ARCHITECTURE_INCOMPATIBLE' || rc === 'PACKAGE_VERSION_INCOMPATIBLE') {
    return 'incompatible'
  }
  return 'unavailable'
}

// dot-구분 버전 비교. a >= b 이면 true.
function versionGte(a: string, b: string): boolean {
  const pa = a.split('.').map((s) => parseInt(s, 10) || 0)
  const pb = b.split('.').map((s) => parseInt(s, 10) || 0)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x > y) return true
    if (x < y) return false
  }
  return true
}

// 시스템(인터프리터 없음) capability용 최소 지문. 경로·사용자명 없음(계약 §3·§5).
function systemFingerprint(probe: CapabilityProbe, digest: string): RuntimeFingerprint {
  return makeRuntimeFingerprint({
    digest,
    pythonVersion: '',
    architecture: '',
    lockHash: null,
    probeVersion: probe.probeVersion,
    packageCount: 0,
  })
}

// 증거 항목 빌더 — 계약 ValidationEvidenceItem + 내부 severity를 함께 만든다.
interface BuiltItem {
  ev: ValidationEvidenceItem
  severity: Severity
  singleton?: 'import' | 'package' | 'architecture' | 'gpu'
  bucket?: 'model' | 'tool'
}

function mk(
  kind: EvidenceKind,
  severity: Severity,
  reasonCode: ReasonCode | null,
  opts: {
    observedVersion?: string | null
    requiredVersion?: string | null
    singleton?: BuiltItem['singleton']
    bucket?: BuiltItem['bucket']
  } = {},
): BuiltItem {
  const status: CapabilityStatus = severity === 'fatal' ? statusForReason(reasonCode) : 'supported'
  const item: BuiltItem = {
    ev: {
      kind,
      status,
      reasonCode,
      observedVersion: opts.observedVersion ?? null,
      requiredVersion: opts.requiredVersion ?? null,
    },
    severity,
  }
  if (opts.singleton) item.singleton = opts.singleton
  if (opts.bucket) item.bucket = opts.bucket
  return item
}

// BuiltItem[] → ValidationEvidence 봉투(계약 구조). singleton/bucket 지정으로 필드 배치.
function buildEvidence(probe: CapabilityProbe, fingerprint: RuntimeFingerprint, built: BuiltItem[]): ValidationEvidence {
  const checks = built.map((b) => b.ev)
  const singleton = (name: BuiltItem['singleton']) => built.find((b) => b.singleton === name)?.ev ?? null
  return {
    observedAt: probe.observedAt,
    probeVersion: probe.probeVersion,
    fingerprint,
    checks,
    packageCheck: singleton('package'),
    architectureCheck: singleton('architecture'),
    importCheck: singleton('import'),
    gpuCheck: singleton('gpu'),
    modelChecks: built.filter((b) => b.bucket === 'model').map((b) => b.ev),
    toolChecks: built.filter((b) => b.bucket === 'tool').map((b) => b.ev),
  }
}

// BuiltItem[](push 순 = fatal 우선순위)에서 3축 상태 도출.
//   첫 fatal → 해당 reasonCode의 status·full. 첫 warning → supported·degraded. 없으면 supported·full.
function deriveState(built: BuiltItem[]): CapabilityState {
  const fatal = built.find((b) => b.severity === 'fatal')
  if (fatal) {
    return {
      status: statusForReason(fatal.ev.reasonCode),
      freshness: 'current',
      supportLevel: 'full',
      reasonCode: fatal.ev.reasonCode,
    }
  }
  const warn = built.find((b) => b.severity === 'warning')
  if (warn) {
    if (warn.ev.reasonCode === 'CPU_FALLBACK_AVAILABLE') return makeCpuFallbackCapabilityState()
    return { status: 'supported', freshness: 'current', supportLevel: 'degraded', reasonCode: warn.ev.reasonCode }
  }
  return makeSupportedCapabilityState()
}

// stale 판정 — probeVersion 불일치 또는 maxAge 초과.
function isStale(probe: CapabilityProbe, opts: EvaluateOptions): boolean {
  if (opts.expectedProbeVersion !== undefined && probe.probeVersion !== opts.expectedProbeVersion) return true
  if (opts.maxAgeMs !== undefined) {
    const now = opts.now ?? Date.now()
    const observed = Date.parse(probe.observedAt)
    if (!Number.isNaN(observed) && now - observed > opts.maxAgeMs) return true
  }
  return false
}

// ── 핵심: capability 1개 판정 (순수) ─────────────────────────────────────────────
export function evaluateCapability(
  req: CapabilityRequirement,
  probe: CapabilityProbe,
  opts: EvaluateOptions = {},
): CapabilityEvaluation {
  // stale 우선 — 무효 스냅샷은 status=unverified(과거 supported 재사용 금지). 증거는 재검증 필요 신호로 비운다.
  if (isStale(probe, opts)) {
    return {
      capability: req.capability,
      state: makeStaleCapabilityState('EVIDENCE_STALE'),
      evidence: buildEvidence(probe, systemFingerprint(probe, 'stale'), []),
      acceleration: { gpuAvailable: false, cpuFallback: false },
    }
  }

  // ── system-only capability: ffmpeg / gpu ──
  if (req.system === 'ffmpeg') {
    const ok = probe.system.ffmpeg
    const built = [mk('tool', ok ? 'ok' : 'fatal', ok ? null : 'TOOL_MISSING', { bucket: 'tool' })]
    return {
      capability: req.capability,
      state: deriveState(built),
      evidence: buildEvidence(probe, systemFingerprint(probe, 'system'), built),
      acceleration: { gpuAvailable: false, cpuFallback: false },
    }
  }
  if (req.system === 'gpu') {
    const ok = probe.system.gpu.cudaAvailable
    // GPU capability 자체는 CUDA 없으면 unavailable. 이는 다른 연산 capability의 CPU 가용성과 무관.
    const built = [mk('gpu', ok ? 'ok' : 'fatal', ok ? null : 'GPU_UNAVAILABLE', {
      singleton: 'gpu',
      observedVersion: ok ? (probe.system.gpu.device ?? null) : null,
    })]
    return {
      capability: req.capability,
      state: deriveState(built),
      evidence: buildEvidence(probe, systemFingerprint(probe, 'system'), built),
      acceleration: { gpuAvailable: ok, cpuFallback: false },
    }
  }

  // ── 인터프리터 기반 capability ──
  const interp = req.interpreterKey ? probe.interpreters[req.interpreterKey] : undefined

  // 인터프리터/venv 존재 — 없으면 여기서 종료(뒤 검사는 무의미). venv 없음 vs interpreter 없음 구분.
  if (interp === undefined || !interp.present) {
    const isVenv = interp?.isVenv ?? req.interpreterKey !== 'parent'
    const code: ReasonCode = isVenv ? 'VENV_MISSING' : 'INTERPRETER_NOT_FOUND'
    const built = [mk('venv', 'fatal', code)]
    return {
      capability: req.capability,
      state: deriveState(built),
      evidence: buildEvidence(probe, interp?.fingerprint ?? systemFingerprint(probe, 'none'), built),
      acceleration: { gpuAvailable: false, cpuFallback: false },
      interpreter: interp ? { id: interp.id, pythonVersion: interp.pythonVersion, fingerprint: interp.fingerprint } : undefined,
    }
  }

  const built: BuiltItem[] = []
  built.push(mk('venv', 'ok', null))

  // drift(빌린 환경): baseline digest ≠ 현재 digest. 두 지문이 모두 있을 때만 판정.
  if (interp.expectedFingerprint !== undefined && interp.fingerprint !== undefined) {
    const match = interp.expectedFingerprint.digest === interp.fingerprint.digest
    built.push(mk('package', match ? 'ok' : 'fatal', match ? null : 'PACKAGE_DRIFT'))
  }

  // python 버전(패키지와 분리된 별도 증거)
  if (interp.pythonVersionSatisfied !== undefined || (interp.minPythonVersion && interp.pythonVersion)) {
    const ok = interp.pythonVersionSatisfied ??
      (interp.pythonVersion && interp.minPythonVersion ? versionGte(interp.pythonVersion, interp.minPythonVersion) : true)
    built.push(mk('python-version', ok ? 'ok' : 'fatal', ok ? null : 'PYTHON_VERSION_INCOMPATIBLE', {
      observedVersion: interp.pythonVersion ?? null,
      requiredVersion: interp.minPythonVersion ?? null,
    }))
  }

  // 아키텍처(예: CUDA 빌드 기대 vs CPU torch) — 별도 증거
  if (interp.architectureOk !== undefined) {
    built.push(mk('architecture', interp.architectureOk ? 'ok' : 'fatal', interp.architectureOk ? null : 'ARCHITECTURE_INCOMPATIBLE', {
      singleton: 'architecture',
      observedVersion: interp.architecture ?? null,
    }))
  }

  // 패키지: import(존재)와 version(제약)을 분리한다.
  const needed = req.requiredImports ?? []
  if (needed.length > 0) {
    const byImport = new Map(interp.packages.map((p) => [p.import, p]))
    const missing: string[] = []
    const versionBad: string[] = []
    for (const imp of needed) {
      const p = byImport.get(imp)
      if (!p || !p.installed) { missing.push(imp); continue }
      if (p.versionSatisfied === false) versionBad.push(imp)
    }
    const importOk = missing.length === 0
    built.push(mk('import', importOk ? 'ok' : 'fatal', importOk ? null : 'PACKAGE_MISSING', { singleton: 'import' }))
    if (importOk) {
      const versionOk = versionBad.length === 0
      built.push(mk('package', versionOk ? 'ok' : 'fatal', versionOk ? null : 'PACKAGE_VERSION_INCOMPATIBLE', { singleton: 'package' }))
    }
  }

  // pip check: fatal vs warning — 계약은 단일 PIP_CHECK_FAILED. fatal은 status 축, warning은 supportLevel 축으로 구분.
  if (interp.pipCheck && interp.pipCheck.ran) {
    const pc = interp.pipCheck
    if (pc.fatalConflicts > 0) built.push(mk('pip-check', 'fatal', 'PIP_CHECK_FAILED'))
    else if (pc.warningConflicts > 0) built.push(mk('pip-check', 'warning', 'PIP_CHECK_FAILED'))
    else built.push(mk('pip-check', 'ok', null))
  }

  // 모델: 존재(model)와 지문(checksum) 분리. venv 없음(위)과도 구분.
  if (req.modelKey) {
    const m = probe.models[req.modelKey]
    if (!m || !m.present) {
      built.push(mk('model', 'fatal', 'MODEL_MISSING', { bucket: 'model' }))
    } else {
      built.push(mk('model', 'ok', null, { bucket: 'model' }))
      if (m.expectedChecksum !== undefined && m.actualChecksum !== undefined) {
        const match = m.expectedChecksum === m.actualChecksum
        built.push(mk('model', match ? 'ok' : 'fatal', match ? null : 'MODEL_CHECKSUM_MISMATCH', { bucket: 'model' }))
      }
    }
  }

  // GPU/CPU 분리: 연산 capability는 GPU가 없어도 CPU로 실행 가능. GPU 부재는 fatal이 아니라
  // warning(CPU_FALLBACK_AVAILABLE) → supportLevel=degraded(status=supported 유지). 전체 unavailable 금지.
  const cuda = probe.system.gpu.cudaAvailable
  const gpuEligible = req.gpuEligible ?? false
  const acceleration: Acceleration = { gpuAvailable: gpuEligible && cuda, cpuFallback: true }
  if (gpuEligible && !cuda) {
    built.push(mk('gpu', 'warning', 'CPU_FALLBACK_AVAILABLE', { singleton: 'gpu' }))
  }

  const fingerprint = interp.fingerprint ?? systemFingerprint(probe, 'none')
  return {
    capability: req.capability,
    state: deriveState(built),
    evidence: buildEvidence(probe, fingerprint, built),
    acceleration,
    interpreter: { id: interp.id, pythonVersion: interp.pythonVersion, fingerprint: interp.fingerprint },
  }
}

// ── 여러 capability 일괄 판정 ────────────────────────────────────────────────────
// ★ 한 capability 실패가 다른 capability를 unavailable로 만들지 않는다 — 각각 독립 판정.
//   전체를 한 번에 죽이는 단일 killswitch는 의도적으로 두지 않는다.
export function evaluateSnapshotSet(
  reqs: CapabilityRequirement[],
  probe: CapabilityProbe,
  opts: EvaluateOptions = {},
): Record<CapabilityId, CapabilityEvaluation> {
  const out = {} as Record<CapabilityId, CapabilityEvaluation>
  for (const req of reqs) out[req.capability] = evaluateCapability(req, probe, opts)
  return out
}

// capability를 실제로 쓸 수 있는지 — 계약 3축상 status==='supported'만 usable(full·degraded 포함).
// unverified(=stale)·unavailable·incompatible·unsupported는 false → stale 재사용 차단.
export function isUsable(e: CapabilityEvaluation): boolean {
  return e.state.status === 'supported'
}

// ── 기본 capability 요구 스펙 (capability 축; env_check import 이름과 정렬) ──────────
// reconcile 주의: 패키지 설치·버전 단일 소스는 env_check.REQUIRED(→ probe)다.
export const DEFAULT_REQUIREMENTS: CapabilityRequirement[] = [
  { capability: 'corePython', interpreterKey: 'parent', requiredImports: ['torch', 'numpy', 'soundfile'] },
  { capability: 'music', interpreterKey: 'parent', requiredImports: ['demucs', 'audio_separator', 'onnxruntime'], gpuEligible: true },
  { capability: 'dialogue', interpreterKey: 'parent', requiredImports: ['speechbrain'], gpuEligible: true },
  { capability: 'asr', interpreterKey: 'parent', requiredImports: ['whisper'], gpuEligible: true },
  { capability: 'pitch', interpreterKey: 'parent', requiredImports: ['torch'], gpuEligible: false },
  { capability: 'qwen', interpreterKey: 'qwen', requiredImports: ['qwen_tts'], modelKey: 'qwen3', gpuEligible: true },
  { capability: 'gptSovits', interpreterKey: 'gptsovits', requiredImports: ['GPT_SoVITS'], modelKey: 'gptsovits-v2', gpuEligible: true },
  { capability: 'ffmpeg', system: 'ffmpeg' },
  { capability: 'gpu', system: 'gpu' },
]

// ── env_check --json → probe 어댑터 경계 ────────────────────────────────────────
// env_check.collect() 출력의 (부분)형태. env_check를 수정하지 않고 읽기만 하며, 이 함수가
// parent InterpreterProbe로 매핑한다. env_check가 제공 안 하는 축(pip check / architecture /
// fingerprint / 격리 venv / 모델 checksum)은 undefined로 남는다 → evaluator가 "그 축 검사 없음"으로
// 처리(누락을 fatal로 오판 안 함). id·digest·probeVersion은 통합 담당(production)이 주입한다.
export interface EnvCheckJson {
  python?: string
  python_version?: string
  packages?: Array<{ pip: string; import: string; installed: boolean; version?: string; tier?: string }>
  ffmpeg?: boolean
  cuda?: { available: boolean; device?: string | null; torch?: string | null }
}

export function interpreterProbeFromEnvCheck(
  json: EnvCheckJson,
  meta: {
    id: string
    probeVersion: string
    digest?: string
    expectedDigest?: string
    architecture?: string
    minPythonVersion?: string
  },
): InterpreterProbe {
  const packages: PackageProbe[] = (json.packages ?? []).map((p) => ({
    import: p.import,
    pip: p.pip,
    installed: p.installed,
    version: p.version || undefined,
  }))
  const fpFields = {
    pythonVersion: json.python_version ?? '',
    architecture: meta.architecture ?? '',
    lockHash: null as string | null,
    probeVersion: meta.probeVersion,
    packageCount: packages.length,
  }
  const probe: InterpreterProbe = {
    id: meta.id,
    present: true, // env_check가 돌았다는 것 자체가 인터프리터 존재의 증거
    isVenv: false,
    pythonVersion: json.python_version,
    packages,
  }
  if (meta.minPythonVersion !== undefined) probe.minPythonVersion = meta.minPythonVersion
  if (meta.digest !== undefined) probe.fingerprint = makeRuntimeFingerprint({ digest: meta.digest, ...fpFields })
  if (meta.expectedDigest !== undefined) probe.expectedFingerprint = makeRuntimeFingerprint({ digest: meta.expectedDigest, ...fpFields })
  return probe
}

export function systemProbeFromEnvCheck(json: EnvCheckJson): SystemProbe {
  return {
    ffmpeg: !!json.ffmpeg,
    gpu: { cudaAvailable: !!json.cuda?.available, device: json.cuda?.device ?? undefined },
  }
}
