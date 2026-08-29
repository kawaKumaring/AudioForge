import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { useAppStore } from '@/stores/app.store'

// TTS 진행 단계 — Python이 보내는 진행 메시지 키워드로 현재 단계를 추정해 표시한다.
// (메시지 문구는 에이전트1/Python 소유. 여기선 소비만 하며 키워드 매칭은 방어적 추정.)
const TTS_STAGES = [
  { key: 'load', label: '모델 로딩', kw: ['모델', '로딩', 'load', '준비'] },
  { key: 'ref', label: '참조 처리', kw: ['참조', 'reference', 'refclip', '구간'] },
  { key: 'gen', label: '문장 생성', kw: ['문장', '생성', '합성', 'synth', 'generat'] },
  { key: 'pitch', label: '음높이 후처리', kw: ['음높이', 'pitch', '후처리', 'rubberband'] },
]

// 메시지에서 현재 단계 인덱스를 추정. 매칭 없으면 진행률로 대략 매핑.
function inferStage(message: string, percent: number): number {
  const m = (message || '').toLowerCase()
  for (let i = TTS_STAGES.length - 1; i >= 0; i--) {
    if (TTS_STAGES[i].kw.some((k) => m.includes(k.toLowerCase()))) return i
  }
  if (percent >= 85) return 3
  if (percent >= 40) return 2
  if (percent >= 15) return 1
  return 0
}

export default function ProgressBar() {
  const { status, progress, progressMessage, mode } = useAppStore()
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
  const pct = Math.round(progress)

  // 취소 신호(진행 메시지에 '취소') — 실제 트리거는 통합 담당이 결정, 여기선 표시만 조건부.
  const cancelling = /취소/.test(progressMessage || '')
  const stageIdx = mode === 'tts' ? inferStage(progressMessage, progress) : -1
  // CPU 장시간 안내: 경과가 길면 CPU 처리 가능성 안내(장치 정보는 결과 metadata에만 있어 경과로 추정).
  const showCpuHint = elapsed >= 40

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className={cancelling ? 'glass-card' : 'glass-card pulse-glow'}
      style={{ borderRadius: 16, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${cancelling ? '취소 중' : progressMessage} ${pct}%`}
      aria-label="처리 진행률"
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <motion.div
            className={cancelling ? 'cancelling-indicator' : undefined}
            animate={cancelling ? undefined : { rotate: 360 }}
            transition={cancelling ? undefined : { duration: 1.5, repeat: Infinity, ease: 'linear' }}
            aria-hidden="true"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={cancelling ? 'var(--amber)' : 'var(--accent)'} strokeWidth="2.5" strokeLinecap="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          </motion.div>
          {/* 메시지는 aria-live로 변경 시 낭독. role=progressbar가 이미 valuetext를 갖지만
              단계 문구 변화를 놓치지 않도록 status 라이브 리전을 함께 둔다. */}
          <span aria-live="polite" style={{ fontSize: 13, fontWeight: 500, color: cancelling ? 'var(--amber)' : 'var(--text-secondary)' }}>
            {cancelling ? '취소 중…' : progressMessage}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>
            {mm}:{String(ss).padStart(2, '0')}
          </span>
          <span style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--accent-light)' }}>
            {pct}%
          </span>
        </div>
      </div>

      {/* TTS 단계 표시 — 4단계, 현재 단계 강조 */}
      {mode === 'tts' && !cancelling && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} aria-hidden="true">
          {TTS_STAGES.map((s, i) => {
            const done = i < stageIdx
            const active = i === stageIdx
            return (
              <span key={s.key} style={{
                fontSize: 11, fontWeight: active ? 700 : 500,
                padding: '3px 9px', borderRadius: 999,
                background: active ? 'var(--accent-glow)' : 'var(--bg-elevated)',
                color: active ? 'var(--accent-light)' : done ? 'var(--text-secondary)' : 'var(--text-muted)',
                border: active ? '1px solid var(--border-accent)' : '1px solid var(--border-subtle)',
              }}>
                {done ? '✓ ' : ''}{s.label}
              </span>
            )
          })}
        </div>
      )}

      <div style={{ height: 8, borderRadius: 999, overflow: 'hidden', background: 'rgba(139,92,246,0.08)' }}>
        <motion.div
          style={{ height: '100%', borderRadius: 999, background: cancelling ? 'linear-gradient(90deg, var(--amber), #f59e0b)' : 'linear-gradient(90deg, var(--accent), var(--accent-light), var(--cyan))', boxShadow: cancelling ? 'none' : '0 0 12px var(--accent-glow)' }}
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        />
      </div>

      {/* CPU 장시간 처리 안내 */}
      {showCpuHint && !cancelling && (
        <span style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          처리가 오래 걸리고 있습니다. GPU를 쓸 수 없는 환경에서는 CPU로 동작해 시간이 더 걸릴 수 있습니다 — 창을 닫지 말고 기다려 주세요.
        </span>
      )}
    </motion.div>
  )
}
