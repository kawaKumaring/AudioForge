/**
 * 음성 편집 — 화자별 트랙에 목소리 클립을 놓고 겹쳐(끼어들기·동시 발화) 섞는다. 계획: doc/voice-processing-plan-2026-10-16.md
 *
 * 조작(참고 도구의 실제 수치 — src/shared/voiceEdit/hit.ts):
 *  - 클립 몸통 끌기 = 옮기기(위아래로 끌면 다른 화자 트랙). 같은 트랙에서 겹치면 그 구간이 크로스페이드.
 *  - 양 끝 = 자르기, 위쪽 모서리 = 페이드 만들기, 페이드 손잡이 = 길이 조절.
 *  - 스냅: 다른 클립 끝·재생 위치에 붙는다. Ctrl 을 누르고 끌면 반대로.
 *  - 눈금자 클릭 = 재생 위치, 눈금자 끌기 = 반복 구간. 스페이스 = 재생/멈춤, Delete = 클립 지우기, Ctrl+Z / Ctrl+Shift+Z.
 * ★반복 조작이라 움직임 효과를 넣지 않는다(즉시 반응). 재생 위치선만 transform 으로 옮긴다.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react'
import { Action, button, primary, muted, badge } from './kit'
import VoiceFxPanel from './VoiceFxPanel'
import * as M from '../../shared/voiceEdit/model'
import { clipHit, hitCursor, type ClipHit } from '../../shared/voiceEdit/hit'
import { fadeInGain } from '../../shared/voiceFx/fades'
import { VoiceEditPlayer, loadPeaks, renderProject, PEAK_BINS_PER_SEC } from '../lib/voiceEdit/engine'
import type { VoiceFxSettings } from '../../shared/voiceFx/settings'

const LANE_H = 76
const RULER_H = 28
const HEAD_W = 176
const COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#10b981', '#ef4444', '#ec4899']

type Drag = { kind: Exclude<ClipHit, null>; clipId: string; x0: number; y0: number; base: M.VeProject; clip: M.VeClip; moved: boolean }
  | { kind: 'ruler'; x0: number; t0: number; moved: boolean }

function fmtTime (s: number): string {
  const m = Math.floor(s / 60), r = s - m * 60
  return `${m}:${r.toFixed(2).padStart(5, '0')}`
}

/** 클립 하나의 파형 — 요약(초당 200칸)에서 보이는 부분만 그린다. */
function ClipWave ({ clip, pps, color }: { clip: M.VeClip; pps: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  useEffect(() => { let alive = true; loadPeaks(clip.path).then((p) => { if (alive) setPeaks(p) }).catch(() => {}); return () => { alive = false } }, [clip.path])
  const w = Math.max(1, Math.round(clip.duration * pps)), h = LANE_H - 10
  useEffect(() => {
    const cv = ref.current
    if (!cv || !peaks) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.min(16384, Math.round(w * dpr)); cv.height = Math.round(h * dpr)
    const g = cv.getContext('2d')!
    g.scale(cv.width / w, dpr)
    g.clearRect(0, 0, w, h)
    g.fillStyle = color
    const bins = peaks.length / 2
    for (let x = 0; x < w; x++) {
      const a = Math.floor((clip.offset + x / pps) * PEAK_BINS_PER_SEC), z = Math.max(a + 1, Math.floor((clip.offset + (x + 1) / pps) * PEAK_BINS_PER_SEC))
      let lo = 0, hi = 0
      for (let k = a; k < z && k < bins; k++) { lo = Math.min(lo, peaks[2 * k]); hi = Math.max(hi, peaks[2 * k + 1]) }
      const y0 = h / 2 - hi * h / 2, y1 = h / 2 - lo * h / 2
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0))
    }
  }, [peaks, w, h, pps, clip.offset, color])
  return <canvas ref={ref} style={{ position: 'absolute', left: 0, top: 5, width: w, height: h, opacity: 0.55, pointerEvents: 'none' }} />
}

