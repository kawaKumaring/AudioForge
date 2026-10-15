/**
 * 음량 다루기 — 컴프레서·치찰음 줄이기·리미터. **블록 단위로 이어서 처리**하는 순수 코드.
 *
 * 실시간 처리 모듈(AudioWorklet)과 파일 저장(OfflineAudioContext)이 이 클래스를 그대로 감싼다 →
 * 들은 소리와 저장된 소리가 같다. 채널은 같은 이득을 쓴다(스테레오 위치가 흔들리지 않게).
 *
 * 흡수 출처(2026-10-16, MIT/Apache): SoundCraft `crates/dsp/src/plugins/dynamics.rs`
 *   - Compressor `compress_gr` 소프트 니 이득 공식, 기본 −20dB·4:1·10ms·100ms·니 6dB
 *   - DeEsser — 고역 감지 신호의 크기로 고역만 줄인다, 기본 6kHz·−30dB·최대 10dB
 *   - Maximizer — 앞보기 창의 최소 이득(min-hold) → 같은 길이 이동평균 → 신호를 늦춰 미리 줄인다, 앞보기 1.5ms·해제 50ms
 */
import { Biquad, biquadCoef } from './biquad.ts'

const dbToLin = (db: number): number => Math.pow(10, db / 20)
const linToDb = (v: number): number => 20 * Math.log10(Math.max(v, 1e-12))
/** 시간 상수(ms) → 한 샘플당 따라가는 계수. */
const coefMs = (ms: number, sr: number): number => (ms <= 0 ? 0 : Math.exp(-1 / (sr * ms / 1000)))

/** 소프트 니 압축량(dB, 0 이하). x=입력 크기 dB, t=문턱, r=비율, w=니 폭. */
export function compressGainDb(x: number, t: number, r: number, w: number): number {
  const over = x - t
  const slope = 1 / r - 1
  if (2 * over < -w) return 0
  if (w > 0 && 2 * Math.abs(over) <= w) return slope * (over + w / 2) ** 2 / (2 * w)
  return slope * over
}

export interface CompressorParams { thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; kneeDb: number; makeupDb: number }

export class Compressor {
  private grDb = 0
  /** 마지막 블록의 최대 압축량(dB, 양수) — 미터용. */
  reductionDb = 0
  private sr: number
  p: CompressorParams
  constructor (sr: number, p: CompressorParams) { this.sr = sr; this.p = p }
  process (ch: Float32Array[]): void {
    const n = ch[0]?.length ?? 0
    const att = coefMs(this.p.attackMs, this.sr), rel = coefMs(this.p.releaseMs, this.sr)
    const makeup = dbToLin(this.p.makeupDb)
    let maxRed = 0
    for (let i = 0; i < n; i++) {
      let peak = 0
      for (const c of ch) peak = Math.max(peak, Math.abs(c[i]))
      const target = compressGainDb(linToDb(peak), this.p.thresholdDb, Math.max(1, this.p.ratio), Math.max(0, this.p.kneeDb))
      const k = target < this.grDb ? att : rel                     // 더 줄일 때는 공격, 풀 때는 해제
      this.grDb = target + (this.grDb - target) * k
      const g = dbToLin(this.grDb) * makeup
      for (const c of ch) c[i] *= g
      if (-this.grDb > maxRed) maxRed = -this.grDb
    }
    this.reductionDb = maxRed
  }
}

export interface DeEsserParams { freqHz: number; thresholdDb: number; rangeDb: number }

/**
 * 치찰음 줄이기. 소리를 freq 아래·위로 나눠(아래 = 저역통과, 위 = 원래 − 아래 → 합치면 정확히 원래 소리)
 * 위쪽 크기가 문턱을 넘은 만큼(최대 range) 위쪽만 줄인다. 넘지 않으면 소리가 **바뀌지 않는다**.
 */
