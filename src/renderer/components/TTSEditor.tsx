import { useState } from 'react'
import { useAppStore } from '@/stores/app.store'

export default function TTSEditor() {
  const { mode, status } = useAppStore()
  const [ttsText, setTtsText] = useState('')
  const [ttsSpeed, setTtsSpeed] = useState(1.0)
  const [ttsSilenceGap, setTtsSilenceGap] = useState(0.5)
  const disabled = status === 'processing'

  if (mode !== 'tts') return null

  // Store TTS params for ProcessButton to access
  useAppStore.setState({ ttsText, ttsSpeed, ttsSilenceGap })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Info */}
      <div style={{
        padding: '10px 14px', borderRadius: 10,
        background: 'rgba(251,113,133,0.06)', border: '1px solid rgba(251,113,133,0.15)',
        fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6
      }}>
        위에 드롭한 파일이 <strong style={{ color: 'var(--rose)' }}>참조 음성</strong>으로 사용됩니다 (5~30초 권장). 아래에 대사를 입력하세요.
      </div>

      {/* Text input */}
      <textarea
        value={ttsText}
        onChange={(e) => !disabled && setTtsText(e.target.value)}
        disabled={disabled}
        placeholder={"합성할 대사를 입력하세요.\n\n줄바꿈으로 문장을 구분합니다.\n각 문장이 개별적으로 합성된 후 이어붙여집니다."}
        style={{
          width: '100%', height: 150, resize: 'vertical',
          borderRadius: 12, padding: '12px 16px',
          border: '1px solid var(--border-subtle)', background: 'var(--bg-card)',
          color: 'var(--text-primary)', fontFamily: "'Inter', sans-serif",
          fontSize: 13, lineHeight: 1.7, outline: 'none',
          opacity: disabled ? 0.5 : 1
        }}
      />

      {/* Controls */}
      <div style={{ display: 'flex', gap: 12 }}>
        {/* Speed */}
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', gap: 10,
          borderRadius: 10, padding: '8px 14px',
          background: 'var(--bg-card)', border: '1px solid var(--border-subtle)'
        }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>속도</span>
          <input type="range" min="0.5" max="2.0" step="0.1" value={ttsSpeed}
            onChange={(e) => setTtsSpeed(parseFloat(e.target.value))} disabled={disabled}
            style={{ flex: 1, accentColor: 'var(--rose)', cursor: 'pointer' }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--rose)', fontVariantNumeric: 'tabular-nums', minWidth: 36, textAlign: 'right' }}>
            {ttsSpeed.toFixed(1)}x
          </span>
        </div>

        {/* Silence gap */}
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', gap: 10,
          borderRadius: 10, padding: '8px 14px',
          background: 'var(--bg-card)', border: '1px solid var(--border-subtle)'
        }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>문장 간격</span>
          <input type="range" min="0" max="2.0" step="0.1" value={ttsSilenceGap}
            onChange={(e) => setTtsSilenceGap(parseFloat(e.target.value))} disabled={disabled}
            style={{ flex: 1, accentColor: 'var(--rose)', cursor: 'pointer' }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--rose)', fontVariantNumeric: 'tabular-nums', minWidth: 36, textAlign: 'right' }}>
            {ttsSilenceGap.toFixed(1)}초
          </span>
        </div>
      </div>

      {/* Line count */}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>
        {ttsText.split('\n').filter(l => l.trim()).length}개 문장
      </div>
    </div>
  )
}