/** 페이드 곡선 — 실제 쓰이는 값(크로스페이드 포함)을 그린다. */
function FadeOverlay ({ s, w, h }: { s: M.VeScheduled | undefined; w: number; h: number }) {
  if (!s) return null
  const pts = (len: number, shape: 'equalPower' | 'linear', out: boolean): string => {
    const px = len * (w / s.duration), n = 24
    return Array.from({ length: n + 1 }, (_, i) => {
      const t = i / n, x = out ? w - px + t * px : t * px
      const g = fadeInGain(shape, out ? 1 - t : t)
      return `${x.toFixed(1)},${(h - g * h).toFixed(1)}`
    }).join(' ')
  }
  return <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible' }}>
    {s.fadeIn > 0 && <><polygon points={`0,0 ${pts(s.fadeIn, s.fadeInShape, false)} 0,0`} fill="rgba(0,0,0,0.28)" />
      <polyline points={pts(s.fadeIn, s.fadeInShape, false)} fill="none" stroke="#fff" strokeWidth={1.2} />
      <circle cx={s.fadeIn * (w / s.duration)} cy={4} r={4} fill="#fff" /></>}
    {s.fadeOut > 0 && <><polygon points={`${w},0 ${pts(s.fadeOut, s.fadeOutShape, true)} ${w},0`} fill="rgba(0,0,0,0.28)" />
      <polyline points={pts(s.fadeOut, s.fadeOutShape, true)} fill="none" stroke="#fff" strokeWidth={1.2} />
      <circle cx={w - s.fadeOut * (w / s.duration)} cy={4} r={4} fill="#fff" /></>}
  </svg>
}

