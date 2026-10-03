import SpeakerControl from './SpeakerControl'
import { attachPlaybackBoost } from '../lib/playbackBoost'
import { useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js'
import { getPlaybackVolume, onPlaybackVolumeChange } from '../lib/playbackVolume'
import { Icon } from './kit'
import { useAppStore } from '../stores/app.store'
import { onManagedPlay, pauseManagedAudio } from '../lib/playbackVolume'
import { loadWave } from '../lib/waveLoad'

const PLAY_EVENT = 'audioforge:compact-voice-play'
type Props = { path: string; name: string; region?: { start: number; duration: number } | null; disabled: boolean; result?: boolean; onPlayingChange?: (playing: boolean) => void }

/** Existing local-file transport and WaveSurfer renderer, displayed without a source-file card. */
export default function CompactVoiceWaveform({ path, name, region, disabled, result = false, onPlayingChange }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(!result)
  const changed = useRef(onPlayingChange); changed.current = onPlayingChange
  useEffect(() => {
    if (!result || !host.current) return
    const io = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setVisible(true); io.disconnect() } }, { rootMargin: '80px' })
    io.observe(host.current); return () => io.disconnect()
  }, [result])
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
    if (!host.current || !path || !visible) return
    let disposed = false
    setState({ path, phase: 'loading', duration: 0 }); setPlaying(false); setPlayError(false)
    const regions = RegionsPlugin.create()
    const ws = WaveSurfer.create({ container: host.current, height: result ? 24 : 32, barWidth: 2, barGap: 2, barRadius: 2,
      waveColor: 'rgba(139,92,246,.42)', progressColor: '#b49aff', cursorColor: '#d7c7ff', cursorWidth: 1,
      normalize: true, dragToSeek: true, plugins: [regions] })
    attachPlaybackBoost(ws.getMediaElement())
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
    ws.on('play', () => { if (!disposed) { setPlaying(true); changed.current?.(true) } })
    ws.on('pause', () => { if (!disposed) { setPlaying(false); changed.current?.(false) } })
    ws.on('finish', () => { if (!disposed) { setPlaying(false); changed.current?.(false) } })
    const stopManaged = result ? onManagedPlay(() => ws.pause()) : () => {}
    const stopClaim = result ? useAppStore.subscribe(s => { if (s.audioClaim && s.audioClaim.owner !== 'card') ws.pause() }) : () => {}
    const stopPeer = (event: Event) => { if ((event as CustomEvent).detail !== ws) ws.pause() }
    window.addEventListener(PLAY_EVENT, stopPeer)
    // ★앱이 받아 넘긴다 — 카드를 만들고 곧바로 다른 작업실로 가면 끊기는데, 그 정상 취소를 wavesurfer 가 경고로 남겼다(2026-10-03). lib/waveLoad.
    const loading = new AbortController()
    void Promise.resolve(window.api.audio.getFileUrl(path)).then(url => {
      if (!disposed) return loadWave(ws, url, loading.signal)
    }).catch(fail)
    return () => {
      disposed = true; loading.abort(); unsubscribe(); stopManaged(); stopClaim(); window.removeEventListener(PLAY_EVENT, stopPeer); ws.destroy()
      if (player.current === ws) { player.current = null; overlay.current = null }
    }
  }, [path, retry, visible, result])
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
    if (result) { pauseManagedAudio(); useAppStore.getState().claimAudio('card') }
    window.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: ws }))
    const start = region?.start ?? 0, end = region ? region.start + region.duration : ws.getDuration()
    const current = ws.getCurrentTime()
    setPlayError(false)
    try { await ws.play(current >= start && current < end - .02 ? current : start, end) }
    catch { if (player.current === ws) setPlayError(true) }
  }
  const range = region ? `${region.start.toFixed(1)}–${(region.start + region.duration).toFixed(1)}초` : state.duration ? `${state.duration.toFixed(1)}초` : ''
  return <SpeakerControl><div data-testid={result ? "take-wave" : "compact-voice-wave"} data-playing={playing ? "true" : "false"} data-state={phase} data-path={path} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, height: result ? 34 : 40, background: 'var(--bg-base)', borderRadius: 9, padding: '0 8px', boxSizing: 'border-box' }}>
    <button type="button" data-testid={result ? "take-play" : "compact-voice-play"} aria-label={`${name} ${playing ? (result ? '정지' : '일시정지') : (result ? '재생' : '목소리 재생')}`} title={playError ? '재생 실패 · 다시 시도' : name}
      disabled={disabled || phase !== 'ready'} onClick={toggle}
      style={{ width: 28, height: 28, minWidth: 28, padding: 0, boxSizing: 'border-box', display: 'grid', placeItems: 'center', lineHeight: 0, flexShrink: 0, border: '1px solid var(--border-subtle)', borderRadius: '50%', background: 'var(--bg-elevated)', color: 'var(--accent-primary, #b49aff)', cursor: disabled || phase !== 'ready' ? 'default' : 'pointer', opacity: phase === 'ready' ? 1 : .45 }}>
      {result ? <Icon name={playing ? 'stop' : 'play'} size={14}/> : playing ? 'Ⅱ' : '▶'}
    </button>
    <div title={path} style={{ flex: '1 1 100px', minWidth: 0, position: 'relative' }}>
      <div ref={host} aria-label={`${name} ${result ? '결과' : '참조'} 파형`} style={{ height: result ? 24 : 32 }} />
      {phase !== 'ready' && <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', fontSize: 10, color: 'var(--text-muted)', pointerEvents: 'none' }}>{phase === 'error' ? '파일 읽기 실패' : '파형 로딩'}</span>}
    </div>
    {phase === 'error' ? <button type="button" disabled={disabled} onClick={() => setRetry(n => n + 1)} title={path} style={{ fontSize: 10, color: 'var(--text-secondary)', background: 'transparent', border: 0, cursor: 'pointer' }}>다시 읽기</button>
      : <span title={`${name} · ${region ? '선택 구간' : '전체 음성'}`} style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{playError ? '재생 실패' : range}</span>}
  </div></SpeakerControl>
}
