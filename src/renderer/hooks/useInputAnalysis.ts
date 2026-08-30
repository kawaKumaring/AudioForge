import { useCallback, useEffect, useRef, useState } from 'react'
import {
  verifyResponseIdentity, type AnalysisResponse, type AnalysisResult,
} from '../../shared/inputAnalysis'

/**
 * 대사 입력 분석 훅.
 *
 * `준비 중…` 에 갇히던 실제 결함 (2차)
 * ------------------------------------
 * watchdog 타이머를 effect 클로저에 두고 **effect cleanup 에서 해제**했다. 그래서 `send()`
 * 이후 effect 가 한 번이라도 다시 돌면(재렌더로 dependency 변화, 재마운트, StrictMode 이중
 * 호출) `preparing` 상태는 남은 채 안전망만 사라진다. 그 뒤 debounce 타이머도 매 cleanup 에서
 * 지워지면 새 요청도 나가지 않아 화면이 영원히 `준비 중…` 에 머문다.
 *
 * 그래서 **타이머 수명을 effect 에서 분리한다.**
 *   · debounce 타이머만 effect cleanup 이 지운다(입력이 또 바뀌면 다시 예약하면 된다)
 *   · watchdog 은 ref 로 살아남아 **응답이 정착할 때만** 해제된다. 어떤 재렌더·재마운트도
 *     이미 걸린 안전망을 풀지 못한다
 *   · 진행 중 요청·성공 이력·watchdog 은 모두 ref 라 렌더 주기와 무관하다
 *
 * 계측
 * ----
 * 왜 요청이 안 나갔는지 화면 밖에서 알 수 없어 같은 증상을 세 번 추적했다. 이제 lifecycle
 * 좌표를 `[analysis]` 로 콘솔에 남긴다 — **대사 원문은 넣지 않고** 횟수·상태·코드·시간만.
 */
export const ANALYSIS_DEBOUNCE_MS = 400

/** 마지막 안전망. main 의 worker 타임아웃(30초)보다 짧아 화면이 먼저 빠져나온다. */
export const ANALYSIS_WATCHDOG_MS = 12_000

/** 추월·취소로 답을 못 받았을 때 같은 입력을 다시 물어보는 횟수 상한. */
export const MAX_SUPERSEDED_RETRIES = 1

/** composition 을 볼 범위. TTS 대사 편집기 안쪽에서 난 조합만 분석을 억제한다. */
export const TTS_EDITOR_SCOPE_SELECTOR = '[data-af-tts-editor]'

export type AnalysisStatus =
  | 'idle' | 'preparing' | 'analyzing' | 'ready' | 'stale' | 'unavailable'

export interface UseInputAnalysis {
  status: AnalysisStatus
  result: AnalysisResult | null
  setComposing: (composing: boolean) => void
}

let requestCounter = 0

/** lifecycle 계측 — 원문 없이 좌표만. 화면 밖에서 흐름을 읽을 수 있어야 한다. */
const trace = (event: string, fields: Record<string, unknown> = {}) => {
  try { console.log('[analysis]', event, JSON.stringify(fields)) } catch { /* 무시 */ }
}

const counters = { mount: 0, effect: 0, cleanup: 0, scheduled: 0, cancelled: 0, fired: 0 }

