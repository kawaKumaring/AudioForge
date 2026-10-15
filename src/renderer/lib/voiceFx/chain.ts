/**
 * 음성 처리 연결(그래프) — 실시간 듣기와 파일 저장이 **같은 함수**로 만든다.
 *
 * 순서(고정): 노이즈 제거 → 저음 자르기 → EQ(저음·또렷함·공기감) → 컴프레서 → 치찰음 줄이기 → 리버브(원음+잔향) → 리미터
 * - 기본 노드: 저음 자르기·EQ(BiquadFilter — RBJ 공식), 리버브(Convolver + 같은 씨앗으로 만든 잔향 → 매번 같은 소리)
 * - 실시간 모듈: 노이즈 제거·컴프레서·치찰음·리미터(voiceFx.worklet.ts → src/shared/voiceFx 계산부)
 * 값 조절은 연결을 그대로 두고 바로 반영(기본 노드는 약 20ms 로 부드럽게 — SoundCraft 1-pole 20ms 와 같은 생각).
 * 켜고 끄기는 연결을 다시 잇는다(드문 일).
 */
import workletUrl from './voiceFx.worklet.ts?worker&url'
import { EQ_BANDS, sanitizeVoiceFx, type VoiceFxSettings } from '../../../shared/voiceFx/settings'

export const VOICE_FX_SAMPLE_RATE = 48000                 // RNNoise 가 48kHz 전용
const SMOOTH_TAU = 0.02
const DENOISE_LATENCY = 480
const LIMITER_LOOKAHEAD_MS = 1.5
const LIMITER_RELEASE_MS = 50

const loaded = new WeakMap<BaseAudioContext, Promise<void>>()
export function ensureVoiceFxWorklet (ctx: BaseAudioContext): Promise<void> {
  let p = loaded.get(ctx)
  if (!p) { p = ctx.audioWorklet.addModule(workletUrl); loaded.set(ctx, p) }
  return p
}

/** 리미터 지연(샘플) — shared Limiter.latency 와 같은 계산. */
export function limiterLatency (sr: number): number { return Math.max(1, Math.round(sr * LIMITER_LOOKAHEAD_MS / 1000)) }

/** 처리 전체 지연(샘플). 저장은 이만큼 앞을 잘라 시간을 맞춘다. */
export function chainLatency (s: VoiceFxSettings, sr: number): number {
  return (s.denoise.on && sr === 48000 ? DENOISE_LATENCY : 0) + (s.limiter.on ? limiterLatency(sr) : 0)
}

/** 리버브 잔향 — 같은 씨앗이면 같은 잔향(실시간·저장이 같다). decaySec 에서 −60dB. */
export function makeReverbIR (ctx: BaseAudioContext, decaySec: number): AudioBuffer {
  const sr = ctx.sampleRate
  const pre = Math.round(sr * 0.01)
  const len = pre + Math.round(sr * decaySec * 1.2)
  const ir = ctx.createBuffer(2, len, sr)
  for (let c = 0; c < 2; c++) {
    let seed = 0x9e3779b9 ^ (c + 1) * 0x85ebca6b
    const rnd = (): number => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) * 2 - 1 }
    const d = ir.getChannelData(c)
    let lp = 0, energy = 0
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr
      lp = lp * 0.6 + rnd() * 0.4                          // 고역을 살짝 깎아 쇳소리를 줄인다
      d[i] = lp * Math.exp(-6.9 * t / decaySec)
      energy += d[i] * d[i]
    }
    const norm = 1 / Math.sqrt(Math.max(energy, 1e-12))
    for (let i = pre; i < len; i++) d[i] *= norm
  }
  return ir
}

export interface VoiceFxChain {
  input: GainNode
  output: GainNode
  /** 설정을 바꾼다 — 값만 바뀌면 바로, 켜고 끄기가 바뀌면 다시 잇는다. */
  set (next: unknown): void
  settings (): VoiceFxSettings
  /** 실시간 모듈이 보내는 감소량(dB) — 미터용. */
  onMeter (fn: (which: 'compressor' | 'deesser' | 'limiter', reductionDb: number) => void): void
  dispose (): void
}

