// @ts-ignore TS5097
import { createEffectsGraph, getPlaybackEffects, onPlaybackEffects } from './playbackEffects.ts'
// @ts-ignore TS5097
import { PLAYBACK_BOOST_STORAGE_KEY, normalizePlaybackBoost } from '../../shared/playbackBoost.ts'
let value = 1
let context: AudioContext | undefined
const targets = new Set<WeakRef<HTMLMediaElement>>()
const graphs = new WeakMap<object, GainNode>()
const effectsGraphs = new WeakMap<object, ReturnType<typeof createEffectsGraph>>()
const listeners = new Set<() => void>()
let failure = ''
export const getPlaybackBoost = () => value
export const getBoostFailure = () => failure
export const onPlaybackBoostChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const notify = () => { for (const fn of listeners) fn() }
function apply(media: HTMLMediaElement) {
  let gain = graphs.get(media)
  if (!gain && value === 1 && !getPlaybackEffects().enabled) return
  try {
    if (!gain) {
      const player = media as HTMLMediaElement & { getGainNode?: () => GainNode }
      const upstream = player.getGainNode?.()
      const ctx = upstream ? upstream.context as AudioContext : (context ??= new AudioContext())
      gain = ctx.createGain()
      if (upstream) { upstream.disconnect(); upstream.connect(gain) }
      else { const source = ctx.createMediaElementSource(media); source.connect(gain) }
      effectsGraphs.set(media, createEffectsGraph(ctx, gain, ctx.destination))
      graphs.set(media, gain)
    }
    effectsGraphs.get(media)?.update(getPlaybackEffects())
    gain.gain.setTargetAtTime(value, gain.context.currentTime, 0.015)
    if (!media.paused) void (gain.context as AudioContext).resume().catch(() => { failure = '음향 조절을 시작하지 못했습니다'; notify() })
  } catch { failure = '이 재생기의 음향 조절을 시작하지 못했습니다'; notify() }
}
/** HTMLAudio와 WaveSurfer의 공개 WebAudio 출력 모두 같은 배율을 쓴다. */
export function attachPlaybackBoost(media: HTMLMediaElement) {
  for (const ref of targets) if (ref.deref() === media) return
  targets.add(new WeakRef(media))
  media.addEventListener?.('play', () => apply(media))
  apply(media)
}
export function setPlaybackBoost(next: unknown) {
  value = normalizePlaybackBoost(next); failure = ''
  for (const ref of targets) { const media = ref.deref(); if (media) apply(media); else targets.delete(ref) }
  notify()
}
export async function loadPlaybackBoost() {
  try { const settings = await window.api.settings.get(); setPlaybackBoost(settings?.[PLAYBACK_BOOST_STORAGE_KEY]) } catch { /* 보관값 읽기 실패는 현 상태 유지 */ }
}
export async function savePlaybackBoost(): Promise<boolean> {
  try { const result = await window.api.settings.set(PLAYBACK_BOOST_STORAGE_KEY, value); return result?.ok !== false } catch { return false }
}

// 패널·저장 알림도 오지만 실제 노드 값이 바뀐 때만 연결을 갱신한다.
let previousEffects = getPlaybackEffects()
onPlaybackEffects(() => {
 const next = getPlaybackEffects(); if (next === previousEffects) return
 previousEffects = next
 for (const ref of targets) { const media = ref.deref(); if (media) apply(media); else targets.delete(ref) }
})
