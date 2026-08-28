import { useState, useEffect, useRef, useCallback, type CSSProperties, type MouseEvent } from 'react'
import {
  IDLE_SESSION, beginRequest, invalidate, applyEvent, decideAsyncResult, previewErrorText,
  type PreviewSession, type PreviewPhase, type PreviewEvent,
} from '../../shared/previewSession'

// 참조 음성 준비 패널 — 10초 초과 원본을 거부하지 않고 "참조 원본"으로 수용하고,
// 파형에서 3~10초 구간을 골라 mono/24k 파생 클립을 만든 뒤 그것만 합성/전사에 전달한다.
// 원본은 변경하지 않는다. 준비 상태는 onState 콜백으로 상위(store slot)에 반영해 합성 버튼을 게이팅.
//
// clipKey('default'|emotionId)로 기본 참조와 감정별 참조에 공용 재사용된다. 여러 인스턴스가 서로 다른
// clipKey/path를 쓰면 파생 클립 폴더가 key별로 분리돼 상호 간섭하지 않는다.

const MIN_SEC = 3.0
const MAX_SEC = 10.0

// 상위(store)로 준비 상태를 올리는 패치 형태 — default(setTtsRefState)/emotion(setEmotionRefState) 공용.
export interface RefStatePatch {
  clip?: string
  ready?: boolean
  message?: string
  region?: { start: number; duration: number } | null
}

interface ReferenceRegionPanelProps {
  path: string                          // 분석/트림 대상 원본 경로
  clipKey: string                       // 'default' | emotionId (파생 클립 식별)
  disabled: boolean                     // 합성 중 등 조작 불가
  onState: (s: RefStatePatch) => void   // 준비 상태 변경을 store slot에 반영
  label?: string                        // 헤더 표시명(감정 label). 기본 참조는 '참조 음성'
}

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
  /** 승인 불가 사유의 안정 코드. 하나라도 있으면 ready=false. 파이썬 analyze_region 이 만든다. */
  blocking?: string[]
  /** 알리되 막지는 않는 사유 코드. */
  warning_codes?: string[]
  /** 파이썬이 계산한 승인 가능 여부(= blocking 이 비어 있음). */
  ready?: boolean
  head_truncated?: boolean
  tail_truncated?: boolean
}

/** 차단 코드 → 사용자 문구. 코드가 없으면 파이썬 경고 문구를 그대로 쓴다. */
const BLOCK_MESSAGE: Record<string, string> = {
  REGION_TOO_SHORT: '구간이 너무 짧습니다(3초 이상).',
  REGION_TOO_LONG: '구간이 너무 깁니다(10초 이하).',
  REGION_HEAD_TRUNCATED: '구간 시작이 말 도중입니다. 말이 시작되는 지점부터 잡으세요.',
  REGION_TAIL_TRUNCATED: '구간 끝이 말 도중입니다. 말이 끝나는 지점까지 포함하세요.',
  REGION_SEVERE_CLIPPING: '소리가 심하게 찌그러졌습니다(클리핑).',
  REGION_NEAR_SILENT: '거의 무음입니다.'
}

function fmt(s: number | undefined | null) {
  return typeof s === 'number' && Number.isFinite(s) ? `${s.toFixed(2)}초` : '-초'
}

// ── 미리듣기 DOM 조작(요소 수명은 컴포넌트가 소유, '적용/폐기' 판정은 shared/previewSession) ──

// 소스 전환은 항상 pause() → src 비우기 → 새 src 순서로만 한다.
// 재생 중인 요소의 src만 갈아끼우면 요소가 이상 상태로 남아(로드 미완·seek 무시) 이후 재생이 무음이 된다.
//
// 단, '진행 중인 로드'는 중간에 끊지 않는다. 끊긴 local-file:// 요청이 수십 개 쌓이면 그 뒤로는
// 어떤 미리듣기도 로드되지 않는다(재현 확인). 로드가 끝났거나 애초에 소스가 없을 때만 src를 비운다.
function detachSource(el: HTMLAudioElement) {
  try { el.pause() } catch { /* noop */ }
  if (el.readyState === 0 && el.networkState === 2 /* NETWORK_LOADING */) return
  el.removeAttribute('src')
  try { el.load() } catch { /* noop */ }
}
function attachSource(el: HTMLAudioElement, url: string) {
  el.src = url
  try { el.load() } catch { /* noop */ }
}