export async function createVoiceFxChain (ctx: BaseAudioContext, initial: unknown): Promise<VoiceFxChain> {
  await ensureVoiceFxWorklet(ctx)
  let s = sanitizeVoiceFx(initial)
  const input = ctx.createGain(), output = ctx.createGain()
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = Math.SQRT1_2
  const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = EQ_BANDS.lowHz
  const pres = ctx.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = EQ_BANDS.presenceHz; pres.Q.value = 1
  const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = EQ_BANDS.airHz
  const node = (name: string, params: unknown): AudioWorkletNode =>
    new AudioWorkletNode(ctx, name, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: { params } })
  const denoise = node('af-denoise', { on: true })
  const comp = node('af-compressor', s.compressor)
  const deess = node('af-deesser', s.deesser)
  const limiter = node('af-limiter', { ceilingDb: s.limiter.ceilingDb, lookaheadMs: LIMITER_LOOKAHEAD_MS, releaseMs: LIMITER_RELEASE_MS })
  const revIn = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain(), revOut = ctx.createGain()
  const conv = ctx.createConvolver(); conv.normalize = false
  revIn.connect(dry).connect(revOut); revIn.connect(conv).connect(wet).connect(revOut)
  let irDecay = -1

  const meters: ((w: 'compressor' | 'deesser' | 'limiter', r: number) => void)[] = []
  const hook = (n: AudioWorkletNode, w: 'compressor' | 'deesser' | 'limiter'): void => {
    n.port.onmessage = (e: MessageEvent) => { for (const f of meters) f(w, (e.data as { reductionDb: number }).reductionDb) }
  }
  hook(comp, 'compressor'); hook(deess, 'deesser'); hook(limiter, 'limiter')

  const ramp = (p: AudioParam, v: number): void => {
    if ('setTargetAtTime' in p && ctx instanceof AudioContext) p.setTargetAtTime(v, ctx.currentTime, SMOOTH_TAU)
    else p.value = v
  }
  const applyValues = (): void => {
    ramp(hp.frequency, s.highpass.freqHz)
    ramp(low.gain, s.eq.lowDb); ramp(pres.gain, s.eq.presenceDb); ramp(air.gain, s.eq.airDb)
    comp.port.postMessage(s.compressor)
    deess.port.postMessage(s.deesser)
    limiter.port.postMessage({ ceilingDb: s.limiter.ceilingDb, lookaheadMs: LIMITER_LOOKAHEAD_MS, releaseMs: LIMITER_RELEASE_MS })
    ramp(wet.gain, s.reverb.mix); ramp(dry.gain, 1)
    if (s.reverb.on && irDecay !== s.reverb.decaySec) { conv.buffer = makeReverbIR(ctx, s.reverb.decaySec); irDecay = s.reverb.decaySec }
  }
  const all: AudioNode[] = [input, denoise, hp, low, pres, air, comp, deess, revIn, revOut, limiter]
  let shape = ''
  const wire = (): void => {
    const key = [s.denoise.on, s.highpass.on, s.eq.on, s.compressor.on, s.deesser.on, s.reverb.on, s.limiter.on].join()
    if (key === shape) return
    shape = key
    for (const n of all) { try { n.disconnect() } catch { /* 연결 없음 */ } }
    revIn.connect(dry).connect(revOut); revIn.connect(conv)                 // 리버브 내부 연결은 유지
    const steps: [boolean, AudioNode, AudioNode][] = [
      [s.denoise.on, denoise, denoise], [s.highpass.on, hp, hp], [s.eq.on, low, air],
      [s.compressor.on, comp, comp], [s.deesser.on, deess, deess], [s.reverb.on, revIn, revOut], [s.limiter.on, limiter, limiter],
    ]
    low.connect(pres).connect(air)
    let tail: AudioNode = input
    for (const [on, first, last] of steps) if (on) { tail.connect(first); tail = last }
    tail.connect(output)
  }
  applyValues(); wire()

  return {
    input, output,
    set (next) { s = sanitizeVoiceFx(next); applyValues(); wire() },
    settings: () => s,
    onMeter (fn) { meters.push(fn) },
    dispose () { for (const n of [...all, output, dry, wet, conv]) { try { n.disconnect() } catch { /* 이미 끊김 */ } } },
  }
}
