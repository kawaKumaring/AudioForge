import { useState, useEffect } from 'react'
import { useAppStore } from '@/stores/app.store'
import type { TtsReferenceEntry } from '../../shared/ttsConfig'
import { deriveRefMode } from '../../shared/ttsConfig'
import ReferenceRegionPanel from './ReferenceRegionPanel'

const EXAMPLE_TEXT = "안녕하세요. 오늘 좋은 소식이 있어요.\n[기쁨] 드디어 프로젝트가 완성됐습니다!\n[슬픔] 하지만 아쉽게도 일정이 늦어졌어요."

const PROMPT_LANGS: [string, string][] = [
  ['', '자동'], ['ko', '한국어'], ['ja', '일본어'], ['zh', '중국어'], ['en', '영어'],
]

// ⚠️ 각 emotion의 id는 Python(python/tts_worker.py의 EMOTION_TAGS 값 / EMOTION_PROMPTS 키)과
// 공유된다. id를 추가/변경하면 Python도 함께 갱신할 것. 불일치는 smoke_test._check_emotions()가
// FAIL로 잡는다(색상/그룹/한글 label은 UI 전용이라 Python과 무관). — L-3
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

// 대사 입력의 태그 삽입에서 기본 노출할 '자주 쓰는' 감정(전체는 더보기). id는 Python과 공유되는 값 그대로.
const FREQUENT_TAG_IDS = ['happy', 'sad', 'angry', 'surprise', 'whisper', 'cheerful', 'worried', 'shy']
const FREQUENT_TAGS = ALL_EMOTIONS.filter(e => FREQUENT_TAG_IDS.includes(e.id))

