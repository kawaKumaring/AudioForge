// 순수 capability evaluator — probe 결과(증거)를 소비해 capability별 독립 판정을 만든다.
//
// 목적/경계:
//   - 이 모듈은 부수효과·I/O·서브프로세스가 전혀 없다. 입력은 "probe 결과"(누군가 이미
//     측정해 넘긴 증거)뿐이고, 출력은 capability별 CapabilitySnapshot이다.
//     실제 측정(env_check.py --json 실행, venv 존재 확인, checksum 계산 등)은 production이
//     하고, 이 evaluator는 그 결과를 *해석*만 한다.
//   - production(audio.ipc.ts / setup_env.py / python/env_check.py)은 수정하지 않는다.
//     특히 env_check.REQUIRED(패키지 설치·버전의 단일 소스)를 여기서 다시 정의하지 않는다.
//     대신 아래 `CapabilityProbe`가 **adapter 경계**다 — env_check --json 출력은
//     `fromEnvCheckJson()`이 이 형태로 매핑해 넣는다(evaluator는 매핑된 증거만 본다).
//
// 자립성/reconcile:
//   계약 타입(CapabilitySnapshot 등)은 R2-A에서 확정될 예정이나 아직 없으므로 여기서
//   자체 정의한다. 필드는 R2-A와 구조 정렬을 의도했다. R2-A 도착 시 reconcile 지점:
//     - ReasonCode enum 값 집합 (여기 정의가 canonical 후보)
//     - CapabilitySnapshot 필드명(status/reason/evidence/acceleration/observedAt/
//       probeVersion/packageFingerprint)
//     - Capability id 목록
//   차이가 나면 이 파일이 adapter를 하나 더 두고 R2-A 타입으로 변환한다(production 불변 유지).

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

// ── 고정 reason code (traceback·전체 경로 없음, 짧은 안정 식별자만) ──────────────
export type ReasonCode =
  | 'OK'
  | 'PYTHON_MISSING'                // 인터프리터 자체 없음(base python)
  | 'VENV_MISSING'                  // 격리 venv 없음(qwen/gptsovits) — 모델 없음과 구분
  | 'PYTHON_VERSION_UNSUPPORTED'    // python 버전 미충족(패키지와 무관한 별도 증거)
  | 'ARCH_MISMATCH'                 // 아키텍처 불일치(예: CPU torch인데 CUDA 빌드 기대)
  | 'PACKAGE_MISSING'               // import 실패
  | 'PACKAGE_VERSION_MISMATCH'      // import 되나 버전 제약 미충족
  | 'PIP_CHECK_FATAL'              // pip check 의존성 충돌(치명) — 사용 불가
  | 'PIP_CHECK_WARNING'            // pip check 경고(비치명) — 사용 가능하나 degraded
  | 'MODEL_MISSING'                 // 모델 파일 없음 — venv 없음/checksum 불일치와 구분
  | 'CHECKSUM_MISMATCH'             // 모델 파일 있으나 지문 불일치
  | 'FFMPEG_MISSING'                // ffmpeg/ffprobe 없음
  | 'GPU_UNAVAILABLE'               // CUDA 없음 — 이것만으로 CPU 불가가 아님(별도 필드)
  | 'ENV_DRIFT'                     // 빌린 환경 지문 불일치(attach 시점 대비 변경)
  | 'STALE_SNAPSHOT'                // 스냅샷 무효(probeVersion/observedAt) — supported 재사용 금지
  | 'UNKNOWN'

export type Severity = 'ok' | 'warning' | 'fatal'

// capability 사용 가능성. stale/unsupported는 usable 아님(아래 isUsable).
export type CapabilityStatus = 'supported' | 'degraded' | 'unsupported' | 'stale'

