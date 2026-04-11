import { motion } from 'framer-motion'
import { useAppStore } from '@/stores/app.store'

export default function ProcessButton() {
  const { fileInfo, mode, trimSilence, silenceGap, transcribe, translate, exportSrt, outputFormat, status, setProcessing, setProgress, setResult, setError } = useAppStore()

  const handleProcess = async () => {
    if (!fileInfo) return
    setProcessing()

    const offProgress = window.api.audio.onProgress((data: any) => {
      setProgress(data.percent ?? 0, data.message ?? '')
    })
    const offResult = window.api.audio.onResult((data: any) => {
      setResult(data.tracks ?? [], data.outputDir ?? '')
      cleanup()
    })
    const offError = window.api.audio.onError((data: any) => {
      setError(data.message ?? 'Unknown error')
      cleanup()
    })

    function cleanup() { offProgress(); offResult(); offError() }

    try {
      await window.api.audio.process(fileInfo.path, mode, { trimSilence, silenceGap, transcribe, translate, exportSrt, outputFormat })
    } catch (err: any) {
      setError(err.message || 'Process failed')
      cleanup()
    }
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
        onClick={() => window.api.audio.cancel()}
        style={{ ...btnBase, background: 'linear-gradient(135deg, #e11d48, #be123c)', color: '#fff', boxShadow: '0 2px 12px var(--rose-glow)' }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
        </svg>
        처리 취소
      </motion.button>
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
      {mode === 'music' ? '음악 분리 시작' : mode === 'conversation' ? '대화 분리 시작' : mode === 'split' ? '트랙 분할 시작' : '텍스트 추출 시작'}
    </motion.button>
  )
}
