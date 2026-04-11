import { useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import { useAppStore } from '@/stores/app.store'

export default function Waveform() {
  const { fileUrl } = useAppStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState('0:00')
  const [duration, setDuration] = useState('0:00')

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  useEffect(() => {
    if (!containerRef.current || !fileUrl) return
    wsRef.current?.destroy()

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: 'rgba(139, 92, 246, 0.25)',
      progressColor: 'rgba(139, 92, 246, 0.7)',
      cursorColor: 'var(--accent-light)',
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
  }, [fileUrl])

  if (!fileUrl) return null

  return (
    <div style={{ padding: '0 16px 12px' }}>
      <div ref={containerRef} style={{ marginBottom: 8 }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 10, fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{currentTime}</span>
        <button onClick={() => wsRef.current?.playPause()} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 32, height: 32, borderRadius: '50%', border: 'none', cursor: 'pointer',
          background: isPlaying ? 'var(--accent-glow)' : 'linear-gradient(135deg, var(--accent), #7c3aed)',
          boxShadow: isPlaying ? 'none' : '0 2px 12px var(--accent-glow)'
        }}>
          {isPlaying ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--accent-light)" stroke="none">
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
