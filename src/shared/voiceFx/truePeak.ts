/**
 * 실제 최대치(샘플 사이 포함) — 4배 다상 windowed-sinc 보간. python/audio_limiter.py 와 같은 필터.
 * 흡수 출처: SoundCraft `crates/dsp/src/meter.rs`.
 */
const OVERSAMPLE = 4
const TAPS_PER_PHASE = 12

function phaseFilters (): Float64Array[] {
  const n = OVERSAMPLE * TAPS_PER_PHASE
  const h = new Float64Array(n)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const t = (i - (n - 1) / 2) / OVERSAMPLE
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    h[i] = sinc * hann; sum += h[i]
  }
  for (let i = 0; i < n; i++) h[i] = (h[i] / sum) * OVERSAMPLE
  return Array.from({ length: OVERSAMPLE }, (_, p) => Float64Array.from({ length: TAPS_PER_PHASE }, (_, k) => h[p + k * OVERSAMPLE]))
}

const PHASES = phaseFilters()

/** 채널들의 실제 최대치(선형). */
export function truePeak (channels: ArrayLike<number>[]): number {
  let m = 0
  const half = TAPS_PER_PHASE / 2
  for (const x of channels) {
    const n = x.length
    for (let i = 0; i < n; i++) { const a = Math.abs(x[i]); if (a > m) m = a }
    for (const f of PHASES) {
      for (let i = 0; i < n; i++) {
        let acc = 0
        const base = i + half - 1                        // np.convolve(full)[half-1:] 와 같은 정렬
        for (let k = 0; k < TAPS_PER_PHASE; k++) {
          const j = base - k
          if (j >= 0 && j < n) acc += f[k] * x[j]
        }
        const a = Math.abs(acc); if (a > m) m = a
      }
    }
  }
  return m
}
