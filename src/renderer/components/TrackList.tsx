import { useEffect, useRef, useCallback, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import WaveSurfer from 'wavesurfer.js'
import { useAppStore } from '@/stores/app.store'
import { openTtsAdvanced } from '@/lib/ttsAdvancedOpen'

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${alpha})`
}
function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// 결과 트랙용 파형 플레이어 (파형 + 시간 + 볼륨 + 드래그 이동). 재생 시에만 지연 생성.
function TrackPlayer({ path, color, paused, onClose }: { path: string; color: string; paused: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const readyRef = useRef(false)
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const [cur, setCur] = useState('0:00')
  const [dur, setDur] = useState('0:00')
  const [volume, setVolume] = useState(1)

  useEffect(() => {
    let cancelled = false
    let ws: WaveSurfer | null = null
    ;(async () => {
      const url = await window.api.audio.getFileUrl(path)
      if (cancelled || !ref.current) return
      ws = WaveSurfer.create({
        container: ref.current, waveColor: hexToRgba(color, 0.3), progressColor: color,
        cursorColor: color, cursorWidth: 2, barWidth: 2, barGap: 2, barRadius: 4,
        height: 40, normalize: true, backend: 'WebAudio', dragToSeek: true
      })
      ws.on('timeupdate', (t) => setCur(fmtTime(t)))
      ws.on('decode', (d) => setDur(fmtTime(d)))
      ws.on('ready', () => { readyRef.current = true; if (ws && !pausedRef.current) ws.play() })
      ws.on('finish', () => onClose())
      ws.load(url)
      wsRef.current = ws
    })()
    return () => {
      cancelled = true
      const w = ws || wsRef.current
      if (w) { try { w.pause() } catch { /* noop */ } try { w.destroy() } catch { /* noop */ } }
      wsRef.current = null
      readyRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  useEffect(() => { wsRef.current?.setVolume(volume) }, [volume])

  // 재생/일시정지 제어는 트랙 행의 버튼(원래 위치)이 담당 — paused prop을 준비된 뒤에만 반영
  useEffect(() => {
    const ws = wsRef.current
    if (!ws || !readyRef.current) return
    if (paused) ws.pause(); else ws.play()
  }, [paused])

  return (
    <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border-subtle)' }}>
      <div ref={ref} style={{ marginBottom: 6 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{cur} / {dur}</span>
        <div title="재생 볼륨 (듣기 전용 · 원본 파일에는 영향 없음)" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            {volume < 0.01
              ? <><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></>
              : <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />}
          </svg>
          <input type="range" min="0" max="1" step="0.05" value={volume}
            aria-label="재생 볼륨 (듣기 전용, 원본에 영향 없음)"
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            style={{ width: 56, accentColor: color, cursor: 'pointer', height: 4 }} />
        </div>
        <button onClick={onClose} title="재생 닫기" aria-label="재생 닫기" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28, borderRadius: 6, border: 'none', cursor: 'pointer',
          background: 'var(--bg-elevated)', color: 'var(--text-secondary)', flexShrink: 0
        }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  )
}

const TRACK_STYLES: Record<string, { color: string; glow: string }> = {
  vocals:      { color: '#a78bfa', glow: 'rgba(167,139,250,0.15)' },
  instrumental:{ color: '#60a5fa', glow: 'rgba(96,165,250,0.12)' },
  drums:     { color: '#fbbf24', glow: 'rgba(251,191,36,0.12)' },
  bass:      { color: '#34d399', glow: 'rgba(52,211,153,0.12)' },
  other:     { color: '#60a5fa', glow: 'rgba(96,165,250,0.12)' },
  // 화자 트랙: 화자 수 선택은 2~5명(Options.tsx)이므로 a~e 를 모두 채운다.
  // c/d/e 가 비어 있으면 DEFAULT_STYLE(= speaker_a 와 같은 보라)로 떨어져
  // 3명 이상일 때 트랙을 색으로 구분할 수 없었다. 결정적 매핑(해시·난수 없음),
  // 색상은 기존 팔레트 규약(400 계열 hex + 같은 색 rgba glow)을 따른다.
  speaker_a: { color: '#a78bfa', glow: 'rgba(167,139,250,0.15)' },  // violet
  speaker_b: { color: '#22d3ee', glow: 'rgba(34,211,238,0.15)' },   // cyan
  speaker_c: { color: '#fbbf24', glow: 'rgba(251,191,36,0.15)' },   // amber
  speaker_d: { color: '#4ade80', glow: 'rgba(74,222,128,0.15)' },   // green
  speaker_e: { color: '#f472b6', glow: 'rgba(244,114,182,0.15)' },  // pink
  transcript:{ color: '#34d399', glow: 'rgba(52,211,153,0.12)' },
  translation:{ color: '#22d3ee', glow: 'rgba(34,211,238,0.15)' },
}
const DEFAULT_STYLE = { color: '#a78bfa', glow: 'rgba(167,139,250,0.15)' }

const actionBtnStyle = (active: boolean, color: string): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px',
  borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600,
  fontFamily: 'inherit', transition: 'all 0.15s',
  background: active ? `${color}20` : 'var(--bg-elevated)',
  color: active ? color : 'var(--text-secondary)'
})

function TrackItem({ track, index }: { track: { name: string; label: string; path: string }; index: number }) {
  const { playingTrack, setPlayingTrack, outputDir, mode, translateModel } = useAppStore()
  const isPlaying = playingTrack === track.name
  const st = TRACK_STYLES[track.name] || DEFAULT_STYLE
  const [transcript, setTranscript] = useState<string | null>(null)
  const [translation, setTranslation] = useState<string | null>(null)
  const [showText, setShowText] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [paused, setPaused] = useState(false)  // 재생 중 일시정지 여부(행 버튼이 제어)

  const isAudioTrack = track.path.endsWith('.wav') || track.path.endsWith('.mp3') || track.path.endsWith('.flac')

  // Load existing transcript/translation
  useEffect(() => {
    if (!outputDir) return
    const base = track.path.replace(/\.(wav|mp3|flac)$/, '')
    window.api.app.readTextFile(base + '.txt').then((t: string | null) => { if (t) setTranscript(t) })
    window.api.app.readTextFile(base + '_korean.txt').then((t: string | null) => { if (t) setTranslation(t) })
  }, [track.path, outputDir])

  // 재생 버튼(행 오른쪽, 원래 위치): 접힘→시작, 재생 중→일시정지/재개(아이콘만 바뀜). 한 번에 한 트랙만.
  const handlePlay = () => {
    if (!isAudioTrack) return
    if (!isPlaying) { setPaused(false); setPlayingTrack(track.name) }
    else setPaused((p) => !p)
  }

  const handleTrackProcess = async (transcribe: boolean, translate: boolean) => {
    if (!outputDir || !isAudioTrack || processing) return
    setProcessing(true)

    const cleanup = () => { offResult(); offError() }

    const offResult = window.api.audio.onTrackResult((data: any) => {
      const t = data?.tracks?.[0]
      if (!t) return
      // Match by track name to avoid cross-track confusion
      const resultName = t.name || ''
      const myName = track.path.replace(/\\/g, '/').split('/').pop()?.replace(/\.\w+$/, '') || ''
      if (resultName !== myName && !resultName.includes(myName)) return
      if (t.text) setTranscript(t.text)
      if (t.translated_text) setTranslation(t.translated_text)
      setProcessing(false)
      cleanup()
    })

    // Python 에러 시 "처리 중..." 고착 방지 — 실패해도 버튼 복구
    const offError = window.api.audio.onTrackError((data: any) => {
      if (data?.trackPath && data.trackPath !== track.path) return
      setProcessing(false)
      cleanup()
    })

    try {
      await window.api.audio.processTrack(track.path, outputDir, { transcribe, translate, srt: false, translateModel })
    } catch {
      setProcessing(false)
      cleanup()
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
            {translation && !processing && (
              <button onClick={() => handleTrackProcess(false, true)} style={actionBtnStyle(false, 'var(--text-muted)')}
                title="현재 번역 설정(600M/1.3B/LLM)으로 다시 번역합니다">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
                다시 번역
              </button>
            )}
            {processing && (
              <span role="status" aria-live="polite" style={{ fontSize: 11, color: 'var(--accent-light)', fontWeight: 500, padding: '4px 8px' }}>처리 중...</span>
            )}
          </div>
        )}

        {/* Text toggle */}
        {(transcript || translation) && (
          <button onClick={() => setShowText(!showText)} style={actionBtnStyle(showText, 'var(--cyan)')}
            aria-expanded={showText} aria-controls={`track-text-${track.name}`}
            aria-label={showText ? `${track.label} 텍스트 접기` : `${track.label} 텍스트 펼치기`}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <line x1="17" y1="10" x2="3" y2="10" /><line x1="21" y1="6" x2="3" y2="6" /><line x1="21" y1="14" x2="3" y2="14" /><line x1="17" y1="18" x2="3" y2="18" />
            </svg>
            텍스트
          </button>
        )}

        {/* 재생 버튼 — 항상 이 자리(원래 위치). 아이콘만 ▶↔❚❚로 바뀜. 정지/닫기는 플레이어의 ✕. */}
        {isAudioTrack && (
          <button onClick={handlePlay}
            aria-label={!isPlaying ? `${track.label} 재생` : paused ? `${track.label} 재생 재개` : `${track.label} 일시정지`}
            style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 32, height: 32, borderRadius: 7, border: 'none', cursor: 'pointer', flexShrink: 0,
            background: isPlaying ? st.color : 'var(--bg-elevated)',
            color: isPlaying ? '#fff' : 'var(--text-secondary)',
            boxShadow: isPlaying ? `0 2px 10px ${st.glow}` : 'none'
          }}>
            {(isPlaying && !paused)
              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
              : <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="7,3 21,12 7,21" /></svg>}
          </button>
        )}
      </div>

      {/* 재생 시 펼쳐지는 파형 플레이어 (파형 + 시간 + 볼륨 + 드래그 이동). 재생/일시정지는 행 버튼이 제어. */}
      {isPlaying && isAudioTrack && (
        <TrackPlayer path={track.path} color={st.color} paused={paused} onClose={() => setPlayingTrack(null)} />
      )}

      {/* Expandable text area */}
      {showText && (transcript || translation) && (
        <div id={`track-text-${track.name}`} style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {transcript && (
            <div style={{ padding: '10px 14px' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>원문</div>
              <div style={{ fontSize: 11, lineHeight: 1.7, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', maxHeight: 150, overflowY: 'auto' }}>
                {transcript}
              </div>
            </div>
          )}
          {translation && (
            <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border-subtle)', background: 'rgba(34,211,238,0.03)' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--cyan)', marginBottom: 4 }}>한국어 번역</div>
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

  // 언마운트 시 모든 오디오 정리 (L-11). 조기 return보다 위에 둬 훅 규칙 준수.
  useEffect(() => {
    return () => {
      audiosRef.current.forEach(a => { a.pause(); a.src = '' })
      audiosRef.current = []
    }
  }, [])

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
  const { tracks, status, outputDir, error, errorInfo, mode, bumpRetry, clearError } = useAppStore()

  if (error) {
    // 생성 상한 도달(GENERATION_LIMIT_EXCEEDED)은 유효 입력에서도 비결정적으로 발생 가능 → 전용 안내 + 명시 재시도.
    // 그 외 오류는 기존 일반 카드(메시지 + '다시 시도'=닫기). code는 main이 정제해 넘긴 구조화 값(전사·경로 없음).
    const isGenLimit = errorInfo?.code === 'GENERATION_LIMIT_EXCEEDED'
    const isCancelFailed = errorInfo?.code === 'CANCEL_FAILED'
    const scrollToTranscript = () => {
      clearError()
      // PHASE B: 참조 전사는 '고급 설정 > 음성' 안으로 들어갔다. 접혀 있으면 DOM 에 없으므로
      // 먼저 그 자리를 열어 달라고 요청한 뒤 스크롤한다(요청이 없으면 아무 일도 안 하는 막다른 길이 된다).
      openTtsAdvanced('referenceTranscript')
      // 열기 → 렌더 → 레이아웃까지 기다린 뒤 스크롤(두 프레임).
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.getElementById('tts-reference-transcript')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }))
    }
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        role="alert"
        style={{ display: 'flex', alignItems: 'flex-start', gap: 12, borderRadius: 14, padding: 14, background: 'var(--rose-glow)', border: '1px solid rgba(251,113,133,0.25)' }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--rose)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true">
          <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
        </svg>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {isGenLimit ? (
            <>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--rose)' }}>생성이 비정상적으로 길어 안전하게 중단됐습니다.</span>
              <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-secondary)' }}>참조 음성과 전사문이 일치하는지 확인하거나 다시 시도하세요.</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => bumpRetry()}
                  className="btn btn-ghost" style={{ fontSize: 11, padding: '6px 12px' }}>다시 시도</button>
                <button onClick={scrollToTranscript}
                  className="btn btn-ghost" style={{ fontSize: 11, padding: '6px 12px' }}>참조 전사 확인</button>
                <button onClick={() => clearError()}
                  className="btn btn-ghost" style={{ fontSize: 11, padding: '6px 12px' }}>닫기</button>
              </div>
            </>
          ) : isCancelFailed ? (
            <>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--rose)' }}>{error}</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {/* '다시 취소'는 실제 child가 살아 있을 때만(계약 5). 없으면 닫기만. */}
                {errorInfo?.childAlive && (
                  <button onClick={() => window.api.audio.cancel()}
                    className="btn btn-ghost" style={{ fontSize: 11, padding: '6px 12px' }}>다시 취소</button>
                )}
                <button onClick={() => clearError()}
                  className="btn btn-ghost" style={{ fontSize: 11, padding: '6px 12px' }}>닫기</button>
              </div>
            </>
          ) : (
            <>
              <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--rose)' }}>{error}</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => clearError()}
                  className="btn btn-ghost" style={{ fontSize: 11, padding: '6px 12px' }}>다시 시도</button>
              </div>
            </>
          )}
        </div>
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
