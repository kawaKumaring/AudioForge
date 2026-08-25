import { useState, useEffect, useRef, useMemo } from 'react'
import type { CSSProperties } from 'react'
import { useAppStore, emotionEffectivePath } from '@/stores/app.store'
import type { TtsReferenceEntry, PitchCapability, TtsEmotionRegion } from '../../shared/ttsConfig'
import { deriveRefMode } from '../../shared/ttsConfig'
import ReferenceRegionPanel from './ReferenceRegionPanel'
import TtsVoiceSection from './TtsVoiceSection'
import EmotionReferenceManager from './EmotionReferenceManager'
import ExpressionControls from './ExpressionControls'
import { getPresetValues } from './ExpressionControls.logic'
import TtsExpressionDetail from './TtsExpressionDetail'
import { resolveExpressionCapability } from '../../shared/ttsExpressionCapabilities'
import EmotionScriptEditor, { type EmotionScriptEditorHandle } from './EmotionScriptEditor'
import { EMOTION_GROUPS, ALL_EMOTIONS, FREQUENT_TAGS, parseUsedEmotionIds } from '@/lib/emotions'

const EXAMPLE_TEXT = "안녕하세요. 오늘 좋은 소식이 있어요.\n[기쁨] 드디어 프로젝트가 완성됐습니다!\n[슬픔] 하지만 아쉽게도 일정이 늦어졌어요."

const PROMPT_LANGS: [string, string][] = [
  ['', '자동'], ['ko', '한국어'], ['ja', '일본어'], ['zh', '중국어'], ['en', '영어'],
]

// I5-a: 감정 참조 미리듣기(신규 어포던스). PHASE 4에서 raw file:// 재생이 webSecurity에 막히는 것을 확인 →
// 앱이 결과 트랙 재생에 쓰는 '기존 안전 경로'(getFileUrl → local-file:// 권한 프로토콜)를 재사용한다.
// webSecurity 완화·임의 경로·외부 전송 없음. 재생 대상은 등록된 감정 참조의 effective(파생 클립/원본) 경로뿐.
let _previewAudio: HTMLAudioElement | null = null
export function stopReferencePreview() {
  if (_previewAudio) { try { _previewAudio.pause() } catch { /* noop */ } _previewAudio = null }
}
async function previewLocalFile(path: string) {
  if (!path) return
  try {
    stopReferencePreview()                             // 다른 clip 미리듣기 시작 전 이전 것 정지(전환)
    const url = await window.api.audio.getFileUrl(path)  // local-file:// (결과 트랙과 동일 안전 경로)
    if (!url) return
    _previewAudio = new Audio(url)
    void _previewAudio.play().catch(() => { /* 재생 불가 시 조용히 무시(크래시 없음) */ })
  } catch { /* noop */ }
}

