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
}
const DEFAULT_STYLE = { color: '#a78bfa', glow: 'rgba(167,139,250,0.15)' }

function TrackItem({ track, index }: { track: { name: string; label: string; path: string }; index: number }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const { playingTrack, setPlayingTrack, outputDir } = useAppStore()
  const isPlaying = playingTrack === track.name
  const st = TRACK_STYLES[track.name] || DEFAULT_STYLE
  const [transcript, setTranscript] = useState<string | null>(null)
  const [showText, setShowText] = useState(false)

  const getFileUrl = useCallback(async () => await window.api.audio.getFileUrl(track.path), [track.path])

  // Load transcript if exists
  useEffect(() => {
    if (!outputDir) return
    const txtPath = track.path.replace('.wav', '.txt')
    window.api.app.readTextFile(txtPath).then((text: string | null) => {
      if (text) setTranscript(text)
    })
  }, [track.path, outputDir])

  useEffect(() => {
    if (!isPlaying && audioRef.current) { audioRef.current.pause(); audioRef.current.currentTime = 0 }
  }, [isPlaying])

  const handlePlay = async () => {
    if (isPlaying) { setPlayingTrack(null); return }
    if (!audioRef.current) {
      const url = await getFileUrl()
      audioRef.current = new Audio(url)
      audioRef.current.onended = () => setPlayingTrack(null)
    }
    setPlayingTrack(track.name)
    audioRef.current.play()
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.08 }}
      style={{ display: 'flex', flexDirection: 'column', borderRadius: 12, overflow: 'hidden',
        background: isPlaying ? st.glow : 'var(--bg-card)',
        border: `1px solid ${isPlaying ? st.color + '40' : 'var(--border-subtle)'}` }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 16px' }}>
        <div style={{ position: 'relative' }}>
          <div style={{ width: 12, height: 12, borderRadius: '50%', background: st.color }} />
          {isPlaying && (
            <motion.div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: st.color }}
              animate={{ scale: [1, 2], opacity: [0.6, 0] }} transition={{ duration: 1, repeat: Infinity }} />
          )}
        </div>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: isPlaying ? st.color : 'var(--text-primary)' }}>
          {track.label}
        </span>
        {transcript && (
          <button onClick={() => setShowText(!showText)} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer',
            background: showText ? 'var(--cyan-glow)' : 'var(--bg-elevated)',
            color: showText ? 'var(--cyan)' : 'var(--text-muted)'
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </button>
        )}
        <button onClick={handlePlay} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer',
          background: isPlaying ? st.color : 'var(--bg-elevated)',
          color: isPlaying ? '#fff' : 'var(--text-muted)',
          boxShadow: isPlaying ? `0 2px 12px ${st.glow}` : 'none'
        }}>
          {isPlaying ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <polygon points="7,3 21,12 7,21" />
            </svg>
          )}
        </button>
      </div>
      {/* Transcript text */}
      {showText && transcript && (
        <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <div style={{
            padding: '12px 16px', fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)',
            maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap'
          }}>
            {transcript}
          </div>
          <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={() => window.api.utils.copyToClipboard(transcript)} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px',
              borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 500,
              background: 'var(--bg-elevated)', color: 'var(--text-muted)', fontFamily: 'inherit'
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              복사
            </button>
          </div>
        </div>
      )}
    </motion.div>
  )
}

function KaraokeButton({ tracks }: { tracks: { name: string; path: string }[] }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)

  // Only show for music separation results that have vocals track
  const hasVocals = tracks.some(t => t.name === 'vocals')
  const instrumentals = tracks.filter(t => t.name !== 'vocals')
  if (!hasVocals || instrumentals.length === 0) return null

  const handleKaraoke = async () => {
    if (playing) {
      audioRef.current?.pause()
      setPlaying(false)
      return
    }
    // Play the "other" track as a simple karaoke (instrumental without vocals)
    // Ideally we'd mix drums+bass+other, but for now play "other" which is the main instrumental
    const otherTrack = tracks.find(t => t.name === 'other') || instrumentals[0]
    if (!audioRef.current) {
      const url = await window.api.audio.getFileUrl(otherTrack.path)
      audioRef.current = new Audio(url)
      audioRef.current.onended = () => setPlaying(false)
    }
    audioRef.current.play()
    setPlaying(true)
  }

  return (
    <button onClick={handleKaraoke} style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px',
      borderRadius: 10, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
      fontSize: 12, fontWeight: 600,
      background: playing ? 'var(--amber)' : 'linear-gradient(135deg, #f59e0b, #d97706)',
      color: playing ? '#000' : '#fff',
      boxShadow: '0 2px 12px rgba(245,158,11,0.2)'
    }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
      </svg>
      {playing ? '노래방 정지' : '노래방 모드'}
    </button>
  )
}

export default function TrackList() {
  const { tracks, status, outputDir, error, mode } = useAppStore()

  if (error) {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        style={{ display: 'flex', alignItems: 'flex-start', gap: 12, borderRadius: 16, padding: 16, background: 'var(--rose-glow)', border: '1px solid rgba(251,113,133,0.25)' }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--rose)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
          <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
        </svg>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--rose)' }}>{error}</span>
      </motion.div>
    )
  }

  if (status !== 'done' || tracks.length === 0) return null

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, background: 'var(--accent-glow)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>분리 완료</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{tracks.length}트랙</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {mode === 'music' && <KaraokeButton tracks={tracks} />}
          <button onClick={() => outputDir && window.api.app.openFolder(outputDir)} className="btn btn-ghost" style={{ fontSize: 12 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            폴더
          </button>
          <button onClick={() => window.api.audio.exportTracks(tracks.map(t => t.path))} className="btn btn-primary" style={{ fontSize: 12 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            내보내기
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <AnimatePresence>
          {tracks.map((track, i) => <TrackItem key={track.name} track={track} index={i} />)}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}
