/**
 * 저장용 렌더 — 실시간 듣기와 **같은 처리 연결**을 OfflineAudioContext 로 돌린다.
 * 처리 지연(노이즈 제거 480 샘플 + 리미터 앞보기)만큼 앞을 잘라 원래 시간에 맞춘다.
 * 리미터가 켜져 있으면 마지막에 실제 최대치(샘플 사이 포함)를 재서 넘으면 고르게 낮춘다(python/audio_limiter.py 와 같은 보증).
 */
import { createVoiceFxChain, chainLatency, VOICE_FX_SAMPLE_RATE } from './chain'
import { sanitizeVoiceFx } from '../../../shared/voiceFx/settings'
import { truePeak } from '../../../shared/voiceFx/truePeak'

export interface VoiceFxRenderInfo { latencySamples: number; truePeakDb: number; scaledDb: number }

export async function renderVoiceFx (src: AudioBuffer, settings: unknown): Promise<{ buffer: AudioBuffer; info: VoiceFxRenderInfo }> {
  const s = sanitizeVoiceFx(settings)
  const sr = VOICE_FX_SAMPLE_RATE
  const ch = Math.max(1, Math.min(2, src.numberOfChannels))
  const latency = chainLatency(s, sr)
  const tailSec = s.reverb.on ? s.reverb.decaySec : 0
  const bodyLen = Math.round(src.duration * sr)
  const outLen = bodyLen + Math.round(tailSec * sr)
  const ctx = new OfflineAudioContext(2, outLen + latency, sr)
  const chain = await createVoiceFxChain(ctx, s)
  const node = ctx.createBufferSource(); node.buffer = src
  node.connect(chain.input); chain.output.connect(ctx.destination)
  node.start(0)
  const full = await ctx.startRendering()

  const out = new AudioBuffer({ numberOfChannels: ch, length: outLen, sampleRate: sr })
  const chans: Float32Array[] = []
  for (let c = 0; c < ch; c++) {
    const d = full.getChannelData(c).subarray(latency, latency + outLen)
    out.copyToChannel(d, c)
    chans.push(out.getChannelData(c))
  }
  let tp = truePeak(chans), scaledDb = 0
  const ceil = Math.pow(10, s.limiter.ceilingDb / 20)
  if (s.limiter.on && tp > ceil) {
    const k = ceil / tp
    for (const d of chans) for (let i = 0; i < d.length; i++) d[i] *= k
    scaledDb = 20 * Math.log10(k); tp = ceil
  }
  chain.dispose()
  return { buffer: out, info: { latencySamples: latency, truePeakDb: 20 * Math.log10(Math.max(tp, 1e-12)), scaledDb } }
}

// 실시간 연결도 같은 모듈에서 내보낸다 — 화면·검사가 한 곳에서 가져간다.
export { createVoiceFxChain } from './chain'
