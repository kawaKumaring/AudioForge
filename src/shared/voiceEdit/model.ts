/**
 * 음성 편집 — 편집 모델(순수). 화면·재생·저장이 모두 이 규칙을 따른다.
 *
 * 흡수 출처(2026-10-16, MIT/Apache): SoundCraft `crates/engine/src/edit.rs`(겹침·크로스페이드·트림 규칙),
 * `crates/model/src/clip.rs`(클립 = 시작·원본 안 위치·길이·이득·페이드).
 *
 * ★트랙(화자)끼리는 자유롭게 겹친다 — 끼어들기·동시 발화.
 * ★같은 트랙에서는 **겹친 구간 = 크로스페이드**(앞 클립 페이드 아웃 + 뒤 클립 페이드 인이 같은 구간, EqualPower).
 *   겹침은 최대 MAX_XFADE_SEC, 어느 쪽도 통째로 덮지 않고(MIN_CLIP_SEC 는 남긴다), 한 클립의 앞뒤 겹침 합이 그 클립 길이를
 *   넘지 않는다 — 넘으면 그 자리에서 멈춘다.
 *   (2026-10-16 MCP 실조작: 처음엔 '짧은 쪽 절반' 규칙을 덧붙였는데, 1초 겹친 2초 클립의 **반대쪽 끝**도 자를 수 없게 막았다 → 뺐다.)
 *   (SoundCraft 는 같은 트랙 겹침을 크로스페이드 구간에만 허용한다.)
 * ★페이드: 사용자가 정한 값과 크로스페이드 중 긴 쪽이 쓰인다(재생·저장에서 계산 — 따로 저장하지 않는다).
 */
import type { FadeShape } from '../voiceFx/fades.ts'
import { sanitizeVoiceFx, VOICE_FX_DEFAULTS, type VoiceFxSettings } from '../voiceFx/settings.ts'

export const MAX_XFADE_SEC = 2
export const MIN_CLIP_SEC = 0.05
export const SNAP_PX = 8

export interface VeClip {
  id: string
  trackId: string
  path: string
  name: string
  /** 시간축 위 시작(초). */
  start: number
  /** 원본 파일 안에서 시작(초). */
  offset: number
  /** 시간축 위 길이(초). */
  duration: number
  /** 원본 파일 전체 길이(초) — 트림 한계. */
  sourceDuration: number
  gainDb: number
  fadeIn: number
  fadeOut: number
  shape: FadeShape
}

export interface VeTrack { id: string; name: string; gainDb: number; mute: boolean; solo: boolean; fx: VoiceFxSettings }

export interface VeProject { version: 1; tracks: VeTrack[]; clips: VeClip[] }

export const emptyProject = (): VeProject => ({ version: 1, tracks: [], clips: [] })

let seq = 0
export const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const end = (c: VeClip): number => c.start + c.duration
const round = (v: number): number => Math.round(v * 1e6) / 1e6

export function addTrack (p: VeProject, name: string, fx: unknown = VOICE_FX_DEFAULTS): VeProject {
  const t: VeTrack = { id: newId('t'), name: name.trim() || `화자 ${p.tracks.length + 1}`, gainDb: 0, mute: false, solo: false, fx: sanitizeVoiceFx(fx) }
  return { ...p, tracks: [...p.tracks, t] }
}

/** 클립을 트랙 끝(또는 at)에 놓는다. 같은 트랙과 겹치면 겹침 한계까지 뒤로 민다. */
export function addClip (p: VeProject, trackId: string, file: { path: string; name: string; duration: number }, at?: number): VeProject {
  if (!p.tracks.some((t) => t.id === trackId)) throw Error('트랙이 없습니다')
  if (!(file.duration > MIN_CLIP_SEC)) throw Error('소리가 너무 짧습니다')
  const last = Math.max(0, ...p.clips.filter((c) => c.trackId === trackId).map(end))
  const c: VeClip = {
    id: newId('c'), trackId, path: file.path, name: file.name, start: round(at ?? last), offset: 0,
    duration: round(file.duration), sourceDuration: round(file.duration), gainDb: 0, fadeIn: 0, fadeOut: 0, shape: 'equalPower',
  }
  const next = { ...p, clips: [...p.clips, c] }
  return moveClip(next, c.id, c.start, trackId)
}

const others = (p: VeProject, c: VeClip, trackId = c.trackId): VeClip[] => p.clips.filter((x) => x.id !== c.id && x.trackId === trackId)

const overlap = (a: VeClip, b: VeClip): number => Math.max(0, Math.min(end(a), end(b)) - Math.max(a.start, b.start))
/** 두 클립 사이 겹침 한계. */
const xfadeLimit = (a: VeClip, b: VeClip): number => Math.max(0, Math.min(MAX_XFADE_SEC, a.duration - MIN_CLIP_SEC, b.duration - MIN_CLIP_SEC))

