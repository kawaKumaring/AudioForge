import { useCallback, useEffect, useRef, useState } from 'react'
import { isCurrentResponse, type AnalysisResponse, type AnalysisResult } from '../../shared/inputAnalysis'

/**
 * 대사 입력 분석 훅 — 편집을 방해하지 않는 것이 첫 번째 규칙이다.
 *
 * 지키는 것
 *   · IME 조합 중에는 요청하지 않는다(조합 중 문자열은 사용자가 쓰려던 글이 아니다)
 *   · 입력이 멈춘 뒤에만 보낸다. 늦게 온 옛 응답은 **화면에 닿기 전에** 버린다
 *   · 실패·준비 지연은 상태일 뿐이다 — 합성 버튼과 편집을 절대 막지 않는다
 *   · 마지막으로 성공한 숫자는 남겨 두되 `stale` 로 표시한다
 *   · **어떤 경로로도 `준비 중…` 에 영원히 갇히지 않는다**
 *
 * `준비 중…` 에 갇히던 실제 결함
 * ------------------------------
 * 사용자 화면에서 `대사 분석 준비 중…` 이 풀리지 않았다. 응답을 **조용히 버리는** 두 경로가
 * 원인이었다.
 *   1) `SUPERSEDED`·`CANCELLED` 를 받으면 그냥 return 했다. 더 새 요청이 없으면 아무도 상태를
 *      바꾸지 않아 `preparing` 이 그대로 남는다. 편집기가 한 번 재마운트되면 옛 인스턴스의
 *      정리(analysis:cancel)가 **새 인스턴스의 진행 중 요청까지** 취소해 이 상태를 만든다.
 *   2) `window.api.analysis` 가 없거나 호출이 동기 예외를 던지면 timer 콜백 안에서 그대로 터져
 *      상태가 멈춘다.
 *
 * 그래서 (a) 취소·추월을 받으면 같은 입력으로 **한 번 다시 요청**하고, (b) 모든 호출을 가드와
 * try/catch 로 감싸고, (c) 마지막 안전망으로 요청마다 watchdog 을 걸어 무슨 일이 있어도 유한
 * 시간 안에 대기 상태를 벗어난다. 훅 정리에서 전역 취소를 **부르지 않는다** — 늦은 응답은
 * requestId·SHA 로 걸러지므로 다른 인스턴스의 요청을 죽일 이유가 없다.
 *
 * prewarm 은 **최적화일 뿐 분석의 선행 조건이 아니다.** 응답을 기다리지 않고 화면 진입 즉시
 * 현재 대사의 debounce 분석을 시작한다. prewarm 이 실패해도 분석은 그대로 진행된다.
 */
export const ANALYSIS_DEBOUNCE_MS = 400

/**
 * 마지막 안전망. main 의 worker 타임아웃(30초)보다 짧아 화면이 먼저 빠져나온다.
 * 성능 목표가 아니라 "무슨 일이 있어도 대기 상태를 벗어난다" 는 보장이다.
 */
export const ANALYSIS_WATCHDOG_MS = 12_000

/** composition 을 볼 범위. TTS 대사 편집기 안쪽에서 난 조합만 분석을 억제한다. */
export const TTS_EDITOR_SCOPE_SELECTOR = '[data-af-tts-editor]'

export type AnalysisStatus =
  | 'idle'          // 입력이 없다
  | 'preparing'     // 첫 요청 — tokenizer 콜드 로드(실측 약 6초)를 기다리는 중
  | 'analyzing'     // 분석 중
  | 'ready'         // 최신 분석 완료
  | 'stale'         // 입력이 바뀌어 지금 숫자는 옛것이다
  | 'unavailable'   // worker 실패·timeout·API 부재 — 조용히 넘어간다

export interface UseInputAnalysis {
  status: AnalysisStatus
  result: AnalysisResult | null
  setComposing: (composing: boolean) => void
}

let requestCounter = 0

