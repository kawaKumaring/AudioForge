import React from 'react'
import { motion } from 'framer-motion'
import { useAppStore } from '@/stores/app.store'
import { ALL_EMOTIONS, planEmotionRefs } from '@/lib/emotions'

function _estimateTime(mode: string, duration: number, transcribe: boolean, translate: boolean): string {
  let secs = 0
  if (mode === 'music') secs = duration * 0.3 + 15
  else if (mode === 'conversation') secs = duration * 0.5 + 20
  else if (mode === 'transcribe') secs = duration * 0.2 + 10
  else if (mode === 'split') secs = 10 + duration * 0.02
  else if (mode === 'tts') secs = 15 + 5  // model load + ~5s per sentence

  if (transcribe && mode !== 'transcribe') secs += duration * 0.2 + 10
  if (translate) secs += 10

  if (secs < 60) return `약 ${Math.ceil(secs)}초`
  return `약 ${Math.ceil(secs / 60)}분`
}

export default function ProcessButton() {
  const { fileInfo, mode, trimSilence, silenceGap, transcribe, translate, exportSrt, outputFormat, whisperModel, whisperLang, translateModel, demucsModel, nSpeakers, splitMarkers, splitLabels, ttsText, ttsSpeed, ttsSilenceGap, ttsPitch, ttsPitchCapability, ttsEmotionRefState, ttsReferencePrompts, ttsEngine, ttsReferenceClip, ttsRefReady, ttsRefMessage, ttsReferenceRegion, status, retryNonce, setProcessing, setProgress, setResult, setError } = useAppStore()
  const cleanupRef = React.useRef<(() => void) | null>(null)
  // 취소 중 표시용 로컬 상태(UI 준비/스타일링). 실제 취소 완료 전환은 통합/메인이 결정.
  const [cancelling, setCancelling] = React.useState(false)
  React.useEffect(() => { if (status !== 'processing') setCancelling(false) }, [status])

  // 감정 참조 게이팅/전송(계약 §5 불변식) — 순수 판정은 planEmotionRefs 단일 로직.
  //  대사에 실제 쓰인 감정만 대상. 미사용은 비차단·미전송. 등록+미준비 사용 감정은 blockedId로 차단.
  const { toSend: emotionRefsToSend, blockedId: blockedEmotionId } = React.useMemo(
    () => planEmotionRefs(ttsText, ttsEmotionRefState),
    [ttsText, ttsEmotionRefState]
  )

  // 재현/Python 등록판정용 — 등록된 감정 전부의 source(원본 경로)와 region(구간). effective(위 toSend)와
  // 역할이 다르다(계약 §1.2). Python은 이 sources로 "사용된 감정이 등록됐는지"를 판정(§5.1). 미사용도 등록이면 포함.
  const { emotionSources, emotionRegions } = React.useMemo(() => {
    const emotionSources: Record<string, string> = {}
    const emotionRegions: Record<string, { start: number; duration: number }> = {}
    for (const [id, slot] of Object.entries(ttsEmotionRefState)) {
      if (slot?.source) emotionSources[id] = slot.source
      if (slot?.region) emotionRegions[id] = slot.region
    }
    return { emotionSources, emotionRegions }
  }, [ttsEmotionRefState])

  const handleProcess = async () => {
    console.log('[renderer][synthesize] 클릭 핸들러 진입', { mode, hasFile: !!fileInfo })
    if (!fileInfo) return
    console.log('[renderer][synthesize] setProcessing 직전')
    setProcessing()
    console.log('[renderer][synthesize] setProcessing 직후')

    const offProgress = window.api.audio.onProgress((data: any) => {
      setProgress(data.percent ?? 0, data.message ?? '')
    })
    const offResult = window.api.audio.onResult((data: any) => {
      setResult(data.tracks ?? [], data.outputDir ?? '', data.metadata ?? null)
      cleanup()
    })
    const offError = window.api.audio.onError((data: any) => {
      // 구조화 code(GENERATION_LIMIT_EXCEEDED 등)를 store에 함께 저장 → 오류 카드가 분기.
      const code = typeof data?.code === 'string' ? data.code : undefined
      setError(data.message ?? 'Unknown error', code ? { code } : null)
      cleanup()
    })

    function cleanup() {
      offProgress(); offResult(); offError()
      cleanupRef.current = null
    }
    cleanupRef.current = cleanup

    try {
      console.log('[renderer][synthesize] audio:process 호출 직전')
      // ttsEmotionRefs = 사용∩등록∩준비된 감정의 effective 경로만(계약 §5 전송 필터).
      // ttsEmotionRefSources/Regions = 등록 전부의 원본/구간(재현·Python 등록판정용, §1.2/§5.1).
      // ttsPitch = 최종 WAV 음높이 후처리(0=무후처리, §6).
      const r = await window.api.audio.process(fileInfo.path, mode, { trimSilence, silenceGap, transcribe, translate, exportSrt, outputFormat, whisperModel, whisperLang, translateModel, demucsModel, nSpeakers, splitMarkers, splitLabels, ttsText, ttsSpeed, ttsSilenceGap, ttsPitch, ttsEmotionRefs: emotionRefsToSend, ttsEmotionRefSources: emotionSources, ttsEmotionRefRegions: emotionRegions, ttsReferencePrompts, ttsEngine, ttsReferenceOverride: ttsReferenceClip, ttsReferenceRegion })
      console.log('[renderer][synthesize] audio:process 호출 직후', r)
    } catch (err: any) {
      console.error('[renderer][synthesize] audio:process 오류', err?.stack || err)
      setError(err.message || 'Process failed')
      cleanup()
    }
  }

  // ── 사용자 명시 재시도 배선 ──
  // 오류 카드의 '다시 시도' → store.bumpRetry()가 retryNonce를 올린다. 이 effect는 그 증가에만 반응해
  // 재합성을 정확히 1회 실행한다. 자동 재시도·타이머·x-vector 강등·기본참조 폴백 없음(현재 store 설정 그대로 재구성).
  // 최신 참조 패턴: 렌더마다 최신 handleProcess와 재시도 가능 여부(차단/파일/상태)를 refs에 담아 stale closure 방지.
  const handleProcessRef = React.useRef(handleProcess)
  const canRetryRef = React.useRef(false)
  const lastHandledNonce = React.useRef(retryNonce)
  React.useEffect(() => {
    if (retryNonce === lastHandledNonce.current) return  // 마운트/무변화 → 발화 안 함
    lastHandledNonce.current = retryNonce
    if (canRetryRef.current) handleProcessRef.current()   // 차단·파일없음·processing이면 실행 안 함
  }, [retryNonce])

  const handleCancel = () => {
    // 취소 중 UI를 먼저 켠다(스타일링 준비). 현재 배선은 즉시 idle로 되돌리므로 실질적으로는
    // 짧게만 보이며, 통합이 취소를 비동기로 배선하면 이 상태가 유지된다(트리거 조건부).
    setCancelling(true)
    window.api.audio.cancel()
    if (cleanupRef.current) cleanupRef.current()
    useAppStore.setState({ status: 'idle', progress: 0, progressMessage: '' })
  }

  if (!fileInfo) return null
  if (status === 'done') return null

  const btnBase: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    width: '100%', borderRadius: 12, padding: '14px 0',
    fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
    border: 'none', cursor: 'pointer'
  }

  if (status === 'processing') {
    // 취소 중 상태(준비/스타일링): 앰버 펄스, 비활성. 트리거는 handleCancel에서 조건부.
    if (cancelling) {
      return (
        <div
          className="cancelling-indicator"
          role="status"
          aria-live="polite"
          style={{ ...btnBase, background: 'var(--bg-elevated)', color: 'var(--amber)', cursor: 'progress' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          취소 중…
        </div>
      )
    }
    return (
      <motion.button
        initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.99 }}
        onClick={handleCancel}
        aria-label="처리 취소"
        style={{ ...btnBase, background: 'linear-gradient(135deg, #e11d48, #be123c)', color: '#fff', boxShadow: '0 2px 12px var(--rose-glow)' }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
        </svg>
        처리 취소
      </motion.button>
    )
  }

  // TTS 게이팅: 빈/공백 대사 → 차단. 기본 참조 미준비 → 차단. 사용된 감정이 등록+미준비 → 감정 지목 차단.
  // (미사용 감정은 등록 여부와 무관하게 비차단 — 계약 §5 불변식 4.)
  const blockedEmotion = blockedEmotionId
    ? ALL_EMOTIONS.find(e => e.id === blockedEmotionId)
    : null
  const emotionBlockReason = blockedEmotion
    ? (() => {
        const msg = ttsEmotionRefState[blockedEmotion.id]?.message
        return `[${blockedEmotion.label}] 참조 ${msg ? `— ${msg}` : '구간을 확정하세요'}`
      })()
    : ''
  // pitch 합성 gate(계약 G-D): ttsPitch==0이면 capability와 무관하게 합성 가능. ttsPitch!=0인데 capability가
  // supported로 확정되지 않았으면(미확인/미지원) 차단 — 저장된 nonzero pitch를 조용히 0으로 무시하지 않는다.
  // 사용자가 '원본(0)'으로 되돌리면 ttsPitch=0이 되어 차단이 풀린다.
  const pitchSupported = !!ttsPitchCapability && ttsPitchCapability.supported
  const pitchBlockReason = (mode === 'tts' && ttsPitch !== 0 && !pitchSupported)
    ? `음높이 보정 지원을 확인할 수 없어 ${ttsPitch > 0 ? '+' : ''}${ttsPitch.toFixed(1)}반음 설정으로 합성할 수 없습니다. 원본(0)으로 되돌리세요.`
    : ''
  const ttsBlockReason = mode === 'tts'
    ? (!ttsText.trim() ? '합성할 대사를 입력하세요'
        : (!ttsRefReady ? (ttsRefMessage || '참조 구간을 확정하세요')
        : (emotionBlockReason || pitchBlockReason || '')))
    : ''

  // 재시도 effect가 읽을 최신 참조 갱신. 이 지점은 processing/done early-return을 이미 지나 status가 idle|loading|error뿐 —
  // 즉 '진행 중 아님'이 타입상 보장되므로 여기선 차단 사유 없음 + 파일 있음만 확인한다. ttsBlockReason은 pitch·감정·참조 게이팅 포함.
  handleProcessRef.current = handleProcess
  canRetryRef.current = !ttsBlockReason && !!fileInfo

  if (ttsBlockReason) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-disabled="true"
        style={{ ...btnBase, background: 'var(--bg-elevated)', color: 'var(--text-secondary)', cursor: 'not-allowed', flexDirection: 'column', gap: 2, padding: '12px 0' }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>음성 합성 시작 (준비 필요)</span>
        <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.95 }}>{ttsBlockReason}</span>
      </div>
    )
  }

  const actionLabel = mode === 'music' ? '음악 분리 시작' : mode === 'conversation' ? '대화 분리 시작' : mode === 'split' ? '트랙 분할 시작' : mode === 'tts' ? '음성 합성 시작' : '텍스트 추출 시작'

  return (
    <motion.button
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      whileHover={{ scale: 1.01, y: -1 }} whileTap={{ scale: 0.99 }}
      onClick={handleProcess}
      aria-label={actionLabel}
      style={{ ...btnBase, background: 'linear-gradient(135deg, var(--accent), #7c3aed)', color: '#fff', boxShadow: '0 2px 12px var(--accent-glow)' }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" /><polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none" />
      </svg>
      {actionLabel}
      {/* TTS는 문장수·장치·모델 준비 상태에 좌우돼 파일 길이 기반 예상이 부정확 → 표시하지 않음 */}
      {fileInfo.duration > 0 && mode !== 'tts' && (
        <span style={{ opacity: 0.6, fontSize: 11, fontWeight: 400 }}>
          ({_estimateTime(mode, fileInfo.duration, transcribe, translate)})
        </span>
      )}
    </motion.button>
  )
}
