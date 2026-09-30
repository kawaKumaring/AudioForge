import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type DragEvent } from 'react'
import { useAppStore } from '../stores/app.store'
import { Icon, Action, Modal, row, muted, badge, field, button, primary, type IconName } from './kit'
import { useSynthesisCards, type SynthesisCard, type CardSource, type CardSettings, type CardTake, type JoinSettings } from '../stores/synthesisCards.store'
import { useLabStore } from '../stores/lab.store'
import { isCancelCleanupBusy } from '../../shared/cancelContract'
import CompactVoiceWaveform from './CompactVoiceWaveform'
import MediaImportCard from './MediaImportCard'
import SharedVoicePicker from './VoicePicker'
import { createManagedAudio, onManagedPlay, pauseManagedAudio } from '../lib/playbackVolume'
import {
  playPreview, stopPreview, disposePreview, onPreviewState, previewState, type PreviewState,
} from '../lib/voicePreview'
import { cancelFailureText, type CancelUiStatus } from '../../shared/cancelContract'
import { cancelAlreadyOverText, useCancelLifecycle } from '../hooks/useCancelLifecycle'
import {
  cardApplied, cardEventFault, cardGenerateFault, takeMark, CARD_PITCH_MIN, CARD_PITCH_MAX, CARD_PITCH_STEP,
} from '../../shared/synthesisCardJob'
import {
  cardVoiceOf, voiceSnapshot, voiceSupports, voiceGenerateFault, type BuiltinVoiceRef,
} from '../../shared/synthesisCardVoice'
import {
  buildJoinPlan, joinPlanKey, joinBlockText,
} from '../../shared/cardJoinPlan'
import {
  previewStale, previewStaleText, playbackStale,
} from '../../shared/joinPreviewGate'
import {
  savedChoices, savedWorkHasContent, removeWorkWarning, type RestoreChoice,
} from '../../shared/synthesisCardSave'
import {
  prepareCardReference, forgetCardReference, releaseCardOwnership,
  startCardGeneration, acceptCardResult, endCardJob, serializeWork, hydrateWork,
} from '../lib/cardSynthesis'
import {
  loadSavedFile, queueSave, flushSave, retrySave, keepCurrentAside, adoptKept,
  onSaveState, saveState, importLegacyWork, deleteSavedWork, type SaveState,
} from '../lib/cardWorkSaver'
import {
  legacyWorks, alreadyImported, importSummary, revealTarget, removeLegacy, removeWarning,
  type ImportPlan,
} from '../../shared/legacyCardImport'

/**
 * 생성본의 **적용값을 안전하게 읽는다.**
 *
 * ★왜 (2026-09-27 격리 검사에서 화면이 멈췄다)
 *   이 칸은 나중에 생긴 것이라 **옛 저장본과 바깥에서 꽂아 넣은 생성본에는 없다.**
 *   그대로 읽으면 생성본 목록이 통째로 그려지지 않는다 — 값 하나 때문에 화면이 죽는다.
 *   없는 것은 '모른다' 로 보여 준다. 없는 값을 지어내지 않는다.
 */
function appliedOf(take: CardTake) {
  const a = take.applied
  return {
    speed: typeof a?.speed === 'number' ? a.speed : null,
    pitch: typeof a?.pitch === 'number' ? a.pitch : null,
    notes: Array.isArray(a?.notes) ? a.notes : [],
    reference: a?.reference || null,
  }
}
const DISCONNECTED = '연결부만 따로 듣는 것은 아직 연결되지 않았습니다. 전체 이어 듣기로 확인하세요.'
function Settings({ card, close, disabled, focusReference = false }: { card: SynthesisCard; close: () => void; disabled: boolean; focusReference?: boolean }) {
  const [draft, setDraft] = useState<CardSettings>({ ...card.settings, pitch: cardApplied(card.settings).pitch })
  const set = (patch: Partial<CardSettings>) => setDraft(s => ({ ...s, ...patch }))
  const supports = voiceSupports(cardVoiceOf(card))
  const referenceChoice = useRef<HTMLSelectElement>(null)
  useEffect(() => { if (focusReference) referenceChoice.current?.focus() }, [focusReference])
  const duration = card.source?.duration || 0
  // 영상이면 꺼낸 wav 로 그린다 — 원본 영상 경로를 그대로 주면 파형이 열지 못한다.
  const cardAudio = useSynthesisCards(st => st.refs[card.id]?.audio || '')
  const valid = draft.reference === 'auto' || duration > 0 && draft.end > draft.start && draft.end <= duration && draft.start >= 0
  const reset = () => setDraft({ ...draft, speed: 1, pitch: 0, emotion: '자연스럽게', reference: 'auto', start: 0, end: duration })
  const panel: CSSProperties = { background: 'var(--bg-base)', borderRadius: 10, padding: '0 16px', minWidth: 0 }
  const heading: CSSProperties = { ...row, padding: '15px 0', cursor: 'pointer', listStyle: 'none', fontSize: 13, fontWeight: 600 }
  const resetButton = (label: string, action: () => void) => <button type="button" aria-label={label} title={label} disabled={disabled} onClick={e => { e.preventDefault(); e.stopPropagation(); action() }} style={{ ...button, padding: 5, border: 0, background: 'transparent', color: 'var(--accent-light)' }}><Icon name="reset"/></button>
  const control = (label: string, value: number, min: number, max: number, step: number, update: (v: number) => void, suffix: string, neutral: number) => <div style={{ display: 'grid', gap: 11 }}>
    <div style={{ ...row, justifyContent: 'space-between' }}><label htmlFor={`card-${label}`}>{label}</label><div style={row}><output style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: value === neutral ? 'var(--text-secondary)' : 'var(--accent-light)' }}>{label === '음높이' && value > 0 ? '+' : ''}{label === '말하기 속도' ? value.toFixed(2) : value.toFixed(1)}{suffix}</output>{resetButton(`${label} 초기화`, () => update(neutral))}</div></div>
    <input id={`card-${label}`} className="af-effect-slider" aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={e => update(+e.target.value)} style={{ width: '100%', margin: '4px 0', '--fill': `${(value - min) / (max - min) * 100}%` } as CSSProperties}/>
    <div style={{ ...row, justifyContent: 'space-between', ...muted }}><span>{min}{suffix}</span><span>{max > 0 && label === '음높이' ? '+' : ''}{max}{suffix}</span></div>
  </div>
  return <Modal title="고급 옵션" subtitle={card.label} close={close} footer={<><button type="button" style={button} onClick={close}>취소</button><button type="button" style={{ ...primary, opacity: disabled || !valid ? .4 : 1 }} disabled={disabled || !valid} onClick={() => { useSynthesisCards.getState().update(card.id, { settings: { ...draft } }); close() }}>적용</button></>}>
    <div style={{ ...row, justifyContent: 'flex-end', marginBottom: 14 }}><button type="button" style={button} disabled={disabled} title="이 팝업의 설정을 기본값으로 돌립니다. 적용 전에는 카드가 바뀌지 않습니다." onClick={reset}><Icon name="reset"/>전체 초기화</button></div>
    <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 12 }}>
      <details className="af-effect-group" open style={panel}>
        <summary style={heading}><span style={{ flex: 1 }}>음성 조정</span><span className="af-effect-chevron" aria-hidden="true">⌃</span></summary>
        <div style={{ display: 'grid', gap: 18, paddingBottom: 18 }}>
          {control('말하기 속도', draft.speed, .7, 1.3, .05, speed => set({ speed }), '×', 1)}
          {control('음높이', draft.pitch, CARD_PITCH_MIN, CARD_PITCH_MAX, CARD_PITCH_STEP, pitch => set({ pitch }), '', 0)}
          {card.settings.pitch !== cardApplied(card.settings).pitch && <span style={{ ...muted, color: 'var(--amber)' }} title={`저장된 음높이 ${card.settings.pitch}는 지원 범위를 벗어납니다. 적용을 누르면 화면의 값으로 저장됩니다.`}>저장값 보정</span>}
        </div>
      </details>
      {supports.region && <details className="af-effect-group" data-testid="card-reference-settings" open={focusReference || card.settings.reference === 'manual' ? true : undefined} style={panel}>
        <summary style={heading}><span style={{ flex: 1 }}>참조 구간</span><span style={muted}>{draft.reference === 'auto' ? '자동' : `${draft.start.toFixed(1)}–${draft.end.toFixed(1)}초`}</span><span className="af-effect-chevron" aria-hidden="true">⌃</span></summary>
        <div style={{ display: 'grid', gap: 12, paddingBottom: 16 }}><div style={{ ...row, justifyContent: 'space-between' }}><select ref={referenceChoice} aria-label="참조 구간 방식" style={field} value={draft.reference} onChange={e => set({ reference: e.target.value as CardSettings['reference'] })}><option value="auto">자동</option><option value="manual">직접 지정</option></select>{resetButton('참조 구간 초기화', () => set({ reference: 'auto', start: 0, end: duration }))}</div>
          {card.source && <CompactVoiceWaveform path={cardAudio || card.source.path} name={card.source.name} disabled={disabled} region={draft.reference === 'manual' && valid ? { start: draft.start, duration: draft.end - draft.start } : null}/>}
          {draft.reference === 'manual' && <div style={row}><label style={{ ...row, flex: '1 1 130px' }}>시작<input aria-label="참조 시작 초" style={{ ...field, width: 95 }} type="number" min="0" max={duration} step=".1" value={draft.start} onChange={e => set({ start: +e.target.value })}/>초</label><label style={{ ...row, flex: '1 1 130px' }}>끝<input aria-label="참조 끝 초" style={{ ...field, width: 95 }} type="number" min="0" max={duration} step=".1" value={draft.end} onChange={e => set({ end: +e.target.value })}/>초</label>{!valid && <span role="alert" style={{ color: 'var(--rose)', fontSize: 12 }}>구간 확인 필요</span>}</div>}
        </div>
      </details>}
      {draft.emotion && draft.emotion !== '자연스럽게' && <div style={{ ...panel, ...row, padding: '14px 16px', color: 'var(--text-muted)', fontSize: 12 }} title="저장된 감정 설정은 현재 생성에 적용되지 않습니다. 해제하면 기본값으로 돌아갑니다."><span style={{ flex: 1 }}>감정 참조</span><span>{draft.emotion && draft.emotion !== '자연스럽게' ? `${draft.emotion} · 미적용` : '미연결'}</span>{draft.emotion && draft.emotion !== '자연스럽게' && <button type="button" aria-label="미지원 감정 선택 해제" style={button} onClick={() => set({ emotion: '자연스럽게' })}>해제</button>}</div>}
    </fieldset>
  </Modal>
}