// 증거 한 조각 — 항목별로 분리 보관(하나가 fatal이어도 나머지 증거는 그대로 남는다).
export interface EvidenceItem {
  ok: boolean
  severity: Severity
  code: ReasonCode
  // 비민감 요약만. 전체 경로·traceback 금지. (예: "torch", "1.13.0", "cuda", "3.9<3.10")
  detail?: string
}

// ValidationEvidence — 증거를 성격별로 분리한다(import·version·pip-check·arch·python version 등).
// undefined = "해당 capability에 그 축의 검사가 없음"(예: ffmpeg엔 packageImport 없음).
export interface ValidationEvidence {
  interpreter?: EvidenceItem   // 인터프리터/venv 존재
  pythonVersion?: EvidenceItem // python 버전
  architecture?: EvidenceItem  // 아키텍처(CUDA 빌드 등)
  packageImport?: EvidenceItem // import 가능 여부
  packageVersion?: EvidenceItem// 버전 제약
  pipCheck?: EvidenceItem      // pip check(의존성 resolver)
  model?: EvidenceItem         // 모델 파일 존재
  checksum?: EvidenceItem      // 모델 지문 일치
  drift?: EvidenceItem         // 빌린 환경 지문 drift
  system?: EvidenceItem        // 시스템 자원(ffmpeg/gpu)
}

// GPU와 CPU를 분리 — "GPU 없음"이 "CPU 불가"를 의미하지 않는다.
export interface Acceleration {
  gpuAvailable: boolean  // CUDA 사용 가능?
  cpuFallback: boolean   // CPU로 실행 가능? (연산 capability는 대개 true)
}

// 어느 인터프리터로 판정했는지 — qwen venv와 parent python은 서로 다른 id/지문을 가진다.
export interface InterpreterRef {
  id: string                 // 안정 식별자(경로 자체가 아님 — 호출자가 부여). 예: "parent", "qwen-venv"
  pythonVersion?: string
  fingerprint?: string       // 이 인터프리터 환경의 packageFingerprint
}

export interface CapabilitySnapshot {
  capability: CapabilityId
  status: CapabilityStatus
  reason: ReasonCode          // 대표 사유(첫 fatal, 없으면 첫 warning, 없으면 OK)
  evidence: ValidationEvidence
  acceleration: Acceleration
  interpreter?: InterpreterRef
  observedAt: string          // probe가 측정된 시각(ISO). now가 아니라 측정 시각.
  probeVersion: string
  packageFingerprint: string  // 재현성/드리프트 추적용(인터프리터 지문 또는 'system'/'none')
  warnings: ReasonCode[]      // 비치명 사유(pip warning, GPU 없음 등)
}

// ── probe 입력(adapter 경계) ───────────────────────────────────────────────────
// production이 측정해 넘기는 형태. env_check --json은 fromEnvCheckJson()이 여기로 매핑한다.

export interface PackageProbe {
  import: string              // import 이름(env_check의 import 이름과 정렬)
  pip: string                 // pip 이름
  installed: boolean
  version?: string
  requiredVersion?: string    // 버전 제약(선택). satisfies=false면 mismatch.
  versionSatisfied?: boolean  // 제약 판정은 production/adapter가 수행(evaluator는 결과만 소비)
}

export interface PipCheckProbe {
  ran: boolean
  // pip check 결과를 fatal/warning으로 분류(개수만, 문장/경로 없음).
  fatalConflicts: number
  warningConflicts: number
}

export interface InterpreterProbe {
  id: string
  present: boolean            // 인터프리터 실행파일 존재
  isVenv?: boolean            // 격리 venv 여부(없을 때 VENV_MISSING vs PYTHON_MISSING 구분)
  pythonVersion?: string
  minPythonVersion?: string   // 요구 최소 버전(선택)
  pythonVersionSatisfied?: boolean
  architecture?: string       // 예: 'cuda-cu124', 'cpu'
  architectureOk?: boolean    // 기대 아키텍처 충족?(선택 — 미지정이면 검사 안 함)
  packages: PackageProbe[]
  pipCheck?: PipCheckProbe
  fingerprint?: string        // 현재 패키지 지문
  expectedFingerprint?: string// attach 시점 baseline(빌린 환경 drift 감지용)
}

