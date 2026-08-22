import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { EventEmitter } from 'events'
import { StringDecoder } from 'string_decoder'

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
    // Line buffer: a JSON line can be split across pipe chunks (~64KB).
    // Keep the trailing incomplete line and prepend it to the next chunk.
    // StringDecoder handles multi-byte UTF-8 chars split across chunk boundaries.
    let stdoutBuffer = ''
    const stdoutDecoder = new StringDecoder('utf-8')

    const handleLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        const msg = JSON.parse(trimmed)
        if (msg.type === 'progress' || msg.type === 'status') {
          this.emit('progress', { percent: msg.percent ?? 0, message: msg.message ?? '' })
        } else if (msg.type === 'result') {
          this.emit('result', msg)
        } else if (msg.type === 'error') {
          // 구조화 오류 전체 전달(message + 선택적 code·필드). renderer용 정제는 audio.ipc가 담당.
          // Python이 담는 필드는 이미 비민감(전사·문장·전체경로 없음)이지만, 소비 측이 최종 정제.
          this.emit('error', msg)
        }
      } catch {
        // Non-JSON output (e.g., tqdm progress bars), ignore
        console.log(`[PythonRunner stdout] ${trimmed}`)
      }
    }

    this.process.stdout?.on('data', (data: Buffer) => {
      stdoutBuffer += stdoutDecoder.write(data)
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8')
      stderrBuffer += text
      console.log(`[PythonRunner stderr] ${text.trim()}`)
    })

    this.process.on('close', (code) => {
      console.log(`[PythonRunner] Process exited with code ${code}`)
      // Flush a final line that had no trailing newline
      stdoutBuffer += stdoutDecoder.end()
      if (stdoutBuffer) {
        handleLine(stdoutBuffer)
        stdoutBuffer = ''
      }
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

  // 취소: 프로세스 트리를 kill하고 '자식 종료(close)'를 bounded timeout 내에서 확인한다.
  //  - resolve(true): timeout 내 child close 관측(트리 종료 확인). run()의 close 핸들러가 done을 발생시킨다.
  //  - resolve(false): timeout 초과 → 종료 미확인(취소 실패). this.process를 null로 만들지 않는다
  //    (isRunning=true로 '자식 생존'을 표면화). child 종료를 가정하지 않는다.
  //  this.process는 여기서 null로 만들지 않는다 — run()의 'close' 핸들러가 관리(그래야 done 경로가 그대로 동작).
  cancel(timeoutMs: number = 8000): Promise<boolean> {
    const proc = this.process
    if (!proc) return Promise.resolve(true)
    const pid = proc.pid
    // E2E 시임(AF_E2E=1에서만): kill 실패를 재현하려면 실제 kill을 건너뛴다(트리는 fixture가 자진 종료).
    const g = globalThis as unknown as { __afSimulateKillFail?: boolean }
    const simulateKillFail = process.env.AF_E2E === '1' && g.__afSimulateKillFail === true
    return new Promise<boolean>((resolve) => {
      let done = false
      const finish = (ok: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        proc.removeListener('close', onClose)
        resolve(ok)
      }
      const onClose = () => finish(true)
      const timer = setTimeout(() => finish(false), timeoutMs)
      proc.once('close', onClose)
      if (simulateKillFail) return  // kill 요청 자체를 생략 → close 없음 → timeout(false)
      // Windows: kill()은 부모 python만 종료 → 자식(ffmpeg, 격리 venv 등) 잔존 → taskkill /T로 트리 전체 종료.
      if (process.platform === 'win32' && pid) {
        try {
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
        } catch {
          try { proc.kill() } catch { /* noop */ }
        }
      } else {
        try { proc.kill() } catch { /* noop */ }
      }
    })
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
