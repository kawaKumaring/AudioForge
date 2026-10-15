/**
 * 2차 필터(biquad) — RBJ Audio EQ Cookbook 계수, Direct Form I.
 *
 * 흡수 출처(2026-10-16, MIT/Apache): SoundCraft `crates/dsp/src/biquad.rs`, EffectCraft `crates/effects/src/audio_fx.rs`
 * (둘 다 RBJ 쿡북). 치찰음 줄이기의 대역 나누기·감지에 쓴다. 저음 자르기·EQ 는 화면의 BiquadFilterNode 가 같은 공식을 쓴다.
 */
export type BiquadKind = 'lowpass' | 'highpass' | 'peaking' | 'lowshelf' | 'highshelf'

export interface BiquadCoef { b0: number; b1: number; b2: number; a1: number; a2: number }

export function biquadCoef(kind: BiquadKind, sr: number, freq: number, q = Math.SQRT1_2, gainDb = 0): BiquadCoef {
  const f = Math.min(Math.max(freq, 1), sr * 0.49)
  const w = (2 * Math.PI * f) / sr
  const cos = Math.cos(w), sin = Math.sin(w)
  const alpha = sin / (2 * q)
  const A = Math.pow(10, gainDb / 40)
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number
  switch (kind) {
    case 'lowpass': b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break
    case 'highpass': b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break
    case 'peaking': b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; break
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha
      b0 = A * ((A + 1) - (A - 1) * cos + s); b1 = 2 * A * ((A - 1) - (A + 1) * cos); b2 = A * ((A + 1) - (A - 1) * cos - s)
      a0 = (A + 1) + (A - 1) * cos + s; a1 = -2 * ((A - 1) + (A + 1) * cos); a2 = (A + 1) + (A - 1) * cos - s; break
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha
      b0 = A * ((A + 1) + (A - 1) * cos + s); b1 = -2 * A * ((A - 1) + (A + 1) * cos); b2 = A * ((A + 1) + (A - 1) * cos - s)
      a0 = (A + 1) - (A - 1) * cos + s; a1 = 2 * ((A - 1) - (A + 1) * cos); a2 = (A + 1) - (A - 1) * cos - s; break
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/** 상태를 가진 필터 하나(채널 하나). */
export class Biquad {
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0
  c: BiquadCoef
  constructor (c: BiquadCoef) { this.c = c }
  step (x: number): number {
    const c = this.c
    const y = c.b0 * x + c.b1 * this.x1 + c.b2 * this.x2 - c.a1 * this.y1 - c.a2 * this.y2
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y
    return y
  }
  reset (): void { this.x1 = this.x2 = this.y1 = this.y2 = 0 }
}
