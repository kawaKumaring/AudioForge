// capability evaluator용 synthetic probe fixture — 실제 probe/설치/GPU/미디어 없이 전부 주입.
// 각 fixture는 하나의 시나리오를 나타내는 CapabilityProbe다. 기준(healthy)에서 시작해
// 시나리오별로 필요한 조각만 바꾼다(그 외는 정상 유지 → capability 독립성을 그대로 검증).
import type {
  CapabilityProbe,
  InterpreterProbe,
  PackageProbe,
} from './capabilityEvaluator.ts'

const PROBE_VERSION = 'probe-v1'
const OBSERVED_AT = '2026-08-24T00:00:00.000Z'

function pkg(imp: string, pip: string, installed = true, extra: Partial<PackageProbe> = {}): PackageProbe {
  return { import: imp, pip, installed, version: installed ? '1.0.0' : undefined, ...extra }
}

// 정상 parent 인터프리터(core/music/dialogue/asr/pitch 전부 충족).
function healthyParent(): InterpreterProbe {
  return {
    id: 'parent-py-3.12',
    present: true,
    isVenv: false,
    pythonVersion: '3.12.4',
    minPythonVersion: '3.9.0',
    architecture: 'cuda-cu124',
    packages: [
      pkg('torch', 'torch'),
      pkg('numpy', 'numpy'),
      pkg('soundfile', 'soundfile'),
      pkg('demucs', 'demucs'),
      pkg('audio_separator', 'audio-separator'),
      pkg('onnxruntime', 'onnxruntime-gpu'),
      pkg('speechbrain', 'speechbrain'),
      pkg('whisper', 'openai-whisper'),
    ],
    pipCheck: { ran: true, fatalConflicts: 0, warningConflicts: 0 },
    fingerprint: 'fp-parent-abc',
    expectedFingerprint: 'fp-parent-abc', // borrowed baseline과 일치(정상)
  }
}

function healthyQwen(): InterpreterProbe {
  return {
    id: 'qwen-venv-py-3.10',
    present: true,
    isVenv: true,
    pythonVersion: '3.10.11',
    packages: [pkg('qwen_tts', 'qwen-tts')],
    pipCheck: { ran: true, fatalConflicts: 0, warningConflicts: 0 },
    fingerprint: 'fp-qwen-xyz',
  }
}

function healthyGptSovits(): InterpreterProbe {
  return {
    id: 'gptsovits-venv-py-3.10',
    present: true,
    isVenv: true,
    pythonVersion: '3.10.11',
    packages: [pkg('GPT_SoVITS', 'gpt-sovits')],
    fingerprint: 'fp-sovits-123',
  }
}

// 모든 것이 정상인 기준 probe.
export function healthyProbe(): CapabilityProbe {
  return {
    probeVersion: PROBE_VERSION,
    observedAt: OBSERVED_AT,
    interpreters: {
      parent: healthyParent(),
      qwen: healthyQwen(),
      gptsovits: healthyGptSovits(),
    },
    models: {
      qwen3: { present: true, expectedChecksum: 'ck-qwen', actualChecksum: 'ck-qwen' },
      'gptsovits-v2': { present: true, expectedChecksum: 'ck-sovits', actualChecksum: 'ck-sovits' },
    },
    system: {
      ffmpeg: true,
      gpu: { cudaAvailable: true, device: 'NVIDIA RTX' },
    },
  }
}

// 얕은 복제 헬퍼(fixture 변형용 — 원본 불변).
function clone(p: CapabilityProbe): CapabilityProbe {
  return JSON.parse(JSON.stringify(p)) as CapabilityProbe
}

