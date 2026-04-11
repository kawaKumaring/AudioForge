import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'
import { join, basename, dirname, extname } from 'path'
import { existsSync, mkdirSync, copyFileSync, readdirSync, renameSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { PythonRunner } from '../services/python-runner'

// Create ASCII-safe temp paths for Python (avoids spawn encoding issues with Korean paths)
function createSafePaths(filePath: string): { safePath: string; safeOutputDir: string; realOutputDir: string; cleanup: () => void } {
  const ext = extname(filePath)
  const nameWithoutExt = basename(filePath, ext)
  const now = new Date()
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`

  // Real output dir (may have Korean chars)
  const realOutputDir = join(dirname(filePath), 'AudioForge_output', `${timestamp}_${nameWithoutExt}`)
  if (!existsSync(realOutputDir)) mkdirSync(realOutputDir, { recursive: true })

  // Check if path is ASCII-safe
  const isAscii = /^[\x00-\x7F]*$/.test(filePath)
  if (isAscii) {
    return { safePath: filePath, safeOutputDir: realOutputDir, realOutputDir, cleanup: () => {} }
  }

  // Copy to temp ASCII dir
  const tempBase = join(tmpdir(), `audioforge_${Date.now()}`)
  mkdirSync(tempBase, { recursive: true })
  const safePath = join(tempBase, `source${ext}`)
  const safeOutputDir = join(tempBase, 'output')
  mkdirSync(safeOutputDir, { recursive: true })
  copyFileSync(filePath, safePath)

  return {
    safePath,
    safeOutputDir,
    realOutputDir,
    cleanup: () => {
      // Move results from safe output to real output
      try {
        if (existsSync(safeOutputDir)) {
          for (const f of readdirSync(safeOutputDir)) {
            const src = join(safeOutputDir, f)
            const dst = join(realOutputDir, f)
            try {
              renameSync(src, dst)
            } catch {
              // Cross-drive rename fails on Windows — fallback to copy+delete
              copyFileSync(src, dst)
              unlinkSync(src)
            }
          }
        }
        // Clean temp
        const { rmSync } = require('fs')
        rmSync(tempBase, { recursive: true, force: true })
      } catch { /* ignore cleanup errors */ }
    }
  }
}

const execAsync = promisify(exec)

// ffprobe path (winget install location)
const FFPROBE_PATHS = [
  'ffprobe',
  join(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1-full_build/bin/ffprobe.exe')
]

// Python path: use ComfyUI's Python 3.12 with CUDA + torch + demucs
const DEFAULT_PYTHON = 'E:/AI/ComfyUI_windows_portable_python3.12/python_embeded/python.exe'

let runner: PythonRunner | null = null
let pythonPath = existsSync(DEFAULT_PYTHON) ? DEFAULT_PYTHON : 'python'

let cachedFfprobe: string | null = null

async function findFfprobe(): Promise<string> {
  if (cachedFfprobe) return cachedFfprobe
  for (const p of FFPROBE_PATHS) {
    try {
      await execAsync(`"${p}" -version`)
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
    const ffprobe = await findFfprobe()
    const cmd = `"${ffprobe}" -hide_banner -show_entries stream=codec_name,channels,channel_layout,sample_rate,duration -of json "${filePath}"`
    const { stdout } = await execAsync(cmd)
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

    // Create ASCII-safe paths (Korean chars break spawn args on Windows)
    console.log(`[AudioForge] Input path: ${filePath}`)
    const { safePath, safeOutputDir, realOutputDir, cleanup: pathCleanup } = createSafePaths(filePath)
    const outputDir = realOutputDir
    console.log(`[AudioForge] Safe path: ${safePath}`)
    console.log(`[AudioForge] Safe output: ${safeOutputDir}`)
    console.log(`[AudioForge] Real output: ${realOutputDir}`)

    runner = new PythonRunner(pythonPath)

    runner.on('progress', (data) => {
      mainWindow.webContents.send('audio:progress', data)
    })

    runner.on('result', (data) => {
      // Replace safe paths with real paths in result
      if (data && data.tracks) {
        for (const t of data.tracks) {
          if (t.path && t.path.includes(safeOutputDir.replace(/\\/g, '/'))) {
            t.path = t.path.replace(safeOutputDir.replace(/\\/g, '/'), realOutputDir.replace(/\\/g, '/'))
          }
          if (t.path && t.path.includes(safeOutputDir)) {
            t.path = t.path.replace(safeOutputDir, realOutputDir)
          }
        }
        data.outputDir = realOutputDir
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

    resetWatchdog()  // Start initial watchdog

    runner.on('done', () => {
      if (watchdog) clearTimeout(watchdog)
      pathCleanup()  // Move results from temp to real output dir
      runner = null
    })

    runner.on('progress', () => {
      resetWatchdog()  // Reset on every progress — keeps alive
    })

    const args = ['--mode', mode, '--input', safePath, '--output', safeOutputDir,
      '--whisper-model', options?.whisperModel || 'large-v3',
      '--model', options?.demucsModel || 'htdemucs',
      '--n-speakers', String(options?.nSpeakers || 2)]
    if (options?.trimSilence) {
      args.push('--trim-silence')
      args.push('--silence-gap', String(options.silenceGap ?? 0.5))
    }
    if (options?.transcribe || mode === 'transcribe') args.push('--transcribe')
    if (options?.translate) args.push('--translate')
    if (options?.exportSrt) args.push('--srt')
    if (options?.outputFormat && options.outputFormat !== 'wav') {
      args.push('--output-format', options.outputFormat)
    }
    if (mode === 'split' && options?.splitMarkers && options.splitMarkers.length > 0) {
      args.push('--split-points', options.splitMarkers.join(','))
      if (options.splitLabels && options.splitLabels.length > 0) {
        args.push('--split-labels', options.splitLabels.join('|'))
      }
    }

    // Send preparation messages before Python starts
    const modeNames: Record<string, string> = {
      music: '음악 분리', conversation: '대화 분리', transcribe: '텍스트 추출', split: '트랙 분할'
    }
    mainWindow.webContents.send('audio:progress', { percent: 0, message: `${modeNames[mode] || mode} 엔진 시작 중...` })

    runner.run(scriptPath, args)

    // Notify that Python process has been spawned
    setTimeout(() => {
      if (runner?.isRunning) {
        mainWindow.webContents.send('audio:progress', { percent: 1, message: 'Python 프로세스 실행 중... (AI 모델 로딩에 시간이 걸릴 수 있습니다)' })
      }
    }, 2000)

    return { outputDir }
  })

  // Process individual track (transcribe/translate)
  ipcMain.handle('audio:process-track', async (_event, trackPath: string, outputDir: string, options: { transcribe?: boolean; translate?: boolean; srt?: boolean }) => {
    if (!existsSync(pythonPath)) {
      sendError(`Python을 찾을 수 없습니다: ${pythonPath}`)
      return null
    }
    const scriptPath = PythonRunner.getScriptPath('separate.py')
    if (!existsSync(scriptPath)) {
      sendError(`스크립트를 찾을 수 없습니다`)
      return null
    }

    const trackRunner = new PythonRunner(pythonPath)
    const args = ['--mode', 'track-process', '--input', trackPath, '--output', outputDir]
    if (options.transcribe) args.push('--transcribe')
    if (options.translate) args.push('--translate')
    if (options.srt) args.push('--srt')

    trackRunner.on('progress', (data) => {
      mainWindow.webContents.send('audio:progress', data)
    })
    trackRunner.on('result', (data) => {
      mainWindow.webContents.send('audio:track-result', data)
    })
    trackRunner.on('error', (message) => {
      sendError(typeof message === 'string' ? message : String(message))
    })

    trackRunner.run(scriptPath, args)
    return { outputDir }
  })

  ipcMain.handle('audio:cancel', () => {
    runner?.cancel()
    runner = null
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