/**
 * 목소리 고르기 — **기본 목소리**와 **소리·영상 파일** 두 갈래.
 *
 * ★설명 문단을 두지 않는다. 항목 이름과 짧은 상태, 그리고 툴팁으로 말한다.
 *   쓸 수 없는 목소리는 **목록에 넣지 않는다**(본체가 설치·구동을 확인한 것만 온다).
 */
/**
 * 기본 목소리 **들어 보기** 단추. 고르기 팝업과 카드가 같은 것을 쓴다.
 * 짧은 상태만 보이고 사유는 툴팁에 둔다(화면에 설명 문단을 늘리지 않는다).
 */
function PreviewButton({ voice, disabled }: {
  voice: { path: string; engineId: string; label: string }
  disabled?: boolean
}) {
  const [pv, setPv] = useState<PreviewState>(() => previewState())
  useEffect(() => onPreviewState(setPv), [])
  const mine = pv.modelPath === voice.path
  const phase = mine ? pv.phase : 'idle'
  const label = phase === 'preparing' ? '준비 중'
    : phase === 'playing' ? '멈춤'
    : phase === 'failed' ? '다시'
    : '들어 보기'
  const title = phase === 'failed'
    ? (pv.message || '미리듣기에 실패했습니다. 다시 눌러 보세요.')
    : `${voice.label} 로 짧은 문장을 읽어 들려줍니다 · 카드와 생성본은 바뀌지 않습니다`
  return (
    <button type="button" data-testid="voice-preview" aria-label={`${voice.label} 들어 보기`}
      disabled={disabled} title={title}
      onClick={(e) => { e.stopPropagation(); void playPreview(voice.path, voice.engineId) }}
      style={{ ...button, minHeight: 26, padding: '3px 9px', fontSize: 11,
        color: phase === 'failed' ? 'var(--rose)' : phase === 'playing' ? 'var(--accent-light)' : 'var(--text-secondary)' }}>
      {label}
    </button>
  )
}
function VoicePicker({ close, onFile, onBuiltin, disabled }: {
  close: () => void
  onFile: () => void
  onBuiltin: (v: BuiltinVoiceRef) => void
  disabled: boolean
}) {
  // ★고르기 창은 낭독과 **같은 것**을 쓴다(SharedVoicePicker — 2026-10-01). 여기서는 목록만 불러 준다.
  const [list, setList] = useState<BuiltinVoiceRef[] | null>(null)
  const [why, setWhy] = useState('')
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await window.api.cards.builtinVoices() as
          { ok: boolean; data?: { voices: BuiltinVoiceRef[] }; error?: string }
        if (!alive) return
        if (!r?.ok) { setWhy(r?.error || '기본 목소리를 확인하지 못했습니다'); setList([]); return }
        setList(r.data?.voices || [])
      } catch (e) { if (alive) { setWhy((e as Error).message); setList([]) } }
    })()
    return () => { alive = false }
  }, [])
  return <SharedVoicePicker close={close} builtins={list} why={why} onChoose={onBuiltin} onFile={onFile}
    confirmLabel="이 목소리로 카드 만들기" fileLabel="음성·영상 파일" disabled={disabled}
    ids={{ chip: 'pick-voice-builtin', confirm: 'pick-voice-confirm', file: 'pick-voice-file', preview: 'voice-preview' }}/>
}
function Takes({ card, close, disabled, back }: { card: SynthesisCard; close: () => void; disabled: boolean; back?: () => void }) {
  const [inspected, inspect] = useState<string | null>(null), [playing, setPlaying] = useState<string | null>(null), [error, setError] = useState('')
  const audio = useRef<HTMLAudioElement | null>(null), epoch = useRef(0)
  const stop = () => { epoch.current++; audio.current?.pause(); setPlaying(null) }
  useEffect(() => () => { epoch.current++; audio.current?.pause(); if (audio.current) { audio.current.removeAttribute('src'); audio.current.load() } }, [])
  useEffect(() => { if (disabled) stop() }, [disabled])
  const play = async (take: CardTake) => {
    if (take.missing) { setError('이 생성본 파일이 사라졌습니다'); return }
    const was = playing === take.id; stop(); if (was) return
    const token = epoch.current; setError('')
    try { const url = await window.api.audio.getFileUrl(take.path); if (token !== epoch.current) return
      const el = audio.current || createManagedAudio(undefined); audio.current = el; el.src = url
      el.onended = () => setPlaying(null); el.onerror = () => { setPlaying(null); setError('파일 재생 실패') }
      await el.play(); if (token === epoch.current) setPlaying(take.id)
    } catch { if (token === epoch.current) setError('파일 재생 실패') }
  }
  return <Modal title="생성본" subtitle={card.label} close={close} back={back} footer={<button type="button" style={button} onClick={close}>닫기</button>}>
    {!card.takes.length && <div style={{ display: 'grid', justifyItems: 'center', gap: 13, padding: '45px 0', color: 'var(--text-muted)' }}><Icon name="history"/><span>생성본 없음</span></div>}
    <div style={{ display: 'grid', gap: 8 }}>{card.takes.map((take, i) => <div key={take.id} data-testid="take-row" data-playing={playing === take.id || undefined} style={{ padding: 12, border: `1px solid ${card.adoptedId === take.id ? 'var(--accent)' : 'var(--border-subtle)'}`, borderRadius: 10, background: card.adoptedId === take.id ? 'var(--accent-glow)' : 'var(--bg-base)', transition: 'border-color 140ms ease, background-color 140ms ease' }}>
      <div style={row}><button type="button" disabled={disabled || !!take.missing} aria-label={`생성본 ${i + 1} 채택`} aria-pressed={take.id === card.adoptedId} title={take.missing ? '파일이 사라져 채택할 수 없습니다' : '최종 연결에 사용할 생성본'} onClick={() => useSynthesisCards.getState().update(card.id, { adoptedId: take.id })} style={{ ...button, color: take.id === card.adoptedId ? 'var(--accent-light)' : 'var(--text-muted)' }}><Icon name="check"/></button>
      <div style={{ flex: '1 1 125px', minWidth: 0 }}><div style={{ fontSize: 13 }}>생성본 {String(i + 1).padStart(2, '0')}{card.adoptedId === take.id && <span style={{ ...muted, color: 'var(--accent-light)', marginLeft: 8 }}>채택</span>}{playing === take.id && <span role="status" style={{ ...muted, color: 'var(--accent-light)', marginLeft: 8 }}>재생 중</span>}
        {/* ★지금 카드와 다른 조건으로 만든 결과임을 구분한다(현재 대사를 덮어 보여 주지 않는다). */}
        {/* ★기록이 없는 것과 값이 다른 것은 다른 일이다. 옛 작업에서 가져온 생성본은
            당시 설정이 아예 기록되지 않았으므로 '수정 전' 이라고 말할 수 없다. */}
        {(() => { const mark = takeMark({ text: take.text, sourcePath: take.source.path, settings: take.settings, applied: appliedOf(take) as never, voice: take.voice, settingsUnknown: take.settingsUnknown }, { text: card.text, sourcePath: card.source?.path || '', settings: card.settings, voice: voiceSnapshot(cardVoiceOf(card)) })
          return mark === 'unknown'
            ? <span data-testid="take-unknown-settings" tabIndex={0} title="옛 작업에서 가져온 생성본입니다. 만들 때 쓴 설정과 참조 구간이 기록되어 있지 않습니다." style={{ ...badge, marginLeft: 8, color: 'var(--text-muted)' }}>설정 기록 없음</span>
            : mark === 'stale' ? <span style={{ ...badge, marginLeft: 8, color: 'var(--amber)' }}>수정 전</span> : null })()}
        {take.missing && <span style={{ ...badge, marginLeft: 8, color: 'var(--rose)' }}>파일 없음</span>}</div><time style={muted}>{new Date(take.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div>
      <Action icon={playing === take.id ? 'stop' : 'play'} pressed={playing === take.id} label={`생성본 ${i + 1} ${playing === take.id ? '정지' : '재생'}`} onClick={() => void play(take)} disabled={disabled || !!take.missing}/>
      <Action icon="folder" label={`생성본 ${i + 1} 파일 위치`} onClick={() => { void window.api.app.revealFile(take.path).catch(() => setError('파일 위치 열기 실패')) }}/>
      <Action icon="text" expanded={inspected === take.id} controls={`take-detail-${take.id}`} label={`생성본 ${i + 1} 대사 보기`} onClick={() => inspect(inspected === take.id ? null : take.id)}/></div>
      {inspected === take.id && (() => { const a = appliedOf(take); return (
        <div id={`take-detail-${take.id}`} className="af-take-detail" style={{ marginTop: 12, borderTop: '1px solid var(--border-subtle)', padding: '12px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13 }}>
          <div style={{ ...muted, marginBottom: 8 }} title="생성 당시 실제로 적용된 값입니다. 기록이 없는 항목은 '기록 없음' 으로 둡니다.">
            {take.source.name}{a.speed === null ? ' · 속도 기록 없음' : ` · ${a.speed.toFixed(2)}×`}
            {a.pitch === null ? ' · 음높이 기록 없음' : ` · 음높이 ${a.pitch > 0 ? '+' : ''}${a.pitch}`}
            {a.reference?.region ? ` · 참조 ${a.reference.region.start.toFixed(1)}~${(a.reference.region.start + a.reference.region.duration).toFixed(1)}초` : ' · 참조 기록 없음'}
            {a.notes.length > 0 && ` · ${a.notes.length}개 설정 조정·미적용`}
          </div>{take.text}</div>) })()}
    </div>)}</div>{error && <div role="alert" style={{ color: 'var(--rose)', marginTop: 12, fontSize: 12 }}>{error}</div>}
  </Modal>
}
function Join({ cards, close, disabled }: { cards: SynthesisCard[]; close: () => void; disabled: boolean }) {
  const [draft, setDraft] = useState<JoinSettings>(() => ({ ...useSynthesisCards.getState().joins, gaps: { ...useSynthesisCards.getState().joins.gaps } }))
  return <Modal title="연결 조정" subtitle={`${cards.length}개 카드`} close={close} footer={<><button type="button" style={button} onClick={close}>취소</button><button type="button" style={primary} disabled={disabled} onClick={() => { useSynthesisCards.getState().setJoins(draft); close() }}>적용</button></>}>
    <fieldset disabled={disabled} style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 20 }}>
      <div style={{ ...row, justifyContent: 'space-between' }}><label htmlFor="join-gap">기본 간격</label><div style={row}><input id="join-gap" type="number" style={{ ...field, width: 95 }} min="0" max="5" step=".05" value={draft.gap} onChange={e => setDraft(s => ({ ...s, gap: Math.max(0, Math.min(5, +e.target.value)) }))}/>초</div></div>
      <div style={{ ...row, gap: 20 }}><label style={row} title="채택한 생성본 사이의 평균 음량 차이를 줄입니다. 원본 생성본은 바뀌지 않습니다."><input type="checkbox" checked={draft.level} onChange={e => setDraft(s => ({ ...s, level: e.target.checked }))}/>음량 맞추기</label><label style={row} title="각 생성본의 시작과 끝 5ms 음량을 부드럽게 낮춥니다. 말끝·숨소리도 영향을 받을 수 있어 이어 듣기로 확인하세요."><input type="checkbox" checked={draft.edges} onChange={e => setDraft(s => ({ ...s, edges: e.target.checked }))}/>경계 다듬기</label></div>
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 5 }}>{cards.slice(0, -1).map((card, i) => {
        const next = cards[i + 1], key = `${card.id}:${next.id}`
        return <div key={key} style={{ ...row, padding: '14px 0', borderBottom: '1px solid var(--border-subtle)' }}><span style={{ flex: '1 1 200px', fontSize: 12, overflowWrap: 'anywhere' }}>{String(i + 1).padStart(2, '0')} {card.label} <span style={muted}>→</span> {String(i + 2).padStart(2, '0')} {next.label}</span><input type="number" aria-label={`${i + 1}번과 ${i + 2}번 카드 간격`} title="두 카드 사이의 개별 간격" style={{ ...field, width: 85 }} min="0" max="5" step=".05" value={draft.gaps[key] ?? draft.gap} onChange={e => setDraft(s => ({ ...s, gaps: { ...s.gaps, [key]: Math.max(0, Math.min(5, +e.target.value)) } }))}/><span style={muted}>초</span><Action icon="play" label={`${i + 1}번 연결부 듣기`} disabled title={DISCONNECTED}/></div>
      })}</div>
    </fieldset>
  </Modal>
}
/**
 * 카드 목록 → 연결 계획. **화면과 보관본 어느 쪽에서도 같은 계획이 나오게** 한 곳에 둔다.
 * (요청을 보낸 뒤 응답을 대조할 때는 보관본에서 다시 만들어야 한다 — 화면 변수는 그때 값에 묶인다.)
 */
