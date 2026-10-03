import SpeakerControl from './SpeakerControl'
import { attachPlaybackBoost } from '../lib/playbackBoost'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useAppStore } from '../stores/app.store'
import WaveSurfer from 'wavesurfer.js'
import { getPlaybackVolume, onPlaybackVolumeChange } from '../lib/playbackVolume'
import { loadWave } from '../lib/waveLoad'

export interface SongResultView {
  /** Unique generation request ID, not the current editable input. */
  id: string
  title: string
  /** Audio extracted from this request's original; never a raw video path. */
  originalAudioPath: string
  mixPath: string
}
export interface SongResultCardProps {
  result: SongResultView
  disabled?: boolean
  onSave: (result: SongResultView) => Promise<void>
  onOpenFolder: (result: SongResultView) => Promise<void>
}
const button: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 34, padding: '7px 11px', border: '1px solid var(--border-subtle)', borderRadius: 9, background: 'var(--bg-elevated)', color: 'var(--text-primary)', font: 'inherit', fontSize: 12, cursor: 'pointer' }
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
const PLAY_EVENT = 'audioforge:compact-voice-play'
function Glyph({ kind }: { kind: 'play' | 'pause' | 'folder' | 'save' }) {
  const paths = { play: 'm8 5 11 7-11 7V5', pause: 'M8 5v14M16 5v14', folder: 'M3 6h7l2 2h9v12H3V6', save: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4' }
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[kind]}/></svg>
}

