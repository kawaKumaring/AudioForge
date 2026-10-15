/**
 * 음성 편집 — 재생·저장 엔진. 실시간 재생과 파일 저장이 **같은 섞기 함수(buildMix)** 를 쓴다 → 들은 소리 = 저장된 소리.
 *
 * 연결: 클립(원본 버퍼 → 클립 이득·페이드) → 트랙(이득 → 처리 연결 → 지연 맞춤) → 출력 리미터(−1dBTP) → 스피커/파일
 * ★지연 맞춤: 트랙마다 처리 지연(노이즈 제거 480·리미터 72 샘플)이 달라 그대로 섞으면 끼어들기 타이밍이 어긋난다.
 *   가장 긴 트랙에 맞춰 짧은 트랙을 늦춘다(SoundCraft `crates/mix` 의 지연 보정과 같은 생각). 저장은 전체 지연만큼 앞을 자른다.
 */
import { createVoiceFxChain, chainLatency, limiterLatency, VOICE_FX_SAMPLE_RATE, type VoiceFxChain } from '../voiceFx/chain'
import { fadeInGain, type FadeShape } from '../../../shared/voiceFx/fades'
import { VOICE_FX_DEFAULTS } from '../../../shared/voiceFx/settings'
import { truePeak } from '../../../shared/voiceFx/truePeak'
import { encodeWav16 } from '../../../shared/voiceFx/wav'
import { mixSchedule, projectDuration, type VeProject } from '../../../shared/voiceEdit/model'

export const SR = VOICE_FX_SAMPLE_RATE
const MASTER_FX = { ...VOICE_FX_DEFAULTS, highpass: { on: false, freqHz: 80 }, compressor: { ...VOICE_FX_DEFAULTS.compressor, on: false }, limiter: { on: true, ceilingDb: -1 } }
const FADE_POINTS_PER_SEC = 400

// ── 원본 불러오기 · 파형 요약 ────────────────────────────────────────────────
const buffers = new Map<string, Promise<AudioBuffer>>()
let decodeCtx: OfflineAudioContext | null = null

export function loadBuffer (path: string): Promise<AudioBuffer> {
  let p = buffers.get(path)
  if (!p) {
    p = (async () => {
      const url = await window.api.audio.getFileUrl(path) as string
      const res = await fetch(url)
      if (!res.ok) throw Error('소리 파일을 읽지 못했습니다')
      decodeCtx ??= new OfflineAudioContext(1, 1, SR)
      return await decodeCtx.decodeAudioData(await res.arrayBuffer())       // 48kHz 로 바꿔 들인다
    })()
    buffers.set(path, p)
    p.catch(() => buffers.delete(path))
  }
  return p
}

/** 파형 요약 — 초당 200칸의 [최소, 최대](채널 합). 모든 확대에서 이것으로 그린다(EffectCraft waveform.rs). */
export const PEAK_BINS_PER_SEC = 200
const peaks = new Map<string, Float32Array>()
export async function loadPeaks (path: string): Promise<Float32Array> {
  const hit = peaks.get(path)
  if (hit) return hit
  const b = await loadBuffer(path)
  const per = Math.max(1, Math.round(b.sampleRate / PEAK_BINS_PER_SEC))
  const bins = Math.ceil(b.length / per)
  const out = new Float32Array(bins * 2)
  const chans = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c))
  for (let k = 0; k < bins; k++) {
    let lo = 0, hi = 0
    const a = k * per, z = Math.min(b.length, a + per)
    for (let i = a; i < z; i++) {
      let s = 0
      for (const d of chans) s += d[i]
      s /= chans.length
      if (s < lo) lo = s; if (s > hi) hi = s
    }
    out[2 * k] = lo; out[2 * k + 1] = hi
  }
  peaks.set(path, out)
  return out
}

// ── 섞기 ─────────────────────────────────────────────────────────────────
function fadeCurve (shape: FadeShape, fadeSec: number, fromT: number, outgoing: boolean): Float32Array {
  const len = Math.max(2, Math.ceil((fadeSec - fromT) * FADE_POINTS_PER_SEC) + 1)
  const c = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    const t = (fromT + (i / (len - 1)) * (fadeSec - fromT)) / fadeSec
    c[i] = fadeInGain(shape, outgoing ? 1 - t : t)
  }
  return c
}