export default function VoiceEditWorkspace () {
  const [project, setProject] = useState<M.VeProject>(M.emptyProject())
  const [ready, setReady] = useState(false)
  const [past, setPast] = useState<M.VeProject[]>([])
  const [future, setFuture] = useState<M.VeProject[]>([])
  const [sel, setSel] = useState<{ clipId?: string; trackId?: string }>({})
  const [pps, setPps] = useState(80)
  const [snap, setSnap] = useState(true)
  const [playhead, setPlayhead] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState<[number, number] | null>(null)
  const [loopOn, setLoopOn] = useState(false)
  const [notice, setNotice] = useState<{ text: string; path?: string; tone?: 'error' } | null>(null)
  const [busy, setBusy] = useState('')
  const [reductions, setReductions] = useState<Record<string, Record<string, number>>>({})
  const [cursor, setCursor] = useState('default')
  const player = useRef<VoiceEditPlayer | null>(null)
  const drag = useRef<Drag | null>(null)
  const lanes = useRef<HTMLDivElement>(null)
  const headLine = useRef<HTMLDivElement>(null)
  const projectRef = useRef(project); projectRef.current = project

  // 불러오기 · 자동 저장
  useEffect(() => {
    let alive = true
    window.api.voiceEdit.getLast().then((r) => {
      if (!alive) return
      let p = r.ok && r.project ? M.sanitizeProject(r.project) : M.emptyProject()
      if (!r.ok) setNotice({ text: r.why, tone: 'error' })
      if (!p.tracks.length) { p = M.addTrack(p, '화자 A'); p = M.addTrack(p, '화자 B') }
      setProject(p); setSel({ trackId: p.tracks[0]?.id }); setReady(true)
    }).catch(() => { if (alive) { const p = M.addTrack(M.addTrack(M.emptyProject(), '화자 A'), '화자 B'); setProject(p); setReady(true) } })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (!ready) return
    const t = window.setTimeout(() => { void window.api.voiceEdit.setLast(project).then((r) => { if (!r.ok) setNotice({ text: r.why, tone: 'error' }) }) }, 800)
    return () => window.clearTimeout(t)
  }, [project, ready])

  // 재생기
  useEffect(() => {
    const p = new VoiceEditPlayer()
    const pending: Record<string, Record<string, number>> = {}
    let raf = 0
    p.onMeter = (which, tid, db) => {
      (pending[tid] ??= {})[which] = db
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; setReductions((r) => { const n = { ...r }; for (const k of Object.keys(pending)) n[k] = { ...n[k], ...pending[k] }; return n }) })
    }
    player.current = p
    return () => { void p.dispose(); cancelAnimationFrame(raf) }
  }, [])
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = (): void => {
      const pl = player.current
      if (pl) {
        const t = pl.position()
        if (headLine.current) headLine.current.style.transform = `translateX(${t * pps}px)`
        if (!pl.playing) { setPlaying(false); setPlayhead(t); setReductions({}); return }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, pps])
  useEffect(() => { if (!playing && headLine.current) headLine.current.style.transform = `translateX(${playhead * pps}px)` }, [playhead, pps, playing])

  const play = useCallback(async (from = playhead) => {
    const pl = player.current; if (!pl) return
    if (!projectRef.current.clips.length) { setNotice({ text: '먼저 소리를 추가하세요' }); return }
    try { await pl.play(projectRef.current, from, loopOn ? loop : null); setPlaying(true); setNotice(null) }
    catch (e) { setNotice({ text: '재생하지 못했습니다: ' + (e as Error).message, tone: 'error' }) }
  }, [playhead, loop, loopOn])
  const stop = useCallback(() => { const pl = player.current; if (!pl) return; const t = pl.position(); pl.stop(); setPlaying(false); setPlayhead(t); setReductions({}) }, [])

  /** 편집 확정 — 되돌리기 기록에 넣고, 재생 중이면 지금 자리부터 새 내용으로 다시 튼다. */
  const commit = useCallback((next: M.VeProject, prev: M.VeProject) => {
    setProject(next); setPast((p) => [...p.slice(-99), prev]); setFuture([])
    const pl = player.current
    if (pl?.playing) { const t = pl.position(); void pl.play(next, t, loopOn ? loop : null) }
  }, [loop, loopOn])
  const apply = (fn: (p: M.VeProject) => M.VeProject): void => { const prev = projectRef.current; const next = fn(prev); if (next !== prev) commit(next, prev) }
  const undo = (): void => { setPast((p) => { if (!p.length) return p; const prev = p[p.length - 1]; setFuture((f) => [projectRef.current, ...f]); setProject(prev); return p.slice(0, -1) }) }
  const redo = (): void => { setFuture((f) => { if (!f.length) return f; const next = f[0]; setPast((p) => [...p, projectRef.current]); setProject(next); return f.slice(1) }) }

  const sched = useMemo(() => new Map(M.mixSchedule({ ...project, tracks: project.tracks.map((t) => ({ ...t, mute: false, solo: false })) }).map((s) => [s.clipId, s])), [project])
  const duration = M.projectDuration(project)
  const width = Math.max(800, (duration + 10) * pps)

  // 추가
  const addTrack = (): void => apply((p) => M.addTrack(p, `화자 ${String.fromCharCode(65 + p.tracks.length)}`))
  const addClips = async (): Promise<void> => {
    const tid = sel.trackId && project.tracks.some((t) => t.id === sel.trackId) ? sel.trackId : project.tracks[0]?.id
    if (!tid) return
    const picked = await window.api.audio.selectFile(true, 'source') as string[] | null
    if (!picked?.length) return
    setBusy('소리를 불러오는 중…')
    let p = projectRef.current
    const failed: string[] = []
    for (const path of picked) {
      try {
        const info = await window.api.audio.getFileInfo(path) as { name?: string; duration?: number }
        if (!info || !(Number(info.duration) > 0)) throw Error('길이를 읽지 못함')
        p = M.addClip(p, tid, { path, name: info.name || path.split(/[\\/]/).pop() || '소리', duration: Number(info.duration) })
      } catch { failed.push(path.split(/[\\/]/).pop() || path) }
    }
    setBusy('')
    commit(p, projectRef.current)
    if (failed.length) setNotice({ text: `추가하지 못한 파일: ${failed.join(', ')}`, tone: 'error' })
  }
  const save = async (): Promise<void> => {
    if (!project.clips.length) { setNotice({ text: '섞을 클립이 없습니다' }); return }
    stop(); setBusy('섞어서 저장하는 중…')
    try {
      const r = await renderProject(project)
      const s = await window.api.voiceEdit.save({ name: '음성편집', wav: r.wav, project })
      setNotice(s.ok ? { text: `저장했습니다 · ${r.seconds.toFixed(1)}초 · 최대 ${r.truePeakDb.toFixed(1)}dBTP`, path: s.path } : { text: s.why, tone: 'error' })
    } catch (e) { setNotice({ text: '저장하지 못했습니다: ' + (e as Error).message, tone: 'error' }) }
    finally { setBusy('') }
  }

  // 끌기
  const toTime = (clientX: number): number => {
    const r = lanes.current!.getBoundingClientRect()
    return Math.max(0, (clientX - r.left + lanes.current!.scrollLeft) / pps)
  }
  const laneAt = (clientY: number): M.VeTrack | undefined => {
    const r = lanes.current!.getBoundingClientRect()
    const i = Math.floor((clientY - r.top - RULER_H) / LANE_H)
    return project.tracks[i]
  }
  const hitAt = (clientX: number, clientY: number): { clip?: M.VeClip; hit: ClipHit } => {
    const track = laneAt(clientY); if (!track) return { hit: null }
    const r = lanes.current!.getBoundingClientRect()
    const ti = project.tracks.indexOf(track)
    const x = clientX - r.left + lanes.current!.scrollLeft, y = clientY - r.top - RULER_H - ti * LANE_H - 5
    const cand = project.clips.filter((c) => c.trackId === track.id).reverse()
    for (const c of cand) {
      const s = sched.get(c.id)
      const h = clipHit(x - c.start * pps, y, c.duration * pps, LANE_H - 10, (s?.fadeIn ?? c.fadeIn) * pps, (s?.fadeOut ?? c.fadeOut) * pps)
      if (h) return { clip: c, hit: h }
    }
    return { hit: null }
  }
  const onDown = (e: RPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !lanes.current) return
    lanes.current.focus()
    const r = lanes.current.getBoundingClientRect()
    if (e.clientY - r.top < RULER_H) {
      drag.current = { kind: 'ruler', x0: e.clientX, t0: toTime(e.clientX), moved: false }
    } else {
      const { clip, hit } = hitAt(e.clientX, e.clientY)
      const track = laneAt(e.clientY)
      setSel({ clipId: clip?.id, trackId: clip?.trackId ?? track?.id })
      if (!clip || !hit) return
      drag.current = { kind: hit, clipId: clip.id, x0: e.clientX, y0: e.clientY, base: project, clip, moved: false }
      if (hit === 'move') setCursor('grabbing')
    }
    // 끌기 중 창 밖으로 나가도 이어지게 붙잡는다 — 포인터가 이미 끊겼으면(펜·터치 끊김, 자동화 입력) 붙잡지 않고 그대로 끈다.
    try { lanes.current.setPointerCapture(e.pointerId) } catch { /* 붙잡기 없이 계속 */ }
  }
  const onMove = (e: RPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) { setCursor(hitCursor(hitAt(e.clientX, e.clientY).hit)); return }
    if (Math.abs(e.clientX - d.x0) > 3) d.moved = true
    if (d.kind === 'ruler') { if (d.moved) setLoop([Math.min(d.t0, toTime(e.clientX)), Math.max(d.t0, toTime(e.clientX))]); return }
    if (!d.moved && d.kind !== 'move') return
    if (d.kind === 'move' && !d.moved && Math.abs(e.clientY - d.y0) < 6) return
    d.moved = true
    const dt = (e.clientX - d.x0) / pps
    const doSnap = snap !== (e.ctrlKey || e.metaKey)
    const th = 8 / pps
    const targets = M.snapTargets(d.base, d.clipId, playhead)
    const c = d.clip
    let next = d.base
    if (d.kind === 'move') {
      let s = c.start + dt
      if (doSnap) {
        const a = M.snapTime(s, targets, th), b = M.snapTime(s + c.duration, targets, th) - c.duration
        s = Math.abs(a - s) <= Math.abs(b - s) ? a : b
      }
      next = M.moveClip(d.base, c.id, s, laneAt(e.clientY)?.id ?? c.trackId)
    } else if (d.kind === 'trimStart' || d.kind === 'trimEnd') {
      const edge = d.kind === 'trimStart' ? 'start' : 'end'
      let t = (edge === 'start' ? c.start : c.start + c.duration) + dt
      if (doSnap) t = M.snapTime(t, targets, th)
      next = M.trimClip(d.base, c.id, edge, t)
    } else {
      const s = sched.get(c.id)
      const cur = d.kind === 'fadeIn' ? (s && s.fadeIn > c.fadeIn ? c.fadeIn : c.fadeIn) : c.fadeOut
      next = M.setFade(d.base, c.id, d.kind === 'fadeIn' ? 'in' : 'out', cur + (d.kind === 'fadeIn' ? dt : -dt))
    }
    setProject(next)
  }
  const onUp = (e: RPointerEvent<HTMLDivElement>): void => {
    const d = drag.current; drag.current = null
    try { lanes.current?.releasePointerCapture(e.pointerId) } catch { /* 붙잡지 않았다 */ }
    setCursor('default')
    if (!d) return
    if (d.kind === 'ruler') {
      if (!d.moved) { setPlayhead(d.t0); if (player.current?.playing) void play(d.t0) }
      else setLoopOn(true)
      return
    }
    if (d.moved) commit(projectRef.current, d.base)
  }
  const onKey = (e: React.KeyboardEvent): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    if (e.code === 'Space') { e.preventDefault(); if (playing) stop(); else void play() }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.clipId) { e.preventDefault(); apply((p) => M.removeClip(p, sel.clipId!)); setSel({ trackId: sel.trackId }) }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo() }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && sel.clipId) {
      e.preventDefault()
      const c = project.clips.find((x) => x.id === sel.clipId); if (!c) return
      const step = (e.shiftKey ? 0.1 : 0.01) * (e.key === 'ArrowLeft' ? -1 : 1)
      apply((p) => M.moveClip(p, c.id, c.start + step))
    }
  }

  const selClip = project.clips.find((c) => c.id === sel.clipId)
  const selTrack = project.tracks.find((t) => t.id === (selClip?.trackId ?? sel.trackId))
  const setFx = (fx: VoiceFxSettings): void => {
    if (!selTrack) return
    const next = M.setTrack(projectRef.current, selTrack.id, { fx })
    setProject(next); setPast((p) => [...p.slice(-99), projectRef.current]); setFuture([])
    player.current?.setTrackFx(selTrack.id, next.tracks.find((t) => t.id === selTrack.id)!.fx)   // 끊지 않고 바로
  }
  const lane: CSSProperties = { position: 'relative', height: LANE_H, borderBottom: '1px solid var(--border-subtle)' }

  return <div data-testid="voiceedit-workspace" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Action icon="plus" label="화자 추가" testId="ve-add-track" onClick={addTrack} title="새 화자 트랙을 만듭니다">화자</Action>
      <Action icon="file" label="소리 추가" testId="ve-add-clip" onClick={() => void addClips()} disabled={!!busy || !project.tracks.length} title="고른 화자 트랙 끝에 소리 파일을 놓습니다(여러 개 가능)">소리</Action>
      <span style={{ width: 1, height: 22, background: 'var(--border-subtle)' }} />
      {playing
        ? <Action icon="stop" label="멈춤" testId="ve-stop" onClick={stop} title="멈춤 (스페이스)" />
        : <Action icon="play" label="재생" testId="ve-play" onClick={() => void play()} title="재생 위치부터 듣기 (스페이스)" />}
      <button type="button" data-testid="ve-loop" aria-pressed={loopOn} onClick={() => setLoopOn((v) => !v)} disabled={!loop} title="눈금자를 끌어 정한 구간을 반복해서 듣습니다 — 들으며 처리 값을 조절할 때"
        style={{ ...button, borderColor: loopOn ? 'var(--border-accent)' : undefined, color: loopOn ? 'var(--accent-light)' : undefined, opacity: loop ? 1 : 0.4 }}>구간 반복</button>
      <button type="button" data-testid="ve-snap" aria-pressed={snap} onClick={() => setSnap((v) => !v)} title="다른 클립 끝·재생 위치에 붙입니다. 끄는 동안 Ctrl 로 반대로."
        style={{ ...button, borderColor: snap ? 'var(--border-accent)' : undefined, color: snap ? 'var(--accent-light)' : undefined }}>붙이기</button>
      <span style={{ ...badge, fontVariantNumeric: 'tabular-nums' }} data-testid="ve-time">{fmtTime(playhead)}</span>
      <span style={{ flex: 1 }} />
      <button type="button" data-testid="ve-undo" onClick={undo} disabled={!past.length} title="되돌리기 (Ctrl+Z)" style={{ ...button, opacity: past.length ? 1 : 0.4 }}>되돌리기</button>
      <button type="button" data-testid="ve-redo" onClick={redo} disabled={!future.length} title="다시 하기 (Ctrl+Shift+Z)" style={{ ...button, opacity: future.length ? 1 : 0.4 }}>다시</button>
      <button type="button" style={button} onClick={() => setPps((v) => Math.max(10, v / 1.5))} title="축소" aria-label="축소">−</button>
      <button type="button" style={button} onClick={() => setPps((v) => Math.min(800, v * 1.5))} title="확대" aria-label="확대">+</button>
      <button type="button" data-testid="ve-save" onClick={() => void save()} disabled={!!busy || !project.clips.length} style={{ ...primary, opacity: busy || !project.clips.length ? 0.5 : 1 }} title="모든 트랙을 처리·섞어 WAV 로 저장합니다(들은 소리와 같습니다)">섞어서 저장</button>
    </div>
    {(busy || notice) && <div role="status" data-testid="ve-notice" data-path={notice?.path ?? ""} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, padding: '8px 11px', borderRadius: 8, border: '1px solid var(--border-subtle)', color: notice?.tone === 'error' ? 'var(--rose, #f43f5e)' : 'var(--text-secondary)' }}>
      <span style={{ flex: 1 }}>{busy || notice?.text}</span>
      {!busy && notice?.path && <button type="button" style={button} onClick={() => void window.api.app.revealFile(notice.path!)}>폴더에서 보기</button>}
    </div>}

    <div style={{ display: 'flex', border: '1px solid var(--border-subtle)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-base)' }}>
      <div style={{ width: HEAD_W, flexShrink: 0, borderRight: '1px solid var(--border-subtle)' }}>
        <div style={{ height: RULER_H, borderBottom: '1px solid var(--border-subtle)' }} />
        {project.tracks.map((t, i) => <div key={t.id} data-testid={`ve-head-${i}`} onClick={() => setSel({ trackId: t.id })}
          style={{ ...lane, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6, cursor: 'pointer', background: selTrack?.id === t.id ? 'var(--accent-glow)' : undefined }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[i % COLORS.length], flexShrink: 0 }} />
            <input aria-label="화자 이름" value={t.name} onChange={(e) => setProject(M.setTrack(project, t.id, { name: e.target.value }))} onBlur={() => commit(projectRef.current, project)}
              style={{ flex: 1, minWidth: 0, font: 'inherit', fontSize: 13, background: 'transparent', border: 'none', color: 'var(--text-primary)' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button type="button" data-testid={`ve-mute-${i}`} aria-pressed={t.mute} title="이 화자 끄기" onClick={(e) => { e.stopPropagation(); apply((p) => M.setTrack(p, t.id, { mute: !t.mute })) }}
              style={{ ...button, minHeight: 26, padding: '2px 8px', color: t.mute ? 'var(--amber, #f59e0b)' : undefined }}>끔</button>
            <button type="button" data-testid={`ve-solo-${i}`} aria-pressed={t.solo} title="이 화자만 듣기" onClick={(e) => { e.stopPropagation(); apply((p) => M.setTrack(p, t.id, { solo: !t.solo })) }}
              style={{ ...button, minHeight: 26, padding: '2px 8px', color: t.solo ? 'var(--accent-light)' : undefined }}>단독</button>
            <span style={{ ...muted, marginLeft: 'auto' }} title="이 화자에 켠 처리 수">{Object.values(t.fx).filter((s) => (s as { on: boolean }).on).length}개 처리</span>
          </div>
        </div>)}
      </div>
      <div ref={lanes} tabIndex={0} data-testid="ve-lanes" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onKeyDown={onKey}
        style={{ position: 'relative', flex: 1, overflowX: 'auto', overflowY: 'hidden', outline: 'none', cursor, userSelect: 'none' }}>
        <div style={{ position: 'relative', width, height: RULER_H + project.tracks.length * LANE_H }}>
          <div data-testid="ve-ruler" style={{ position: 'relative', height: RULER_H, borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', cursor: 'text' }}>
            {Array.from({ length: Math.ceil(width / pps) + 1 }, (_, s) => s).filter((s) => pps >= 40 || s % 5 === 0).map((s) =>
              <span key={s} style={{ position: 'absolute', left: s * pps, top: 0, height: RULER_H, borderLeft: '1px solid var(--border-subtle)', paddingLeft: 3, fontSize: 10, color: 'var(--text-muted)' }}>{s}s</span>)}
            {loop && <div data-testid="ve-loop-region" style={{ position: 'absolute', left: loop[0] * pps, width: (loop[1] - loop[0]) * pps, top: 0, height: RULER_H, background: loopOn ? 'rgba(139,92,246,0.35)' : 'rgba(148,163,184,0.25)' }} />}
          </div>
          {project.tracks.map((t, i) => <div key={t.id} data-testid={`ve-lane-${i}`} style={{ ...lane, background: selTrack?.id === t.id ? 'rgba(139,92,246,0.04)' : undefined }}>
            {project.clips.filter((c) => c.trackId === t.id).map((c) => {
              const w = Math.max(2, c.duration * pps), color = COLORS[i % COLORS.length], on = c.id === sel.clipId
              return <div key={c.id} data-testid={`ve-clip-${c.id}`} data-start={c.start} data-duration={c.duration}
                style={{ position: 'absolute', left: c.start * pps, top: 5, width: w, height: LANE_H - 10, borderRadius: 6, overflow: 'hidden',
                  background: `${color}33`, border: `1px solid ${on ? '#fff' : color}`, boxSizing: 'border-box', opacity: t.mute ? 0.4 : 1, pointerEvents: 'none' }}>
                <ClipWave clip={c} pps={pps} color={color} />
                <FadeOverlay s={sched.get(c.id)} w={w} h={LANE_H - 10} />
                <span style={{ position: 'absolute', left: 6, bottom: 3, fontSize: 11, color: 'var(--text-primary)', whiteSpace: 'nowrap', textShadow: '0 1px 2px rgba(0,0,0,.6)' }}>{c.name}{c.gainDb ? ` · ${c.gainDb > 0 ? '+' : ''}${c.gainDb.toFixed(1)}dB` : ''}</span>
              </div>
            })}
          </div>)}
          <div ref={headLine} data-testid="ve-playhead" style={{ position: 'absolute', left: 0, top: 0, width: 2, height: '100%', background: 'var(--rose, #f43f5e)', pointerEvents: 'none', willChange: 'transform' }} />
        </div>
      </div>
    </div>
    {!project.clips.length && ready && <div style={{ ...muted, fontSize: 12 }}>‘소리’ 로 목소리 파일을 화자 트랙에 놓고, 끌어서 겹치면 끼어들기·동시 발화가 됩니다.</div>}

    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600 }}>{selTrack ? `${selTrack.name} — 음성 처리` : '화자를 고르세요'}</h3>
        {selTrack && <VoiceFxPanel fx={selTrack.fx} onChange={setFx} reductions={playing ? reductions[selTrack.id] as never : undefined} />}
      </section>
      <section data-testid="ve-clip-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600 }}>{selClip ? `클립 — ${selClip.name}` : '클립을 고르세요'}</h3>
        {selClip && <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
          <div style={muted}>시작 {fmtTime(selClip.start)} · 길이 {selClip.duration.toFixed(2)}초 · 원본 {selClip.offset.toFixed(2)}초부터</div>
          <label title="이 클립만 크게·작게" style={{ display: 'grid', gridTemplateColumns: '64px 1fr 60px', alignItems: 'center', gap: 8 }}>
            <span>음량</span>
            <input type="range" data-testid="ve-clip-gain" min={-24} max={12} step={0.5} value={selClip.gainDb}
              onChange={(e) => setProject(M.setClip(project, selClip.id, { gainDb: Number(e.target.value) }))} onPointerUp={() => commit(projectRef.current, project)} />
            <span style={{ textAlign: 'right' }}>{selClip.gainDb.toFixed(1)}dB</span>
          </label>
          <label title="페이드 곡선 — 부드럽게(EqualPower)는 겹칠 때 크기가 일정합니다" style={{ display: 'grid', gridTemplateColumns: '64px 1fr', alignItems: 'center', gap: 8 }}>
            <span>곡선</span>
            <select data-testid="ve-clip-shape" value={selClip.shape} onChange={(e) => apply((p) => M.setClip(p, selClip.id, { shape: e.target.value as 'equalPower' | 'linear' }))} style={{ font: 'inherit', fontSize: 12 }}>
              <option value="equalPower">부드럽게</option><option value="linear">일정하게</option>
            </select>
          </label>
          <div style={muted}>페이드 인 {selClip.fadeIn.toFixed(2)}초 · 아웃 {selClip.fadeOut.toFixed(2)}초 {sched.get(selClip.id) && (sched.get(selClip.id)!.fadeIn > selClip.fadeIn || sched.get(selClip.id)!.fadeOut > selClip.fadeOut) ? '· 겹친 구간은 크로스페이드' : ''}</div>
          <button type="button" data-testid="ve-clip-remove" style={{ ...button, alignSelf: 'flex-start' }} onClick={() => { apply((p) => M.removeClip(p, selClip.id)); setSel({ trackId: selClip.trackId }) }}>클립 지우기</button>
        </div>}
      </section>
    </div>
  </div>
}
