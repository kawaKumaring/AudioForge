// 끌어 옮기는 동안 **목록 칸의 끝에 머물면 그쪽으로 굴린다** (2026-10-03).
//
// ★왜: 앱 틀이 바뀌어 카드 목록은 고정 머리와 고정 하단 막대 사이의 굴림 칸(850 창에서 591px)에서만 굴러간다.
//   카드 한 장이 그 칸의 절반을 넘어(316px) 첫 카드를 맨 뒤로 옮기려면 끄는 도중에 굴러가야 한다.
//   실제 앱에서 손잡이를 잡고 칸 아래 끝에 머물러도 칸이 전혀 굴러가지 않았다(측정: scrollTop 0 그대로) —
//   브라우저의 끌기 자동 굴림에 기대지 않고 앱이 직접 굴린다.
// ★포인터가 칸 **밖**(위 머리·아래 고정 막대 위)에 있어도 그쪽 끝으로 본다 — 막대 위에 올린 것은 '더 아래로' 라는 뜻이다.
import { useEffect, type RefObject } from 'react'

/** 칸 끝에서 얼마나 빨리 굴릴지(한 화면 틀마다 px). 끝 영역 밖이면 0. 칸 밖은 최대 속도. */
export function edgeVelocity(y: number, top: number, bottom: number, edge = 64, max = 22): number {
  if (bottom - top < edge * 2) edge = Math.max(8, Math.floor((bottom - top) / 3))   // 아주 낮은 칸에서도 가운데에는 멈춘 자리가 있게
  if (y < top + edge) return -Math.max(1, Math.round(max * Math.min(1, (top + edge - y) / edge)))
  if (y > bottom - edge) return Math.max(1, Math.round(max * Math.min(1, (y - (bottom - edge)) / edge)))
  return 0
}

/** 이 요소를 담고 실제로 굴러가는 가장 가까운 칸. */
export function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n
  }
  return null
}

/** `active` 인 동안(끄는 중) 문서의 dragover 로 포인터 높이를 받아, 굴림 칸 끝에 있으면 굴린다. 놓거나 끝나면 멈춘다. */
export function useDragEdgeScroll(active: boolean, anchor: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!active) return
    const scroller = scrollParentOf(anchor.current)
    if (!scroller) return
    let y: number | null = null
    let raf = 0
    const step = () => {
      raf = 0
      if (y === null) return
      const r = scroller.getBoundingClientRect()
      const v = edgeVelocity(y, r.top, r.bottom)
      if (!v) return
      const before = scroller.scrollTop
      scroller.scrollTop = before + v
      if (scroller.scrollTop !== before) raf = requestAnimationFrame(step)      // 끝에 닿으면 멈춘다
    }
    const onOver = (e: globalThis.DragEvent) => { y = e.clientY; if (!raf) raf = requestAnimationFrame(step) }
    const stop = () => { y = null; if (raf) { cancelAnimationFrame(raf); raf = 0 } }
    document.addEventListener('dragover', onOver, true)
    document.addEventListener('drop', stop, true)
    document.addEventListener('dragend', stop, true)
    return () => {
      stop()
      document.removeEventListener('dragover', onOver, true)
      document.removeEventListener('drop', stop, true)
      document.removeEventListener('dragend', stop, true)
    }
  }, [active, anchor])
}
