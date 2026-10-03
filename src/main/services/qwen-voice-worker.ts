import type { ChildProcess } from 'child_process'

/**
 * Qwen 지정 목소리(소희) **상주 실행기** 관리자 — 낭독이 소희로 읽을 때 모델을 띄워 둔다.
 *
 * ★왜 (2026-09-30 실측): 조각마다 프로세스를 새로 띄우면 모델 열기·묶어 실행 준비로 약 10초가 매번 든다
 *   (10.6초 분량이 20초, 그중 생성 10초). 띄워 두면 첫 조각 다음부터는 생성 시간만 든다 — 읽는 속도보다 빠르다.
 * ★그래픽카드 메모리를 붙든다 — 그래서 **한동안 안 쓰면 내린다**(idleMs). 앱이 끝날 때도 내린다(stop).
 *   실행기는 입력이 끊기면 스스로 끝난다(부모가 죽어도 고아로 남지 않는다).
 * ★죽은 파이프에 쓰는 경쟁 — 분석 상주 실행기에서 main 이 `write EPIPE` 로 터진 적이 있다(analysis-worker.ts).
 *   쓰기 전에 살아 있는지 확인하고, stdin 에 error 리스너를 달고, 쓰기 실패·종료·타임아웃을 **한 번만** 끝낸다.
 * 한 번에 하나만 보낸다(부르는 쪽 — 낭독 줄 — 이 이미 한 줄로 세운다). 겹쳐 오면 차례로 보낸다.
 *
 * ★같은 관리자를 **기본 목소리 상주 실행기**(reader_voice_server.py)도 쓴다(2026-10-01) — 주고받는 모양이 같다.
 *   이름(label)만 다르게 주고, 요청은 call(payload) 로 그대로 보낸다.
 */
export type SpawnFn = (command: string, args: string[], options: Record<string, unknown>) => ChildProcess

export interface QwenVoiceRequest {
  model: string; speaker: string; language: string; textFile: string; out: string; seed?: number
  /** 협조적 정지 파일 — 생기면 실행기가 만들기를 멈추고 stopped 로 답한다(2026-10-03). */
  stopFlag?: string
}
export interface QwenVoiceReply { seconds: number; sampleRate: number; genSec: number; loadedNow: boolean }

export interface QwenVoiceWorkerDeps {
  spawn: SpawnFn
  /** 격리 환경 파이썬. */
  pythonPath: () => string
  scriptPath: () => string
  env?: Record<string, string | undefined>
  /** 이만큼 요청이 없으면 내린다. */
  idleMs?: number
  /** 한 조각 상한 — 멈춘 실행기를 놓아주는 안전장치(첫 조각은 모델 열기가 더해진다). */
  timeoutMs?: number
  onEvent?: (event: string, fields: Record<string, unknown>) => void
  /** 사유 글에 쓰는 이름. 없으면 'Qwen 상주 실행기'. */
  label?: string
}

export const QWEN_IDLE_MS = 3 * 60_000
export const QWEN_TIMEOUT_MS = 10 * 60_000

interface Live {
  proc: ChildProcess
  buf: string
  dead: boolean
  /** 실행기가 '준비됨' 을 알렸다(파이프까지 열렸다). */
  ready: Promise<void>
  markReady: () => void
  pending: { id: string; resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null
}

export class QwenVoiceWorker {
  private live: Live | null = null
  private seq = 0
  private idle: ReturnType<typeof setTimeout> | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private deps: QwenVoiceWorkerDeps

  // ★매개변수 속성(constructor(private deps…))을 쓰지 않는다 — node --test 가 이 파일을 곧바로 읽는다(타입만 벗기는 방식).
  constructor(deps: QwenVoiceWorkerDeps) { this.deps = deps }

