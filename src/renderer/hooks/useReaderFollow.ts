import { useEffect, useRef, useState, type RefObject } from 'react'
export function useReaderFollow({ body, playing, enabled, visible, documentId, caret, paragraphAt, offsets, reveal }: {
 body: RefObject<HTMLDivElement | null>; playing: boolean; enabled: boolean; visible: boolean; documentId?: string;
 caret: () => number; paragraphAt: (c: number) => number; offsets: number[];
 reveal: (index: number, how: 'nearest' | 'center', smooth: boolean, phrase: boolean) => void
}) {
  // 읽는 줄이 보이는 동안 화면을 고정한다. 직접 둘러본 뒤에는 명시적으로 복귀한다.
  const [followPaused, setFollowPaused] = useState(false)
  const followPausedRef = useRef(false)
  const resumeFollow = () => { followPausedRef.current = false; setFollowPaused(false) }
  useEffect(() => { resumeFollow() }, [documentId])
  const revealRef = useRef(reveal); revealRef.current = reveal
  useEffect(() => {
    if (!playing || !enabled || !visible) return
    const calm = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const range = document.createRange()
    let raf = 0, movedAt = -1000, lastPara = -1
    const lineAt = (el: Element, offset: number): { y: number; h: number } | null => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let left = offset
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const len = n.textContent?.length ?? 0
        if (left < len) {
          range.setStart(n, left); range.setEnd(n, Math.min(len, left + 1))
          const r = range.getClientRects()[0] || range.getBoundingClientRect()
          return r.height ? { y: r.top + r.height / 2, h: r.height } : null
        }
        left -= len
      }
      return null
    }
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const now = performance.now()
      if (followPausedRef.current || now - movedAt < 800) return
      const box = body.current
      const c = caret()
      if (!box || c < 0) return
      const para = paragraphAt(c)
      const el = box.querySelector(`[data-index="${para}"]`)
      if (!el) {
        // 아직 그리지 않은 문단(큰 책) — 어림 자리로 먼저 옮기면 그려진 뒤 다음 화면에서 줄을 맞춘다.
        if (para !== lastPara) { lastPara = para; movedAt = now; revealRef.current(para, 'center', false, false) }
        return
      }
      lastPara = para
      const line = lineAt(el, Math.max(0, c - (offsets[para] ?? 0)))
      if (!line) return
      const b = box.getBoundingClientRect()
      const y = line.y - b.top
      // 글자 타이밍의 작은 역행은 화면 역행으로 바꾸지 않는다. 화면 밖인 경우만 복귀한다.
      if (y >= line.h && y <= b.height * 0.76) return
      const off = y - b.height * 0.32
      const top = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, box.scrollTop + off))
      if (Math.abs(top - box.scrollTop) < 2) return
      movedAt = now
      box.scrollTo({ top, behavior: calm ? 'auto' : 'smooth' })
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, enabled, documentId, paragraphAt, offsets, caret, visible])
  const markUserScroll = () => {
    if (!enabled || !playing) return
    followPausedRef.current = true; setFollowPaused(true)
    const box = body.current
    if (box) box.scrollTo({ top: box.scrollTop, behavior: 'instant' })
  }

 return { followPaused, resumeFollow, markUserScroll }
}
