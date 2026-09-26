import { useState, useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '@/stores/app.store'
import { isCancelCleanupBusy } from '../../shared/cancelContract'

/** The picker is mounted only where the shared source is the actual input. */
export default function DropZone() {
  const { fileInfo, status, errorInfo, mode, setFile, reset, setRestorable } = useAppStore()
  const [isDragging, setIsDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const requestId = useRef(0)
  const dragCounter = useRef(0)
  const disabled = loading || status === 'processing' || isCancelCleanupBusy(status) || !!errorInfo?.childAlive

  // Reading metadata is asynchronous. A newer pick/unmount must invalidate the old response.
  useEffect(() => () => { requestId.current++ }, [])
  useEffect(() => { setLoadError('') }, [fileInfo])
  const loadFile = useCallback(async (filePath: string) => {
    const current = useAppStore.getState()
    if (current.status === 'processing' || isCancelCleanupBusy(current.status) || current.errorInfo?.childAlive) return
    const id = ++requestId.current
    setLoading(true)
    setLoadError('')
    try {
      const [info, url] = await Promise.all([window.api.audio.getFileInfo(filePath), window.api.audio.getFileUrl(filePath)])
      const state = useAppStore.getState()
      if (id !== requestId.current || state.fileInfo !== current.fileInfo || state.status === 'processing' || isCancelCleanupBusy(state.status) || state.errorInfo?.childAlive) return
      setFile(info, url)
      try {
        const saved = await window.api.audio.findSession(filePath)
        if (id === requestId.current && useAppStore.getState().fileInfo?.path === filePath && saved?.dir && saved.session) setRestorable(saved)
      } catch { /* A missing previous result does not prevent opening a source. */ }
    } catch {
      const state = useAppStore.getState()
      if (id === requestId.current && state.fileInfo === current.fileInfo && state.status !== 'processing' && !isCancelCleanupBusy(state.status) && !state.errorInfo?.childAlive) {
        setLoadError('이 파일을 열 수 없습니다. 파일 형식이나 손상 여부를 확인한 뒤 다시 선택하세요.')
      }
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [setFile, setRestorable])

  useEffect(() => {
    const enter = (event: DragEvent) => {
      event.preventDefault()
      if (disabled) return
      dragCounter.current++
      if (event.dataTransfer?.types.includes('Files')) setIsDragging(true)
    }
    const leave = (event: DragEvent) => {
      event.preventDefault()
      if (--dragCounter.current <= 0) { dragCounter.current = 0; setIsDragging(false) }
    }
    const over = (event: DragEvent) => { event.preventDefault() }
    const drop = (event: DragEvent) => {
      event.preventDefault()
      dragCounter.current = 0
      setIsDragging(false)
      if (disabled) return
      const file = event.dataTransfer?.files?.[0]
      if (file) { const path = window.api.utils.getPathForFile(file); if (path) void loadFile(path) }
    }
    document.addEventListener('dragenter', enter)
    document.addEventListener('dragleave', leave)
    document.addEventListener('dragover', over)
    document.addEventListener('drop', drop)
    return () => {
      document.removeEventListener('dragenter', enter)
      document.removeEventListener('dragleave', leave)
      document.removeEventListener('dragover', over)
      document.removeEventListener('drop', drop)
    }
  }, [disabled, loadFile])

  const pickFile = async () => {
    if (disabled) return
    try { const path = await window.api.audio.selectFile(); if (path) await loadFile(path) }
    catch { setLoadError('파일 선택 창을 열지 못했습니다. 다시 시도하세요.') }
  }
  const duration = fileInfo?.duration ?? 0
  const details = fileInfo ? [
    duration > 0 ? `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, '0')}` : null,
    fileInfo.channels > 0 ? (fileInfo.channels === 1 ? '모노' : `${fileInfo.channels}채널`) : null,
    fileInfo.sampleRate > 0 ? `${(fileInfo.sampleRate / 1000).toFixed(1)} kHz` : null,
    fileInfo.format?.toUpperCase()
  ].filter(Boolean).join('  ·  ') : ''

  return <>
    {isDragging && <div role="status" style={{ position: 'fixed', inset: 36, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', background: 'rgba(14,16,22,.94)', border: '2px dashed var(--accent)', borderRadius: 16, fontSize: 20 }}>파일을 놓아 {mode === 'tts' ? '참조 목소리로' : '원본으로'} 사용</div>}
    {fileInfo ? <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, padding: '16px 20px' }}>
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, borderRadius: 10, background: 'var(--accent-glow)', color: 'var(--accent-light)' }} aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M8 3h8l4 4v14H4V3zM8 12h8M8 16h5"/></svg>
      </span>
      <div style={{ flex: '1 1 180px', minWidth: 0 }}>
        <div title={fileInfo.path} style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{fileInfo.name}</div>
        <div style={{ marginTop: 5, fontSize: 11, color: 'var(--text-muted)' }}>{loading ? '파일을 여는 중…' : details || '이전 결과에서 복원한 파일'}</div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="btn btn-ghost" data-testid="source-change" onClick={() => void pickFile()} disabled={disabled} style={{ padding: '7px 10px', fontSize: 12 }}>파일 변경</button>
        <button type="button" className="btn btn-ghost" data-testid="source-close" onClick={reset} disabled={disabled} title="현재 원본을 닫습니다. 저장한 결과 파일은 그대로 남습니다." style={{ padding: '7px 10px', fontSize: 12 }}>닫기</button>
      </div>
    </div> : <button type="button" onClick={() => void pickFile()} disabled={disabled} data-testid="source-open" aria-label={mode === 'tts' ? '참조 목소리 파일 선택' : '오디오 또는 영상 파일 선택'} className="source-dropzone"
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, width: '100%', minHeight: 245, padding: '36px 24px', border: '1px dashed var(--border-accent)', borderRadius: 13, background: 'var(--bg-card)', color: 'var(--text-primary)', fontFamily: 'inherit', cursor: disabled ? 'wait' : 'pointer' }}>
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 52, height: 52, borderRadius: 14, background: 'var(--accent-glow)', color: 'var(--accent-light)' }} aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 15v6h18v-6M12 16V3m-5 5 5-5 5 5"/></svg>
      </span>
      <span style={{ fontSize: 16, fontWeight: 600 }}>{loading ? '파일을 여는 중…' : mode === 'tts' ? '참조할 목소리 파일을 선택하세요' : '오디오나 영상 파일을 가져오세요'}</span>
      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>이곳에 끌어 놓거나 클릭해서 선택</span>
      <span style={{ marginTop: 5, fontSize: 11, color: 'var(--text-muted)' }}>WAV · MP3 · M4A · FLAC · MP4 · MKV 등</span>
    </button>}
    {loadError && <p role="alert" data-testid="source-error" style={{ padding: '12px 20px', fontSize: 12, lineHeight: 1.6, color: 'var(--rose)' }}>{loadError}</p>}
  </>
}