export interface ModelProbe {
  present: boolean            // 필수 파일 전부 존재(size>0 등은 production이 판정)
  expectedChecksum?: string
  actualChecksum?: string
}

export interface SystemProbe {
  ffmpeg: boolean
  gpu: { cudaAvailable: boolean; device?: string }
}

export interface CapabilityProbe {
  probeVersion: string
  observedAt: string          // ISO 시각
  interpreters: Record<string, InterpreterProbe>
  models: Record<string, ModelProbe>
  system: SystemProbe
}

// ── capability 요구 스펙 ────────────────────────────────────────────────────────
// 어떤 인터프리터 / 어떤 import / 어떤 모델 / GPU 적격 여부를 선언한다.
// 이 스펙은 env_check.REQUIRED의 *tier* 축(core/tts/hub)이 아니라 *capability* 축이다.
// 패키지 설치·버전의 단일 소스는 여전히 probe(어댑터가 env_check --json에서 채움)이며,
// 여기서는 "어떤 import가 어떤 capability에 필요한지"의 관계만 선언한다.
// R2-A 확정 시 이 매핑을 R2-A 스펙과 reconcile한다.
export interface CapabilityRequirement {
  capability: CapabilityId
  interpreterKey?: string       // probe.interpreters의 키. system-only(ffmpeg/gpu)면 생략.
  requiredImports?: string[]    // 이 capability가 필요로 하는 import 이름(부분집합)
  modelKey?: string             // probe.models의 키(선택)
  gpuEligible?: boolean         // GPU 가속 대상? (없으면 CPU 전용으로 간주)
  system?: 'ffmpeg' | 'gpu'     // 시스템 자원 capability
}

export interface EvaluateOptions {
  now?: number                  // 현재 시각(ms). 기본 Date.now(). staleness 계산용.
  expectedProbeVersion?: string // 이 값과 probe.probeVersion 불일치 → stale
  maxAgeMs?: number             // observedAt이 이보다 오래됨 → stale
}

// ── helpers ────────────────────────────────────────────────────────────────────

function ev(ok: boolean, severity: Severity, code: ReasonCode, detail?: string): EvidenceItem {
  return detail === undefined ? { ok, severity, code } : { ok, severity, code, detail }
}

// dot-구분 버전 비교. a >= b 이면 true. 파싱 불가 세그먼트는 0 취급.
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

// 대표 reason 선택: 첫 fatal → 없으면 첫 warning → 없으면 OK.
function pickReason(items: EvidenceItem[]): { reason: ReasonCode; hasFatal: boolean; warnings: ReasonCode[] } {
  const warnings: ReasonCode[] = []
  let firstWarning: ReasonCode | null = null
  for (const it of items) {
    if (it.severity === 'fatal') {
      return { reason: it.code, hasFatal: true, warnings }
    }
    if (it.severity === 'warning') {
      warnings.push(it.code)
      if (firstWarning === null) firstWarning = it.code
    }
  }
  return { reason: firstWarning ?? 'OK', hasFatal: false, warnings }
}

