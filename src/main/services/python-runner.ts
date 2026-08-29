import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { EventEmitter } from 'events'
import { StringDecoder } from 'string_decoder'
import type { RunEnd, RunEndReasonCode } from './run-settlement'
import type { SidecarValidation, SidecarValidator } from '../../shared/sidecarEvents'

// 사이드카 카운터 키 위생: '타입 이름 + 개수'만 남긴다 — payload 는 절대 담지 않는다.
// 짧은 안전 토큰이 아니면(경로·본문·긴 문자열 냄새) 버킷명으로 대체해 로그/메트릭 오염을 막는다.
const SAFE_TYPE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const TYPE_KEY_UNSAFE = '(unsafe-type)'
const TYPE_KEY_MISSING = '(no-type)'
const TYPE_KEY_OVERFLOW = '(overflow)'
// 회귀한 Python 이 무한히 새로운 type 을 뿜어도 맵이 무한정 자라지 않게 한다.
const MAX_TRACKED_TYPE_KEYS = 64

function typeKeyOf(msg: unknown): string {
  const t = (msg as { type?: unknown } | null)?.type
  if (typeof t !== 'string' || t.length === 0) return TYPE_KEY_MISSING
  return SAFE_TYPE_KEY_RE.test(t) ? t : TYPE_KEY_UNSAFE
}

function bumpCounter(map: Map<string, number>, key: string): void {
  const k = map.has(key) || map.size < MAX_TRACKED_TYPE_KEYS ? key : TYPE_KEY_OVERFLOW
  map.set(k, (map.get(k) ?? 0) + 1)
}

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
  /**
   * 진단 사이드카 이벤트 검증기(src/shared/sidecarEvents.validateSidecarEvent).
   *
   * 왜 '주입'인가: 이 파일은 Electron 없이 `node --test` 가 직접 로드한다. 프로젝트 모듈을
   * 런타임 import 하면(확장자 없는 ESM specifier) 그 로드가 깨진다 — 그래서 run-settlement 도
   * 여기서는 type-only 로만 가져온다. 실제 함수는 소유자(audio.ipc)가 넣는다.
   *
   * 미주입 시 동작은 **fail-closed**: 어떤 사이드카도 전달하지 않고, 네 핵심 type 밖의 모든
   * 이벤트는 unknownEventStats 에 타입명으로 집계된다(손실이 조용하지 않게).
   */
  validateSidecar?: SidecarValidator
}

// 한 번의 run()에 묶인 상태. done은 정확히 1회 — 어떤 종료 경로에서도(정상/비정상/신호/spawn 실패).
interface RunScope {
  started: boolean
  ended: boolean
  killRequested: boolean        // 우리가 cancel()로 끝냈는가 → cancelled vs error 구분의 근거
  cleanups: Array<() => void>   // run-scoped 정리(config 파일 등) — 모든 종료 경로에서 finally처럼 1회 실행
}

// ── 실패 '문구' 선택 — 실패 '판정'은 하지 않는다 ────────────────────────────
//
// 실패 권위는 여기 없다: nonzero exit / structured error·final / no-result settlement 가 정한다.
// 이 함수는 이미 실패로 판정된 실행에 대해 사용자에게 보여줄 한 줄을 고를 뿐이다.
//
// 왜 바꿨나: 예전에는 알려진 패턴을 못 찾으면 stderr 마지막 3줄을 그대로 썼다. 그런데 외부
// 패키지가 import 단계에서 뿜는 경고(RequestsDependencyWarning 등)가 stderr 끝에 남으면
// 진짜 원인 대신 그 경고문이 사용자 오류 카드에 올라온다. 경고는 실패의 원인이 아닌데도
// 원인처럼 보이는 것이다.
//
// 그래서 '문구 후보'에서만 소음을 걸러낸다. stderr 자체는 그대로 보존되고(콘솔 로그·진단),
// 실제 ModuleNotFoundError·ImportError·traceback 은 숨기지 않는다.
// 안전하게 고를 것이 없으면 빈 문자열을 돌려주고 호출부가 exit code 문구를 쓴다.