/** Display-only result component. Parent owns conversion, output protection and file dialogs. */
export default function SongResultCard({ result, disabled = false, onSave, onOpenFolder }: SongResultCardProps) {
  const identity = `${result.id}\n${result.originalAudioPath}\n${result.mixPath}`
  // Reset playback state on a new result, including when paths are unexpectedly reused.
  return <ResultPlayback key={identity} result={result} disabled={disabled} onSave={onSave} onOpenFolder={onOpenFolder}/>
}
function ResultPlayback({ result, disabled, onSave, onOpenFolder }: SongResultCardProps) {
  const [side, setSide] = useState<'original' | 'mix'>('mix')
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [playing, setPlaying] = useState(false), [time, setTime] = useState(0), [duration, setDuration] = useState(0)
  const [retry, setRetry] = useState(0), [message, setMessage] = useState(''), [action, setAction] = useState('')
  const host = useRef<HTMLDivElement>(null), player = useRef<WaveSurfer | null>(null)
  const position = useRef(0), resume = useRef(false), locked = useRef(disabled), alive = useRef(true), pending = useRef(false)
  locked.current = disabled
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (disabled) { resume.current = false; player.current?.pause() }
  }, [disabled])
  const path = side === 'original' ? result.originalAudioPath : result.mixPath
  useEffect(() => {
    if (!host.current) return
    let disposed = false
    setPhase('loading'); setPlaying(false); setMessage('')
    const ws = WaveSurfer.create({ container: host.current, height: 54, barWidth: 2, barGap: 2, barRadius: 2,
      waveColor: '#8261b5', progressColor: '#c2a7fa', cursorColor: '#e0d5fc', normalize: true, dragToSeek: true, interact: !locked.current })
    attachPlaybackBoost(ws.getMediaElement())
    player.current = ws
    ws.setVolume(getPlaybackVolume())
    const unvolume = onPlaybackVolumeChange(v => ws.setVolume(v))
    const fail = () => { if (!disposed) { resume.current = false; ws.pause(); setPhase('error'); setMessage('소리를 읽지 못했습니다') } }
    const play = () => {
      if (locked.current || disposed) return
      window.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: ws }))
      void ws.play().catch(() => { if (!disposed) { resume.current = false; setMessage('재생하지 못했습니다') } })
    }
    ws.on('error', fail)
    ws.on('ready', length => {
      if (disposed) return
      const at = Math.min(position.current, length)
      position.current = at; ws.setTime(at); setTime(at); setDuration(length); setPhase('ready')
      if (resume.current && at < length) play()
      resume.current = false
    })
    ws.on('timeupdate', value => { if (!disposed) { position.current = value; setTime(value) } })
    ws.on('play', () => { if (!disposed) setPlaying(true) })
    ws.on('pause', () => { if (!disposed) setPlaying(false) })
    ws.on('finish', () => { if (!disposed) setPlaying(false) })
    const stop = (e: Event) => { if ((e as CustomEvent).detail !== ws) { resume.current = false; ws.pause() } }
    window.addEventListener(PLAY_EVENT, stop)
    const loading = new AbortController()      // 앱이 받아 넘긴다(lib/waveLoad) — 정리 때 먼저 끊는다
    void Promise.resolve().then(() => window.api.audio.getFileUrl(path)).then(url => { if (!disposed) return loadWave(ws, url, loading.signal) }).catch(fail)
    return () => { disposed = true; loading.abort(); unvolume(); window.removeEventListener(PLAY_EVENT, stop); ws.destroy(); if (player.current === ws) player.current = null }
  }, [path, retry])
  useEffect(() => { player.current?.setOptions({ interact: !disabled }) }, [disabled, phase])
  const choose = (next: 'original' | 'mix') => {
    if (disabled || next === side) return
    const ws = player.current
    if (phase === 'ready' && ws) { position.current = ws.getCurrentTime(); resume.current = ws.isPlaying() }
    ws?.pause(); setSide(next)
  }
  // ★다른 자리가 소리를 가져가면 여기서 멈춘다(결과 재생기·원본 파형과 같은 규칙).
  const claim = useAppStore((st) => st.audioClaim)
  useEffect(() => {
    if (claim && claim.owner !== 'song') { try { player.current?.pause() } catch { /* noop */ } }
  }, [claim])

  const toggle = async () => {
    const ws = player.current
    if (!ws || disabled || phase !== 'ready') return
    setMessage('')
    if (ws.isPlaying()) { ws.pause(); return }
    if (ws.getCurrentTime() >= ws.getDuration()) ws.setTime(0)
    window.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: ws }))
    // ★소리 낼 자리를 가져온다 — 원본 파형이나 다른 화면의 재생과 겹치지 않게.
    useAppStore.getState().claimAudio('song')
    try { await ws.play() } catch { if (alive.current && player.current === ws) setMessage('재생하지 못했습니다') }
  }
  const run = async (kind: 'save' | 'folder') => {
    if (disabled || pending.current) return
    pending.current = true; setAction(kind); setMessage('')
    try { await (kind === 'save' ? onSave(result) : onOpenFolder(result)) }
    catch { if (alive.current) setMessage(kind === 'save' ? '저장하지 못했습니다' : '폴더를 열지 못했습니다') }
    finally { pending.current = false; if (alive.current) setAction('') }
  }
  return <SpeakerControl><section aria-label="노래 변환 결과" data-testid="song-result" data-state={phase} style={{ padding: 18, border: '1px solid var(--border-subtle)', borderRadius: 16, background: 'var(--bg-card)', minWidth: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
      <div style={{ flex: '1 1 160px', minWidth: 0 }}><h2 style={{ margin: 0, fontSize: 14 }}>변환 음원</h2><div title={result.title} style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{result.title}</div></div>
      <button type="button" style={button} aria-label="결과 폴더 열기" title="결과 폴더 열기" disabled={disabled || !!action} onClick={() => void run('folder')}><Glyph kind="folder"/></button>
      <button type="button" style={button} disabled={disabled || !!action} onClick={() => void run('save')}><Glyph kind="save"/>{action === 'save' ? '저장 중' : '파일로 저장'}</button>
    </div>
    <div role="group" aria-label="비교할 소리" style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
      {(['original', 'mix'] as const).map(key => <button type="button" key={key} aria-pressed={side === key} disabled={disabled} title="같은 재생 시간에서 소리를 바꿉니다" style={{ ...button, borderColor: side === key ? 'var(--border-accent)' : 'transparent', background: side === key ? 'var(--accent-glow)' : 'transparent', color: side === key ? 'var(--accent-light)' : 'var(--text-muted)' }} onClick={() => choose(key)}>{key === 'original' ? '원곡' : '변환본'}</button>)}
    </div>
    <div style={{ padding: 12, background: 'var(--bg-base)', borderRadius: 10 }}>
      <div ref={host} aria-label={`${side === 'original' ? '원곡' : '변환본'} 파형`} style={{ minHeight: 54 }}/>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 36px minmax(0, 1fr)', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{phase === 'loading' ? '불러오는 중' : clock(time)}</span>
        <button type="button" aria-label={playing ? '비교 재생 일시정지' : '비교 재생'} disabled={disabled || phase !== 'ready'} onClick={() => void toggle()} style={{ ...button, width: 36, height: 36, padding: 0, borderRadius: '50%', color: 'var(--accent-light)' }}><Glyph kind={playing ? 'pause' : 'play'}/></button>
        <span style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)' }}>{phase === 'ready' ? clock(duration) : '—'}</span>
      </div>
    </div>
    {message && <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, fontSize: 12, color: 'var(--rose)' }}>{message}{phase === 'error' && <button type="button" style={button} disabled={disabled} onClick={() => setRetry(n => n + 1)}>다시 읽기</button>}</div>}
  </section></SpeakerControl>
}
