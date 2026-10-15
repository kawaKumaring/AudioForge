/**
 * 페이드·크로스페이드 곡선.
 *
 * 흡수 출처(2026-10-16, MIT/Apache): SoundCraft `crates/dsp/src/offline.rs` FadeShape, `crates/model/src/clip.rs` Fade.
 * v1 은 두 곡선만 둔다(계획 5절): EqualPower(기본 — 겹치는 동안 합친 크기가 일정) · Linear.
 * fade-out 은 fade-in 을 뒤집은 것(gain(1-t)). 크로스페이드 = 앞 클립 fade-out + 뒤 클립 fade-in 이 **같은 구간**.
 */
export type FadeShape = 'equalPower' | 'linear'

export const FADE_SHAPES: readonly FadeShape[] = ['equalPower', 'linear']

/** t: 0(시작)~1(끝) → fade-in 이득 0~1. 범위를 넘는 t 는 잘라 쓴다. */
export function fadeInGain(shape: FadeShape, t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return shape === 'linear' ? x : Math.sin((x * Math.PI) / 2)
}

export function fadeOutGain(shape: FadeShape, t: number): number {
  return fadeInGain(shape, 1 - t)
}

/** 크로스페이드 기본 길이(초). SoundCraft 코드에는 기본값이 없어 우리가 정했다 — 청취로 조정한다(계획 4절). */
export const CROSSFADE_DEFAULT_SEC = 0.02

/**
 * 클립 하나의 샘플 i(0..n-1)에 곱할 이득. fadeIn/fadeOut 은 샘플 수(0이면 없음).
 * 둘이 겹치면(클립보다 길면) 각각을 길이에 맞춰 줄이지 않고 그대로 곱한다 — 짧은 클립이 조용해지는 것은 의도된 결과.
 */
export function clipEdgeGain(i: number, n: number, fadeIn: number, fadeOut: number, shape: FadeShape): number {
  let g = 1
  if (fadeIn > 0 && i < fadeIn) g *= fadeInGain(shape, (i + 0.5) / fadeIn)
  const fromEnd = n - 1 - i
  if (fadeOut > 0 && fromEnd < fadeOut) g *= fadeInGain(shape, (fromEnd + 0.5) / fadeOut)
  return g
}