// staleness 판정 — 무효면 stale 스냅샷을 반환(그 외 증거는 채우지 않는다: 재측정 필요 신호).
function staleReason(probe: CapabilityProbe, opts: EvaluateOptions): boolean {
  if (opts.expectedProbeVersion !== undefined && probe.probeVersion !== opts.expectedProbeVersion) {
    return true
  }
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
): CapabilitySnapshot {
  const base = {
    capability: req.capability,
    observedAt: probe.observedAt,
    probeVersion: probe.probeVersion,
  }

  // stale 우선 — 무효 스냅샷은 어떤 증거도 supported로 재사용하지 않는다.
  if (staleReason(probe, opts)) {
    return {
      ...base,
      status: 'stale',
      reason: 'STALE_SNAPSHOT',
      evidence: {},
      acceleration: { gpuAvailable: false, cpuFallback: false },
      packageFingerprint: 'stale',
      warnings: ['STALE_SNAPSHOT'],
    }
  }

  // ── system-only capability: ffmpeg / gpu ──
  if (req.system === 'ffmpeg') {
    const ok = probe.system.ffmpeg
    const item = ev(ok, ok ? 'ok' : 'fatal', ok ? 'OK' : 'FFMPEG_MISSING')
    return {
      ...base,
      status: ok ? 'supported' : 'unsupported',
      reason: item.code,
      evidence: { system: item },
      acceleration: { gpuAvailable: false, cpuFallback: false },
      packageFingerprint: 'system',
      warnings: [],
    }
  }
  if (req.system === 'gpu') {
    const ok = probe.system.gpu.cudaAvailable
    // GPU capability 자체는 CUDA 없으면 unsupported. 단 이건 다른 연산 capability의
    // CPU 가용성과 무관하다(별도 capability·별도 필드).
    const item = ev(ok, ok ? 'ok' : 'fatal', ok ? 'OK' : 'GPU_UNAVAILABLE',
      ok ? probe.system.gpu.device : 'cpu')
    return {
      ...base,
      status: ok ? 'supported' : 'unsupported',
      reason: item.code,
      evidence: { system: item },
      acceleration: { gpuAvailable: ok, cpuFallback: false },
      packageFingerprint: 'system',
      warnings: [],
    }
  }

  // ── 인터프리터 기반 capability ──
  const evidence: ValidationEvidence = {}
  const interp = req.interpreterKey ? probe.interpreters[req.interpreterKey] : undefined

  // 인터프리터/venv 존재
  if (interp === undefined || !interp.present) {
    const isVenv = interp?.isVenv ?? req.interpreterKey !== 'parent'
    const code: ReasonCode = isVenv ? 'VENV_MISSING' : 'PYTHON_MISSING'
    evidence.interpreter = ev(false, 'fatal', code, req.interpreterKey)
    return {
      ...base,
      status: 'unsupported',
      reason: code,
      evidence,
      acceleration: { gpuAvailable: false, cpuFallback: false },
      interpreter: interp ? { id: interp.id, pythonVersion: interp.pythonVersion, fingerprint: interp.fingerprint } : undefined,
      packageFingerprint: interp?.fingerprint ?? 'none',
      warnings: [],
    }
  }
  evidence.interpreter = ev(true, 'ok', 'OK', interp.id)

  const interpRef: InterpreterRef = {
    id: interp.id,
    pythonVersion: interp.pythonVersion,
    fingerprint: interp.fingerprint,
  }

  // drift(빌린 환경): baseline 지문과 현재 지문 불일치. 두 값이 모두 있을 때만 판정.
  if (interp.expectedFingerprint !== undefined && interp.fingerprint !== undefined) {
    const match = interp.expectedFingerprint === interp.fingerprint
    evidence.drift = ev(match, match ? 'ok' : 'fatal', match ? 'OK' : 'ENV_DRIFT')
  }

  // python 버전(패키지와 분리된 별도 증거)
  if (interp.pythonVersionSatisfied !== undefined || (interp.minPythonVersion && interp.pythonVersion)) {
    const ok = interp.pythonVersionSatisfied ??
      (interp.pythonVersion && interp.minPythonVersion
        ? versionGte(interp.pythonVersion, interp.minPythonVersion)
        : true)
    evidence.pythonVersion = ev(ok, ok ? 'ok' : 'fatal', ok ? 'OK' : 'PYTHON_VERSION_UNSUPPORTED',
      ok ? undefined : `${interp.pythonVersion}<${interp.minPythonVersion}`)
  }

  // 아키텍처(예: CUDA 빌드 기대 vs CPU torch) — 별도 증거
  if (interp.architectureOk !== undefined) {
    evidence.architecture = ev(interp.architectureOk, interp.architectureOk ? 'ok' : 'fatal',
      interp.architectureOk ? 'OK' : 'ARCH_MISMATCH', interp.architecture)
  }

  // 패키지: import(존재) 증거와 version(제약) 증거를 분리한다.
  const needed = req.requiredImports ?? []
  const byImport = new Map(interp.packages.map((p) => [p.import, p]))
  const missing: string[] = []
  const versionBad: string[] = []
  for (const imp of needed) {
    const p = byImport.get(imp)
    if (!p || !p.installed) {
      missing.push(imp)
      continue
    }
    if (p.versionSatisfied === false) versionBad.push(imp)
  }
  if (needed.length > 0) {
    const importOk = missing.length === 0
    evidence.packageImport = ev(importOk, importOk ? 'ok' : 'fatal', importOk ? 'OK' : 'PACKAGE_MISSING',
      importOk ? undefined : missing.join(','))
    // version 증거는 import가 된 패키지에 한해 의미가 있다(분리).
    if (importOk) {
      const versionOk = versionBad.length === 0
      evidence.packageVersion = ev(versionOk, versionOk ? 'ok' : 'fatal', versionOk ? 'OK' : 'PACKAGE_VERSION_MISMATCH',
        versionOk ? undefined : versionBad.join(','))
    }
  }

  // pip check: fatal vs warning 구분
  if (interp.pipCheck && interp.pipCheck.ran) {
    const pc = interp.pipCheck
    if (pc.fatalConflicts > 0) {
      evidence.pipCheck = ev(false, 'fatal', 'PIP_CHECK_FATAL', String(pc.fatalConflicts))
    } else if (pc.warningConflicts > 0) {
      evidence.pipCheck = ev(false, 'warning', 'PIP_CHECK_WARNING', String(pc.warningConflicts))
    } else {
      evidence.pipCheck = ev(true, 'ok', 'OK')
    }
  }

  // 모델: 존재(model)와 지문(checksum)을 분리. venv 없음(위)과도 구분됨.
  if (req.modelKey) {
    const m = probe.models[req.modelKey]
    if (!m || !m.present) {
      evidence.model = ev(false, 'fatal', 'MODEL_MISSING', req.modelKey)
    } else {
      evidence.model = ev(true, 'ok', 'OK', req.modelKey)
      if (m.expectedChecksum !== undefined && m.actualChecksum !== undefined) {
        const match = m.expectedChecksum === m.actualChecksum
        evidence.checksum = ev(match, match ? 'ok' : 'fatal', match ? 'OK' : 'CHECKSUM_MISMATCH')
      }
    }
  }

  // GPU/CPU 분리: 연산 capability는 GPU가 없어도 CPU로 실행 가능(cpuFallback=true).
  // GPU 부재는 fatal이 아니라 warning(GPU_UNAVAILABLE) — 전체 unavailable 유발 금지.
  const gpuAvailable = probe.system.gpu.cudaAvailable
  const gpuEligible = req.gpuEligible ?? false
  const acceleration: Acceleration = { gpuAvailable: gpuEligible && gpuAvailable, cpuFallback: true }
  if (gpuEligible && !gpuAvailable) {
    evidence.system = ev(false, 'warning', 'GPU_UNAVAILABLE', 'cpu-fallback')
  }

  // 대표 reason + status 결정
  const items = Object.values(evidence).filter((x): x is EvidenceItem => !!x)
  const { reason, hasFatal, warnings } = pickReason(items)
  let status: CapabilityStatus
  if (hasFatal) status = 'unsupported'
  else if (warnings.length > 0) status = 'degraded'
  else status = 'supported'

  return {
    ...base,
    status,
    reason,
    evidence,
    acceleration,
    interpreter: interpRef,
    packageFingerprint: interp.fingerprint ?? 'none',
    warnings,
  }
}