export default function TTSEditor() {
  const { mode, status, fileInfo } = useAppStore()
  // 로컬 상태는 store 값으로 초기화 — 빈 값으로 시작하면 아래 동기화
  // useEffect가 다른 모드에 다녀온 뒤 store의 대사/등록을 덮어써 유실시킴
  const [ttsText, setTtsText] = useState(() => useAppStore.getState().ttsText)
  const [ttsSpeed, setTtsSpeed] = useState(() => useAppStore.getState().ttsSpeed)
  const [ttsSilenceGap, setTtsSilenceGap] = useState(() => useAppStore.getState().ttsSilenceGap)
  const [emotionRefs, setEmotionRefs] = useState<Record<string, string>>(() => useAppStore.getState().ttsEmotionRefs)
  const [showEmotionSetup, setShowEmotionSetup] = useState(false)
  const [ttsEngine, setTtsEngine] = useState(() => useAppStore.getState().ttsEngine)
  const [refPrompts, setRefPrompts] = useState<Record<string, TtsReferenceEntry>>(() => useAppStore.getState().ttsReferencePrompts)
  const [showRefPrompts, setShowRefPrompts] = useState(false)
  const [txLoading, setTxLoading] = useState<string | null>(null)
  const [preflight, setPreflight] = useState<{ available?: boolean; snapshot_ok?: boolean; device_expected?: string; reason?: string } | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showAllTags, setShowAllTags] = useState(false)
  const disabled = status === 'processing'

  // Sync to store
  useEffect(() => {
    useAppStore.setState({ ttsText, ttsSpeed, ttsSilenceGap, ttsEmotionRefs: emotionRefs, ttsReferencePrompts: refPrompts, ttsEngine })
  }, [ttsText, ttsSpeed, ttsSilenceGap, emotionRefs, refPrompts, ttsEngine])

  // Qwen 실행 전 상태(preflight) — 마운트 시 1회. 예상값이며 실행 결과는 결과 화면 metadata가 최종.
  useEffect(() => {
    if (mode !== 'tts') return
    let cancelled = false
    window.api.audio.qwenPreflight()
      .then((p: unknown) => { if (!cancelled) setPreflight(p as typeof preflight) })
      .catch(() => { if (!cancelled) setPreflight(null) })
    return () => { cancelled = true }
  }, [mode])

  const updateRef = (id: string, patch: Partial<TtsReferenceEntry>) =>
    setRefPrompts(prev => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }))

  const autoTranscribe = async (id: string, path: string) => {
    if (!path || txLoading) return
    setTxLoading(id)
    try {
      const t = await window.api.audio.transcribeReference(path) as {
        status?: string; text?: string; language?: string; error_message?: string
      }
      const ok = t?.status === 'ok'
      // 자동 결과는 autoText에만 저장한다. manualText에 자동 복사하지 않는다 —
      // 사용자가 '수정하여 사용'을 눌러 명시적으로 전환해야만 수동(manual)이 된다.
      updateRef(id, {
        autoStatus: t?.status || 'failed',
        autoText: ok ? (t?.text ?? '') : '',
        autoLang: ok ? (t?.language ?? '') : '',
        autoError: ok ? undefined : (t?.error_message || t?.status || '전사 실패')
      })
    } catch (e) {
      // 실패를 조용히 무시하지 않고 UI에 표시
      updateRef(id, { autoStatus: 'failed', autoError: (e as Error)?.message || '전사 실패' })
    } finally {
      setTxLoading(null)
    }
  }

  // '수정하여 사용': 자동 결과를 수동 칸으로 옮기고 store mode도 manual로 전환(UI=직렬화 일치).
  const useAutoAsManual = (id: string) =>
    updateRef(id, { manualText: (refPrompts[id]?.autoText || ''), mode: 'manual' })

  // 수동문 편집: 내용이 있으면 manual, 완전히 비우면 auto로 복귀(ref-free일 때는 이 경로가 비활성).
  const onManualEdit = (id: string, text: string) =>
    updateRef(id, { manualText: text, mode: text.trim() ? 'manual' : 'auto' })

  // ref-free 토글: 켜면 ref_free, 끄면 남은 수동문 유무로 mode 복원.
  const onRefFreeToggle = (id: string, checked: boolean) =>
    updateRef(id, { mode: checked ? 'ref_free' : ((refPrompts[id]?.manualText || '').trim() ? 'manual' : 'auto') })

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
      {/* 참조 음성: 분석·구간 선택(3~10초)·파생 클립 준비 */}
      <ReferenceRegionPanel />

      {/* Guide */}
      <div style={{
        borderRadius: 12, padding: '12px 16px',
        background: 'rgba(251,113,133,0.05)', border: '1px solid rgba(251,113,133,0.12)',
        fontSize: 12, lineHeight: 1.7, color: 'var(--text-secondary)'
      }}>
        <strong style={{ color: 'var(--rose)' }}>참조 음성</strong> = 위에 올린 파일의 목소리를 흉내 냅니다.
        감정별 음성을 추가 등록하면 대사마다 <code style={{ background: 'var(--bg-elevated)', padding: '1px 4px', borderRadius: 3 }}>[기쁨]</code> 태그로 감정을 지정할 수 있습니다.
        <br />한국어 · 영어 · 일본어 · 중국어 지원. 영어 목소리로 한국어 대사도 가능합니다.
      </div>

      {/* Qwen 실행 전 상태(preflight) — 예상값. 실제 엔진·장치는 합성 후 결과 화면에 표시 */}
      {preflight && (() => {
        const ok = preflight.available === true
        const snapMissing = !ok && preflight.snapshot_ok === false
        const dev = preflight.device_expected
        const msg = ok
          ? (dev === 'gpu' ? 'Qwen3 준비됨 · 완전 로컬 · GPU 예상'
            : dev === 'cpu' ? 'Qwen3 준비됨 · 완전 로컬 · VRAM 부족으로 CPU 예상'
            : 'Qwen3 준비됨 · 완전 로컬')
          : (snapMissing ? 'Qwen3 모델 스냅샷 누락 · 자동 선택 시 GPT-SoVITS 사용 예정'
            : 'Qwen3 미설치 · 자동 선택 시 GPT-SoVITS 사용 예정')
        const color = ok ? 'var(--cyan)' : 'var(--text-muted)'
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color, padding: '2px 2px' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: ok ? 'var(--cyan)' : 'var(--text-muted)', flexShrink: 0 }} />
            <span>{msg}</span>
            <span style={{ color: 'var(--text-muted)' }}>· 예상값(실제 결과는 합성 후 표시)</span>
          </div>
        )
      })()}

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

      {/* 참조 전사 (선택 — 수동 입력·언어). GPT-SoVITS 클로닝 품질용. */}
      <div style={{ borderRadius: 12, overflow: 'hidden', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <button onClick={() => setShowRefPrompts(!showRefPrompts)} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          width: '100%', padding: '10px 16px', border: 'none', cursor: 'pointer',
          background: 'transparent', fontFamily: 'inherit', outline: 'none'
        }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
            참조 전사 <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>(선택 — 수동 입력·언어)</span>
          </span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2"
            style={{ transform: showRefPrompts ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {showRefPrompts && (
          <div style={{ padding: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              참조 음성이 무슨 말을 하는지 적어두면 목소리를 더 정확히 흉내 냅니다. 자동 전사가 틀리면 직접 고치거나 입력하세요.
              비워두면 자동 전사를 사용합니다. (10초 초과 파일은 확정한 구간만 전사합니다.)
            </div>
            {[
              { id: 'default', label: '기본 참조', path: fileInfo?.path || '' },
              ...ALL_EMOTIONS.filter(e => e.id !== 'default' && emotionRefs[e.id]).map(e => ({ id: e.id, label: e.label, path: emotionRefs[e.id] }))
            ].map(ref => {
              const entry = refPrompts[ref.id] || {}
              const effMode = deriveRefMode(entry)  // 우선순위: ref_free > manual > auto
              const refFree = effMode === 'ref_free'
              const eff = refFree ? '전사문 없이' : (effMode === 'manual' ? '직접 입력' : '자동 인식')
              const effColor = refFree ? 'var(--text-muted)' : (effMode === 'manual' ? 'var(--rose)' : 'var(--cyan)')
              return (
                <div key={ref.id} style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', minWidth: 62 }}>{ref.label}</span>
                    <span style={{ fontSize: 9, fontWeight: 600, color: effColor, padding: '1px 6px', borderRadius: 4, background: 'var(--bg-elevated)' }}>{eff}</span>
                    <span style={{ flex: 1, fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {ref.path ? ref.path.split(/[/\\]/).pop() : '파일 없음'}
                    </span>
                    <button onClick={() => autoTranscribe(ref.id, ref.path)} disabled={disabled || !ref.path || !!txLoading} style={{
                      padding: '3px 10px', borderRadius: 5, border: 'none', cursor: 'pointer',
                      fontSize: 10, fontWeight: 500, fontFamily: 'inherit',
                      background: 'var(--bg-elevated)', color: 'var(--text-secondary)', opacity: (disabled || !ref.path || !!txLoading) ? 0.5 : 1
                    }}>
                      {txLoading === ref.id ? '전사 중...' : '자동 전사'}
                    </button>
                  </div>
                  {entry.autoStatus === 'ok' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 9, color: 'var(--text-muted)' }}>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        자동 전사: {entry.autoLang || '?'} · {(entry.autoText || '').length}자 · "{(entry.autoText || '').slice(0, 30)}"
                      </span>
                      <button onClick={() => useAutoAsManual(ref.id)} disabled={disabled || refFree || !entry.autoText} style={{
                        padding: '2px 8px', borderRadius: 4, border: 'none', cursor: 'pointer',
                        fontSize: 9, fontWeight: 600, fontFamily: 'inherit',
                        background: 'var(--accent-glow, rgba(56,189,248,0.15))', color: 'var(--cyan)',
                        opacity: (disabled || refFree || !entry.autoText) ? 0.5 : 1
                      }}>수정하여 사용</button>
                    </div>
                  )}
                  {entry.autoStatus && entry.autoStatus !== 'ok' && (
                    <div style={{ fontSize: 9, color: 'var(--rose)' }}>
                      자동 전사 실패({entry.autoStatus}): {entry.autoError || '알 수 없는 오류'}
                    </div>
                  )}
                  <textarea value={entry.manualText || ''} onChange={(e) => onManualEdit(ref.id, e.target.value)}
                    disabled={disabled || refFree}
                    placeholder="수동 전사문 (비우면 자동 전사 사용). '자동 전사' 후 '수정하여 사용'으로 불러올 수 있습니다."
                    style={{
                      width: '100%', height: 42, resize: 'vertical', padding: '6px 8px',
                      borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
                      color: 'var(--text-primary)', fontFamily: "'Inter', sans-serif", fontSize: 11, outline: 'none',
                      opacity: (disabled || refFree) ? 0.5 : 1
                    }} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>언어</span>
                    <select value={entry.promptLang || ''} onChange={(e) => updateRef(ref.id, { promptLang: e.target.value })} disabled={disabled}
                      style={{ fontSize: 10, padding: '2px 6px', borderRadius: 5, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontFamily: 'inherit' }}>
                      {PROMPT_LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-muted)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={refFree} disabled={disabled}
                        onChange={(e) => onRefFreeToggle(ref.id, e.target.checked)} />
                      전사문 없이 사용(화자 특성만 · 유사도 저하 가능)
                    </label>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Text input */}
      <div style={{ borderRadius: 12, overflow: 'hidden', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>대사 입력</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {!ttsText.trim() && (
              <button onClick={() => !disabled && setTtsText(EXAMPLE_TEXT)} disabled={disabled} style={{
                padding: '3px 10px', borderRadius: 5, border: 'none', cursor: 'pointer',
                fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
                background: 'var(--bg-elevated)', color: 'var(--cyan)'
              }}>예문 불러오기</button>
            )}
            <span style={{ fontSize: 11, color: ttsText.trim() ? 'var(--text-muted)' : 'var(--rose)' }}>
              {ttsText.trim() ? `${ttsText.split('\n').filter(l => l.trim()).length}개 문장` : '합성할 대사를 입력하세요'}
            </span>
          </div>
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
        {/* 태그 삽입 — 자주 쓰는 것만 기본, 전체는 더보기 */}
        <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>감정 태그 삽입:</span>
            <button onClick={() => setShowAllTags(v => !v)} style={{
              padding: '1px 8px', borderRadius: 4, border: 'none', cursor: 'pointer',
              fontSize: 10, fontWeight: 600, fontFamily: 'inherit',
              background: 'var(--bg-elevated)', color: 'var(--text-secondary)'
            }}>{showAllTags ? '접기' : '더보기(전체)'}</button>
          </div>
          {!showAllTags ? (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {FREQUENT_TAGS.map((e) => (
                <button key={e.id} onClick={() => {
                  const tag = `[${e.label}] `
                  setTtsText(prev => prev + (prev.endsWith('\n') || prev === '' ? '' : '\n') + tag)
                }} disabled={disabled} style={{
                  padding: '3px 9px', borderRadius: 4, border: 'none', cursor: 'pointer',
                  fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
                  background: `${e.color}15`, color: e.color
                }}>{e.label}</button>
              ))}
            </div>
          ) : (
            EMOTION_GROUPS.filter(g => g.name !== '기본').map((group) => (
              <div key={group.name} style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginBottom: 4, alignItems: 'center' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 44 }}>{group.name}</span>
                {group.emotions.filter(e => e.id !== 'default').map((e) => (
                  <button key={e.id} onClick={() => {
                    const tag = `[${e.label}] `
                    setTtsText(prev => prev + (prev.endsWith('\n') || prev === '' ? '' : '\n') + tag)
                  }} disabled={disabled} style={{
                    padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer',
                    fontSize: 10, fontWeight: 600, fontFamily: 'inherit',
                    background: `${e.color}15`, color: e.color
                  }}>{e.label}</button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      {/* 고급 설정 — 엔진 직접 선택 · 속도 · 간격 (기본 화면 단순화). 기본 접힘. */}
      <div style={{ borderRadius: 12, overflow: 'hidden', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <button onClick={() => setShowAdvanced(v => !v)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '10px 16px', border: 'none', cursor: 'pointer', background: 'transparent', fontFamily: 'inherit', outline: 'none' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>고급 설정 <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>(엔진 직접 선택 · 속도 · 간격)</span></span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" style={{ transform: showAdvanced ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}><polyline points="6 9 12 15 18 9" /></svg>
        </button>
        {showAdvanced && (<div style={{ padding: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Engine + Controls */}
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          borderRadius: 10, padding: '8px 14px',
          background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', flexShrink: 0
        }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }} title="목소리를 합성하는 AI 엔진 선택">엔진</span>
          {[
            { id: 'auto', label: '자동', hint: '언어에 맞춰 최적 엔진 자동 선택 (한국어는 Qwen3 우선, 미설치 시 GPT-SoVITS) (권장)' },
            { id: 'qwen3', label: 'Qwen3', hint: '한국어 제로샷 발음·운율 우수 (로컬 Qwen3-TTS 0.6B, 별도 venv 필요 — 미설치 시 자동 폴백)' },
            { id: 'gptsovits', label: 'GPT-SoVITS', hint: '한/영/중 지원, 참조 음성으로 목소리 클로닝 (베타)' },
            { id: 'f5tts', label: 'F5', hint: '영어 중심의 고품질 보이스 클로닝' },
            { id: 'kokoro', label: 'Kokoro', hint: '한/일/중/영 다국어 폴백 엔진, 가벼움' },
          ].map(e => (
            <button key={e.id} onClick={() => !disabled && setTtsEngine(e.id)} disabled={disabled} title={e.hint} style={{
              padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer',
              fontSize: 9, fontWeight: 600, fontFamily: 'inherit',
              background: ttsEngine === e.id ? 'var(--rose)' : 'transparent',
              color: ttsEngine === e.id ? '#fff' : 'var(--text-muted)'
            }}>{e.label}</button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', gap: 8,
          borderRadius: 10, padding: '8px 14px',
          background: 'var(--bg-card)', border: '1px solid var(--border-subtle)'
        }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title="말하기 속도 (1.0 = 기본, 낮을수록 느리게)">속도</span>
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
          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title="문장과 문장 사이에 넣을 무음 길이(초)">간격</span>
          <input type="range" min="0" max="2.0" step="0.1" value={ttsSilenceGap}
            onChange={(e) => setTtsSilenceGap(parseFloat(e.target.value))} disabled={disabled}
            style={{ flex: 1, accentColor: 'var(--rose)', cursor: 'pointer' }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--rose)', fontVariantNumeric: 'tabular-nums', minWidth: 32, textAlign: 'right' }}>
            {ttsSilenceGap.toFixed(1)}초
          </span>
        </div>
      </div>
        </div>)}
      </div>
    </div>
  )
}
