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
 */
export type SpawnFn = (command: string, args: string[], options: Record<string, unknown>) => ChildProcess

export interface QwenVoiceRequest {
  model: string; speaker: string; language: string; textFile: string; out: string; seed?: number
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
}

export const QWEN_IDLE_MS = 3 * 60_000
export const QWEN_TIMEOUT_MS = 10 * 60_000

interface Live {
  proc: ChildProcess
  buf: string
  dead: boolean
  pending: { id: string; resolve: (r: QwenVoiceReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null
}

export class QwenVoiceWorker {
  private live: Live | null = null
  private seq = 0
  private idle: ReturnType<typeof setTimeout> | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private deps: QwenVoiceWorkerDeps

  // ★매개변수 속성(constructor(private deps…))을 쓰지 않는다 — node --test 가 이 파일을 곧바로 읽는다(타입만 벗기는 방식).
  constructor(deps: QwenVoiceWorkerDeps) { this.deps = deps }

  /** 지금 떠 있는가(검사·기록용). */
  get running(): boolean { return !!this.live && !this.live.dead }

  /** 한 조각을 만든다 — 차례로. */
  speak(req: QwenVoiceRequest): Promise<QwenVoiceReply> {
    const run = this.tail.then(() => this.once(req), () => this.once(req))
    this.tail = run.catch(() => { /* 다음 차례는 앞의 실패와 무관하다 */ })
    return run
  }

  /** 내린다 — 떠 있지 않으면 아무 일도 없다. 기다리던 요청은 사유와 함께 끝난다. */
  stop(reason = '내림'): void {
    if (this.idle) { clearTimeout(this.idle); this.idle = null }
    const l = this.live
    if (!l) return
    this.finish(l, new Error(`Qwen 상주 실행기를 내렸습니다(${reason})`))
    try { l.proc.stdin?.end() } catch { /* 이미 닫혔다 */ }
    try { l.proc.kill() } catch { /* 이미 죽었다 */ }
    this.deps.onEvent?.('stop', { reason })
  }

  private start(): Live {
    const proc = this.deps.spawn(this.deps.pythonPath(), ['-X', 'utf8', '-u', this.deps.scriptPath()], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, ...(this.deps.env || {}), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    const l: Live = { proc, buf: '', dead: false, pending: null }
    proc.stdin?.on('error', () => this.finish(l, new Error('Qwen 상주 실행기에 쓰지 못했습니다')))
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
      this.finish(l, new Error(`Qwen 상주 실행기가 끝났습니다(${why})`))
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
    const p = l.pending
    if (!p || String(msg.id ?? '') !== p.id) return
    l.pending = null
    clearTimeout(p.timer)
    if (msg.ok === true) {
      p.resolve({ seconds: Number(msg.seconds) || 0, sampleRate: Number(msg.sample_rate) || 0,
        genSec: Number(msg.gen_sec) || 0, loadedNow: !!msg.loaded_now })
    } else {
      p.reject(new Error(String(msg.error || 'Qwen 지정 목소리로 만들지 못했습니다')))
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

  private once(req: QwenVoiceRequest): Promise<QwenVoiceReply> {
    if (this.idle) { clearTimeout(this.idle); this.idle = null }
    if (!this.live || this.live.dead) this.live = this.start()
    const l = this.live
    const id = `q${++this.seq}`
    return new Promise<QwenVoiceReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finish(l, new Error('Qwen 지정 목소리가 너무 오래 걸려 멈췄습니다'))
        try { l.proc.kill() } catch { /* 이미 죽었다 */ }
      }, this.deps.timeoutMs ?? QWEN_TIMEOUT_MS)
      l.pending = { id, resolve, reject, timer }
      const line = JSON.stringify({ id, model: req.model, speaker: req.speaker, language: req.language,
        text_file: req.textFile, out: req.out, seed: req.seed ?? 0 }) + '\n'
      const w = l.proc.stdin
      if (l.dead || !w || !w.writable || w.destroyed || w.writableEnded) {
        this.finish(l, new Error('Qwen 상주 실행기에 쓰지 못했습니다'))
        return
      }
      try {
        w.write(line, (err) => { if (err) this.finish(l, new Error('Qwen 상주 실행기에 쓰지 못했습니다')) })
      } catch {
        this.finish(l, new Error('Qwen 상주 실행기에 쓰지 못했습니다'))
      }
    }).finally(() => {
      if (this.idle) clearTimeout(this.idle)
      this.idle = setTimeout(() => this.stop('한동안 안 씀'), this.deps.idleMs ?? QWEN_IDLE_MS)
    })
  }
}
