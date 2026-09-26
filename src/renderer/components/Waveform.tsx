import { useEffect, useRef, useState, type CSSProperties } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js'
import { useAppStore } from '@/stores/app.store'
import { detectSilence, estimateProcessedDuration, type SilenceAnalysis } from '@/lib/silenceDetect'
import { usePlaybackVolume } from '@/hooks/usePlaybackVolume'

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
  const { fileInfo, fileUrl, mode, silenceGap, silencePreview, setSilencePreview } = useAppStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState('0:00')
  const [duration, setDuration] = useState('0:00')
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retry, setRetry] = useState(0)
  const [playError, setPlayError] = useState('')
  // 재생 볼륨(듣기 전용 — 파일에 영향 없음). 값은 앱 공용이고 보관된다 —
  // 예전에는 여기 지역 상태여서 화면을 다시 그리거나 앱을 다시 켜면 100% 로 되돌아갔다.
  const { volume, change: changeVolume, commit: commitVolume, saveFailed: volumeSaveFailed } = usePlaybackVolume()
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
    let disposed = false
    setLoadState('loading')
    setCurrentTime('0:00')
    setDuration('0:00')
    setIsPlaying(false)
    setPlayError('')
    setComputing(false)
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
      dragToSeek: true, // 드래그로 스크럽/이동 (왼쪽으로 넘겨 끌면 처음으로)
      plugins: [regions]
    })

    wsRef.current = ws
    const fail = () => {
      if (disposed) return
      setLoadState('error')
      setDecoded(false)
      setAnalysis(null)
      setIsPlaying(false)
    }
    ws.on('play', () => { if (!disposed) setIsPlaying(true) })
    ws.on('pause', () => { if (!disposed) setIsPlaying(false) })
    ws.on('timeupdate', (t) => { if (!disposed) setCurrentTime(formatTime(t)) })
    ws.on('decode', (d) => {
      if (!disposed) { setDuration(formatTime(d)); setDecoded(true) }
    })
    ws.on('ready', () => { if (!disposed) setLoadState('ready') })
    // StrictMode 정리·빠른 이동 뒤 옛 요청의 실패가 새 파형 상태를 덮지 않는다.
    // 읽기 실패는 사용자가 복구할 수 있게 표시하며, 처리되지 않은 Promise로 버리지 않는다.
    void ws.load(fileUrl).catch(fail)

    return () => {
      disposed = true
      ws.destroy()
      if (wsRef.current === ws) { wsRef.current = null; regionsRef.current = null }
    }
  }, [fileUrl, retry])

  // 같은 원본에서 메뉴만 바꾸면 색만 바꾼다. 디코드·재생 위치를 초기화하지 않는다.
  useEffect(() => {
    wsRef.current?.setOptions({ waveColor: colors.wave, progressColor: colors.progress, cursorColor: colors.cursor })
  }, [colors, fileUrl, retry])
  useEffect(() => { wsRef.current?.setVolume(volume) }, [volume, fileUrl, retry])

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
    // 무음 구간 '내부'만 재생 — 인접 말소리를 섞지 않아야 "정말 조용한지"를 확인할 수 있다.
    // 시작 버튼=무음 앞부분, 끝 버튼=무음 뒷부분 (둘 다 [start,end] 안에서만).
    const span = Math.min(0.8, r.end - r.start)
    const [s, e] = which === 'start'
      ? [r.start, r.start + span]
      : [r.end - span, r.end]
    void ws.play(s, e).catch(() => {
      if (wsRef.current === ws) setPlayError('재생을 시작하지 못했습니다. 다시 눌러 주세요.')
    })
  }

  const step = (delta: number) => {
    if (regionCount === 0) return
    const next = (selIdx + delta + regionCount) % regionCount
    setSelIdx(next)
    const r = analysis!.regions[next]
    wsRef.current?.setTime(Math.max(0, r.start))
  }

  const btnMini = (accent: boolean): CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 3, padding: '2px 8px', borderRadius: 6,
    border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 10, fontWeight: 600,
    background: accent ? hexToRgba(colors.cursor, 0.18) : 'var(--bg-elevated)',
    color: accent ? colors.cursor : 'var(--text-muted)', whiteSpace: 'nowrap'
  })

  return (
    <div data-testid="source-waveform" data-state={loadState} style={{ padding: '0 16px 12px' }}>
      {loadState === 'loading' && <div role="status" style={{ padding: '12px 0', color: 'var(--text-muted)', fontSize: 12 }}>원본 파형을 불러오는 중…</div>}
      {loadState === 'error' && <div role="alert" data-testid="waveform-error" style={{ padding: '12px 14px', marginBottom: 10, borderRadius: 8, background: 'var(--rose-glow)', color: 'var(--text-primary)', fontSize: 12, lineHeight: 1.7 }}>
        <strong>원본을 읽지 못했습니다.</strong>
        <div style={{ color: 'var(--text-secondary)' }}>파일 위치와 접근 권한을 확인하고 다시 읽어 주세요. 위치가 바뀌었다면 위의 ‘파일 변경’에서 선택할 수 있습니다.</div>
        <details style={{ marginTop: 6, color: 'var(--text-muted)' }}><summary style={{ cursor: 'pointer' }}>현재 원본 경로</summary><div style={{ overflowWrap: 'anywhere' }}>{fileInfo?.path}</div></details>
        <button type="button" className="btn btn-ghost" data-testid="waveform-retry" onClick={() => setRetry(v => v + 1)} style={{ marginTop: 8, padding: '6px 12px', fontSize: 12 }}>다시 읽기</button>
      </div>}
      <div ref={containerRef} style={{ marginBottom: 8, display: loadState === 'error' ? 'none' : undefined }} />
      {playError && <div role="alert" style={{ marginBottom: 8, color: 'var(--rose)', fontSize: 12 }}>{playError}</div>}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {/* 왼쪽: 시간 + (Layer 1) 무음 미리보기 ghost 토글 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 10, fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{currentTime}</span>
          {canPreview && (
            <button disabled={loadState !== 'ready'} onClick={() => setSilencePreview(!silencePreview)}
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
        <button type="button" data-testid="waveform-play" aria-label={isPlaying ? '원본 일시정지' : '원본 재생'} disabled={loadState !== 'ready'} onClick={() => {
          const ws = wsRef.current
          if (!ws || loadState !== 'ready') return
          setPlayError('')
          void ws.playPause().catch(() => {
            if (wsRef.current === ws) setPlayError('재생을 시작하지 못했습니다. 다시 눌러 주세요.')
          })
        }} style={{
          opacity: loadState === 'ready' ? 1 : 0.4,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 32, height: 32, borderRadius: '50%', border: 'none', cursor: loadState === 'ready' ? 'pointer' : 'not-allowed',
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
        {/* 오른쪽: 볼륨(듣기 전용) + 길이 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div title={volumeSaveFailed
            ? '재생 볼륨 — 이 값을 기억하지 못했습니다(이번 실행에만 적용됩니다).'
            : '재생 볼륨 (듣기 전용 · 원본 파일에는 영향 없음) — 정한 값이 다음에도 그대로 쓰입니다.'}
            style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              {volume < 0.01
                ? <><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></>
                : <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />}
            </svg>
            <input type="range" min="0" max="1" step="0.05" value={volume}
              data-testid="waveform-volume" aria-label="재생 볼륨 (듣기 전용, 원본에 영향 없음)"
              onChange={(e) => changeVolume(parseFloat(e.target.value))}
              onPointerUp={commitVolume} onKeyUp={commitVolume} onBlur={commitVolume}
              style={{ width: 60, accentColor: colors.cursor, cursor: 'pointer', height: 4 }} />
          </div>
          <span style={{ fontSize: 10, fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{loadState === 'ready' ? duration : '—'}</span>
        </div>
      </div>

      {/* Layer 2: 미리보기 켤 때만 펼쳐지는 얇은 스트립 */}
      {canPreview && silencePreview && loadState === 'ready' && (
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
                <button onClick={() => playBoundary('start')} title="무음 앞부분 듣기 (이 구간이 정말 조용한지 확인 — 말소리 안 섞음)" style={btnMini(true)}>▶ 앞</button>
                <button onClick={() => playBoundary('end')} title="무음 뒷부분 듣기 (이 구간이 정말 조용한지 확인 — 말소리 안 섞음)" style={btnMini(true)}>▶ 뒤</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
