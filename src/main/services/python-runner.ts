import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { EventEmitter } from 'events'

export class PythonRunner extends EventEmitter {
  private process: ChildProcess | null = null
  private pythonPath: string

  constructor(pythonPath: string = 'python') {
    super()
    this.pythonPath = pythonPath
  }

  run(scriptPath: string, args: string[]): void {
    if (this.process) {
      this.cancel()
    }

    console.log(`[PythonRunner] Spawning: ${this.pythonPath} ${scriptPath} ${args.join(' ')}`)

    try {
      this.process = spawn(this.pythonPath, ['-X', 'utf8', '-u', scriptPath, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          PYTHONUTF8: '1',
          TORCHAUDIO_BACKEND: 'soundfile'
        },
        windowsHide: true
      })
    } catch (err: any) {
      this.emit('error', `Python 실행 실패: ${err.message}`)
      return
    }

    let stderrBuffer = ''

    this.process.stdout?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8')
      const lines = text.split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const msg = JSON.parse(line.trim())
          if (msg.type === 'progress' || msg.type === 'status') {
            this.emit('progress', { percent: msg.percent ?? 0, message: msg.message ?? '' })
          } else if (msg.type === 'result') {
            this.emit('result', msg)
          } else if (msg.type === 'error') {
            this.emit('error', msg.message)
          }
        } catch {
          // Non-JSON output (e.g., tqdm progress bars), ignore
          console.log(`[PythonRunner stdout] ${line}`)
        }
      }
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8')
      stderrBuffer += text
      console.log(`[PythonRunner stderr] ${text.trim()}`)
    })

    this.process.on('close', (code) => {
      console.log(`[PythonRunner] Process exited with code ${code}`)
      this.process = null
      if (code !== 0 && code !== null) {
        // Extract meaningful error from stderr
        const errorMsg = this.extractError(stderrBuffer) || `프로세스가 코드 ${code}로 종료되었습니다`
        this.emit('error', errorMsg)
      }
      this.emit('done', code)
    })

    this.process.on('error', (err) => {
      console.log(`[PythonRunner] Spawn error: ${err.message}`)
      this.process = null
      this.emit('error', `Python 실행 실패: ${err.message}`)
      this.emit('done', -1)
    })
  }

  private extractError(stderr: string): string {
    // Try to find the last meaningful error line
    const lines = stderr.trim().split('\n').filter(Boolean)

    // Look for common Python errors
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (line.startsWith('ModuleNotFoundError:')) return `패키지 미설치: ${line}`
      if (line.startsWith('ImportError:')) return `Import 오류: ${line}`
      if (line.startsWith('FileNotFoundError:')) return `파일 없음: ${line}`
      if (line.startsWith('RuntimeError:')) return line
      if (line.startsWith('Error:') || line.startsWith('error:')) return line
    }

    // Return last 3 lines if nothing specific found
    return lines.slice(-3).join('\n')
  }

  cancel(): void {
    if (this.process) {
      this.process.kill()
      this.process = null
    }
  }

  get isRunning(): boolean {
    return this.process !== null
  }

  static getScriptPath(scriptName: string): string {
    // Try project root /python first (development)
    const devPath = join(__dirname, '..', '..', 'python', scriptName)
    if (existsSync(devPath)) return devPath

    // Try resources path (production)
    if (process.resourcesPath) {
      const prodPath = join(process.resourcesPath, 'python', scriptName)
      if (existsSync(prodPath)) return prodPath
    }

    return devPath // fallback, will fail with clear error
  }
}
