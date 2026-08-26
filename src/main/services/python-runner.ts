import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { EventEmitter } from 'events'
import { StringDecoder } from 'string_decoder'
import type { RunEnd, RunEndReasonCode } from './run-settlement'

// 취소 결과(공용 마감 K2): 부모 종료 관측 + (Windows) taskkill 완료·성공까지 확인해야 tree 종료로 판정.
export interface CancelResult {
  parentExited: boolean        // 대상 Python 프로세스 'close' 관측
  treeKillConfirmed: boolean   // Windows: parentExited && taskkill 'close' && exit 0. 비-Windows: parentExited(best-effort)
  timedOut: boolean            // bounded 대기 초과
  reason?: string              // 비민감 사유(코드/이벤트만 — 경로·명령줄 없음)
}

// 테스트 주입용(Electron·실제 프로세스 없이 종료 경로 전수 검증). 기본은 child_process.spawn.
export interface PythonRunnerDeps {
  spawn?: typeof spawn
}

// 한 번의 run()에 묶인 상태. done은 정확히 1회 — 어떤 종료 경로에서도(정상/비정상/신호/spawn 실패).
interface RunScope {
  started: boolean
  ended: boolean
  killRequested: boolean        // 우리가 cancel()로 끝냈는가 → cancelled vs error 구분의 근거
  cleanups: Array<() => void>   // run-scoped 정리(config 파일 등) — 모든 종료 경로에서 finally처럼 1회 실행
}

export class PythonRunner extends EventEmitter {
  private process: ChildProcess | null = null
  private pythonPath: string
  private spawnFn: typeof spawn
  // run() 전에 등록된 cleanup을 첫 run이 이어받도록 초기 scope를 미리 둔다(started=false).
  private scope: RunScope = { started: false, ended: false, killRequested: false, cleanups: [] }

  constructor(pythonPath: string = 'python', deps?: PythonRunnerDeps) {
    super()
    this.pythonPath = pythonPath
    this.spawnFn = deps?.spawn ?? spawn
  }

  /**
   * 이번 실행에만 유효한 정리 작업 등록(임시 config, 임시 복사본 등).
   * 어떤 종료 경로에서도 done 방출 '직전'에 정확히 1회 실행된다(finally 등가).
   * 이미 종료된 뒤에 등록하면 즉시 실행한다 — 등록 시점 때문에 정리가 새는 일이 없도록.
   * 실제 파일 삭제 로직은 소유자(호출부)가 넣는다. 개별 cleanup의 예외는 삼켜 다른 정리를 막지 않는다.
   */
  registerCleanup(fn: () => void): void {
    if (this.scope.ended) {
      this.runCleanup(fn)
      return
    }
    this.scope.cleanups.push(fn)
  }

  private runCleanup(fn: () => void): void {
    try {
      fn()
    } catch (e) {
      console.log(`[PythonRunner] cleanup 실패: ${(e as Error)?.name || 'error'}`)
    }
  }

  // 종료 신호를 '정확히 1회' 방출한다. cleanup → done 순서(소유자가 done을 볼 때 임시물은 이미 정리됨).
  // done의 1번째 인자는 기존 그대로 code(하위 호환), 2번째 인자가 구조화된 RunEnd.
  private finalize(scope: RunScope, end: RunEnd): void {
    if (scope.ended) return
    scope.ended = true
    const pending = scope.cleanups.splice(0)
    for (const fn of pending) this.runCleanup(fn)
    this.emit('done', end.code, end)
  }