// 4-flow 셸(통합 담당, 정정11). A의 EmotionScriptEditor + C의 TtsVoiceSection·EmotionReferenceManager·
// ExpressionControls를 실제 props 계약으로 배선한다. 편집 알고리즘은 A 컴포넌트가 소유(I5-b는 그 동작 검증).
// 모든 effect/analyze/preflight는 이 단일 컴포넌트에 유지 → 신규 하위 패널 재렌더로 중복 실행되지 않는다.
export default function TTSEditor() {
  const { mode, status, fileInfo, ttsEmotionRefState, registerEmotionRef, removeEmotionRef, setEmotionRefState, setTtsRefState, ttsRefReady, ttsRefMessage, ttsPitchCapability, setTtsPitchCapability,
    ttsTailMode, ttsTailPaddingMs, ttsTailFadeMs, ttsEmotionBoundaryMode, ttsEmotionBoundaryPauseMs, setTtsExpression } = useAppStore()
  // 로컬 상태는 store 값으로 초기화 — 빈 값으로 시작하면 아래 동기화 useEffect가 다른 모드에 다녀온 뒤 store를 덮어써 유실시킴
  const [ttsText, setTtsText] = useState(() => useAppStore.getState().ttsText)
  const [ttsSpeed, setTtsSpeed] = useState(() => useAppStore.getState().ttsSpeed)
  const [ttsSilenceGap, setTtsSilenceGap] = useState(() => useAppStore.getState().ttsSilenceGap)
  const [ttsPitch, setTtsPitch] = useState(() => useAppStore.getState().ttsPitch)
  const [ttsEngine, setTtsEngine] = useState(() => useAppStore.getState().ttsEngine)
  const [refPrompts, setRefPrompts] = useState<Record<string, TtsReferenceEntry>>(() => useAppStore.getState().ttsReferencePrompts)
  const [showRefPrompts, setShowRefPrompts] = useState(false)
  const [txLoading, setTxLoading] = useState<string | null>(null)
  const [preflight, setPreflight] = useState<{ available?: boolean; snapshot_ok?: boolean; device_expected?: string; reason?: string } | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showAllTags, setShowAllTags] = useState(false)
  // I5-a 표현 흐름 UI 상태(셸 로컬 — '고급 기능(세부 조절)'과 '패널 펼치기'는 컴포넌트가 각자 별도 관리, 정정 I5-c).
  const [presetId, setPresetId] = useState('original')
  const [fineTuneEnabled, setFineTuneEnabled] = useState(false)
  const [detailFineTune, setDetailFineTune] = useState(false)   // 세부 표현 '직접 조절'(ExpressionControls fineTune과 별개)
  const [showSettingHelp, setShowSettingHelp] = useState(false)
  const editorRef = useRef<EmotionScriptEditorHandle>(null)
  const pitchCap = ttsPitchCapability
  const disabled = status === 'processing'

  // Sync to store (감정 참조 상태는 store가 단일 소스라 여기서 동기화하지 않는다)
  useEffect(() => {
    useAppStore.setState({ ttsText, ttsSpeed, ttsSilenceGap, ttsPitch, ttsReferencePrompts: refPrompts, ttsEngine })
  }, [ttsText, ttsSpeed, ttsSilenceGap, ttsPitch, refPrompts, ttsEngine])

  // Qwen preflight — 마운트 시 1회(mode 의존). 예상값이며 실행 결과는 결과 화면 metadata가 최종.
  useEffect(() => {
    if (mode !== 'tts') return
    let cancelled = false
    window.api.audio.qwenPreflight()
      .then((p: unknown) => { if (!cancelled) setPreflight(p as typeof preflight) })
      .catch(() => { if (!cancelled) setPreflight(null) })
    return () => { cancelled = true }
  }, [mode])

  // pitch 후처리 capability(§6) — ffmpeg rubberband 지원 여부. 미지원이면 슬라이더 비활성 + 사유 표시.
  useEffect(() => {
    if (mode !== 'tts') return
    let cancelled = false
    window.api.audio.pitchPreflight()
      .then((cap: unknown) => {
        if (cancelled) return
        const c = cap as PitchCapability | null
        setTtsPitchCapability(c && typeof c.probed === 'boolean' ? c : { supported: false, method: 'none', probed: true, reason: 'pitch-probe-failed' })
      })
      .catch(() => { if (!cancelled) setTtsPitchCapability({ supported: false, method: 'none', probed: true, reason: 'pitch-probe-failed' }) })
    return () => { cancelled = true }
  }, [mode])

  // 컴포넌트 해제(모드 전환 등) 시 재생 중인 참조 미리듣기 정지 — 잔여 재생 방지.
  useEffect(() => () => { stopReferencePreview() }, [])

  const updateRef = (id: string, patch: Partial<TtsReferenceEntry>) =>
    setRefPrompts(prev => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }))

  // 수동 전사 '확정' 시 그 참조 source의 지문을 stamp(§4 stale 방지).
  const stampFingerprint = async (id: string, sourcePath: string) => {
    if (!sourcePath) return
    try {
      const fp = await window.api.audio.fingerprintReference(sourcePath)
      if (fp) updateRef(id, { sourceFingerprint: fp })
    } catch { /* 지문 실패 시 stamp 생략 — 불변식(4)이 미기록을 '보존'으로 처리 */ }
  }

  const autoTranscribe = async (id: string, path: string) => {
    if (!path || txLoading) return
    setTxLoading(id)
    try {
      const t = await window.api.audio.transcribeReference(path) as {
        status?: string; text?: string; language?: string; error_message?: string
      }
      const ok = t?.status === 'ok'
      updateRef(id, {
        autoStatus: t?.status || 'failed',
        autoText: ok ? (t?.text ?? '') : '',
        autoLang: ok ? (t?.language ?? '') : '',
        autoError: ok ? undefined : (t?.error_message || t?.status || '전사 실패')
      })
    } catch (e) {
      updateRef(id, { autoStatus: 'failed', autoError: (e as Error)?.message || '전사 실패' })
    } finally {
      setTxLoading(null)
    }
  }

  const useAutoAsManual = (id: string, sourcePath: string) => {
    updateRef(id, { manualText: (refPrompts[id]?.autoText || ''), mode: 'manual' })
    void stampFingerprint(id, sourcePath)
  }
  const onManualEdit = (id: string, text: string) =>
    updateRef(id, { manualText: text, mode: text.trim() ? 'manual' : 'auto' })
  const onRefFreeToggle = (id: string, checked: boolean) =>
    updateRef(id, { mode: checked ? 'ref_free' : ((refPrompts[id]?.manualText || '').trim() ? 'manual' : 'auto') })

  // 감정 요약(§1) — 대사에 실제 쓰인 감정 + 미등록 안내(§3).
  const usedIds = useMemo(() => parseUsedEmotionIds(ttsText), [ttsText])
  const nonDefaultEmotions = useMemo(() => ALL_EMOTIONS.filter(e => e.id !== 'default'), [])

  if (mode !== 'tts') return null

  // ── EmotionReferenceManager 입력 배선 ──
  const registeredEmotions = nonDefaultEmotions.filter(e => ttsEmotionRefState[e.id]?.source)
  const managerRefs = registeredEmotions.map(e => {
    const slot = ttsEmotionRefState[e.id]
    return { emotionId: e.id, registered: true, ready: !!slot?.ready, region: slot?.region ?? undefined }
  })
  // 대사에 쓰였지만 미등록 → 기본 참조 사용(§3 안내 보존).
  const usedUnregistered = nonDefaultEmotions.filter(e => usedIds.has(e.id) && !ttsEmotionRefState[e.id]?.source)

  // 셸이 파일 선택 다이얼로그를 주입(EmotionReferenceManager는 파일 I/O를 하지 않음).
  const requestEmotionSource = async (): Promise<string | null> => {
    const p = await window.api.audio.selectFile()
    return p || null
  }
  // 감정별 구간 편집기 = 기존 ReferenceRegionPanel 재사용(중복 마운트 없음: 감정당 1개, 행 펼침 시).
  const renderEmotionRegion = (emotionId: string, onChangeRegion: (r: TtsEmotionRegion) => void) => {
    const src = ttsEmotionRefState[emotionId]?.source || ''
    if (!src) return null
    return (
      <ReferenceRegionPanel
        key={src}
        clipKey={emotionId}
        path={src}
        disabled={disabled}
        onState={(s) => {
          setEmotionRefState(emotionId, s)              // store가 단일 소스(clip/ready/message/region)
          if (s.region) onChangeRegion(s.region)         // 관리자 표시 콜백 계약 충족
        }}
        label={`${nonDefaultEmotions.find(e => e.id === emotionId)?.label || emotionId} 참조`}
      />
    )
  }

  // ── ExpressionControls 입력 배선(후처리 축) ──
  const pitchSupported = !!pitchCap && pitchCap.supported
  const pitchProbedUnsupported = !!pitchCap && pitchCap.probed && !pitchCap.supported
  const pitchUnknown = !pitchSupported && !pitchProbedUnsupported
  const capabilities = {
    pitch: pitchSupported, speed: true, sentenceGap: true,
    // tail/감정경계는 I3로 실제 구현됨(supported=true). 단 C 소유 ExpressionControls엔 아직 슬라이더가 없어
    // 사용자 제어 UI가 부재(기본값 auto/pause로 동작). 슬라이더 추가는 C 컴포넌트 확장 사안 → 보고.
    emotionTransitionGap: true, tailTrim: true, tailPadding: true,
  }
  const exprValues = {
    pitchSemitones: ttsPitch,
    speed: ttsSpeed,
    sentenceGapMs: Math.round(ttsSilenceGap * 1000),
  }
  const onExprChange = (patch: Partial<{ pitchSemitones: number; speed: number; sentenceGapMs: number }>) => {
    if (patch.pitchSemitones !== undefined) setTtsPitch(patch.pitchSemitones)
    if (patch.speed !== undefined) setTtsSpeed(patch.speed)
    if (patch.sentenceGapMs !== undefined) setTtsSilenceGap(patch.sentenceGapMs / 1000)
  }
  const onPreset = (id: string) => {
    setPresetId(id)
    const v = getPresetValues(id)
    if (v) { setTtsPitch(v.pitchSemitones); setTtsSpeed(v.speed); setTtsSilenceGap(v.sentenceGapMs / 1000) }
  }

  const flowCard: CSSProperties = { borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', overflow: 'hidden' }
  const flowHead: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }
  const flowNum: CSSProperties = { width: 22, height: 22, borderRadius: 6, background: 'var(--bg-elevated)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--accent)', flexShrink: 0 }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* ───────── [1] 목소리 ───────── */}
      <TtsVoiceSection
        referenceReady={ttsRefReady}
        referenceMessage={ttsRefMessage}
        showSettingHelp={showSettingHelp}
        onToggleSettingHelp={setShowSettingHelp}
        emotionManager={
          <>
            <EmotionReferenceManager
              refs={managerRefs}
              onRegister={(id, src) => registerEmotionRef(id, src)}
              onRemove={(id) => removeEmotionRef(id)}
              onPreview={(id) => previewLocalFile(emotionEffectivePath(ttsEmotionRefState[id]) || ttsEmotionRefState[id]?.source || '')}
              onChangeRegion={(id, region) => setEmotionRefState(id, { region })}
              requestSource={requestEmotionSource}
              renderRegionEditor={renderEmotionRegion}
              disabled={disabled}
            />
            {usedUnregistered.length > 0 && (
              <div style={{ fontSize: 10, lineHeight: 1.6, color: 'var(--text-secondary)', padding: '6px 10px', borderRadius: 6, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                대사에 쓰인 <span style={{ color: 'var(--text-muted)' }}>{usedUnregistered.map(e => e.label).join(', ')}</span> 은(는) 아직 미등록입니다 → <strong style={{ color: 'var(--rose)' }}>기본 참조</strong>로 합성됩니다.
              </div>
            )}
          </>
        }
      >
        {/* 기본 참조 음성 패널(셸 주입) — 단 1회 마운트. */}
        {fileInfo?.path && (
          <ReferenceRegionPanel clipKey="default" path={fileInfo.path} disabled={disabled} onState={setTtsRefState} label="참조 음성" />
        )}
        {/* Guide */}
        <div style={{ borderRadius: 12, padding: '12px 16px', background: 'rgba(251,113,133,0.05)', border: '1px solid rgba(251,113,133,0.12)', fontSize: 12, lineHeight: 1.7, color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--rose)' }}>참조 음성</strong> = 위에 올린 파일의 목소리를 흉내 냅니다.
          감정별 음성을 추가 등록하면 대사마다 <code style={{ background: 'var(--bg-elevated)', padding: '1px 4px', borderRadius: 3 }}>[기쁨]</code> 태그로 감정을 지정할 수 있습니다.
          <br />한국어 · 영어 · 일본어 · 중국어 지원. 영어 목소리로 한국어 대사도 가능합니다.
        </div>
        {/* Qwen preflight 배지 */}
        {preflight && (() => {
          const ok = preflight.available === true
          const snapMissing = !ok && preflight.snapshot_ok === false
          const dev = preflight.device_expected
          const msg = ok
            ? (dev === 'gpu' ? 'Qwen3 준비됨 · 완전 로컬 · GPU 예상' : dev === 'cpu' ? 'Qwen3 준비됨 · 완전 로컬 · VRAM 부족으로 CPU 예상' : 'Qwen3 준비됨 · 완전 로컬')
            : (snapMissing ? 'Qwen3 모델 스냅샷 누락 · 자동 선택 시 GPT-SoVITS 사용 예정' : 'Qwen3 미설치 · 자동 선택 시 GPT-SoVITS 사용 예정')
          const color = ok ? 'var(--cyan)' : 'var(--text-muted)'
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color, padding: '2px 2px' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: ok ? 'var(--cyan)' : 'var(--text-muted)', flexShrink: 0 }} />
              <span>{msg}</span>
              <span style={{ color: 'var(--text-muted)' }}>· 예상값(실제 결과는 합성 후 표시)</span>
            </div>
          )
        })()}
        {/* 참조 전사(선택 — 수동 입력·언어). 신규 패널에 대응 없어 셸이 그대로 보존(무손실). */}
        <div id="tts-reference-transcript" style={flowCard}>
          <button onClick={() => setShowRefPrompts(!showRefPrompts)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '10px 16px', border: 'none', cursor: 'pointer', background: 'transparent', fontFamily: 'inherit', outline: 'none' }} aria-expanded={showRefPrompts}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>참조 전사 <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>(선택 — 수동 입력·언어)</span></span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" style={{ transform: showRefPrompts ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {showRefPrompts && (
            <div style={{ padding: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                참조 음성이 무슨 말을 하는지 적어두면 목소리를 더 정확히 흉내 냅니다. 자동 전사가 틀리면 직접 고치거나 입력하세요.
                비워두면 자동 전사를 사용합니다. (10초 초과 파일은 확정한 구간만 전사합니다.)
              </div>
              {[
                { id: 'default', label: '기본 참조', path: fileInfo?.path || '', sourcePath: fileInfo?.path || '' },
                ...ALL_EMOTIONS.filter(e => e.id !== 'default' && ttsEmotionRefState[e.id]?.source)
                  .map(e => ({ id: e.id, label: e.label, path: ttsEmotionRefState[e.id].clip || ttsEmotionRefState[e.id].source, sourcePath: ttsEmotionRefState[e.id].source }))
              ].map(ref => {
                const entry = refPrompts[ref.id] || {}
                const effMode = deriveRefMode(entry)
                const refFree = effMode === 'ref_free'
                const eff = refFree ? '화자 특성만' : (effMode === 'manual' ? '직접 입력' : '자동 전사')
                const effColor = refFree ? 'var(--text-muted)' : (effMode === 'manual' ? 'var(--rose)' : 'var(--cyan)')
                return (
                  <div key={ref.id} style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', minWidth: 62 }}>{ref.label}</span>
                      <span style={{ fontSize: 9, fontWeight: 600, color: effColor, padding: '1px 6px', borderRadius: 4, background: 'var(--bg-elevated)' }}>{eff}</span>
                      <span style={{ flex: 1, fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ref.path ? ref.path.split(/[/\\]/).pop() : '파일 없음'}</span>
                      <button onClick={() => autoTranscribe(ref.id, ref.path)} disabled={disabled || !ref.path || !!txLoading} style={{ padding: '3px 10px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 500, fontFamily: 'inherit', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', opacity: (disabled || !ref.path || !!txLoading) ? 0.5 : 1 }}>
                        {txLoading === ref.id ? '전사 중...' : '자동 전사'}
                      </button>
                    </div>
                    {entry.autoStatus === 'ok' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 9, color: 'var(--text-muted)' }}>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>자동 전사: {entry.autoLang || '?'} · {(entry.autoText || '').length}자 · "{(entry.autoText || '').slice(0, 30)}"</span>
                        <button onClick={() => useAutoAsManual(ref.id, ref.sourcePath)} disabled={disabled || refFree || !entry.autoText} style={{ padding: '2px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 9, fontWeight: 600, fontFamily: 'inherit', background: 'var(--accent-glow, rgba(56,189,248,0.15))', color: 'var(--cyan)', opacity: (disabled || refFree || !entry.autoText) ? 0.5 : 1 }}>수정하여 사용</button>
                      </div>
                    )}
                    {entry.autoStatus && entry.autoStatus !== 'ok' && (
                      <div style={{ fontSize: 9, color: 'var(--rose)' }}>자동 전사 실패({entry.autoStatus}): {entry.autoError || '알 수 없는 오류'}</div>
                    )}
                    <textarea value={entry.manualText || ''} onChange={(e) => onManualEdit(ref.id, e.target.value)}
                      onBlur={() => { if ((entry.manualText || '').trim() && !refFree) void stampFingerprint(ref.id, ref.sourcePath) }}
                      disabled={disabled || refFree}
                      placeholder="수동 전사문 (비우면 자동 전사 사용). '자동 전사' 후 '수정하여 사용'으로 불러올 수 있습니다."
                      style={{ width: '100%', height: 42, resize: 'vertical', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontFamily: "'Inter', sans-serif", fontSize: 11, outline: 'none', opacity: (disabled || refFree) ? 0.5 : 1 }} />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>언어</span>
                      <select value={entry.promptLang || ''} onChange={(e) => updateRef(ref.id, { promptLang: e.target.value })} disabled={disabled} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 5, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontFamily: 'inherit' }}>
                        {PROMPT_LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-muted)', cursor: 'pointer' }}>
                        <input type="checkbox" checked={refFree} disabled={disabled} onChange={(e) => onRefFreeToggle(ref.id, e.target.checked)} />
                        화자 특성만 사용 (전사문 없이 · 유사도 저하 가능)
                      </label>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </TtsVoiceSection>

      {/* ───────── [2] 대사 ───────── */}
      <section className="tts-flow-card" aria-label="대사" style={flowCard}>
        <header className="tts-flow-head" style={flowHead}>
          <span aria-hidden="true" style={flowNum}>2</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>대사</span>
          <span style={{ fontSize: 11, color: ttsText.trim() ? 'var(--text-muted)' : 'var(--rose)', flex: 1, minWidth: 100 }}>
            {ttsText.trim() ? `${ttsText.split('\n').filter(l => l.trim()).length}개 문장` : '합성할 대사를 입력하세요'}
          </span>
          {!ttsText.trim() && (
            <button onClick={() => !disabled && setTtsText(EXAMPLE_TEXT)} disabled={disabled} style={{ padding: '3px 10px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, fontFamily: 'inherit', background: 'var(--bg-elevated)', color: 'var(--cyan)' }}>예문 불러오기</button>
          )}
        </header>
        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* A 소유 편집기(caret/IME/overlay/오류 = A). 셸은 value/onChange + 삽입 handle만 배선. */}
          <EmotionScriptEditor
            ref={editorRef}
            value={ttsText}
            parsedPreview={null}
            parseErrors={[]}
            onChange={(next) => { if (!disabled) setTtsText(next) }}
            onInsertEmotion={() => { /* A가 caret 삽입까지 수행 — 셸은 추가 배선 불필요(게이팅은 store가 담당) */ }}
            onInsertPause={() => { /* 동일 */ }}
            disabled={disabled}
            refStates={Object.fromEntries(nonDefaultEmotions.map(e => [e.id, { registered: !!ttsEmotionRefState[e.id]?.source, ready: !!ttsEmotionRefState[e.id]?.ready }]))}
          />
          {/* 감정 태그 삽입 팔레트(셸) — A의 imperative handle 호출(실제 caret/선택 삽입은 A). 색은 감정 '전환' 표시. */}
          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>감정 태그 삽입 <span style={{ fontSize: 9 }}>(색은 감정 전환 구간 표시 · 혼합 아님)</span>:</span>
              <button onClick={() => setShowAllTags(v => !v)} style={{ padding: '1px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 600, fontFamily: 'inherit', background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }} aria-expanded={showAllTags}>{showAllTags ? '접기' : '더보기(전체)'}</button>
            </div>
            {!showAllTags ? (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {FREQUENT_TAGS.map((e) => (
                  <button key={e.id} onClick={() => editorRef.current?.insertEmotion(e.id)} disabled={disabled} style={{ padding: '3px 9px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, fontFamily: 'inherit', background: `${e.color}15`, color: e.color }}>{e.label}</button>
                ))}
              </div>
            ) : (
              EMOTION_GROUPS.filter(g => g.name !== '기본').map((group) => (
                <div key={group.name} style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginBottom: 4, alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 44 }}>{group.name}</span>
                  {group.emotions.filter(e => e.id !== 'default').map((e) => (
                    <button key={e.id} onClick={() => editorRef.current?.insertEmotion(e.id)} disabled={disabled} style={{ padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 600, fontFamily: 'inherit', background: `${e.color}15`, color: e.color }}>{e.label}</button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {/* ───────── [3] 표현 ───────── */}
      <ExpressionControls
        capabilities={capabilities}
        presetId={presetId}
        fineTuneEnabled={fineTuneEnabled}
        values={exprValues}
        onPreset={onPreset}
        onToggleFineTune={setFineTuneEnabled}
        onChange={onExprChange}
        showSettingHelp={showSettingHelp}
        disabled={disabled}
      />
      {/* pitch capability 사유(미지원/미확인) — ExpressionControls는 슬라이더만 숨기므로 사유는 셸이 보존 표시(§6). */}
      {(pitchProbedUnsupported || pitchUnknown) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 10, lineHeight: 1.5, color: pitchProbedUnsupported ? 'var(--rose)' : 'var(--text-muted)', padding: '2px 4px' }}>
          <span style={{ flex: 1, minWidth: 180 }}>
            {pitchProbedUnsupported
              ? `이 환경에서는 음높이 보정을 사용할 수 없습니다${pitchCap?.reason ? ` — ${pitchCap.reason}` : ''}. 저장된 음높이 값이 있으면 원본(0)으로 되돌린 뒤 합성하세요.`
              : '음높이 보정 지원 여부를 확인하는 중입니다. 확인 전에는 음높이를 조절할 수 없습니다(원본 0으로 합성됩니다).'}
          </span>
          {/* 기존 '원본(0)' 리셋 보존(§6 계약): capability와 무관하게 저장된 nonzero pitch를 0으로 되돌려 합성 차단을 푼다.
              (미지원 시 ExpressionControls가 슬라이더를 숨겨 리셋 경로가 사라지는 막다른 길 방지.) */}
          {ttsPitch !== 0 && (
            <button onClick={() => !disabled && setTtsPitch(0)} disabled={disabled}
              title="음높이를 원본(0)으로 되돌립니다" style={{ padding: '2px 8px', borderRadius: 4, border: 'none', cursor: disabled ? 'default' : 'pointer', fontSize: 9, fontWeight: 600, fontFamily: 'inherit', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', opacity: disabled ? 0.4 : 1, whiteSpace: 'nowrap' }}>
              음높이 원본(0)으로 ({ttsPitch > 0 ? '+' : ''}{ttsPitch.toFixed(1)}반음)
            </button>
          )}
        </div>
      )}

      {/* 세부 표현(통합 소유 블록) — 말끝 finishing + 감정 전환 경계. ExpressionControls(C) 아래 별도 배치. */}
      <TtsExpressionDetail
        capability={resolveExpressionCapability()}
        tailMode={ttsTailMode}
        tailPaddingMs={ttsTailPaddingMs}
        tailFadeMs={ttsTailFadeMs}
        emotionMode={ttsEmotionBoundaryMode}
        emotionPauseMs={ttsEmotionBoundaryPauseMs}
        fineTune={detailFineTune}
        showSettingHelp={showSettingHelp}
        disabled={disabled}
        onChange={(patch) => setTtsExpression(patch)}
        onToggleFineTune={setDetailFineTune}
      />

      {/* 고급: 엔진 직접 선택(표현축 아님 → 셸이 별도 배치, 기본 접힘). */}
      <div style={flowCard}>
        <button onClick={() => setShowAdvanced(v => !v)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '10px 16px', border: 'none', cursor: 'pointer', background: 'transparent', fontFamily: 'inherit', outline: 'none' }} aria-expanded={showAdvanced}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>고급 <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>(엔진 직접 선택)</span></span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" style={{ transform: showAdvanced ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}><polyline points="6 9 12 15 18 9" /></svg>
        </button>
        {showAdvanced && (
          <div style={{ padding: '0 16px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', borderRadius: 10, padding: '8px 14px', width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }} title="목소리를 합성하는 AI 엔진 선택">엔진</span>
              {[
                { id: 'auto', label: '자동', hint: '언어에 맞춰 최적 엔진 자동 선택 (한국어는 Qwen3 우선, 미설치 시 GPT-SoVITS) (권장)' },
                { id: 'qwen3', label: 'Qwen3', hint: '한국어 제로샷 발음·운율 우수 (로컬 Qwen3-TTS 0.6B, 별도 venv 필요 — 미설치 시 자동 폴백)' },
                { id: 'gptsovits', label: 'GPT-SoVITS', hint: '한/영/중 지원, 참조 음성으로 목소리 클로닝 (베타)' },
                { id: 'f5tts', label: 'F5', hint: '영어 중심의 고품질 보이스 클로닝' },
                { id: 'kokoro', label: 'Kokoro', hint: '한/일/중/영 다국어 폴백 엔진, 가벼움' },
              ].map(e => (
                <button key={e.id} onClick={() => !disabled && setTtsEngine(e.id)} disabled={disabled} title={e.hint} style={{ padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 9, fontWeight: 600, fontFamily: 'inherit', background: ttsEngine === e.id ? 'var(--rose)' : 'transparent', color: ttsEngine === e.id ? '#fff' : 'var(--text-muted)' }}>{e.label}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