/** 사용자에게 보여줄 '원인 후보'가 될 수 없는 줄인가. */
function isDiagnosticNoise(line: string): boolean {
  if (!line) return true
  const hasError = /(Error|Exception)\s*:/.test(line)
  if (/\w*Warning\s*:/.test(line)) return true          // 경고류는 실패 원인이 아니다
  if (/#\s*type:\s*ignore/.test(line)) return true      // 외부 패키지 소스 인용 줄
  if (/site-packages/.test(line) && !hasError) return true
  if (/^\s*File\s+"/.test(line)) return true            // traceback 위치 표시
  if (/^\s{2,}\S/.test(line) && !hasError) return true  // 들여쓰기된 소스 인용
  return false
}

/** 사용자 문구에서 절대 경로를 파일명만 남기고 지운다(경로 노출 금지). */
function stripPaths(text: string): string {
  return text
    .replace(/[A-Za-z]:[\\/][^\s'"]*[\\/]([^\s'"\\/]+)/g, '$1')
    .replace(/\/(?:[^\s'"/]+\/)+([^\s'"/]+)/g, '$1')
    .trim()
}

const EXCEPTION_LINE = /^[A-Za-z_][\w.]*(Error|Exception)\s*:/
/** 줄 앞에 파일 위치가 붙어 있어도 예외 부분만 떼어낸다. */
const EXCEPTION_ANYWHERE = /([A-Za-z_][\w.]*(?:Error|Exception)\s*:.*)$/

/** 이 줄에서 사용자에게 보여줄 예외 문구를 뽑는다. 없으면 null. */
function exceptionFrom(line: string): string | null {
  if (EXCEPTION_LINE.test(line)) return line
  const m = EXCEPTION_ANYWHERE.exec(line)
  return m ? m[1] : null
}

/**
 * 이미 실패로 판정된 실행의 stderr 에서 사용자에게 보여줄 한 줄을 고른다.
 * 고를 것이 없으면 빈 문자열 — 호출부가 exit code 기반 문구를 쓴다.
 */
export function selectPythonErrorMessage(stderr: string): string {
  const raw = (stderr || '').trim()
  if (!raw) return ''
  const lines = raw.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim().length > 0)

  // 1) traceback 이 있으면 그 블록의 마지막 예외 줄이 가장 정확한 원인이다.
  let lastTraceback = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^Traceback \(most recent call last\)/.test(lines[i].trim())) { lastTraceback = i; break }
  }
  if (lastTraceback >= 0) {
    for (let i = lines.length - 1; i > lastTraceback; i--) {
      const line = lines[i].trim()
      if (isDiagnosticNoise(line)) continue
      const exc = exceptionFrom(line)
      if (exc) return stripPaths(exc)
    }
  }

  // 2) 알려진 원인 패턴 — 소음 줄은 후보에서 뺀다.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (isDiagnosticNoise(line)) continue
    if (line.startsWith('ModuleNotFoundError:')) return stripPaths(`패키지 미설치: ${line}`)
    if (line.startsWith('ImportError:')) return stripPaths(`Import 오류: ${line}`)
    if (line.startsWith('FileNotFoundError:')) return stripPaths(`파일 없음: ${line}`)
    if (line.startsWith('RuntimeError:')) return stripPaths(line)
    const exc = exceptionFrom(line)
    if (exc) return stripPaths(exc)
    if (line.startsWith('Error:') || line.startsWith('error:')) return stripPaths(line)
  }

  // 3) 안전하게 고를 것이 없다 — 지어내지 않고 호출부에 넘긴다.
  return ''
}

export class PythonRunner extends EventEmitter {
  private process: ChildProcess | null = null
  private pythonPath: string
  private spawnFn: typeof spawn
  private validateSidecar?: SidecarValidator
  // 전달된 사이드카의 단조 순번(= 전달 성공 건수). Date.now()를 쓰지 않는다 — 테스트 결정성.
  private sidecarSequence = 0
  // 허용목록 밖 type 의 손실 관측용: 타입명 → 개수. payload 는 담지 않는다.
  private readonly unknownEventCounts = new Map<string, number>()
  // 허용목록 안이지만 검증에 실패한 건: reasonCode → 개수.
  private readonly sidecarRejectCounts = new Map<string, number>()
  // run() 전에 등록된 cleanup을 첫 run이 이어받도록 초기 scope를 미리 둔다(started=false).
  private scope: RunScope = { started: false, ended: false, killRequested: false, cleanups: [] }

  constructor(pythonPath: string = 'python', deps?: PythonRunnerDeps) {
    super()
    this.pythonPath = pythonPath
    this.spawnFn = deps?.spawn ?? spawn
    this.validateSidecar = deps?.validateSidecar
  }

  /** 허용목록 밖 type 의 누적 집계(타입명 → 개수). 러너 인스턴스 수명 동안 누적된다. */
  get unknownEventStats(): Record<string, number> {
    return Object.fromEntries(this.unknownEventCounts)
  }

  /** 허용목록 안이지만 검증에 실패한 건의 누적 집계(reasonCode → 개수). */
  get sidecarRejectStats(): Record<string, number> {
    return Object.fromEntries(this.sidecarRejectCounts)
  }

  /** 'sidecar' 로 실제 전달된 envelope 개수(= 마지막으로 부여한 sequence). */
  get sidecarForwardedCount(): number {
    return this.sidecarSequence
  }

  /**
   * 네 핵심 type(progress|status|result|error) 밖의 JSON 한 줄을 처리한다.
   *
   * 예전에는 여기서 **완전한 침묵**으로 사라졌다: JSON 파싱은 성공하므로 catch(비-JSON 로그)
   * 로도 가지 못했다. 이제 허용목록 검증을 통과한 것만 'sidecar' 로 재방출하고, 나머지는
   * 카운터만 올린다(payload 는 어디에도 남기지 않는다). 어떤 경우에도 throw 하지 않는다.
   */
  private handleAuxMessage(msg: unknown): void {
    const validate = this.validateSidecar
    if (validate) {
      const seq = this.sidecarSequence + 1
      let verdict: SidecarValidation
      try {
        verdict = validate(msg, seq)
      } catch {
        // 검증기 자체가 터져도 실행은 계속된다 — 구조화 사유로 집계만 하고 아무것도 안 보낸다.
        verdict = { ok: false, reasonCode: 'validator-threw' }
      }
      if (verdict.ok) {
        this.sidecarSequence = seq
        try {
          this.emit('sidecar', verdict.envelope)
        } catch (e) {
          // 소비자가 터져도 여기서 막는다. 바깥 catch 로 넘기면 그쪽이 '비-JSON'으로 오해해
          // 원본 줄(회귀 시 경로·본문이 들어있을 수 있는)을 통째로 로그에 찍는다.
          console.log(`[PythonRunner] sidecar 소비자 실패: ${(e as Error)?.name || 'error'}`)
        }
        return
      }
      // 'unknown-kind' = 허용목록 밖 → 아래 타입명 카운터로 흘려보낸다(손실 관측).
      if (verdict.reasonCode !== 'unknown-kind') {
        bumpCounter(this.sidecarRejectCounts, verdict.reasonCode)
        return
      }
    }
    bumpCounter(this.unknownEventCounts, typeKeyOf(msg))
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
          // job_restarted 는 '지금까지 만든 것을 버리고 처음부터 다시 만든다'는 기계용 선언이다
          // (참조 사용 방식 '자동'의 안정 방식 전환). 감시기(longform-job)가 조각 원장을 비우고
          // 축을 다시 재는 데 쓰는 유일한 신호라, 여기서 떨어뜨리면 긴 2회차가 무진행으로 오판된다.
          // 다른 임의 필드는 그대로 버린다 — 표시 경로에 실릴 수 있는 값을 늘리지 않는다.
          this.emit('progress', {
            percent: msg.percent ?? 0, message: msg.message ?? '',
            ...(msg.job_restarted === true ? { job_restarted: true as const } : {})
          })
        } else if (msg.type === 'result') {
          this.emit('result', msg)
        } else if (msg.type === 'error') {
          // 구조화 오류 전체 전달(message + 선택적 code·필드). renderer용 정제는 audio.ipc가 담당.
          // Python이 담는 필드는 이미 비민감(전사·문장·전체경로 없음)이지만, 소비 측이 최종 정제.
          this.emit('error', msg)
        } else {
          // 위 네 종류의 의미는 그대로 두고, 나머지만 여기서 처음으로 '보이게' 만든다.
          this.handleAuxMessage(msg)
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
    return selectPythonErrorMessage(stderr)
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