  /** 파이프로 맡은 작업이 돌고 있는가 — 실행기가 알린 시작·끝으로 안다. 실행기가 죽으면 거짓. */
  private pipeBusy = false
  private pipeWaiters: Array<(r: { idle: boolean; stopped: boolean }) => void> = []
  private lastPipeStopped = false
  /** 마지막 파이프 작업이 어떻게 끝났나(ok · stopped · error: …) — 취소 기록용. */
  lastPipeWhy = ''
  private setPipeBusy(busy: boolean, stopped: boolean): void {
    this.pipeBusy = busy
    if (!busy) {
      this.lastPipeStopped = stopped
      const ws = this.pipeWaiters; this.pipeWaiters = []
      for (const w of ws) w({ idle: true, stopped })
    }
  }
  get pipeWorking(): boolean { return this.pipeBusy && this.running }
  /** 파이프 작업이 끝날 때까지(최대 timeoutMs). idle=false 면 시간 안에 끝나지 않았다. stopped = 정지 요청으로 멈췄는가. */
  whenPipeIdle(timeoutMs: number): Promise<{ idle: boolean; stopped: boolean }> {
    if (!this.pipeWorking) return Promise.resolve({ idle: true, stopped: this.lastPipeStopped })
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.pipeWaiters = this.pipeWaiters.filter((w) => w !== done); resolve({ idle: false, stopped: false }) }, timeoutMs)
      const done = (r: { idle: boolean; stopped: boolean }) => { clearTimeout(t); resolve(r) }
      this.pipeWaiters.push(done)
    })
  }

  /** 지금 떠 있는가(검사·기록용). */
  get running(): boolean { return !!this.live && !this.live.dead }

  private get label(): string { return this.deps.label || 'Qwen 상주 실행기' }

  /** 한 조각을 만든다 — 차례로. */
  speak(req: QwenVoiceRequest): Promise<QwenVoiceReply> {
    return this.call({ model: req.model, speaker: req.speaker, language: req.language,
      text_file: req.textFile, out: req.out, seed: req.seed ?? 0, ...(req.stopFlag ? { stop_flag: req.stopFlag } : {}) }).then((msg) => ({
      seconds: Number(msg.seconds) || 0, sampleRate: Number(msg.sample_rate) || 0,
      genSec: Number(msg.gen_sec) || 0, loadedNow: !!msg.loaded_now }))
  }

  /** 요청 하나를 그대로 보내고 성공 답을 받는다 — 차례로. 실패 답은 사유와 함께 거절된다. */
  call(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const run = this.tail.then(() => this.once(payload), () => this.once(payload))
    this.tail = run.catch(() => { /* 다음 차례는 앞의 실패와 무관하다 */ })
    return run
  }

  /**
   * 요청 없이 **띄워 둔다** — 다른 입구(이름 있는 파이프)로 일이 올 때를 위해(2026-10-01 생성 카드).
   * 한동안 일이 없으면 평소처럼 내린다.
   */
  ensure(waitMs = 30_000): Promise<boolean> {
    if (!this.live || this.live.dead) this.live = this.start()
    this.touch()
    const l = this.live
    // 준비 알림(파이프가 열림)까지 기다린다 — 너무 오래면 기다리지 않고 넘어간다(합성 쪽이 예전 길로 간다).
    return Promise.race([l.ready.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), waitMs))])
  }

  /** '한동안 안 씀' 시계를 다시 건다. */
  private touch(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.stop('한동안 안 씀'), this.deps.idleMs ?? QWEN_IDLE_MS)
  }

  /** 내린다 — 떠 있지 않으면 아무 일도 없다. 기다리던 요청은 사유와 함께 끝난다. */
  stop(reason = '내림'): void {
    if (this.idle) { clearTimeout(this.idle); this.idle = null }
    const l = this.live
    if (!l) return
    this.finish(l, new Error(`${this.label}를 내렸습니다(${reason})`))
    try { l.proc.stdin?.end() } catch { /* 이미 닫혔다 */ }
    try { l.proc.kill() } catch { /* 이미 죽었다 */ }
    this.setPipeBusy(false, false)
    this.deps.onEvent?.('stop', { reason })
  }

  private start(): Live {
    const proc = this.deps.spawn(this.deps.pythonPath(), ['-X', 'utf8', '-u', this.deps.scriptPath()], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, ...(this.deps.env || {}), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    let markReady = () => { /* 아래에서 채운다 */ }
    const ready = new Promise<void>((r) => { markReady = r })
    const l: Live = { proc, buf: '', dead: false, pending: null, ready, markReady: () => markReady() }
    proc.stdin?.on('error', () => this.finish(l, new Error(`${this.label}에 쓰지 못했습니다`)))
    proc.stdout?.setEncoding?.('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      l.buf += String(chunk)
      let i: number
      while ((i = l.buf.indexOf('\n')) >= 0) {
        const line = l.buf.slice(0, i).trim()
        l.buf = l.buf.slice(i + 1)
        this.onLine(l, line)
      }
    })
    proc.stderr?.on('data', () => { /* 라이브러리 경고 — 버린다(글 내용이 섞이지 않는다) */ })
    const gone = (why: string) => () => {
      l.dead = true
      if (this.live === l) this.live = null
      this.finish(l, new Error(`${this.label}가 끝났습니다(${why})`))
      this.setPipeBusy(false, false)        // 실행기가 죽었으면 그 파이프 작업도 끝났다 — 기다리는 취소를 풀어 준다
    }
    proc.on('exit', gone('종료'))
    proc.on('error', gone('시작 실패'))
    this.deps.onEvent?.('start', {})
    return l
  }

  private onLine(l: Live, line: string): void {
    if (!line.startsWith('{')) return
    let msg: Record<string, unknown>
    try { msg = JSON.parse(line) } catch { return }
    // 다른 입구(파이프)로 일하는 중이라는 알림 — 내리지 않게 시계를 다시 건다(기다리던 요청이 있으면 끝날 때 다시 건다).
    // 파이프 작업(카드·참조 낭독)의 시작·끝 — 카드 취소가 '실행기 작업까지 끝났나' 를 기다린다(2026-10-03).
    if (msg.pipe_busy === false) { this.lastPipeWhy = String(msg.why ?? ''); this.setPipeBusy(false, !!msg.stopped); if (!l.pending) this.touch(); return }
    if (msg.activity === true) { if (msg.pipe_busy === true) this.setPipeBusy(true, false); if (!l.pending) this.touch(); return }
    if (msg.ready === true) { l.markReady(); return }
    const p = l.pending
    if (!p || String(msg.id ?? '') !== p.id) return
    l.pending = null
    clearTimeout(p.timer)
    if (msg.ok === true) {
      p.resolve(msg)
    } else {
      p.reject(new Error(String(msg.error || (this.deps.label ? '이 부분을 소리로 만들지 못했습니다' : 'Qwen 지정 목소리로 만들지 못했습니다'))))
    }
  }

  /** 기다리던 요청을 **한 번만** 끝낸다. */
  private finish(l: Live, err: Error): void {
    const p = l.pending
    if (!p) return
    l.pending = null
    clearTimeout(p.timer)
    p.reject(err)
  }

  private once(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.idle) { clearTimeout(this.idle); this.idle = null }
    if (!this.live || this.live.dead) this.live = this.start()
    const l = this.live
    const id = `q${++this.seq}`
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finish(l, new Error(this.deps.label ? `${this.label}가 너무 오래 걸려 멈췄습니다` : 'Qwen 지정 목소리가 너무 오래 걸려 멈췄습니다'))
        try { l.proc.kill() } catch { /* 이미 죽었다 */ }
      }, this.deps.timeoutMs ?? QWEN_TIMEOUT_MS)
      l.pending = { id, resolve, reject, timer }
      const line = JSON.stringify({ id, ...payload }) + '\n'
      const w = l.proc.stdin
      if (l.dead || !w || !w.writable || w.destroyed || w.writableEnded) {
        this.finish(l, new Error(`${this.label}에 쓰지 못했습니다`))
        return
      }
      try {
        w.write(line, (err) => { if (err) this.finish(l, new Error(`${this.label}에 쓰지 못했습니다`)) })
      } catch {
        this.finish(l, new Error(`${this.label}에 쓰지 못했습니다`))
      }
    }).finally(() => {
      if (this.idle) clearTimeout(this.idle)
      this.idle = setTimeout(() => this.stop('한동안 안 씀'), this.deps.idleMs ?? QWEN_IDLE_MS)
    })
  }
}
