// 참조 전사 미리보기 실행 제어 — 동시 실행 방지 + timeout + 정리(단일 resolve).
//
// audio.ipc.ts의 'audio:transcribe-reference' 핸들러가 사용한다. 미리보기가 진행 중이면
// 두 번째 미리보기와 메인 합성을 막고, timeout/spawn 오류/비정상 done에서도 config·runner를
// 정리하고 반드시 결과를 resolve해 UI가 '전사 중...'에 남지 않게 한다.

export interface PreviewResult {
  status?: string
  text?: string
  language?: string
  error_message?: string
}

// EventEmitter 기반 러너의 최소 인터페이스(PythonRunner 호환) — 테스트에서 fake 주입.
export interface PreviewRunnerLike {
  on(event: string, cb: (arg?: unknown) => void): void
  run(scriptPath: string, args: string[]): void
  cancel(): void
}

export interface PreviewGuard {
  readonly running: boolean
  begin(): void   // 이미 실행 중이면 throw
  end(): void
}

export function createPreviewGuard(): PreviewGuard {
  let running = false
  return {
    get running() { return running },
    begin() {
      if (running) throw new Error('이미 참조 전사 미리보기가 진행 중입니다.')
      running = true
    },
    end() { running = false }
  }
}

interface RunPreviewOpts {
  runner: PreviewRunnerLike
  scriptPath: string
  args: string[]
  timeoutMs: number
  cleanup: () => void
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (h: unknown) => void
}

// 러너를 실행하고 result/error/done/timeout을 단일 resolve로 마감한다. 절대 reject하지 않는다
// (실패도 status:'failed'로 resolve) → 호출부/UI가 항상 종료 상태로 전이.
export function runPreview(opts: RunPreviewOpts): Promise<PreviewResult> {
  const setT = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
  const clrT = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  return new Promise<PreviewResult>((resolve) => {
    let settled = false
    let payload: PreviewResult | null = null
    let errMsg: string | null = null
    let timer: unknown = null

    const finish = (res: PreviewResult) => {
      if (settled) return
      settled = true
      if (timer !== null) clrT(timer)
      opts.cleanup()
      resolve(res)
    }

    opts.runner.on('result', (data) => {
      const t = (data as { transcript?: PreviewResult })?.transcript
      if (t) payload = t
    })
    opts.runner.on('error', (msg) => {
      if (!errMsg) errMsg = typeof msg === 'string' ? msg : String(msg)
    })
    opts.runner.on('done', () => {
      finish(payload ?? { status: 'failed', error_message: errMsg || '전사 실패' })
    })

    timer = setT(() => {
      try { opts.runner.cancel() } catch { /* ignore */ }
      finish({ status: 'failed', error_message: `참조 전사 시간 초과 (${Math.round(opts.timeoutMs / 1000)}초)` })
    }, opts.timeoutMs)

    opts.runner.run(opts.scriptPath, opts.args)
  })
}
