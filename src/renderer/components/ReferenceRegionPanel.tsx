import { useState, useEffect, useRef, useCallback, type CSSProperties, type MouseEvent } from 'react'
import { useAppStore } from '@/stores/app.store'

// 참조 음성 준비 패널 — 10초 초과 원본을 거부하지 않고 "참조 원본"으로 수용하고,
// 파형에서 3~10초 구간을 골라 mono/24k 파생 클립을 만든 뒤 그것만 합성/전사에 전달한다.
// 원본은 변경하지 않는다. 준비 상태(store.ttsRefReady/ttsReferenceClip/ttsRefMessage)로 합성 버튼을 게이팅.

const MIN_SEC = 3.0
const MAX_SEC = 10.0

interface Analysis {
  duration_sec: number
  sample_rate: number
  channels: number
  needs_region: boolean
  too_short: boolean
  valid_whole: boolean
  errors?: { code: string; message: string }[]
  warnings?: { code: string; message: string }[]
  recommend?: { ok: boolean; start_sec: number; dur_sec: number; whole_file?: boolean }
  peaks?: { peaks: number[]; duration_sec: number }
}

interface RegionMetrics {
  dur_sec: number
  silence_ratio: number
  clipping_ratio: number
  rms_dbfs: number
  in_range: boolean
  warnings: string[]
}

function fmt(s: number) {
  return `${s.toFixed(2)}초`
}

