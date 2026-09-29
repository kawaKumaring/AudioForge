/**
 * 큰 책은 **보이는 문단만** 그린다 — 자리 계산만 한다(순수 함수).
 *
 * ★왜 (2026-09-30 실측, 3만 문단 · 5.5MB): 문단을 전부 그리면 열 때 3.7초, 문단을 누를 때마다 120~170ms
 *   (거의 전부가 브라우저의 배치·그리기 — 리액트는 50ms 안쪽). 덩이가 넘어갈 때마다도 같은 값이 든다.
 *   3천 문단은 누름 20ms · 열기 0.55초로 문제없다 → 그보다 큰 책만 창을 쓴다(`WINDOW_FROM`).
 * ★`content-visibility` 로는 안 됐다 — 열기는 2.0초로 줄었지만 문단마다 보임 감시가 붙어 누름이 오히려
 *   210~370ms 로 늘었다(보임 계산만 388ms/3회 실측).
 *
 * 높이는 **어림 → 잰 값**으로 바뀐다. 어림은 글자 수로 줄 수를 세고, 그려진 문단은 실제 높이를 잰다.
 * 자리(각 문단의 위쪽 끝)는 높이의 누적 합이다.
 */
export const WINDOW_FROM = 3000
/** 보이는 칸 위아래로 더 그려 둘 높이(px) — 빠르게 굴려도 빈칸이 보이지 않게. */
export const OVERSCAN_PX = 1200

export interface RowGeometry {
  /** 글자 크기(px). */
  fontSize: number
  /** 문단 글이 들어가는 너비(px). */
  contentWidth: number
  /** 줄 높이 배수. */
  lineHeight: number
  /** 문단 하나의 위아래 안쪽 여백 + 아래 간격(px). */
  chrome: number
}

/** 글자 수로 어림한 문단 높이. 한글 한 글자 ≈ 글자 크기 너비. */
export function estimateHeight(chars: number, g: RowGeometry): number {
  const perLine = Math.max(1, Math.floor(g.contentWidth / Math.max(1, g.fontSize * 0.98)))
  const lines = Math.max(1, Math.ceil(chars / perLine))
  return Math.round(lines * g.fontSize * g.lineHeight + g.chrome)
}

/** 각 문단의 위쪽 끝(길이 n+1 — 마지막 칸이 전체 높이). */
export function offsetsOf(heights: ArrayLike<number>): Float64Array {
  const out = new Float64Array(heights.length + 1)
  for (let i = 0; i < heights.length; i++) out[i + 1] = out[i] + heights[i]
  return out
}

/** 이 자리(px)를 품은 문단 번호. */
export function indexAt(offsets: Float64Array, y: number): number {
  const n = offsets.length - 1
  if (n <= 0) return 0
  let lo = 0, hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= y) lo = mid; else hi = mid - 1
  }
  return lo
}

/** 그릴 문단 범위 [start, end) — 보이는 칸 + 위아래 여유. 꼭 넣어야 할 문단(`keep`)이 있으면 함께 넣는다. */
export function visibleRange(offsets: Float64Array, scrollTop: number, viewHeight: number,
  overscan = OVERSCAN_PX): { start: number; end: number } {
  const n = offsets.length - 1
  if (n <= 0) return { start: 0, end: 0 }
  const start = indexAt(offsets, Math.max(0, scrollTop - overscan))
  const end = Math.min(n, indexAt(offsets, scrollTop + viewHeight + overscan) + 1)
  return { start, end: Math.max(end, start + 1) }
}

/** 이 문단을 칸 가운데(또는 위)로 가져오려면 굴릴 자리. */
export function scrollTopFor(offsets: Float64Array, index: number, viewHeight: number, how: 'center' | 'top'): number {
  const n = offsets.length - 1
  const i = Math.max(0, Math.min(n - 1, index))
  const top = offsets[i], h = offsets[i + 1] - offsets[i]
  const want = how === 'center' && h < viewHeight * 0.8 ? top - (viewHeight - h) / 2 : top - 16
  return Math.max(0, Math.min(want, offsets[n] - viewHeight))
}
