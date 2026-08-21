import { ipcMain, dialog, BrowserWindow, shell, app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, basename, dirname, extname, resolve } from 'path'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { PythonRunner } from '../services/python-runner'
import { createSettlementGuard } from '../services/run-settlement'
import { createPreviewGuard, runPreview } from '../services/preview-transcribe'
import { buildTtsConfig, type TtsInputOptions } from '../../shared/ttsConfig'
import { sweepQwenJobDirs } from '../services/qwen-cleanup'
import { removeRefClipDir, sweepRefClipDirs } from '../services/refclip-cleanup'
import { createSingleFlight, createKeyedSingleFlight } from '../services/single-flight'

// execFile(배열 인자)은 cmd.exe를 거치지 않아 시스템 코드페이지(CP949)의
// 한글 경로 손상 문제에 면역. exec(문자열)은 한글 파일명에서 깨짐 → 금지.
const execFileAsync = promisify(execFile)

// ffprobe path (winget install location)
const FFPROBE_PATHS = [
  'ffprobe',
  join(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1-full_build/bin/ffprobe.exe')
]

// AI 패키지가 설치된 Python을 참조 (의존 대상은 ComfyUI 앱이 아니라 그 패키지들).
// 우선순위: externals/env.json(setup_env.py가 기록) → 하드코딩 기본값 → 시스템 python.
const DEFAULT_PYTHON = 'E:/AI/ComfyUI_windows_portable_python3.12/python_embeded/python.exe'

function resolvePythonPath(): string {
  // 1. setup_env.py가 해석해 기록한 경로
  try {
    const cfg = join(__dirname, '..', '..', 'externals', 'env.json')
    if (existsSync(cfg)) {
      const p = JSON.parse(readFileSync(cfg, 'utf-8')).python
      if (p && existsSync(p)) return p
    }
  } catch { /* fall through */ }
  // 2. 하드코딩 기본값(ComfyUI 임베디드) — 있으면
  if (existsSync(DEFAULT_PYTHON)) return DEFAULT_PYTHON
  // 3. 시스템 python
  return 'python'
}

// L-6: 사용자가 고른 python 경로를 userData/settings.json에 영속화 → 재시작 후에도 유지.
// (app.getPath는 ready 이후에만 안전하므로 여기서 함수로만 정의하고 호출은 registerAudioIpc 내부에서)
function settingsFilePath(): string {
  return join(app.getPath('userData'), 'settings.json')
}
function loadSettings(): Record<string, unknown> {
  try {
    const f = settingsFilePath()
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf-8'))
  } catch { /* ignore */ }
  return {}
}
function saveSetting(key: string, value: unknown): void {
  try {
    const s = loadSettings()
    s[key] = value
    writeFileSync(settingsFilePath(), JSON.stringify(s, null, 2), 'utf-8')
  } catch (err) {
    console.log(`[AudioForge] 설정 저장 실패: ${(err as Error).message}`)
  }
}
function savePythonPath(p: string): void { saveSetting('pythonPath', p) }

let runner: PythonRunner | null = null
let trackRunner: PythonRunner | null = null
let pythonPath = resolvePythonPath()
// 현재 유효한 파생 참조 클립 폴더(tmpdir/audioforge_refclip_*). 새 클립/새 파일/합성 종료 시 정리.
let currentRefClipDir: string | null = null

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

export function registerAudioIpc(mainWindow: BrowserWindow): void {
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
  // 앱 종료: 남은 파생 참조 폴더 정리.
  app.on('will-quit', () => { try { sweepRefClipDirs(tmpdir()) } catch { /* noop */ } })

  const releaseRefClip = () => {
    if (currentRefClipDir) { removeRefClipDir(tmpdir(), currentRefClipDir); currentRefClipDir = null }
  }

  // Helper to send error to renderer
  const sendError = (message: string) => {
    mainWindow.webContents.send('audio:error', { message })
  }

  // 배타 가드는 '중복 실행을 막아야 하는' 쓰기성 작업에만. 읽기 전용 analyze/preflight는 쓰지 않는다.
  //  - transcriptPreviewGuard: 참조 전사 미리보기(Whisper)
  //  - referenceTrimGuard: 참조 구간 트림(파생 클립 생성)
  // 둘은 서로 다른 가드라 서로를 차단하지 않고, analyze/preflight도 차단하지 않는다.
  const transcriptPreviewGuard = createPreviewGuard()
  const referenceTrimGuard = createPreviewGuard()

  // 읽기 전용 작업 single-flight — StrictMode 중복 effect/동시 요청에도 subprocess는 1회.
  const qwenPreflightSF = createSingleFlight<unknown>()
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
        runner: new PythonRunner(pythonPath),
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
  ipcMain.handle('audio:analyze-reference', async (_event, filePath: string) => {
    if (runner?.isRunning) throw new Error('처리 중에는 참조 분석을 실행할 수 없습니다.')
    if (!existsSync(pythonPath)) throw new Error(`Python을 찾을 수 없습니다: ${pythonPath}`)
    if (!existsSync(filePath)) throw new Error(`참조 파일을 찾을 수 없습니다: ${filePath}`)
    const key = resolve(filePath)
    if (!analyzeSF.has(key)) releaseRefClip()  // 새 분석 시작일 때만 이전 파생 클립 폐기(중복 요청엔 안 함)
    return analyzeSF.run(key, async () => {  // 동시/StrictMode 중복은 진행 중 Promise 공유(subprocess 1회)
      const cfgPath = join(tmpdir(), `audioforge_refanalyze_${randomUUID()}.json`)
      try {
        const scriptPath = PythonRunner.getScriptPath('separate.py')
        writeFileSync(cfgPath, JSON.stringify({ mode: 'ref-analyze', input: filePath, output: dirname(filePath) }), 'utf-8')
        return await runPreview({
          runner: new PythonRunner(pythonPath),
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
  ipcMain.handle('audio:trim-reference', async (_event, filePath: string, startSec: number, durSec: number) => {
    if (runner?.isRunning) throw new Error('처리 중에는 참조 트림을 실행할 수 없습니다.')
    if (!existsSync(pythonPath)) throw new Error(`Python을 찾을 수 없습니다: ${pythonPath}`)
    if (!existsSync(filePath)) throw new Error(`참조 파일을 찾을 수 없습니다: ${filePath}`)
    releaseRefClip()  // 재확정 → 이전 파생 클립 폐기(합성 중 아님: 위에서 차단)
    referenceTrimGuard.begin()  // 트림 중복 실행 방지(전사 가드와 분리 — 서로 차단하지 않음)
    const uid = randomUUID()
    const cfgPath = join(tmpdir(), `audioforge_reftrim_${uid}.json`)
    const outDir = join(tmpdir(), `audioforge_refclip_${uid}`)  // 작업 임시폴더(프로젝트 밖), 충돌 불가 UID
    currentRefClipDir = outDir  // 새 파생 클립 폴더 추적(합성 종료/새 파일/재확정 시 정리)
    try {
      mkdirSync(outDir, { recursive: true })
      const scriptPath = PythonRunner.getScriptPath('separate.py')
      writeFileSync(cfgPath, JSON.stringify({
        mode: 'ref-trim', input: filePath, output: outDir,
        regionStart: startSec, regionDur: durSec
      }), 'utf-8')
      return await runPreview({
        runner: new PythonRunner(pythonPath),
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
          runner: new PythonRunner(pythonPath),
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

  ipcMain.handle('audio:process', async (_event, filePath: string, mode: string, options?: Record<string, unknown>) => {
    if (runner?.isRunning) {
      throw new Error('이미 처리 중인 작업이 있습니다')
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

    // Resolve script path
    const scriptPath = PythonRunner.getScriptPath('separate.py')
    if (!existsSync(scriptPath)) {
      throw new Error(`Python 스크립트를 찾을 수 없습니다: ${scriptPath}`)
    }

    // Build output directory
    const ext = extname(filePath)
    const nameWithoutExt = basename(filePath, ext)
    const now = new Date()
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`
    const outputDir = join(dirname(filePath), 'AudioForge_output', `${timestamp}_${nameWithoutExt}`)
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })
    // 방어적: 이 output_dir에 이전 실행이 남긴 Qwen 실행별 임시폴더가 있으면 시작 전에 정리
    // (신규 dir이라 보통 없음). 안전 범위 = 이 output_dir 바로 아래 .qwen-job-* 폴더만.
    if (mode === 'tts') { try { sweepQwenJobDirs(outputDir) } catch { /* noop */ } }

    // Write all options to JSON config file (avoids spawn encoding issues with Korean paths)
    const configPath = join(tmpdir(), `audioforge_config_${Date.now()}.json`)
    const config = {
      mode,
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
      ...buildTtsConfig(options as TtsInputOptions | undefined)
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    console.log(`[AudioForge] Config written to: ${configPath}`)

    runner = new PythonRunner(pythonPath)

    // 종료 시 UI가 'processing'에 남지 않도록: result/error/watchdog 중 하나로 반드시 '정착'.
    // 어느 것도 없이 프로세스가 끝나면(예: 외부 kill, 코드 0인데 result 미도달) done에서 오류로 마감.
    const settle = createSettlementGuard(sendError)

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
        ;(data as { metadata?: unknown }).metadata = md
      }
      // 세션 매니페스트 저장 — 나중에 재분리 없이 설정+트랙 복원용 (source of truth)
      try {
        const tracks = Array.isArray((data as { tracks?: unknown[] })?.tracks)
          ? (data as { tracks: { name?: string; label?: string; path?: string }[] }).tracks.map(t => ({ name: t.name, label: t.label, path: t.path }))
          : []
        const session = {
          version: 1,
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
      mainWindow.webContents.send('audio:result', data)
    })

    runner.on('error', (message) => {
      settle.markSettled()
      sendError(typeof message === 'string' ? message : String(message))
    })

    // Watchdog: kill if no progress for 5 minutes
    const WATCHDOG_MS = 300000
    let watchdog: ReturnType<typeof setTimeout> | null = null

    const resetWatchdog = () => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        if (runner?.isRunning) {
          settle.markSettled()
          runner.cancel()
          sendError('처리 시간이 초과되었습니다 (5분간 응답 없음). Python 환경을 확인해주세요.')
        }
      }, WATCHDOG_MS)
    }

    resetWatchdog()

    runner.on('done', (code) => {
      if (watchdog) clearTimeout(watchdog)
      // 정착 신호(result/error/watchdog)가 없었으면 여기서 오류로 마감 → UI가 processing에 안 남음.
      settle.finish(code)
      // Clean up config file
      try { unlinkSync(configPath) } catch {}
      // 'done'은 자식 프로세스 실제 종료 후 발생(취소 taskkill 포함). 정상 성공 시 Python finally가
      // 이미 .qwen-job-*를 지웠으므로 no-op이고, 취소로 finally가 안 돈 경우 남은 실행별 폴더를 제거.
      if (mode === 'tts') {
        try { sweepQwenJobDirs(outputDir) } catch { /* noop */ }
        // 합성 종료(성공/오류/취소) → worker가 참조 사용을 끝냈으므로 파생 참조 클립 폴더 정리.
        releaseRefClip()
      }
      runner = null
    })

    runner.on('progress', () => {
      resetWatchdog()
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
    if (trackRunner?.isRunning) {
      throw new Error('이미 처리 중인 트랙 작업이 있습니다')
    }
    if (!existsSync(pythonPath)) {
      throw new Error(`Python을 찾을 수 없습니다: ${pythonPath}`)
    }
    const scriptPath = PythonRunner.getScriptPath('separate.py')
    if (!existsSync(scriptPath)) {
      throw new Error(`Python 스크립트를 찾을 수 없습니다: ${scriptPath}`)
    }

    trackRunner = new PythonRunner(pythonPath)

    // Korean paths must never be passed as spawn args (CP949 corruption) —
    // same JSON config approach as 'audio:process'
    const configPath = join(tmpdir(), `audioforge_track_${Date.now()}.json`)
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

    // Watchdog: kill if no progress for 5 minutes (same policy as main runner)
    const WATCHDOG_MS = 300000
    let watchdog: ReturnType<typeof setTimeout> | null = null
    const sendTrackError = (message: string) => {
      mainWindow.webContents.send('audio:track-error', { message, trackPath })
    }
    const resetWatchdog = () => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        if (trackRunner?.isRunning) {
          trackRunner.cancel()
          sendTrackError('트랙 처리 시간이 초과되었습니다 (5분간 응답 없음).')
        }
      }, WATCHDOG_MS)
    }
    resetWatchdog()

    trackRunner.on('done', () => {
      if (watchdog) clearTimeout(watchdog)
      try { unlinkSync(configPath) } catch {}
      trackRunner = null
    })

    trackRunner.on('progress', (data) => {
      resetWatchdog()
      mainWindow.webContents.send('audio:progress', data)
    })
    trackRunner.on('result', (data) => {
      mainWindow.webContents.send('audio:track-result', data)
    })
    trackRunner.on('error', (message) => {
      sendTrackError(typeof message === 'string' ? message : String(message))
    })

    trackRunner.run(scriptPath, ['--config', configPath])
    return { outputDir }
  })

  ipcMain.handle('audio:cancel', () => {
    runner?.cancel()
    runner = null
    trackRunner?.cancel()
    trackRunner = null
    return true
  })

  // 파일 reset/변경 시 렌더러가 호출 — 유효 파생 참조 클립 폴더 정리(합성 중이면 건드리지 않음).
  ipcMain.handle('audio:release-reference-clip', () => {
    if (runner?.isRunning) return false  // 합성 worker가 참조 사용 중 → 삭제 금지
    releaseRefClip()
    return true
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
      return { dir: matches[0].dir, session: matches[0].session }
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

    return { tracks, outputDir: dir }
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
    return { pythonPath }
  })

  ipcMain.handle('settings:set', (_event, key: string, value: unknown) => {
    if (key === 'pythonPath' && typeof value === 'string') {
      pythonPath = value
      savePythonPath(value)  // L-6: 영속화
    }
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
}
