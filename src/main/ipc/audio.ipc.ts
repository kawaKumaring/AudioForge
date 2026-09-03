import { ipcMain, dialog, BrowserWindow, shell, app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, basename, dirname, extname, resolve } from 'path'
import { randomUUID } from 'crypto'
import {
  existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync, readdirSync, statSync,
} from 'fs'
import { tmpdir } from 'os'
import { PythonRunner } from '../services/python-runner'
import { createSettlementGuard, createRunSettlement, createRunnerSlot } from '../services/run-settlement'
import type { RunEnd, RunTerminal } from '../services/run-settlement'
import { sendToWindow } from '../services/window-send'
import { createPreviewGuard, runPreview } from '../services/preview-transcribe'
import { buildTtsConfig, normalizePitchCapability, type TtsInputOptions } from '../../shared/ttsConfig'
import { sweepQwenJobDirs, listQwenJobDirs } from '../services/qwen-cleanup'
import { removeRefClipDir, sweepRefClipDirs } from '../services/refclip-cleanup'
import { removeSplitTempDirs, listSplitTempDirs } from '../services/split-temp-cleanup'
import { createSingleFlight, createKeyedSingleFlight } from '../services/single-flight'
import { createJobWatchdog, startJobWatch, createStagingGate } from '../services/longform-job'
import { createTerminalGate } from '../services/run-settlement'
import type { CancelResponse } from '../../shared/cancelContract'
import { validateSidecarEvent, SIDECAR_IPC_CHANNEL } from '../../shared/sidecarEvents'
import {
  GLOBAL_ASSET_STORAGE_KEY, VOICE_CAST_STORAGE_KEY,
} from '../../shared/emotionCandidateRegistry'
import { readSettingsFile, setSettingsKey } from '../services/settings-store'
import type { SidecarEnvelope } from '../../shared/sidecarEvents'
// 타입만 가져온다 — 참조 라이브러리 모듈을 런타임에 끌어오지 않으므로 순환 의존이 생기지 않는다.
import type { ReferencePreviewAdapter } from './reference-library.ipc'
import type { SamplerJob, SamplerRunOutcome } from '../services/sampler-generation'

// execFile(배열 인자)은 cmd.exe를 거치지 않아 시스템 코드페이지(CP949)의
// 한글 경로 손상 문제에 면역. exec(문자열)은 한글 파일명에서 깨짐 → 금지.
const execFileAsync = promisify(execFile)

// ffprobe path (winget install location)
const FFPROBE_PATHS = [
  'ffprobe',
  join(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1-full_build/bin/ffprobe.exe')
]

// AI 패키지가 설치된 Python을 참조 (의존 대상은 ComfyUI 앱이 아니라 그 패키지들).
//
// 특정 PC 의 절대경로를 코드에 두지 않는다. 그런 기본값은 그 PC 에서만 맞고 다른 PC 에서는
// 조용히 틀린 파이썬을 고르거나, 없는 경로를 찾다가 시스템 python 으로 흘러내린다.
// 연결은 '추측' 이 아니라 '기록' 이어야 한다.
//
// 우선순위: 환경변수 AUDIOFORGE_PYTHON → externals/env.json(setup_env.py 가 기록)
//           → 앱 전용 runtime(externals/runtime/runtime.json) → 시스템 python
// ComfyUI 임베디드 파이썬은 사용자가 위 경로 중 하나로 **명시 연결했을 때만** 쓰인다.
function resolvePythonPath(): string {
  const env = process.env.AUDIOFORGE_PYTHON
  if (env && existsSync(env)) return env
  try {
    const cfg = join(__dirname, '..', '..', 'externals', 'env.json')
    if (existsSync(cfg)) {
      const p = JSON.parse(readFileSync(cfg, 'utf-8')).python
      if (p && existsSync(p)) return p
    }
  } catch { /* fall through */ }
  try {
    const rt = join(__dirname, '..', '..', 'externals', 'runtime', 'runtime.json')
    if (existsSync(rt)) {
      const p = JSON.parse(readFileSync(rt, 'utf-8')).python
      if (p && existsSync(p)) return p
    }
  } catch { /* fall through */ }
  return 'python'
}

// L-6: 사용자가 고른 python 경로를 userData/settings.json에 영속화 → 재시작 후에도 유지.
// (app.getPath는 ready 이후에만 안전하므로 여기서 함수로만 정의하고 호출은 registerAudioIpc 내부에서)
function settingsFilePath(): string {
  return join(app.getPath('userData'), 'settings.json')
}
function loadSettings(): Record<string, unknown> {
  const got = readSettingsFile(settingsFilePath())
  // 손상은 빈 설정과 다르다 — 여기서는 읽기 용도라 빈 것으로 보되, 쓰기 경로가
  // 손상본을 덮어쓰지 않는다(settings-store 가 막는다).
  return got.kind === 'ok' ? got.settings : {}
}
// 원자 저장은 `services/settings-store` 가 소유한다(실패 시 기존 바이트 보존, 표적 테스트
// 로 검증). 여기서는 결과를 그대로 돌려주고 실패를 성공으로 바꾸지 않는다.
function saveSetting(key: string, value: unknown): { ok: boolean; code?: string } {
  const res = setSettingsKey(settingsFilePath(), key, value)
  if (!res.ok) console.log(`[AudioForge] 설정 저장 실패: ${res.code}`)
  return res.ok ? { ok: true } : { ok: false, code: res.code }
}
function savePythonPath(p: string): void { saveSetting('pythonPath', p) }

// 진단 사이드카 검증기를 모든 러너에 주입한다. python-runner는 Electron 없이 node --test로도
// 로드되므로 검증기를 직접 import하지 않고 주입받는다(주입을 빠뜨리면 fail-closed —
// 아무것도 전달되지 않고 unknownEventStats에만 집계된다).
const runnerDeps = { validateSidecar: validateSidecarEvent }

// 검증을 통과한 봉투만 renderer로. main에서 이미 검증했으므로 여기서 추가 정제는 하지 않는다.
function forwardSidecar(r: PythonRunner, win: BrowserWindow): void {
  r.on('sidecar', (env: SidecarEnvelope) => { sendToWindow(win, SIDECAR_IPC_CHANNEL, env) })
}

let runner: PythonRunner | null = null
// 트랙 후처리 러너 슬롯. 늦게 도착한 옛 러너의 done이 새 러너를 지우지 못하도록 신원 가드를 쓴다
// (메인 러너에는 원래 있던 보호가 여기엔 없어 고아 프로세스가 생길 수 있었다 — 감사 R3).
const trackSlot = createRunnerSlot<PythonRunner>()
let pythonPath = resolvePythonPath()

/** 분석 worker 도 **같은 인터프리터**를 쓴다(설치 상태가 갈라지지 않게).
 *  audio.ipc 가 런타임에 경로를 바꾸면 그 값을 그대로 따라간다. */
export function currentPythonPath(): string { return pythonPath }
// 취소 lifecycle(공용 마감 K/K2) 조정 상태 — audio:process가 세팅하고 audio:cancel/done이 소비.
let currentSettle: import('../services/run-settlement').SettlementGuard | null = null
// 취소 진행 상태: none=취소 안 함 / inflight=취소 요청 후 종료·정리 대기 / failed=kill 확인 실패(재취소 허용).
let cancelState: 'none' | 'inflight' | 'failed' = 'none'
let currentWatchdogClear: (() => void) | null = null          // 취소가 watchdog을 즉시 해제할 수 있게
let currentOutputDir: string | null = null                    // 취소 정리(bounded cleanup)가 쓸 output_dir
let currentIsTts = false                                      // tts 실행만 job-dir 정리 대상
let cleanupPending = false                                    // 취소 성공했으나 job-dir 정리 미완 → 새 실행 차단
// runner 'done' 합류용 deferred — cancel 핸들러가 '실제로 runner가 free 됐는지'를 sleep 없이 기다린다.
let runnerDoneDeferred: { promise: Promise<void>; resolve: () => void } | null = null
const CANCEL_EXIT_MS_DEFAULT = 8000                           // taskkill 후 tree 종료 확인 대기(bounded). worker timeout과 별개.
const CLEANUP_DEADLINE_MS = 2500                              // 취소 후 .qwen-job-* 정리 마감(bounded retry).
// 장문 job 축(무진행/총예산) 점검 주기. 이 값은 '언제 판정하는지'일 뿐 '얼마나 기다리는지'가 아니다 —
// 실제 상한은 longform-job.ts 의 STALL_MS/jobBudgetMs 가 정한다. 짧게 두면 판정 지연만 줄어든다.
const JOB_TICK_MS = 15000
// 장문 감시 축의 E2E 시임. production 값은 절대 바뀌지 않는다 — AF_E2E=1에서만 globalThis 주입값을
// 읽는다(취소-종료 대기의 __afCancelExitMs, 정리 실패의 __afCleanupFailCount와 같은 선례).
// 실제 stall/예산은 분 단위라 E2E가 그대로 기다릴 수 없으므로, '축이 존재하고 올바른 순서로
// 작동하는가'를 초 단위로 재현하기 위한 것이다. 상한 값 자체의 근거는 longform-job.ts가 갖는다.
function jobWatchSeam(): { inactivityMs?: number; stallMs?: number; tickMs?: number } {
  if (process.env.AF_E2E !== '1') return {}
  const g = globalThis as unknown as {
    __afJobInactivityMs?: number; __afJobStallMs?: number; __afJobTickMs?: number
  }
  const pos = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined)
  return { inactivityMs: pos(g.__afJobInactivityMs), stallMs: pos(g.__afJobStallMs), tickMs: pos(g.__afJobTickMs) }
}
// 취소-종료 대기 timeout(ms). production 값 불변; AF_E2E=1에서만 globalThis 주입값으로 대체(테스트 결정성).
function cancelExitMs(): number {
  if (process.env.AF_E2E === '1') {
    const g = globalThis as unknown as { __afCancelExitMs?: number }
    if (typeof g.__afCancelExitMs === 'number' && g.__afCancelExitMs > 0) return g.__afCancelExitMs
  }
  return CANCEL_EXIT_MS_DEFAULT
}
function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
// 취소 phase telemetry — AF_E2E=1에서만 globalThis에 최초 관측 시각(ms) 기록. production 로그/UI 미노출.
function afPhase(name: string): void {
  if (process.env.AF_E2E !== '1') return
  const g = globalThis as unknown as { __afCancelPhases?: Record<string, number> }
  g.__afCancelPhases = g.__afCancelPhases || {}
  if (g.__afCancelPhases[name] == null) g.__afCancelPhases[name] = Date.now()
}
// 취소 후 .qwen-job-* bounded 정리 — 실제로 0개임을 확인(listQwenJobDirs)한 뒤에만 true.
// AF_E2E=1에서 __afCleanupFailCount로 초기 실패 횟수를 주입해 지연 정리 회귀를 결정적으로 재현.
async function boundedJobCleanup(outputDir: string, deadlineMs: number): Promise<boolean> {
  const start = Date.now()
  const g = globalThis as unknown as { __afCleanupFailCount?: number }
  let forceFail = process.env.AF_E2E === '1' && typeof g.__afCleanupFailCount === 'number' ? g.__afCleanupFailCount : 0
  for (;;) {
    try { sweepQwenJobDirs(outputDir) } catch { /* noop */ }
    let remaining = listQwenJobDirs(outputDir).length
    if (forceFail > 0) { forceFail--; if (process.env.AF_E2E === '1') g.__afCleanupFailCount = forceFail; remaining = Math.max(remaining, 1) }
    if (remaining === 0) return true
    if (Date.now() - start >= deadlineMs) return false
    await delay(120)
  }
}
// 유효한 파생 참조 클립 폴더(tmpdir/audioforge_refclip_*)를 clipKey별로 추적.
// clipKey = 'default'(기본 참조) | emotionId(감정 참조). 단일 슬롯을 감정별 식별 구조로 확장.
// 새 클립/새 파일/재확정/합성 종료(합성 중 제외) 시 해당 key(또는 전체)만 정리.
const refClipDirs = new Map<string, string>()

