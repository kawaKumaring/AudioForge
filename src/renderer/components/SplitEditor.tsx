import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import WaveSurfer from 'wavesurfer.js'
import { isCancelCleanupBusy } from '../../shared/cancelContract'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js'
import { useAppStore } from '@/stores/app.store'
import { usePlaybackVolume } from '@/hooks/usePlaybackVolume'
import {
  validateMarkers, formatSplitMarkerError, AUTO_SILENCE_SPLIT_NOTICE,
} from '../../shared/splitMarkers'
import { parseTimeList, issuesSummary, type TimeListIssue } from '../../shared/splitTimeList'
import {
  emptyHistory, pushHistory, sealHistory, undo as undoStep, redo as redoStep,
  canUndo, canRedo, type SplitHistory,
} from '../../shared/splitHistory'
import { buildPieces, fmtDuration, type SplitPiece } from '../../shared/splitPieces'

interface Marker {
  id: string
  time: number
  label: string
}

export default function SplitEditor() {
  const { fileUrl, fileInfo, mode, status, errorInfo } = useAppStore()
  const locked = status === 'processing' || isCancelCleanupBusy(status) || !!errorInfo?.childAlive
  const lockedRef = useRef(locked); lockedRef.current = locked
  const [waveReady, setWaveReady] = useState(false)
  const [waveError, setWaveError] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null)
  const { volume: playbackVolume } = usePlaybackVolume()
  const [markers, setMarkers] = useState<Marker[]>([])
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [inputMode, setInputMode] = useState<'wave' | 'auto' | 'manual'>('wave')
  const [timestampText, setTimestampText] = useState('')
  const [autoDetecting, setAutoDetecting] = useState(false)
  const [firstTrackLabel, setFirstTrackLabel] = useState('Track 01')
  const markersRef = useRef<Marker[]>([])
  // 지금 화면의 마커가 '어느 파일 기준'인지. 파일이 바뀌면 마커와 함께 갱신된다.
  const [markerFileKey, setMarkerFileKey] = useState('')
  // ★되돌리기 이력 — **화면 안에만** 산다. 메뉴를 옮기면 편집은 남고 이력은 새로 시작한다.
  const [history, setHistory] = useState<SplitHistory<Marker>>(() => emptyHistory<Marker>())
  const firstLabelRef = useRef('Track 01')
  /** 바꾸기 **직전** 장면을 이력에 쌓는다. `kind` 가 걸음의 크기를 정한다. */
  const remember = useCallback((kind: string) => {
    setHistory((h) => pushHistory(h, { markers: markersRef.current, firstLabel: firstLabelRef.current }, kind))
  }, [])
  /** 이어 묶기를 끊는다 — 드래그를 놓거나 다른 곳을 만질 때. */
  const seal = useCallback(() => { setHistory((h) => sealHistory(h)) }, [])
  // 시간 목록의 오류(줄 번호와 함께). 입력창 아래 한 줄로 보인다.
  const [listIssues, setListIssues] = useState<TimeListIssue[]>([])
  const timestampRef = useRef<HTMLTextAreaElement | null>(null)

  // Keep ref in sync
  useEffect(() => { markersRef.current = markers }, [markers])
  // 파서가 범위 검사에 쓴다(콜백이 만들어질 때의 값에 묶이지 않게 ref 로 든다).
  const effectiveDurationRef = useRef(0)
  // 첫 트랙 이름도 이력에 담아야 하므로 ref 로 함께 든다.
  useEffect(() => { firstLabelRef.current = firstTrackLabel }, [firstTrackLabel])

  const isActive = mode === 'split' && !!fileUrl

  // 파일 식별 키(지문). 오류 payload에는 절대 싣지 않는다 — 비교 입력으로만 쓴다.
  const fileKey = fileInfo?.path || fileUrl || ''

  // 파일이 바뀌면 이전 파일 기준 마커를 버린다.
  // 없으면 A의 분할 지점이 B에 그대로 적용된다(B가 더 길면 오류조차 없이 엉뚱하게 잘림).
  // 아래 store 동기화 effect가 splitMarkers를 []로 덮어써 store의 스테일 값까지 정리한다.
  useEffect(() => {
    // ★메뉴를 옮겼다가 돌아온 경우에는 **그 원본의 편집을 되살린다**(2026-09-27).
    //   파일을 닫거나 새로 불러오면 `setFile`·`reset` 이 초안을 비우므로, 같은 경로를
    //   다시 열어도 이전 작업으로 이어지지 않는다 — 그것이 '새로 불러온 것' 이다.
    const draft = useAppStore.getState().splitDraft
    const mine = draft && draft.sourceKey === fileKey && fileKey
    setMarkers(mine ? draft!.markers.map((m) => ({ ...m })) : [])
    setFirstTrackLabel(mine ? draft!.firstLabel : 'Track 01')
    setUnselected(mine ? new Set(draft!.unselected) : new Set())
    setMarkerFileKey(fileKey)
    setHistory(emptyHistory<Marker>())     // 편집은 잇되 이력은 새로 시작한다
    setListIssues([])
  }, [fileKey])

  // Initialize wavesurfer
  useEffect(() => {
    if (!isActive || !containerRef.current || !fileUrl) return

    wsRef.current?.destroy()
    setWaveReady(false); setWaveError(''); setDuration(0); setCurrentTime(0); setIsPlaying(false)

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
    ws.on('ready', () => setWaveReady(true))
    ws.on('error', () => { setWaveReady(false); setWaveError('파형을 읽지 못했습니다') })
    ws.on('timeupdate', (t) => setCurrentTime(t))
    ws.on('play', () => setIsPlaying(true))
    ws.on('pause', () => setIsPlaying(false))

    // Double-click to add marker
    ws.on('dblclick', (relativeX) => {
      const time = relativeX * ws.getDuration()
      addMarker(time)
    })

    void ws.load(fileUrl).catch(() => { setWaveReady(false); setWaveError('파형을 읽지 못했습니다') })
    wsRef.current = ws

    return () => { ws.destroy(); wsRef.current = null }
  }, [fileUrl])

  useEffect(() => { if (locked) wsRef.current?.pause(); wsRef.current?.setOptions({ interact: !locked }) }, [locked, waveReady])

  // 이 화면에는 볼륨 슬라이더가 없다 — 다른 화면에서 정한 값을 그대로 따른다.
  // 예전에는 어떤 값을 정해도 이 파형만 최대로 나갔다(2026-09-10).
  useEffect(() => { wsRef.current?.setVolume(playbackVolume) }, [playbackVolume, fileUrl])

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
        drag: !locked,
        resize: false,
        id: m.id
      })
    })

    // Listen for drag updates — use a single persistent handler
    const handleUpdate = (region: any) => {
      // ★끄는 동안 수십 번 불린다. 같은 종류로 쌓아 **한 걸음으로 묶는다**.
      remember(`drag:${region.id}`)
      setMarkers(prev => prev.map(m =>
        m.id === region.id ? { ...m, time: region.start } : m
      ).sort((a, b) => a.time - b.time))
    }
    // 놓는 순간 묶기를 끊는다 — 다시 끌면 새 걸음이다.
    const handleUpdateEnd = () => { seal() }

    regions.on('region-updated', handleUpdate)
    regions.on('region-update-end', handleUpdateEnd)

    return () => {
      // un(event)만 부르면 아무것도 해제되지 않음 — 핸들러를 명시해야 함
      regions.un('region-updated', handleUpdate)
      regions.un('region-update-end', handleUpdateEnd)
    }
  }, [markers, locked, remember, seal])

  const addMarker = useCallback((time: number, label?: string) => {
    if (lockedRef.current || !Number.isFinite(time) || time <= 0 || time >= (wsRef.current?.getDuration() || 0) || markersRef.current.some(m => Math.abs(m.time - time) < .05)) return
    const id = `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const newLabel = label || `Track ${markersRef.current.length + 2}`
    remember('add')
    setMarkers(prev => [...prev, { id, time, label: newLabel }].sort((a, b) => a.time - b.time))
  }, [remember])

  const removeMarker = useCallback((id: string) => {
    remember('remove')
    setMarkers(prev => prev.filter(m => m.id !== id))
  }, [remember])

  const updateLabel = useCallback((id: string, label: string) => {
    // ★글자마다 걸음을 쌓지 않는다 — 같은 칸을 이어 치는 동안 하나로 묶인다.
    remember(`label:${id}`)
    setMarkers(prev => prev.map(m => m.id === id ? { ...m, label } : m))
  }, [remember])

  // Preview: play 3 seconds around marker
  /**
   * 경계 앞뒤를 잠깐 들어 본다.
   *
   * ★예전에는 5초 뒤 멈추는 타이머를 걸어 두고 **치우지 않았다.** 그래서 다른 곳을
   *   재생하기 시작해도 그 타이머가 살아 있다가 **남의 재생을 끊었고**, 파일을 바꾼
   *   뒤에도 남았다(2026-09-27 지적). 이제 새 미리듣기·언마운트에서 반드시 치운다.
   */
  /** 되돌리기·다시 적용 — 현재 장면을 넘기고 돌려받은 장면으로 갈아 끼운다. */
  const doUndo = useCallback(() => {
    const r = undoStep(history, { markers: markersRef.current, firstLabel: firstLabelRef.current })
    if (!r) return
    setHistory(r.history); setMarkers(r.snap.markers as Marker[]); setFirstTrackLabel(r.snap.firstLabel)
  }, [history])
  const doRedo = useCallback(() => {
    const r = redoStep(history, { markers: markersRef.current, firstLabel: firstLabelRef.current })
    if (!r) return
    setHistory(r.history); setMarkers(r.snap.markers as Marker[]); setFirstTrackLabel(r.snap.firstLabel)
  }, [history])

  /** 그 줄을 입력창에서 **골라 준다** — 어디가 문제인지 눈으로 찾게 하지 않는다. */
  const selectLine = useCallback((line: number) => {
    const el = timestampRef.current
    if (!el) return
    const lines = el.value.split('\n')
    if (line < 1 || line > lines.length) return
    const from = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0)
    el.focus()
    el.setSelectionRange(from, from + lines[line - 1].length)
  }, [])

  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearPreviewTimer = useCallback(() => {
    if (previewTimer.current) { clearTimeout(previewTimer.current); previewTimer.current = null }
  }, [])
  useEffect(() => clearPreviewTimer, [clearPreviewTimer])
  const previewMarker = useCallback((time: number) => {
    const ws = wsRef.current
    if (!ws) return
    clearPreviewTimer()
    const start = Math.max(0, time - 2)
    ws.setTime(start)
    ws.play()
    previewTimer.current = setTimeout(() => {
      previewTimer.current = null
      // 그 사이 다른 것을 틀었으면 건드리지 않는다 — 이 미리듣기의 재생일 때만 멈춘다.
      if (wsRef.current === ws && ws.isPlaying()) ws.pause()
    }, 5000)
  }, [clearPreviewTimer])

  // Parse timestamp text
  /**
   * 붙여넣은 시간 목록을 적용한다.
   *
   * ★규칙은 `shared/splitTimeList` 하나만 본다 — 화면 안에 두었더니 검사할 수 없었고,
   *   잘못된 줄을 조용히 버리고 있었다(2026-09-27).
   * ★**하나라도 잘못되면 아무것도 바꾸지 않는다.** 기존 편집을 그대로 두고 사유만 띄운다.
   */
  const parseTimestamps = useCallback(() => {
    const r = parseTimeList(timestampText, effectiveDurationRef.current)
    setListIssues(r.issues)
    if (!r.ok) return                       // 기존 편집 유지 — 부분 적용하지 않는다
    remember('list')
    seal()
    const stamp = Date.now()
    setFirstTrackLabel(r.firstLabel || 'Track 01')
    setMarkers(r.marks.map((mk, i) => ({
      id: `m_${stamp}_${i}`,
      time: mk.seconds,
      label: mk.label || `Track ${i + 2}`,
    })))
  }, [timestampText, remember, seal])

  // 무음 자동 감지 = 클라이언트 RMS 에너지 분석(즉시·인터랙티브). Python silencedetect
  // (separate.py 배치 분할)와 의도적으로 분리 — 편집기에선 서브프로세스 왕복 없이 이미
  // 디코드된 WaveSurfer 버퍼로 즉답한다. (무음 감지 3벌은 목적이 달라 통일하지 않음 — L-2)
  const handleAutoDetect = async () => {
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

  // 분할 지점 검증 — 규칙은 shared/splitMarkers 하나만 본다(renderer/main/Python 동일 권위).
  // 저장 전에 실제로 나올 조각 — 여기서 경계를 새로 찾지 않는다. 화면이 확정한 마커를
  // 그대로 조각으로 만들고, 실행 단계도 같은 규칙(split_markers.build_pieces)을 쓴다.
  const [unselected, setUnselected] = useState<Set<number>>(new Set())
  const [playingPiece, setPlayingPiece] = useState<number | null>(null)
  const pieceStopRef = useRef<number | null>(null)

  // 파형 디코드 전(duration 0)에는 fileInfo.duration으로 대체하고, 그것도 없으면 판정을 미룬다
  // (로딩 중 가짜 오류를 띄우지 않기 위해). 마커를 고쳐 담지 않는다 — 표시만 한다.
  const effectiveDuration = duration > 0 ? duration : (fileInfo?.duration ?? 0)
  const validation = useMemo(() => validateMarkers(
    markers.map((m) => m.time),
    {
      durationSeconds: effectiveDuration,
      fingerprint: markerFileKey || null,
      expectedFingerprint: fileKey || null,
    }
  ), [markers, effectiveDuration, markerFileKey, fileKey])
  effectiveDurationRef.current = effectiveDuration
  const validationErrors = effectiveDuration > 0 && !validation.ok ? validation.errors : []
  const autoSilenceSplit = markers.length === 0

  // Build split points for export (used by ProcessButton)
  const pieces: SplitPiece[] = useMemo(() => (
    effectiveDuration > 0
      ? buildPieces(markers.map((m) => m.time), effectiveDuration,
                    [firstTrackLabel, ...markers.map((m) => m.label)])
      : []
  ), [markers, effectiveDuration, firstTrackLabel])

  useEffect(() => {
    // Store markers in global state for ProcessButton to access
    const points = markers.map(m => m.time)
    const labels = [firstTrackLabel, ...markers.map(m => m.label)]
    // 고른 조각만 저장한다 — 전부 고른 상태면 아무것도 보내지 않아 예전 동작 그대로다.
    const selected = pieces.filter((p) => !unselected.has(p.index)).map((p) => p.index)
    useAppStore.setState({
      splitMarkers: points, splitLabels: labels,
      splitSelected: selected.length === pieces.length ? null : selected,
      // ★메뉴를 옮겨도 잃지 않도록 **그 원본의 편집**으로 적어 둔다(디스크에는 쓰지 않는다).
      //   원본이 없으면 적지 않는다 — 임자 없는 초안을 남기지 않는다.
      splitDraft: fileKey
        ? { sourceKey: fileKey, markers: markers.map((m) => ({ ...m })), firstLabel: firstTrackLabel, unselected: [...unselected] }
        : null,
    })
  }, [markers, firstTrackLabel, pieces, unselected, fileKey])

  // 조각 듣기 — 저장에 쓰는 것과 **같은 구간 정보**를 쓴다. 파일을 만들지 않는다.
  const stopPiece = useCallback(() => {
    try { wsRef.current?.pause() } catch { /* noop */ }
    pieceStopRef.current = null
    setPlayingPiece(null)
  }, [])

  const playPiece = useCallback((p: SplitPiece | null) => {
    const ws = wsRef.current
    if (!ws || effectiveDuration <= 0) return
    const same = p ? playingPiece === p.index : playingPiece === -1
    if (same) { stopPiece(); return }
    stopPiece()
    pieceStopRef.current = p ? p.end : effectiveDuration
    setPlayingPiece(p ? p.index : -1)
    try {
      ws.setTime(p ? p.start : 0)
      ws.play()
    } catch { setPlayingPiece(null) }
  }, [effectiveDuration, playingPiece, stopPiece])

  // 끝 지점에 닿으면 멈춘다.
  useEffect(() => {
    const ws = wsRef.current
    if (!ws) return
    const un = ws.on('timeupdate', (sec: number) => {
      const until = pieceStopRef.current
      if (until != null && sec >= until) stopPiece()
    })
    return () => { try { un() } catch { /* noop */ } }
  }, [stopPiece, fileUrl])

  useEffect(() => stopPiece, [stopPiece])

  if (!isActive) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <fieldset disabled={locked} style={{ margin: 0, padding: 0, border: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <section aria-label="파형으로 분할" style={{ padding: 16, borderRadius: 14, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
          <strong style={{ fontSize: 13 }}>분할 지점</strong>
          <button type="button" disabled={!waveReady || currentTime <= 0 || currentTime >= duration} onClick={() => addMarker(wsRef.current?.getCurrentTime() || 0)} title="파형을 두 번 클릭해도 분할점을 추가할 수 있습니다. 선을 끌어 위치를 조정하세요." style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border-accent)', background: 'var(--accent-glow)', color: 'var(--accent-light)', font: 'inherit', fontSize: 12 }}>＋ 현재 위치에서 나누기</button>
        </div>
        <div style={{ background: 'var(--bg-base)', borderRadius: 10, padding: 10 }}>
          <div ref={containerRef} data-testid="split-edit-wave" title="두 번 클릭: 분할점 추가 · 분할선 끌기: 위치 변경"/>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 32px minmax(0,1fr)', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtTime(currentTime)}</span>
            <button type="button" aria-label={isPlaying ? '분할 파형 일시정지' : '분할 파형 재생'} disabled={!waveReady} onClick={() => { pieceStopRef.current = null; setPlayingPiece(null); void wsRef.current?.playPause().catch(() => setWaveError('재생하지 못했습니다')) }} style={{ width: 32, height: 32, padding: 0, border: 0, borderRadius: '50%', background: 'var(--accent-glow)', color: 'var(--accent-light)' }}>{isPlaying ? 'Ⅱ' : '▶'}</button>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>{fmtTime(duration)}</span>
          </div>
        </div>
        {waveError && <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--rose)' }}>{waveError}</div>}
      </section>
      {/* Input mode toggle — 오른쪽 끝에 되돌리기·다시 적용을 붙인다(좁으면 줄바꿈) */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', borderRadius: 10, overflow: 'hidden',
        background: 'var(--bg-card)', border: '1px solid var(--border-subtle)'
      }}>
        {(['wave', 'manual', 'auto'] as const).map((m) => (
          <button type="button" aria-pressed={inputMode === m} key={m} onClick={() => setInputMode(m)} style={{
            flex: 1, padding: '8px 0', border: 'none', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 11, fontWeight: inputMode === m ? 600 : 500,
            background: inputMode === m ? 'rgba(251,191,36,0.12)' : 'transparent',
            color: inputMode === m ? 'var(--amber)' : 'var(--text-muted)',
            borderBottom: inputMode === m ? '2px solid var(--amber)' : '2px solid transparent'
          }}>
            {m === 'wave' ? '파형 편집' : m === 'manual' ? '시간 목록 붙여넣기' : '무음으로 나누기'}
          </button>
        ))}
        {/* ★되돌릴 것이 없으면 **비활성**이다 — 눌러도 아무 일이 없는 단추를 살려 두지 않는다. */}
        <div style={{ display: 'flex', alignItems: 'stretch', borderLeft: '1px solid var(--border-subtle)' }}>
          {([['undo', '되돌리기', !canUndo(history) || locked, doUndo],
             ['redo', '다시 적용', !canRedo(history) || locked, doRedo]] as const).map(([key, label, off, act]) => (
            <button type="button" key={key} data-testid={`split-${key}`} aria-label={label}
              title={off ? (locked ? '작업 중에는 편집할 수 없습니다' : `${label}할 것이 없습니다`) : label}
              disabled={off} onClick={act}
              style={{
                padding: '8px 11px', border: 'none', background: 'transparent', cursor: off ? 'default' : 'pointer',
                color: off ? 'var(--text-muted)' : 'var(--text-primary)', opacity: off ? .45 : 1,
                display: 'inline-flex', alignItems: 'center',
              }}>
              <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                style={key === 'redo' ? { transform: 'scaleX(-1)' } : undefined}>
                <path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>
              </svg>
            </button>
          ))}
        </div>
      </div>

      {/* Timestamp input */}
      {inputMode === 'manual' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            ref={timestampRef}
            data-testid="split-time-list"
            value={timestampText}
            onChange={(e) => { setTimestampText(e.target.value); if (listIssues.length) setListIssues([]) }}
            placeholder={"0:00 첫 번째 곡\n3:52 두 번째 곡\n7:15 세 번째 곡\n...\n\n타임스탬프를 붙여넣으세요"}
            style={{
              width: '100%', height: 120, resize: 'vertical',
              borderRadius: 10, padding: '10px 14px', border: '1px solid var(--border-subtle)',
              background: 'var(--bg-base)', color: 'var(--text-primary)',
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
          {/* ★입력창을 줄마다 쪼개지 않는다. 아래에 '3행: …' 으로 짧게 적고,
              누르면 그 줄을 **골라 준다**(2026-09-27 지시 3). */}
          {listIssues.length > 0 && (
            <div role="alert" data-testid="split-time-issues"
              style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'baseline', fontSize: 11, color: 'var(--rose)' }}>
              <span>{issuesSummary(listIssues)}</span>
              <span style={{ color: 'var(--text-muted)' }}>· 적용하지 않았습니다(기존 편집 유지)</span>
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {listIssues.filter((x) => x.line > 0).slice(0, 8).map((x) => (
                  <button type="button" key={`${x.line}-${x.code}`} onClick={() => selectLine(x.line)}
                    title={x.message}
                    style={{
                      padding: '2px 7px', borderRadius: 5, border: '1px solid var(--border-subtle)',
                      background: 'var(--bg-elevated)', color: 'var(--rose)', cursor: 'pointer',
                      font: 'inherit', fontSize: 10,
                    }}>{x.line}행</button>
                ))}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Auto detect */}
      {inputMode === 'auto' && (
        <button onClick={handleAutoDetect} disabled={autoDetecting || !waveReady} style={{
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
              <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 400, color: 'var(--text-muted)' }}>01 = 0:00~ {firstTrackLabel}</span>
            </span>
            <button onClick={() => { remember('clear'); seal(); setMarkers([]) }} style={{
              padding: '2px 8px', borderRadius: 4, border: 'none', cursor: 'pointer',
              fontSize: 10, fontWeight: 500, background: 'var(--bg-elevated)', color: 'var(--text-muted)', fontFamily: 'inherit'
            }}>전체 삭제</button>
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {markers.map((m, idx) => (
              <div key={m.id} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px',
                borderBottom: '1px solid var(--border-subtle)'
              }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', minWidth: 20, textAlign: 'center' }}>
                  {String(idx + 2).padStart(2, '0')}
                </span>
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

      {/* 저장 전에 실제로 나올 조각 — 화면이 확정한 경계 그대로다.
          ★여기부터는 '분할 경계 편집' 이 아니라 **'저장할 트랙 고르기'** 다. 눈에 띄게 가른다. */}
      {pieces.length > 0 && (
        <div data-testid="split-pieces" style={{
          borderRadius: 10, padding: '10px 12px',
          background: 'var(--bg-card)', border: '1px solid var(--border-accent, var(--border-subtle))',
          borderTopWidth: 3, borderTopStyle: 'solid', borderTopColor: 'var(--border-accent, var(--border-subtle))',
          display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
              {/* ★마커가 없으면 조각 수를 **확정값처럼 말하지 않는다**(2026-09-27 지시 5).
                  실제 자동 분할은 ffmpeg 이 정하므로 화면은 그 수를 모른다. */}
              {autoSilenceSplit ? '저장할 트랙 — 자동 분할' : `저장할 트랙 — 조각 ${pieces.length}개`}
            </span>
            {autoSilenceSplit && (
              <span tabIndex={0} data-testid="split-auto-note"
                title="분할 지점을 두지 않으면 저장할 때 무음을 기준으로 나눕니다. 실제 조각 수는 그때 정해집니다."
                style={{ fontSize: 10, color: 'var(--amber)' }}>조각 수는 저장할 때 정해집니다</span>
            )}
            <button data-testid="split-play-all" onClick={() => playPiece(null)}
              title={"처음부터 끝까지 들어 봅니다. 저장 파일을 만들지 않습니다."}
              style={{
                padding: '3px 9px', borderRadius: 6, border: 'none', cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
                background: 'var(--bg-elevated)', color: 'var(--text-primary)',
              }}>{playingPiece === -1 ? '■ 멈춤' : '▶ 전체 미리듣기'}</button>
            {/* ★자동 분할이면 조각이 몇 개인지 **우리도 모른다** — 고른 수를 세어 보여 주지 않는다. */}
            {!autoSilenceSplit && (
              <span data-testid="split-selected-count" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)' }}>
                저장할 조각 {pieces.length - unselected.size}개
              </span>
            )}
          </div>
          {pieces.map((p) => {
            const off = unselected.has(p.index)
            return (
              <div key={p.index} data-testid="split-piece" data-selected={off ? '0' : '1'}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '3px 4px', borderRadius: 6,
                  background: playingPiece === p.index ? 'var(--bg-elevated)' : 'transparent',
                  opacity: off ? 0.45 : 1,
                }}>
                <input type="checkbox" data-testid="split-piece-keep" checked={!off}
                  onChange={() => setUnselected((s) => {
                    const n = new Set(s)
                    if (n.has(p.index)) n.delete(p.index); else n.add(p.index)
                    return n
                  })}
                  aria-label={`${p.label} 저장하기`}
                  style={{ accentColor: 'var(--accent)', cursor: 'pointer', flexShrink: 0 }} />
                <button data-testid="split-piece-play" onClick={() => playPiece(p)}
                  aria-label={`${p.label} 듣기`}
                  style={{
                    padding: '1px 5px', borderRadius: 5, border: 'none', cursor: 'pointer',
                    fontFamily: 'inherit', fontSize: 11, background: 'transparent', color: 'var(--text-primary)',
                  }}>{playingPiece === p.index ? '■' : '▶'}</button>
                <span data-testid="split-piece-name" style={{ fontSize: 11, color: 'var(--text-primary)', minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.name}
                </span>
                <span data-testid="split-piece-time" style={{ fontSize: 10, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                  {fmtDuration(p.start)} → {fmtDuration(p.end)} · {fmtDuration(p.duration)}
                </span>
              </div>
            )
          })}

        </div>
      )}

      {/* 검증 오류 — 실행 전에 반드시 보인다. 숫자와 순번만, 경로/파일명은 노출하지 않는다. */}
      {validationErrors.length > 0 && (
        <div role="alert" style={{
          borderRadius: 10, padding: '10px 14px',
          background: 'rgba(244,63,94,0.08)', border: '1px solid var(--rose)'
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--rose)', marginBottom: 6 }}>
            분할 지점을 확인하세요 — 이대로는 실행할 수 없습니다
          </div>
          <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {validationErrors.map((e, i) => (
              <li key={`${e.reasonCode}_${e.index}_${i}`} style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                {formatSplitMarkerError(e)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 마커 0개 = 배치 무음 자동 분할 경로. 조용히 넘어가지 않고 명시한다. */}
      {autoSilenceSplit && (
        <div style={{
          borderRadius: 10, padding: '10px 14px',
          background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
          fontSize: 11, lineHeight: 1.5, color: 'var(--text-secondary)'
        }}>
          {AUTO_SILENCE_SPLIT_NOTICE}
        </div>
      )}

      <span tabIndex={0} title="파형의 무음 감지는 RMS 기준이고, 분할점 없이 실행하는 자동 분할은 ffmpeg 기준입니다. 감지 결과가 다를 수 있습니다." style={{ fontSize: 10, color: 'var(--text-muted)', alignSelf: 'flex-end' }}>ⓘ 자동 감지 기준</span>
      </fieldset>
    </div>
  )
}
