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

/** 죽은 worker 를 무한히 되살리지 않는다. 넘으면 그 세션에서는 분석 없이 편집만 계속된다. */
export const MAX_RESTARTS = 3

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
  private restarts = 0
  private pending = new Map<string, Pending>()
  private readonly deps: AnalysisWorkerDeps
  private readonly timeoutMs: number

  constructor(deps: AnalysisWorkerDeps) {
    this.deps = deps
    this.timeoutMs = deps.timeoutMs ?? ANALYSIS_TIMEOUT_MS
  }

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed
  }

  get restartCount(): number {
    return this.restarts
  }

  private ensure(): boolean {
    if (this.alive) return true
    if (this.restarts > MAX_RESTARTS) return false
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
      this.restarts += 1
      return false
    }
  }

  private onExit(): void {
    this.proc = null
    this.restarts += 1
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
      if (msg.type !== 'analysis') continue
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

  /** 아직 답하지 않은 이전 요청을 모두 버린다(모드 전환·파일 변경 등). */
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
    // 새 요청이 왔으니 그보다 오래된 것은 계산할 필요가 없다.
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

  /** 앱 종료·정리. 남은 요청은 취소로 답하고 프로세스를 정중히 닫는다. */
  dispose(): void {
    this.cancelPending('CANCELLED')
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
