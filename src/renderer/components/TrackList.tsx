import { useEffect, useRef, useCallback, useState } from 'react'
import { speakerBlockNotice } from '../../shared/speakerReference'
import { sha256HexOfString } from '../../shared/referenceLibrary'
import { motion, AnimatePresence } from 'framer-motion'
import { useAppStore } from '@/stores/app.store'
import { openTtsAdvanced } from '@/lib/ttsAdvancedOpen'
import { createManagedAudio } from '@/lib/playbackVolume'
// 결과 재생기·색·단추 모양은 **공용 부품**이다(음악·대화가 같은 것을 쓴다).
import { ResultPlayer, actionBtnStyle, styleOf } from '@/components/ResultPlayer'
import { ResultToolbar, useResultExport } from '@/components/ResultActions'

const menuItem: React.CSSProperties = {
  padding: '5px 8px', borderRadius: 6, border: 'none', background: 'transparent',
  color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11,
  textAlign: 'left', whiteSpace: 'nowrap',
}

function TrackItem({ track, index, keep, onKeep, onKeepOnly }: {
  track: { name: string; label: string; path: string }
  index: number
  /** 저장 대상으로 골랐는가. 재생 중인 것과 **다른 표시**다. */
  keep: boolean
  onKeep: (name: string, next: boolean) => void
  /** 이것 **하나만** 저장 대상으로 — 개별 결과 저장에 쓴다. */
  onKeepOnly: (name: string) => void
}) {
  const { playingTrack, setPlayingTrack, outputDir, mode, translateModel, fileInfo,
    // ★고른 알아듣기 설정 — 트랙의 '가사' 도 같은 설정으로 돌아야 한다(2026-09-24 감사).
    whisperModel, whisperLang, asrSeparate } = useAppStore()
  const isPlaying = playingTrack === track.name
  const st = styleOf(track.name)
  const [transcript, setTranscript] = useState<string | null>(null)
  const [translation, setTranslation] = useState<string | null>(null)
  const [showText, setShowText] = useState(false)
  const [menu, setMenu] = useState(false)
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
      // ★고른 설정을 함께 보낸다 — 예전에는 빠져서 고른 모델·언어가 무시됐다(2026-09-24 감사).
      await window.api.audio.processTrack(track.path, outputDir,
        { transcribe, translate, srt: false, translateModel, whisperModel, whisperLang, asrSeparate })
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
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: isPlaying ? st.color : 'var(--text-primary)' }}>
          {track.label}
          {isPlaying && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 500, color: st.color }}>듣는 중</span>}
        </span>

        {/* ★저장 선택 — **재생 중인 것과 다른 표시**다(색 테두리 ≠ 저장 대상). */}
        {isAudioTrack && (
          <label data-testid="track-keep-label" title="저장할 결과로 고릅니다"
            style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, cursor: 'pointer', fontSize: 10, color: 'var(--text-muted)' }}>
            <input type="checkbox" data-testid="track-keep" checked={keep}
              onChange={(e) => onKeep(track.name, e.target.checked)}
              aria-label={`${track.label} 저장 선택`}
              style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} />
            저장
          </label>
        )}

        {processing && (
          <span role="status" aria-live="polite" style={{ fontSize: 11, color: 'var(--accent-light)', fontWeight: 500, padding: '4px 8px' }}>처리 중...</span>
        )}

        {/* 글이 나온 결과는 바로 펼쳐 볼 수 있다(자주 쓰는 조작은 밖에). */}
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

        {/* ★세부 조작은 **이 결과의 메뉴**로 모은다 — 줄마다 길게 늘어놓지 않는다. */}
        {isAudioTrack && (mode === 'split' || mode === 'music') && !processing && (
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button data-testid="track-menu" onClick={() => setMenu((v) => !v)}
              aria-expanded={menu} aria-haspopup="menu" aria-label={`${track.label} 세부 작업`}
              title="이 결과로 할 수 있는 일" style={actionBtnStyle(menu, 'var(--text-secondary)')}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
              </svg>
            </button>
            {menu && (
              <div role="menu" data-testid="track-menu-list" style={{
                position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 20,
                display: 'flex', flexDirection: 'column', gap: 2, padding: 4, borderRadius: 8,
                background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
                boxShadow: '0 6px 18px rgba(0,0,0,0.35)', minWidth: 132,
              }}>
                {!transcript && (
                  <button role="menuitem" data-testid="track-menu-transcribe"
                    onClick={() => { setMenu(false); void handleTrackProcess(true, false) }}
                    title="이 결과의 말을 글로 옮깁니다" style={menuItem}>가사 뽑기</button>
                )}
                {transcript && (
                  <button role="menuitem" data-testid="track-menu-translate"
                    onClick={() => { setMenu(false); void handleTrackProcess(false, true) }}
                    title={translation ? '지금 번역 설정으로 다시 번역합니다' : '뽑은 글을 한국어로 옮깁니다'}
                    style={menuItem}>{translation ? '다시 번역' : '번역'}</button>
                )}
                <button role="menuitem" data-testid="track-menu-only"
                  onClick={() => { setMenu(false); onKeepOnly(track.name) }}
                  title="이 결과만 저장 대상으로 고릅니다" style={menuItem}>이것만 저장 선택</button>
              </div>
            )}
          </div>
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
      {/* 분리 결과일 때만 원본과 견줄 수 있다 — 텍스트 트랙에는 비교할 소리가 없다. */}
      {isPlaying && isAudioTrack && (
        <ResultPlayer path={track.path} color={st.color} paused={paused} onClose={() => setPlayingTrack(null)}
          originalPath={(mode === 'music' || mode === 'conversation') && track.name !== 'transcript'
            && track.name !== 'translation' ? (fileInfo?.path || null) : null}
          originalLabel={fileInfo?.name} />
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
        const audio = createManagedAudio(url)   // 음량은 단일 소유자가 건다
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
  const { tracks, status, outputDir, error, errorInfo, mode, bumpRetry, clearError, ttsSpeakerRefState, ttsSpeakerLabels } = useAppStore()
  // ★내보내기 결과를 버리지 않는다(2026-09-24 2차 감사).
  //   예전에는 약속을 통째로 버려 거절이 콘솔 한 줄로 사라졌고,
  //   **성공과 실패가 화면상 완전히 같았다.**
  const { note: exportNote, setNote: setExportNote, run: runExport } = useResultExport()
  /**
   * 저장 대상 — **결과가 바뀌면 다시 전부 고른 상태**로 시작한다.
   *
   * 모델마다 나오는 결과가 다르므로(보컬·반주 둘일 수도, 넷일 수도 있다)
   * 이름 목록을 열쇠로 삼아 새 결과인지 본다.
   */
  const trackKey = tracks.map((t) => t.name).join('|')
  const [dropped, setDropped] = useState<Set<string>>(new Set())
  const [keptFor, setKeptFor] = useState('')
  useEffect(() => {
    if (keptFor === trackKey) return
    setKeptFor(trackKey); setDropped(new Set()); setExportNote(null)
  }, [trackKey, keptFor, setExportNote])
  /** 이것 하나만 남긴다 — 나머지는 저장 대상에서 뺀다(개별 저장). */
  const onKeepOnly = useCallback((name: string) => {
    setDropped(new Set(tracksRef.current.filter((t) => t.name !== name).map((t) => t.name)))
  }, [])
  const onKeep = useCallback((name: string, next: boolean) => {
    setDropped((s) => {
      const n = new Set(s)
      if (next) n.delete(name); else n.add(name)
      return n
    })
  }, [])
  const audioTracks = tracks.filter((t) => t.name !== 'transcript' && t.name !== 'translation')
  const tracksRef = useRef(audioTracks); tracksRef.current = audioTracks
  const keptPaths = audioTracks.filter((t) => !dropped.has(t.name)).map((t) => t.path)

  if (error) {
    // 생성 상한 도달(GENERATION_LIMIT_EXCEEDED)은 유효 입력에서도 비결정적으로 발생 가능 → 전용 안내 + 명시 재시도.
    // 그 외 오류는 기존 일반 카드(메시지 + '다시 시도'=닫기). code는 main이 정제해 넘긴 구조화 값(전사·경로 없음).
    const isGenLimit = errorInfo?.code === 'GENERATION_LIMIT_EXCEEDED'
    // 화자 참조 차단(Python fail-closed 가 남긴 코드)은 내부 코드가 아니라 인물 카드로 안내한다.
    // 화자 차단 안내 — **이미 사람 말이면 그대로**(화면 검사는 "(N번 대사: 이름)" 을 붙여 준다),
    // 코드만 왔으면(파이썬이 막은 경우) 지문으로 인물을 찾아 이름을 붙인다.
    // ★예전엔 여기서 고정 문장으로 덮어써서 화면 검사가 알려 준 **인물 이름이 사라졌다**(2026-09-17).
    const speakerNotice = errorInfo?.code === 'SPEAKER_NOT_REGISTERED' || errorInfo?.code === 'SPEAKER_REFERENCE_NOT_READY'
      ? speakerBlockNotice({
          code: errorInfo.code, error, speakerRef: errorInfo.speakerRef,
          knownIds: Object.keys(ttsSpeakerRefState), labelOf: (id) => ttsSpeakerLabels[id] || id,
          sha256Hex: sha256HexOfString,
        })
      : null
    const speakerBlock = speakerNotice?.headline ?? null
    // 시간 제한 판정(main watchdog) — 모델 상한(GENERATION_LIMIT_EXCEEDED)과 다른 사유다. 완료된 부분은 아직
    // 보존되지 않으므로 "보존했습니다" 라고 말하지 않는다.
    const timeLimitMessage = errorInfo?.code === 'JOB_STALLED' || errorInfo?.code === 'JOB_INACTIVE'
      ? '생성이 진행되지 않아 중단했습니다. 다시 시도해 주세요.'
      : errorInfo?.code === 'JOB_BUDGET_EXHAUSTED'
        ? '이 작업에 허용된 총 시간을 넘겨 중단했습니다. 대본을 나누어 다시 시도해 주세요.'
        : null
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
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--rose)' }}>
                {speakerBlock && (!error || /^SPEAKER_/.test(error) || error.includes('SPEAKER_')) ? speakerBlock
                  : (timeLimitMessage ?? error)}
              </span>
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
          ) : speakerBlock ? (
            // 화자 참조 차단은 **여기서도** 사람 말로 바꾼다.
            // ★예전에는 이 안내를 '취소 실패' 갈래 안에서만 썼다. 그래서 파이썬이 막은 경우
            //   (SpeakerReferenceError 는 message 없이 던져 **코드가 곧 문구**가 된다)
            //   화면에 'SPEAKER_NOT_REGISTERED' 가 그대로 찍혔다.
            <>
              <span data-testid="speaker-block-headline"
                style={{ fontSize: 13, fontWeight: 600, color: 'var(--rose)' }}>{speakerBlock}</span>
              <span data-testid="speaker-block-detail"
                style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-secondary)' }}>
                위에 적힌 인물의 카드에서 목소리를 지정한 뒤 다시 만들어 주세요. 이미 지정한 인물은 그대로 쓰입니다.
              </span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {/* 목소리를 지정하기 전에는 다시 눌러도 같은 자리에서 막힌다 — '다시 시도' 라고 하지 않는다. */}
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
          {audioTracks.length > 0 && (
            <span data-testid="track-keep-count" style={{ fontSize: 10, color: 'var(--text-muted)' }}
              title="내보내기로 저장할 결과의 수입니다. 재생 중인 것과는 다릅니다.">
              · 저장 선택 {keptPaths.length}/{audioTracks.length}
            </span>
          )}
        </div>
        <ResultToolbar what={mode === 'conversation' ? '인물별 결과' : '분리 결과'}
          paths={keptPaths} outputDir={outputDir} note={exportNote}
          onExport={(paths, what) => { void runExport(paths, what) }}>
          {mode === 'music' && <KaraokeButton tracks={tracks} />}
        </ResultToolbar>
      </div>

      {/* Tracks — ★대화 모드에서는 **작업실의 인물 카드**가 이 자리를 대신한다.
          같은 트랙을 두 군데에 쌓지 않는다(2026-09-27 개편). 폴더·내보내기는 위에 남는다. */}
      {mode !== 'conversation' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <AnimatePresence>
            {tracks.map((track, i) => (
              <TrackItem key={track.name} track={track} index={i}
                keep={!dropped.has(track.name)} onKeep={onKeep} onKeepOnly={onKeepOnly} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  )
}