function planOfCards(cards: SynthesisCard[], joins: JoinSettings) {
  return buildJoinPlan(cards.map((c) => {
    const t = c.takes.find((x) => x.id === c.adoptedId)
    return {
      id: c.id, label: c.label,
      adopted: t ? { id: t.id, path: t.path, missing: t.missing } : null,
    }
  }), joins)
}

export default function SynthesisCardWorkspace() {
  const state = useSynthesisCards(), source = useAppStore(s => s.fileInfo), status = useAppStore(s => s.status), childAlive = useAppStore(s => s.errorInfo?.childAlive)
  const busy = status === 'processing' || isCancelCleanupBusy(status) || !!childAlive
  const [modal, setModal] = useState<{ type: 'settings' | 'takes' | 'voice'; id: string; focusReference?: boolean; fromSequence?: boolean } | { type: 'join' | 'sequence' } | null>(null)
  const [notice, setNotice] = useState(''), [loading, setLoading] = useState(false), [hover, setHover] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null), [over, setOver] = useState<{ id: string; after: boolean } | null>(null)
  const alive = useRef(true), pending = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false; disposePreview() } }, [])
  useEffect(() => { if (source?.path) state.seed(source) }, [source?.path])

  // ── 실제 연결 (Claude) ───────────────────────────────────────────────
  // 원본·구간이 정해지면 **그 카드의** 목소리를 준비한다. 자리는 card:<id> 로 카드마다 따로다.
  const prepared = useRef<Record<string, string>>({})
  useEffect(() => {
    for (const card of state.cards) {
      if (!card.source) { delete prepared.current[card.id]; continue }
      const key = JSON.stringify([card.source.path, card.settings.reference, card.settings.start, card.settings.end])
      // ★조건이 같아도 **준비 상태가 없으면 다시 준비한다.** 삭제→되돌리기로 카드가 돌아왔는데
      //   준비 상태만 비어 생성 단추가 잠긴 채였다(2026-09-27 검수 재현).
      //   되돌리기가 준비 상태를 되살리면 이 자리는 그냥 지나간다 — 어느 쪽이든 어긋나지 않는다.
      if (prepared.current[card.id] === key && state.refs[card.id]) continue
      prepared.current[card.id] = key
      forgetCardReference(card.id)
      void prepareCardReference(card)
    }
  }, [state.cards, state.refs])

  // 되돌릴 수 없게 사라진 카드의 것만 정리한다 — 다른 카드·기존 작업 파일은 건드리지 않는다.
  const known = useRef<Set<string>>(new Set())
  useEffect(() => {
    const live = new Set(state.cards.map(c => c.id))
    if (state.removed) live.add(state.removed.card.id)
    for (const id of [...known.current]) {
      if (!live.has(id)) { known.current.delete(id); delete prepared.current[id]; void releaseCardOwnership(id) }
    }
    for (const id of live) known.current.add(id)
  }, [state.cards, state.removed])

  // 생성 결과·진행·오류. **지금 기다리는 요청의 것만** 받는다(늦은 응답은 버린다).
  useEffect(() => {
    // ★모든 이벤트에서 **누구의 응답인가**를 먼저 본다. 작업이 있는지만 보면
    //   지난 요청의 응답이 지금 요청의 것으로 둔갑한다(2026-09-27 격리 재현).
    const mine = mineNow
    const offP = window.api.audio.onProgress((d: unknown) => {
      if (!mine(d)) return
      const o = d as { percent?: unknown; message?: unknown }
      useSynthesisCards.getState().patchJob({ percent: Number(o?.percent) || 0, message: String(o?.message || '') })
    })
    const offR = window.api.audio.onResult((d: unknown) => {
      // ★남의 응답은 **조용히** 지나간다. 알림을 띄우면 사용자는 자기 작업이 실패한 줄 안다.
      if (!mine(d)) return
      const r = acceptCardResult(d)
      if (r.dropped && alive.current) setNotice(`만든 소리를 붙이지 못했습니다: ${r.dropped}`)
    })
    const offE = window.api.audio.onError((d: unknown) => {
      if (!mine(d)) return
      const o = d as { message?: unknown }
      // ★어느 카드가 실패했는지 **그 카드에서** 말한다. 전역 알림만 띄우면 찾아 헤맨다.
      const id = useSynthesisCards.getState().job?.cardId || ''
      endCardJob()
      if (!alive.current) return
      const why = String(o?.message || '만들기에 실패했습니다')
      if (id) setCardFault({ id, why }); else setNotice(why)
    })
    return () => { offP(); offR(); offE() }
  }, [])

  /**
   * 이 신호가 내 요청의 것인가. **잣대는 하나다** — 진행·결과·오류·취소 모두 같은 규칙을 쓴다.
   *
   * ★예전에는 '식별자가 없으면 내 것으로 본다' 는 예외가 있었다. 그 예외가 본체의 식별자
   *   유실을 가려, 남의 취소가 내 작업을 끝내 버렸다(2026-09-27 2차 검수).
   *   본체는 이제 모든 마감 이벤트에 식별자를 싣는다 — 예외를 둘 이유가 없다.
   */
  const mineNow = (d: unknown): boolean => {
    const job = useSynthesisCards.getState().job
    return !!job && !cardEventFault(d, job.reqId)
  }

  // ★취소 수명주기를 이 화면이 **직접** 듣는다 — 카드 화면은 공용 실행 단추를 감추므로,
  //   취소가 실패하면 여기서 받지 않는 한 '만드는 중' 에 갇힌다.
  const { requestCancel } = useCancelLifecycle(
    () => useAppStore.getState().status as CancelUiStatus,
    {
      // 취소 신호도 같은 잣대로 본다 — 남의 실행이 끝났다고 내 작업을 내리지 않는다.
      onCancelling: (d) => { if (mineNow(d)) useSynthesisCards.getState().patchJob({ cancelling: true, message: '멈추는 중…' }) },
      onCancelled: (d) => { if (!mineNow(d)) return; endCardJob(); if (alive.current) setNotice('멈췄습니다. 여기까지 만든 생성본은 그대로 있습니다.') },
      onFailed: (kind, d) => { if (!mineNow(d)) return; endCardJob(); if (alive.current) setNotice(cancelFailureText(kind)) },
    })

  const stopWork = async () => {
    const why = await requestCancel()
    if (why) { const t = cancelAlreadyOverText(why); if (t && alive.current) setNotice(t) }
  }

  // ── 최종 음성 ────────────────────────────────────────────────────────
  // ★이어 듣기와 저장이 **같은 계획**을 쓴다. 계획을 두 군데서 만들면 언젠가 갈라진다.
  /**
   * **실패한 자리에서 바로 다시** — 전역 알림만 띄우면 어느 카드였는지 찾아 헤맨다.
   *   · 카드 실패는 그 카드 줄에 사유와 '다시 생성' 을 둔다
   *   · 최종 연결 실패는 최종 음성 줄에 사유와 '다시 시도' 를 둔다
   * ★어느 경우에도 대사·생성본·채택은 그대로 둔다(실패가 작업을 지우지 않는다).
   */
  const [cardFault, setCardFault] = useState<{ id: string; why: string } | null>(null)
  const [joinFault, setJoinFault] = useState<{ mode: 'preview' | 'save'; why: string } | null>(null)
  const [joining, setJoining] = useState<'' | 'preview' | 'save'>('')
  const joinAudio = useRef<HTMLAudioElement | null>(null)
  const [joinPlaying, setJoinPlaying] = useState(false)
  // ★이어 듣기 요청의 세대와, 지금 울리고 있는 소리의 계획 지문(2026-09-27 검수 2항).
  //   준비 중에 채택·순서·간격이 바뀌면 **먼저 보낸 요청의 소리를 재생하지 않는다.**
  const joinGen = useRef(0)
  const [playingKey, setPlayingKey] = useState('')
  useEffect(() => () => { joinAudio.current?.pause() }, [])

  /** 지금 화면의 카드로 계획을 만든다(렌더용). */
  const currentPlan = () => planOfCards(state.cards, state.joins)

  /**
   * **보관된 최신 상태**로 계획을 만든다 — 기다리는 동안 화면이 바뀌었을 수 있다.
   * 화면 변수(state)는 요청을 보낸 순간에 묶여 있으므로 응답 대조에는 쓸 수 없다.
   */
  const livePlanKey = () => {
    const s = useSynthesisCards.getState()
    const r = planOfCards(s.cards, s.joins)
    return r.plan ? joinPlanKey(r.plan) : ''
  }

  const planNow = currentPlan()
  const joinBlocked = planNow.plan ? '' : joinBlockText(planNow.blocks)
  const planKeyNow = planNow.plan ? joinPlanKey(planNow.plan) : ''

  // 울리는 중에 계획이 바뀌면 멈춘다 — 들리는 소리와 화면이 어긋나지 않게.
  useEffect(() => {
    if (!playbackStale(playingKey, planKeyNow)) return
    joinAudio.current?.pause()
    setJoinPlaying(false)
    setPlayingKey('')
  }, [playingKey, planKeyNow])

  const runJoin = async (mode: 'preview' | 'save') => {
    setNotice('')
    const r = currentPlan()
    if (!r.plan) { setNotice(joinBlockText(r.blocks)); return }
    // 듣고 있던 것을 먼저 멈춘다 — 계획이 바뀌었을 수 있다.
    joinAudio.current?.pause(); setJoinPlaying(false); setPlayingKey('')
    const key = joinPlanKey(r.plan)
    const gen = ++joinGen.current
    // 이 응답을 아직 써도 되는가. **저장은 묻지 않는다** — 누른 순간의 계획을 저장한다.
    const stale = () => (mode === 'save' ? ''
      : previewStale({ gen, key }, { gen: joinGen.current, key: livePlanKey(), alive: alive.current }))
    setJoining(mode)
    setJoinFault(null)
    try {
      const res = await window.api.cards.join(r.plan, mode, key) as
        { ok: boolean; data?: { path: string; seconds: number; canceled?: boolean }; error?: string }
      const afterCall = stale()
      if (afterCall) { const t = previewStaleText(afterCall); if (t && alive.current) setNotice(t); return }
      if (!res?.ok) throw new Error(res?.error || '최종 음성을 만들지 못했습니다')
      if (res.data?.canceled) return
      if (mode === 'save') {
        if (alive.current) setNotice(`최종 음성을 저장했습니다: ${res.data!.path}`)
        return
      }
      const url = await window.api.audio.getFileUrl(res.data!.path)
      // ★재생 직전에 한 번 더 본다 — 주소를 받는 사이에도 계획은 바뀔 수 있다.
      const beforePlay = stale()
      if (beforePlay) { const t = previewStaleText(beforePlay); if (t && alive.current) setNotice(t); return }
      const el = joinAudio.current || createManagedAudio(undefined)
      joinAudio.current = el
      el.src = url
      el.onended = () => { setJoinPlaying(false); setPlayingKey('') }
      el.onerror = () => { setJoinPlaying(false); setPlayingKey(''); if (alive.current) setNotice('최종 음성을 재생하지 못했습니다') }
      await el.play()
      if (alive.current) { setJoinPlaying(true); setPlayingKey(key) }
      else el.pause()
    } catch (e) {
      // ★카드와 채택은 그대로 둔다 — 다시 시도만 하면 된다.
      if (alive.current) setJoinFault({ mode, why: (e as Error)?.message || '최종 음성을 만들지 못했습니다' })
    } finally {
      if (alive.current && joinGen.current === gen) setJoining('')
    }
  }

  const generate = async (card: SynthesisCard) => {
    setNotice('')
    setCardFault(null)
    const why = await startCardGeneration(card)
    // ★실패해도 대사·생성본·채택은 그대로다. 그 카드 줄에서 바로 다시 할 수 있게 한다.
    if (why && alive.current) setCardFault({ id: card.id, why })
  }

  // 저장 — **타이머를 여기서 잡지 않는다.**
  // ★화면 수명과 저장 수명을 분리했다(2026-09-27). 예전에는 언마운트에서 타이머를 취소해
  //   메뉴를 빨리 옮기면 마지막 편집이 통째로 사라졌다. 이제 `lib/cardWorkSaver` 가 소유한다.
  const [save, setSave] = useState<SaveState>(() => saveState())
  useEffect(() => onSaveState(setSave), [])
  useEffect(() => {
    if (!state.dirty) return
    queueSave(serializeWork(state.cards, state.joins, state.importedFrom))
  }, [state.cards, state.joins, state.dirty, state.importedFrom])
  // 떠날 때는 **취소가 아니라 흘려보낸다.**
  useEffect(() => () => { void flushSave() }, [])

  // 이전 작업 — **묻기만 한다.** 스스로 되살리는 길은 없다.
  // 치워 둔 것까지 함께 보여 준다 — 거절했던 작업에 재시작 뒤에도 닿을 수 있어야 한다.
  // ★소리는 한 번에 한 곳만 — 음악·대화 결과 재생기와 같은 규칙이다.
  //   예전에는 이 화면만 규칙 밖에 있어, 원본 파형을 틀어 둔 채 생성본을 들으면 둘이 겹쳤다.
  const audioClaim = useAppStore((st) => st.audioClaim)
  useEffect(() => onManagedPlay(() => useAppStore.getState().claimAudio('card')), [])
  useEffect(() => { if (audioClaim && audioClaim.owner !== 'card') pauseManagedAudio() }, [audioClaim])

  const [restore, setRestore] = useState<RestoreChoice[] | null>(null)
  /** 지우기 전에 한 번 묻는다 — 되돌릴 수 없다. */
  const [restoreDrop, setRestoreDrop] = useState<RestoreChoice | null>(null)
  const [restoreWhy, setRestoreWhy] = useState('')

  /**
   * 이 작업 **기록이 적히는 파일**을 탐색기로 연다.
   * ★음원이 아니라 데이터 파일이다(2026-09-28 지시).
   */
  const openDataFile = async () => {
    setRestoreWhy('')
    try {
      const where = await window.api.app.dataFile()
      if (!where) { setRestoreWhy('데이터 파일 자리를 알 수 없습니다.'); return }
      await window.api.app.revealFile(where)
    } catch { if (alive.current) setRestoreWhy('데이터 파일을 열지 못했습니다.') }
  }

  /** 저장된 작업 하나를 지운다. 기록만 지운다 — 만든 소리 파일은 그대로다. */
  const dropSavedWork = async (c: RestoreChoice) => {
    setRestoreWhy('')
    const why = await deleteSavedWork(c.slot, c.index)
    if (!alive.current) return
    if (why) { setRestoreWhy(`지우지 못했습니다(${why})`); return }
    setRestoreDrop(null)
    const file = await loadSavedFile(true)
    const left = savedChoices(file)
    if (!alive.current) return
    setRestore(left.length ? left : null)
    if (!left.length) useSynthesisCards.getState().markAsked()
  }

  /**
   * 옛 작업 가져오기 — **진입점은 여기 한 곳이다.**
   *   고르기(list) → 가져올 내용 확인(plan) → 가져오기 → 새 카드 작업(done)
   * ★복사다. 옛 기록도, 하던 작업도 지우지 않는다(하던 것은 보관함으로 간다).
   */
  const [importStep, setImportStep] = useState<'list' | 'plan' | 'done' | null>(null)
  const [importList, setImportList] = useState<ImportPlan[]>([])
  const [importPick, setImportPick] = useState<ImportPlan | null>(null)
  const [importDup, setImportDup] = useState<{ slot: 'current' | 'kept'; index: number } | null>(null)
  const [importWhy, setImportWhy] = useState('')
  const [importing, setImporting] = useState(false)
  const [importDone, setImportDone] = useState('')
  /** 지우기 전에 한 번 묻는다 — 되돌릴 수 없다. */
  const [importDrop, setImportDrop] = useState<ImportPlan | null>(null)

  /** 이 옛 작업이 온 파일을 탐색기로 연다. 기록에 없으면 그렇다고 말한다. */
  const openLegacyFile = async (plan: ImportPlan) => {
    setImportWhy('')
    try {
      const all = await window.api.settings.get() as Record<string, unknown>
      const target = revealTarget(all, plan.work)
      if (!target) { setImportWhy('찾아갈 파일이 기록에 없습니다.'); return }
      await window.api.app.revealFile(target)
    } catch { if (alive.current) setImportWhy('파일 위치를 열지 못했습니다.') }
  }

  /**
   * 옛 기록 하나를 지운다. **기록만** 지운다 —
   * 그 작업이 만든 소리 파일도, 이미 가져온 카드 작업도 건드리지 않는다.
   */
  const dropLegacy = async (plan: ImportPlan) => {
    setImportWhy('')
    try {
      const all = await window.api.settings.get() as Record<string, unknown>
      const patch = removeLegacy(all, plan.work)
      if (!patch) { setImportWhy('이미 지워진 기록입니다.'); return }
      const r = await window.api.settings.set(patch.key, patch.value) as { ok?: boolean } | undefined
      if (r && r.ok === false) throw Error('저장하지 못했습니다')
      // ★지운 기록을 **들고 있는 쪽에게도 알린다.** 옛 화면은 문서를 메모리에 두고
      //   바뀔 때마다·떠날 때마다 다시 쓴다 — 알리지 않으면 탭 한 번에 되살아난다.
      if (plan.work.kind === 'lab') useLabStore.getState().forget()
      if (!alive.current) return
      setImportDrop(null)
      setImportList((list) => list.filter((x) => x.work.key !== plan.work.key))
      if (importPick?.work.key === plan.work.key) { setImportPick(null); setImportStep('list') }
    } catch (e) { if (alive.current) setImportWhy((e as Error)?.message || '지우지 못했습니다.') }
  }

  const openImport = async () => {
    setImportWhy(''); setImportPick(null); setImportDup(null); setImportStep('list')
    try {
      const all = await window.api.settings.get() as Record<string, unknown>
      const found = legacyWorks(all, Date.now())
      if (alive.current) setImportList(found)
    } catch {
      if (alive.current) { setImportList([]); setImportWhy('옛 작업을 읽지 못했습니다') }
    }
  }
  /** 고른 작업의 '가져올 내용' 을 연다. 이미 가져온 적이 있으면 그 사실을 먼저 말한다. */
  const pickImport = async (plan: ImportPlan) => {
    setImportWhy('')
    setImportPick(plan)
    try {
      const file = await loadSavedFile(true)
      const dup = alreadyImported(file, plan.work.key)
      if (alive.current) setImportDup(dup ? { slot: dup.slot, index: dup.index } : null)
    } catch { if (alive.current) setImportDup(null) }
    if (alive.current) setImportStep('plan')
  }
  /** 이미 가져온 작업을 **그대로 연다**(한 벌 더 만들지 않는다). */
  const openImported = () => {
    const dup = importDup
    if (!dup) return
    setImportStep(null)
    void (async () => {
      try {
        const file = await loadSavedFile(true)
        const work = dup.slot === 'current' ? file.current : file.kept[dup.index]
        if (!work) throw Error('가져온 작업을 찾지 못했습니다')
        const h = await hydrateWork(work)
        if (dup.slot === 'kept') adoptKept(dup.index)
        useSynthesisCards.getState().replaceAll(h.cards, h.joins, h.importedFrom)
      } catch (e) { if (alive.current) setNotice((e as Error)?.message || '가져온 작업을 열지 못했습니다') }
    })()
  }
  /**
   * 가져온다. **디스크에 먼저 쓰고, 성공했을 때만 화면을 바꾼다.**
   * 중간에 실패하면 카드가 한 장도 들어가지 않는다.
   */
  const runImport = async () => {
    const plan = importPick
    if (!plan || importing) return
    setImporting(true); setImportWhy('')
    try {
      // ① 변환 결과를 먼저 화면 모양으로 만들어 본다 — 여기서 실패하면 저장에 손대지 않는다.
      const h = await hydrateWork(plan.doc)
      // ② 저장까지 성공해야 가져온 것이다.
      const why = await importLegacyWork(plan.doc)
      if (why) throw Error(`저장하지 못했습니다(${why})`)
      useSynthesisCards.getState().replaceAll(h.cards, h.joins, h.importedFrom)
      if (!alive.current) return
      setImportDone(`${plan.work.title} · 카드 ${h.cards.length}장`)
      setImportStep('done')
    } catch (e) {
      if (alive.current) setImportWhy((e as Error)?.message || '가져오지 못했습니다')
    } finally { if (alive.current) setImporting(false) }
  }
  useEffect(() => {
    void (async () => {
      const file = await loadSavedFile()
      const st = useSynthesisCards.getState()
      if (st.asked || st.dirty) return
      if (!savedWorkHasContent(file.current) && !file.kept.length) return
      const choices = savedChoices(file)
      if (choices.length && alive.current) setRestore(choices)
    })()
  }, [])

  /** '나중에' — 지금 문서를 **옆으로 치운다.** 지우지 않는다. */
  const laterRestore = () => {
    useSynthesisCards.getState().markAsked()
    setRestore(null)
    void keepCurrentAside()
  }
  const takeRestore = (c: RestoreChoice) => {
    setRestore(null)
    void (async () => {
      try {
        // ★먼저 읽는다. 읽기에 실패하면 **저장 문서를 건드리지 않는다** —
        //   문서부터 바꿔 놓고 실패하면 고른 것도 하던 것도 잃는다(2차 검수 지적).
        const h = await hydrateWork(c.work)
        if (c.slot === 'kept') adoptKept(c.index)
        useSynthesisCards.getState().replaceAll(h.cards, h.joins, h.importedFrom)
      } catch { if (alive.current) setNotice('이전 작업을 불러오지 못했습니다') }
    })()
  }

  const locked = busy || loading

  /**
   * **다른 카드**가 지금 목소리를 준비하고 있는가.
   *
   * ★본체는 파이썬을 한 번에 하나만 돌린다. 그래서 남의 참조 트림이 도는 동안
   *   생성을 누르면 거절당한다(실측: 다섯 카드 중 넷이 그렇게 튕겼다).
   *   누르기 전에 말해 주려면 화면이 **모든 카드의 준비 상태**를 봐야 한다.
   */
  const preparingElsewhere = (id: string) => Object.entries(state.refs)
    .some(([cardId, r]) => cardId !== id && !!r && r.phase === 'preparing')
  const load = async (paths: string[], id?: string) => {
    if (busy || pending.current) return
    pending.current = true; setLoading(true); setNotice('')
    try {
      const sources: CardSource[] = []
      for (const path of paths) {
        if (!/\.(wav|mp3|flac|ogg|m4a|aac|wma|opus|aiff|aif|mp4|mkv|mov|avi|webm|m4v)$/i.test(path)) throw Error('음성·영상 파일을 선택하세요')
        const info = await window.api.audio.getFileInfo(path)
        if (!info || !Number.isFinite(info.duration) || info.duration <= 0) throw Error('파일 정보를 읽을 수 없습니다')
        sources.push({ path, name: info.name, duration: info.duration })
      }
      if (!alive.current) return
      const current = useAppStore.getState(); if (current.status === 'processing' || isCancelCleanupBusy(current.status) || current.errorInfo?.childAlive) { setNotice('작업이 끝난 뒤 다시 선택하세요'); return }
      if (id && sources[0]) { const card = useSynthesisCards.getState().cards.find(c => c.id === id); if (card) state.update(id, { source: sources[0], settings: { ...card.settings, reference: 'auto', start: 0, end: sources[0].duration } }) }
      else state.add(sources)
    } catch (e) { if (alive.current) setNotice(e instanceof Error ? e.message : '파일 불러오기 실패') }
    finally { pending.current = false; if (alive.current) setLoading(false) }
  }
  const pick = async (id?: string) => {
    if (locked || pending.current) return
    try { const value = await window.api.audio.selectFile(!id, 'source'); if (!alive.current || !value) return
      const paths = Array.isArray(value) ? value : [typeof value === 'string' ? value : (value as { path: string }).path]
      await load(paths.filter(Boolean), id)
    } catch { if (alive.current) setNotice('파일 선택 실패') }
  }
  const drop = (e: DragEvent, id?: string) => { e.preventDefault(); e.stopPropagation(); setHover(null)
    if (locked) return
    try { const files = [...e.dataTransfer.files]; if (id && files.length > 1) { setNotice('카드에는 파일 하나를 놓으세요'); return }
      const paths = files.map(f => window.api.utils.getPathForFile(f)).filter(Boolean); if (paths.length) void load(paths, id)
    } catch { setNotice('파일을 다시 선택하세요') }
  }
  // ★'이전 작업' 단추는 여기서 뺐다(2026-09-27). 같은 일을 하는 자리가 둘이면 어느 쪽이
  //   진짜인지 알 수 없고, 같은 testid 가 둘이 되어 검사도 갈린다.
  //   옛 버전으로 가는 길은 위쪽 버전 탭 하나뿐이다(SynthesisTabs).
  const workspace = useRef<HTMLDivElement>(null)
  const [focusCard, setFocusCard] = useState<string | null>(null)
  useLayoutEffect(() => {
    if (!focusCard || modal) return
    const card = Array.from(workspace.current?.querySelectorAll<HTMLElement>('[data-card-id]') || [])
      .find(el => el.dataset.cardId === focusCard)
    card?.scrollIntoView({ block: 'center', behavior: 'instant' })
    card?.querySelector<HTMLElement>('[data-testid="card-script"]')?.focus({ preventScroll: true })
    setFocusCard(null)
  }, [focusCard, modal])
  // Measure at the user's move, so a resized textarea cannot leave stale positions.
  const cardPositions = useRef(new Map<string, number>())
  const moveCard = (id: string, index: number) => {
    cardPositions.current.clear()
    if (state.cards.findIndex(c => c.id === id) === index) return
    for (const el of workspace.current?.querySelectorAll<HTMLElement>('[data-card-id]') || []) {
      cardPositions.current.set(el.dataset.cardId!, el.offsetTop)
    }
    state.move(id, index)
  }
  const order = state.cards.map(c => c.id).join('|')
  useLayoutEffect(() => {
    const elements = Array.from(workspace.current?.querySelectorAll<HTMLElement>('[data-card-id]') || [])
    const positions = new Map(elements.map(el => [el.dataset.cardId!, el.offsetTop]))
    const canAnimate = elements.length <= 30 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const animations: Animation[] = []
    for (const el of elements) {
      const before = cardPositions.current.get(el.dataset.cardId!)
      const after = positions.get(el.dataset.cardId!)!
      if (canAnimate && before !== undefined && before !== after) {
        animations.push(el.animate([{ transform: `translateY(${before - after}px)` }, { transform: 'none' }], { duration: 150, easing: 'ease-out' }))
      }
    }
    cardPositions.current.clear()
    return () => animations.forEach(a => a.cancel())
  }, [order])
  const readyCount = state.cards.length - planNow.blocks.filter(b => b.cardId).length
  const active = modal && 'id' in modal ? state.cards.find(c => c.id === modal.id) : null
  return <div ref={workspace} data-testid="synthesis-card-workspace" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }} onDrop={e => { if (e.dataTransfer.files.length) drop(e) }} style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
    <style>{`.af-card-progress{appearance:none;border:0;border-radius:3px;overflow:hidden;background:var(--border-subtle)}.af-card-progress::-webkit-progress-bar{background:var(--border-subtle)}.af-card-progress::-webkit-progress-value{background:var(--accent);border-radius:3px}.af-effect-slider{appearance:none;height:4px;border-radius:3px;background:linear-gradient(to right,var(--accent) var(--fill),var(--border-subtle) var(--fill));cursor:pointer}.af-effect-slider::-webkit-slider-thumb{appearance:none;width:15px;height:15px;border-radius:50%;background:var(--accent-light);box-shadow:0 0 0 4px rgba(139,92,246,.12)}.af-effect-slider:disabled{opacity:.4;cursor:not-allowed}.af-effect-group summary::-webkit-details-marker{display:none}.af-effect-group .af-effect-chevron{transition:transform 150ms ease;color:var(--text-muted)}.af-effect-group:not([open]) .af-effect-chevron{transform:rotate(180deg)}.af-card-modal::backdrop{background:rgba(5,7,12,.68);backdrop-filter:blur(4px)}.af-card-modal[open]{display:flex;flex-direction:column;animation:af-card-open 150ms ease-out}.af-take-detail{animation:af-card-open 120ms ease-out}.af-generation-card{transition:border-color 140ms ease,opacity 140ms ease}.af-card-modal button[aria-pressed="true"]{color:var(--accent-light)}.af-generation-card:focus-within{border-color:var(--accent)!important}.af-card-work-button:disabled{cursor:not-allowed;opacity:.4}@keyframes af-card-open{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){.af-card-modal[open],.af-take-detail{animation:none}}`}</style>
    <div style={{ ...row, paddingBottom: 2 }}><span style={{ fontSize: 13, fontWeight: 600 }}>생성 카드 <span style={{ ...muted, marginLeft: 5 }}>{state.cards.length}</span></span><span style={{ flex: 1 }}/>
      <button type="button" data-testid="import-legacy" disabled={locked} style={{ ...button, background: 'transparent' }}
        title="옛 화면에서 만들던 작업을 카드로 복사합니다. 옛 기록은 그대로 남습니다."
        onClick={() => void openImport()}><Icon name="history"/>옛 작업 가져오기</button>
    </div>
    {notice && <div role="status" style={{ ...row, fontSize: 12, color: 'var(--amber)' }}><span style={{ flex: 1 }}>{notice}</span><Action icon="close" label="알림 닫기" onClick={() => setNotice('')}/></div>}
    {save.phase === 'failed' && <div role="alert" data-testid="card-save-failed" style={{ ...row, fontSize: 12, color: 'var(--rose)', padding: '9px 12px', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderLeft: '3px solid var(--rose)', borderRadius: 8 }}>
      <span tabIndex={0} style={{ flex: 1 }} title={`저장 실패 코드: ${save.code || '알 수 없음'}`}>저장 실패</span>
      <button type="button" style={button} onClick={() => { void retrySave() }}>다시 저장</button></div>}
    {/* ★'남이 준비 중인가' 는 카드마다 같은 답을 쓴다 — 줄마다 다시 세지 않는다. */}
    {state.cards.map((card, index) => {
      const chosen = card.takes.find(t => t.id === card.adoptedId)
      // '수정 전' 판정은 shared/synthesisCardJob 이 소유한다 — 생성본 팝업과 같은 잣대를 쓴다.
      // 판정은 shared/synthesisCardJob 의 takeMark 하나가 한다 — 세 자리가 같은 말을 쓴다.
      const chosenMark = chosen && takeMark(
        { text: chosen.text, sourcePath: chosen.source.path, settings: chosen.settings, applied: chosen.applied, voice: chosen.voice, settingsUnknown: chosen.settingsUnknown },
        { text: card.text, sourcePath: card.source?.path || '', settings: card.settings, voice: voiceSnapshot(cardVoiceOf(card)) })
      const changed = chosenMark === 'stale'
      const ref = state.refs[card.id]
      const voice = cardVoiceOf(card)
      // ★엔진이 못 받는 설정을 **말한다.** 조용히 무시하거나 적용된 척하지 않는다.
      const notes = cardApplied(card.settings).notes
      const fault = voiceGenerateFault({
        voice, text: card.text,
        refReady: !!(ref && ref.phase === 'ready' && ref.clip),
        refMessage: ref?.message || '', busy: locked || !!state.job,
        // ★남의 준비가 도는 동안은 본체가 거절한다 — 누르기 전에 말한다.
        othersPreparing: preparingElsewhere(card.id),
        builtinUsable: true, builtinWhy: '',
      })
      const mine = state.job?.cardId === card.id
      const dropHere = over?.id === card.id
      return <article key={card.id} data-testid="generation-card" data-card-id={card.id} className="af-generation-card" aria-label={`${index + 1}번 생성 카드`} onDragOver={e => {
        if (!dragging || locked) return; e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setOver({ id: card.id, after: e.clientY > r.top + r.height / 2 })
      }} onDrop={e => {
        if (!dragging || locked) return; e.preventDefault(); e.stopPropagation(); const from = state.cards.findIndex(c => c.id === dragging); let to = index + (over?.after ? 1 : 0); if (from < to) to--; moveCard(dragging, to); setDragging(null); setOver(null)
      }} style={{ position: 'relative', border: `1px solid ${hover === card.id ? 'var(--accent)' : 'var(--border-subtle)'}`, borderRadius: 14, background: 'var(--bg-card)', boxShadow: '0 7px 24px rgba(0,0,0,.10)', opacity: dragging === card.id ? .5 : 1, overflowWrap: 'anywhere' }}>
        {dropHere && <div style={{ position: 'absolute', left: 0, right: 0, [over.after ? 'bottom' : 'top']: -9, height: 2, background: 'var(--accent)', pointerEvents: 'none' }}/>}
        <div style={{ ...row, padding: '13px 16px 0' }}>
          <button type="button" data-testid="card-drag-handle" title="카드 이동 · Alt+↑/↓" aria-label={`${index + 1}번 카드 이동`} disabled={locked} draggable={!locked} onDragStart={e => { e.dataTransfer.setData('application/x-audioforge-card', card.id); e.dataTransfer.effectAllowed = 'move'; setDragging(card.id) }} onDragEnd={() => { setDragging(null); setOver(null) }} onKeyDown={e => { if (!locked && e.altKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); moveCard(card.id, index + (e.key === 'ArrowUp' ? -1 : 1)) } }} style={{ ...button, padding: 5, border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'grab' }}><Icon name="grip"/></button>
          <span style={{ ...muted, fontVariantNumeric: 'tabular-nums' }}>{String(index + 1).padStart(2, '0')}</span>
          <input aria-label={`${index + 1}번 카드 이름`} value={card.label} disabled={locked} onChange={e => state.update(card.id, { label: e.target.value })} style={{ ...field, flex: '1 1 120px', padding: '6px 8px', background: 'transparent', borderColor: 'transparent', fontWeight: 600 }}/>
          <Action icon="copy" label={`${index + 1}번 카드 복제`} title="목소리·설정 복제 — 대사와 생성본은 새로 시작" disabled={locked} onClick={() => state.clone(card.id)}/>
          <Action icon="settings" label={`${index + 1}번 카드 고급 옵션`} disabled={locked} onClick={() => setModal({ type: 'settings', id: card.id })}/>
          <Action icon="trash" label={`${index + 1}번 카드 삭제`} disabled={locked} onClick={() => state.remove(card.id)}/>
        </div>
        <div style={{ padding: '6px 20px 0' }} onDragOver={e => { if (!dragging && !locked && e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); setHover(card.id) } }} onDragLeave={() => setHover(null)} onDrop={e => { if (!dragging) drop(e, card.id) }}>
          <div style={{ ...row, marginBottom: 1 }}>
            <span title={voice.kind === 'builtin' ? `${voice.voice.engineId} · ${voice.voice.language}` : card.source?.path}
              style={{ ...muted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {voice.kind === 'builtin' ? voice.voice.label : (card.source?.name || '목소리 미선택')}
              {voice.kind === 'builtin' && <span style={{ marginLeft: 6 }}>{voice.voice.language}</span>}
            </span>
            {voice.kind === 'builtin' && <PreviewButton disabled={locked}
              voice={{ path: voice.voice.path, engineId: voice.voice.engineId, label: voice.voice.label }}/>}
            <button type="button" aria-label={`${index + 1}번 카드 목소리 변경`} disabled={locked}
              onClick={() => setModal({ type: 'voice', id: card.id })}
              style={{ ...button, minHeight: 26, padding: '3px 7px', background: 'transparent', border: 0, fontSize: 11 }}>변경</button>
          </div>
          {/* ★기본 목소리에는 파형이 없다 — 없는 소리를 그리지 않는다. */}
          {voice.kind === 'reference' && card.source && !modal && <CompactVoiceWaveform path={ref?.audio || card.source.path} name={card.source.name} region={card.settings.reference === 'manual' ? { start: card.settings.start, duration: card.settings.end - card.settings.start } : null} disabled={locked}/>}
          {card.source && modal && <div style={{ height: 40 }}/>}
          <textarea data-testid="card-script" aria-label={`${index + 1}번 카드 대사`} placeholder="대사를 입력하세요" rows={2} spellCheck={false} disabled={locked} value={card.text} onChange={e => state.update(card.id, { text: e.target.value })} style={{ ...field, width: '100%', resize: 'vertical', minHeight: 76, fontSize: 15, lineHeight: 1.75, border: '1px solid var(--border-subtle)', background: 'var(--bg-base)', padding: '11px 13px', margin: '9px 0 0' }}/>
        </div>
        {/* ★실패도 '이 카드가 지금 하는 말' 이다 — 줄이 없으면 사유가 그려질 자리가 없다. */}
        {(mine || cardFault?.id === card.id || (ref && ref.phase !== 'ready') || notes.length > 0) && (
          <div data-testid="card-status" style={{ ...row, gap: 7, padding: '8px 20px 10px', minHeight: 22 }}>
            {ref && ref.phase !== 'ready' && ref.message && (
              <span tabIndex={0} title={ref.message} style={{ ...badge, color: ref.phase === 'failed' ? 'var(--rose)' : ref.phase === 'needs_region' ? 'var(--amber)' : 'var(--text-muted)' }}>{ref.phase === 'failed' ? '준비 실패' : ref.phase === 'needs_region' ? '구간 확인 필요' : '목소리 준비 중'}</span>
            )}
            {voice.kind === 'reference' && ref?.phase === 'failed' && <button type="button" data-testid="card-reference-retry" aria-label={`${index + 1}번 카드 목소리 준비 다시 시도`} title={ref.message || '같은 목소리와 구간으로 다시 준비합니다'} disabled={locked || !!state.job} style={{ ...button, padding: '3px 8px', minHeight: 26, fontSize: 11 }} onClick={() => forgetCardReference(card.id)}><Icon name="reset"/>다시 시도</button>}
            {cardFault?.id === card.id && <span data-testid="card-generate-fault" role="alert" style={{ ...row, gap: 6, fontSize: 11, color: 'var(--rose)' }}>
              <span tabIndex={0} title={cardFault.why} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cardFault.why}</span>
              <button type="button" data-testid="card-generate-retry" aria-label={`${index + 1}번 카드 다시 생성`}
                title="같은 대사·목소리·설정으로 다시 만듭니다. 지금까지의 생성본은 그대로 있습니다."
                disabled={locked || !!state.job} style={{ ...button, padding: '3px 8px', minHeight: 26, fontSize: 11 }}
                onClick={() => void generate(card)}><Icon name="reset"/>다시 생성</button>
            </span>}
            {voice.kind === 'reference' && ref?.phase === 'needs_region' && <button type="button" data-testid="card-reference-review" aria-label={`${index + 1}번 카드 참조 구간 확인`} title={ref.message || '이 카드의 참조 구간 설정을 엽니다'} disabled={locked || !!state.job} style={{ ...button, padding: '3px 8px', minHeight: 26, fontSize: 11 }} onClick={() => setModal({ type: 'settings', id: card.id, focusReference: true })}>구간 확인</button>}
            {/* ★엔진이 못 받는 설정을 그대로 말한다 — 조용히 버리지 않는다. */}
            {notes.map(n => <span key={n.field} tabIndex={0} title={n.reason} style={{ ...badge, color: 'var(--amber)' }}>{n.field === 'emotion' ? '감정 미적용' : n.field === 'pitch' ? '음높이 보정' : '속도 보정'}</span>)}
            {mine && (
              <span title={state.job?.message} role="status" style={{ ...row, flex: '1 1 180px', fontSize: 11, color: 'var(--text-secondary)' }}>{state.job?.cancelling ? '멈추는 중' : '생성 중'}<progress className="af-card-progress" aria-label="음성 생성 진행률" max={100} value={Math.max(0, Math.min(100, state.job?.percent || 0))} style={{ flex: '1 1 70px', height: 4, accentColor: 'var(--accent)' }}/>{Math.max(0, Math.min(100, Math.round(state.job?.percent || 0)))}%</span>
            )}
          </div>
        )}
        <div style={{ ...row, padding: '12px 20px', borderTop: '1px solid var(--border-subtle)' }}>
          <button type="button" data-testid="card-takes" onClick={() => setModal({ type: 'takes', id: card.id })} style={{ ...button, background: 'transparent' }}><Icon name="history"/>생성본 <span style={muted}>{card.takes.length}</span></button>
          {chosen && <button type="button" onClick={() => setModal({ type: 'takes', id: card.id })} style={{ ...button, background: 'transparent', border: 0, padding: '4px 0', minHeight: 28, fontSize: 11, color: chosen.missing ? 'var(--rose)' : chosenMark === 'unknown' ? 'var(--text-muted)' : changed ? 'var(--amber)' : 'var(--accent-light)' }} title={chosen.missing ? '채택한 파일이 없습니다. 다른 생성본을 선택하세요.' : chosenMark === 'unknown' ? '옛 작업에서 가져온 생성본입니다. 만들 때 쓴 설정과 참조 구간이 기록되어 있지 않습니다.' : changed ? '채택한 생성본은 수정 전 대사·목소리·설정으로 생성되었습니다' : '최종 연결에 사용할 생성본을 변경합니다'}>#{card.takes.indexOf(chosen) + 1} 채택{chosen.missing ? ' · 파일 없음' : chosenMark === 'unknown' ? ' · 기록 없음' : changed ? ' · 수정 전' : ''}</button>}
          <span style={{ flex: 1 }}/><span style={muted}>{card.text.length}자</span>
          {mine ? (
            <button type="button" data-testid="card-stop" className="af-card-work-button" onClick={() => void stopWork()}
              disabled={state.job?.cancelling} title="만들기를 멈춥니다. 여기까지 만든 생성본은 그대로 있습니다."
              style={{ ...button, minWidth: 85, color: 'var(--rose, #fb7185)' }}><Icon name="stop"/>{state.job?.cancelling ? '멈추는 중' : '멈추기'}</button>
          ) : (
            <button type="button" data-testid="card-generate" className="af-card-work-button" onClick={() => void generate(card)}
              disabled={!!fault} title={fault || '이 카드의 대사를 지금 목소리·설정으로 만듭니다'} style={primary}><Icon name="play"/>생성</button>
          )}
        </div>
      </article>
    })}
    {!state.cards.length ? <section aria-label="첫 목소리" style={{ border: '1px solid var(--border-subtle)', borderRadius: 14, background: 'var(--bg-card)', padding: 18, width: '100%', maxWidth: 580, alignSelf: 'center' }}>
      <div onDropCapture={e => drop(e)}>
        <MediaImportCard file={null} busy={loading} disabled={locked} testId="synthesis-empty-source" pickerLabel="합성할 목소리의 오디오 또는 영상 파일 선택"
          onPick={() => void pick()} onDrop={path => void load([path])} onClear={() => {}}/>
      </div>
      <div style={{ ...row, justifyContent: 'center', paddingTop: 14 }}>
        <button type="button" data-testid="add-generation-card" aria-label="기본 목소리 선택" title="참조 파일 없이 사용할 기본 목소리를 고릅니다" disabled={locked}
          onClick={() => setModal({ type: 'voice', id: '' })} style={{ ...button, background: 'transparent' }}><Icon name="play"/>기본 목소리로 시작</button>
      </div>
    </section> : <>
    <button type="button" data-testid="add-generation-card" aria-label="카드 추가" title="기본 목소리를 고르거나 음성·영상 파일을 끌어 놓아 카드를 추가합니다" disabled={locked} onClick={() => setModal({ type: 'voice', id: '' })}
      onDragOver={e => { if (!locked && !dragging && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setHover('add') } }} onDragLeave={() => setHover(null)} onDrop={e => drop(e)}
      style={{ ...button, minHeight: 52, width: '100%', border: `1px dashed ${hover === 'add' ? 'var(--accent)' : 'var(--border-default, var(--border-subtle))'}`, background: hover === 'add' ? 'var(--bg-elevated)' : 'transparent', color: 'var(--text-muted)' }}><Icon name="plus"/>{loading ? '불러오는 중' : '목소리 추가'}</button>
    </>}
    {state.removed && <div role="status" style={{ ...row, ...muted }}><span>카드 삭제됨</span><button type="button" disabled={locked} style={button} onClick={state.undo}>되돌리기</button></div>}
    {/* ★카드가 없으면 최종 음성 줄을 내보이지 않는다 — 누를 수 없는 단추만 남기지 않는다.
        실패 표시는 예외다: 마지막 시도가 실패했으면 카드가 비어도 그 사실은 보인다. */}
    {(state.cards.length > 0 || joinFault) && <footer data-testid="join-bar" style={{ ...row, position: 'sticky', bottom: 0, zIndex: 2, marginTop: 4, padding: '15px 18px', background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)', borderRadius: 12, boxShadow: '0 -8px 30px rgba(0,0,0,.12)' }}>
      <div style={{ flex: '1 1 130px' }}>
        <div style={{ ...row, fontSize: 13, fontWeight: 600 }}>최종 음성
          {joinBlocked && <span title={joinBlocked} style={{ ...muted, fontWeight: 400, color: 'var(--amber)' }}>{state.cards.length ? `${state.cards.length - readyCount}개 확인 필요` : '카드 없음'}</span>}</div>
        {joinFault && <span data-testid="join-fault" role="alert" style={{ ...row, gap: 6, fontSize: 11, color: 'var(--rose)' }}>
          <span tabIndex={0} title={joinFault.why} style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{joinFault.why}</span>
          <button type="button" data-testid="join-retry" title="같은 구성으로 다시 시도합니다. 카드와 채택은 그대로입니다."
            disabled={locked || joining !== ''} style={{ ...button, padding: '3px 8px', minHeight: 26, fontSize: 11 }}
            onClick={() => { const m = joinFault.mode; setJoinFault(null); void runJoin(m) }}><Icon name="reset"/>다시 시도</button>
        </span>}
        <button type="button" data-testid="join-sequence" aria-label="최종 음성 구성 보기" disabled={!state.cards.length} title="카드 순서와 채택한 생성본을 확인합니다" onClick={() => setModal({ type: 'sequence' })} style={{ ...button, background: 'transparent', border: 0, padding: '3px 0', minHeight: 26, fontSize: 11 }}><Icon name="list"/>{readyCount} / {state.cards.length} 준비</button>
      </div>
      <Action icon={joinPlaying ? 'stop' : 'play'} pressed={joinPlaying} label={joinPlaying ? '이어 듣기 멈춤' : '전체 이어 듣기'} testId="join-play"
        disabled={locked || !!joinBlocked || joining !== ''}
        title={joinPlaying ? '이어 듣기를 멈춥니다' : joinBlocked || (joining === 'preview' ? '이어 들을 음성을 준비하고 있습니다' : '카드 순서대로 채택한 생성본을 이어서 들려줍니다')}
        onClick={() => { if (joinPlaying) { joinAudio.current?.pause(); setJoinPlaying(false); setPlayingKey('') } else void runJoin('preview') }}>{joining === 'preview' ? '준비 중' : joinPlaying ? '멈춤' : '이어 듣기'}</Action>
      <Action icon="link" label="연결 조정" disabled={locked || !state.cards.length} onClick={() => setModal({ type: 'join' })}>연결 조정</Action>
      <button type="button" className="af-card-work-button" data-testid="join-save"
        disabled={locked || !!joinBlocked || joining !== ''}
        title={joinBlocked || '들은 것과 같은 방식으로 한 파일에 저장합니다'}
        onClick={() => void runJoin('save')} style={primary}>
        <Icon name="save"/>{joining === 'save' ? '저장 중' : '파일로 저장'}</button>
    </footer>}
    {modal?.type === 'sequence' && <Modal title="최종 음성 구성" close={() => setModal(null)} footer={<button type="button" style={button} onClick={() => setModal(null)}>닫기</button>}>
      <div style={{ display: 'grid', gap: 8 }}>{state.cards.map((card, i) => {
        const take = card.takes.find(t => t.id === card.adoptedId)
        const block = planNow.blocks.find(b => b.cardId === card.id)
        const mark = take && takeMark(
          { text: take.text, sourcePath: take.source.path, settings: take.settings, applied: take.applied, voice: take.voice, settingsUnknown: take.settingsUnknown },
          { text: card.text, sourcePath: card.source?.path || '', settings: card.settings, voice: voiceSnapshot(cardVoiceOf(card)) })
        const stale = mark === 'stale'
        const noRecord = mark === 'unknown'
        return <div key={card.id} data-testid="join-sequence-row" style={{ ...row, gap: 12, padding: 12, borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--bg-base)' }}>
          <span style={{ ...muted, fontVariantNumeric: 'tabular-nums' }}>{String(i + 1).padStart(2, '0')}</span>
          <div style={{ flex: '1 1 150px', minWidth: 0 }}><div style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{card.label}</div>
            <div data-testid="join-sequence-mark" title={block?.why || (stale ? '현재 편집과 다른 조건으로 만든 생성본입니다. 채택은 그대로 유지됩니다.' : noRecord ? '옛 작업에서 가져온 생성본입니다. 만들 때 쓴 설정과 참조 구간이 기록되어 있지 않습니다.' : undefined)} style={{ ...muted, marginTop: 4, color: block || stale ? 'var(--amber)' : 'var(--accent-light)' }}>{block ? (take ? '파일 확인 필요' : '채택 필요') : `생성본 ${String(card.takes.indexOf(take!) + 1).padStart(2, '0')} 채택${stale ? ' · 수정 전' : noRecord ? ' · 기록 없음' : ''}`}</div>
          </div>
          <button type="button" style={button} disabled={locked} aria-label={`${i + 1}번 카드 ${card.takes.length ? '생성본 선택' : '카드로 이동'}`} onClick={() => {
            if (card.takes.length) setModal({ type: 'takes', id: card.id, fromSequence: true })
            else { setModal(null); setFocusCard(card.id) }
          }}>{card.takes.length ? '생성본 선택' : '카드로 이동'}</button>
        </div>
      })}</div>
    </Modal>}
    {modal?.type === 'settings' && active && <Settings key={active.id} card={active} disabled={busy} focusReference={modal.focusReference} close={() => setModal(null)}/>}
    {modal?.type === 'takes' && active && <Takes key={active.id} card={active} disabled={busy} close={() => setModal(null)} back={modal.fromSequence ? () => setModal({ type: 'sequence' }) : undefined}/>}
    {modal?.type === 'join' && <Join cards={state.cards} disabled={busy} close={() => setModal(null)}/>}
    {modal?.type === 'voice' && <VoicePicker disabled={busy} close={() => setModal(null)}
      onFile={() => { void pick(modal.id || undefined) }}
      onBuiltin={(v) => {
        if (modal.id) useSynthesisCards.getState().setBuiltin(modal.id, v)
        else useSynthesisCards.getState().addBuiltin(v)
      }}/>}
    {/* 옛 작업 가져오기 — 고르기 → 확인 → 가져옴. 설명 문단 대신 목록과 짧은 사유만. */}
    {importStep === 'list' && <Modal title="옛 작업 가져오기" subtitle={importList.length ? `${importList.length}개` : ''} close={() => setImportStep(null)}>
      {importWhy && <div role="alert" data-testid="import-fault" style={{ fontSize: 12, color: 'var(--rose)', marginBottom: 10 }}>{importWhy}</div>}
      {!importList.length && !importWhy && <div data-testid="import-empty" style={muted}>가져올 옛 작업이 없습니다.</div>}
      {importDrop && <div data-testid="import-drop-ask" role="alert" style={{ ...row, gap: 8, fontSize: 12, color: 'var(--rose)', padding: '10px 12px', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 8, marginBottom: 10 }}>
        <span style={{ flex: 1 }}>{removeWarning(importDrop.work)}</span>
        <button type="button" data-testid="import-drop-cancel" style={button} onClick={() => setImportDrop(null)}>그대로 두기</button>
        <button type="button" data-testid="import-drop-yes" style={{ ...button, color: 'var(--rose)' }}
          onClick={() => void dropLegacy(importDrop)}>지우기</button>
      </div>}
      <div style={{ display: 'grid', gap: 8 }}>{importList.map(plan => (
        <div key={plan.work.key} data-testid="import-work" data-key={plan.work.key}
          style={{ ...row, gap: 12, padding: 14, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 10 }}>
          <span style={{ color: 'var(--accent-light)', display: 'flex' }}><Icon name="history"/></span>
          <div style={{ flex: '1 1 160px', minWidth: 0 }}>
            <div title={plan.work.title} style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{plan.work.title}</div>
            <div style={muted}>{importSummary(plan.work)}</div>
          </div>
          <Action icon="folder" testId="import-reveal"
            label={`${plan.work.title} 파일 위치 열기`}
            title="이 옛 작업이 온 파일을 탐색기에서 엽니다"
            onClick={() => void openLegacyFile(plan)}/>
          <Action icon="trash" testId="import-drop"
            label={`${plan.work.title} 기록 지우기`}
            title="이 옛 기록을 지웁니다. 만든 소리 파일과 가져온 카드 작업은 그대로입니다."
            onClick={() => setImportDrop(plan)}/>
          <button type="button" data-testid="import-pick" style={button} onClick={() => void pickImport(plan)}>내용 보기</button>
        </div>
      ))}</div>
    </Modal>}

    {importStep === 'plan' && importPick && <Modal title="가져올 내용" subtitle={importPick.work.title}
      close={() => setImportStep('list')}
      footer={<>
        <button type="button" style={button} onClick={() => setImportStep('list')}>뒤로</button>
        <span style={{ flex: 1 }}/>
        <button type="button" data-testid="import-run" disabled={importing} style={primary}
          title="지금 작업은 보관함으로 옮기고, 가져온 작업을 엽니다. 옛 기록은 그대로 남습니다."
          onClick={() => void runImport()}><Icon name="check"/>{importing ? '가져오는 중…' : importDup ? '따로 한 벌 더 가져오기' : '가져오기'}</button>
      </>}>
      {importDup && <div data-testid="import-duplicate" role="status" style={{ ...row, gap: 8, fontSize: 12, color: 'var(--amber)', padding: '9px 12px', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 8, marginBottom: 10 }}>
        <span style={{ flex: 1 }}>이미 가져온 작업입니다.</span>
        <button type="button" data-testid="import-open-existing" style={button}
          title="전에 가져온 카드 작업을 그대로 엽니다" onClick={openImported}>가져온 작업 열기</button>
      </div>}
      {importWhy && <div role="alert" data-testid="import-fault" style={{ fontSize: 12, color: 'var(--rose)', marginBottom: 10 }}>{importWhy}</div>}
      <div data-testid="import-counts" style={{ ...row, gap: 14, fontSize: 13, padding: '10px 12px', background: 'var(--bg-base)', borderRadius: 9 }}>
        <span>카드 <b>{importPick.work.cardCount}</b>장</span>
        <span>생성본 <b>{importPick.work.takeCount}</b>개</span>
      </div>
      {importPick.work.skips.length > 0 && <div data-testid="import-skips" style={{ marginTop: 12 }}>
        <div style={{ ...muted, marginBottom: 6 }}>옮기지 못하는 항목</div>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
          {importPick.work.skips.map(k => (
            <li key={k.what} style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              <span style={{ color: 'var(--amber)' }}>{k.what}</span> <span style={muted}>— {k.why}</span>
            </li>
          ))}
        </ul>
      </div>}
    </Modal>}

    {importStep === 'done' && <Modal title="가져왔습니다" subtitle={importDone} close={() => setImportStep(null)}
      footer={<button type="button" data-testid="import-close" style={primary} onClick={() => setImportStep(null)}>카드 작업 열기</button>}>
      <div data-testid="import-done" style={{ ...row, gap: 8, fontSize: 13 }}>
        <span>가져온 작업이 지금 카드 작업으로 열렸습니다.</span>
        <span tabIndex={0} title="하던 작업은 보관함에 있습니다. 이전 작업 목록에서 다시 열 수 있습니다. 옛 화면의 기록도 그대로입니다." style={badge}>보존됨</span>
      </div>
    </Modal>}

    {restore && <Modal title="이전 작업을 불러올까요?" subtitle={`${restore.length}개`} close={laterRestore}
      footer={<button type="button" style={button} title="불러오기를 닫고 현재 카드로 계속합니다"
        onClick={laterRestore}>현재 작업 계속</button>}>
      {restoreWhy && <div role="alert" data-testid="restore-fault" style={{ fontSize: 12, color: 'var(--rose)', marginBottom: 10 }}>{restoreWhy}</div>}
      {restoreDrop && <div data-testid="restore-drop-ask" role="alert" style={{ ...row, gap: 8, fontSize: 12, color: 'var(--rose)', padding: '10px 12px', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 8, marginBottom: 10 }}>
        <span style={{ flex: 1 }}>{removeWorkWarning(restoreDrop.work)}</span>
        <button type="button" data-testid="restore-drop-cancel" style={button} onClick={() => setRestoreDrop(null)}>그대로 두기</button>
        <button type="button" data-testid="restore-drop-yes" style={{ ...button, color: 'var(--rose)' }}
          onClick={() => void dropSavedWork(restoreDrop)}>지우기</button>
      </div>}
      <div style={{ display: 'grid', gap: 8 }}>{restore.map((c) => (
        <div key={`${c.slot}:${c.index}`} style={{ ...row, gap: 12, padding: '14px', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 10 }}>
          <span style={{ color: 'var(--accent-light)', display: 'flex' }}><Icon name="history"/></span>
          <div style={{ flex: '1 1 160px', minWidth: 0 }}>
            <div style={{ ...row, gap: 7, marginBottom: 5 }}><span title={c.work.cards.map(card => card.label || card.sourceName).join(' · ')} style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{c.work.cards[0]?.label || c.work.cards[0]?.sourceName || '카드 작업'}</span>
              {c.slot === 'kept' && <span style={badge} title="이전에 보관한 작업입니다">보관됨</span>}
            </div><div style={muted}>{c.summary}</div>
          </div>
          <Action icon="folder" testId="restore-reveal"
            label="작업 기록 파일 위치 열기"
            title="이 작업 기록이 적히는 데이터 파일을 탐색기에서 엽니다"
            onClick={() => void openDataFile()}/>
          <Action icon="trash" testId="restore-drop"
            label="이 작업 기록 지우기"
            title="이 작업 기록을 지웁니다. 만들어 둔 소리 파일은 그대로입니다."
            onClick={() => setRestoreDrop(c)}/>
          <button type="button" style={button} onClick={() => takeRestore(c)}>불러오기</button>
        </div>
      ))}</div>
    </Modal>}
  </div>
}
