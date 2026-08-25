import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { EventEmitter } from 'events'
import { StringDecoder } from 'string_decoder'
import { diagnoseExit } from './runner-diagnostics'

// 취소 결과(공용 마감 K2): 부모 종료 관측 + (Windows) taskkill 완료·성공까지 확인해야 tree 종료로 판정.
export interface CancelResult {
  parentExited: boolean        // 대상 Python 프로세스 'close' 관측
  treeKillConfirmed: boolean   // Windows: parentExited && taskkill 'close' && exit 0. 비-Windows: parentExited(best-effort)
  timedOut: boolean            // bounded 대기 초과
  reason?: string              // 비민감 사유(코드/이벤트만 — 경로·명령줄 없음)
}

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
    // 진단 수집(공용 마감 R3-C): close 시점에 '구조화 stdout 신호가 왔는지'를 알아야
    // 무해 경고를 실패 원인으로 표면화하지 않고 이중 emit도 피한다. 구조화 신호가 권위.
    let hadStructuredResult = false
    let hadStructuredError = false
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
          hadStructuredResult = true
          this.emit('result', msg)
        } else if (msg.type === 'error') {
          // 구조화 오류 전체 전달(message + 선택적 code·필드). renderer용 정제는 audio.ipc가 담당.
          // Python이 담는 필드는 이미 비민감(전사·문장·전체경로 없음)이지만, 소비 측이 최종 정제.
          hadStructuredError = true
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

    this.process.on('close', (code, signal) => {
      console.log(`[PythonRunner] Process exited with code ${code} signal ${signal}`)
      // Flush a final line that had no trailing newline
      stdoutBuffer += stdoutDecoder.end()
      if (stdoutBuffer) {
        handleLine(stdoutBuffer)
        stdoutBuffer = ''
      }
      this.process = null
      // 종료 진단(R3-C): 구조화 stdout 신호가 권위이므로 그게 왔으면 여기서 재표면화하지 않는다.
      // 무해 경고(*Warning:)만으로 fatal 금지, signal→PYTHON_PROCESS_SIGNAL, nonzero+fatal없음→ABNORMAL_EXIT.
      // renderer로는 { message: 안전 안내, code: reasonCode }만. traceback·절대경로·sha8/length는 devLog(로컬 console)만.
      const diag = diagnoseExit({
        code,
        signal,
        stderr: stderrBuffer,
        hadStructuredError,
        hadStructuredResult
      })
      if (diag) {
        console.log(`[PythonRunner][diag] ${diag.devLog}`)
        this.emit('error', { message: diag.userMessage, code: diag.reasonCode })
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

  // 취소: 프로세스 트리를 kill하고 종료를 bounded timeout 내에서 '확인'한다(공용 마감 K2).
  //  Windows 성공(treeKillConfirmed) = 대상 Python 'close' 관측 AND taskkill 프로세스 'close' AND exit 0.
  //  taskkill을 fire-and-forget으로 두지 않는다 — parent만 닫히고 트리가 아직 종료 중이면 성공으로 오판하지 않도록.
  //  실패 구분: taskkill spawn error / nonzero exit / parent close timeout / taskkill 완료 timeout → treeKillConfirmed=false.
  //  this.process는 여기서 null로 만들지 않는다 — run()의 'close' 핸들러가 관리(그래야 done 경로가 그대로 동작).
  cancel(timeoutMs: number = 8000): Promise<CancelResult> {
    const proc = this.process
    if (!proc) return Promise.resolve({ parentExited: true, treeKillConfirmed: true, timedOut: false, reason: 'no-process' })
    const pid = proc.pid
    const isWin = process.platform === 'win32'
    // E2E 시임(AF_E2E=1에서만): kill 실패를 재현하려면 실제 kill을 건너뛴다(트리는 fixture가 자진 종료).
    const g = globalThis as unknown as { __afSimulateKillFail?: boolean }
    const simulateKillFail = process.env.AF_E2E === '1' && g.__afSimulateKillFail === true
    return new Promise<CancelResult>((resolve) => {
      let settled = false
      let parentExited = false
      let taskkillDone = !isWin           // 비-Windows는 taskkill 개념 없음 → 완료로 간주
      let taskkillOk = !isWin
      let reason: string | undefined
      const finalize = (timedOut: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        proc.removeListener('close', onParentClose)
        const treeKillConfirmed = isWin
          ? (parentExited && taskkillDone && taskkillOk)   // 트리 종료 명령 성공 + 부모 종료 확인
          : parentExited                                    // 비-Windows: best-effort
        resolve({ parentExited, treeKillConfirmed, timedOut, reason })
      }
      const maybeDone = () => { if (parentExited && taskkillDone) finalize(false) }
      const onParentClose = () => { parentExited = true; maybeDone() }
      proc.once('close', onParentClose)
      const timer = setTimeout(() => finalize(true), timeoutMs)
      if (simulateKillFail) return  // kill 생략 → parent close 없음 → timeout(treeKillConfirmed=false)
      if (isWin && pid) {
        let tk
        try {
          tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
        } catch (e) {
          // taskkill 자체를 못 띄움 → fallback kill(부모만). 트리 확인 불가 → taskkillOk=false 유지.
          reason = `taskkill-spawn-failed:${(e as Error)?.name || 'error'}`
          taskkillDone = true; taskkillOk = false
          try { proc.kill() } catch { /* noop */ }
          maybeDone()
          return
        }
        tk.on('close', (code) => {
          taskkillDone = true
          taskkillOk = code === 0
          if (code !== 0) reason = `taskkill-exit-${code}`
          maybeDone()
        })
        tk.on('error', (e) => {
          taskkillDone = true; taskkillOk = false
          reason = `taskkill-error:${(e as Error)?.name || 'error'}`
          try { proc.kill() } catch { /* noop */ }
          maybeDone()
        })
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