/** c 를 이 자리에 두어도 되는가(같은 트랙 이웃 neigh 기준). */
function placementOk (c: VeClip, neigh: VeClip[]): boolean {
  let sum = 0
  for (const n of neigh) {
    const ov = overlap(c, n)
    if (ov <= 1e-9) continue
    if (ov > xfadeLimit(c, n) + 1e-9) return false
    sum += ov
  }
  return sum <= c.duration - MIN_CLIP_SEC + 1e-9
}

/**
 * 클립을 start(초)·trackId 로 옮긴다. 같은 트랙 겹침이 한계를 넘으면 **원하는 자리에서 가장 가까운 허용 자리**로 멈춘다.
 */
export function moveClip (p: VeProject, id: string, start: number, trackId?: string): VeProject {
  const c = p.clips.find((x) => x.id === id)
  if (!c) return p
  const tid = trackId && p.tracks.some((t) => t.id === trackId) ? trackId : c.trackId
  const want = Math.max(0, start)
  const neigh = others(p, c, tid)
  const fits = (s: number): boolean => placementOk({ ...c, start: s }, neigh)
  let best = fits(want) ? want : NaN
  if (Number.isNaN(best)) {
    // 후보: 각 이웃의 앞뒤로 허용 최대 겹침만큼 붙는 자리
    const cands: number[] = [0]
    for (const n of neigh) {
      const lim = xfadeLimit(c, n)
      cands.push(end(n) - lim, n.start - c.duration + lim, end(n), n.start - c.duration)
    }
    best = cands.filter((s) => s >= 0 && fits(s)).sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0] ?? c.start
  }
  return { ...p, clips: p.clips.map((x) => (x.id === id ? { ...x, start: round(best), trackId: tid } : x)) }
}

/** 한쪽 끝을 끌어 자른다(edge 의 새 시간축 위치). 원본 길이·최소 길이·같은 트랙 겹침 한계 안에서 멈춘다. */
export function trimClip (p: VeProject, id: string, edge: 'start' | 'end', t: number): VeProject {
  const c = p.clips.find((x) => x.id === id)
  if (!c) return p
  let next: VeClip
  if (edge === 'start') {
    const lo = c.start - c.offset, hi = end(c) - MIN_CLIP_SEC
    const s = clamp(t, Math.max(0, lo), hi)
    next = { ...c, start: s, offset: c.offset + (s - c.start), duration: end(c) - s }
  } else {
    const hi = c.start + (c.sourceDuration - c.offset), lo = c.start + MIN_CLIP_SEC
    next = { ...c, duration: clamp(t, lo, hi) - c.start }
  }
  const neigh = others(p, c)
  if (!placementOk(next, neigh)) {
    // 한계를 넘으면 원하는 자리와 원래 자리 사이에서 **허용되는 가장 먼 곳**에서 멈춘다(이분 탐색).
    const at = (k: number): VeClip => (edge === 'start'
      ? { ...c, start: c.start + (next.start - c.start) * k, offset: c.offset + (next.start - c.start) * k, duration: c.duration - (next.start - c.start) * k }
      : { ...c, duration: c.duration + (next.duration - c.duration) * k })
    let lo = 0, hi = 1
    for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (placementOk(at(mid), neigh)) lo = mid; else hi = mid }
    next = at(lo)
  }
  next = { ...next, start: round(next.start), offset: round(next.offset), duration: round(next.duration) }
  next.fadeIn = Math.min(next.fadeIn, next.duration); next.fadeOut = Math.min(next.fadeOut, next.duration)
  return { ...p, clips: p.clips.map((x) => (x.id === id ? next : x)) }
}

export function setFade (p: VeProject, id: string, which: 'in' | 'out', sec: number): VeProject {
  return { ...p, clips: p.clips.map((c) => (c.id !== id ? c : { ...c, [which === 'in' ? 'fadeIn' : 'fadeOut']: round(clamp(sec, 0, c.duration)) })) }
}

export function setClip (p: VeProject, id: string, patch: Partial<Pick<VeClip, 'gainDb' | 'shape' | 'name'>>): VeProject {
  const g = patch.gainDb === undefined ? undefined : clamp(patch.gainDb, -48, 12)
  return { ...p, clips: p.clips.map((c) => (c.id !== id ? c : { ...c, ...patch, ...(g === undefined ? {} : { gainDb: g }) })) }
}

