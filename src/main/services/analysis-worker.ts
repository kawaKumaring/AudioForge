import { createHash } from 'crypto'
import type { ChildProcess } from 'child_process'

/**
 * 입력 분석 **상주 worker** 관리자.
 *
 * 타이핑마다 Python 을 새로 띄우면 편집이 끊긴다. 그래서 프로세스 하나를 살려 두고
 * 줄 단위 JSON 으로 주고받는다. worker 는 GPU 를 쓰지 않고 TTS 모델도 로드하지 않는다 —
 * 필요한 것은 tokenizer 뿐이고 그마저 첫 요청에서 지연 로드한다.
 *
 * 실측(2026-08-30, 공유 venv): 첫 요청 7.9초(tokenizer 지연 로드 포함), 이후 요청 0.02초.
 * 아래 타임아웃은 성능 목표가 아니라 **멈춘 worker 를 놓아주는 fail-open 가드**이고,
 * 그 실측의 약 4배로 잡았다.
 *
 * 죽은 파이프에 쓰는 경쟁
 * -----------------------
 * 실제 앱에서 `Uncaught Exception: Error: write EPIPE` 로 main 이 터졌다. 원인은 종료된
 * worker 의 stdin 에 쓰는 lifecycle race 다. EPIPE 는 `write()` 의 **동기 예외가 아니라**
 * write callback 과 stream 의 `error` 이벤트로 온다 — try/catch 로는 잡히지 않고,
 * `error` 리스너가 없으면 그대로 프로세스 전역 예외가 된다.
 *
 * 그래서 여기서는
 *   · 쓰기 전에 살아 있는지 + `writable` · `!destroyed` · `!writableEnded` 를 확인하고
 *   · stdin 에 `error` 리스너를 항상 달고
 *   · write 의 동기 예외와 callback 오류를 **둘 다** 실패로 다루고
 *   · exit·close·error·write 실패가 동시에 와도 무효화와 pending 종료가 **정확히 한 번**만
 *     일어나게 세대(generation) 로 잠근다.
 * 실패한 요청은 타임아웃을 기다리지 않고 즉시 구조화 응답으로 끝난다 — UI 의 `준비 중…` 이
 * 30초 동안 붙잡히지 않게 하려는 것이다.
 */
export const ANALYSIS_TIMEOUT_MS = 30_000

/**
 * **연속** 실패 상한. 넘으면 그 동안은 분석 없이 편집만 계속된다.
 *
 * 앱 수명 전체의 총량이 아니다 — handshake 나 분석이 한 번 성공하면 카운터를 0 으로 되돌린다.
 * 몇 시간 쓰다 어쩌다 세 번 죽었다고 남은 세션 내내 분석이 꺼지면 안 된다.
 */
export const MAX_CONSECUTIVE_FAILURES = 3

export type SpawnFn = (
  command: string, args: string[], options: Record<string, unknown>
) => ChildProcess

export interface AnalysisWorkerDeps {
  spawn: SpawnFn
  pythonPath: () => string
  scriptPath: () => string
  now?: () => number
  timeoutMs?: number
  /** 진단 훅. **사용자 원문을 넘기지 않는다** — 사유 코드와 수치만 온다. */
  onEvent?: (event: string, fields: Record<string, unknown>) => void
}

interface Pending {
  seq: number
  requestId: string
  resolve: (value: Record<string, unknown>) => void
  timer: ReturnType<typeof setTimeout>
}

interface Live {
  proc: ChildProcess
  gen: number
  invalidated: boolean
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

export class AnalysisWorker {
  private live: Live | null = null
  private buffer = ''
  private seq = 0
  private latestSeq = 0
  private generation = 0
  private consecutiveFailures = 0
  private totalRestarts = 0
  private disposed = false
  private pending = new Map<string, Pending>()
  private prewarmWaiter: ((ok: boolean) => void) | null = null
  private readonly deps: AnalysisWorkerDeps
  private readonly timeoutMs: number

  constructor(deps: AnalysisWorkerDeps) {
    this.deps = deps
    this.timeoutMs = deps.timeoutMs ?? ANALYSIS_TIMEOUT_MS
  }

  get alive(): boolean {
    const l = this.live
    return !!l && !l.invalidated && l.proc.exitCode === null && !l.proc.killed
  }

  /** 연속 실패 횟수. 성공 한 번이면 0 이 된다. */
  get consecutiveFailureCount(): number {
    return this.consecutiveFailures
  }

  /** 진단용 총 재시작 횟수(상한 판정에는 쓰지 않는다). */
  get restartCount(): number {
    return this.totalRestarts
  }

  private note(event: string, fields: Record<string, unknown> = {}): void {
    try { this.deps.onEvent?.(event, fields) } catch { /* 진단이 본류를 막지 않는다 */ }
  }

  /** 성공했다 — 연속 실패 기록을 지운다. */
  private noteSuccess(): void {
    this.consecutiveFailures = 0
  }

