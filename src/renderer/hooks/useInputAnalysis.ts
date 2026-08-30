import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isCurrentResponse, type AnalysisResult,
} from '../../shared/inputAnalysis'

/**
 * 대사 입력 분석 훅 — 편집을 방해하지 않는 것이 첫 번째 규칙이다.
 *
 * 지키는 것
 *   · IME 조합 중에는 요청하지 않는다(조합 중 문자열은 사용자가 쓰려던 글이 아니다)
 *   · 입력이 멈춘 뒤에만 보낸다. 늦게 온 옛 응답은 **화면에 닿기 전에** 버린다
 *   · 실패·준비 지연은 상태일 뿐이다 — 합성 버튼과 편집을 절대 막지 않는다
 *   · 마지막으로 성공한 숫자는 남겨 두되 `stale` 로 표시한다. 옛 숫자를 새것처럼 다시
 *     띄우지 않는다(늦은 응답은 폐기지 재표시가 아니다)
 *
 * debounce 는 "입력이 멈췄는가" 를 보는 값이고 성능 목표가 아니다. 분석 자체는 상주 worker
 * 에서 실측 0~0.02초라 지연의 대부분은 사람의 타이핑 간격이다.
 */
/**
 * 입력이 멈췄는지 보는 **UX 조절값**이다. 권위 모델 상수가 아니다 —
 * 분석 자체는 상주 worker 에서 실측 0~0.02초라 체감 지연의 대부분은 사람의 타이핑 간격이다.
 * 바꾸려면 연속 요청 수와 체감 지연 실측을 근거로 남긴다.
 */
export const ANALYSIS_DEBOUNCE_MS = 400

/** composition 을 볼 범위. TTS 대사 편집기 안쪽에서 난 조합만 분석을 억제한다. */
export const TTS_EDITOR_SCOPE_SELECTOR = '[data-af-tts-editor]'

export type AnalysisStatus =
  | 'idle'          // 입력이 없다
  | 'preparing'     // 첫 요청 — tokenizer 콜드 로드(실측 약 7.9초)를 기다리는 중
  | 'analyzing'     // 분석 중
  | 'ready'         // 최신 분석 완료
  | 'stale'         // 입력이 바뀌어 지금 숫자는 옛것이다
  | 'unavailable'   // worker 실패·timeout·schema 불일치 — 조용히 넘어간다

export interface UseInputAnalysis {
  status: AnalysisStatus
  result: AnalysisResult | null
  /** 조합 중에는 요청을 멈춘다. 편집기가 그대로 넘겨 준다. */
  setComposing: (composing: boolean) => void
}

let requestCounter = 0

export function useInputAnalysis(
  text: string,
  opts: { enabled?: boolean; mode?: string; referenceConditioningMode?: string;
          debounceMs?: number; scopeSelector?: string } = {}
): UseInputAnalysis {
  const enabled = opts.enabled !== false
  const debounceMs = opts.debounceMs ?? ANALYSIS_DEBOUNCE_MS
  const scopeSelector = opts.scopeSelector ?? TTS_EDITOR_SCOPE_SELECTOR
  const [status, setStatus] = useState<AnalysisStatus>('idle')
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const composing = useRef(false)
  const inflight = useRef<string | null>(null)
  const everSucceeded = useRef(false)
  const alive = useRef(true)

  const setComposing = useCallback((v: boolean) => { composing.current = v }, [])

  // TTS 화면에 들어오면 낮은 우선순위로 tokenizer 를 데운다. 실패는 조용하다.
  useEffect(() => {
    if (!enabled) return
    const id = setTimeout(() => { void window.api.analysis?.prewarm?.().catch(() => {}) }, 0)
    return () => clearTimeout(id)
  }, [enabled])

  useEffect(() => () => {
    alive.current = false
    void window.api.analysis?.cancel?.().catch(() => {})
  }, [])

  // IME 조합 억제 — **편집기 컴포넌트를 건드리지 않는다.** composition 이벤트는 버블하므로
  // document 에서 듣되, **TTS 대사 편집기 안쪽에서 난 것만** 본다.
  //
  // 범위를 안 걸면 같은 화면의 검색창·참조 전사 입력·다른 모드의 input 에서 한글을 쳐도
  // 분석이 억제되거나 다시 돈다. 편집기 컴포넌트에 props 를 심지 않고 안정된 data 속성으로
  // 판정한다(그 컴포넌트가 caret·IME 책임을 갖고 있어 침범하지 않는다).
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
      // 모드 전환·unmount 뒤에 남은 조합 상태가 다음 마운트로 새지 않게 한다.
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
    // 입력이 바뀌었다 — 지금 숫자는 옛것이다. 지우지 않고 표시만 바꾼다.
    setStatus((s) => (s === 'ready' ? 'stale' : s))
    const timer = setTimeout(() => {
      // 조합 중 문자열은 사용자가 쓰려던 글이 아니다. 조합이 끝나면 값이 다시 바뀌므로
      // 이 effect 가 다시 돌아 요청한다 — 여기서는 그냥 넘어가면 된다.
      if (composing.current) return
      requestCounter += 1
      const requestId = `a${requestCounter}`
      inflight.current = requestId
      setStatus(everSucceeded.current ? 'analyzing' : 'preparing')
      const sent = text
      window.api.analysis.analyze({
        requestId, text: sent,
        mode: opts.mode, referenceConditioningMode: opts.referenceConditioningMode,
      }).then(async (res) => {
        if (!alive.current) return
        if (inflight.current !== requestId) return   // 더 새 요청이 있다 — 조용히 버린다
        const sha = await sha256(sent)
        if (!isCurrentResponse(res, requestId, sha)) {
          // 늦게 온 옛 결과이거나 다른 입력의 결과다. 이전 숫자를 다시 띄우지 않는다.
          if (!res.ok && (res.code === 'SUPERSEDED' || res.code === 'CANCELLED')) return
          setStatus('unavailable')
          return
        }
        everSucceeded.current = true
        setResult(res.result)
        setStatus('ready')
      }).catch(() => {
        if (!alive.current || inflight.current !== requestId) return
        setStatus('unavailable')            // 분석 실패는 상태일 뿐 — 합성을 막지 않는다
      })
    }, debounceMs)
    return () => clearTimeout(timer)
  }, [text, enabled, debounceMs, opts.mode, opts.referenceConditioningMode])

  return { status, result, setComposing }
}

/** 원문 SHA — main 이 준 값과 대조해 늦은 응답을 가른다. */
async function sha256(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