// 참조 source 지문 — 경로+크기+수정시각. 파일이 바뀌면(경로 교체/내용 덮어쓰기) 값이 달라져
// 전사 캐시를 무효화할 수 있다(불변식 3·4). stat 실패 시 ''(비교에서 '살아있는 source 없음'과 동치).
function computeFingerprint(filePath: string): string {
  try {
    if (!filePath) return ''
    const st = statSync(filePath)
    return `${resolve(filePath)}|${st.size}|${Math.round(st.mtimeMs)}`
  } catch {
    return ''
  }
}

// 합성 경계에서 쓸 현재 참조 source 지문 맵 — 'default'=원본 파일, 감정 id=ttsEmotionRefSources.
// 지문이 잡히는(파일 존재) source만 포함한다. 여기 없는 id의 전사는 orphan으로 폐기된다(§4 규칙 2).
function buildReferenceFingerprints(filePath: string, options?: Record<string, unknown>): Record<string, string> {
  const map: Record<string, string> = {}
  const dfp = computeFingerprint(filePath)
  if (dfp) map.default = dfp
  const sources = (options?.ttsEmotionRefSources as Record<string, string> | undefined) || {}
  for (const [id, src] of Object.entries(sources)) {
    const fp = computeFingerprint(src)
    if (fp) map[id] = fp
  }
  return map
}

// 세션 복원 시 참조 source 존재 여부 맵('default' + 감정 id). 렌더러는 fs 접근이 없으므로 여기서 판정.
// source가 사라진 감정만 재지정 필요로 표시하기 위한 근거.
function computeRefLiveness(session: Record<string, unknown>): Record<string, boolean> {
  const liveness: Record<string, boolean> = {}
  const source = typeof session.source === 'string' ? session.source : ''
  liveness.default = !!source && existsSync(source)
  const options = (session.options as Record<string, unknown> | undefined) || {}
  const sources = (options.ttsEmotionRefSources as Record<string, string> | undefined) || {}
  for (const [id, src] of Object.entries(sources)) {
    liveness[id] = !!src && existsSync(src)
  }
  return liveness
}

let cachedFfprobe: string | null = null

async function findFfprobe(): Promise<string> {
  if (cachedFfprobe) return cachedFfprobe
  for (const p of FFPROBE_PATHS) {
    try {
      await execFileAsync(p, ['-version'])
      cachedFfprobe = p
      return p
    } catch { /* try next */ }
  }
  throw new Error('ffprobe를 찾을 수 없습니다. ffmpeg을 설치해주세요.')
}

/**
 * 오디오 IPC 등록. 반환값은 참조 라이브러리가 쓰는 파이썬 실행 adapter 하나뿐이다 —
 * 기존 핸들러의 서명·타임아웃·정리·터미널 의미는 그대로다(추가만 했다).
 * 기존 호출부는 반환값을 무시해도 동작이 같다.
 */
export interface AudioIpcAdapters {
  reference: ReferencePreviewAdapter
  /** 감정 샘플 1건을 기존 TTS 실행 경로로 만든다. 별도 runner·모델 lifecycle 을 만들지 않는다. */
  runSamplerTts: (job: SamplerJob) => Promise<SamplerRunOutcome>
  busyReason: () => string | null
}

