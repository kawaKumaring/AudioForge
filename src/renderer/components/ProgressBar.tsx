import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { useAppStore } from '@/stores/app.store'

export default function ProgressBar() {
  const { status, progress, progressMessage } = useAppStore()
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(0)

  useEffect(() => {
    if (status === 'processing') {
      startRef.current = Date.now()
      setElapsed(0)
      const timer = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
      }, 1000)
      return () => clearInterval(timer)
    }
    setElapsed(0)
  }, [status])

  if (status !== 'processing') return null

  const mm = Math.floor(elapsed / 60)
  const ss = elapsed % 60

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className="glass-card pulse-glow"
      style={{ borderRadius: 16, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          </motion.div>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)' }}>{progressMessage}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>
            {mm}:{String(ss).padStart(2, '0')}
          </span>
          <span style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--accent-light)' }}>
            {Math.round(progress)}%
          </span>
        </div>
      </div>
      <div style={{ height: 8, borderRadius: 999, overflow: 'hidden', background: 'rgba(139,92,246,0.08)' }}>
        <motion.div
          style={{ height: '100%', borderRadius: 999, background: 'linear-gradient(90deg, var(--accent), var(--accent-light), var(--cyan))', boxShadow: '0 0 12px var(--accent-glow)' }}
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        />
      </div>
    </motion.div>
  )
}
