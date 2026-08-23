import React from 'react'
import { motion } from 'framer-motion'
import { useAppStore } from '@/stores/app.store'
import { ALL_EMOTIONS, planEmotionRefs } from '@/lib/emotions'
import { parseTtsScript, TTS_PARSER_VERSION } from '../../shared/ttsGrammar'

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
  const { fileInfo, mode, trimSilence, silenceGap, transcribe, translate, exportSrt, outputFormat, whisperModel, whisperLang, translateModel, demucsModel, nSpeakers, splitMarkers, splitLabels, ttsText, ttsSpeed, ttsSilenceGap, ttsPitch, ttsPitchCapability, ttsEmotionRefState, ttsReferencePrompts, ttsEngine, ttsReferenceClip, ttsRefReady, ttsRefMessage, ttsReferenceRegion, ttsTailMode, ttsTailPaddingMs, ttsTailFadeMs, ttsEmotionBoundaryMode, ttsEmotionBoundaryPauseMs, status, retryNonce, errorInfo, setProcessing, setProgress, setResult, setError, beginCancelling } = useAppStore()
  const cleanupRef = React.useRef<(() => void) | null>(null)

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
    // 공용 마감 I1: tts는 합성 시작 전에 대사 문법을 파싱(parser_version=2). 오류(unknown/invalid/empty)면
    // 합성을 시작하지 않고 차단(모델 미로딩). 성공이면 full sha256를 Python parity 대조용으로 전달한다.
    // 대사 전문은 로그/오류에 넣지 않는다(오류엔 code만).
    let ttsParsedPlanSha256: string | undefined
    if (mode === 'tts') {
      const parsed = parseTtsScript(ttsText)
      if (!parsed.ok) {
        setError('대사 태그를 처리할 수 없습니다.', { code: parsed.errors[0]?.code })
        return
      }
      ttsParsedPlanSha256 = parsed.plan.fullSha256
    }

    console.log('[renderer][synthesize] setProcessing 직전')
    setProcessing()
    console.log('[renderer][synthesize] setProcessing 직후')

    const offProgress = window.api.audio.onProgress((data: any) => {
      // 취소 정리 중이면 진행률 갱신 무시(cancelling 메시지를 덮지 않도록).
      if (useAppStore.getState().status === 'cancelling') return
      setProgress(data.percent ?? 0, data.message ?? '')
    })
    const offResult = window.api.audio.onResult((data: any) => {
      // 취소가 먼저 정착했으면 늦게 도착한 결과는 채택 안 함(계약 4-A). main도 억제하지만 방어적 이중 가드.
      if (useAppStore.getState().status === 'cancelling') return
      setResult(data.tracks ?? [], data.outputDir ?? '', data.metadata ?? null)
      cleanup()
    })
    const offError = window.api.audio.onError((data: any) => {
      if (useAppStore.getState().status === 'cancelling') return  // 취소 승리 시 늦은 오류 무시(계약 4-A)
      // 구조화 code(GENERATION_LIMIT_EXCEEDED 등)를 store에 함께 저장 → 오류 카드가 분기.
      const code = typeof data?.code === 'string' ? data.code : undefined
      setError(data.message ?? 'Unknown error', code ? { code } : null)
      cleanup()
    })

    // 진행/결과/오류(실행별) 구독만 여기서 관리. 취소 lifecycle 구독은 아래 상시 effect(재취소도 받도록).
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
      const r = await window.api.audio.process(fileInfo.path, mode, { trimSilence, silenceGap, transcribe, translate, exportSrt, outputFormat, whisperModel, whisperLang, translateModel, demucsModel, nSpeakers, splitMarkers, splitLabels, ttsText, ttsSpeed, ttsSilenceGap, ttsPitch, ttsEmotionRefs: emotionRefsToSend, ttsEmotionRefSources: emotionSources, ttsEmotionRefRegions: emotionRegions, ttsReferencePrompts, ttsEngine, ttsReferenceOverride: ttsReferenceClip, ttsReferenceRegion, ttsParsedPlanSha256, ttsParserVersion: TTS_PARSER_VERSION, ttsTailMode, ttsTailPaddingMs, ttsTailFadeMs, ttsEmotionBoundaryMode, ttsEmotionBoundaryPauseMs })
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

  // 취소 lifecycle 상시 구독(공용 마감 K). 실행별 구독과 분리 — cancel-failed 후 '다시 취소'도 받아야 하므로
  // 여기서 유지하고, 터미널(cancelled/cancel-failed)에서만 실행별 구독(cleanupRef)을 해제한다.
  React.useEffect(() => {
    const s = () => useAppStore.getState()
    const offCancelling = window.api.audio.onCancelling(() => s().beginCancelling())
    const offCancelled = window.api.audio.onCancelled(() => { s().finishCancelled(); cleanupRef.current?.() })
    const offFailed = window.api.audio.onCancelFailed((d: any) => { s().setCancelFailed(!!d?.childAlive); cleanupRef.current?.() })
    return () => { offCancelling(); offCancelled(); offFailed() }
  }, [])

  const handleCancel = () => {
    if (status !== 'processing') return  // cancelling/그 외에서는 무시(중복 클릭 방지)
    // 즉시 'cancelling' 표시(child 생존 중 idle 금지). idle/error 전환은 main의 audio:cancelled / cancel-failed가 결정.
    // 구독(onResult/onCancelled/…)은 여기서 해제하지 않는다 — 터미널 이벤트가 도착해 cleanup해야 하므로.
    beginCancelling()
    window.api.audio.cancel()
  }

  if (!fileInfo) return null
  if (status === 'done') return null

  const btnBase: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    width: '100%', borderRadius: 12, padding: '14px 0',
    fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
    border: 'none', cursor: 'pointer'
  }

  // 취소 정리 중: 실제 상태 머신(status==='cancelling')에 연결된 비활성 표시. child 종료 확인 전까지 유지.
  // aria-busy=true, 취소·합성 버튼 비활성. Agent 3의 cancelling 스타일(.cancelling-indicator)에 연결.
  if (status === 'cancelling') {
    return (
      <div
        className="cancelling-indicator"
        role="status"
        aria-live="polite"
        aria-busy="true"
        style={{ ...btnBase, background: 'var(--bg-elevated)', color: 'var(--amber)', cursor: 'progress' }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
        </svg>
        작업을 취소하고 정리하는 중…
      </div>
    )
  }

  if (status === 'processing') {
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

  // 취소 실패로 이전 작업의 child가 아직 살아 있으면(CANCEL_FAILED·childAlive) 새 합성·재시도를 차단한다.
  // (main도 runner.isRunning으로 새 process를 거부하지만, UI에서 먼저 명확히 막는다.)
  const cancelFailedActive = errorInfo?.code === 'CANCEL_FAILED' && !!errorInfo?.childAlive

  // 재시도 effect가 읽을 최신 참조 갱신. 이 지점은 processing/cancelling/done early-return을 이미 지나 status가 idle|loading|error뿐 —
  // 즉 '진행 중 아님'이 타입상 보장되므로 여기선 차단 사유 없음 + 파일 있음 + 취소실패-생존 아님만 확인한다.
  handleProcessRef.current = handleProcess
  canRetryRef.current = !ttsBlockReason && !!fileInfo && !cancelFailedActive

  if (cancelFailedActive) {
    // 이전 작업 종료 대기 — 새 합성 불가(오류 카드의 '다시 취소'로 트리 종료를 재시도). aria-disabled.
    return (
      <div role="status" aria-live="polite" aria-disabled="true"
        style={{ ...btnBase, background: 'var(--bg-elevated)', color: 'var(--text-secondary)', cursor: 'not-allowed', flexDirection: 'column', gap: 2, padding: '12px 0' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>이전 작업 종료 대기</span>
        <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.95 }}>취소되지 않은 작업이 남아 있어 새 합성을 시작할 수 없습니다.</span>
      </div>
    )
  }

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