  run(scriptPath: string, args: string[]): void {
    if (this.process) {
      this.cancel()
    }

    // 시작 전 등록분(config 삭제 등)은 첫 run이 이어받고, 이전 '실행'의 cleanup은 그 실행이 소유한다.
    const carried = this.scope.started ? [] : this.scope.cleanups
    const scope: RunScope = { started: true, ended: false, killRequested: false, cleanups: carried }
    this.scope = scope

    console.log(`[PythonRunner] Spawning: ${this.pythonPath} ${scriptPath} ${args.join(' ')}`)

    try {
      this.process = this.spawnFn(this.pythonPath, ['-X', 'utf8', '-u', scriptPath, ...args], {
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
      // spawn 자체가 throw — 예전에는 error만 내고 done이 없어 소유자가 러너 참조를 영원히 붙들었다.
      // this.process는 건드리지 않는다(할당 자체가 일어나지 않았다).
      this.emit('error', `Python 실행 실패: ${err.message}`)
      this.finalize(scope, { reasonCode: 'spawn-error-sync', code: -1, signal: null, killedByUs: false })
      return
    }

    // 이 실행의 자식 고정 — 늦게 도착한 옛 자식의 이벤트가 새 실행의 참조를 지우지 못하게(clobber 방지).
    const child = this.process
    const clearIfMine = () => { if (this.process === child) this.process = null }

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

    this.process.on('close', (code, signal) => {
      // spawn 'error'로 이미 마감된 뒤 따라오는 close — 오류/done을 두 번 내지 않는다.
      if (scope.ended) { clearIfMine(); return }
      console.log(`[PythonRunner] Process exited with code ${code}`)
      // Flush a final line that had no trailing newline
      stdoutBuffer += stdoutDecoder.end()
      if (stdoutBuffer) {
        handleLine(stdoutBuffer)
        stdoutBuffer = ''
      }
      clearIfMine()
      if (code !== 0 && code !== null) {
        // Extract meaningful error from stderr
        const errorMsg = this.extractError(stderrBuffer) || `프로세스가 코드 ${code}로 종료되었습니다`
        this.emit('error', errorMsg)
      }
      // 신호 종료(code===null)는 error를 내지 않는다(기존 동작 유지) — 대신 done의 RunEnd가
      // 'signal'/'killed'로 그 사실을 실어 보내 소유자가 반드시 터미널을 만들 수 있게 한다.
      let reasonCode: RunEndReasonCode
      if (scope.killRequested) reasonCode = 'killed'
      else if (code === null) reasonCode = 'signal'
      else if (code === 0) reasonCode = 'exit-ok'
      else reasonCode = 'exit-nonzero'
      this.finalize(scope, {
        reasonCode,
        code,
        signal: signal ?? null,
        killedByUs: scope.killRequested
      })
    })

    this.process.on('error', (err) => {
      if (scope.ended) return   // close로 이미 마감 — 중복 오류/done 금지
      console.log(`[PythonRunner] Spawn error: ${err.message}`)
      clearIfMine()
      this.emit('error', `Python 실행 실패: ${err.message}`)
      this.finalize(scope, { reasonCode: 'spawn-error-async', code: -1, signal: null, killedByUs: false })
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

  // 취소: 프로세스 트리를 kill하고 종료를 bounded timeout 내에서 '확인'한다(공용 마감 K2).
  //  Windows 성공(treeKillConfirmed) = 대상 Python 'close' 관측 AND taskkill 프로세스 'close' AND exit 0.
  //  taskkill을 fire-and-forget으로 두지 않는다 — parent만 닫히고 트리가 아직 종료 중이면 성공으로 오판하지 않도록.
  //  실패 구분: taskkill spawn error / nonzero exit / parent close timeout / taskkill 완료 timeout → treeKillConfirmed=false.
  //  this.process는 여기서 null로 만들지 않는다 — run()의 'close' 핸들러가 관리(그래야 done 경로가 그대로 동작).
  cancel(timeoutMs: number = 8000): Promise<CancelResult> {
    const proc = this.process
    if (!proc) return Promise.resolve({ parentExited: true, treeKillConfirmed: true, timedOut: false, reason: 'no-process' })
    // '우리가 죽였다'를 기록 — close(code null)를 신호 사망이 아니라 취소로 해석하게 한다.
    this.scope.killRequested = true
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
          tk = this.spawnFn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
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

  /** 이번(또는 직전) 실행이 우리 요청으로 종료됐는가 — 소유자가 cancelled/error를 가를 때 참고. */
  get killRequested(): boolean {
    return this.scope.killRequested
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