export function registerAudioIpc(mainWindow: BrowserWindow): AudioIpcAdapters {
  // 영속화된 사용자 지정 python 경로가 있으면 우선 적용(재시작 후에도 유지) — L-6.
  // 사용자의 명시적 선택이 자동 해석(env.json/기본값)보다 우선한다.
  try {
    const persisted = loadSettings().pythonPath
    if (typeof persisted === 'string' && existsSync(persisted)) {
      pythonPath = persisted
    }
  } catch { /* ignore */ }

  // 앱 시작: 이전 세션이 남긴 stale 파생 참조 폴더 방어 정리(정확한 prefix + tmpdir 직속 폴더만).
  try { sweepRefClipDirs(tmpdir()) } catch { /* noop */ }
  // 과거 실행이 남긴 split 원본 사본은 **자동 삭제하지 않는다**(사용자 디스크의 큰 파일을 임의로
  // 지우지 않는다). 개수와 가장 오래된 항목의 시각만 로그로 남겨 상황을 알 수 있게 한다.
  try {
    const orphans = listSplitTempDirs(tmpdir())
    if (orphans.length > 0) {
      const oldest = orphans.reduce((a, b) => (a.mtimeMs <= b.mtimeMs ? a : b))
      console.log(`[AudioForge] split 임시 폴더 ${orphans.length}개 잔류(가장 오래된 것: ${new Date(oldest.mtimeMs).toISOString()}). 자동 삭제하지 않습니다.`)
    }
  } catch { /* noop */ }
  // 앱 종료: 실행 중인 작업의 프로세스 트리를 kill(고아 자식 방지) + 남은 파생 참조 폴더 정리(공용 마감 K).
  // 앱 종료(공용 마감 K2-I): 실행 트리를 kill하고 '종료 확인'까지 기다린 뒤 실제 quit(고아 자식 방지).
  // before-quit을 1회 preventDefault → bounded tree kill → 재진입 guard 후 quit. 무한 대기 방지(delay backstop).
  let quitCleanupDone = false
  app.on('before-quit', (e) => {
    if (quitCleanupDone) return  // 재진입 → 실제 종료 진행
    const busy = runner?.isRunning || trackSlot.current?.isRunning
    if (!busy) { try { sweepRefClipDirs(tmpdir()) } catch { /* noop */ } ; quitCleanupDone = true; return }
    e.preventDefault()  // 실행 트리 종료 확인 전까지 종료 보류
    const kills: Promise<unknown>[] = []
    if (runner) kills.push(runner.cancel(3000))
    { const tr = trackSlot.current; if (tr) kills.push(tr.cancel(3000)) }
    Promise.race([Promise.all(kills), delay(3500)])
      .then(() => { try { sweepRefClipDirs(tmpdir()) } catch { /* noop */ } })
      .finally(() => { quitCleanupDone = true; app.quit() })
  })

  // clipKey 지정 시 그 하나만, 생략 시 전체 정리(새 파일/reset용). 반환: 실제 삭제된 개수.
  const releaseRefClip = (clipKey?: string): number => {
    const keys = clipKey !== undefined ? [clipKey] : Array.from(refClipDirs.keys())
    let removed = 0
    for (const k of keys) {
      const dir = refClipDirs.get(k)
      if (dir) { removeRefClipDir(tmpdir(), dir); refClipDirs.delete(k); removed++ }
    }
    return removed
  }

  // Helper to send error to renderer.
  // 문자열 또는 구조화 오류({message, code?})를 받아 renderer용으로 정제 — message + (있으면) code만 전달.
  // code는 GENERATION_LIMIT_EXCEEDED 등 오류 UX 분기 열쇠. 전사·문장·전체경로·수치 상세는 전달하지 않는다.
  const sendError = (err: string | { message?: unknown; code?: unknown }) => {
    const o = typeof err === 'string' ? { message: err } : (err || {})
    const message = typeof o.message === 'string' ? o.message : String((o.message ?? '알 수 없는 오류'))
    const code = typeof o.code === 'string' ? o.code : undefined
    mainWindow.webContents.send('audio:error', code ? { message, code } : { message })
  }

  // 배타 가드는 '중복 실행을 막아야 하는' 쓰기성 작업에만. 읽기 전용 analyze/preflight는 쓰지 않는다.
  //  - transcriptPreviewGuard: 참조 전사 미리보기(Whisper)
  //  - referenceTrimGuard: 참조 구간 트림(파생 클립 생성)
  // 둘은 서로 다른 가드라 서로를 차단하지 않고, analyze/preflight도 차단하지 않는다.
  const transcriptPreviewGuard = createPreviewGuard()
  const referenceTrimGuard = createPreviewGuard()

  // 읽기 전용 작업 single-flight — StrictMode 중복 effect/동시 요청에도 subprocess는 1회.
  const qwenPreflightSF = createSingleFlight<unknown>()
  const pitchPreflightSF = createSingleFlight<unknown>()  // pitch capability probe(qwen/analyze/trim guard와 무관)
  const analyzeSF = createKeyedSingleFlight<unknown>()  // 절대경로 key

  ipcMain.handle('audio:select-file', async () => {
    // 마지막으로 불러온 폴더에서 열기 — settings.json에 기억(다른 앱 영향 없음)
    const lastDir = loadSettings().lastDir
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      defaultPath: (typeof lastDir === 'string' && existsSync(lastDir)) ? lastDir : undefined,
      filters: [
        // 대표 포맷은 편의를 위해 앞에 두고, 실제 허용은 전체(ffmpeg 디코딩 가능 포맷 전부: mo3 등 포함)
        { name: 'Audio/Video', extensions: ['m4a', 'mp3', 'wav', 'flac', 'ogg', 'aac', 'wma', 'mp4', 'mkv', 'avi', 'mov', 'webm'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('audio:get-file-info', async (_event, filePath: string) => {
    if (!existsSync(filePath)) {
      throw new Error(`파일을 찾을 수 없습니다: ${basename(filePath)}`)
    }
    // 마지막 폴더 기억 — 다이얼로그·드래그앤드롭 공통 경로라 여기서 저장
    saveSetting('lastDir', dirname(filePath))
    const ffprobe = await findFfprobe()
    // 한글 경로 손상 방지: execFile 배열 인자 (cmd.exe 미경유)
    const { stdout } = await execFileAsync(ffprobe, [
      '-hide_banner',
      '-show_entries', 'stream=codec_name,channels,channel_layout,sample_rate,duration',
      '-of', 'json',
      filePath
    ])
    const data = JSON.parse(stdout)
    const stream = data.streams?.[0]
    if (!stream) throw new Error('오디오 스트림을 찾을 수 없습니다')

    return {
      path: filePath,
      name: basename(filePath),
      duration: parseFloat(stream.duration) || 0,
      channels: stream.channels || 1,
      sampleRate: parseInt(stream.sample_rate) || 44100,
      format: stream.codec_name || 'unknown'
    }
  })

  ipcMain.handle('audio:get-file-url', (_event, filePath: string) => {
    return `local-file://${encodeURIComponent(filePath)}`
  })

  // 참조 음성 자동 전사 미리보기(수동 전사 UI용). 사용자 클릭 시에만 Whisper 로딩.
  // 메인 처리용 runner와 별개의 단기 프로세스로 실행. 동시 실행 방지 + timeout + 정리.
  ipcMain.handle('audio:transcribe-reference', async (_event, filePath: string) => {
    if (runner?.isRunning) throw new Error('처리 중에는 참조 전사를 실행할 수 없습니다.')
    if (!existsSync(pythonPath)) throw new Error(`Python을 찾을 수 없습니다: ${pythonPath}`)
    if (!existsSync(filePath)) throw new Error(`참조 파일을 찾을 수 없습니다: ${filePath}`)
    transcriptPreviewGuard.begin()  // 참조 전사 중복 실행 방지(진행 중이면 throw)
    // config 생성·writeFileSync·실행 전체를 try/finally 안에 둔다 — 설정 단계 예외에서도
    // guard가 running에 영구히 남지 않고, 생성된 config도 정리된다.
    const cfgPath = join(tmpdir(), `audioforge_reftx_${randomUUID()}.json`)
    try {
      const scriptPath = PythonRunner.getScriptPath('separate.py')
      writeFileSync(cfgPath, JSON.stringify({ mode: 'ref-transcribe', input: filePath, output: dirname(filePath) }), 'utf-8')
      return await runPreview({
        runner: new PythonRunner(pythonPath, runnerDeps),
        scriptPath, args: ['--config', cfgPath],
        timeoutMs: 120000,  // Whisper small 로딩+전사 여유. 멈춘 프로세스만 끊음.
        cleanup: () => { try { unlinkSync(cfgPath) } catch {} }
      })
    } finally {
      try { unlinkSync(cfgPath) } catch {}  // 설정 예외/누락 대비(정상 시 runPreview cleanup과 중복이나 무해)
      transcriptPreviewGuard.end()
    }
  })

  // 참조 구간 분석(길이/추천/파형 peak) — 읽기 전용. 배타 가드 미사용(analyze/preflight를 서로 차단하지
  // 않음). 같은 절대 filePath의 동시 요청은 single-flight로 합쳐 subprocess 1회, 모두 같은 결과.
  ipcMain.handle('audio:analyze-reference', async (_event, filePath: string, clipKey: string = 'default',
                                                   extra?: Record<string, unknown>) => {
    if (runner?.isRunning) throw new Error('처리 중에는 참조 분석을 실행할 수 없습니다.')
    if (!existsSync(pythonPath)) throw new Error(`Python을 찾을 수 없습니다: ${pythonPath}`)
    if (!existsSync(filePath)) throw new Error(`참조 파일을 찾을 수 없습니다: ${filePath}`)
    // single-flight key는 clipKey+절대경로 — 감정별로 분리하되 같은 (key,파일)의 동시 요청만 합침.
    // extra 가 다르면 다른 질문이다 — single-flight 키에 넣지 않으면 후보 목록 요청이
    // 같은 파일의 이전 분석 응답에 합쳐져 후보가 오지 않는다.
    const key = clipKey + '\u0000' + resolve(filePath)
      + (extra ? '\u0000' + JSON.stringify(extra) : '')
    if (!analyzeSF.has(key)) releaseRefClip(clipKey)  // 새 분석 시작일 때만 그 key의 이전 파생 클립 폐기(중복 요청엔 안 함)
    return analyzeSF.run(key, async () => {  // 동시/StrictMode 중복은 진행 중 Promise 공유(subprocess 1회)
      const cfgPath = join(tmpdir(), `audioforge_refanalyze_${randomUUID()}.json`)
      try {
        const scriptPath = PythonRunner.getScriptPath('separate.py')
        writeFileSync(cfgPath, JSON.stringify({
          mode: 'ref-analyze', input: filePath, output: dirname(filePath), ...(extra ?? {}),
        }), 'utf-8')
        return await runPreview({
          runner: new PythonRunner(pythonPath, runnerDeps),
          scriptPath, args: ['--config', cfgPath],
          timeoutMs: 60000,  // 파형 peak 스캔 여유. 멈춘 프로세스만 끊음.
          cleanup: () => { try { unlinkSync(cfgPath) } catch {} }
        })
      } finally {
        try { unlinkSync(cfgPath) } catch {}
      }
    })
  })

  // 선택 구간 → mono/24k 파생 참조 WAV(작업 임시폴더). 원본 불변. 반환 clip_path를 합성에 전달한다.
  ipcMain.handle('audio:trim-reference', async (_event, filePath: string, startSec: number, durSec: number, clipKey: string = 'default') => {
    if (runner?.isRunning) throw new Error('처리 중에는 참조 트림을 실행할 수 없습니다.')
    if (!existsSync(pythonPath)) throw new Error(`Python을 찾을 수 없습니다: ${pythonPath}`)
    if (!existsSync(filePath)) throw new Error(`참조 파일을 찾을 수 없습니다: ${filePath}`)
    releaseRefClip(clipKey)  // 재확정 → 그 key의 이전 파생 클립만 폐기(타 감정 클립 불변; 합성 중 아님: 위에서 차단)
    referenceTrimGuard.begin()  // 트림 중복 실행 방지(전사 가드와 분리 — 서로 차단하지 않음)
    const uid = randomUUID()
    const cfgPath = join(tmpdir(), `audioforge_reftrim_${uid}.json`)
    const outDir = join(tmpdir(), `audioforge_refclip_${uid}`)  // 작업 임시폴더(프로젝트 밖), 충돌 불가 UID
    refClipDirs.set(clipKey, outDir)  // 새 파생 클립 폴더를 그 key로 추적(합성 종료/새 파일/재확정 시 정리)
    try {
      mkdirSync(outDir, { recursive: true })
      const scriptPath = PythonRunner.getScriptPath('separate.py')
      writeFileSync(cfgPath, JSON.stringify({
        mode: 'ref-trim', input: filePath, output: outDir,
        regionStart: startSec, regionDur: durSec
      }), 'utf-8')
      return await runPreview({
        runner: new PythonRunner(pythonPath, runnerDeps),
        scriptPath, args: ['--config', cfgPath],
        timeoutMs: 60000,
        cleanup: () => { try { unlinkSync(cfgPath) } catch {} }
      })
    } finally {
      try { unlinkSync(cfgPath) } catch {}
      referenceTrimGuard.end()
    }
  })

  // Qwen 실행 전 상태(preflight) — 읽기 전용. 배타 가드 미사용. 동시(또는 StrictMode 중복) 호출은
  // 하나의 in-flight Promise를 공유해 subprocess 1회. 예상값이며 실행 결과는 metadata가 최종.
  ipcMain.handle('audio:qwen-preflight', async () => {
    if (runner?.isRunning) return { available: false, reason: '처리 중' }
    if (!existsSync(pythonPath)) return { available: false, reason: 'Python 없음' }
    return qwenPreflightSF.run(async () => {  // 동시/StrictMode 중복은 진행 중 Promise 공유(subprocess 1회)
      const cfgPath = join(tmpdir(), `audioforge_qwenpre_${randomUUID()}.json`)
      try {
        const scriptPath = PythonRunner.getScriptPath('separate.py')
        writeFileSync(cfgPath, JSON.stringify({ mode: 'qwen-preflight' }), 'utf-8')
        return await runPreview({
          runner: new PythonRunner(pythonPath, runnerDeps),
          scriptPath, args: ['--config', cfgPath],
          timeoutMs: 30000,
          cleanup: () => { try { unlinkSync(cfgPath) } catch {} }
        })
      } catch (e) {
        return { available: false, reason: (e as Error)?.message || 'preflight 실패' }
      } finally {
        try { unlinkSync(cfgPath) } catch {}
      }
    })
  })

  // pitch capability preflight(§6·계약 G) — UI(음높이 슬라이더)와 합성 gate가 rubberband 지원 여부를 소비.
  // separate.py 'pitch-preflight' 모드가 pitch_shift.pitch_available()의 (available, reason)만 반환(미디어·
  // GPU·모델 없음). 읽기 전용 single-flight로 StrictMode/동시 호출에도 subprocess 1회. Python 없음·runner
  // 오류·timeout은 supported=false·probed=true(미지원 확정)로 명확히 반환한다(조용한 unknown 방치 금지).
  ipcMain.handle('audio:pitch-preflight', async () => {
    // E2E 결정성(계약 G-C): AF_E2E=1 일 때만 환경변수로 capability를 강제한다(production 무영향·monkeypatch 없음).
    if (process.env.AF_E2E === '1') {
      const forced = process.env.AF_E2E_PITCH_CAPABILITY
      if (forced === 'supported') return normalizePitchCapability({ available: true, reason: 'e2e-forced-supported' })
      if (forced === 'unsupported') return normalizePitchCapability({ available: false, reason: 'e2e-forced-unsupported' })
      if (forced === 'probe-failed') return normalizePitchCapability({ available: false, reason: 'pitch-probe-failed: e2e-forced' })
      // 그 외/미설정이면 실제 probe로 진행
    }
    if (runner?.isRunning) return normalizePitchCapability(null)  // 처리 중엔 probe 안 함(unknown 유지)
    if (!existsSync(pythonPath)) return normalizePitchCapability({ available: false, reason: 'pitch-probe-failed: python-not-found' })
    return pitchPreflightSF.run(async () => {  // 동시/StrictMode 중복은 진행 중 Promise 공유(subprocess 1회)
      const cfgPath = join(tmpdir(), `audioforge_pitchpre_${randomUUID()}.json`)
      try {
        const scriptPath = PythonRunner.getScriptPath('separate.py')
        writeFileSync(cfgPath, JSON.stringify({ mode: 'pitch-preflight' }), 'utf-8')
        const raw = await runPreview({
          runner: new PythonRunner(pythonPath, runnerDeps),
          scriptPath, args: ['--config', cfgPath],
          timeoutMs: 35000,
          cleanup: () => { try { unlinkSync(cfgPath) } catch {} }
        }) as { available?: boolean | null; reason?: string } | null
        return normalizePitchCapability(raw)
      } catch (e) {
        // Python/runner 오류·timeout → 미지원 확정(probed=true, supported=false). 사유에 경로/민감정보 미포함.
        return normalizePitchCapability({ available: false, reason: `pitch-probe-failed: ${(e as Error)?.name || 'error'}` })
      } finally {
        try { unlinkSync(cfgPath) } catch {}
      }
    })
  })

  ipcMain.handle('audio:process', async (_event, filePath: string, mode: string, options?: Record<string, unknown>) => {
    if (runner?.isRunning) {
      throw new Error('이미 처리 중인 작업이 있습니다')
    }
    // 취소 진행 중(inflight)엔 새 실행 거부 — renderer 버튼 차단에만 의존하지 않는다(공용 마감 K2-D).
    if (cancelState === 'inflight') {
      throw new Error('작업을 취소하고 정리하는 중입니다. 잠시 후 다시 시도하세요.')
    }
    // 취소 후 job-dir 정리 미완(cleanupPending): 여기서 한 번 더 bounded 정리 시도 → 성공해야 진행.
    if (cleanupPending) {
      const dir = currentOutputDir
      const done = dir ? await boundedJobCleanup(dir, CLEANUP_DEADLINE_MS) : true
      if (!done) throw new Error('이전 취소 작업의 임시 파일 정리가 끝나지 않았습니다. 잠시 후 다시 시도하세요.')
      cleanupPending = false; currentOutputDir = null
    }
    // 읽기 전용 preflight/analyze는 합성을 막지 않는다. 실제 참조 전사·트림 중일 때만 차단(작업명 표시).
    if (transcriptPreviewGuard.running) {
      throw new Error('참조 전사 미리보기 중에는 합성을 시작할 수 없습니다.')
    }
    if (referenceTrimGuard.running) {
      throw new Error('참조 구간 트림 중에는 합성을 시작할 수 없습니다.')
    }

    // Verify python exists
    if (!existsSync(pythonPath)) {
      throw new Error(`Python을 찾을 수 없습니다: ${pythonPath}`)
    }

    // Resolve script path. AF_E2E=1에서만: 취소 lifecycle E2E가 실제 Qwen/미디어 대신 synthetic
    // 프로세스 트리를 띄우도록 스크립트 경로를 대체(취소·정착·정리·watchdog 로직은 production 그대로 실행).
    let scriptPath = PythonRunner.getScriptPath('separate.py')
    if (process.env.AF_E2E === '1' && process.env.AF_E2E_TTS_SCRIPT && existsSync(process.env.AF_E2E_TTS_SCRIPT)) {
      scriptPath = process.env.AF_E2E_TTS_SCRIPT
    }
    if (!existsSync(scriptPath)) {
      throw new Error(`Python 스크립트를 찾을 수 없습니다: ${scriptPath}`)
    }

    // Build output directory
    const ext = extname(filePath)
    const nameWithoutExt = basename(filePath, ext)
    const now = new Date()
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`
    // 폴더명은 초 단위라 같은 초에 두 번 시작하면 같은 폴더를 재사용하게 되고, 워커가 ffmpeg -y로
    // 덮어써 **이전 결과가 소리 없이 사라진다**(감사 R9). 이미 존재하면 짧은 접미사를 붙여 새 폴더를
    // 확보한다. 접미사는 첫 충돌부터만 붙으므로 기존 폴더 이름 규칙은 그대로다.
    const baseOutputDir = join(dirname(filePath), 'AudioForge_output', `${timestamp}_${nameWithoutExt}`)
    let outputDir = baseOutputDir
    for (let n = 2; existsSync(outputDir) && n <= 100; n++) outputDir = `${baseOutputDir}_${n}`
    if (existsSync(outputDir)) {
      // 100개까지 전부 존재 = 비정상. 덮어쓰지 않고 명시 실패한다.
      throw Object.assign(new Error('출력 폴더를 만들 수 없습니다. 같은 이름의 폴더가 너무 많습니다.'), { code: 'OUTPUT_DIR_UNAVAILABLE' })
    }
    mkdirSync(outputDir, { recursive: true })
    // 방어적: 이 output_dir에 이전 실행이 남긴 Qwen 실행별 임시폴더가 있으면 시작 전에 정리
    // (신규 dir이라 보통 없음). 안전 범위 = 이 output_dir 바로 아래 .qwen-job-* 폴더만.
    if (mode === 'tts') { try { sweepQwenJobDirs(outputDir) } catch { /* noop */ } }

    // 이번 실행 식별자. ① config 파일 이름 충돌 방지(Date.now()는 같은 ms에 겹칠 수 있다)
    // ② split 워커가 만드는 '원본 전체 사본' 임시폴더 이름에 실려, 취소·강제종료 뒤에도 main이
    //    이 실행의 폴더만 정확히 지울 수 있게 한다(파이썬 finally는 taskkill에서 실행되지 않는다).
    const runToken = randomUUID().slice(0, 8)
    // Write all options to JSON config file (avoids spawn encoding issues with Korean paths)
    const configPath = join(tmpdir(), `audioforge_config_${runToken}.json`)
    const config = {
      mode,
      runToken,
      input: filePath,
      output: outputDir,
      model: options?.demucsModel || 'htdemucs',
      trimSilence: !!options?.trimSilence,
      silenceGap: options?.silenceGap ?? 0.5,
      transcribe: !!(options?.transcribe || mode === 'transcribe'),
      outputFormat: options?.outputFormat || 'wav',
      whisperModel: options?.whisperModel || 'large-v3',
      whisperLang: options?.whisperLang || 'auto',
      translate: !!options?.translate,
      translateModel: options?.translateModel || '600m',
      srt: !!options?.exportSrt,
      splitPoints: mode === 'split' && options?.splitMarkers ? (options.splitMarkers as number[]).join(',') : '',
      splitLabels: mode === 'split' && options?.splitLabels ? (options.splitLabels as string[]).join('|') : '',
      nSpeakers: options?.nSpeakers || 2,
      // TTS 필드는 단일 소스(buildTtsConfig)로 직렬화 — ttsEmotionRefs 포함,
      // 숫자 기본값은 ??(0 보존). 필드 추가 시 컴파일 단계에서 누락 검출.
      // IPC로 온 untyped 옵션을 TtsInputOptions로 명시 변환해 전달.
      // 합성 경계 불변식(§4): 현재 참조 source 지문 맵을 함께 넘겨 stale 전사를 폐기한 뒤 직렬화.
      // 'default'=원본 파일, 감정=ttsEmotionRefSources. 렌더러가 stale 전사를 되살려 보내도
      // 여기서 정합 전사만 Python에 전달된다.
      ...buildTtsConfig(options as TtsInputOptions | undefined, buildReferenceFingerprints(filePath, options))
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    console.log(`[AudioForge] Config written to: ${configPath}`)

    runner = new PythonRunner(pythonPath, runnerDeps)
    const thisRunner = runner  // 이 실행 인스턴스 고정 — done에서 새 실행의 runner를 null로 덮어쓰지 않도록(clobber 방지).

    // 종료 시 UI가 'processing'에 남지 않도록: result/error/watchdog/취소 중 하나로 반드시 '정착'.
    // 어느 것도 없이 프로세스가 끝나면(예: 외부 kill, 코드 0인데 result 미도달) done에서 오류로 마감.
    const settle = createSettlementGuard(sendError)
    cancelState = 'none'          // 새 실행 시작 → 취소 상태 초기화
    currentSettle = settle        // audio:cancel이 '최초 정착 승자' 판정에 사용
    currentOutputDir = outputDir  // 취소 정리(bounded cleanup)가 쓸 경로
    currentIsTts = mode === 'tts'
    const runnerDone = makeDeferred()  // done 핸들러가 resolve → cancel 핸들러가 sleep 없이 합류
    runnerDoneDeferred = runnerDone

    // production race 방지: 터미널 신호(result/error)를 즉시 보내지 않고 버퍼링했다가 runner 'done'
    // (자식 프로세스 실제 종료 = backend free) 이후에 전달한다. 이러면 renderer가 완료(done)와
    // '다른 모드로 재처리'를 보는 시점엔 이미 runner=null이라, 결과 직후 재합성해도 "이미 처리 중"이 없다.
    // 결과는 staging 게이트가 붙든다. 예전에는 pendingResult 변수 하나였고, 그 기준은 '자식
    // 프로세스가 끝났는가'뿐이었다 — watchdog이 이미 시간 초과로 마감한 뒤에 result가 도착하면
    // done 경로가 그 결과를 그대로 렌더러에 보냈다(터미널 확정 이후의 결과 공개). 게이트는
    // '중간 산출물 정리(staging)까지 확인됐을 때만 공개'를 명시적 전제로 만들고, abandon된
    // 실행에서는 어떤 결과도 나가지 못하게 한다.
    const stagingGate = createStagingGate<unknown>(
      (data) => { mainWindow.webContents.send('audio:result', data) },
      createTerminalGate
    )
    let pendingError: string | { message?: unknown; code?: unknown } | null = null

    forwardSidecar(runner, mainWindow)

    runner.on('progress', (data) => {
      mainWindow.webContents.send('audio:progress', data)
    })

    runner.on('result', (data) => {
      // TTS 결과 재현 메타데이터: Python이 아는 런타임 사실 + main이 아는 config 필드 병합.
      // 보안: 참조 전사 '전문'은 기록하지 않는다(Python이 언어/글자수/해시만 넣음).
      if (mode === 'tts' && data && typeof data === 'object') {
        const md = ((data as { metadata?: Record<string, unknown> }).metadata) || {}
        if (md.requested_engine == null) md.requested_engine = options?.ttsEngine ?? 'auto'
        md.original_reference_path = filePath  // 사용자 원본
        md.effective_reference_path = (options?.ttsReferenceOverride as string) || filePath  // 파생 클립 우선
        const region = options?.ttsReferenceRegion as { start: number; duration: number } | null | undefined
        if (region && typeof region.start === 'number') md.reference_region = region
        // 감정별 참조(추가정합1): metadata에는 실제 사용된 감정(effective=ttsEmotionRefs 키)의 구간 +
        // source basename만 기록(비민감 요약·실제 사용 사실). 전체 원본 경로는 session config에만 보존.
        // 완전 재현은 session의 source+region이 담당한다(§1.2/§2.3).
        const usedEmo = options?.ttsEmotionRefs as Record<string, string> | undefined
        if (usedEmo && Object.keys(usedEmo).length) {
          const emoRegions = (options?.ttsEmotionRefRegions as Record<string, { start: number; duration: number }> | undefined) || {}
          const emoSources = (options?.ttsEmotionRefSources as Record<string, string> | undefined) || {}
          const regionsOut: Record<string, { start: number; duration: number }> = {}
          const namesOut: Record<string, string> = {}
          for (const id of Object.keys(usedEmo)) {
            const r = emoRegions[id]
            if (r && typeof r.start === 'number') regionsOut[id] = r
            const s = emoSources[id]
            if (s) namesOut[id] = basename(s)
          }
          if (Object.keys(regionsOut).length) md.emotion_reference_regions = regionsOut
          if (Object.keys(namesOut).length) md.emotion_reference_source_names = namesOut
        }
        ;(data as { metadata?: unknown }).metadata = md
      }
      // 세션 매니페스트 저장 — 나중에 재분리 없이 설정+트랙 복원용 (source of truth)
      try {
        const tracks = Array.isArray((data as { tracks?: unknown[] })?.tracks)
          ? (data as { tracks: { name?: string; label?: string; path?: string }[] }).tracks.map(t => ({ name: t.name, label: t.label, path: t.path }))
          : []
        const session = {
          version: 1,
          // I3(계약 정정8): 세션 스키마 버전. 이 필드가 없는(legacy) 세션은 복원 시 tail off/현행으로 강등되어
          // 구 세션을 여는 것만으로 재현이 조용히 바뀌지 않는다(자동 마이그레이션 없음). 2 = tail/감정경계 도입.
          session_schema_version: 2,
          source: filePath,
          sourceName: basename(filePath),
          mode,
          options: config,
          tracks,
          metadata: (data as { metadata?: unknown }).metadata ?? null,
          createdAt: new Date().toISOString()
        }
        writeFileSync(join(outputDir, 'session.json'), JSON.stringify(session, null, 2), 'utf-8')
      } catch (err) {
        console.log(`[AudioForge] session.json 저장 실패: ${(err as Error).message}`)
      }
      settle.markSettled()
      stagingGate.offerFinal(data)  // 공개는 'done'에서 staging 확인 후(markStagingComplete)
    })

    runner.on('error', (message) => {
      settle.markSettled()
      // 문자열(spawn/close 오류) 또는 구조화 객체(파싱된 error 라인, code 포함) 그대로 보관 → 'done'에서 정제 전달.
      const next = (message && typeof message === 'object') ? message : String(message)
      // 구조화 오류가 먼저 도착했으면 뒤따르는 일반 문구가 그것을 덮지 않는다.
      // Python이 error 라인(code 포함)을 내고 비정상 코드로 종료하면 러너가 close에서 '프로세스가
      // 코드 N로 종료되었습니다'를 한 번 더 emit한다. 예전에는 그 두 번째가 code를 지워버려서
      // QWEN_NO_RESPONSE·QWEN_LOAD_TIMEOUT 같은 진단이 일반 종료 문구로 뭉개졌다.
      const hasCode = (v: unknown): boolean =>
        !!v && typeof v === 'object' && typeof (v as { code?: unknown }).code === 'string'
      if (pendingError !== null && hasCode(pendingError) && !hasCode(next)) return
      pendingError = next
    })

    // Watchdog: kill if no progress for 5 minutes
    // ① 비활성 축 — 값·문구·동작 모두 기존 그대로다(아래 두 축이 추가된 것뿐).
    const WATCHDOG_MS = 300000
    let watchdog: ReturnType<typeof setTimeout> | null = null

    const resetWatchdog = () => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        if (runner?.isRunning) {
          settle.markSettled()
          stagingGate.abandon()   // 시간 초과로 마감된 실행의 늦은 결과는 공개하지 않는다
          runner.cancel()  // async(무시) — 트리 kill 시도
          sendError('처리 시간이 초과되었습니다 (5분간 응답 없음). Python 환경을 확인해주세요.')
        }
      }, WATCHDOG_MS)
    }

    // ②③ 장문 job 축 — '살아있음'과 '실제로 조각을 만들어냈음'을 구분해 판정한다.
    // 왜 별도 타이머인가: ①은 'progress 이벤트가 오면 리셋'이라 heartbeat(=Python이 로딩 생존
    // 신호를 progress로 옮겨 보낸 것)만으로도 무한히 연장된다. 그건 의도된 보호지만(느린 콜드
    // 로딩을 죽이면 안 된다), 그것 **하나뿐**이면 살아있으나 아무것도 생산하지 않는 job과
    // 총 길이가 폭주하는 job에 대한 천장이 어디에도 없다. 판정 로직·상수 근거는 longform-job.ts.
    const seam = jobWatchSeam()
    const jobWatch = createJobWatchdog({
      now: () => Date.now(), inactivityMs: seam.inactivityMs, stallMs: seam.stallMs
    })
    // 타이머 소유권은 longform-job.startJobWatch 가 갖는다 — 이 파일은 electron 을 import 하므로
    // node --test 로 로드할 수 없고, 여기에 타이머를 두면 '취소·종료 후 남지 않는다'를 유닛
    // 테스트로 확인할 방법이 없다. setInterval/clearInterval 을 주입하는 형태라 그쪽에서 검증된다.
    const jobTick = startJobWatch({
      watchdog: jobWatch,
      intervalMs: seam.tickMs ?? JOB_TICK_MS,
      isRunning: () => runner?.isRunning === true,
      deps: { setInterval, clearInterval },
      onBreach: (verdict, r) => {
        settle.markSettled()
        // staging 이 끝나기 전에 터미널이 확정됐다 → 뒤늦게 도착하는 결과는 절대 공개하지 않는다.
        stagingGate.abandon()
        runner?.cancel()  // async(무시) — 트리 kill 시도
        sendError(verdict === 'no-forward-progress'
          ? `합성이 ${Math.round(r.sinceForwardMs / 1000)}초 동안 한 조각도 진행하지 못했습니다 `
            + `(완료 ${r.completedChunks}조각). 프로세스는 살아 있었지만 결과를 만들지 못했습니다.`
          : `합성이 이 작업에 허용된 총 시간을 초과했습니다 `
            + `(경과 ${Math.round(r.elapsedMs / 1000)}초, 완료 ${r.completedChunks}`
            + `/${r.estimatedTotalChunks ?? '?'}조각).`)
      }
    })

    // 취소가 watchdog을 즉시 해제할 수 있게 노출(취소는 watchdog 무의미). done에서 정리.
    currentWatchdogClear = () => {
      if (watchdog) { clearTimeout(watchdog); watchdog = null }
      jobTick.stop()
      stagingGate.abandon()   // 취소된 실행의 결과는 공개하지 않는다
    }

    resetWatchdog()

    runner.on('done', (code) => {
      if (watchdog) { clearTimeout(watchdog); watchdog = null }
      jobTick.stop()
      try { unlinkSync(configPath) } catch {}
      // 성공·오류·취소 어느 경로로 끝나든 이 실행이 만든 split 원본 사본을 지운다. 취소 분기보다
      // 위에 두어 early return에 걸리지 않게 한다. 다른 실행/과거 orphan은 건드리지 않는다.
      if (mode === 'split') { try { removeSplitTempDirs(tmpdir(), runToken) } catch { /* noop */ } }

      // ── 취소 경로(inflight): done은 '권위'가 아니다. runner를 free로 만들고 관측만 기록·합류시킨다.
      // 부분 결과/오류/스윕/터미널 신호(cancelled)는 모두 audio:cancel 핸들러가 tree 종료·정리 확인 후 보낸다.
      if (cancelState === 'inflight') {
        afPhase('runner_done')
        if (runner === thisRunner) { runner = null }  // clobber 방지. currentSettle/OutputDir는 cancel 핸들러가 정리.
        runnerDone.resolve()  // cancel 핸들러의 await 합류(sleep 없이)
        return
      }

      // ── 정상 종료 경로 ──
      // 자식 프로세스 실제 종료 후 발생. 여기서 backend를 먼저 free로 만들고 '그 다음' 버퍼링한 터미널 신호 전달.
      if (mode === 'tts') {
        // 합성 '중간 산출물'(.qwen-job-*)만 정리(즉시 + 지연 재스윕). synthesized.wav·session.json은 보존.
        try { sweepQwenJobDirs(outputDir) } catch { /* noop */ }
        setTimeout(() => { try { sweepQwenJobDirs(outputDir) } catch { /* noop */ } }, 2500)
        // 파생 '참조 클립'은 여기서 삭제하지 않는다(유효 수명 계약).
      }
      // clobber 방지: 이 done이 '현재' 실행의 것일 때만 backend를 free로.
      if (runner === thisRunner) { runner = null; currentSettle = null; currentWatchdogClear = null; currentOutputDir = null }
      // 취소 실패 후 child가 뒤늦게 스스로 종료: 이미 cancel-failed를 보냈으므로 추가 신호 없이 상태만 정리.
      if (cancelState === 'failed') { cancelState = 'none' }
      // 버퍼링한 터미널 신호 전달(정착됨). 없으면 abnormal exit → settle.finish가 오류로 마감(UI 안 멈춤).
      // tts는 위에서 .qwen-job-* 스윕이 이미 돌았다 — 그 '다음'에만 결과가 공개된다(순서가 계약).
      // 게이트가 공개하지 못한 경우(결과 없음 / watchdog·취소로 abandon)에만 오류 경로로 내려간다.
      // watchdog(비활성/무진행/총예산)이 이미 terminal을 보냈으면 여기서 두 번째를 보내지 않는다.
      // 그 경로들은 abandon()으로 게이트를 닫으므로 outcome이 그 사실의 단일 증거다. 이게 없으면
      // watchdog이 kill한 자식의 종료 코드(taskkill /F → 1)에서 만들어진 '프로세스가 코드 1로
      // 종료되었습니다'가 시간 초과 사유를 덮어쓰며 terminal을 2개로 만든다.
      const terminalAlreadySent = stagingGate.outcome === 'abandoned'
      if (!stagingGate.markStagingComplete() && pendingError !== null && !terminalAlreadySent) {
        sendError(pendingError)
      }
      settle.finish(code)
    })

    runner.on('progress', (data) => {
      resetWatchdog()          // ① 기존 그대로 — 어떤 progress 로도 리셋된다
      jobWatch.observe(data)   // ②③ 은 여기서 liveness/forward 를 갈라 각자의 축만 갱신한다
    })

    // Only pass ASCII config path to Python — no Korean chars in spawn args
    const modeNames: Record<string, string> = {
      music: '음악 분리', conversation: '대화 분리', transcribe: '텍스트 추출', split: '트랙 분할', tts: '음성 합성'
    }
    mainWindow.webContents.send('audio:progress', { percent: 0, message: `${modeNames[mode] || mode} 시작 중...` })

    runner.run(scriptPath, ['--config', configPath])

    return { outputDir }
  })

  // Process individual track (transcribe/translate)
  ipcMain.handle('audio:process-track', async (_event, trackPath: string, outputDir: string, options: { transcribe?: boolean; translate?: boolean; srt?: boolean; translateModel?: string }) => {
    if (trackSlot.current?.isRunning) {
      throw new Error('이미 처리 중인 트랙 작업이 있습니다')
    }
    if (!existsSync(pythonPath)) {
      throw new Error(`Python을 찾을 수 없습니다: ${pythonPath}`)
    }
    const scriptPath = PythonRunner.getScriptPath('separate.py')
    if (!existsSync(scriptPath)) {
      throw new Error(`Python 스크립트를 찾을 수 없습니다: ${scriptPath}`)
    }

    const thisRunner = trackSlot.set(new PythonRunner(pythonPath, runnerDeps))

    // Korean paths must never be passed as spawn args (CP949 corruption) —
    // same JSON config approach as 'audio:process'
    const configPath = join(tmpdir(), `audioforge_track_${randomUUID().slice(0, 8)}.json`)  // 같은 ms 충돌 방지
    const config = {
      mode: 'track-process',
      input: trackPath,
      output: outputDir,
      transcribe: !!options.transcribe,
      translate: !!options.translate,
      srt: !!options.srt,
      translateModel: options.translateModel || '600m'
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

    // 실행 범위 정리 — 성공·오류·취소·강제종료 어느 경로로 끝나도 done 직전에 1회 실행된다.
    thisRunner.registerCleanup(() => { try { unlinkSync(configPath) } catch { /* noop */ } })

    // 실행당 터미널 정확히 1개. 여기가 없어서 'exit 0인데 result 없음'이나 시그널 종료 때
    // TrackList의 처리중 표시가 영구히 남았다(감사 R4) — 트랙 처리에는 취소 버튼도 없다.
    const settle = createRunSettlement((t: RunTerminal) => {
      if (t.kind === 'result') { sendToWindow(mainWindow, 'audio:track-result', t.data); return }
      const message = t.kind === 'cancelled'
        ? '트랙 처리가 취소되었습니다.'
        : (t.message ?? '트랙 처리에 실패했습니다.')
      // TrackList는 track-error로만 처리중 표시를 해제한다 → 취소도 같은 채널로 보낸다.
      sendToWindow(mainWindow, 'audio:track-error', { message, trackPath, reasonCode: t.reasonCode })
    })

    // Watchdog: kill if no progress for 5 minutes (same policy as main runner)
    const WATCHDOG_MS = 300000
    let watchdog: ReturnType<typeof setTimeout> | null = null
    const resetWatchdog = () => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        if (!trackSlot.isCurrent(thisRunner)) return
        // 먼저 정착시킨 뒤 kill — 뒤따르는 'killed' done이 timeout 사유를 덮지 않게.
        if (settle.settleError('트랙 처리 시간이 초과되었습니다 (5분간 응답 없음).', 'timeout')) thisRunner.cancel()
      }, WATCHDOG_MS)
    }
    resetWatchdog()

    forwardSidecar(thisRunner, mainWindow)

    thisRunner.on('progress', (data) => {
      resetWatchdog()
      sendToWindow(mainWindow, 'audio:progress', data)
    })
    thisRunner.on('result', (data) => { settle.settleResult(data) })
    thisRunner.on('error', (message) => {
      // message가 구조화 객체({message,...})일 수 있으므로 .message 추출(그냥 String()이면 [object Object]).
      const text = typeof message === 'string'
        ? message
        : String((message as { message?: unknown })?.message ?? message)
      settle.settleError(text, 'error-reported')
    })
    thisRunner.on('done', (_code: number | null, end: RunEnd) => {
      if (watchdog) { clearTimeout(watchdog); watchdog = null }
      trackSlot.release(thisRunner)   // 신원 가드 — 내가 아직 현재 러너일 때만 비운다
      settle.finishFromEnd(end)       // 미정착이면 여기서 반드시 터미널 1개(killed→cancelled, 그 외→error)
    })

    thisRunner.run(scriptPath, ['--config', configPath])
    return { outputDir }
  })

  // 취소 lifecycle(공용 마감 K): cancelling→kill 요청→child exit 확인(bounded)→done이 'cancelled' 전송→idle.
  //  - 최초 정착 승자: 이미 result/error로 정착(currentSettle.settled)했으면 취소는 no-op(늦은 취소).
  //  - kill 확인 실패/timeout: 조용한 idle 금지 → 'cancel-failed'(child 생존 boolean만).
  //  - kill 요청 1회: 핸들러 재진입은 cancelRequested/settled로 차단.
  // 정상 취소의 terminal 신호(audio:cancelled)는 '이 핸들러'가 권위다(공용 마감 K2-B).
  // 순서: cancelling → kill 요청 → tree 종료 확인 → runner done 합류 → bounded cleanup 확인 → cancelled → idle.
  // done 핸들러는 취소 중이면 runner만 free로 만들고 아무 신호도 보내지 않는다.
  // 반환값이 취소 수락의 **권위**다(계약 C2-P0.1). accepted:true = '취소를 접수했고 터미널 이벤트가
  // 정확히 하나 뒤따른다'는 뜻이며 '취소가 성공했다'는 뜻이 아니다(실패 상세는 audio:cancel-failed가 나른다).
  // accepted:true인 경우에만 audio:cancelling을 보낸다 — 렌더러는 그 이벤트로만 cancelling으로 전이한다.
  ipcMain.handle('audio:cancel', async (): Promise<CancelResponse> => {
    // track-process(대화 분할 후처리)는 이번 K/K2 범위 밖 — 단순 취소 유지(별도 열린 결함으로 문서화).
    // 트랙 후처리도 전역 취소에 합류시킨다. 여기서 이벤트를 보내지 않는다 —
    // 러너의 done이 reasonCode 'killed'로 도착해 그쪽 정착이 cancelled 터미널 1개를 보낸다.
    { const tr = trackSlot.current; if (tr) { tr.cancel(); trackSlot.release(tr) } }

    const r = runner
    if (!r || !r.isRunning) return { accepted: false, reasonCode: 'NO_ACTIVE_JOB' }   // 실행 중 아님 → 렌더러 상태 불변
    // result/error가 먼저 정착(취소 아님)했으면 늦은 취소는 no-op(계약 4-B/4-C).
    if (currentSettle?.settled && cancelState === 'none') return { accepted: false, reasonCode: 'ALREADY_SETTLED' }
    if (cancelState === 'inflight') return { accepted: false, reasonCode: 'ALREADY_CANCELLING' }  // 중복 클릭 → kill 요청 1회
    // 첫 취소면 최초 정착 승자로 마킹(재취소는 이미 settled이므로 재마킹하지 않는다).
    if (cancelState === 'none') currentSettle?.markSettled()
    cancelState = 'inflight'
    const doneP = runnerDoneDeferred?.promise ?? Promise.resolve()
    const outDir = currentOutputDir
    const isTts = currentIsTts
    if (currentWatchdogClear) currentWatchdogClear()   // watchdog 무의미 → 즉시 해제
    afPhase('cancelling_sent')
    mainWindow.webContents.send('audio:cancelling')     // renderer → 'cancelling' 표시
    afPhase('kill_requested')
    const res = await r.cancel(cancelExitMs())          // 트리 kill + tree 종료 확인(parent close + taskkill exit 0)
    if (res.treeKillConfirmed) afPhase('tree_kill_confirmed')
    if (!res.treeKillConfirmed) {
      // 트리 종료 미확인(spawn 실패/nonzero/parent close timeout/taskkill timeout) — 조용한 idle 금지.
      cancelState = 'failed'
      const childAlive = r.isRunning
      mainWindow.webContents.send('audio:cancel-failed', { childAlive })
      return { accepted: true }   // 취소는 접수됨(결과는 audio:cancel-failed로 이미 통지)
    }
    // runner done 합류(bounded) — done 핸들러가 runner를 free로 만들었는지 sleep 없이 확인.
    await Promise.race([doneP, delay(3000)])
    afPhase('runner_done_joined')
    // bounded cleanup — 실제로 .qwen-job-* 0개임을 확인한 뒤에만 취소 완료.
    const cleanupOk = isTts && outDir ? await boundedJobCleanup(outDir, CLEANUP_DEADLINE_MS) : true
    afPhase('cleanup_done')
    if (!cleanupOk) {
      // 트리는 죽었으나 임시파일 정리 미완 — 조용한 idle 금지. 새 합성 차단(cleanupPending). synthesized.wav 보존.
      cleanupPending = true
      cancelState = 'none'
      currentSettle = null; currentWatchdogClear = null  // currentOutputDir는 재시도 정리용으로 남긴다
      mainWindow.webContents.send('audio:cancel-failed', { childAlive: false, cleanupPending: true })
      return { accepted: true }   // 접수됨(정리 미완은 audio:cancel-failed payload가 통지)
    }
    cancelState = 'none'
    currentSettle = null; currentWatchdogClear = null; currentOutputDir = null
    afPhase('cancelled_sent')
    mainWindow.webContents.send('audio:cancelled')       // ← terminal 신호(권위). renderer가 idle로.
    return { accepted: true }
  })

  // 파일 reset/변경·감정 삭제/재등록 시 렌더러가 호출 — 파생 참조 클립 폴더 정리(합성 중이면 건드리지 않음).
  // clipKey 지정 시 그 하나만(감정 삭제/재등록), 생략 시 전체(새 파일/reset).
  ipcMain.handle('audio:release-reference-clip', (_event, clipKey?: string) => {
    if (runner?.isRunning) return false  // 합성 worker가 참조 사용 중 → 삭제 금지
    releaseRefClip(clipKey)
    return true
  })

  // 참조 source 지문(path|size|mtimeMs) — 렌더러가 전사 확정 시 그 전사가 어느 source에서 왔는지
  // 기록(TtsReferenceEntry.sourceFingerprint)해 두면, 합성 경계에서 현재 지문과 비교해 stale을 폐기(§4).
  // 파일 없음/접근 실패는 '' 반환(비교 시 '살아있는 source 없음'과 동치).
  ipcMain.handle('audio:fingerprint-reference', (_event, filePath: string) => {
    return computeFingerprint(filePath)
  })

  // 불러온 원본에 대응하는 이전 결과(session.json) 탐색 — <원본폴더>/AudioForge_output/*/session.json
  ipcMain.handle('audio:find-session', (_event, sourcePath: string) => {
    try {
      const root = join(dirname(sourcePath), 'AudioForge_output')
      if (!existsSync(root)) return null
      const srcName = basename(sourcePath)
      const matches: { dir: string; session: Record<string, unknown>; createdAt: string }[] = []
      for (const entry of readdirSync(root)) {
        const dir = join(root, entry)
        let isDir = false
        try { isDir = statSync(dir).isDirectory() } catch { continue }
        if (!isDir) continue
        const sp = join(dir, 'session.json')
        if (!existsSync(sp)) continue
        try {
          const s = JSON.parse(readFileSync(sp, 'utf-8'))
          if (s.source !== sourcePath && s.sourceName !== srcName) continue
          // 트랙 파일이 실제로 남아 있는 것만 유지 (지워졌으면 복원 대상 아님)
          const tracks = Array.isArray(s.tracks)
            ? s.tracks.filter((t: { path?: string }) => t.path && existsSync(t.path))
            : []
          if (tracks.length === 0) continue
          matches.push({ dir, session: { ...s, tracks }, createdAt: String(s.createdAt || entry) })
        } catch { /* skip invalid */ }
      }
      if (matches.length === 0) return null
      matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt))  // 최신 우선
      const top = matches[0]
      // refLiveness 주입 — 자동 복원 경로도 source 소실 감정을 재지정 필요로 표시할 수 있게.
      return { dir: top.dir, session: { ...top.session, refLiveness: computeRefLiveness(top.session) } }
    } catch {
      return null
    }
  })

  ipcMain.handle('audio:restore-from-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '이전 결과 폴더 선택'
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const dir = result.filePaths[0]
    const { readdirSync, readFileSync } = await import('fs')
    const files = readdirSync(dir)

    // 우선 session.json이 있으면 그것으로 전체 설정(TTS mode·pitch·source+region·전사·metadata)을 복원.
    // 트랙은 session.tracks 중 실제 남아 있는 파일만. refLiveness로 source 소실 감정을 렌더러가 표시.
    if (files.includes('session.json')) {
      try {
        const s = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf-8')) as Record<string, unknown>
        const rawTracks = Array.isArray(s.tracks) ? s.tracks as { name?: string; label?: string; path?: string }[] : []
        const sessionTracks = rawTracks
          .filter(t => t.path && existsSync(t.path as string))
          .map(t => ({ name: t.name || '', label: t.label || t.name || '', path: t.path as string }))
        return {
          tracks: sessionTracks,
          outputDir: dir,
          session: {
            mode: s.mode,
            source: s.source,
            metadata: s.metadata ?? null,
            options: s.options ?? {},
            refLiveness: computeRefLiveness(s),
            tracks: sessionTracks
          }
        }
      } catch { /* session.json 손상 → 아래 레거시 스캔으로 폴백 */ }
    }

    const jsonFiles = files.filter((f: string) => f.endsWith('.json')).sort()

    if (jsonFiles.length === 0) return null

    const tracks: { name: string; label: string; path: string }[] = []

    for (const jf of jsonFiles) {
      try {
        const meta = JSON.parse(readFileSync(join(dir, jf), 'utf-8'))
        const audioFile = meta.output_file || ''
        const audioPath = join(dir, audioFile)
        if (existsSync(audioPath)) {
          tracks.push({
            name: audioFile.replace(/\.\w+$/, ''),
            label: `${meta.title || audioFile} (${Math.floor((meta.duration || 0) / 60)}:${String(Math.floor((meta.duration || 0) % 60)).padStart(2, '0')})`,
            path: audioPath
          })
        }
      } catch { /* skip invalid json */ }
    }

    // Also include audio files without JSON (e.g., speaker_a.wav, vocals.wav)
    const audioExts = ['.wav', '.mp3', '.flac']
    for (const f of files) {
      const ext = f.substring(f.lastIndexOf('.')).toLowerCase()
      if (audioExts.includes(ext)) {
        const name = f.replace(/\.\w+$/, '')
        if (!tracks.some(t => t.name === name)) {
          tracks.push({ name, label: name, path: join(dir, f) })
        }
      }
    }

    return { tracks, outputDir: dir, session: null }
  })

  ipcMain.handle('audio:export-tracks', async (_event, trackPaths: string[]) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: '내보내기 위치 선택'
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const destDir = result.filePaths[0]
    const { copyFileSync } = await import('fs')
    for (const src of trackPaths) {
      const dest = join(destDir, basename(src))
      copyFileSync(src, dest)
    }
    return destDir
  })

  ipcMain.handle('settings:get', () => {
    // 후보 등록부는 합성과 무관하게 살아 있어야 한다 — 합성하지 않고 앱을 닫아도
    // 복원돼야 하므로 여기서 함께 돌려준다. Python 이 읽는 생성 config 와 다른 파일이다.
    // 두 키를 따로 돌려준다 — 자산(물리 음원)과 배역(연결)은 다른 책임이고, 한쪽이
    // 손상돼도 다른 쪽이 함께 죽지 않아야 한다.
    const stored = loadSettings()
    return {
      pythonPath,
      [GLOBAL_ASSET_STORAGE_KEY]: stored[GLOBAL_ASSET_STORAGE_KEY] ?? null,
      [VOICE_CAST_STORAGE_KEY]: stored[VOICE_CAST_STORAGE_KEY] ?? null,
    }
  })

  ipcMain.handle('settings:set', (_event, key: string, value: unknown) => {
    if (key === 'pythonPath' && typeof value === 'string') {
      pythonPath = value
      savePythonPath(value)  // L-6: 영속화
      return
    }
    // 전역 참조 자산 등록부. 해석 권위는 shared `deserializeAssetStore` 이고 main 은
    // 옮기기만 한다. 저장 성공 여부를 그대로 돌려준다 — 실패를 persisted 로 표시하면
    // 사용자는 저장된 줄 알고 앱을 닫는다.
    if (key === GLOBAL_ASSET_STORAGE_KEY || key === VOICE_CAST_STORAGE_KEY) {
      // 배역 세트도 같은 원자 경로를 쓴다. 두 키는 서로를 덮지 않는다 —
      // settings-store 가 현재 파일을 읽어 그 키 하나만 갱신한다.
      return saveSetting(key, value ?? undefined)
    }
    return { ok: false, code: 'SETTINGS_KEY_NOT_ALLOWED' }
  })

  ipcMain.handle('settings:select-python-path', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Python', extensions: ['exe'] }]
    })
    if (result.canceled) return null
    pythonPath = result.filePaths[0]
    savePythonPath(pythonPath)  // L-6: 영속화
    return pythonPath
  })

  ipcMain.handle('app:open-folder', (_event, path: string) => {
    shell.openPath(path)
  })

  ipcMain.handle('app:copy-to-clipboard', async (_event, text: string) => {
    const { clipboard } = await import('electron')
    clipboard.writeText(text)
    return true
  })

  ipcMain.handle('app:read-text-file', async (_event, path: string) => {
    const { readFileSync } = await import('fs')
    try {
      return readFileSync(path, 'utf-8')
    } catch {
      return null
    }
  })

  // 참조 라이브러리가 쓸 파이썬 실행 adapter. 기존 analyze/trim 핸들러와 **같은** 방식
  // (같은 pythonPath·같은 separate.py·같은 runPreview 타임아웃/정리)으로 돌린다.
  // 이 함수 밖으로 runner·pythonPath 를 내보내지 않기 위해 adapter 형태로만 넘긴다.
  const referenceAdapter: ReferencePreviewAdapter = {
    busyReason: () => {
      if (runner?.isRunning) return '처리 중에는 참조를 등록할 수 없습니다.'
      if (!existsSync(pythonPath)) return 'Python 실행 파일을 찾을 수 없습니다.'
      return null
    },
    runAnalyze: async (filePath: string) => {
      const cfgPath = join(tmpdir(), `audioforge_reflib_analyze_${randomUUID()}.json`)
      try {
        const scriptPath = PythonRunner.getScriptPath('separate.py')
        writeFileSync(cfgPath, JSON.stringify({
          mode: 'ref-analyze', input: filePath, output: dirname(filePath)
        }), 'utf-8')
        return await runPreview({
          runner: new PythonRunner(pythonPath, runnerDeps),
          scriptPath, args: ['--config', cfgPath],
          timeoutMs: 60000,
          cleanup: () => { try { unlinkSync(cfgPath) } catch { /* noop */ } }
        })
      } finally {
        try { unlinkSync(cfgPath) } catch { /* noop */ }
      }
    },
    runTrim: async (filePath: string, startSec: number, durSec: number, outDir: string) => {
      const cfgPath = join(tmpdir(), `audioforge_reflib_trim_${randomUUID()}.json`)
      try {
        mkdirSync(outDir, { recursive: true })
        const scriptPath = PythonRunner.getScriptPath('separate.py')
        writeFileSync(cfgPath, JSON.stringify({
          mode: 'ref-trim', input: filePath, output: outDir,
          regionStart: startSec, regionDur: durSec
        }), 'utf-8')
        return await runPreview({
          runner: new PythonRunner(pythonPath, runnerDeps),
          scriptPath, args: ['--config', cfgPath],
          timeoutMs: 60000,
          cleanup: () => { try { unlinkSync(cfgPath) } catch { /* noop */ } }
        })
      } finally {
        try { unlinkSync(cfgPath) } catch { /* noop */ }
      }
    },
  }

  // 감정 샘플 실행 — 기존 tts 모드·기존 PythonRunner 를 그대로 쓴다.
  // generation-limit·watchdog·timeout·CPU/GPU 정책은 건드리지 않는다.
  const runSamplerTts = async (job: SamplerJob): Promise<SamplerRunOutcome> => {
    if (runner?.isRunning) return { kind: 'error', code: 'BUSY' }
    if (!existsSync(pythonPath)) return { kind: 'error', code: 'NO_PYTHON' }
    const cfgPath = join(tmpdir(), `audioforge_sampler_${randomUUID()}.json`)
    try {
      const scriptPath = PythonRunner.getScriptPath('separate.py')
      writeFileSync(cfgPath, JSON.stringify({
        mode: 'tts', input: job.referenceAudioPath, output: job.stagingDir,
        ...buildTtsConfig({
          ttsText: job.script,
          ttsReferenceOverride: job.referenceAudioPath,
          ttsReferencePrompts: {
            default: { manualText: job.referenceText, promptLang: job.referenceLanguage, mode: 'manual' },
          },
        })
      }), 'utf-8')
      const res = await runPreview({
        runner: new PythonRunner(pythonPath, runnerDeps),
        scriptPath, args: ['--config', cfgPath],
        timeoutMs: 600000,
        cleanup: () => { try { unlinkSync(cfgPath) } catch { /* noop */ } }
      })
      if (res.status === 'failed' || res.status === 'error') return { kind: 'error' }
      const out = typeof res.output_path === 'string' ? res.output_path
        : join(job.stagingDir, 'synthesized.wav')
      return existsSync(out) ? { kind: 'success', outputPath: out } : { kind: 'no-result' }
    } catch {
      return { kind: 'error' }
    } finally {
      try { unlinkSync(cfgPath) } catch { /* noop */ }
    }
  }

  return {
    reference: referenceAdapter,
    runSamplerTts,
    busyReason: () => (runner?.isRunning ? '다른 작업이 진행 중입니다.' : null),
  }
}
