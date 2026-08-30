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
}

interface Pending {
  seq: number
  requestId: string
  resolve: (value: Record<string, unknown>) => void
  timer: ReturnType<typeof setTimeout>
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

export class AnalysisWorker {
  private proc: ChildProcess | null = null
  private buffer = ''
  private seq = 0
  private latestSeq = 0
  private consecutiveFailures = 0
  private totalRestarts = 0
  private pending = new Map<string, Pending>()
  private prewarmWaiter: ((msg: Record<string, unknown>) => void) | null = null
  private readonly deps: AnalysisWorkerDeps
  private readonly timeoutMs: number

  constructor(deps: AnalysisWorkerDeps) {
    this.deps = deps
    this.timeoutMs = deps.timeoutMs ?? ANALYSIS_TIMEOUT_MS
  }

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed
  }

  /** 연속 실패 횟수. 성공 한 번이면 0 이 된다. */
  get consecutiveFailureCount(): number {
    return this.consecutiveFailures
  }

  /** 진단용 총 재시작 횟수(상한 판정에는 쓰지 않는다). */
  get restartCount(): number {
    return this.totalRestarts
  }

  /** 성공했다 — 연속 실패 기록을 지운다. */
  private noteSuccess(): void {
    this.consecutiveFailures = 0
  }

  private ensure(): boolean {
    if (this.alive) return true
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false
    try {
      const p = this.deps.spawn(this.deps.pythonPath(),
        ['-X', 'utf8', '-u', this.deps.scriptPath()],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      p.stdout?.setEncoding?.('utf-8')
      p.stdout?.on('data', (d: string) => this.onData(String(d)))
      // stderr 는 흘려 보낸다 — 대사 원문이 아니고, 여기서 읽지 않으면 파이프가 막힌다.
      p.stderr?.on('data', () => {})
      p.on('exit', () => this.onExit())
      p.on('error', () => this.onExit())
      this.proc = p
      this.buffer = ''
      return true
    } catch {
      this.proc = null
      this.consecutiveFailures += 1
      this.totalRestarts += 1
      return false
    }
  }

  private onExit(): void {
    this.proc = null
    this.consecutiveFailures += 1
    this.totalRestarts += 1
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, code: 'WORKER_UNAVAILABLE', request_id: id })
    }
    this.pending.clear()
  }

  private onData(chunk: string): void {
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
          w?.(msg)
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

  /**
   * 아직 답하지 않은 이전 요청을 모두 버린다(모드 전환·파일 변경 등).
   *
   * worker 에 보내는 `drop_before` 는 **아직 시작하지 않은 대기 요청**만 건너뛰게 한다.
   * 이미 계산 중인 것은 끝까지 가고, 그 결과는 여기서 이미 취소로 답했으므로 버려진다.
   * 강제로 끊자고 프로세스를 죽이지 않는다.
   */
  cancelPending(reason = 'CANCELLED'): number {
    const n = this.pending.size
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, code: reason, request_id: id })
    }
    this.pending.clear()
    this.latestSeq = this.seq
    if (this.alive) {
      try {
        this.proc?.stdin?.write(
          JSON.stringify({ type: 'drop_before', request_seq: this.seq + 1 }) + '\n')
      } catch { /* 종료 중이면 무시한다 */ }
    }
    return n
  }

  analyze(req: {
    requestId: string; text: string; mode?: string; referenceConditioningMode?: string
  }): Promise<Record<string, unknown>> {
    const id = req.requestId
    if (!this.ensure()) {
      return Promise.resolve({ ok: false, code: 'WORKER_UNAVAILABLE', request_id: id })
    }
    this.seq += 1
    const seq = this.seq
    this.latestSeq = seq
    // 아직 시작하지 않은 대기 요청은 건너뛰게 한다. 계산 중인 것은 끝까지 가고,
    // 그 결과는 아래 SUPERSEDED 판정에서 버려진다.
    try {
      this.proc?.stdin?.write(JSON.stringify({ type: 'drop_before', request_seq: seq }) + '\n')
    } catch { /* 아래 write 에서 다시 걸린다 */ }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // 멈춘 worker 를 붙들지 않는다 — 죽이고 다음 요청에서 새로 띄운다.
        try { this.proc?.kill() } catch { /* 이미 죽었을 수 있다 */ }
        resolve({ ok: false, code: 'WORKER_TIMEOUT', request_id: id })
      }, this.timeoutMs)
      this.pending.set(id, { seq, requestId: id, resolve, timer })
      try {
        this.proc?.stdin?.write(JSON.stringify({
          type: 'analyze', request_id: id, request_seq: seq,
          text: req.text, mode: req.mode ?? 'high_quality_icl',
          reference_conditioning_mode: req.referenceConditioningMode ?? req.mode
            ?? 'high_quality_icl',
          source_sha256: sha256Hex(req.text ?? ''),
        }) + '\n')
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
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
    if (!this.ensure()) return Promise.resolve(false)
    if (this.prewarmWaiter) return Promise.resolve(false)   // 이미 데우는 중이다
    return new Promise((resolve) => {
      const done = (okValue: boolean) => {
        clearTimeout(timer)
        this.prewarmWaiter = null
        resolve(okValue)
      }
      const timer = setTimeout(() => done(false), timeoutMs)
      this.prewarmWaiter = (msg) => done(msg.ok === true)
      try {
        this.proc?.stdin?.write(JSON.stringify({ type: 'prewarm' }) + '\n')
      } catch {
        done(false)
      }
    })
  }

  /** 앱 종료·정리. 남은 요청은 취소로 답하고 프로세스를 정중히 닫는다. */
  dispose(): void {
    this.cancelPending('CANCELLED')
    this.prewarmWaiter = null
    const p = this.proc
    this.proc = null
    if (!p) return
    try {
      p.stdin?.write(JSON.stringify({ type: 'shutdown' }) + '\n')
      p.stdin?.end()
    } catch { /* 이미 닫혔다 */ }
    try { p.kill() } catch { /* 이미 죽었다 */ }
  }
}
