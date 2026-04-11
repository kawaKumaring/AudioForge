import { useState, useCallback, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAppStore } from '@/stores/app.store'

export default function DropZone() {
  const { fileInfo, status, setFile } = useAppStore()
  const [isDragging, setIsDragging] = useState(false)
  const dragCounter = useRef(0)

  const loadFile = useCallback(async (filePath: string) => {
    try {
      const info = await window.api.audio.getFileInfo(filePath)
      const url = await window.api.audio.getFileUrl(filePath)
      setFile(info, url)
    } catch (err) {
      console.error('Failed to load file:', err)
    }
  }, [setFile])

  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current++
      if (e.dataTransfer?.types.includes('Files')) {
        setIsDragging(true)
      }
    }

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current--
      if (dragCounter.current <= 0) {
        dragCounter.current = 0
        setIsDragging(false)
      }
    }

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }

    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current = 0
      setIsDragging(false)

      const file = e.dataTransfer?.files?.[0]
      if (file) {
        const ext = file.name.split('.').pop()?.toLowerCase()
        if (['m4a', 'mp3', 'wav', 'flac', 'ogg', 'aac', 'wma'].includes(ext || '')) {
          const filePath = window.api.utils.getPathForFile(file)
          if (filePath) loadFile(filePath)
        }
      }
    }

    document.addEventListener('dragenter', handleDragEnter)
    document.addEventListener('dragleave', handleDragLeave)
    document.addEventListener('dragover', handleDragOver)
    document.addEventListener('drop', handleDrop)

    return () => {
      document.removeEventListener('dragenter', handleDragEnter)
      document.removeEventListener('dragleave', handleDragLeave)
      document.removeEventListener('dragover', handleDragOver)
      document.removeEventListener('drop', handleDrop)
    }
  }, [loadFile])

  const handleClick = useCallback(async () => {
    const filePath = await window.api.audio.selectFile()
    if (filePath) loadFile(filePath)
  }, [loadFile])

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <>
      {/* Full-screen drag overlay */}
      <AnimatePresence>
        {isDragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            style={{
              position: 'fixed', inset: 0, zIndex: 50,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(8, 8, 12, 0.85)', backdropFilter: 'blur(8px)'
            }}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px',
                borderRadius: '16px', padding: '48px',
                border: '2px dashed var(--accent)',
                background: 'var(--accent-glow)',
                boxShadow: '0 0 80px var(--accent-glow)'
              }}
            >
              <motion.div animate={{ y: [-4, 4, -4] }} transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </motion.div>
              <span style={{ fontSize: '16px', fontWeight: 600, color: 'var(--accent-light)' }}>
                여기에 드롭하세요
              </span>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* File info or upload prompt */}
      <AnimatePresence mode="wait">
        {fileInfo ? (
          <motion.div
            key="file-info"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="glass-card"
            style={{
              display: 'flex', alignItems: 'center', gap: '16px',
              borderRadius: '16px', padding: '20px'
            }}
          >
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: '56px', height: '56px', flexShrink: 0, borderRadius: '12px',
              background: 'var(--accent-glow)', border: '1px solid var(--border-accent)'
            }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
              </svg>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {fileInfo.name}
              </div>
              <div style={{ marginTop: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                {[
                  formatDuration(fileInfo.duration),
                  fileInfo.channels === 1 ? 'Mono' : 'Stereo',
                  `${(fileInfo.sampleRate / 1000).toFixed(1)}kHz`,
                  fileInfo.format.toUpperCase()
                ].map((tag, i) => (
                  <span key={i} style={{
                    borderRadius: '6px', padding: '2px 8px', fontSize: '11px', fontWeight: 500,
                    background: 'var(--bg-elevated)', color: 'var(--text-muted)'
                  }}>
                    {tag}
                  </span>
                ))}
              </div>
            </div>
            {status === 'idle' && (
              <button onClick={handleClick} className="btn btn-ghost" style={{ fontSize: '12px' }}>변경</button>
            )}
          </motion.div>
        ) : (
          <motion.div
            key="dropzone"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            onClick={handleClick}
            className="hover-glow group"
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              cursor: 'pointer', borderRadius: '16px', padding: '48px 32px',
              background: 'var(--bg-card)'
            }}
          >
            {/* Upload icon */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: '72px', height: '72px', borderRadius: '16px', marginBottom: '20px',
              background: 'linear-gradient(135deg, var(--accent-glow), var(--cyan-glow))',
              border: '1px solid var(--border-accent)',
              transition: 'transform 0.2s'
            }}>
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>

            <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
              오디오 파일을 드래그하거나 클릭
            </div>
            <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
              M4A, MP3, WAV, FLAC, OGG 지원
            </div>

            {/* Format badges */}
            <div style={{ marginTop: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
              {['M4A', 'MP3', 'WAV', 'FLAC'].map((fmt) => (
                <span key={fmt} style={{
                  borderRadius: '6px', padding: '4px 10px',
                  fontSize: '10px', fontWeight: 600, letterSpacing: '0.05em',
                  background: 'var(--bg-elevated)', color: 'var(--text-muted)',
                  border: '1px solid var(--border-subtle)'
                }}>
                  {fmt}
                </span>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
