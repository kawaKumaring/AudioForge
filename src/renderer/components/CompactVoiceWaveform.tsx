import { useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js'
import { getPlaybackVolume, onPlaybackVolumeChange } from '../lib/playbackVolume'

const PLAY_EVENT = 'audioforge:compact-voice-play'
type Props = { path: string; name: string; region?: { start: number; duration: number } | null; disabled: boolean }

/** Existing local-file transport and WaveSurfer renderer, displayed without a source-file card. */
export default function CompactVoiceWaveform({ path, name, region, disabled }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const player = useRef<WaveSurfer | null>(null)
  const overlay = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null)
  const selected = useRef(region)
  selected.current = region
  const [state, setState] = useState<{ path: string; phase: 'loading' | 'ready' | 'error'; duration: number }>({ path: '', phase: 'loading', duration: 0 })
  const [playing, setPlaying] = useState(false)
  const [retry, setRetry] = useState(0)
  const [playError, setPlayError] = useState(false)
  const phase = state.path === path ? state.phase : 'loading'
  useEffect(() => {
    if (!host.current || !path) return
    let disposed = false
    setState({ path, phase: 'loading', duration: 0 }); setPlaying(false); setPlayError(false)
    const regions = RegionsPlugin.create()
    const ws = WaveSurfer.create({ container: host.current, height: 32, barWidth: 2, barGap: 2, barRadius: 2,
      waveColor: 'rgba(139,92,246,.42)', progressColor: '#b49aff', cursorColor: '#d7c7ff', cursorWidth: 1,
      normalize: true, dragToSeek: true, plugins: [regions] })
    player.current = ws; overlay.current = regions
    ws.setVolume(getPlaybackVolume())
    const unsubscribe = onPlaybackVolumeChange(v => ws.setVolume(v))
    const fail = () => { if (!disposed) { ws.pause(); setState({ path, phase: 'error', duration: 0 }); setPlaying(false) } }
    ws.on('error', fail)
    ws.on('ready', duration => {
      if (disposed) return
      const r = selected.current
      if (r) regions.addRegion({ start: r.start, end: r.start + r.duration, drag: false, resize: false, color: 'rgba(139,92,246,.18)' })
      setState({ path, phase: 'ready', duration })
    })
    ws.on('play', () => { if (!disposed) setPlaying(true) })
    ws.on('pause', () => { if (!disposed) setPlaying(false) })
    ws.on('finish', () => { if (!disposed) setPlaying(false) })
    const stopPeer = (event: Event) => { if ((event as CustomEvent).detail !== ws) ws.pause() }
    window.addEventListener(PLAY_EVENT, stopPeer)
    void Promise.resolve(window.api.audio.getFileUrl(path)).then(url => {
      if (!disposed) return ws.load(url)
    }).catch(fail)
    return () => {
      disposed = true; unsubscribe(); window.removeEventListener(PLAY_EVENT, stopPeer); ws.destroy()
      if (player.current === ws) { player.current = null; overlay.current = null }
    }
  }, [path, retry])
  useEffect(() => {
    if (phase !== 'ready' || !overlay.current) return
    player.current?.pause()
    overlay.current.clearRegions()
    if (region) overlay.current.addRegion({ start: region.start, end: region.start + region.duration, drag: false, resize: false, color: 'rgba(139,92,246,.18)' })
  }, [phase, region?.start, region?.duration])
  useEffect(() => { if (disabled) player.current?.pause(); player.current?.setOptions({ interact: !disabled }) }, [disabled, phase])
  const toggle = async () => {
    const ws = player.current
    if (!ws || phase !== 'ready' || disabled) return
    if (ws.isPlaying()) { ws.pause(); return }
    window.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: ws }))
    const start = region?.start ?? 0, end = region ? region.start + region.duration : ws.getDuration()
    const current = ws.getCurrentTime()
    setPlayError(false)
    try { await ws.play(current >= start && current < end - .02 ? current : start, end) }
    catch { if (player.current === ws) setPlayError(true) }
  }
  const range = region ? `${region.start.toFixed(1)}–${(region.start + region.duration).toFixed(1)}초` : state.duration ? `${state.duration.toFixed(1)}초` : ''
  return <div data-testid="compact-voice-wave" data-state={phase} data-path={path} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, height: 40 }}>
    <button type="button" data-testid="compact-voice-play" aria-label={`${name} ${playing ? '일시정지' : '목소리 재생'}`} title={playError ? '재생 실패 · 다시 시도' : name}
      disabled={disabled || phase !== 'ready'} onClick={toggle}
      style={{ width: 28, height: 28, flexShrink: 0, border: '1px solid var(--border-subtle)', borderRadius: '50%', background: 'var(--bg-elevated)', color: 'var(--accent-primary, #b49aff)', cursor: disabled || phase !== 'ready' ? 'default' : 'pointer', opacity: phase === 'ready' ? 1 : .45 }}>
      {playing ? 'Ⅱ' : '▶'}
    </button>
    <div title={path} style={{ flex: '1 1 100px', minWidth: 0, position: 'relative' }}>
      <div ref={host} aria-label={`${name} 참조 파형`} style={{ height: 32 }} />
      {phase !== 'ready' && <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', fontSize: 10, color: 'var(--text-muted)', pointerEvents: 'none' }}>{phase === 'error' ? '파일 읽기 실패' : '파형 로딩'}</span>}
    </div>
    {phase === 'error' ? <button type="button" disabled={disabled} onClick={() => setRetry(n => n + 1)} title={path} style={{ fontSize: 10, color: 'var(--text-secondary)', background: 'transparent', border: 0, cursor: 'pointer' }}>다시 읽기</button>
      : <span title={`${name} · ${region ? '선택 구간' : '전체 음성'}`} style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{playError ? '재생 실패' : range}</span>}
  </div>
}