export const fixtures = {
  // 1) core만 가능 — parent에 core 3종만, 나머지 패키지·venv·모델·ffmpeg 없음.
  coreOnly(): CapabilityProbe {
    const p = clone(healthyProbe())
    p.interpreters.parent.packages = [
      pkg('torch', 'torch'),
      pkg('numpy', 'numpy'),
      pkg('soundfile', 'soundfile'),
      // music/dialogue/asr 패키지 미설치
      pkg('demucs', 'demucs', false),
      pkg('audio_separator', 'audio-separator', false),
      pkg('onnxruntime', 'onnxruntime-gpu', false),
      pkg('speechbrain', 'speechbrain', false),
      pkg('whisper', 'openai-whisper', false),
    ]
    delete p.interpreters.qwen
    delete p.interpreters.gptsovits
    p.models = {}
    p.system.ffmpeg = false
    p.system.gpu = { cudaAvailable: false }
    return p
  },

  // 2) ASR만 불가 — whisper 미설치, 나머지 정상.
  asrOnlyBroken(): CapabilityProbe {
    const p = clone(healthyProbe())
    const pkgs = p.interpreters.parent.packages
    const w = pkgs.find((x) => x.import === 'whisper')!
    w.installed = false
    w.version = undefined
    return p
  },

  // 3) Qwen venv만 불가 — qwen 인터프리터 없음, 나머지 정상.
  qwenVenvMissing(): CapabilityProbe {
    const p = clone(healthyProbe())
    delete p.interpreters.qwen
    return p
  },

  // 4) FFmpeg 없음 — 시스템 ffmpeg false, 나머지 정상.
  ffmpegMissing(): CapabilityProbe {
    const p = clone(healthyProbe())
    p.system.ffmpeg = false
    return p
  },

  // 5) 모델 없음 — qwen venv·패키지는 있으나 모델 파일 없음(VENV_MISSING과 구분).
  qwenModelMissing(): CapabilityProbe {
    const p = clone(healthyProbe())
    p.models.qwen3 = { present: false }
    return p
  },

  // 6) checksum mismatch — 모델 파일은 있으나 지문 불일치.
  qwenChecksumMismatch(): CapabilityProbe {
    const p = clone(healthyProbe())
    p.models.qwen3 = { present: true, expectedChecksum: 'ck-qwen', actualChecksum: 'ck-DRIFTED' }
    return p
  },

  // 7) CUDA 없음·CPU 가능 — GPU 부재. 연산 capability는 여전히 사용 가능(CPU).
  noCudaCpuOk(): CapabilityProbe {
    const p = clone(healthyProbe())
    p.system.gpu = { cudaAvailable: false }
    return p
  },

  // 8a) pip check warning(비치명) — parent에 경고 충돌만.
  pipCheckWarning(): CapabilityProbe {
    const p = clone(healthyProbe())
    p.interpreters.parent.pipCheck = { ran: true, fatalConflicts: 0, warningConflicts: 2 }
    return p
  },

  // 8b) pip check fatal(치명) — parent에 치명 충돌.
  pipCheckFatal(): CapabilityProbe {
    const p = clone(healthyProbe())
    p.interpreters.parent.pipCheck = { ran: true, fatalConflicts: 1, warningConflicts: 0 }
    return p
  },

  // 9) external borrowed drift — parent 지문이 baseline과 불일치.
  borrowedDrift(): CapabilityProbe {
    const p = clone(healthyProbe())
    p.interpreters.parent.fingerprint = 'fp-parent-CHANGED'
    p.interpreters.parent.expectedFingerprint = 'fp-parent-abc'
    return p
  },

  // 10) 아키텍처 불일치 — torch가 CPU 빌드인데 CUDA 기대.
  archMismatch(): CapabilityProbe {
    const p = clone(healthyProbe())
    p.interpreters.parent.architecture = 'cpu'
    p.interpreters.parent.architectureOk = false
    return p
  },

  // 11) python 버전 미충족.
  pythonTooOld(): CapabilityProbe {
    const p = clone(healthyProbe())
    p.interpreters.parent.pythonVersion = '3.7.0'
    p.interpreters.parent.pythonVersionSatisfied = false
    return p
  },
}

export { PROBE_VERSION, OBSERVED_AT }
