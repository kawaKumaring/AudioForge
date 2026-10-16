/**
 * 카드 생성본에 음성 처리 걸기(2026-10-16, 계획 P3).
 *
 * - 음성 편집 패널과 **같은 엔진**(renderVoiceFx · createVoiceFxChain)을 쓴다 → 고급 옵션에서 들은 소리 = 저장된 소리.
 * - 처리 전 원본은 지우지 않고 생성본의 `rawPath` 로 남긴다. 다시 걸 때는 늘 원본에서 시작한다(처리 위에 처리가 겹치지 않게).
 * - 엔진(파이썬)은 건드리지 않는다. 생성이 끝난 파일을 화면에서 처리해 원본 옆에 새 파일로 둔다.
 *
 * ★이 파일은 Web Audio 를 쓰므로 node --test 가 읽는 cardSynthesis.ts 에서 부르지 않는다 — 화면이 결과를 받은 뒤 부른다.
 */
import { renderVoiceFx, createVoiceFxChain } from './voiceFx/render'
import { VOICE_FX_SAMPLE_RATE, type VoiceFxChain } from './voiceFx/chain'
import { encodeWav16 } from '../../shared/voiceFx/wav'
import { loadBuffer } from './voiceEdit/engine'
import { useSynthesisCards } from '../stores/synthesisCards.store'

/** 같은 생성본을 두 번 동시에 처리하지 않는다 — 나중 요청만 남긴다. */
const running = new Map<string, number>()

/**
 * 카드의 지금 음성 처리 설정을 그 생성본에 건다. 설정이 없으면(꺼짐) 처리 전 원본으로 되돌린다.
 * 돌려주는 값: 빈 문자열이면 성공, 아니면 사람이 읽을 사유.
 */
export async function applyCardFx (cardId: string, takeId: string): Promise<string> {
  const ticket = (running.get(takeId) || 0) + 1
  running.set(takeId, ticket)
  try {
    const st = useSynthesisCards.getState()
    const card = st.cards.find((c) => c.id === cardId)
    const take = card?.takes.find((t) => t.id === takeId)
    if (!card || !take) return '카드나 생성본이 사라졌습니다'
    const raw = take.rawPath || take.path
    const fx = card.settings.voiceFx
    if (!fx) {
      if (take.rawPath) {
        const { voiceFx: _drop, ...settings } = take.settings
        st.setTake(cardId, takeId, { path: raw, rawPath: undefined, settings })
      }
      return ''
    }
    const { buffer } = await renderVoiceFx(await loadBuffer(raw), fx)
    const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
    const wav = encodeWav16(chans, buffer.sampleRate)
    if (running.get(takeId) !== ticket) return ''                       // 그 사이 다시 요청됐다 — 나중 것이 저장한다
    const r = await window.api.voiceEdit.saveBeside({ raw, wav, previous: take.rawPath ? take.path : '' })
    if (!r.ok) return r.why
    // 처리하는 사이 생성본이 지워졌으면 붙일 자리가 없다(파일은 남지만 원본 옆이라 찾을 수 있다).
    const now = useSynthesisCards.getState().cards.find((c) => c.id === cardId)?.takes.find((t) => t.id === takeId)
    if (!now) return '생성본이 사라졌습니다'
    useSynthesisCards.getState().setTake(cardId, takeId, { path: r.path, rawPath: raw, settings: { ...now.settings, voiceFx: fx } })
    return ''
  } catch (e) {
    return '음성 처리에 실패했습니다: ' + ((e as Error)?.message || String(e))
  } finally {
    if (running.get(takeId) === ticket) running.delete(takeId)
  }
}

/**
 * 고급 옵션의 **실시간 듣기** — 생성본 원본을 처리 연결에 통과시켜 반복 재생한다.
 * 값을 바꾸면 끊지 않고 바로 들린다. `bypass` 로 처리 전 소리와 번갈아 비교한다.
 */
export class CardFxPreviewer {
  private ctx: AudioContext | null = null
  private chain: VoiceFxChain | null = null
  private src: AudioBufferSourceNode | null = null
  private dry: GainNode | null = null
  private gen = 0
  playing = false
  onMeter: ((which: 'compressor' | 'deesser' | 'limiter', db: number) => void) | null = null
  onEnd: (() => void) | null = null

  async play (path: string, fx: unknown, bypass: boolean): Promise<void> {
    this.stop()
    const g = ++this.gen
    this.ctx ??= new AudioContext({ sampleRate: VOICE_FX_SAMPLE_RATE, latencyHint: 'interactive' })
    const ctx = this.ctx
    await ctx.resume()
    const buf = await loadBuffer(path)
    const chain = await createVoiceFxChain(ctx, fx)
    if (g !== this.gen) { chain.dispose(); return }
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true
    const dry = ctx.createGain()
    src.connect(chain.input); src.connect(dry)
    chain.output.connect(ctx.destination); dry.connect(ctx.destination)
    chain.output.gain.value = bypass ? 0 : 1; dry.gain.value = bypass ? 1 : 0
    chain.onMeter((w, db) => this.onMeter?.(w, db))
    src.start()
    this.chain = chain; this.src = src; this.dry = dry; this.playing = true
  }

  setFx (fx: unknown): void { this.chain?.set(fx) }

  setBypass (bypass: boolean): void {
    if (!this.chain || !this.dry || !this.ctx) return
    const t = this.ctx.currentTime
    this.chain.output.gain.setTargetAtTime(bypass ? 0 : 1, t, 0.01)
    this.dry.gain.setTargetAtTime(bypass ? 1 : 0, t, 0.01)
  }

  stop (): void {
    this.gen++
    try { this.src?.stop() } catch { /* 이미 멈춤 */ }
    this.src?.disconnect(); this.dry?.disconnect(); this.chain?.dispose()
    this.src = null; this.dry = null; this.chain = null
    if (this.playing) { this.playing = false; this.onEnd?.() }
  }

  async dispose (): Promise<void> { this.stop(); await this.ctx?.close().catch(() => {}); this.ctx = null }
}
