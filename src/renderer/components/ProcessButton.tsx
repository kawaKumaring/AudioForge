import React from 'react'
import { motion } from 'framer-motion'
import { useAppStore, emotionEffectivePath } from '@/stores/app.store'
import { ALL_EMOTIONS, parseUsedEmotionIds } from '@/lib/emotions'

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
  const { fileInfo, mode, trimSilence, silenceGap, transcribe, translate, exportSrt, outputFormat, whisperModel, whisperLang, translateModel, demucsModel, nSpeakers, splitMarkers, splitLabels, ttsText, ttsSpeed, ttsSilenceGap, ttsEmotionRefState, ttsReferencePrompts, ttsEngine, ttsReferenceClip, ttsRefReady, ttsRefMessage, ttsReferenceRegion, status, setProcessing, setProgress, setResult, setError } = useAppStore()
  const cleanupRef = React.useRef<(() => void) | null>(null)

  // 감정 참조 게이팅/전송(계약 §5 불변식):
  //  - 대사에 실제 쓰인 감정만 대상. 미사용 감정은 등록 여부와 무관하게 비차단·미전송.
  //  - 사용된 감정이 등록됐는데(source 있음) 준비 안 됐으면(구간 미확정/품질/만료) → 차단 + 감정 지목 사유.
  //  - 미등록(source 없음) 사용 감정은 기본 참조로 폴백(허용) — 차단하지 않음.
  const usedEmotionIds = React.useMemo(() => parseUsedEmotionIds(ttsText), [ttsText])
  // 전송용 effective 맵(ttsEmotionRefs): 사용 ∩ 등록 ∩ 준비된 감정만, effective 경로로.
  const emotionRefsToSend = React.useMemo(() => {
    const out: Record<string, string> = {}
    for (const id of usedEmotionIds) {
      const slot = ttsEmotionRefState[id]
      if (!slot) continue                 // 미등록 → 기본 폴백(전송 안 함)
      const eff = emotionEffectivePath(slot)
      if (eff) out[id] = eff              // 준비된 것만. 미준비는 아래 blockedEmotion이 차단.
    }
    return out
  }, [usedEmotionIds, ttsEmotionRefState])
  // 사용됐지만 등록+미준비인 첫 감정(차단 사유 생성용).
  const blockedEmotionId = React.useMemo(() => {
    for (const id of usedEmotionIds) {
      const slot = ttsEmotionRefState[id]
      if (slot && !slot.ready) return id
    }
    return null
  }, [usedEmotionIds, ttsEmotionRefState])

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
      setError(data.message ?? 'Unknown error')
      cleanup()
    })

    function cleanup() {
      offProgress(); offResult(); offError()
      cleanupRef.current = null
    }
    cleanupRef.current = cleanup

    try {
      console.log('[renderer][synthesize] audio:process 호출 직전')
      // ttsEmotionRefs = 사용∩등록∩준비된 감정의 effective 경로만(계약 §5 전송 필터). 통합 브랜치가
      // 여기에 ttsEmotionRefSources/ttsEmotionRefRegions(재현용)를 추가한다 — 편집을 게이팅/전송에 국소화.
      const r = await window.api.audio.process(fileInfo.path, mode, { trimSilence, silenceGap, transcribe, translate, exportSrt, outputFormat, whisperModel, whisperLang, translateModel, demucsModel, nSpeakers, splitMarkers, splitLabels, ttsText, ttsSpeed, ttsSilenceGap, ttsEmotionRefs: emotionRefsToSend, ttsReferencePrompts, ttsEngine, ttsReferenceOverride: ttsReferenceClip, ttsReferenceRegion })
      console.log('[renderer][synthesize] audio:process 호출 직후', r)
    } catch (err: any) {
      console.error('[renderer][synthesize] audio:process 오류', err?.stack || err)
      setError(err.message || 'Process failed')
      cleanup()
    }
  }

  const handleCancel = () => {
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
    border: 'none', cursor: 'pointer', outline: 'none'
  }

  if (status === 'processing') {
    return (
      <motion.button
        initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.99 }}
        onClick={handleCancel}
        style={{ ...btnBase, background: 'linear-gradient(135deg, #e11d48, #be123c)', color: '#fff', boxShadow: '0 2px 12px var(--rose-glow)' }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
  const ttsBlockReason = mode === 'tts'
    ? (!ttsText.trim() ? '합성할 대사를 입력하세요'
        : (!ttsRefReady ? (ttsRefMessage || '참조 구간을 확정하세요')
        : (emotionBlockReason || '')))
    : ''

  if (ttsBlockReason) {
    return (
      <div style={{ ...btnBase, background: 'var(--bg-elevated)', color: 'var(--text-muted)', cursor: 'not-allowed', flexDirection: 'column', gap: 2, padding: '12px 0' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>음성 합성 시작</span>
        <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.9 }}>{ttsBlockReason}</span>
      </div>
    )
  }

  return (
    <motion.button
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      whileHover={{ scale: 1.01, y: -1 }} whileTap={{ scale: 0.99 }}
      onClick={handleProcess}
      style={{ ...btnBase, background: 'linear-gradient(135deg, var(--accent), #7c3aed)', color: '#fff', boxShadow: '0 2px 12px var(--accent-glow)' }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none" />
      </svg>
      {mode === 'music' ? '음악 분리 시작' : mode === 'conversation' ? '대화 분리 시작' : mode === 'split' ? '트랙 분할 시작' : mode === 'tts' ? '음성 합성 시작' : '텍스트 추출 시작'}
      {/* TTS는 문장수·장치·모델 준비 상태에 좌우돼 파일 길이 기반 예상이 부정확 → 표시하지 않음 */}
      {fileInfo.duration > 0 && mode !== 'tts' && (
        <span style={{ opacity: 0.6, fontSize: 11, fontWeight: 400 }}>
          ({_estimateTime(mode, fileInfo.duration, transcribe, translate)})
        </span>
      )}
    </motion.button>
  )
}
