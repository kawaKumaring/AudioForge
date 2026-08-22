import { useState, useEffect, useRef, useMemo } from 'react'
import { useAppStore } from '@/stores/app.store'
import type { TtsReferenceEntry, PitchCapability } from '../../shared/ttsConfig'
import { deriveRefMode } from '../../shared/ttsConfig'
import ReferenceRegionPanel from './ReferenceRegionPanel'
import { EMOTION_GROUPS, ALL_EMOTIONS, FREQUENT_TAGS, parseUsedEmotionIds } from '@/lib/emotions'

const EXAMPLE_TEXT = "안녕하세요. 오늘 좋은 소식이 있어요.\n[기쁨] 드디어 프로젝트가 완성됐습니다!\n[슬픔] 하지만 아쉽게도 일정이 늦어졌어요."

const PROMPT_LANGS: [string, string][] = [
  ['', '자동'], ['ko', '한국어'], ['ja', '일본어'], ['zh', '중국어'], ['en', '영어'],
]

export default function TTSEditor() {
  const { mode, status, fileInfo, ttsEmotionRefState, registerEmotionRef, removeEmotionRef, setEmotionRefState, setTtsRefState, ttsPitchCapability, setTtsPitchCapability } = useAppStore()
  // 로컬 상태는 store 값으로 초기화 — 빈 값으로 시작하면 아래 동기화
  // useEffect가 다른 모드에 다녀온 뒤 store의 대사/등록을 덮어써 유실시킴
  const [ttsText, setTtsText] = useState(() => useAppStore.getState().ttsText)
  const [ttsSpeed, setTtsSpeed] = useState(() => useAppStore.getState().ttsSpeed)
  const [ttsSilenceGap, setTtsSilenceGap] = useState(() => useAppStore.getState().ttsSilenceGap)
  const [ttsPitch, setTtsPitch] = useState(() => useAppStore.getState().ttsPitch)
  const [showEmotionSetup, setShowEmotionSetup] = useState(false)
  const [ttsEngine, setTtsEngine] = useState(() => useAppStore.getState().ttsEngine)
  const [refPrompts, setRefPrompts] = useState<Record<string, TtsReferenceEntry>>(() => useAppStore.getState().ttsReferencePrompts)
  const [showRefPrompts, setShowRefPrompts] = useState(false)
  const [txLoading, setTxLoading] = useState<string | null>(null)
  const [preflight, setPreflight] = useState<{ available?: boolean; snapshot_ok?: boolean; device_expected?: string; reason?: string } | null>(null)
  // pitch capability는 store 단일 소스(ProcessButton도 같은 상태를 gate에 소비). 여기선 probe해 기록만.
  const pitchCap = ttsPitchCapability
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showAllTags, setShowAllTags] = useState(false)
  const [showUnregistered, setShowUnregistered] = useState(false)
  // 등록된 감정 항목별 접힘(구간 패널 숨김) — id 집합. 기본은 펼침.
  const [collapsedRefs, setCollapsedRefs] = useState<Record<string, boolean>>({})
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const disabled = status === 'processing'

  // Sync to store (감정 참조 상태는 store가 단일 소스라 여기서 동기화하지 않는다)
  useEffect(() => {
    useAppStore.setState({ ttsText, ttsSpeed, ttsSilenceGap, ttsPitch, ttsReferencePrompts: refPrompts, ttsEngine })
  }, [ttsText, ttsSpeed, ttsSilenceGap, ttsPitch, refPrompts, ttsEngine])

  // Qwen 실행 전 상태(preflight) — 마운트 시 1회. 예상값이며 실행 결과는 결과 화면 metadata가 최종.
  useEffect(() => {
    if (mode !== 'tts') return
    let cancelled = false
    window.api.audio.qwenPreflight()
      .then((p: unknown) => { if (!cancelled) setPreflight(p as typeof preflight) })
      .catch(() => { if (!cancelled) setPreflight(null) })
    return () => { cancelled = true }
  }, [mode])

  // pitch 후처리 capability(§6) — ffmpeg rubberband 지원 여부. 미지원이면 음높이 슬라이더를 비활성하고
  // 사유를 표시한다(조용한 무시 금지). preload가 raw {available, reason}를 주면 계약 형태로 정규화.
  useEffect(() => {
    if (mode !== 'tts') return
    let cancelled = false
    // 핸들러(audio:pitch-preflight)가 이미 normalizePitchCapability로 최종 계약(PitchCapability)을 반환한다.
    // 여기서 다시 normalize하면 이중 정규화로 뭉개지므로(PitchCapability엔 available 필드가 없음) 직접 소비한다.
    window.api.audio.pitchPreflight()
      .then((cap: unknown) => {
        if (cancelled) return
        const c = cap as PitchCapability | null
        setTtsPitchCapability(c && typeof c.probed === 'boolean' ? c : { supported: false, method: 'none', probed: true, reason: 'pitch-probe-failed' })
      })
      .catch(() => { if (!cancelled) setTtsPitchCapability({ supported: false, method: 'none', probed: true, reason: 'pitch-probe-failed' }) })
    return () => { cancelled = true }
  }, [mode])

  const updateRef = (id: string, patch: Partial<TtsReferenceEntry>) =>
    setRefPrompts(prev => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }))

  // 수동 전사 '확정' 시 그 참조 source의 지문을 전사 항목에 stamp(§4). 합성 경계에서 현재 source 지문과
  // 대조해 원본 교체/내용 변경 시 stale로 폐기하는 계약과 연결된다. 지문은 항상 source(원본) 기준 —
  // 파생 클립(effective)이 아니라 통합 담당이 만드는 지문 맵과 같은 축이어야 한다.
  const stampFingerprint = async (id: string, sourcePath: string) => {
    if (!sourcePath) return
    try {
      const fp = await window.api.audio.fingerprintReference(sourcePath)
      if (fp) updateRef(id, { sourceFingerprint: fp })
    } catch { /* 지문 실패 시 stamp 생략 — 불변식(4)이 미기록을 '보존'으로 처리 */ }
  }

  // 감정 태그를 대사 textarea의 커서/선택 위치에 삽입하고 focus·커서를 복원(끝에 붙이지 않는다).
  const insertEmotionTag = (label: string) => {
    if (disabled) return
    const el = textareaRef.current
    const cur = ttsText
    const start = el ? el.selectionStart : cur.length
    const end = el ? el.selectionEnd : cur.length
    const before = cur.slice(0, start)
    const after = cur.slice(end)
    // 태그는 줄 단위로 적용 — 앞이 줄바꿈/비어있지 않으면 줄바꿈을 먼저 넣는다.
    const needNL = before.length > 0 && !before.endsWith('\n')
    const insert = (needNL ? '\n' : '') + `[${label}] `
    const next = before + insert + after
    const caret = (before + insert).length
    setTtsText(next)
    // setState 반영 후 커서 복원 — 다음 프레임에 focus + selection.
    requestAnimationFrame(() => {
      const t = textareaRef.current
      if (!t) return
      t.focus()
      try { t.setSelectionRange(caret, caret) } catch { /* noop */ }
    })
  }

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
  // 확정된 수동 전사이므로 그 참조 source의 지문을 함께 stamp(§4).
  const useAutoAsManual = (id: string, sourcePath: string) => {
    updateRef(id, { manualText: (refPrompts[id]?.autoText || ''), mode: 'manual' })
    void stampFingerprint(id, sourcePath)
  }

  // 수동문 편집: 내용이 있으면 manual, 완전히 비우면 auto로 복귀(ref-free일 때는 이 경로가 비활성).
  const onManualEdit = (id: string, text: string) =>
    updateRef(id, { manualText: text, mode: text.trim() ? 'manual' : 'auto' })

  // ref-free 토글: 켜면 ref_free, 끄면 남은 수동문 유무로 mode 복원.
  const onRefFreeToggle = (id: string, checked: boolean) =>
    updateRef(id, { mode: checked ? 'ref_free' : ((refPrompts[id]?.manualText || '').trim() ? 'manual' : 'auto') })

  if (mode !== 'tts') return null

  // 감정 원본 등록/변경 → store에 source 기록(파생 상태 초기화·그 clipKey 정리). 아래 구간 패널이 재분석.
  const handleEmotionFile = async (emotionId: string) => {
    const filePath = await window.api.audio.selectFile()
    if (filePath) registerEmotionRef(emotionId, filePath)
  }

  // 감정 요약(§1) — 대사에 실제 쓰인 감정 id + 등록/준비/확정필요 집계. 등록 감정을 먼저 노출(§2)한다.
  const usedIds = useMemo(() => parseUsedEmotionIds(ttsText), [ttsText])
  const nonDefaultEmotions = useMemo(() => ALL_EMOTIONS.filter(e => e.id !== 'default'), [])
  const registeredEmotions = nonDefaultEmotions.filter(e => ttsEmotionRefState[e.id]?.source)
  const unregisteredEmotions = nonDefaultEmotions.filter(e => !ttsEmotionRefState[e.id]?.source)
  const registeredCount = registeredEmotions.length
  const readyCount = registeredEmotions.filter(e => ttsEmotionRefState[e.id]?.ready).length
  const needsConfirmCount = registeredCount - readyCount
  // 대사에서 쓰였지만 미등록 → 기본 참조로 합성(§3). 개수와 목록 표시에 사용.
  const usedUnregistered = unregisteredEmotions.filter(e => usedIds.has(e.id))
  const usedCount = nonDefaultEmotions.filter(e => usedIds.has(e.id)).length

  const toggleCollapse = (id: string) => setCollapsedRefs(prev => ({ ...prev, [id]: !prev[id] }))

  // pitch capability(§6·계약 G): supported로 확정된 경우에만 슬라이더 활성. 미확인(unknown/probe 전)과
  // 미지원(probed·unsupported)은 모두 잠근다(미probe인데 활성화되던 회귀 수정). reset은 capability와 무관.
  const pitchSupported = !!pitchCap && pitchCap.supported
  const pitchProbedUnsupported = !!pitchCap && pitchCap.probed && !pitchCap.supported
  const pitchUnknown = !pitchSupported && !pitchProbedUnsupported   // null 또는 probed=false
  const pitchDisabled = disabled || !pitchSupported

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 기본 참조 음성: 분석·구간 선택(3~10초)·파생 클립 준비 */}
      {fileInfo?.path && (
        <ReferenceRegionPanel
          clipKey="default"
          path={fileInfo.path}
          disabled={disabled}
          onState={setTtsRefState}
          label="참조 음성"
        />
      )}

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

      {/* Emotion references (collapsible) — 등록 감정 우선 노출 + 상태 요약(§1·§2·§3) */}
      <div style={{ borderRadius: 12, overflow: 'hidden', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
        <button onClick={() => setShowEmotionSetup(!showEmotionSetup)} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          width: '100%', padding: '10px 16px', border: 'none', cursor: 'pointer',
          background: 'transparent', fontFamily: 'inherit', outline: 'none', gap: 8
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>감정별 음성 등록</span>
            {/* 상태 요약: 등록 / 준비됨 / 확정 필요 / 대사에서 사용 */}
            {registeredCount > 0 && <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)' }}>등록 {registeredCount}</span>}
            {readyCount > 0 && <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--cyan)' }}>준비됨 {readyCount}</span>}
            {needsConfirmCount > 0 && <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--rose)' }}>확정 필요 {needsConfirmCount}</span>}
            {usedCount > 0 && <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)' }}>대사에서 사용 {usedCount}</span>}
          </span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2"
            style={{ flexShrink: 0, transform: showEmotionSetup ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {showEmotionSetup && (
          <div style={{ padding: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, lineHeight: 1.6 }}>
              각 감정의 참조 음성을 등록하세요. 미등록 감정은 기본 참조(위에 올린 파일)를 사용합니다.
              10초를 넘는 파일은 등록 후 아래에서 <strong style={{ color: 'var(--rose)' }}>3~10초 구간</strong>을 골라 확정하세요.
              감정은 그 참조 음성으로 근사합니다(대사에 실제로 쓴 감정만 준비되면 됩니다).
            </div>

            {/* 대사에 쓰였지만 미등록 → 기본 참조 사용(§3). 미등록 섹션이 접혀 있어도 항상 안내. */}
            {usedUnregistered.length > 0 && (
              <div style={{ fontSize: 10, lineHeight: 1.6, color: 'var(--text-secondary)', padding: '6px 10px', borderRadius: 6, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                대사에 쓰인 <span style={{ color: 'var(--text-muted)' }}>
                  {usedUnregistered.map(e => e.label).join(', ')}
                </span> 은(는) 아직 미등록입니다 → <strong style={{ color: 'var(--rose)' }}>기본 참조</strong>로 합성됩니다.
              </div>
            )}

            {/* ── 등록된 감정 (우선 노출) ── */}
            {registeredEmotions.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)' }}>등록된 감정</div>
                {registeredEmotions.map((e) => {
                  const slot = ttsEmotionRefState[e.id]
                  const src = slot?.source || ''
                  const base = src ? (src.split(/[/\\]/).pop() || src) : ''
                  const collapsed = !!collapsedRefs[e.id]
                  const used = usedIds.has(e.id)
                  return (
                    <div key={e.id} style={{ marginBottom: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                        <button onClick={() => toggleCollapse(e.id)} title={collapsed ? '구간 패널 펼치기' : '구간 패널 접기'}
                          style={{ display: 'flex', alignItems: 'center', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2"
                            style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                        <span style={{ fontSize: 11, fontWeight: 600, color: e.color, minWidth: 55 }}>{e.label}</span>
                        <div style={{ flex: 1, fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{base}</div>
                        {used && <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-secondary)', padding: '1px 6px', borderRadius: 4, background: 'var(--bg-elevated)' }}>대사에서 사용</span>}
                        {slot && (slot.ready
                          ? <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--cyan)' }}>준비됨</span>
                          : <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--rose)' }} title={slot.message || ''}>확정 필요</span>
                        )}
                        <button onClick={() => handleEmotionFile(e.id)} disabled={disabled} style={{
                          padding: '3px 10px', borderRadius: 5, border: 'none', cursor: 'pointer',
                          fontSize: 10, fontWeight: 500, fontFamily: 'inherit',
                          background: `${e.color}20`, color: e.color, opacity: disabled ? 0.5 : 1
                        }}>변경</button>
                        <button onClick={() => removeEmotionRef(e.id)} disabled={disabled}
                          style={{ padding: '3px 6px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 10, background: 'var(--bg-elevated)', color: 'var(--text-muted)', opacity: disabled ? 0.5 : 1 }}>
                          X
                        </button>
                      </div>
                      {/* 등록된 감정: 3~10초 구간 선택 패널(긴 파일 대응). key에 source 포함 → 파일 변경 시 재마운트. 항목별로 접을 수 있다(§2). */}
                      {!collapsed && (
                        <ReferenceRegionPanel
                          key={src}
                          clipKey={e.id}
                          path={src}
                          disabled={disabled}
                          onState={(s) => setEmotionRefState(e.id, s)}
                          label={`${e.label} 참조`}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>아직 등록된 감정이 없습니다. 아래에서 감정을 추가하세요.</div>
            )}

            {/* ── 미등록 감정 (접기) ── */}
            {unregisteredEmotions.length > 0 && (
              <div style={{ marginTop: 4 }}>
                <button onClick={() => setShowUnregistered(v => !v)} style={{
                  display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '6px 0',
                  border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', outline: 'none'
                }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2"
                    style={{ transform: showUnregistered ? 'rotate(0)' : 'rotate(-90deg)', transition: 'transform 0.2s' }}>
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                  <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)' }}>미등록 감정 추가 ({unregisteredEmotions.length})</span>
                </button>
                {showUnregistered && EMOTION_GROUPS.filter(g => g.name !== '기본').map((group) => {
                  const items = group.emotions.filter(e => e.id !== 'default' && !ttsEmotionRefState[e.id]?.source)
                  if (items.length === 0) return null
                  return (
                    <div key={group.name} style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>{group.name}</div>
                      {items.map((e) => {
                        const used = usedIds.has(e.id)
                        return (
                          <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                            <span style={{ fontSize: 11, fontWeight: 600, color: e.color, minWidth: 55 }}>{e.label}</span>
                            <div style={{ flex: 1, fontSize: 10, color: used ? 'var(--text-secondary)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {used ? '대사에서 사용 · 기본 참조로 합성' : '미등록 (기본 사용)'}
                            </div>
                            <button onClick={() => handleEmotionFile(e.id)} disabled={disabled} style={{
                              padding: '3px 10px', borderRadius: 5, border: 'none', cursor: 'pointer',
                              fontSize: 10, fontWeight: 500, fontFamily: 'inherit',
                              background: 'var(--bg-elevated)', color: 'var(--text-muted)', opacity: disabled ? 0.5 : 1
                            }}>등록</button>
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            )}
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
              // sourcePath = 지문 stamp 기준(항상 원본 source). 전사(path)는 effective(파생 클립) 우선이지만
              // stale 판정 지문은 통합 담당의 지문 맵과 같은 축(원본)이어야 하므로 별도로 들고 다닌다(§4/§9).
              { id: 'default', label: '기본 참조', path: fileInfo?.path || '', sourcePath: fileInfo?.path || '' },
              // 감정 참조 전사 대상은 effective(확정 파생 클립) 우선, 없으면 원본 — 10초 초과는 확정 구간만 전사.
              ...ALL_EMOTIONS.filter(e => e.id !== 'default' && ttsEmotionRefState[e.id]?.source)
                .map(e => ({ id: e.id, label: e.label, path: ttsEmotionRefState[e.id].clip || ttsEmotionRefState[e.id].source, sourcePath: ttsEmotionRefState[e.id].source }))
            ].map(ref => {
              const entry = refPrompts[ref.id] || {}
              const effMode = deriveRefMode(entry)  // 우선순위: ref_free > manual > auto
              const refFree = effMode === 'ref_free'
              // 용어 통일(§4): 자동 전사 / 직접 입력 / 화자 특성만
              const eff = refFree ? '화자 특성만' : (effMode === 'manual' ? '직접 입력' : '자동 전사')
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
                      <button onClick={() => useAutoAsManual(ref.id, ref.sourcePath)} disabled={disabled || refFree || !entry.autoText} style={{
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
                    onBlur={() => { if ((entry.manualText || '').trim() && !refFree) void stampFingerprint(ref.id, ref.sourcePath) }}
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
                      화자 특성만 사용 (전사문 없이 · 유사도 저하 가능)
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
          ref={textareaRef}
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
                <button key={e.id} onClick={() => insertEmotionTag(e.label)} disabled={disabled} style={{
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
                  <button key={e.id} onClick={() => insertEmotionTag(e.label)} disabled={disabled} style={{
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
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>고급 설정 <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>(엔진 직접 선택 · 속도 · 간격 · 음높이)</span></span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" style={{ transform: showAdvanced ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}><polyline points="6 9 12 15 18 9" /></svg>
        </button>
        {showAdvanced && (<div style={{ padding: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Engine + Controls */}
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
          borderRadius: 10, padding: '8px 14px', width: '100%',
          background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)'
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
      {/* 작은 창 반응형(§8): flex-basis + flexWrap → 넓으면 3열, 좁으면 2열/1열로 접힘 */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div style={{
          flex: '1 1 200px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 8,
          borderRadius: 10, padding: '8px 14px',
          background: 'var(--bg-card)', border: '1px solid var(--border-subtle)'
        }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title="말하기 속도 (1.0 = 기본, 낮을수록 느리게)">속도</span>
          <input type="range" min="0.5" max="2.0" step="0.1" value={ttsSpeed}
            onChange={(e) => setTtsSpeed(parseFloat(e.target.value))} disabled={disabled}
            style={{ flex: 1, minWidth: 0, accentColor: 'var(--rose)', cursor: 'pointer' }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--rose)', fontVariantNumeric: 'tabular-nums', minWidth: 32, textAlign: 'right' }}>
            {ttsSpeed.toFixed(1)}x
          </span>
        </div>
        <div style={{
          flex: '1 1 200px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 8,
          borderRadius: 10, padding: '8px 14px',
          background: 'var(--bg-card)', border: '1px solid var(--border-subtle)'
        }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title="문장과 문장 사이에 넣을 무음 길이(초)">간격</span>
          <input type="range" min="0" max="2.0" step="0.1" value={ttsSilenceGap}
            onChange={(e) => setTtsSilenceGap(parseFloat(e.target.value))} disabled={disabled}
            style={{ flex: 1, minWidth: 0, accentColor: 'var(--rose)', cursor: 'pointer' }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--rose)', fontVariantNumeric: 'tabular-nums', minWidth: 32, textAlign: 'right' }}>
            {ttsSilenceGap.toFixed(1)}초
          </span>
        </div>
        {/* 음높이(§5): 원본(0) reset · 중앙 눈금 · 후처리 설명 · 미지원 capability 반영(§6) */}
        <div style={{
          flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5,
          borderRadius: 10, padding: '8px 14px',
          background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
          opacity: pitchSupported ? 1 : 0.6
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title="음높이 보정(반음). 0=원본, +는 높게 / −는 낮게.">음높이</span>
            <input type="range" list="tts-pitch-ticks" min="-2" max="2" step="0.5" value={ttsPitch}
              onChange={(e) => setTtsPitch(parseFloat(e.target.value))} disabled={pitchDisabled}
              style={{ flex: 1, minWidth: 0, accentColor: 'var(--rose)', cursor: pitchDisabled ? 'not-allowed' : 'pointer' }} />
            <datalist id="tts-pitch-ticks"><option value="0" /></datalist>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--rose)', fontVariantNumeric: 'tabular-nums', minWidth: 46, textAlign: 'right' }}>
              {ttsPitch > 0 ? '+' : ''}{ttsPitch.toFixed(1)}반음
            </span>
            {/* reset은 capability와 무관: 미지원/미확인이라도 저장된 nonzero를 0으로 되돌려 합성 차단을 풀 수 있어야 함.
                처리 중이거나 이미 0일 때만 비활성. */}
            <button onClick={() => !disabled && ttsPitch !== 0 && setTtsPitch(0)} disabled={disabled || ttsPitch === 0}
              title="음높이를 원본(0)으로 되돌립니다" style={{
                padding: '2px 7px', borderRadius: 4, border: 'none', cursor: (disabled || ttsPitch === 0) ? 'default' : 'pointer',
                fontSize: 9, fontWeight: 600, fontFamily: 'inherit',
                background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
                opacity: (disabled || ttsPitch === 0) ? 0.4 : 1
              }}>원본(0)</button>
          </div>
          {/* 중앙 눈금 — 0(원본)을 가운데에 표시 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: 'var(--text-muted)', padding: '0 2px' }}>
            <span>−2</span><span style={{ fontWeight: 600 }}>0 · 원본</span><span>+2</span>
          </div>
          {pitchProbedUnsupported ? (
            <div style={{ fontSize: 9, lineHeight: 1.5, color: 'var(--rose)' }}>
              이 환경에서는 음높이 보정을 사용할 수 없습니다{pitchCap?.reason ? ` — ${pitchCap.reason}` : ''}. 저장된 음높이 값이 있으면 원본(0)으로 되돌린 뒤 합성하세요.
            </div>
          ) : pitchUnknown ? (
            <div style={{ fontSize: 9, lineHeight: 1.5, color: 'var(--text-muted)' }}>
              음높이 보정 지원 여부를 확인하는 중입니다. 확인 전에는 음높이를 조절할 수 없습니다(원본 0으로 합성됩니다).
            </div>
          ) : (
            <div style={{ fontSize: 9, lineHeight: 1.5, color: 'var(--text-muted)' }}>
              모델 재합성 없이 결과 음성에 후처리로 적용됩니다.
            </div>
          )}
        </div>
      </div>
        </div>)}
      </div>
    </div>
  )
}