  private ensure(): boolean {
    if (this.disposed) return false
    if (this.alive) return true
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false
    this.generation += 1
    const gen = this.generation
    try {
      const proc = this.deps.spawn(this.deps.pythonPath(),
        ['-X', 'utf8', '-u', this.deps.scriptPath()],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      const live: Live = { proc, gen, invalidated: false }
      proc.stdout?.setEncoding?.('utf-8')
      proc.stdout?.on('data', (d: string) => this.onData(gen, String(d)))
      // stderr 는 흘려 보낸다 — 여기서 읽지 않으면 파이프가 막힌다.
      proc.stderr?.on('data', () => {})
      proc.stderr?.on('error', () => { /* 진단 스트림 오류는 무시한다 */ })
      // ★ stdin 의 error 리스너가 없으면 EPIPE 가 곧바로 프로세스 전역 예외가 된다.
      proc.stdin?.on('error', (err: NodeJS.ErrnoException) =>
        this.invalidate(gen, 'STDIN_ERROR', err?.code))
      proc.on('exit', () => this.invalidate(gen, 'EXIT'))
      proc.on('close', () => this.invalidate(gen, 'CLOSE'))
      proc.on('error', (err: NodeJS.ErrnoException) =>
        this.invalidate(gen, 'PROC_ERROR', err?.code))
      this.live = live
      this.buffer = ''
      return true
    } catch (err) {
      this.live = null
      this.countFailure()
      this.note('spawn_failed', { reason: (err as Error)?.name })
      return false
    }
  }

  private countFailure(): void {
    this.consecutiveFailures += 1
    this.totalRestarts += 1
  }

  /**
   * 이 세대의 worker 를 무효화한다. exit·close·error·write 실패가 경쟁해도 **한 번만** 돈다.
   * 대기 중인 요청과 prewarm 은 여기서 전부 fail-open 으로 끝난다.
   */
  private invalidate(gen: number, cause: string, detail?: string): void {
    const l = this.live
    if (!l || l.gen !== gen || l.invalidated) return
    l.invalidated = true
    this.live = null
    if (!this.disposed) this.countFailure()
    this.note('worker_invalidated', {
      cause, detail, pending: this.pending.size, prewarm: !!this.prewarmWaiter,
    })
    this.failAllPending('WORKER_UNAVAILABLE')
    const w = this.prewarmWaiter
    this.prewarmWaiter = null
    w?.(false)
  }

  private failAllPending(code: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, code, request_id: id })
    }
    this.pending.clear()
  }

  /** 지금 이 stdin 에 안전하게 쓸 수 있는가. */
  private canWrite(): boolean {
    const l = this.live
    if (!l || l.invalidated) return false
    const s = l.proc.stdin
    if (!s) return false
    if (s.destroyed || s.writableEnded) return false
    return s.writable !== false
  }

  /**
   * 한 줄을 쓴다. 실패하면 **false** 를 돌려주고 worker 를 무효화한다.
   * EPIPE 는 callback 으로도 오므로 동기 예외와 callback 오류를 함께 다룬다.
   */
  private safeWrite(payload: Record<string, unknown>): boolean {
    const l = this.live
    if (!this.canWrite() || !l) return false
    const gen = l.gen
    try {
      l.proc.stdin!.write(JSON.stringify(payload) + '\n', (err) => {
        if (err) this.invalidate(gen, 'WRITE_FAILED', (err as NodeJS.ErrnoException)?.code)
      })
      return true
    } catch (err) {
      this.invalidate(gen, 'WRITE_THREW', (err as NodeJS.ErrnoException)?.code)
      return false
    }
  }

  /**
   * 아직 답하지 않은 이전 요청을 모두 버린다(모드 전환·파일 변경 등).
   *
   * worker 에 보내는 `drop_before` 는 **아직 시작하지 않은 대기 요청**만 건너뛰게 한다.
   * 이미 계산 중인 것은 끝까지 가고, 그 결과는 여기서 이미 취소로 답했으므로 버려진다.
   * 강제로 끊자고 프로세스를 죽이지 않는다.
   */
  cancelPending(reason = 'CANCELLED'): number {
    const n = this.pending.size
    this.failAllPending(reason)
    this.latestSeq = this.seq
    this.safeWrite({ type: 'drop_before', request_seq: this.seq + 1 })
    return n
  }

  analyze(req: {
    requestId: string; text: string; mode?: string; referenceConditioningMode?: string
  }): Promise<Record<string, unknown>> {
    const id = req.requestId
    if (!this.ensure()) {
      this.note('analyze_unavailable', { reason: 'NO_WORKER' })
      return Promise.resolve({ ok: false, code: 'WORKER_UNAVAILABLE', request_id: id })
    }
    this.seq += 1
    const seq = this.seq
    this.latestSeq = seq
    // 아직 시작하지 않은 대기 요청은 건너뛰게 한다. 계산 중인 것은 끝까지 가고,
    // 그 결과는 아래 SUPERSEDED 판정에서 버려진다.
    this.safeWrite({ type: 'drop_before', request_seq: seq })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // 멈춘 worker 를 붙들지 않는다 — 놓아주고 다음 요청에서 새로 띄운다.
        const l = this.live
        if (l) {
          try { l.proc.kill() } catch { /* 이미 죽었을 수 있다 */ }
          this.invalidate(l.gen, 'TIMEOUT')
        }
        this.note('analyze_timeout', { timeout_ms: this.timeoutMs })
        resolve({ ok: false, code: 'WORKER_TIMEOUT', request_id: id })
      }, this.timeoutMs)
      this.pending.set(id, { seq, requestId: id, resolve, timer })
      const sent = this.safeWrite({
        type: 'analyze', request_id: id, request_seq: seq,
        text: req.text, mode: req.mode ?? 'high_quality_icl',
        reference_conditioning_mode: req.referenceConditioningMode ?? req.mode
          ?? 'high_quality_icl',
        source_sha256: sha256Hex(req.text ?? ''),
      })
      if (!sent && this.pending.has(id)) {
        // 타임아웃을 기다리지 않는다 — UI 가 `준비 중…` 에 붙잡히면 안 된다.
        clearTimeout(timer)
        this.pending.delete(id)
        this.note('analyze_write_failed', {})
        resolve({ ok: false, code: 'WORKER_UNAVAILABLE', request_id: id })
      }
    })
  }

  /**
   * tokenizer 를 미리 데운다 — **사용자 텍스트 없이**, 낮은 우선순위로.
   *
   * 첫 분석의 콜드 로드(실측 약 7.9초)를 타이핑 전으로 옮기는 것이 전부다. 실패해도
   * 조용히 false 를 돌려주고 이후 분석을 막지 않는다.
   */
  prewarm(timeoutMs = this.timeoutMs): Promise<boolean> {
    if (!this.ensure()) {
      this.note('prewarm_unavailable', { reason: 'NO_WORKER' })
      return Promise.resolve(false)
    }
    if (this.prewarmWaiter) return Promise.resolve(false)   // 이미 데우는 중이다
    return new Promise((resolve) => {
      let settled = false
      const done = (okValue: boolean, why?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.prewarmWaiter === waiter) this.prewarmWaiter = null
        if (!okValue) this.note('prewarm_failed', { reason: why ?? 'UNKNOWN' })
        resolve(okValue)
      }
      const waiter = (okValue: boolean) => done(okValue, 'WORKER_GONE')
      const timer = setTimeout(() => done(false, 'TIMEOUT'), timeoutMs)
      this.prewarmWaiter = waiter
      if (!this.safeWrite({ type: 'prewarm' })) done(false, 'WRITE_FAILED')
    })
  }

  /** 앱 종료·정리. 남은 요청은 취소로 답하고 프로세스를 정중히 닫는다. */
  dispose(): void {
    this.disposed = true
    this.cancelPending('CANCELLED')
    const w = this.prewarmWaiter
    this.prewarmWaiter = null
    w?.(false)
    const l = this.live
    this.live = null
    if (!l) return
    l.invalidated = true
    if (l.proc.stdin && !l.proc.stdin.destroyed && !l.proc.stdin.writableEnded) {
      try {
        l.proc.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n', () => { /* 무시 */ })
        l.proc.stdin.end()
      } catch { /* 이미 닫혔다 */ }
    }
    try { l.proc.kill() } catch { /* 이미 죽었다 */ }
  }

  private onData(gen: number, chunk: string): void {
    if (!this.live || this.live.gen !== gen) return      // 옛 세대의 늦은 출력은 버린다
    this.buffer += chunk
    let nl = this.buffer.indexOf('\n')
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      nl = this.buffer.indexOf('\n')
      if (!line) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue                       // 깨진 줄은 버린다. 원문을 로그로 흘리지 않는다.
      }
      if (msg.type === 'ready' || msg.type === 'prewarm') {
        this.noteSuccess()          // handshake 가 왔다는 것은 프로세스가 멀쩡하다는 뜻이다
        if (msg.type === 'prewarm') {
          const w = this.prewarmWaiter
          this.prewarmWaiter = null
          w?.(msg.ok === true)
        }
        continue
      }
      if (msg.type !== 'analysis') continue
      this.noteSuccess()
      const id = String(msg.request_id ?? '')
      const p = this.pending.get(id)
      if (!p) continue                 // 이미 타임아웃·취소된 요청의 늦은 응답
      clearTimeout(p.timer)
      this.pending.delete(id)
      p.resolve(p.seq < this.latestSeq
        ? { ok: false, code: 'SUPERSEDED', request_id: id }
        : msg)
    }
  }
}
