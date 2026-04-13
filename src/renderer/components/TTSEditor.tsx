import { useState, useEffect } from 'react'
import { useAppStore } from '@/stores/app.store'

export default function TTSEditor() {
  const { mode, status } = useAppStore()
  const [ttsText, setTtsText] = useState('')
  const [ttsSpeed, setTtsSpeed] = useState(1.0)
  const [ttsSilenceGap, setTtsSilenceGap] = useState(0.5)
  const disabled = status === 'processing'

  // Sync to store
  useEffect(() => {
    useAppStore.setState({ ttsText, ttsSpeed, ttsSilenceGap })
  }, [ttsText, ttsSpeed, ttsSilenceGap])

  if (mode !== 'tts') return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Guide */}
      <div style={{
        borderRadius: 12, overflow: 'hidden',
        background: 'var(--bg-card)', border: '1px solid var(--border-subtle)'
      }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--rose)' }}>음성 합성 가이드</span>
        </div>
        <div style={{ padding: '12px 16px', fontSize: 11, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
          <div style={{ marginBottom: 8 }}>
            <strong style={{ color: 'var(--text-primary)' }}>참조 음성</strong> = 위에 드롭한 파일 (5~30초 권장)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 8, borderLeft: '2px solid var(--border-subtle)' }}>
            <div><span style={{ color: 'var(--rose)' }}>감정 톤</span> — 참조 음성의 감정이 그대로 반영됩니다</div>
            <div style={{ paddingLeft: 12, color: 'var(--text-muted)', fontSize: 10 }}>
              웃는 톤 샘플 → 밝은 음성 / 화난 톤 샘플 → 강한 음성 / 속삭임 샘플 → 속삭이는 음성
            </div>
            <div><span style={{ color: 'var(--cyan)' }}>다국어</span> — 한국어, 영어, 일본어, 중국어 지원</div>
            <div><span style={{ color: 'var(--emerald)' }}>긴 대사</span> — 줄바꿈으로 문장 구분, 각각 합성 후 이어붙임</div>
          </div>
          <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 6, background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.1)', fontSize: 10, color: 'var(--amber)' }}>
            💡 <strong>팁:</strong> 같은 사람의 기쁜/슬픈/화난 음성을 각각 저장해두면 감정별 합성이 가능합니다.
            AudioForge 대화 분리로 특정 화자 목소리를 추출하면 참조 음성으로 바로 사용할 수 있습니다.
          </div>
        </div>
      </div>

      {/* Text input */}
      <div style={{
        borderRadius: 12, overflow: 'hidden',
        background: 'var(--bg-card)', border: '1px solid var(--border-subtle)'
      }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>대사 입력</span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {ttsText.split('\n').filter(l => l.trim()).length}개 문장
          </span>
        </div>
        <textarea
          value={ttsText}
          onChange={(e) => !disabled && setTtsText(e.target.value)}
          disabled={disabled}
          placeholder={"안녕하세요. 오늘 회의를 시작하겠습니다.\n첫 번째 안건은 프로젝트 진행 상황입니다.\n각 팀별로 발표해주세요.\n\n↑ 줄바꿈으로 문장을 구분합니다"}
          style={{
            width: '100%', height: 140, resize: 'vertical',
            padding: '12px 16px', border: 'none',
            background: 'transparent', color: 'var(--text-primary)',
            fontFamily: "'Inter', sans-serif", fontSize: 13, lineHeight: 1.7,
            outline: 'none', opacity: disabled ? 0.5 : 1
          }}
        />
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 10 }}>
        {/* Speed */}
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', gap: 8,
          borderRadius: 10, padding: '8px 14px',
          background: 'var(--bg-card)', border: '1px solid var(--border-subtle)'
        }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>속도</span>
          <input type="range" min="0.5" max="2.0" step="0.1" value={ttsSpeed}
            onChange={(e) => setTtsSpeed(parseFloat(e.target.value))} disabled={disabled}
            style={{ flex: 1, accentColor: 'var(--rose)', cursor: 'pointer' }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--rose)', fontVariantNumeric: 'tabular-nums', minWidth: 32, textAlign: 'right' }}>
            {ttsSpeed.toFixed(1)}x
          </span>
        </div>

        {/* Silence gap */}
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', gap: 8,
          borderRadius: 10, padding: '8px 14px',
          background: 'var(--bg-card)', border: '1px solid var(--border-subtle)'
        }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>간격</span>
          <input type="range" min="0" max="2.0" step="0.1" value={ttsSilenceGap}
            onChange={(e) => setTtsSilenceGap(parseFloat(e.target.value))} disabled={disabled}
            style={{ flex: 1, accentColor: 'var(--rose)', cursor: 'pointer' }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--rose)', fontVariantNumeric: 'tabular-nums', minWidth: 32, textAlign: 'right' }}>
            {ttsSilenceGap.toFixed(1)}초
          </span>
        </div>
      </div>
    </div>
  )
}