export default function ReferenceRegionPanel() {
  const { fileInfo, fileUrl, status, setTtsRefState } = useAppStore()
  const disabled = status === 'processing'
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const [start, setStart] = useState(0)      // 구간 시작(초)
  const [dur, setDur] = useState(7)          // 구간 길이(초)
  const [confirming, setConfirming] = useState(false)
  const [metrics, setMetrics] = useState<RegionMetrics | null>(null)
  const [confirmedClip, setConfirmedClip] = useState<string>('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const path = fileInfo?.path || ''

  // 파일이 바뀌면 분석. 결과에 따라 준비 상태를 store에 반영.
  useEffect(() => {
    if (!path) return
    let cancelled = false
    setAnalysis(null); setMetrics(null); setConfirmedClip(''); setAnalyzeError(null)
    setLoading(true)
    setTtsRefState({ ready: false, clip: '', message: '참조 음성을 분석 중입니다...' })
    ;(async () => {
      try {
        const a = await window.api.audio.analyzeReference(path) as Analysis
        if (cancelled) return
        setAnalysis(a)
        if (a.too_short) {
          setTtsRefState({ ready: false, clip: '', message: `참조가 ${fmt(a.duration_sec)}로 3초 미만입니다 — 3~10초 음성을 올려주세요` })
        } else if (a.needs_region) {
          const r = a.recommend
          if (r && r.ok) { setStart(r.start_sec); setDur(Math.min(MAX_SEC, Math.max(MIN_SEC, r.dur_sec))) }
          setTtsRefState({ ready: false, clip: '', message: '참조 구간(3~10초)을 확정하세요' })
        } else if (a.valid_whole) {
          // 3~10초 + 품질 통과 → 원본을 그대로 참조로 사용(파생 클립 불필요)
          setTtsRefState({ ready: true, clip: '', message: '' })
        } else {
          const why = (a.errors || []).map(e => e.message).join(' / ') || '참조 음성 품질 오류'
          setTtsRefState({ ready: false, clip: '', message: why })
        }
      } catch (e) {
        if (cancelled) return
        const msg = (e as Error)?.message || '참조 분석 실패'
        setAnalyzeError(msg)
        setTtsRefState({ ready: false, clip: '', message: `참조 분석 실패: ${msg}` })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [path, setTtsRefState])

  // 구간(start/dur)이 바뀌면 이전 확정은 무효 → 재확정 필요
  useEffect(() => {
    if (analysis?.needs_region) {
      setConfirmedClip(''); setMetrics(null)
      setTtsRefState({ ready: false, clip: '', message: '구간을 변경했습니다 — 다시 확정하세요', region: null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, dur])

  const stopPlay = useCallback(() => {
    if (stopTimer.current) { clearTimeout(stopTimer.current); stopTimer.current = null }
    if (audioRef.current) { audioRef.current.pause() }
  }, [])

  useEffect(() => () => stopPlay(), [stopPlay])

  const playRegion = () => {
    const el = audioRef.current
    if (!el) return
    stopPlay()
    el.currentTime = start
    el.play().catch(() => {})
    stopTimer.current = setTimeout(() => { el.pause() }, Math.max(100, dur * 1000))
  }

  const confirmRegion = async () => {
    if (!path || confirming) return
    setConfirming(true)
    try {
      const res = await window.api.audio.trimReference(path, start, dur) as { clip_path: string; metrics: RegionMetrics }
      setMetrics(res.metrics)
      const ok = res.metrics.in_range && !res.metrics.warnings.some(w => w.includes('심각') || w.includes('거의 무음') || w.includes('부족') || w.includes('초과'))
      if (ok) {
        setConfirmedClip(res.clip_path)
        setTtsRefState({ ready: true, clip: res.clip_path, message: '', region: { start, duration: dur } })
      } else {
        setConfirmedClip('')
        setTtsRefState({ ready: false, clip: '', message: res.metrics.warnings[0] || '구간 품질이 부적합합니다', region: null })
      }
    } catch (e) {
      setTtsRefState({ ready: false, clip: '', message: `파생 참조 생성 실패: ${(e as Error)?.message || ''}` })
    } finally {
      setConfirming(false)
    }
  }

  if (!path) return null

  const card: CSSProperties = {
    borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
    padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8
  }
  const label: CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }
  const sub: CSSProperties = { fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }

  if (loading) {
    return <div style={card}><span style={sub}>참조 음성 분석 중...</span></div>
  }
  if (analyzeError) {
    return <div style={card}><span style={{ ...sub, color: 'var(--rose)' }}>참조 분석 실패: {analyzeError}</span></div>
  }
  if (!analysis) return null

  const durTotal = analysis.duration_sec

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={label}>참조 음성</span>
        <span style={sub}>
          길이 {fmt(durTotal)} · {analysis.sample_rate.toLocaleString()}Hz · {analysis.channels === 1 ? '모노' : `${analysis.channels}채널`} · 허용 3~10초
        </span>
      </div>

      {/* 3초 미만 → 다른 파일 요청 */}
      {analysis.too_short && (
        <div style={{ ...sub, color: 'var(--rose)' }}>
          참조가 3초 미만입니다. 목소리 특징을 담기 어렵습니다 — 3~10초 길이의 음성 파일을 올려주세요.
        </div>
      )}

      {/* 3~10초 정상 → 원본 그대로 사용 */}
      {!analysis.too_short && !analysis.needs_region && analysis.valid_whole && (
        <div style={{ ...sub, color: 'var(--cyan)' }}>
          길이·품질 조건을 만족합니다. 이 파일을 참조로 사용합니다.
          {(analysis.warnings || []).length > 0 && (
            <span style={{ color: 'var(--text-muted)' }}> · 참고: {(analysis.warnings || []).map(w => w.message).join(', ')}</span>
          )}
        </div>
      )}

      {/* 3~10초지만 품질 오류 */}
      {!analysis.too_short && !analysis.needs_region && !analysis.valid_whole && (
        <div style={{ ...sub, color: 'var(--rose)' }}>
          {(analysis.errors || []).map(e => e.message).join(' / ') || '참조 음성 품질이 합성에 부적합합니다.'}
        </div>
      )}

      {/* 10초 초과 → 구간 선택 */}
      {analysis.needs_region && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={sub}>
            10초를 초과합니다. 아래 파형에서 <strong style={{ color: 'var(--rose)' }}>3~10초 구간</strong>을 골라 확정하세요.
            추천 구간이 미리 선택돼 있지만, 재생해 확인하고 필요하면 조정하세요. 선택한 구간만 참조로 쓰입니다(원본은 변경되지 않음).
          </div>

          {/* 파형 + 구간 하이라이트 (클릭으로 시작 위치 이동) */}
          <Waveform peaks={analysis.peaks?.peaks || []} durTotal={durTotal} start={start} dur={dur}
            disabled={disabled}
            onSeek={(s) => setStart(Math.max(0, Math.min(s, durTotal - dur)))} />

          {/* 시작/길이 컨트롤 */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 180 }}>
              <span style={sub}>시작</span>
              <input type="range" min={0} max={Math.max(0, durTotal - dur)} step={0.1} value={start} disabled={disabled}
                onChange={(e) => setStart(parseFloat(e.target.value))} style={{ flex: 1, accentColor: 'var(--rose)' }} />
              <span style={{ ...sub, minWidth: 48, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{start.toFixed(1)}s</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 180 }}>
              <span style={sub}>길이</span>
              <input type="range" min={MIN_SEC} max={MAX_SEC} step={0.1} value={dur} disabled={disabled}
                onChange={(e) => { const d = parseFloat(e.target.value); setDur(d); setStart(s => Math.min(s, Math.max(0, durTotal - d))) }}
                style={{ flex: 1, accentColor: 'var(--rose)' }} />
              <span style={{ ...sub, minWidth: 48, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dur.toFixed(1)}s</span>
            </div>
          </div>

          {/* 재생 · 확정 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={playRegion} disabled={disabled} style={btn('var(--bg-elevated)', 'var(--text-secondary)')}>▶ 구간 미리듣기</button>
            <button onClick={stopPlay} disabled={disabled} style={btn('var(--bg-elevated)', 'var(--text-muted)')}>■ 정지</button>
            <button onClick={confirmRegion} disabled={disabled || confirming}
              style={btn(confirmedClip ? 'var(--bg-elevated)' : 'var(--rose)', confirmedClip ? 'var(--cyan)' : '#fff')}>
              {confirming ? '생성 중...' : confirmedClip ? '✓ 확정됨 (다시 확정)' : '이 구간으로 확정'}
            </button>
            <span style={{ ...sub, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>선택 {fmt(dur)}</span>
          </div>

          {/* 확정 후 구간 품질 지표 */}
          {metrics && (
            <div style={{ ...sub, borderTop: '1px solid var(--border-subtle)', paddingTop: 6 }}>
              구간 품질 — 길이 {fmt(metrics.dur_sec)} · 무음 {(metrics.silence_ratio * 100).toFixed(0)}% ·
              클리핑 {(metrics.clipping_ratio * 100).toFixed(2)}% · RMS {metrics.rms_dbfs.toFixed(1)}dBFS
              {metrics.warnings.length > 0 && (
                <div style={{ color: 'var(--rose)', marginTop: 2 }}>⚠ {metrics.warnings.join(' · ')}</div>
              )}
              {confirmedClip && metrics.warnings.length === 0 && (
                <span style={{ color: 'var(--cyan)' }}> · 참조 준비 완료</span>
              )}
            </div>
          )}

          {/* 원본 재생용(숨김 오디오) */}
          {fileUrl && <audio ref={audioRef} src={fileUrl} preload="auto" style={{ display: 'none' }} />}
        </div>
      )}
    </div>
  )
}

function btn(bg: string, color: string): CSSProperties {
  return {
    padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
    fontSize: 11, fontWeight: 600, fontFamily: 'inherit', background: bg, color
  }
}

// 파형: coarse peaks를 막대로, 선택 구간을 하이라이트. 클릭으로 시작 위치 이동.
function Waveform({ peaks, durTotal, start, dur, disabled, onSeek }: {
  peaks: number[]; durTotal: number; start: number; dur: number; disabled: boolean; onSeek: (s: number) => void
}) {
  const W = 100, H = 100  // viewBox 단위(%). preserveAspectRatio none으로 늘림.
  const n = peaks.length || 1
  const regA = durTotal > 0 ? (start / durTotal) * W : 0
  const regB = durTotal > 0 ? ((start + dur) / durTotal) * W : 0
  const handleClick = (e: MouseEvent<SVGSVGElement>) => {
    if (disabled || durTotal <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    onSeek(frac * durTotal - dur / 2)  // 클릭 지점을 구간 중앙으로
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onClick={handleClick}
      style={{ width: '100%', height: 72, background: 'var(--bg-elevated)', borderRadius: 8, cursor: disabled ? 'default' : 'pointer', display: 'block' }}>
      {/* 선택 구간 하이라이트 */}
      <rect x={regA} y={0} width={Math.max(0, regB - regA)} height={H} fill="rgba(251,113,133,0.18)" />
      <line x1={regA} y1={0} x2={regA} y2={H} stroke="var(--rose)" strokeWidth={0.4} />
      <line x1={regB} y1={0} x2={regB} y2={H} stroke="var(--rose)" strokeWidth={0.4} />
      {/* 파형 막대 */}
      {peaks.map((p, i) => {
        const x = (i / n) * W
        const h = Math.max(0.5, p * H * 0.9)
        const inReg = x >= regA && x <= regB
        return <rect key={i} x={x} y={(H - h) / 2} width={W / n} height={h}
          fill={inReg ? 'var(--rose)' : 'var(--text-muted)'} opacity={inReg ? 0.9 : 0.4} />
      })}
    </svg>
  )
}
