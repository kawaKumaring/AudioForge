import { useState, useEffect, useCallback } from 'react'
import { useAppStore } from '@/stores/app.store'

const EMOTION_GROUPS = [
  {
    name: '기본',
    emotions: [
      { id: 'default', label: '기본', color: 'var(--text-secondary)' },
      { id: 'narration', label: '나레이션', color: '#cbd5e1' },
      { id: 'polite', label: '공손', color: '#2dd4bf' },
      { id: 'serious', label: '진지', color: '#94a3b8' },
      { id: 'confident', label: '자신감', color: '#38bdf8' },
    ]
  },
  {
    name: '긍정',
    emotions: [
      { id: 'happy', label: '기쁨', color: '#4ade80' },
      { id: 'cheerful', label: '명랑', color: '#fb923c' },
      { id: 'excited', label: '흥분', color: '#ff6b6b' },
      { id: 'proud', label: '득의', color: '#fde047' },
      { id: 'touched', label: '감동', color: '#f472b6' },
      { id: 'curious', label: '호기심', color: '#34d399' },
      { id: 'playful', label: '장난', color: '#facc15' },
      { id: 'admiring', label: '동경', color: '#c4b5fd' },
    ]
  },
  {
    name: '부정',
    emotions: [
      { id: 'sad', label: '슬픔', color: '#60a5fa' },
      { id: 'angry', label: '화남', color: '#f87171' },
      { id: 'annoyed', label: '짜증', color: '#fdba74' },
      { id: 'scared', label: '공포', color: '#a78bfa' },
      { id: 'jealous', label: '질투', color: '#d946ef' },
      { id: 'contempt', label: '경멸', color: '#9f1239' },
      { id: 'sarcastic', label: '냉소', color: '#e879f9' },
      { id: 'mocking', label: '비꼼', color: '#a855f7' },
      { id: 'cold', label: '냉정', color: '#64748b' },
    ]
  },
  {
    name: '불안/피로',
    emotions: [
      { id: 'worried', label: '걱정', color: '#f59e0b' },
      { id: 'nervous', label: '긴장', color: '#fda4af' },
      { id: 'restless', label: '초조', color: '#ef4444' },
      { id: 'flustered', label: '당황', color: '#fca5a5' },
      { id: 'tired', label: '피곤', color: '#78716c' },
      { id: 'bored', label: '지루함', color: '#d4d4d8' },
      { id: 'sighing', label: '한숨', color: '#a1a1aa' },
      { id: 'empty', label: '허탈', color: '#6b7280' },
      { id: 'resigned', label: '체념', color: '#9ca3af' },
    ]
  },
  {
    name: '부드러움',
    emotions: [
      { id: 'whisper', label: '속삭임', color: '#c084fc' },
      { id: 'comforting', label: '위로', color: '#86efac' },
      { id: 'tender', label: '다정', color: '#f9a8d4' },
      { id: 'shy', label: '부끄러움', color: '#f9a8d4' },
      { id: 'cute', label: '애교', color: '#fb7185' },
      { id: 'tearful', label: '울먹', color: '#7dd3fc' },
      { id: 'solemn', label: '비장', color: '#475569' },
      { id: 'surprise', label: '놀람', color: '#fbbf24' },
      { id: 'longing', label: '그리움', color: '#93c5fd' },
      { id: 'bittersweet', label: '애틋', color: '#db2777' },
    ]
  },
  {
    name: '로맨스',
    emotions: [
      { id: 'flutter', label: '설렘', color: '#ff6b9d' },
      { id: 'sweet', label: '달콤', color: '#f9a8d4' },
      { id: 'charming', label: '매력', color: '#ec4899' },
      { id: 'seductive', label: '유혹', color: '#be185d' },
      { id: 'intimate', label: '은밀', color: '#831843' },
      { id: 'aroused', label: '흥분(성적)', color: '#9f1239' },
      { id: 'moaning', label: '신음', color: '#701a75' },
      { id: 'climax', label: '절정', color: '#881337' },
      { id: 'ecstasy', label: '황홀', color: '#a21caf' },
    ]
  },
]

// Flat list for reference registration
const ALL_EMOTIONS = EMOTION_GROUPS.flatMap(g => g.emotions)

