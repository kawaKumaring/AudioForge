// 음성 처리 계산부 — 합성 신호만 쓴다(사용자 음성 없음).
import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097
import { Compressor, DeEsser, Limiter, compressGainDb } from './dynamics.ts'
// @ts-ignore TS5097
import { fadeInGain, fadeOutGain, clipEdgeGain } from './fades.ts'
// @ts-ignore TS5097
import { sanitizeVoiceFx, VOICE_FX_DEFAULTS } from './settings.ts'
// @ts-ignore TS5097
import { biquadCoef, Biquad } from './biquad.ts'

const SR = 48000
const sine = (f: number, amp: number, sec: number): Float32Array => {
  const a = new Float32Array(Math.round(SR * sec))
  for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin(2 * Math.PI * f * i / SR)
  return a
}
const peak = (a: Float32Array, from = 0, to = a.length): number => { let m = 0; for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i])); return m }
const rms = (a: Float32Array, from = 0, to = a.length): number => { let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i]; return Math.sqrt(s / (to - from)) }
/** 128 샘플씩 나눠 처리 — 실시간 처리 모듈과 같은 쪼개기. */
function blocks (ch: Float32Array[], proc: { process: (b: Float32Array[]) => void }): void {
  for (let i = 0; i < ch[0].length; i += 128) proc.process(ch.map((c) => c.subarray(i, Math.min(i + 128, c.length))))
}

test('크로스페이드: EqualPower 는 겹치는 동안 합친 힘이 일정하다', () => {
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const p = fadeOutGain('equalPower', t) ** 2 + fadeInGain('equalPower', t) ** 2
    assert.ok(Math.abs(p - 1) < 1e-9, `t=${t} 힘 ${p}`)
  }
  assert.equal(fadeInGain('linear', 0.3), 0.3)
  assert.equal(clipEdgeGain(500, 1000, 100, 100, 'linear'), 1)
  assert.ok(clipEdgeGain(0, 1000, 100, 0, 'equalPower') < 0.02)
})

test('컴프레서 이득 공식: 문턱 아래 0, 위는 비율대로, 니는 이어진다', () => {
  assert.equal(compressGainDb(-40, -20, 4, 6), 0)
  assert.ok(Math.abs(compressGainDb(0, -20, 4, 6) - (-15)) < 1e-9)          // 20dB 넘음 × (1/4-1)
  const a = compressGainDb(-23, -20, 4, 6), b = compressGainDb(-22.999, -20, 4, 6)
  assert.ok(Math.abs(a - b) < 1e-3, '니 경계에서 끊기지 않는다')
})

test('컴프레서: 큰 소리를 줄이고 작은 소리는 그대로 둔다', () => {
  const loud = sine(440, 0.9, 0.5), quiet = sine(440, 0.02, 0.5)
  const p = { thresholdDb: -20, ratio: 4, attackMs: 10, releaseMs: 100, kneeDb: 6, makeupDb: 0 }
  const c1 = new Compressor(SR, p); blocks([loud], c1)
  const c2 = new Compressor(SR, p); blocks([quiet], c2)
  assert.ok(peak(loud, SR * 0.3, SR * 0.5) < 0.5, '큰 소리가 줄었다')
  assert.ok(Math.abs(peak(quiet, SR * 0.3, SR * 0.5) - 0.02) < 1e-3, '작은 소리는 그대로')
})

test('치찰음 줄이기: 고역이 문턱 아래면 소리가 바뀌지 않고, 넘으면 고역만 줄인다', () => {
  const low = sine(300, 0.3, 0.5)
  const before = Float32Array.from(low)
  blocks([low], new DeEsser(SR, { freqHz: 6000, thresholdDb: -30, rangeDb: 10 }, 1))
  let maxDiff = 0; for (let i = 0; i < low.length; i++) maxDiff = Math.max(maxDiff, Math.abs(low[i] - before[i]))
  assert.ok(maxDiff < 1e-4, `저역만 있으면 그대로 (차이 ${maxDiff})`)

  const ess = sine(8000, 0.3, 0.5), voice = sine(300, 0.3, 0.5)
  const mix = new Float32Array(ess.length); for (let i = 0; i < mix.length; i++) mix[i] = ess[i] + voice[i]
  blocks([mix], new DeEsser(SR, { freqHz: 6000, thresholdDb: -30, rangeDb: 10 }, 1))
  // 8kHz 성분 크기를 따로 재기 위해 고역만 걸러 본다
  const hp = new Biquad(biquadCoef('highpass', SR, 6000)); const hi = mix.map((x) => hp.step(x))
  assert.ok(rms(hi, SR * 0.3, SR * 0.5) < 0.3 / Math.SQRT2 * 0.5, '치찰 대역이 줄었다(6dB 이상)')
})

test('리미터: 블록으로 나눠도 상한을 넘지 않고, 지연만큼 늦게 나온다', () => {
  const x = sine(440, 0.3, 1)
  for (let i = SR * 0.4; i < SR * 0.5; i++) x[i] *= 5            // 1.5 까지 튀는 구간
  const lim = new Limiter(SR, { ceilingDb: -1, lookaheadMs: 1.5, releaseMs: 50 }, 1)
  const src = Float32Array.from(x)
  blocks([x], lim)
  assert.ok(peak(x) <= Math.pow(10, -1 / 20) + 1e-6, `최대 ${peak(x)}`)
  const L = lim.latency
  let diff = 0; for (let i = L; i < SR * 0.3; i++) diff = Math.max(diff, Math.abs(x[i] - src[i - L]))
  assert.ok(diff < 1e-6, '튀기 전 구간은 지연만 있고 그대로')
})

test('설정 정리: 깨진 값·범위 밖은 기본값·한계로', () => {
  const s = sanitizeVoiceFx({ highpass: { on: 'yes', freqHz: 5000 }, reverb: { on: true, mix: NaN }, compressor: { ratio: 0.2 }, junk: 1 })
  assert.equal(s.highpass.on, VOICE_FX_DEFAULTS.highpass.on)
  assert.equal(s.highpass.freqHz, 300)
  assert.equal(s.reverb.on, true)
  assert.equal(s.reverb.mix, VOICE_FX_DEFAULTS.reverb.mix)
  assert.equal(s.compressor.ratio, 1)
  assert.deepEqual(sanitizeVoiceFx(null), VOICE_FX_DEFAULTS)
})