export interface MixHandle {
  trackChains: Map<string, VoiceFxChain>
  master: VoiceFxChain
  /** 전체 지연(초) — 저장은 이만큼 앞을 자른다. 재생은 화면 위치를 이만큼 늦춰 보인다. */
  latencySec: number
  stop (): void
}

/**
 * ctx 에 프로젝트를 놓는다. from(초)부터 to(초)까지, ctx 시간 at 에 시작.
 * 실시간·저장이 모두 이 함수를 쓴다.
 */
export async function buildMix (ctx: BaseAudioContext, p: VeProject, from: number, to: number, at: number): Promise<MixHandle> {
  const sched = mixSchedule(p).filter((s) => s.when < to && s.when + s.duration > from)
  const bufs = new Map<string, AudioBuffer>()
  await Promise.all([...new Set(sched.map((s) => s.path))].map(async (path) => { bufs.set(path, await loadBuffer(path)) }))

  const master = await createVoiceFxChain(ctx, MASTER_FX)
  master.output.connect(ctx.destination)
  const lat = new Map(p.tracks.map((t) => [t.id, chainLatency(t.fx, SR)]))
  const maxLat = Math.max(0, ...lat.values())
  const trackChains = new Map<string, VoiceFxChain>()
  const trackIn = new Map<string, GainNode>()
  for (const t of p.tracks) {
    const g = ctx.createGain(); g.gain.value = Math.pow(10, t.gainDb / 20)
    const chain = await createVoiceFxChain(ctx, t.fx)
    const delay = ctx.createDelay(1); delay.delayTime.value = (maxLat - (lat.get(t.id) ?? 0)) / SR
    g.connect(chain.input); chain.output.connect(delay).connect(master.input)
    trackChains.set(t.id, chain); trackIn.set(t.id, g)
  }
  const sources: AudioBufferSourceNode[] = []
  for (const s of sched) {
    const buf = bufs.get(s.path)
    const dest = trackIn.get(s.trackId)
    if (!buf || !dest) continue
    const skip = Math.max(0, from - s.when)                  // 클립 안에서 건너뛸 길이
    const dur = Math.min(s.duration - skip, to - Math.max(from, s.when))
    if (dur <= 0) continue
    const startAt = at + Math.max(0, s.when - from)
    const src = ctx.createBufferSource(); src.buffer = buf
    const cg = ctx.createGain()
    cg.gain.setValueAtTime(s.gain, startAt)
    if (s.fadeIn > skip) cg.gain.setValueCurveAtTime(fadeCurve(s.fadeInShape, s.fadeIn, skip, false).map((v) => v * s.gain), startAt, s.fadeIn - skip)
    const outStart = s.duration - s.fadeOut                 // 클립 안에서 페이드 아웃이 시작하는 자리
    if (s.fadeOut > 0) {
      const into = Math.max(0, skip - outStart)
      const when = startAt + Math.max(0, outStart - skip)
      if (into < s.fadeOut) cg.gain.setValueCurveAtTime(fadeCurve(s.fadeOutShape, s.fadeOut, into, true).map((v) => v * s.gain), when, s.fadeOut - into)
    }
    src.connect(cg).connect(dest)
    src.start(startAt, s.offset + skip, dur)
    sources.push(src)
  }
  const latencySec = (maxLat + limiterLatency(SR)) / SR
  return {
    trackChains, master, latencySec,
    stop () {
      for (const s of sources) { try { s.stop() } catch { /* 이미 끝남 */ } try { s.disconnect() } catch { /* 끊김 */ } }
      for (const c of trackChains.values()) c.dispose()
      for (const g of trackIn.values()) { try { g.disconnect() } catch { /* 끊김 */ } }
      master.dispose()
    },
  }
}

