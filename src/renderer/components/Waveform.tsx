import { useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import { useAppStore } from '@/stores/app.store'

const MODE_WAVE_COLORS: Record<string, { wave: string; progress: string; cursor: string; btn: string; btnGlow: string }> = {
  music:        { wave: 'rgba(139,92,246,0.25)', progress: 'rgba(139,92,246,0.7)', cursor: '#a78bfa', btn: 'linear-gradient(135deg,#8b5cf6,#7c3aed)', btnGlow: 'rgba(139,92,246,0.2)' },
  conversation: { wave: 'rgba(34,211,238,0.25)', progress: 'rgba(34,211,238,0.7)', cursor: '#22d3ee', btn: 'linear-gradient(135deg,#06b6d4,#0891b2)', btnGlow: 'rgba(34,211,238,0.2)' },
  transcribe:   { wave: 'rgba(52,211,153,0.25)', progress: 'rgba(52,211,153,0.7)', cursor: '#34d399', btn: 'linear-gradient(135deg,#10b981,#059669)', btnGlow: 'rgba(52,211,153,0.2)' },
  split:        { wave: 'rgba(251,191,36,0.25)', progress: 'rgba(251,191,36,0.7)', cursor: '#fbbf24', btn: 'linear-gradient(135deg,#f59e0b,#d97706)', btnGlow: 'rgba(251,191,36,0.2)' },
  tts:          { wave: 'rgba(251,113,133,0.25)', progress: 'rgba(251,113,133,0.7)', cursor: '#fb7185', btn: 'linear-gradient(135deg,#f43f5e,#e11d48)', btnGlow: 'rgba(251,113,133,0.2)' },
}

const DEFAULT_COLORS = MODE_WAVE_COLORS.music

export default function Waveform() {
  const { fileUrl, mode } = useAppStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState('0:00')
  const [duration, setDuration] = useState('0:00')

  const colors = MODE_WAVE_COLORS[mode] || DEFAULT_COLORS

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  useEffect(() => {
    if (!containerRef.current || !fileUrl) return
    wsRef.current?.destroy()

    const c = MODE_WAVE_COLORS[useAppStore.getState().mode] || DEFAULT_COLORS
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: c.wave,
      progressColor: c.progress,
      cursorColor: c.cursor,
      cursorWidth: 2, barWidth: 2, barGap: 2, barRadius: 4,
      height: 56, normalize: true, backend: 'WebAudio'
    })

    ws.on('play', () => setIsPlaying(true))
    ws.on('pause', () => setIsPlaying(false))
    ws.on('timeupdate', (t) => setCurrentTime(formatTime(t)))
    ws.on('decode', (d) => setDuration(formatTime(d)))
    ws.load(fileUrl)
    wsRef.current = ws

    return () => { ws.destroy(); wsRef.current = null; setIsPlaying(false) }
  }, [fileUrl, mode])

  if (!fileUrl) return null

  return (
    <div style={{ padding: '0 16px 12px' }}>
      <div ref={containerRef} style={{ marginBottom: 8 }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 10, fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{currentTime}</span>
        <button onClick={() => wsRef.current?.playPause()} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 32, height: 32, borderRadius: '50%', border: 'none', cursor: 'pointer',
          background: isPlaying ? `${colors.cursor}20` : colors.btn,
          boxShadow: isPlaying ? 'none' : `0 2px 12px ${colors.btnGlow}`
        }}>
          {isPlaying ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill={colors.cursor} stroke="none">
              <rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="#fff" stroke="none">
              <polygon points="6,3 20,12 6,21" />
            </svg>
          )}
        </button>
        <span style={{ fontSize: 10, fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{duration}</span>
      </div>
    </div>
  )
}
