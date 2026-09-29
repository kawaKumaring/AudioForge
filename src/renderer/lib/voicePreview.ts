/**
 * 기본 목소리 **미리듣기** — 고르기 전에도, 고른 뒤에도 들어 본다.
 *
 * ★카드를 건드리지 않는다. 대사·생성본·채택을 이 파일은 알지도 못한다.
 *   여기서 만든 소리는 생성본 목록에 들어가지 않는다.
 *
 * ★한 번에 하나만 울린다. 다른 목소리를 누르면 앞 재생을 멈춘다 —
 *   두 목소리가 겹쳐 들리면 어느 쪽을 고르는지 알 수 없다.
 *
 * ★앱의 재생 음량을 따른다(`createManagedAudio`). 이 화면만 다른 음량으로 울리지 않는다.
 *
 * ★합성이 도는 동안에는 새로 만들지 않는다(파이썬 통로가 하나다).
 *   이미 만들어 둔 것이 있으면 그것은 그냥 들린다 — 부딪히지 않는다.
 */
import { createManagedAudio } from './playbackVolume'

export type PreviewPhase = 'idle' | 'preparing' | 'playing' | 'failed'
export interface PreviewState {
  /** 지금 다루는 목소리의 모델 자리. 비면 아무것도 안 하고 있다. */
  modelPath: string
  phase: PreviewPhase
  /** 실패 사유. 화면은 짧게 보이고 자세한 것은 툴팁에 둔다. */
  message: string
}

let state: PreviewState = { modelPath: '', phase: 'idle', message: '' }
const listeners = new Set<(s: PreviewState) => void>()
let el: HTMLAudioElement | null = null
/** 늦게 온 결과를 버린다 — 누를 때마다 올라간다. */
let gen = 0

function publish(next: PreviewState): void {
  state = next
  for (const cb of listeners) cb(next)
}

export function previewState(): PreviewState { return state }
export function onPreviewState(cb: (s: PreviewState) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** 울리고 있는 것을 멈춘다. 만들던 것이 있으면 그 결과는 버린다. */
export function stopPreview(): void {
  gen += 1
  if (el) { try { el.pause() } catch { /* 이미 멈췄다 */ } }
  publish({ modelPath: '', phase: 'idle', message: '' })
}

/**
 * 그 목소리를 들어 본다. 같은 것을 다시 누르면 멈춘다(토글).
 *
 * 돌려주는 값은 없다 — 상태는 `onPreviewState` 로 본다.
 */
export async function playPreview(modelPath: string, engineId?: string): Promise<void> {
  if (!modelPath) return
  // 같은 것을 다시 누르면 멈춘다.
  if (state.modelPath === modelPath && (state.phase === 'playing' || state.phase === 'preparing')) {
    stopPreview()
    return
  }
  gen += 1
  const mine = gen
  if (el) { try { el.pause() } catch { /* 이미 멈췄다 */ } }
  publish({ modelPath, phase: 'preparing', message: '' })

  try {
    const r = await window.api.cards.previewBuiltin(modelPath, engineId) as
      { ok: boolean; data?: string; error?: string }
    if (mine !== gen) return                       // 그 사이 다른 것을 눌렀다
    if (!r?.ok || !r.data) throw new Error(r?.error || '미리듣기를 만들지 못했습니다')

    const url = await window.api.audio.getFileUrl(r.data)
    if (mine !== gen) return
    const audio = el || createManagedAudio(undefined, { made: true })
    el = audio
    audio.src = url
    audio.onended = () => { if (mine === gen) publish({ modelPath: '', phase: 'idle', message: '' }) }
    audio.onerror = () => { if (mine === gen) publish({ modelPath, phase: 'failed', message: '소리를 재생하지 못했습니다' }) }
    await audio.play()
    if (mine === gen) publish({ modelPath, phase: 'playing', message: '' })
  } catch (e) {
    if (mine !== gen) return
    publish({ modelPath, phase: 'failed', message: (e as Error)?.message || '미리듣기에 실패했습니다' })
  }
}

/** 화면을 떠날 때 — 소리를 끄고 요소를 놓는다. */
export function disposePreview(): void {
  stopPreview()
  if (el) {
    try { el.removeAttribute('src'); el.load() } catch { /* 이미 정리됐다 */ }
    el = null
  }
}
