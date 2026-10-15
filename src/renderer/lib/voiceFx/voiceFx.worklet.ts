/**
 * 음성 처리 실시간 모듈(AudioWorklet). 계산은 전부 src/shared/voiceFx 의 클래스가 한다 — 여기는 감싸기만.
 * 같은 모듈이 실시간 듣기(AudioContext)와 파일 저장(OfflineAudioContext) 양쪽에 올라간다 → 들은 소리 = 저장된 소리.
 *
 * 설정 변경은 port 메시지로 받는다(다음 블록부터 적용 — 이득은 각 클래스 안에서 부드럽게 따라간다).
 * 미터용 감소량은 약 20번/초로 port 로 돌려보낸다.
 */
import { Compressor, DeEsser, Limiter, type CompressorParams, type DeEsserParams, type LimiterParams } from '../../../shared/voiceFx/dynamics.ts'
// @ts-ignore 형식 선언 없음 — wasm 을 글자로 품은 동기판(따로 불러오지 않는다)
import createRNNWasmModuleSync from '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js'

declare const sampleRate: number
declare function registerProcessor (name: string, ctor: unknown): void
declare class AudioWorkletProcessor { readonly port: MessagePort; constructor (options?: unknown) }

const METER_EVERY = Math.round(sampleRate / 20)

/** 입력을 출력으로 복사하고(채널 수 맞춤) 처리 함수를 부른다. */
function passThrough (inputs: Float32Array[][], outputs: Float32Array[][]): Float32Array[] {
  const inp = inputs[0] ?? [], out = outputs[0] ?? []
  for (let c = 0; c < out.length; c++) {
    const src = inp[c] ?? inp[0]
    if (src) out[c].set(src); else out[c].fill(0)
  }
  return out
}

abstract class Base<P> extends AudioWorkletProcessor {
  protected p: P
  protected sinceMeter = 0
  constructor (options: { processorOptions?: { params: P } }) {
    super()
    this.p = options.processorOptions!.params
    this.port.onmessage = (e: MessageEvent) => { this.p = e.data as P; this.update() }
  }
  protected update (): void {}
  protected meter (reductionDb: number, frames: number): void {
    this.sinceMeter += frames
    if (this.sinceMeter >= METER_EVERY) { this.sinceMeter = 0; this.port.postMessage({ reductionDb }) }
  }
}

class CompressorProcessor extends Base<CompressorParams> {
  private c: Compressor | null = null
  process (inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = passThrough(inputs, outputs)
    if (!out.length) return true
    if (!this.c) this.c = new Compressor(sampleRate, this.p)
    this.c.p = this.p
    this.c.process(out)
    this.meter(this.c.reductionDb, out[0].length)
    return true
  }
}

class DeEsserProcessor extends Base<DeEsserParams> {
  private d: DeEsser | null = null
  private ch = 0
  protected update (): void { this.d = null }       // 주파수가 바뀌면 필터를 새로 만든다
  process (inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = passThrough(inputs, outputs)
    if (!out.length) return true
    if (!this.d || this.ch !== out.length) { this.d = new DeEsser(sampleRate, this.p, out.length); this.ch = out.length }
    this.d.process(out)
    this.meter(this.d.reductionDb, out[0].length)
    return true
  }
}

class LimiterProcessor extends Base<LimiterParams> {
  private l: Limiter | null = null
  process (inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = passThrough(inputs, outputs)
    if (!out.length) return true
    if (!this.l) this.l = new Limiter(sampleRate, this.p, out.length)
    this.l.p = this.p
    this.l.process(out)
    this.meter(this.l.reductionDb, out[0].length)
    return true
  }
}

/**
 * 노이즈 제거 — RNNoise(Apache-2.0, jitsi wasm). 48kHz·480 샘플 단위라 128 블록을 모아 처리한다(지연 480 샘플).
 * 채널마다 상태 하나. RNNoise 는 16비트 크기(±32768)를 기대한다.
 */
const FRAME = 480
class DenoiseProcessor extends Base<{ on: boolean }> {
  private M: any = createRNNWasmModuleSync()
  private states: number[] = []
  private ptr = 0
  private inBuf: Float32Array[] = []
  private outBuf: Float32Array[] = []
  private fill = 0
  process (inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = passThrough(inputs, outputs)
    if (!out.length) return true
    if (sampleRate !== 48000) return true                 // 48kHz 가 아니면 손대지 않는다(엔진은 48kHz 로 연다)
    if (!this.ptr) this.ptr = this.M._malloc(FRAME * 4)
    while (this.states.length < out.length) {
      this.states.push(this.M._rnnoise_create(0))
      this.inBuf.push(new Float32Array(FRAME)); this.outBuf.push(new Float32Array(FRAME))
    }
    const n = out[0].length
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < out.length; c++) {
        this.inBuf[c][this.fill] = out[c][i] * 32768
        out[c][i] = this.outBuf[c][this.fill] / 32768
      }
      if (++this.fill === FRAME) {
        this.fill = 0
        for (let c = 0; c < out.length; c++) {
          this.M.HEAPF32.set(this.inBuf[c], this.ptr >> 2)
          this.M._rnnoise_process_frame(this.states[c], this.ptr, this.ptr)
          this.outBuf[c].set(this.M.HEAPF32.subarray(this.ptr >> 2, (this.ptr >> 2) + FRAME))
        }
      }
    }
    return true
  }
}

registerProcessor('af-compressor', CompressorProcessor)
registerProcessor('af-deesser', DeEsserProcessor)
registerProcessor('af-limiter', LimiterProcessor)
registerProcessor('af-denoise', DenoiseProcessor)