export function setTrack (p: VeProject, id: string, patch: Partial<Omit<VeTrack, 'id'>>): VeProject {
  return {
    ...p,
    tracks: p.tracks.map((t) => (t.id !== id ? t : {
      ...t, ...patch,
      ...(patch.gainDb === undefined ? {} : { gainDb: clamp(patch.gainDb, -48, 12) }),
      ...(patch.fx === undefined ? {} : { fx: sanitizeVoiceFx(patch.fx) }),
    })),
  }
}

export const removeClip = (p: VeProject, id: string): VeProject => ({ ...p, clips: p.clips.filter((c) => c.id !== id) })
export const removeTrack = (p: VeProject, id: string): VeProject => ({ ...p, tracks: p.tracks.filter((t) => t.id !== id), clips: p.clips.filter((c) => c.trackId !== id) })

export const projectDuration = (p: VeProject): number => Math.max(0, ...p.clips.map(end))

/** 가까운 붙는 자리(다른 클립 끝·재생 위치·0). 없으면 t 그대로. thresholdSec 는 화면 8px 에 해당하는 초. */
export function snapTime (t: number, targets: number[], thresholdSec: number): number {
  let best = t, dist = thresholdSec
  for (const x of targets) { const d = Math.abs(x - t); if (d <= dist) { dist = d; best = x } }
  return best
}

export function snapTargets (p: VeProject, exceptId: string, playhead: number): number[] {
  const out = [0, playhead]
  for (const c of p.clips) if (c.id !== exceptId) out.push(c.start, end(c))
  return out
}

/** 재생·저장 계획 — 들리는 클립(음소거·솔로 반영)과 실제 페이드(사용자 값과 크로스페이드 중 긴 쪽). */
export interface VeScheduled {
  clipId: string; trackId: string; path: string; when: number; offset: number; duration: number
  gain: number; fadeIn: number; fadeOut: number; fadeInShape: FadeShape; fadeOutShape: FadeShape
}

export function mixSchedule (p: VeProject): VeScheduled[] {
  const solo = p.tracks.some((t) => t.solo)
  const audible = new Set(p.tracks.filter((t) => !t.mute && (!solo || t.solo)).map((t) => t.id))
  const out: VeScheduled[] = []
  for (const c of p.clips) {
    if (!audible.has(c.trackId)) continue
    let xin = 0, xout = 0
    for (const n of others(p, c)) {
      const ov = Math.min(end(c), end(n)) - Math.max(c.start, n.start)
      if (ov <= 1e-9) continue
      if (n.start < c.start) xin = Math.max(xin, ov); else xout = Math.max(xout, ov)
    }
    out.push({
      clipId: c.id, trackId: c.trackId, path: c.path, when: c.start, offset: c.offset, duration: c.duration,
      gain: Math.pow(10, c.gainDb / 20),
      fadeIn: Math.max(c.fadeIn, xin), fadeOut: Math.max(c.fadeOut, xout),
      fadeInShape: xin > c.fadeIn ? 'equalPower' : c.shape, fadeOutShape: xout > c.fadeOut ? 'equalPower' : c.shape,
    })
  }
  return out
}

/** 저장된 작업을 읽을 때 — 깨진 항목은 버리고 값은 범위 안으로. */
export function sanitizeProject (raw: unknown): VeProject {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<VeProject>
  const tracks = (Array.isArray(r.tracks) ? r.tracks : []).filter((t) => t && typeof t.id === 'string')
    .map((t) => ({ id: t.id, name: String(t.name ?? ''), gainDb: clamp(Number(t.gainDb) || 0, -48, 12), mute: !!t.mute, solo: !!t.solo, fx: sanitizeVoiceFx(t.fx) }))
  const ids = new Set(tracks.map((t) => t.id))
  const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const clips = (Array.isArray(r.clips) ? r.clips : []).filter((c) => c && typeof c.id === 'string' && ids.has(c.trackId) && typeof c.path === 'string')
    .map((c) => {
      const src = Math.max(MIN_CLIP_SEC, num(c.sourceDuration, num(c.duration)))
      const offset = clamp(num(c.offset), 0, src - MIN_CLIP_SEC)
      const duration = clamp(num(c.duration, src), MIN_CLIP_SEC, src - offset)
      return {
        id: c.id, trackId: c.trackId, path: c.path, name: String(c.name ?? ''), start: Math.max(0, num(c.start)), offset, duration, sourceDuration: src,
        gainDb: clamp(num(c.gainDb), -48, 12), fadeIn: clamp(num(c.fadeIn), 0, duration), fadeOut: clamp(num(c.fadeOut), 0, duration),
        shape: (c.shape === 'linear' ? 'linear' : 'equalPower') as FadeShape,
      }
    })
  return { version: 1, tracks, clips }
}
