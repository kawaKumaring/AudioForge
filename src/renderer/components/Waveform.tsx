import { useEffect, useRef, useState, type CSSProperties } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js'
import { useAppStore } from '@/stores/app.store'
import { detectSilence, estimateProcessedDuration, type SilenceAnalysis } from '@/lib/silenceDetect'

const MODE_WAVE_COLORS: Record<string, { wave: string; progress: string; cursor: string; btn: string; btnGlow: string }> = {
  music:        { wave: 'rgba(139,92,246,0.25)', progress: 'rgba(139,92,246,0.7)', cursor: '#a78bfa', btn: 'linear-gradient(135deg,#8b5cf6,#7c3aed)', btnGlow: 'rgba(139,92,246,0.2)' },
  conversation: { wave: 'rgba(34,211,238,0.25)', progress: 'rgba(34,211,238,0.7)', cursor: '#22d3ee', btn: 'linear-gradient(135deg,#06b6d4,#0891b2)', btnGlow: 'rgba(34,211,238,0.2)' },
  transcribe:   { wave: 'rgba(52,211,153,0.25)', progress: 'rgba(52,211,153,0.7)', cursor: '#34d399', btn: 'linear-gradient(135deg,#10b981,#059669)', btnGlow: 'rgba(52,211,153,0.2)' },
  split:        { wave: 'rgba(251,191,36,0.25)', progress: 'rgba(251,191,36,0.7)', cursor: '#fbbf24', btn: 'linear-gradient(135deg,#f59e0b,#d97706)', btnGlow: 'rgba(251,191,36,0.2)' },
  tts:          { wave: 'rgba(251,113,133,0.25)', progress: 'rgba(251,113,133,0.7)', cursor: '#fb7185', btn: 'linear-gradient(135deg,#f43f5e,#e11d48)', btnGlow: 'rgba(251,113,133,0.2)' },
}

const DEFAULT_COLORS = MODE_WAVE_COLORS.music

// #rrggbb → rgba(r,g,b,a) (무음 오버레이용 저알파)
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

