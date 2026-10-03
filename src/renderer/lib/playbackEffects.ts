// @ts-ignore TS5097
import { DEFAULT_EFFECTS, PLAYBACK_EFFECTS_KEY, normalizeEffects, type PlaybackEffects } from '../../shared/playbackEffects.ts'
let state = { ...DEFAULT_EFFECTS }
let opened = false, saveFailed = false, revision = 0
const listeners = new Set<() => void>()
const notify = () => { for (const fn of listeners) fn() }
export const getPlaybackEffects = () => state
export const effectsPanelOpen = () => opened
export const effectsSaveFailed = () => saveFailed
export const onPlaybackEffects = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export function openEffectsPanel(open = true) { opened = open; notify() }
export function setPlaybackEffects(next: Partial<PlaybackEffects>) { state = normalizeEffects({ ...state, ...next }); revision++; notify() }
let writes: Promise<void> = Promise.resolve()
export function savePlaybackEffects() {
 const snapshot = { ...state }, mine = revision
 writes = writes.catch(() => {}).then(async () => {
  try { const r = await window.api.settings.set(PLAYBACK_EFFECTS_KEY, snapshot); if (mine === revision) saveFailed = r?.ok === false }
  catch { if (mine === revision) saveFailed = true }
  notify()
 })
 return writes
}
export async function loadPlaybackEffects() {
 const mine = revision
 try { const r = await window.api.settings.get(); if (mine === revision) { state = normalizeEffects(r?.[PLAYBACK_EFFECTS_KEY]); notify() } } catch { /* 현재 설정 유지 */ }
}
/** 공용 출력 연결. 꺼진 효과는 노드를 우회하므로 압축기의 지연도 남지 않는다. */
export function createEffectsGraph(ctx: BaseAudioContext, input: GainNode, destination: AudioNode) {
 const bass = ctx.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 180
 const clarity = ctx.createBiquadFilter(); clarity.type = 'peaking'; clarity.frequency.value = 2400; clarity.Q.value = .7
 const treble = ctx.createBiquadFilter(); treble.type = 'highshelf'; treble.frequency.value = 6500
 const compressor = ctx.createDynamicsCompressor(); compressor.threshold.value = -22; compressor.knee.value = 18; compressor.ratio.value = 3; compressor.attack.value = .012; compressor.release.value = .22
 const peaks = ctx.createDynamicsCompressor(); peaks.threshold.value = -3; peaks.knee.value = 0; peaks.ratio.value = 20; peaks.attack.value = .001; peaks.release.value = .08
 let route = ''
 const nodes: AudioNode[] = [input, bass, clarity, treble, compressor, peaks]
 const update = (s: PlaybackEffects) => {
  bass.gain.setTargetAtTime(s.bass, ctx.currentTime, .025); clarity.gain.setTargetAtTime(s.clarity, ctx.currentTime, .025); treble.gain.setTargetAtTime(s.treble, ctx.currentTime, .025)
  const key = [s.enabled, s.compress, s.softenPeaks].join(':')
  if (key === route) return
  route = key; for (const node of nodes) node.disconnect()
  const chain: AudioNode[] = s.enabled ? [input, bass, clarity, treble, ...(s.compress ? [compressor] : []), ...(s.softenPeaks ? [peaks] : [])] : [input]
  for (let i = 1; i < chain.length; i++) chain[i - 1].connect(chain[i])
  chain.at(-1)!.connect(destination)
 }
 update(state)
 return { update }
}
