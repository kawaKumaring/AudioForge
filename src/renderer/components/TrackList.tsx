import { useEffect, useRef, useCallback, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAppStore } from '@/stores/app.store'

const TRACK_STYLES: Record<string, { color: string; glow: string }> = {
  vocals:    { color: '#a78bfa', glow: 'rgba(167,139,250,0.15)' },
  drums:     { color: '#fbbf24', glow: 'rgba(251,191,36,0.12)' },
  bass:      { color: '#34d399', glow: 'rgba(52,211,153,0.12)' },
  other:     { color: '#60a5fa', glow: 'rgba(96,165,250,0.12)' },
  speaker_a: { color: '#a78bfa', glow: 'rgba(167,139,250,0.15)' },
  speaker_b: { color: '#22d3ee', glow: 'rgba(34,211,238,0.15)' },
  transcript:{ color: '#34d399', glow: 'rgba(52,211,153,0.12)' },
  translation:{ color: '#22d3ee', glow: 'rgba(34,211,238,0.15)' },
}
const DEFAULT_STYLE = { color: '#a78bfa', glow: 'rgba(167,139,250,0.15)' }

const actionBtnStyle = (active: boolean, color: string): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px',
  borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 600,
  fontFamily: 'inherit', transition: 'all 0.15s',
  background: active ? `${color}20` : 'var(--bg-elevated)',
  color: active ? color : 'var(--text-muted)'
})

function TrackItem({ track, index }: { track: { name: string; label: string; path: string }; index: number }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const { playingTrack, setPlayingTrack, outputDir, mode } = useAppStore()
  const isPlaying = playingTrack === track.name
  const st = TRACK_STYLES[track.name] || DEFAULT_STYLE
  const [transcript, setTranscript] = useState<string | null>(null)
  const [translation, setTranslation] = useState<string | null>(null)
  const [showText, setShowText] = useState(false)
  const [processing, setProcessing] = useState(false)

  const isAudioTrack = track.path.endsWith('.wav') || track.path.endsWith('.mp3') || track.path.endsWith('.flac')

  // Load existing transcript/translation
  useEffect(() => {
    if (!outputDir) return
    const base = track.path.replace(/\.(wav|mp3|flac)$/, '')
    window.api.app.readTextFile(base + '.txt').then((t: string | null) => { if (t) setTranscript(t) })
    window.api.app.readTextFile(base + '_korean.txt').then((t: string | null) => { if (t) setTranslation(t) })
  }, [track.path, outputDir])

  useEffect(() => {
    if (!isPlaying && audioRef.current) { audioRef.current.pause(); audioRef.current.currentTime = 0 }
  }, [isPlaying])

  const handlePlay = async () => {
    if (!isAudioTrack) return
    if (isPlaying) { setPlayingTrack(null); return }
    if (!audioRef.current) {
      const url = await window.api.audio.getFileUrl(track.path)
      audioRef.current = new Audio(url)
      audioRef.current.onended = () => setPlayingTrack(null)
    }
    setPlayingTrack(track.name)
    audioRef.current.play()
  }

  const handleTrackProcess = async (transcribe: boolean, translate: boolean) => {
    if (!outputDir || !isAudioTrack || processing) return
    setProcessing(true)

    const off = window.api.audio.onTrackResult((data: any) => {
      const t = data?.tracks?.[0]
      if (!t) return
      // Match by track name to avoid cross-track confusion
      const resultName = t.name || ''
      const myName = track.path.replace(/\\/g, '/').split('/').pop()?.replace(/\.\w+$/, '') || ''
      if (resultName !== myName && !resultName.includes(myName)) return
      if (t.text) setTranscript(t.text)
      if (t.translated_text) setTranslation(t.translated_text)
      setProcessing(false)
      off()
    })

    try {
      await window.api.audio.processTrack(track.path, outputDir, { transcribe, translate, srt: false })
    } catch {
      setProcessing(false)
      off()
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.06 }}
      style={{
        display: 'flex', flexDirection: 'column', borderRadius: 12, overflow: 'hidden',
        background: isPlaying ? st.glow : 'var(--bg-card)',
        border: `1px solid ${isPlaying ? st.color + '40' : 'var(--border-subtle)'}`
      }}
    >
      {/* Main row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px' }}>
        {/* Color dot */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: st.color }} />
          {isPlaying && (
            <motion.div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: st.color }}
              animate={{ scale: [1, 2], opacity: [0.6, 0] }} transition={{ duration: 1, repeat: Infinity }} />
          )}
        </div>

        {/* Label */}
        <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: isPlaying ? st.color : 'var(--text-primary)' }}>
          {track.label}
        </span>

        {/* Action buttons for tracks (split/music mode) */}
        {isAudioTrack && (mode === 'split' || mode === 'music') && (
          <div style={{ display: 'flex', gap: 4 }}>
            {!transcript && !processing && (
              <button onClick={() => handleTrackProcess(true, false)} style={actionBtnStyle(false, 'var(--cyan)')}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /></svg>
                가사
              </button>
            )}
            {transcript && !translation && !processing && (
              <button onClick={() => handleTrackProcess(false, true)} style={actionBtnStyle(false, 'var(--emerald)')}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 8l6 6M4 14l6-6 2 3" /><path d="M2 5h12M7 2v6" /><path d="M12 22l5-10 5 10M14.5 19h5" /></svg>
                번역
              </button>
            )}
            {processing && (
              <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 500, padding: '4px 8px' }}>처리 중...</span>
            )}
          </div>
        )}

        {/* Text toggle */}
        {(transcript || translation) && (
          <button onClick={() => setShowText(!showText)} style={actionBtnStyle(showText, 'var(--cyan)')}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="17" y1="10" x2="3" y2="10" /><line x1="21" y1="6" x2="3" y2="6" /><line x1="21" y1="14" x2="3" y2="14" /><line x1="17" y1="18" x2="3" y2="18" />
            </svg>
            텍스트
          </button>
        )}

        {/* Play button */}
        {isAudioTrack && (
          <button onClick={handlePlay} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, borderRadius: 7, border: 'none', cursor: 'pointer', flexShrink: 0,
            background: isPlaying ? st.color : 'var(--bg-elevated)',
            color: isPlaying ? '#fff' : 'var(--text-muted)',
            boxShadow: isPlaying ? `0 2px 10px ${st.glow}` : 'none'
          }}>
            {isPlaying ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="7,3 21,12 7,21" /></svg>
            )}
          </button>
        )}
      </div>

      {/* Expandable text area */}
      {showText && (transcript || translation) && (
        <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {transcript && (
            <div style={{ padding: '10px 14px' }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>원문</div>
              <div style={{ fontSize: 11, lineHeight: 1.7, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', maxHeight: 150, overflowY: 'auto' }}>
                {transcript}
              </div>
            </div>
          )}
          {translation && (
            <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border-subtle)', background: 'rgba(34,211,238,0.03)' }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--cyan)', marginBottom: 4 }}>한국어 번역</div>
              <div style={{ fontSize: 11, lineHeight: 1.7, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', maxHeight: 150, overflowY: 'auto' }}>
                {translation}
              </div>
            </div>
          )}
          <div style={{ padding: '6px 14px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            {transcript && (
              <button onClick={() => window.api.utils.copyToClipboard(transcript)} style={actionBtnStyle(false, 'var(--text-muted)')}>
                복사 (원문)
              </button>
            )}
            {translation && (
              <button onClick={() => window.api.utils.copyToClipboard(translation)} style={actionBtnStyle(false, 'var(--cyan)')}>
                복사 (번역)
              </button>
            )}
          </div>
        </div>
      )}
    </motion.div>
  )
}

