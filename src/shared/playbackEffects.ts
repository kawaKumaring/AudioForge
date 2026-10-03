export const PLAYBACK_EFFECTS_KEY = 'playbackEffects'
export interface PlaybackEffects { enabled: boolean; bass: number; clarity: number; treble: number; compress: boolean; softenPeaks: boolean }
export const DEFAULT_EFFECTS: PlaybackEffects = { enabled: false, bass: 0, clarity: 0, treble: 0, compress: false, softenPeaks: false }
export function normalizeEffects(raw: unknown): PlaybackEffects {
 const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
 const db = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? Math.max(-6, Math.min(6, v)) : 0
 return { enabled: r.enabled === true, bass: db(r.bass), clarity: db(r.clarity), treble: db(r.treble), compress: r.compress === true, softenPeaks: r.softenPeaks === true }
}