/** 원문 SHA. 보안 컨텍스트가 아니면 null — 그때는 requestId 로만 판정한다(가용성 우선). */
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
  const [status, setStatus] = useState<AnalysisStatus>('idle')
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const composing = useRef(false)
  const inflight = useRef<string | null>(null)
  const everSucceeded = useRef(false)
  const alive = useRef(true)
  const retried = useRef<Set<string>>(new Set())

  const setComposing = useCallback((v: boolean) => { composing.current = v }, [])

  // prewarm 은 최적화다 — 응답을 기다리지 않고, 실패해도 분석을 막지 않는다.
  useEffect(() => {
    if (!enabled) return
    const id = setTimeout(() => {
      try {
        const p = window.api?.analysis?.prewarm?.()
        if (p && typeof p.catch === 'function') p.catch(() => {})
      } catch { /* prewarm 실패는 분석과 무관하다 */ }
    }, 0)
    return () => clearTimeout(id)
  }, [enabled])

  useEffect(() => () => { alive.current = false }, [])

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

  useEffect(() => {
    if (!enabled) return
    if (!text.trim()) {
      inflight.current = null
      setResult(null)
      setStatus('idle')
      return
    }
    setStatus((s) => (s === 'ready' ? 'stale' : s))
    let watchdog: ReturnType<typeof setTimeout> | null = null
    const clearWatchdog = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null } }

    const send = (attempt: number) => {
      requestCounter += 1
      const requestId = `a${requestCounter}`
      inflight.current = requestId
      setStatus(everSucceeded.current ? 'analyzing' : 'preparing')
      clearWatchdog()
      watchdog = setTimeout(() => {
        if (!alive.current || inflight.current !== requestId) return
        setStatus('unavailable')       // 무슨 일이 있어도 대기 상태를 벗어난다
      }, watchdogMs)

      const api = window.api?.analysis
      if (!api?.analyze) {
        clearWatchdog()
        setStatus('unavailable')       // API 가 없어도 편집·합성은 그대로 간다
        return
      }
      const sent = text
      let promise: Promise<AnalysisResponse>
      try {
        promise = api.analyze({
          requestId, text: sent,
          mode: opts.mode, referenceConditioningMode: opts.referenceConditioningMode,
        })
      } catch {
        clearWatchdog()
        setStatus('unavailable')
        return
      }
      promise.then(async (res) => {
        if (!alive.current || inflight.current !== requestId) return
        if (!res.ok && (res.code === 'SUPERSEDED' || res.code === 'CANCELLED')) {
          // 추월·취소인데 더 새 요청이 없다 — 여기서 그냥 돌아가면 `준비 중…` 에 갇힌다.
          // 같은 입력으로 딱 한 번 다시 물어본다.
          if (attempt === 0 && !retried.current.has(sent)) {
            retried.current.add(sent)
            send(1)
            return
          }
          clearWatchdog()
          setStatus('unavailable')
          return
        }
        const sha = await sha256(sent)
        if (!alive.current || inflight.current !== requestId) return
        const current = sha === null
          ? (res.ok && res.requestId === requestId)
          : isCurrentResponse(res, requestId, sha)
        clearWatchdog()
        if (!current || !res.ok) {
          setStatus('unavailable')
          return
        }
        everSucceeded.current = true
        setResult(res.result)
        setStatus('ready')
      }).catch(() => {
        if (!alive.current || inflight.current !== requestId) return
        clearWatchdog()
        setStatus('unavailable')       // 분석 실패는 상태일 뿐 — 합성을 막지 않는다
      })
    }

    const timer = setTimeout(() => {
      if (composing.current) return
      try { send(0) } catch { setStatus('unavailable') }
    }, debounceMs)
    return () => {
      clearTimeout(timer)
      clearWatchdog()
    }
  }, [text, enabled, debounceMs, watchdogMs, opts.mode, opts.referenceConditioningMode])

  return { status, result, setComposing }
}