function KaraokeButton({ tracks }: { tracks: { name: string; path: string }[] }) {
  const audiosRef = useRef<HTMLAudioElement[]>([])
  const [playing, setPlaying] = useState(false)

  const hasVocals = tracks.some(t => t.name === 'vocals')
  const instrumentals = tracks.filter(t => t.name !== 'vocals')
  if (!hasVocals || instrumentals.length === 0) return null

  const handleKaraoke = async () => {
    if (playing) {
      audiosRef.current.forEach(a => a.pause())
      setPlaying(false)
      return
    }
    // Load all instrumental tracks for simultaneous playback
    if (audiosRef.current.length === 0) {
      for (const t of instrumentals) {
        const url = await window.api.audio.getFileUrl(t.path)
        const audio = new Audio(url)
        audiosRef.current.push(audio)
      }
      audiosRef.current[0].onended = () => {
        audiosRef.current.forEach(a => a.pause())
        setPlaying(false)
      }
    }
    // Sync play all tracks
    audiosRef.current.forEach(a => { a.currentTime = 0; a.play() })
    setPlaying(true)
  }

  return (
    <button onClick={handleKaraoke} style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px',
      borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
      fontSize: 11, fontWeight: 600,
      background: playing ? 'var(--amber)' : 'linear-gradient(135deg, #f59e0b, #d97706)',
      color: playing ? '#000' : '#fff'
    }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      </svg>
      {playing ? '정지' : '노래방'}
    </button>
  )
}

export default function TrackList() {
  const { tracks, status, outputDir, error, mode } = useAppStore()

  if (error) {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        style={{ display: 'flex', alignItems: 'flex-start', gap: 12, borderRadius: 14, padding: 14, background: 'var(--rose-glow)', border: '1px solid rgba(251,113,133,0.25)' }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--rose)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
          <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
        </svg>
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--rose)' }}>{error}</span>
      </motion.div>
    )
  }

  if (status !== 'done' || tracks.length === 0) return null

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>완료</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{tracks.length}트랙</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {mode === 'music' && <KaraokeButton tracks={tracks} />}
          <button onClick={() => outputDir && window.api.app.openFolder(outputDir)} className="btn btn-ghost" style={{ fontSize: 11, padding: '6px 12px' }}>폴더</button>
          <button onClick={() => window.api.audio.exportTracks(tracks.map(t => t.path))} className="btn btn-primary" style={{ fontSize: 11, padding: '6px 12px' }}>내보내기</button>
        </div>
      </div>

      {/* Tracks */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <AnimatePresence>
          {tracks.map((track, i) => <TrackItem key={track.name} track={track} index={i} />)}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}