// ── 여러 capability 일괄 판정 ────────────────────────────────────────────────────
// ★ 한 capability 실패가 다른 capability를 unavailable로 만들지 않는다 — 각각 독립 판정.
//   전체를 한 번에 죽이는 단일 killswitch는 의도적으로 두지 않는다.
export function evaluateSnapshotSet(
  reqs: CapabilityRequirement[],
  probe: CapabilityProbe,
  opts: EvaluateOptions = {},
): Record<CapabilityId, CapabilitySnapshot> {
  const out = {} as Record<CapabilityId, CapabilitySnapshot>
  for (const req of reqs) {
    out[req.capability] = evaluateCapability(req, probe, opts)
  }
  return out
}

// 스냅샷이 실제로 쓸 수 있는 상태인지 — stale/unsupported는 false.
// (stale 스냅샷을 supported로 재사용하지 못하게 하는 단일 게이트.)
export function isUsable(snap: CapabilitySnapshot): boolean {
  return snap.status === 'supported' || snap.status === 'degraded'
}

// ── 기본 capability 요구 스펙 (capability 축; env_check import 이름과 정렬) ──────────
// reconcile 주의: 패키지 설치·버전의 단일 소스는 env_check.REQUIRED(→ probe)다.
// 여기 import 이름은 그 이름과 맞춘 참조일 뿐, 설치 여부를 여기서 단정하지 않는다.
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
// env_check.collect() 출력의 (부분)형태. env_check를 수정하지 않고 읽기만 하며,
// 이 함수가 그 출력을 parent InterpreterProbe로 매핑한다. env_check가 아직 제공하지 않는
// 축(pip check / architecture / expectedFingerprint / 격리 venv / 모델 checksum)은
// undefined로 남는다 → evaluator가 "그 축 검사 없음"으로 처리(누락을 fatal로 오판 안 함).
export interface EnvCheckJson {
  python?: string
  python_version?: string
  packages?: Array<{ pip: string; import: string; installed: boolean; version?: string; tier?: string }>
  ffmpeg?: boolean
  cuda?: { available: boolean; device?: string | null; torch?: string | null }
}