/** 원문 SHA. 못 구하면 null — 그때는 main 이 이미 한 대조에 의존한다. */
async function sha256(text: string): Promise<string | null> {
  try {
    const buf = new TextEncoder().encode(text)
    const digest = await crypto.subtle.digest('SHA-256', buf)
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

export function useInputAnalysis(
  text: string,
  opts: { enabled?: boolean; mode?: string; referenceConditioningMode?: string;
          debounceMs?: number; scopeSelector?: string; watchdogMs?: number } = {}
): UseInputAnalysis {
  const enabled = opts.enabled !== false
  const debounceMs = opts.debounceMs ?? ANALYSIS_DEBOUNCE_MS
  const watchdogMs = opts.watchdogMs ?? ANALYSIS_WATCHDOG_MS
  const scopeSelector = opts.scopeSelector ?? TTS_EDITOR_SCOPE_SELECTOR
  // dependency 로 쓰는 값은 전부 primitive 로 고정한다 — opts 객체는 매 렌더 새로 만들어진다.
  const mode = opts.mode
  const refMode = opts.referenceConditioningMode

  const [status, setStatus] = useState<AnalysisStatus>('idle')
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const composing = useRef(false)
  const inflight = useRef<string | null>(null)
  const everSucceeded = useRef(false)
  const alive = useRef(true)
  // ★ watchdog 은 effect 밖에서 산다. cleanup 이 이것을 지우면 안전망이 사라진다.
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textRef = useRef(text)
  textRef.current = text

  const setComposing = useCallback((v: boolean) => { composing.current = v }, [])

  const clearWatchdog = useCallback(() => {
    if (watchdog.current) { clearTimeout(watchdog.current); watchdog.current = null }
  }, [])

  useEffect(() => {
    // ★ 재진입마다 살린다. StrictMode(개발) 는 mount -> cleanup -> mount 로 effect 를 두 번
    //   부르는데, cleanup 에서 내려둔 alive 를 여기서 되돌리지 않으면 그 인스턴스는 영원히
    //   죽은 것으로 남아 모든 응답과 watchdog 이 무시된다 — 개발 실행에서만 나던 무한
    //   `준비 중…` 의 실제 원인이다(production 번들은 이중 호출이 없어 드러나지 않았다).
    alive.current = true
    counters.mount += 1
    trace('mount', { n: counters.mount })
    return () => {
      alive.current = false
      clearWatchdog()                 // 소유자가 사라질 때만 안전망을 걷는다
      trace('unmount', { n: counters.mount })
    }
  }, [clearWatchdog])

  // prewarm 은 최적화다 — 응답을 기다리지 않고, 실패해도 분석을 막지 않는다.
  useEffect(() => {
    if (!enabled) return
    const id = setTimeout(() => {
      const t0 = Date.now()
      try {
        const p = window.api?.analysis?.prewarm?.()
        trace('prewarm_call', { available: !!p })
        if (p && typeof p.then === 'function') {
          p.then((r) => trace('prewarm_done', { ms: Date.now() - t0, ready: r?.ready === true }))
            .catch(() => trace('prewarm_done', { ms: Date.now() - t0, ready: false }))
        }
      } catch { trace('prewarm_call', { available: false }) }
    }, 0)
    return () => clearTimeout(id)
  }, [enabled])

  // IME 조합 억제 — TTS 대사 편집기 안쪽에서 난 조합만 본다.
  useEffect(() => {
    if (!enabled) { composing.current = false; return }
    const inScope = (e: Event) => {
      const t = e.target
      return t instanceof Element && !!t.closest(scopeSelector)
    }
    const start = (e: Event) => { if (inScope(e)) composing.current = true }
    const end = (e: Event) => { if (inScope(e)) composing.current = false }
    document.addEventListener('compositionstart', start)
    document.addEventListener('compositionend', end)
    return () => {
      document.removeEventListener('compositionstart', start)
      document.removeEventListener('compositionend', end)
      composing.current = false
    }
  }, [enabled, scopeSelector])

  const send = useCallback((attempt: number) => {
    requestCounter += 1
    const requestId = `a${requestCounter}`
    const sent = textRef.current
    inflight.current = requestId
    setStatus(everSucceeded.current ? 'analyzing' : 'preparing')

    // 안전망을 다시 건다. 이 타이머는 **응답이 정착할 때만** 풀린다.
    clearWatchdog()
    watchdog.current = setTimeout(() => {
      if (!alive.current || inflight.current !== requestId) return
      trace('watchdog_fired', { requestId, ms: watchdogMs })
      setStatus('unavailable')
    }, watchdogMs)

    const api = window.api?.analysis
    trace('request', { requestId, attempt, chars: sent.length, api: !!api?.analyze })
    if (!api?.analyze) {
      clearWatchdog()
      setStatus('unavailable')
      return
    }
    const t0 = Date.now()
    let promise: Promise<AnalysisResponse>
    try {
      promise = api.analyze({ requestId, text: sent, mode, referenceConditioningMode: refMode })
    } catch (e) {
      trace('invoke_threw', { requestId, name: (e as Error)?.name })
      clearWatchdog()
      setStatus('unavailable')
      return
    }
    promise.then(async (res) => {
      const ms = Date.now() - t0
      if (!alive.current || inflight.current !== requestId) {
        trace('response_ignored', { requestId, ms, reason: alive.current ? 'SUPERSEDED_LOCAL' : 'UNMOUNTED' })
        return
      }
      if (!res.ok && (res.code === 'SUPERSEDED' || res.code === 'CANCELLED')) {
        if (attempt < MAX_SUPERSEDED_RETRIES) {
          trace('retry', { requestId, code: res.code, attempt })
          send(attempt + 1)
          return
        }
        clearWatchdog()
        trace('response', { requestId, ms, ok: false, code: res.code })
        setStatus('unavailable')
        return
      }
      const sha = await sha256(sent)
      if (!alive.current || inflight.current !== requestId) return
      const current = verifyResponseIdentity(res, requestId, sha)
      clearWatchdog()
      trace('response', {
        requestId, ms, ok: res.ok, code: res.ok ? undefined : res.code, identity: current,
      })
      if (!current || !res.ok) { setStatus('unavailable'); return }
      everSucceeded.current = true
      setResult(res.result)
      setStatus('ready')
    }).catch((e) => {
      if (!alive.current || inflight.current !== requestId) return
      clearWatchdog()
      trace('invoke_rejected', { requestId, ms: Date.now() - t0, name: (e as Error)?.name })
      setStatus('unavailable')
    })
  }, [clearWatchdog, mode, refMode, watchdogMs])

  useEffect(() => {
    if (!enabled) return
    counters.effect += 1
    if (!text.trim()) {
      inflight.current = null
      clearWatchdog()
      setResult(null)
      setStatus('idle')
      return
    }
    setStatus((s) => (s === 'ready' ? 'stale' : s))
    counters.scheduled += 1
    const timer = setTimeout(() => {
      if (composing.current) { trace('skipped_composing', {}); return }
      counters.fired += 1
      trace('debounce_fired', {
        effect: counters.effect, scheduled: counters.scheduled,
        cancelled: counters.cancelled, fired: counters.fired,
      })
      try { send(0) } catch { setStatus('unavailable') }
    }, debounceMs)
    // ★ cleanup 은 debounce 타이머만 지운다. watchdog 은 건드리지 않는다.
    return () => {
      counters.cleanup += 1
      counters.cancelled += 1
      clearTimeout(timer)
    }
  }, [text, enabled, debounceMs, send, clearWatchdog])

  return { status, result, setComposing }
}