export class DeEsser {
  private lp: Biquad[] = []
  private det: Biquad
  private envDb = -120
  private grDb = 0
  reductionDb = 0
  private sr: number
  p: DeEsserParams
  constructor (sr: number, p: DeEsserParams, channels: number) {
    this.sr = sr; this.p = p
    for (let i = 0; i < channels; i++) this.lp.push(new Biquad(biquadCoef('lowpass', sr, p.freqHz)))
    this.det = new Biquad(biquadCoef('highpass', sr, p.freqHz))
  }
  process (ch: Float32Array[]): void {
    const n = ch[0]?.length ?? 0
    const envAtt = coefMs(1, this.sr), envRel = coefMs(60, this.sr)
    const gAtt = coefMs(1, this.sr), gRel = coefMs(80, this.sr)
    let maxRed = 0
    for (let i = 0; i < n; i++) {
      let mono = 0
      for (const c of ch) mono += c[i]
      const hi = Math.abs(this.det.step(mono / ch.length))
      const lv = linToDb(hi)
      this.envDb = lv + (this.envDb - lv) * (lv > this.envDb ? envAtt : envRel)
      const target = -Math.min(Math.max(this.envDb - this.p.thresholdDb, 0), this.p.rangeDb)
      this.grDb = target + (this.grDb - target) * (target < this.grDb ? gAtt : gRel)
      const g = dbToLin(this.grDb)
      for (let k = 0; k < ch.length; k++) {
        const x = ch[k][i]
        const low = this.lp[k].step(x)
        ch[k][i] = low + (x - low) * g
      }
      if (-this.grDb > maxRed) maxRed = -this.grDb
    }
    this.reductionDb = maxRed
  }
}

export interface LimiterParams { ceilingDb: number; lookaheadMs: number; releaseMs: number }

/**
 * 앞보기 리미터. 출력은 lookahead 만큼 늦다(latency) — 파일 저장은 그만큼 앞을 잘라 맞춘다.
 * 샘플 최대치 기준이다. 샘플 사이 최대치는 저장 경로에서 마지막에 재서 넘으면 고르게 낮춘다(python/audio_limiter.py 와 같은 보증).
 */
export class Limiter {
  readonly latency: number
  private delay: Float32Array[]
  private need: Float32Array      // 지난 L+1 개의 필요한 이득(원형 버퍼)
  private avg: Float32Array       // 이동평균용 최소값 기록
  private pos = 0
  private sum: number
  private rel = 1
  reductionDb = 0
  private sr: number
  p: LimiterParams
  constructor (sr: number, p: LimiterParams, channels: number) {
    this.sr = sr; this.p = p
    this.latency = Math.max(1, Math.round(sr * p.lookaheadMs / 1000))
    const L = this.latency + 1
    this.delay = Array.from({ length: channels }, () => new Float32Array(L))
    this.need = new Float32Array(L).fill(1)
    this.avg = new Float32Array(L).fill(1)
    this.sum = L
  }
  process (ch: Float32Array[]): void {
    const n = ch[0]?.length ?? 0
    const L = this.latency + 1
    const ceil = dbToLin(this.p.ceilingDb)
    const relK = coefMs(this.p.releaseMs, this.sr)
    let maxRed = 0
    for (let i = 0; i < n; i++) {
      let peak = 0
      for (const c of ch) peak = Math.max(peak, Math.abs(c[i]))
      this.need[this.pos] = peak > ceil ? ceil / peak : 1
      let m = 1                                         // 앞보기 창(지금부터 L 샘플)의 최소 이득
      for (let k = 0; k < L; k++) if (this.need[k] < m) m = this.need[k]
      this.sum += m - this.avg[this.pos]; this.avg[this.pos] = m
      if (this.pos === 0) { let t = 0; for (let k = 0; k < L; k++) t += this.avg[k]; this.sum = t }   // 더하기 오차가 쌓이지 않게
      const smooth = this.sum / L
      this.rel = smooth < this.rel ? smooth : smooth + (this.rel - smooth) * relK
      const g = Math.min(this.rel, smooth)
      const out = (this.pos + 1) % L                     // 가장 오래된 = L 샘플 전 입력
      for (let k = 0; k < ch.length; k++) {
        const d = this.delay[k]
        d[this.pos] = ch[k][i]
        ch[k][i] = d[out] * g
      }
      this.pos = out
      const red = -linToDb(g)
      if (red > maxRed) maxRed = red
    }
    this.reductionDb = maxRed
  }
}

export const VOICE_FX_DB = { dbToLin, linToDb }
