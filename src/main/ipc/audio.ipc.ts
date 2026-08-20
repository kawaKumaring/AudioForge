import { ipcMain, dialog, BrowserWindow, shell, app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, basename, dirname, extname } from 'path'
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { PythonRunner } from '../services/python-runner'
import { buildTtsConfig, type TtsInputOptions } from '../../shared/ttsConfig'

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

  // Helper to send error to renderer
  const sendError = (message: string) => {
    mainWindow.webContents.send('audio:error', { message })
  }

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

  ipcMain.handle('audio:process', async (_event, filePath: string, mode: string, options?: Record<string, unknown>) => {
    if (runner?.isRunning) {
      throw new Error('이미 처리 중인 작업이 있습니다')
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

    runner.on('progress', (data) => {
      mainWindow.webContents.send('audio:progress', data)
    })

    runner.on('result', (data) => {
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
          createdAt: new Date().toISOString()
        }
        writeFileSync(join(outputDir, 'session.json'), JSON.stringify(session, null, 2), 'utf-8')
      } catch (err) {
        console.log(`[AudioForge] session.json 저장 실패: ${(err as Error).message}`)
      }
      mainWindow.webContents.send('audio:result', data)
    })

    runner.on('error', (message) => {
      sendError(typeof message === 'string' ? message : String(message))
    })

    // Watchdog: kill if no progress for 5 minutes
    const WATCHDOG_MS = 300000
    let watchdog: ReturnType<typeof setTimeout> | null = null

    const resetWatchdog = () => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        if (runner?.isRunning) {
          runner.cancel()
          sendError('처리 시간이 초과되었습니다 (5분간 응답 없음). Python 환경을 확인해주세요.')
        }
      }, WATCHDOG_MS)
    }

    resetWatchdog()

    runner.on('done', () => {
      if (watchdog) clearTimeout(watchdog)
      // Clean up config file
      try { unlinkSync(configPath) } catch {}
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
