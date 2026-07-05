import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, basename, dirname, extname } from 'path'
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { PythonRunner } from '../services/python-runner'

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
  // Helper to send error to renderer
  const sendError = (message: string) => {
    mainWindow.webContents.send('audio:error', { message })
  }

  ipcMain.handle('audio:select-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'Audio/Video', extensions: ['m4a', 'mp3', 'wav', 'flac', 'ogg', 'aac', 'wma', 'mp4', 'mkv', 'avi', 'mov', 'webm'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('audio:get-file-info', async (_event, filePath: string) => {
    if (!existsSync(filePath)) {
      throw new Error(`파일을 찾을 수 없습니다: ${basename(filePath)}`)
    }
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
      ttsText: options?.ttsText || '',
      ttsSpeed: options?.ttsSpeed || 1.0,
      ttsSilenceGap: options?.ttsSilenceGap || 0.5,
      ttsEngine: options?.ttsEngine || 'auto'
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    console.log(`[AudioForge] Config written to: ${configPath}`)

    runner = new PythonRunner(pythonPath)

    runner.on('progress', (data) => {
      mainWindow.webContents.send('audio:progress', data)
    })

    runner.on('result', (data) => {
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
    }
  })

  ipcMain.handle('settings:select-python-path', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Python', extensions: ['exe'] }]
    })
    if (result.canceled) return null
    pythonPath = result.filePaths[0]
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
