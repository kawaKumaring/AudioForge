/**
 * 음성 처리 설정 — 순서는 고정: 노이즈 제거 → 저음 자르기 → EQ → 컴프레서 → 치찰음 줄이기 → 리버브 → 리미터.
 * (사용자 지시 2026-10-16: 노이즈 제거 → HPF·EQ → 컴프레서 → 리버브(선택, 2~5%). 치찰음·리미터는 흡수 권장.)
 *
 * 기본값 근거: SoundCraft `crates/dsp/src/plugins/` 기본값에서 음성용으로 조정(계획 6절).
 * 모든 값은 `sanitizeVoiceFx` 를 거친다 — 저장된 값이 깨져도 범위 밖·숫자 아님은 기본값으로 돌린다.
 */
export interface VoiceFxSettings {
  denoise: { on: boolean }
  highpass: { on: boolean; freqHz: number }
  eq: { on: boolean; lowDb: number; presenceDb: number; airDb: number }
  compressor: { on: boolean; thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; kneeDb: number; makeupDb: number }
  deesser: { on: boolean; freqHz: number; thresholdDb: number; rangeDb: number }
  reverb: { on: boolean; mix: number; decaySec: number }
  limiter: { on: boolean; ceilingDb: number }
}

/** EQ 고정 대역 — 값(dB)만 조절한다. 저음 몸통·말소리 또렷함·공기감. */
export const EQ_BANDS = { lowHz: 120, presenceHz: 3000, airHz: 10000 } as const

export const VOICE_FX_DEFAULTS: VoiceFxSettings = {
  denoise: { on: false },
  highpass: { on: true, freqHz: 80 },
  eq: { on: false, lowDb: 0, presenceDb: 0, airDb: 0 },
  compressor: { on: true, thresholdDb: -20, ratio: 4, attackMs: 10, releaseMs: 100, kneeDb: 6, makeupDb: 0 },
  deesser: { on: false, freqHz: 6000, thresholdDb: -30, rangeDb: 10 },
  reverb: { on: false, mix: 0.03, decaySec: 0.8 },
  limiter: { on: true, ceilingDb: -1 },
}

/** 조절 범위 — 화면 슬라이더와 저장값 검사가 같은 표를 쓴다. */
export const VOICE_FX_RANGES = {
  'highpass.freqHz': [20, 300],
  'eq.lowDb': [-12, 12], 'eq.presenceDb': [-12, 12], 'eq.airDb': [-12, 12],
  'compressor.thresholdDb': [-60, 0], 'compressor.ratio': [1, 20], 'compressor.attackMs': [0.1, 100],
  'compressor.releaseMs': [10, 1000], 'compressor.kneeDb': [0, 24], 'compressor.makeupDb': [0, 24],
  'deesser.freqHz': [3000, 12000], 'deesser.thresholdDb': [-60, 0], 'deesser.rangeDb': [0, 24],
  'reverb.mix': [0, 0.3], 'reverb.decaySec': [0.2, 3],
  'limiter.ceilingDb': [-6, 0],
} as const

export function sanitizeVoiceFx(raw: unknown): VoiceFxSettings {
  const src = (raw && typeof raw === 'object') ? raw as Record<string, Record<string, unknown>> : {}
  const out = JSON.parse(JSON.stringify(VOICE_FX_DEFAULTS)) as VoiceFxSettings
  for (const sec of Object.keys(out) as (keyof VoiceFxSettings)[]) {
    const from = src[sec]
    if (!from || typeof from !== 'object') continue
    const to = out[sec] as unknown as Record<string, unknown>
    for (const key of Object.keys(to)) {
      const v = from[key]
      if (key === 'on') { if (typeof v === 'boolean') to.on = v; continue }
      const range = (VOICE_FX_RANGES as Record<string, readonly [number, number]>)[`${sec}.${key}`]
      if (typeof v === 'number' && Number.isFinite(v) && range) to[key] = Math.min(range[1], Math.max(range[0], v))
    }
  }
  return out
}