export default function TTSEditor() {
  const { mode, status } = useAppStore()
  const [ttsText, setTtsText] = useState('')
  const [ttsSpeed, setTtsSpeed] = useState(1.0)
  const [ttsSilenceGap, setTtsSilenceGap] = useState(0.5)
  const [emotionRefs, setEmotionRefs] = useState<Record<string, string>>({})
  const [showEmotionSetup, setShowEmotionSetup] = useState(false)
  const disabled = status === 'processing'

  // Sync to store
  useEffect(() => {
    useAppStore.setState({ ttsText, ttsSpeed, ttsSilenceGap, ttsEmotionRefs: emotionRefs })
  }, [ttsText, ttsSpeed, ttsSilenceGap, emotionRefs])

  if (mode !== 'tts') return null

  const handleEmotionFile = async (emotionId: string) => {
    const filePath = await window.api.audio.selectFile()
    if (filePath) {
      setEmotionRefs(prev => ({ ...prev, [emotionId]: filePath }))
    }
  }

  const registeredCount = Object.keys(emotionRefs).filter(k => emotionRefs[k]).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Guide */}
      <div style={{
        borderRadius: 12, padding: '12px 16px',
        background: 'rgba(251,113,133,0.05)', border: '1px solid rgba(251,113,133,0.12)',
        fontSize: 11, lineHeight: 1.7, color: 'var(--text-secondary)'
      }}>
        <strong style={{ color: 'var(--rose)' }}>참조 음성</strong> = 위에 드롭한 파일 (기본 감정).
        감정별 음성을 추가 등록하면 대사마다 <code style={{ background: 'var(--bg-elevated)', padding: '1px 4px', borderRadius: 3 }}>[기쁨]</code> 태그로 감정을 지정할 수 있습니다.
        <br />한국어 · 영어 · 일본어 · 중국어 지원. 영어 목소리로 한국어 대사도 가능합니다.
      </div>

      {/* Emotion references (collapsible) */}
      <div style={{ borderRadius: 12, overflow: 'hidden', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <button onClick={() => setShowEmotionSetup(!showEmotionSetup)} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          width: '100%', padding: '10px 16px', border: 'none', cursor: 'pointer',
          background: 'transparent', fontFamily: 'inherit', outline: 'none'
        }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
            감정별 음성 등록
            {registeredCount > 0 && <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--rose)' }}>{registeredCount}개 등록됨</span>}
          </span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2"
            style={{ transform: showEmotionSetup ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {showEmotionSetup && (
          <div style={{ padding: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>
              각 감정의 참조 음성을 등록하세요. 미등록 감정은 기본(드롭한 파일)을 사용합니다.
            </div>
            {EMOTION_GROUPS.filter(g => g.name !== '기본').map((group) => (
              <div key={group.name} style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>{group.name}</div>
                {group.emotions.filter(e => e.id !== 'default').map((e) => (
              <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: e.color, minWidth: 55 }}>{e.label}</span>
                <div style={{
                  flex: 1, fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                }}>
                  {emotionRefs[e.id] ? emotionRefs[e.id].split(/[/\\]/).pop() : '미등록 (기본 사용)'}
                </div>
                <button onClick={() => handleEmotionFile(e.id)} disabled={disabled} style={{
                  padding: '3px 10px', borderRadius: 5, border: 'none', cursor: 'pointer',
                  fontSize: 10, fontWeight: 500, fontFamily: 'inherit',
                  background: emotionRefs[e.id] ? `${e.color}20` : 'var(--bg-elevated)',
                  color: emotionRefs[e.id] ? e.color : 'var(--text-muted)'
                }}>
                  {emotionRefs[e.id] ? '변경' : '등록'}
                </button>
                {emotionRefs[e.id] && (
                  <button onClick={() => setEmotionRefs(prev => { const n = { ...prev }; delete n[e.id]; return n })}
                    style={{ padding: '3px 6px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 10, background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                    X
                  </button>
                )}
              </div>
            ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Text input */}
      <div style={{ borderRadius: 12, overflow: 'hidden', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
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
          placeholder={"안녕하세요. 오늘 좋은 소식이 있어요.\n[기쁨] 드디어 프로젝트가 완성됐습니다!\n[슬픔] 하지만 아쉽게도 일정이 늦어졌어요.\n[속삭임] 비밀인데... 사실 보너스가 있대요.\n\n감정 태그 없으면 기본 톤으로 합성됩니다."}
          style={{
            width: '100%', height: 140, resize: 'vertical',
            padding: '12px 16px', border: 'none',
            background: 'transparent', color: 'var(--text-primary)',
            fontFamily: "'Inter', sans-serif", fontSize: 13, lineHeight: 1.7,
            outline: 'none', opacity: disabled ? 0.5 : 1
          }}
        />
        {/* Emotion tag buttons for quick insert */}
        <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-subtle)' }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>태그 삽입:</span>
          {EMOTION_GROUPS.filter(g => g.name !== '기본').map((group) => (
            <div key={group.name} style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginBottom: 4, alignItems: 'center' }}>
              <span style={{ fontSize: 9, color: 'var(--text-muted)', minWidth: 40 }}>{group.name}</span>
              {group.emotions.filter(e => e.id !== 'default').map((e) => (
                <button key={e.id} onClick={() => {
                  const tag = `[${e.label}] `
                  setTtsText(prev => prev + (prev.endsWith('\n') || prev === '' ? '' : '\n') + tag)
                }} disabled={disabled} style={{
                  padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer',
                  fontSize: 9, fontWeight: 600, fontFamily: 'inherit',
                  background: `${e.color}15`, color: e.color
                }}>
                  {e.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 10 }}>
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
