import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'
import { join, basename, dirname, extname } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { PythonRunner } from '../services/python-runner'

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
        { name: 'Audio', extensions: ['m4a', 'mp3', 'wav', 'flac', 'ogg', 'aac', 'wma'] }
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

  ipcMain.handle('audio:process', async (_event, filePath: string, mode: string, options?: { trimSilence?: boolean; silenceGap?: number; transcribe?: boolean; translate?: boolean; exportSrt?: boolean; outputFormat?: string }) => {
    if (runner?.isRunning) {
      throw new Error('이미 처리 중인 작업이 있습니다')
    }

    // Verify python exists
    if (!existsSync(pythonPath)) {
      sendError(`Python을 찾을 수 없습니다: ${pythonPath}`)
      return null
    }

    // Build output directory: timestamp + filename
    const ext = extname(filePath)
    const nameWithoutExt = basename(filePath, ext)
    const now = new Date()
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`
    const outputDir = join(dirname(filePath), 'AudioForge_output', `${timestamp}_${nameWithoutExt}`)
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })

    // Resolve script path
    const scriptPath = PythonRunner.getScriptPath('separate.py')
    if (!existsSync(scriptPath)) {
      sendError(`Python 스크립트를 찾을 수 없습니다: ${scriptPath}`)
      return null
    }

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

    // Timeout: if no progress within 5 min (Whisper model loading can be slow)
    const timeoutMs = options?.transcribe ? 300000 : 120000
    const timeout = setTimeout(() => {
      if (runner?.isRunning) {
        runner.cancel()
        sendError(`처리 시간이 초과되었습니다. Python 환경을 확인해주세요.`)
      }
    }, timeoutMs)

    runner.on('done', () => {
      clearTimeout(timeout)
      runner = null
    })

    runner.on('progress', () => {
      // Reset timeout on any progress
      clearTimeout(timeout)
    })

    const args = ['--mode', mode, '--input', filePath, '--output', outputDir]
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

    runner.run(scriptPath, args)
    return { outputDir }
  })

  ipcMain.handle('audio:cancel', () => {
    runner?.cancel()
    runner = null
    return true
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