// env_check --json 한 판을 parent 인터프리터 probe 조각으로 매핑한다(순수).
// interpreterId·fingerprint·observedAt·probeVersion은 호출자(production)가 부여한다
// (env_check 자체엔 그 개념이 없다 — reconcile 지점).
export function interpreterProbeFromEnvCheck(
  json: EnvCheckJson,
  meta: { id: string; fingerprint?: string; expectedFingerprint?: string; minPythonVersion?: string },
): InterpreterProbe {
  const packages: PackageProbe[] = (json.packages ?? []).map((p) => ({
    import: p.import,
    pip: p.pip,
    installed: p.installed,
    version: p.version || undefined,
  }))
  const probe: InterpreterProbe = {
    id: meta.id,
    present: true, // env_check가 돌았다는 것 자체가 인터프리터 존재의 증거
    isVenv: false,
    pythonVersion: json.python_version,
    packages,
  }
  if (meta.minPythonVersion !== undefined) probe.minPythonVersion = meta.minPythonVersion
  if (meta.fingerprint !== undefined) probe.fingerprint = meta.fingerprint
  if (meta.expectedFingerprint !== undefined) probe.expectedFingerprint = meta.expectedFingerprint
  return probe
}

// env_check --json의 시스템(ffmpeg/cuda) 조각을 SystemProbe로 매핑한다(순수).
export function systemProbeFromEnvCheck(json: EnvCheckJson): SystemProbe {
  return {
    ffmpeg: !!json.ffmpeg,
    gpu: {
      cudaAvailable: !!json.cuda?.available,
      device: json.cuda?.device ?? undefined,
    },
  }
}