// loadedmetadata/canplay(또는 error/타임아웃)까지 기다린다. true면 재생 위치를 지정해도 안전하다.
// 로드가 끝나기 전 currentTime을 지정하거나 play()를 부르면 위치가 반영되지 않거나 프로미스가 거부된다.
function waitUntilLoaded(el: HTMLAudioElement, timeoutMs = 4000): Promise<boolean> {
  if (el.readyState >= 1 /* HAVE_METADATA */) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const onReady = () => finish(true)
    const onFail = () => finish(false)
    function finish(v: boolean) {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      el.removeEventListener('loadedmetadata', onReady)
      el.removeEventListener('canplay', onReady)
      el.removeEventListener('error', onFail)
      resolve(v)
    }
    timer = setTimeout(() => finish(el.readyState >= 1), timeoutMs)
    el.addEventListener('loadedmetadata', onReady)
    el.addEventListener('canplay', onReady)
    el.addEventListener('error', onFail)
  })
}

export default function ReferenceRegionPanel({ path, clipKey, disabled, onState, label = '참조 음성' }: ReferenceRegionPanelProps) {
  const [fileUrl, setFileUrl] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const [start, setStart] = useState(0)      // 구간 시작(초)
  const [dur, setDur] = useState(7)          // 구간 길이(초)
  const [confirming, setConfirming] = useState(false)
  const [metrics, setMetrics] = useState<RegionMetrics | null>(null)
  const [confirmedClip, setConfirmedClip] = useState<string>('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // 구간 종료 타이머는 '어느 세대의 재생을 멈추려던 것인지'를 함께 들고 다닌다 — 옛 세대 타이머는 no-op.
  const stopTimer = useRef<{ id: ReturnType<typeof setTimeout>; gen: number } | null>(null)
  const sessionRef = useRef<PreviewSession>(IDLE_SESSION)
  const [previewPhase, setPreviewPhase] = useState<PreviewPhase>('idle')
  const [previewError, setPreviewError] = useState<string | null>(null)
  // audio ref 콜백은 stable해야 매 렌더 detach/attach가 일어나지 않는다 → fileUrl은 ref로 읽는다.
  const fileUrlRef = useRef<string | null>(fileUrl)
  fileUrlRef.current = fileUrl

  // onState는 상위에서 인라인 화살표로 올 수 있어 매 렌더 새 참조 → runAnalyze useCallback/effect가
  // 매 렌더 재실행되면 무한 재분석이 된다. ref로 최신 함수만 참조해 identity 의존을 끊는다.
  const onStateRef = useRef(onState)
  useEffect(() => { onStateRef.current = onState })

  // 원본 재생용 URL — path에서 자체 취득(기본/감정 공용, 상위가 넘겨줄 필요 없음).
  useEffect(() => {
    let cancelled = false
    if (!path) { setFileUrl(null); return }
    Promise.resolve(window.api.audio.getFileUrl(path))
      .then((u) => { if (!cancelled) setFileUrl(u as string) })
      .catch(() => { if (!cancelled) setFileUrl(null) })
    return () => { cancelled = true }
  }, [path])

  // 분석 실행(재사용 — 파일 변경 시 + '다시 분석' 재시도). single-flight는 main IPC에서 보장.
  const runAnalyze = useCallback(async (signal?: { cancelled: boolean }) => {
    if (!path) return
    setAnalysis(null); setMetrics(null); setConfirmedClip(''); setAnalyzeError(null)
    setLoading(true)
    onStateRef.current({ ready: false, clip: '', message: '참조 음성을 분석 중입니다...', region: null })
    try {
      const a = await window.api.audio.analyzeReference(path, clipKey) as Analysis & { error_message?: string; reason?: string }
      if (signal?.cancelled) return
      // 방어: 분석 payload가 올바르지 않으면(예: IPC 유실/실패) 검은 화면 대신 오류 처리 → "다시 분석"
      if (!a || typeof a.duration_sec !== 'number') {
        throw new Error(a?.error_message || a?.reason || '참조 분석 결과가 올바르지 않습니다')
      }
      setAnalysis(a)
      if (a.too_short) {
        onStateRef.current({ ready: false, clip: '', message: `참조가 ${fmt(a.duration_sec)}로 3초 미만입니다 — 3~10초 음성을 올려주세요`, region: null })
      } else if (a.needs_region) {
        const r = a.recommend
        if (r && r.ok) { setStart(r.start_sec); setDur(Math.min(MAX_SEC, Math.max(MIN_SEC, r.dur_sec))) }
        onStateRef.current({ ready: false, clip: '', message: '참조 구간(3~10초)을 확정하세요', region: null })
      } else if (a.valid_whole) {
        // 3~10초 + 품질 통과 → 원본을 그대로 참조로 사용(파생 클립 불필요, effective==원본)
        onStateRef.current({ ready: true, clip: '', message: '', region: null })
      } else {
        const why = (a.errors || []).map(e => e.message).join(' / ') || '참조 음성 품질 오류'
        onStateRef.current({ ready: false, clip: '', message: why, region: null })
      }
    } catch (e) {
      if (signal?.cancelled) return
      const msg = (e as Error)?.message || '참조 분석 실패'
      setAnalyzeError(msg)
      onStateRef.current({ ready: false, clip: '', message: `참조 분석 실패: ${msg}`, region: null })
    } finally {
      if (!signal?.cancelled) setLoading(false)
    }
  }, [path, clipKey])

  // 파일이 바뀌면 분석(StrictMode 중복 setup에도 main single-flight로 subprocess 1회).
  useEffect(() => {
    if (!path) return
    const signal = { cancelled: false }
    runAnalyze(signal)
    return () => { signal.cancelled = true }
  }, [path, runAnalyze])

  // 구간(start/dur)이 바뀌면 이전 확정은 무효 → 재확정 필요
  useEffect(() => {
    if (analysis?.needs_region) {
      setConfirmedClip(''); setMetrics(null)
      onStateRef.current({ ready: false, clip: '', message: '구간을 변경했습니다 — 다시 확정하세요', region: null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, dur])

  // ── 미리듣기(세대 기반) ────────────────────────────────────────────────────
  const commitSession = (next: PreviewSession) => {
    sessionRef.current = next
    setPreviewPhase(next.phase)
    setPreviewError(next.errorMessage)
  }
  // 비동기 결과를 세션에 반영한다. 옛 세대/불법 전이는 여기서 걸러져 아무 일도 하지 않는다.
  const dispatchPreview = (gen: number, event: PreviewEvent): boolean => {
    const v = applyEvent(sessionRef.current, gen, event)
    if (v.apply) commitSession(v.next)
    return v.apply
  }
  const clearRegionTimer = () => {
    if (stopTimer.current) { clearTimeout(stopTimer.current.id); stopTimer.current = null }
  }

  // audio 요소의 src는 React가 아니라 이 콜백이 소유한다 — 교체/해제 시 pause + src 비우기를 보장하기 위해.
  const setAudioEl = useCallback((el: HTMLAudioElement | null) => {
    const prev = audioRef.current
    if (prev === el) return
    if (stopTimer.current) { clearTimeout(stopTimer.current.id); stopTimer.current = null }
    if (prev) {
      detachSource(prev)
      // 요소가 교체/해제되면 진행 중이던 세대를 무효화 — 늦게 오는 로드/재생 결과가 새 요소를 건드리지 못하게.
      sessionRef.current = invalidate(sessionRef.current)
      setPreviewPhase('idle'); setPreviewError(null)
    }
    audioRef.current = el
    const url = fileUrlRef.current
    if (el && url) attachSource(el, url)
  }, [])

  // 소스가 바뀌면(파일 교체) 이전 재생을 끝내고 src를 비운 뒤 새 소스를 건다 + 세대 무효화.
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    if (el.getAttribute('src') === (fileUrl || '')) return
    clearRegionTimer()
    detachSource(el)
    commitSession(invalidate(sessionRef.current))
    if (fileUrl) attachSource(el, fileUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileUrl])

  const stopPlay = () => {
    clearRegionTimer()
    const el = audioRef.current
    if (el) { try { el.pause() } catch { /* noop */ } }
    // 정지도 세대를 올린다 — 아직 돌아오지 않은 로드/재생 결과가 다시 재생을 시작하지 못하게.
    commitSession(invalidate(sessionRef.current, 'stopped'))
  }

  // 언마운트(모드 전환·행 접기) 시 재생 정지 + 타이머 해제 — 잔여 재생 방지.
  useEffect(() => () => {
    if (stopTimer.current) { clearTimeout(stopTimer.current.id); stopTimer.current = null }
    const el = audioRef.current
    if (el) { try { el.pause() } catch { /* noop */ } }
  }, [])

  const playRegion = () => {
    const el = audioRef.current
    if (!el) return
    // (1) 이전 재생을 확실히 끝낸다 — 구간 종료 타이머 해제 + pause.
    clearRegionTimer()
    try { el.pause() } catch { /* noop */ }
    // (2) 새 세대. 이후 도착하는 이전 세대의 로드 완료·play 결과·구간 종료 타이머는 전부 폐기된다.
    const session = beginRequest(sessionRef.current)
    commitSession(session)
    const gen = session.gen
    const startSec = start
    const durSec = dur
    void (async () => {
      // (3) loadedmetadata/canplay 이전에는 seek·play 하지 않는다(위치 미반영·프로미스 거부의 원인).
      const loaded = await waitUntilLoaded(el)
      if (decideAsyncResult(sessionRef.current, gen) === 'discard') return
      if (!loaded) { dispatchPreview(gen, { kind: 'error', message: previewErrorText('load') }); return }
      if (!dispatchPreview(gen, { kind: 'ready' })) return
      try { el.currentTime = startSec } catch { /* noop */ }
      // play() 프로미스는 정착하지 않을 수도 있다(로드가 멈춘 요소) → 타임아웃과 경주시켜 '준비 중'에 갇히지 않게.
      const result = await Promise.race([
        el.play().then(() => 'ok', (e: unknown) => 'rejected:' + ((e as Error)?.name || '')),
        new Promise<string>((r) => setTimeout(() => r('timeout'), 4000)),
      ])
      // stale이면 그냥 물러난다 — 요소는 하나뿐이라 여기서 pause() 하면 이미 시작된 '새' 재생을 죽인다.
      // 정지 책임은 무효화한 쪽(stopPlay·소스 교체·언마운트·새 요청)이 이미 졌다.
      if (decideAsyncResult(sessionRef.current, gen) === 'discard') return
      if (result !== 'ok') {
        // 새 요청이 이 재생을 끊어서 생긴 거부(AbortError)는 옛 세대 → 위 stale 검사에서 이미 폐기된다.
        // 여기까지 온 실패는 삼키지 않고 사용자 언어 오류로 노출한다(자동 재시도 없음).
        const kind = el.error || result.includes('NotSupportedError') ? 'load' : 'play'
        dispatchPreview(gen, { kind: 'error', message: previewErrorText(kind) })
        return
      }
      if (!dispatchPreview(gen, { kind: 'play' })) return
      // (4) 구간 종료 타이머는 '실제 재생이 시작된 뒤'에 건다. 클릭 시각 기준이면 로드 시간만큼
      //     들리는 구간이 잘려 무음처럼 느껴진다. 세대를 함께 들고 있어 옛 타이머는 새 재생을 멈추지 못한다.
      const id = setTimeout(() => {
        if (decideAsyncResult(sessionRef.current, gen) === 'discard') return
        try { el.pause() } catch { /* noop */ }
        dispatchPreview(gen, { kind: 'region-end' })
      }, Math.max(100, durSec * 1000))
      stopTimer.current = { id, gen }
    })()
  }

  const confirmRegion = async () => {
    if (!path || confirming) return
    setConfirming(true)
    try {
      const res = await window.api.audio.trimReference(path, start, dur, clipKey) as { clip_path: string; metrics: RegionMetrics }
      setMetrics(res.metrics)
      // 승인 여부는 구조화된 blocking 코드로만 정한다. 예전에는 경고 '문구'에 특정 낱말이
      // 들어 있는지로 판단해서, 새로 생긴 '말 도중 절단' 경고가 그 낱말을 안 가져 조용히
      // 승인됐다 — 그 클립이 그대로 ICL 프롬프트가 되어 참조 대사가 섞였다.
      // 승인 권위는 Python(analyze_region) 하나다. renderer 는 그 계약을 '해석'하지 않는다.
      // blocking 누락·타입 오류·ready 와의 모순은 전부 승인 거부로 떨어뜨린다(fail-closed).
      const m = res.metrics
      const blocking = Array.isArray(m?.blocking) ? m.blocking.filter(c => typeof c === 'string') : null
      const contractOk = blocking !== null && typeof m?.ready === 'boolean'
        && m.ready === (blocking.length === 0)
      const ok = contractOk && m.ready === true
      if (ok) {
        setConfirmedClip(res.clip_path)
        onStateRef.current({ ready: true, clip: res.clip_path, message: '', region: { start, duration: dur } })
      } else {
        setConfirmedClip('')
        const msg = !contractOk
          ? '구간 검사 결과를 읽지 못했습니다(형식 불일치). 다시 시도하세요.'
          : (blocking as string[]).map(c => BLOCK_MESSAGE[c] ?? c).join(' · ')
        onStateRef.current({ ready: false, clip: '', message: msg || '구간 품질이 부적합합니다', region: null })
      }
    } catch (e) {
      onStateRef.current({ ready: false, clip: '', message: `파생 참조 생성 실패: ${(e as Error)?.message || ''}`, region: null })
    } finally {
      setConfirming(false)
    }
  }

  if (!path) return null

  const card: CSSProperties = {
    borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
    padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8
  }
  const labelStyle: CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }
  const sub: CSSProperties = { fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }

  if (loading) {
    return <div style={card}><span role="status" aria-live="polite" aria-busy="true" style={sub}>참조 음성 분석 중...</span></div>
  }
  if (analyzeError) {
    return (
      <div style={card} role="alert">
        <span style={{ ...sub, color: 'var(--rose)' }}>참조 분석 실패: {analyzeError}</span>
        <div>
          <button onClick={() => runAnalyze()} disabled={disabled || loading} aria-label="참조 음성 다시 분석" style={{
            padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
            fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
            background: 'var(--rose)', color: '#fff', opacity: (disabled || loading) ? 0.5 : 1,
          }}>다시 분석</button>
          <span style={{ ...sub, marginLeft: 8 }}>일시적 오류일 수 있습니다 — 파일을 다시 올릴 필요 없이 재시도하세요.</span>
        </div>
      </div>
    )
  }
  if (!analysis) return null

  const durTotal = analysis.duration_sec

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={labelStyle}>{label}</span>
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
              <span style={sub} aria-hidden="true">시작</span>
              <input type="range" min={0} max={Math.max(0, durTotal - dur)} step={0.1} value={start} disabled={disabled}
                aria-label="참조 구간 시작 위치(초)"
                aria-valuetext={`${start.toFixed(1)}초`}
                onChange={(e) => setStart(parseFloat(e.target.value))} style={{ flex: 1, accentColor: 'var(--rose)' }} />
              <span style={{ ...sub, minWidth: 48, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{start.toFixed(1)}s</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 180 }}>
              <span style={sub} aria-hidden="true">길이</span>
              <input type="range" min={MIN_SEC} max={MAX_SEC} step={0.1} value={dur} disabled={disabled}
                aria-label="참조 구간 길이(초)"
                aria-valuetext={`${dur.toFixed(1)}초`}
                onChange={(e) => { const d = parseFloat(e.target.value); setDur(d); setStart(s => Math.min(s, Math.max(0, durTotal - d))) }}
                style={{ flex: 1, accentColor: 'var(--rose)' }} />
              <span style={{ ...sub, minWidth: 48, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dur.toFixed(1)}s</span>
            </div>
          </div>

          {/* 재생 · 확정 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={playRegion} disabled={disabled} data-af-preview-phase={previewPhase}
              style={btn('var(--bg-elevated)', 'var(--text-secondary)')}>▶ 구간 미리듣기</button>
            <button onClick={stopPlay} disabled={disabled} style={btn('var(--bg-elevated)', 'var(--text-muted)')}>■ 정지</button>
            <button onClick={confirmRegion} disabled={disabled || confirming}
              style={btn(confirmedClip ? 'var(--bg-elevated)' : 'var(--rose)', confirmedClip ? 'var(--cyan)' : '#fff')}>
              {confirming ? '생성 중...' : confirmedClip ? '✓ 확정됨 (다시 확정)' : '이 구간으로 확정'}
            </button>
            {/* 재생 상태를 눈에 보이게 — '눌렀는데 아무 반응 없음'을 없앤다 */}
            <span role="status" aria-live="polite" style={{ ...sub, minWidth: 44 }}>
              {previewPhase === 'playing' ? '재생 중' : previewPhase === 'loading' ? '준비 중' : ''}
            </span>
            <span style={{ ...sub, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>선택 {fmt(dur)}</span>
          </div>

          {/* 미리듣기 실패는 삼키지 않고 보여준다(사용자 언어·경로 미노출·자동 재시도 없음) */}
          {previewError && (
            <div role="alert" style={{ ...sub, color: 'var(--rose)' }}>{previewError}</div>
          )}

          {/* 확정 후 구간 품질 지표 */}
          {metrics && (
            <div role="status" aria-live="polite" style={{ ...sub, borderTop: '1px solid var(--border-subtle)', paddingTop: 6 }}>
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

          {/* 원본 재생용(숨김 오디오). src는 setAudioEl/fileUrl effect가 소유한다 — 재생 중 src만 갈아끼우지 않기 위해. */}
          {fileUrl && <audio ref={setAudioEl} preload="auto" style={{ display: 'none' }} />}
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
      role="img"
      aria-label={`참조 파형 미리보기 — 전체 ${durTotal.toFixed(1)}초 중 ${start.toFixed(1)}~${(start + dur).toFixed(1)}초 선택됨. 아래 슬라이더로 조정하세요.`}
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
