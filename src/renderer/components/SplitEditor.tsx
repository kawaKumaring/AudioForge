import { useEffect, useRef, useState, useCallback } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js'
import { useAppStore } from '@/stores/app.store'

interface Marker {
  id: string
  time: number
  label: string
}

export default function SplitEditor() {
  const { fileUrl, mode } = useAppStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null)
  const [markers, setMarkers] = useState<Marker[]>([])
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [inputMode, setInputMode] = useState<'auto' | 'manual'>('manual')
  const [timestampText, setTimestampText] = useState('')
  const [autoDetecting, setAutoDetecting] = useState(false)
  const markersRef = useRef<Marker[]>([])

  // Keep ref in sync
  useEffect(() => { markersRef.current = markers }, [markers])

  if (mode !== 'split') return null
  if (!fileUrl) return null

  // Initialize wavesurfer
  useEffect(() => {
    if (!containerRef.current || !fileUrl) return

    wsRef.current?.destroy()

    const regions = RegionsPlugin.create()
    regionsRef.current = regions

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: 'rgba(251, 191, 36, 0.25)',
      progressColor: 'rgba(251, 191, 36, 0.5)',
      cursorColor: '#fff',
      cursorWidth: 1,
      barWidth: 2, barGap: 1, barRadius: 2,
      height: 100, normalize: true, backend: 'WebAudio',
      plugins: [regions]
    })

    ws.on('decode', (d) => setDuration(d))
    ws.on('timeupdate', (t) => setCurrentTime(t))
    ws.on('play', () => setIsPlaying(true))
    ws.on('pause', () => setIsPlaying(false))

    // Double-click to add marker
    ws.on('dblclick', (relativeX) => {
      const time = relativeX * ws.getDuration()
      addMarker(time)
    })

    ws.load(fileUrl)
    wsRef.current = ws

    return () => { ws.destroy(); wsRef.current = null }
  }, [fileUrl])

  // Sync markers to regions
  useEffect(() => {
    const regions = regionsRef.current
    if (!regions) return

    // Clear existing
    regions.clearRegions()

    // Add marker lines
    markers.forEach((m) => {
      regions.addRegion({
        start: m.time,
        end: m.time + 0.01,
        color: 'rgba(251, 191, 36, 0.8)',
        drag: true,
        resize: false,
        id: m.id
      })
    })

    // Listen for drag updates
    const handleUpdate = (region: any) => {
      setMarkers(prev => prev.map(m =>
        m.id === region.id ? { ...m, time: region.start } : m
      ).sort((a, b) => a.time - b.time))
    }

    regions.on('region-updated', handleUpdate)
    return () => { regions.un('region-updated', handleUpdate) }
  }, [markers])

  const addMarker = useCallback((time: number, label?: string) => {
    const id = `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const newLabel = label || `Track ${markersRef.current.length + 2}`
    setMarkers(prev => [...prev, { id, time, label: newLabel }].sort((a, b) => a.time - b.time))
  }, [])

  const removeMarker = useCallback((id: string) => {
    setMarkers(prev => prev.filter(m => m.id !== id))
  }, [])

  const updateLabel = useCallback((id: string, label: string) => {
    setMarkers(prev => prev.map(m => m.id === id ? { ...m, label } : m))
  }, [])

  // Preview: play 3 seconds around marker
  const previewMarker = useCallback((time: number) => {
    const ws = wsRef.current
    if (!ws) return
    const start = Math.max(0, time - 2)
    ws.setTime(start)
    ws.play()
    setTimeout(() => { if (ws.isPlaying()) ws.pause() }, 5000)
  }, [])

  // Parse timestamp text
  const parseTimestamps = useCallback(() => {
    const lines = timestampText.split('\n').filter(l => l.trim())
    const parsed: { time: number; label: string }[] = []

    for (const line of lines) {
      // Match patterns: "0:00 title", "00:00 title", "1:23:45 title", "[0:00] title"
      const match = line.match(/\[?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*\]?\s*[-–—.]?\s*(.*)/)
      if (match) {
        const h = match[3] ? parseInt(match[1]) : 0
        const m = match[3] ? parseInt(match[2]) : parseInt(match[1])
        const s = match[3] ? parseInt(match[3]) : parseInt(match[2])
        const time = h * 3600 + m * 60 + s
        const label = match[4]?.trim() || `Track ${parsed.length + 1}`
        parsed.push({ time, label })
      }
    }

    if (parsed.length === 0) return

    // First entry at 0:00 is the start of Track 1, not a split point
    // Split points are everything after the first
    const newMarkers: Marker[] = []
    for (let i = 1; i < parsed.length; i++) {
      newMarkers.push({
        id: `m_${Date.now()}_${i}`,
        time: parsed[i].time,
        label: parsed[i].label
      })
    }

    // Update first track label context (stored in markers[0] area)
    setMarkers(newMarkers.sort((a, b) => a.time - b.time))
  }, [timestampText])

  // Auto detect (calls existing Python split logic for silence detection)
  const handleAutoDetect = async () => {
    // Use simple client-side energy analysis for speed
    setAutoDetecting(true)
    const ws = wsRef.current
    if (!ws) { setAutoDetecting(false); return }

    // Get audio buffer
    const decoded = ws.getDecodedData()
    if (!decoded) { setAutoDetecting(false); return }

    const channel = decoded.getChannelData(0)
    const sr = decoded.sampleRate
    const frameSec = 0.05
    const frameLen = Math.floor(frameSec * sr)
    const nFrames = Math.floor(channel.length / frameLen)

    // Compute RMS per frame
    const rms = new Float32Array(nFrames)
    for (let i = 0; i < nFrames; i++) {
      let sum = 0
      for (let j = 0; j < frameLen; j++) {
        const v = channel[i * frameLen + j]
        sum += v * v
      }
      rms[i] = Math.sqrt(sum / frameLen)
    }

    // Find threshold
    const sorted = Float32Array.from(rms).sort()
    const noiseFloor = sorted[Math.floor(sorted.length * 0.1)]
    const threshold = Math.max(noiseFloor * 5, 0.005)

    // Find silence gaps > 1s
    const minSilenceFrames = Math.floor(1.0 / frameSec)
    const silencePoints: number[] = []
    let i = 0
    while (i < nFrames) {
      if (rms[i] < threshold) {
        let j = i
        while (j < nFrames && rms[j] < threshold) j++
        if ((j - i) >= minSilenceFrames) {
          const center = ((i + j) / 2) * frameSec
          silencePoints.push(center)
        }
        i = j
      } else {
        i++
      }
    }

    // Create markers
    const newMarkers: Marker[] = silencePoints.map((t, idx) => ({
      id: `m_auto_${idx}`,
      time: t,
      label: `Track ${idx + 2}`
    }))

    setMarkers(newMarkers)
    setAutoDetecting(false)
  }

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  // Build split points for export (used by ProcessButton)
  useEffect(() => {
    // Store markers in global state for ProcessButton to access
    const points = markers.map(m => m.time)
    const labels = ['Track 01', ...markers.map(m => m.label)]
    useAppStore.setState({ splitMarkers: points, splitLabels: labels })
  }, [markers])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Waveform with markers */}
      <div style={{
        borderRadius: 14, overflow: 'hidden', padding: '16px 16px 12px',
        background: 'var(--bg-card)', border: '1px solid var(--border-subtle)'
      }}>
        <div ref={containerRef} style={{ marginBottom: 8 }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{fmtTime(currentTime)}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => wsRef.current?.playPause()} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30, borderRadius: '50%', border: 'none', cursor: 'pointer',
              background: isPlaying ? 'rgba(251,191,36,0.15)' : 'linear-gradient(135deg, #f59e0b, #d97706)',
              boxShadow: isPlaying ? 'none' : '0 2px 10px rgba(251,191,36,0.2)'
            }}>
              {isPlaying ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="#fbbf24"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="#fff"><polygon points="6,3 20,12 6,21" /></svg>
              )}
            </button>
          </div>
          <span style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{fmtTime(duration)}</span>
        </div>
        <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>
          더블클릭: 마커 추가 · 마커 드래그: 위치 조정
        </div>
      </div>

      {/* Input mode toggle */}
      <div style={{
        display: 'flex', borderRadius: 10, overflow: 'hidden',
        background: 'var(--bg-card)', border: '1px solid var(--border-subtle)'
      }}>
        {(['manual', 'auto'] as const).map((m) => (
          <button key={m} onClick={() => setInputMode(m)} style={{
            flex: 1, padding: '8px 0', border: 'none', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 11, fontWeight: inputMode === m ? 600 : 500,
            background: inputMode === m ? 'rgba(251,191,36,0.12)' : 'transparent',
            color: inputMode === m ? 'var(--amber)' : 'var(--text-muted)',
            borderBottom: inputMode === m ? '2px solid var(--amber)' : '2px solid transparent'
          }}>
            {m === 'manual' ? '타임스탬프 입력' : '자동 감지'}
          </button>
        ))}
      </div>

      {/* Timestamp input */}
      {inputMode === 'manual' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            value={timestampText}
            onChange={(e) => setTimestampText(e.target.value)}
            placeholder={"0:00 첫 번째 곡\n3:52 두 번째 곡\n7:15 세 번째 곡\n...\n\n타임스탬프를 붙여넣으세요"}
            style={{
              width: '100%', height: 120, resize: 'vertical',
              borderRadius: 10, padding: '10px 14px', border: '1px solid var(--border-subtle)',
              background: 'var(--bg-card)', color: 'var(--text-primary)',
              fontFamily: "'Inter', monospace", fontSize: 12, lineHeight: 1.6,
              outline: 'none'
            }}
          />
          <button onClick={parseTimestamps} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            width: '100%', padding: '8px 0', borderRadius: 8,
            border: '1px solid var(--amber)', background: 'rgba(251,191,36,0.08)',
            cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: 'var(--amber)'
          }}>
            타임스탬프 적용 ({timestampText.split('\n').filter(l => l.trim()).length}줄)
          </button>
        </div>
      )}

      {/* Auto detect */}
      {inputMode === 'auto' && (
        <button onClick={handleAutoDetect} disabled={autoDetecting} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          width: '100%', padding: '10px 0', borderRadius: 8,
          border: '1px solid var(--amber)', background: 'rgba(251,191,36,0.08)',
          cursor: autoDetecting ? 'not-allowed' : 'pointer',
          fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: 'var(--amber)',
          opacity: autoDetecting ? 0.5 : 1
        }}>
          {autoDetecting ? '분석 중...' : '무음 구간 자동 감지'}
        </button>
      )}

      {/* Marker list */}
      {markers.length > 0 && (
        <div style={{
          borderRadius: 12, overflow: 'hidden',
          background: 'var(--bg-card)', border: '1px solid var(--border-subtle)'
        }}>
          <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>
              분할 지점 ({markers.length}개 → {markers.length + 1}트랙)
            </span>
            <button onClick={() => setMarkers([])} style={{
              padding: '2px 8px', borderRadius: 4, border: 'none', cursor: 'pointer',
              fontSize: 10, fontWeight: 500, background: 'var(--bg-elevated)', color: 'var(--text-muted)', fontFamily: 'inherit'
            }}>전체 삭제</button>
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {markers.map((m) => (
              <div key={m.id} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px',
                borderBottom: '1px solid var(--border-subtle)'
              }}>
                <span style={{ fontSize: 11, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--amber)', minWidth: 40 }}>
                  {fmtTime(m.time)}
                </span>
                <input
                  value={m.label}
                  onChange={(e) => updateLabel(m.id, e.target.value)}
                  style={{
                    flex: 1, padding: '3px 8px', borderRadius: 4, border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-elevated)', color: 'var(--text-primary)',
                    fontSize: 11, fontFamily: 'inherit', outline: 'none'
                  }}
                />
                <button onClick={() => previewMarker(m.time)} title="미리듣기" style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 24, height: 24, borderRadius: 5, border: 'none', cursor: 'pointer',
                  background: 'var(--bg-elevated)', color: 'var(--text-muted)'
                }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21" /></svg>
                </button>
                <button onClick={() => removeMarker(m.id)} title="삭제" style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 24, height: 24, borderRadius: 5, border: 'none', cursor: 'pointer',
                  background: 'var(--bg-elevated)', color: 'var(--rose)'
                }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