export default function Waveform() {
  const { fileUrl, mode, silenceGap, silencePreview, setSilencePreview } = useAppStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState('0:00')
  const [duration, setDuration] = useState('0:00')
  const [decoded, setDecoded] = useState(false)
  const [analysis, setAnalysis] = useState<SilenceAnalysis | null>(null)
  const [computing, setComputing] = useState(false)
  const [selIdx, setSelIdx] = useState(0)

  const colors = MODE_WAVE_COLORS[mode] || DEFAULT_COLORS
  // 무음 제거를 지원하는 모드에서만 미리보기 진입점 노출
  const canPreview = mode === 'music' || mode === 'conversation'

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  useEffect(() => {
    if (!containerRef.current || !fileUrl) return
    wsRef.current?.destroy()
    setDecoded(false)
    setAnalysis(null)
    setSelIdx(0)

    const c = MODE_WAVE_COLORS[useAppStore.getState().mode] || DEFAULT_COLORS
    const regions = RegionsPlugin.create()
    regionsRef.current = regions
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: c.wave,
      progressColor: c.progress,
      cursorColor: c.cursor,
      cursorWidth: 2, barWidth: 2, barGap: 2, barRadius: 4,
      height: 56, normalize: true, backend: 'WebAudio',
      plugins: [regions]
    })

    ws.on('play', () => setIsPlaying(true))
    ws.on('pause', () => setIsPlaying(false))
    ws.on('timeupdate', (t) => setCurrentTime(formatTime(t)))
    ws.on('decode', (d) => { setDuration(formatTime(d)); setDecoded(true) })
    ws.load(fileUrl)
    wsRef.current = ws

    return () => { ws.destroy(); wsRef.current = null; regionsRef.current = null; setIsPlaying(false) }
  }, [fileUrl, mode])

  // 미리보기 켜지고 디코드 완료 시 감지 계산(1회, 지연 실행으로 클릭 블로킹 방지 — 설계 §5 R5)
  useEffect(() => {
    if (!silencePreview || !canPreview || !decoded || analysis) return
    const ws = wsRef.current
    if (!ws) return
    setComputing(true)
    const t = setTimeout(() => {
      try {
        const buf = ws.getDecodedData()
        if (buf) {
          const a = detectSilence(buf.getChannelData(0), buf.sampleRate)
          setAnalysis(a)
          setSelIdx(0)
        }
      } finally {
        setComputing(false)
      }
    }, 0)
    return () => clearTimeout(t)
  }, [silencePreview, canPreview, decoded, analysis])

  // 오버레이 그리기: 감지 결과 → wavesurfer regions (모드 액센트 저알파, 비인터랙티브)
  useEffect(() => {
    const regions = regionsRef.current
    if (!regions) return
    regions.clearRegions()
    if (!silencePreview || !canPreview || !analysis) return
    const fill = hexToRgba(colors.cursor, 0.14)
    for (const r of analysis.regions) {
      regions.addRegion({ start: r.start, end: r.end, color: fill, drag: false, resize: false })
    }
  }, [analysis, silencePreview, canPreview, colors.cursor])

  if (!fileUrl) return null

  const regionCount = analysis?.regions.length ?? 0
  const afterDur = analysis ? estimateProcessedDuration(analysis, silenceGap) : 0
  const saved = analysis ? Math.max(0, analysis.totalDur - afterDur) : 0

  // 선택 무음 경계 청취 (전환을 걸쳐 재생 — 설계 §10 R1)
  const playBoundary = (which: 'start' | 'end') => {
    const ws = wsRef.current
    if (!ws || !analysis || !analysis.regions[selIdx]) return
    const r = analysis.regions[selIdx]
    const dur = ws.getDuration()
    const [s, e] = which === 'start'
      ? [Math.max(0, r.start - 0.3), Math.min(dur, r.start + 0.5)]
      : [Math.max(0, r.end - 0.5), Math.min(dur, r.end + 0.3)]
    ws.play(s, e)
  }

  const step = (delta: number) => {
    if (regionCount === 0) return
    const next = (selIdx + delta + regionCount) % regionCount
    setSelIdx(next)
    const r = analysis!.regions[next]
    wsRef.current?.setTime(Math.max(0, r.start - 0.3))
  }

  const btnMini = (accent: boolean): CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 3, padding: '2px 8px', borderRadius: 6,
    border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 10, fontWeight: 600,
    background: accent ? hexToRgba(colors.cursor, 0.18) : 'var(--bg-elevated)',
    color: accent ? colors.cursor : 'var(--text-muted)', whiteSpace: 'nowrap'
  })

  return (
    <div style={{ padding: '0 16px 12px' }}>
      <div ref={containerRef} style={{ marginBottom: 8 }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {/* 왼쪽: 시간 + (Layer 1) 무음 미리보기 ghost 토글 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 10, fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{currentTime}</span>
          {canPreview && (
            <button onClick={() => setSilencePreview(!silencePreview)}
              title="제거될 무음 구간을 파형에 표시하고 경계를 들어봅니다"
              style={{
                display: 'flex', alignItems: 'center', gap: 3, padding: '2px 7px', borderRadius: 6,
                border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 10, fontWeight: 600,
                background: silencePreview ? hexToRgba(colors.cursor, 0.18) : 'transparent',
                color: silencePreview ? colors.cursor : 'var(--text-muted)',
                opacity: silencePreview ? 1 : 0.6, transition: 'all 0.15s'
              }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" />
              </svg>
              무음
            </button>
          )}
        </div>
        {/* 가운데: 재생 */}
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

      {/* Layer 2: 미리보기 켤 때만 펼쳐지는 얇은 스트립 */}
      {canPreview && silencePreview && (
        <div style={{
          marginTop: 8, padding: '8px 10px', borderRadius: 8,
          background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, fontSize: 10
        }}>
          {computing ? (
            <span style={{ color: 'var(--text-muted)' }}>무음 감지 중…</span>
          ) : regionCount === 0 ? (
            <span style={{ color: 'var(--text-muted)' }}>감지된 무음 없음</span>
          ) : (
            <>
              <span style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                무음 <b style={{ color: colors.cursor }}>{regionCount}</b>곳
              </span>
              <span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {formatTime(analysis!.totalDur)} → {formatTime(afterDur)} <span style={{ color: colors.cursor }}>(−{formatTime(saved)})</span>
              </span>
              {/* 스테퍼 + 경계 청취 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
                <button onClick={() => step(-1)} title="이전 무음" style={btnMini(false)}>◀</button>
                <span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'center' }}>{selIdx + 1}/{regionCount}</span>
                <button onClick={() => step(1)} title="다음 무음" style={btnMini(false)}>▶</button>
                <button onClick={() => playBoundary('start')} title="무음 시작 경계 듣기(말→무음)" style={btnMini(true)}>▶ 시작</button>
                <button onClick={() => playBoundary('end')} title="무음 끝 경계 듣기(무음→말)" style={btnMini(true)}>▶ 끝</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
