/**
 * 클립 위 마우스 자리 → 무엇을 잡는가. 수치는 참고 도구 코드의 실제 값(계획 5절).
 *  - 페이드 손잡이 ±8px(SoundCraft edit_window.rs) — 페이드 끝, 위쪽 띠
 *  - 페이드 만들기 모서리: 위쪽 28% 높이 × 양 끝 14px(SoundCraft)
 *  - 자르기: 바깥 4px + 안쪽 5px, 짧은 클립은 안쪽을 폭의 1/3(EffectCraft timeline.rs)
 *  - 나머지 = 옮기기
 * x·y 는 클립 왼쪽 위 기준(px). 바깥 4px 는 x<0 또는 x>w 로 들어온다.
 */
export type ClipHit = 'fadeIn' | 'fadeOut' | 'trimStart' | 'trimEnd' | 'move' | null

export const HIT = { handle: 8, handleBand: 12, cornerFrac: 0.28, corner: 14, trimOut: 4, trimIn: 5 } as const

export function clipHit (x: number, y: number, w: number, h: number, fadeInPx: number, fadeOutPx: number): ClipHit {
  if (x < -HIT.trimOut || x > w + HIT.trimOut || y < 0 || y > h) return null
  if (x >= 0 && x <= w && y <= HIT.handleBand) {
    if (fadeInPx > 0 && Math.abs(x - fadeInPx) <= HIT.handle) return 'fadeIn'
    if (fadeOutPx > 0 && Math.abs(x - (w - fadeOutPx)) <= HIT.handle) return 'fadeOut'
  }
  if (y <= h * HIT.cornerFrac && x >= 0 && x <= w) {
    if (x <= HIT.corner) return 'fadeIn'
    if (x >= w - HIT.corner) return 'fadeOut'
  }
  const inner = w < 3 * HIT.trimIn ? w / 3 : HIT.trimIn
  if (x < inner) return 'trimStart'
  if (x > w - inner) return 'trimEnd'
  return 'move'
}

/** 잡은 것에 맞는 마우스 모양. */
export function hitCursor (h: ClipHit): string {
  switch (h) {
    case 'fadeIn': case 'fadeOut': return 'nwse-resize'
    case 'trimStart': case 'trimEnd': return 'ew-resize'
    case 'move': return 'grab'
    default: return 'default'
  }
}