// ── 실시간 재생 ──────────────────────────────────────────────────────────
export class VoiceEditPlayer {
  private ctx: AudioContext | null = null
  private mix: MixHandle | null = null
  private startedAt = 0      // ctx 시간
  private startFrom = 0      // 프로젝트 시간
  private loop: [number, number] | null = null
  private loopTimer = 0
  private gen = 0
  playing = false
  onMeter: ((which: string, trackId: string, db: number) => void) | null = null

  private ensure (): AudioContext {
    this.ctx ??= new AudioContext({ sampleRate: SR, latencyHint: 'interactive' })
    return this.ctx
  }

  /** from 초부터 재생. loop 가 있으면 그 구간을 반복. */
  async play (p: VeProject, from: number, loop: [number, number] | null = null): Promise<void> {
    this.stop()
    const ctx = this.ensure()
    await ctx.resume()
    const g = ++this.gen
    this.loop = loop && loop[1] - loop[0] > 0.05 ? loop : null
    const begin = this.loop ? Math.min(Math.max(from, this.loop[0]), this.loop[1]) : from
    const to = this.loop ? this.loop[1] : projectDuration(p) + 0.05
    const at = ctx.currentTime + 0.05
    const mix = await buildMix(ctx, p, begin, to, at)
    if (g !== this.gen) { mix.stop(); return }              // 그 사이 멈췄거나 다시 눌렀다
    for (const [tid, ch] of mix.trackChains) ch.onMeter((w, db) => this.onMeter?.(w, tid, db))
    mix.master.onMeter((w, db) => this.onMeter?.(w, 'master', db))
    this.mix = mix; this.startedAt = at; this.startFrom = begin; this.playing = true
    const remain = (to - begin) + mix.latencySec
    this.loopTimer = window.setTimeout(() => {
      if (g !== this.gen) return
      if (this.loop) void this.play(p, this.loop[0], this.loop)
      else this.stop()
    }, remain * 1000)
  }

  /** 지금 들리는 프로젝트 위치(초) — 처리 지연만큼 늦춰서 소리와 화면이 맞는다. */
  position (): number {
    if (!this.ctx || !this.playing || !this.mix) return this.startFrom
    return this.startFrom + Math.max(0, this.ctx.currentTime - this.startedAt - this.mix.latencySec)
  }

  /** 처리 값만 바뀌면 끊지 않고 바로 반영. */
  setTrackFx (trackId: string, fx: unknown): boolean {
    const ch = this.mix?.trackChains.get(trackId)
    if (!ch) return false
    ch.set(fx); return true
  }

  stop (): void {
    this.gen++
    window.clearTimeout(this.loopTimer)
    this.mix?.stop(); this.mix = null
    if (this.playing) this.startFrom = this.position()
    this.playing = false
  }

  async dispose (): Promise<void> { this.stop(); await this.ctx?.close().catch(() => {}); this.ctx = null }
}

// ── 저장 ─────────────────────────────────────────────────────────────────
export async function renderProject (p: VeProject): Promise<{ wav: Uint8Array; seconds: number; truePeakDb: number }> {
  const dur = projectDuration(p)
  if (!(dur > 0)) throw Error('섞을 클립이 없습니다')
  const tail = Math.max(0, ...p.tracks.map((t) => (t.fx.reverb.on ? t.fx.reverb.decaySec : 0)))
  const outLen = Math.ceil((dur + tail) * SR)
  const pre = Math.max(0, ...p.tracks.map((t) => chainLatency(t.fx, SR))) + limiterLatency(SR)
  const ctx = new OfflineAudioContext(2, outLen + pre, SR)
  const mix = await buildMix(ctx, p, 0, dur, 0)
  const full = await ctx.startRendering()
  mix.stop()
  const chans = [0, 1].map((c) => full.getChannelData(c).slice(pre, pre + outLen))
  let tp = truePeak(chans)
  const ceil = Math.pow(10, -1 / 20)
  if (tp > ceil) { const k = ceil / tp; for (const d of chans) for (let i = 0; i < d.length; i++) d[i] *= k; tp = ceil }
  return { wav: encodeWav16(chans, SR), seconds: outLen / SR, truePeakDb: 20 * Math.log10(Math.max(tp, 1e-12)) }
}
