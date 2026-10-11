import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type DragEvent } from 'react'
import { useAppStore } from '../stores/app.store'
import { useSynthesisCards, type SynthesisCard, type CardSource, type CardSettings, type CardTake, type JoinSettings } from '../stores/synthesisCards.store'
import { isCancelCleanupBusy } from '../../shared/cancelContract'
import CompactVoiceWaveform from './CompactVoiceWaveform'
import { createManagedAudio } from '../lib/playbackVolume'
import { cancelFailureText, type CancelUiStatus } from '../../shared/cancelContract'
import { cancelAlreadyOverText, useCancelLifecycle } from '../hooks/useCancelLifecycle'
import {
  cardApplied, cardEventFault, cardGenerateFault, takeIsStale, CARD_PITCH_MIN, CARD_PITCH_MAX, CARD_PITCH_STEP,
} from '../../shared/synthesisCardJob'
import {
  savedChoices, savedWorkHasContent, type RestoreChoice,
} from '../../shared/synthesisCardSave'
import {
  prepareCardReference, forgetCardReference, releaseCardOwnership,
  startCardGeneration, acceptCardResult, endCardJob, serializeWork, hydrateWork,
} from '../lib/cardSynthesis'
import {
  loadSavedFile, queueSave, flushSave, retrySave, keepCurrentAside, adoptKept,
  onSaveState, saveState, type SaveState,
} from '../lib/cardWorkSaver'

type IconName = 'stop' | 'reset' | 'plus' | 'grip' | 'settings' | 'copy' | 'trash' | 'play' | 'folder' | 'text' | 'history' | 'close' | 'check' | 'link' | 'save' | 'file'
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
    reset: <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>,
    plus: <path d="M12 5v14M5 12h14"/>, grip: <path d="M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01"/>,
    settings: <><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 4H6a2 2 0 0 0-2 2v9"/></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></>,
    play: <path d="m9 5 10 7-10 7z"/>, folder: <path d="M3 7V4h7l2 3h9v13H3z"/>, text: <><path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6"/></>,
    history: <><path d="M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2"/></>, close: <path d="m6 6 12 12M6 18 18 6"/>, check: <path d="m5 12 4 4L19 6"/>,
    link: <><path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M13 9l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/></>,
    save: <><path d="M5 3h12l4 4v14H3V3zM7 3v6h10V3M7 21v-8h10v8"/></>, file: <><path d="M14 3H5v18h14V8zM14 3v5h5M9 13v4M13 11v6"/></>,
  }
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'grip' ? 3 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }
const muted: CSSProperties = { fontSize: 11, color: 'var(--text-muted)' }
const badge: CSSProperties = { ...muted, display: 'inline-flex', alignItems: 'center', padding: '3px 7px', borderRadius: 5, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', lineHeight: 1.3 }
const field: CSSProperties = { font: 'inherit', fontSize: 13, color: 'var(--text-primary)', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '9px 11px', minWidth: 0, boxSizing: 'border-box' }
const button: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 34, padding: '7px 11px', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-elevated)', color: 'var(--text-secondary)', font: 'inherit', fontSize: 12, cursor: 'pointer' }
const primary: CSSProperties = { ...button, background: 'var(--accent, #8b5cf6)', color: '#fff', borderColor: 'transparent' }
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
const DISCONNECTED = '최종 음성의 이어 듣기·연결부 재생·한 파일로 저장은 아직 연결되지 않았습니다.'
function Action({ icon, label, onClick, disabled = false, children, title }: { icon: IconName; label: string; onClick?: () => void; disabled?: boolean; children?: ReactNode; title?: string }) {
  return <button type="button" aria-label={label} title={title || label} disabled={disabled} onClick={onClick} style={{ ...button, padding: children ? '7px 11px' : 8, opacity: disabled ? .4 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}><Icon name={icon}/>{children}</button>
}
function Modal({ title, subtitle, close, children, footer }: { title: string; subtitle?: string; close: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const el = ref.current; el?.showModal(); return () => el?.close() }, [])
  return <dialog ref={ref} className="af-card-modal" aria-label={title} onCancel={e => { e.preventDefault(); close() }}
    style={{ margin: 'auto', width: 650, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 48px)', padding: 0, border: '1px solid var(--border-default, var(--border-subtle))', borderRadius: 16, background: 'var(--bg-card)', color: 'var(--text-primary)', boxShadow: '0 24px 100px rgba(0,0,0,.5)' }}>
    <div style={{ ...row, padding: '19px 22px', borderBottom: '1px solid var(--border-subtle)' }}><div style={{ flex: 1, minWidth: 0 }}><h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>{subtitle && <div style={{ ...muted, marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</div>}</div><Action icon="close" label="팝업 닫기" onClick={close}/></div>
    <div style={{ padding: 22, overflowY: 'auto', maxHeight: 'calc(100vh - 230px)' }}>{children}</div>
    {footer && <div style={{ ...row, padding: '14px 22px', justifyContent: 'flex-end', borderTop: '1px solid var(--border-subtle)' }}>{footer}</div>}
  </dialog>
}
function Settings({ card, close, disabled }: { card: SynthesisCard; close: () => void; disabled: boolean }) {
  const [draft, setDraft] = useState<CardSettings>({ ...card.settings, pitch: cardApplied(card.settings).pitch })
  const set = (patch: Partial<CardSettings>) => setDraft(s => ({ ...s, ...patch }))
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
      <details className="af-effect-group" data-testid="card-reference-settings" open={card.settings.reference === 'manual' ? true : undefined} style={panel}>
        <summary style={heading}><span style={{ flex: 1 }}>참조 구간</span><span style={muted}>{draft.reference === 'auto' ? '자동' : `${draft.start.toFixed(1)}–${draft.end.toFixed(1)}초`}</span><span className="af-effect-chevron" aria-hidden="true">⌃</span></summary>
        <div style={{ display: 'grid', gap: 12, paddingBottom: 16 }}><div style={{ ...row, justifyContent: 'space-between' }}><select aria-label="참조 구간 방식" style={field} value={draft.reference} onChange={e => set({ reference: e.target.value as CardSettings['reference'] })}><option value="auto">자동</option><option value="manual">직접 지정</option></select>{resetButton('참조 구간 초기화', () => set({ reference: 'auto', start: 0, end: duration }))}</div>
          {card.source && <CompactVoiceWaveform path={cardAudio || card.source.path} name={card.source.name} disabled={disabled} region={draft.reference === 'manual' && valid ? { start: draft.start, duration: draft.end - draft.start } : null}/>}
          {draft.reference === 'manual' && <div style={row}><label style={{ ...row, flex: '1 1 130px' }}>시작<input aria-label="참조 시작 초" style={{ ...field, width: 95 }} type="number" min="0" max={duration} step=".1" value={draft.start} onChange={e => set({ start: +e.target.value })}/>초</label><label style={{ ...row, flex: '1 1 130px' }}>끝<input aria-label="참조 끝 초" style={{ ...field, width: 95 }} type="number" min="0" max={duration} step=".1" value={draft.end} onChange={e => set({ end: +e.target.value })}/>초</label>{!valid && <span role="alert" style={{ color: 'var(--rose)', fontSize: 12 }}>구간 확인 필요</span>}</div>}
        </div>
      </details>
      <div style={{ ...panel, ...row, padding: '14px 16px', color: 'var(--text-muted)', fontSize: 12 }} title="감정은 감정별 참조 음성이 필요합니다. 카드의 감정 참조 등록은 아직 연결되지 않았습니다."><span style={{ flex: 1 }}>감정 참조</span><span>{draft.emotion && draft.emotion !== '자연스럽게' ? `${draft.emotion} · 미적용` : '미연결'}</span>{draft.emotion && draft.emotion !== '자연스럽게' && <button type="button" aria-label="미지원 감정 선택 해제" style={button} onClick={() => set({ emotion: '자연스럽게' })}>해제</button>}</div>
    </fieldset>
  </Modal>
}

function Takes({ card, close, disabled }: { card: SynthesisCard; close: () => void; disabled: boolean }) {
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
      const el = audio.current || createManagedAudio(); audio.current = el; el.src = url
      el.onended = () => setPlaying(null); el.onerror = () => { setPlaying(null); setError('파일 재생 실패') }
      await el.play(); if (token === epoch.current) setPlaying(take.id)
    } catch { if (token === epoch.current) setError('파일 재생 실패') }
  }
  return <Modal title="생성본" subtitle={card.label} close={close} footer={<button type="button" style={button} onClick={close}>닫기</button>}>
    {!card.takes.length && <div style={{ display: 'grid', justifyItems: 'center', gap: 13, padding: '45px 0', color: 'var(--text-muted)' }}><Icon name="history"/><span>생성본 없음</span></div>}
    <div style={{ display: 'grid', gap: 2 }}>{card.takes.map((take, i) => <div key={take.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={row}><button type="button" disabled={disabled || !!take.missing} aria-label={`생성본 ${i + 1} 채택`} aria-pressed={take.id === card.adoptedId} title={take.missing ? '파일이 사라져 채택할 수 없습니다' : '최종 연결에 사용할 생성본'} onClick={() => useSynthesisCards.getState().update(card.id, { adoptedId: take.id })} style={{ ...button, color: take.id === card.adoptedId ? 'var(--accent-light)' : 'var(--text-muted)' }}><Icon name="check"/></button>
      <div style={{ flex: '1 1 130px' }}><div style={{ fontSize: 13 }}>생성본 {String(i + 1).padStart(2, '0')}{card.adoptedId === take.id && <span style={{ ...muted, marginLeft: 8 }}>채택</span>}
        {/* ★지금 카드와 다른 조건으로 만든 결과임을 구분한다(현재 대사를 덮어 보여 주지 않는다). */}
        {takeIsStale({ text: take.text, sourcePath: take.source.path, settings: take.settings, applied: appliedOf(take) as never }, { text: card.text, sourcePath: card.source?.path || '', settings: card.settings }) && <span style={{ ...badge, marginLeft: 8, color: 'var(--amber)' }}>수정 전</span>}
        {take.missing && <span style={{ ...badge, marginLeft: 8, color: 'var(--rose)' }}>파일 없음</span>}</div><time style={muted}>{new Date(take.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div>
      <Action icon="play" label={`생성본 ${i + 1} ${playing === take.id ? '정지' : '재생'}`} onClick={() => void play(take)} disabled={disabled || !!take.missing}/>
      <Action icon="folder" label={`생성본 ${i + 1} 파일 위치`} onClick={() => { void window.api.app.revealFile(take.path).catch(() => setError('파일 위치 열기 실패')) }}/>
      <Action icon="text" label={`생성본 ${i + 1} 대사 보기`} onClick={() => inspect(inspected === take.id ? null : take.id)}/></div>
      {inspected === take.id && (() => { const a = appliedOf(take); return (
        <div style={{ padding: '13px 8px 3px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13 }}>
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
      <div style={{ ...row, gap: 20 }}><label style={row} title="인물 간 음량 차이를 완화합니다. 연결 처리 구현 후 적용됩니다."><input type="checkbox" checked={draft.level} onChange={e => setDraft(s => ({ ...s, level: e.target.checked }))}/>음량 맞추기</label><label style={row} title="말끝과 숨소리를 보존하며 접합부를 다듬습니다. 연결 처리 구현 후 적용됩니다."><input type="checkbox" checked={draft.edges} onChange={e => setDraft(s => ({ ...s, edges: e.target.checked }))}/>경계 다듬기</label></div>
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 5 }}>{cards.slice(0, -1).map((card, i) => {
        const next = cards[i + 1], key = `${card.id}:${next.id}`
        return <div key={key} style={{ ...row, padding: '14px 0', borderBottom: '1px solid var(--border-subtle)' }}><span style={{ flex: '1 1 200px', fontSize: 12, overflowWrap: 'anywhere' }}>{String(i + 1).padStart(2, '0')} {card.label} <span style={muted}>→</span> {String(i + 2).padStart(2, '0')} {next.label}</span><input type="number" aria-label={`${i + 1}번과 ${i + 2}번 카드 간격`} title="두 카드 사이의 개별 간격" style={{ ...field, width: 85 }} min="0" max="5" step=".05" value={draft.gaps[key] ?? draft.gap} onChange={e => setDraft(s => ({ ...s, gaps: { ...s.gaps, [key]: Math.max(0, Math.min(5, +e.target.value)) } }))}/><span style={muted}>초</span><Action icon="play" label={`${i + 1}번 연결부 듣기`} disabled title={DISCONNECTED}/></div>
      })}</div>
    </fieldset>
  </Modal>
}
export default function SynthesisCardWorkspace() {
  const state = useSynthesisCards(), source = useAppStore(s => s.fileInfo), status = useAppStore(s => s.status), childAlive = useAppStore(s => s.errorInfo?.childAlive)
  const busy = status === 'processing' || isCancelCleanupBusy(status) || !!childAlive
  const [modal, setModal] = useState<{ type: 'settings' | 'takes'; id: string } | { type: 'join' } | null>(null)
  const [notice, setNotice] = useState(''), [loading, setLoading] = useState(false), [hover, setHover] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null), [over, setOver] = useState<{ id: string; after: boolean } | null>(null)
  const alive = useRef(true), pending = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
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
      endCardJob()
      if (alive.current) setNotice(String(o?.message || '만들기에 실패했습니다'))
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

  const generate = async (card: SynthesisCard) => {
    setNotice('')
    const why = await startCardGeneration(card)
    if (why && alive.current) setNotice(why)
  }

  // 저장 — **타이머를 여기서 잡지 않는다.**
  // ★화면 수명과 저장 수명을 분리했다(2026-09-27). 예전에는 언마운트에서 타이머를 취소해
  //   메뉴를 빨리 옮기면 마지막 편집이 통째로 사라졌다. 이제 `lib/cardWorkSaver` 가 소유한다.
  const [save, setSave] = useState<SaveState>(() => saveState())
  useEffect(() => onSaveState(setSave), [])
  useEffect(() => {
    if (!state.dirty) return
    queueSave(serializeWork(state.cards, state.joins))
  }, [state.cards, state.joins, state.dirty])
  // 떠날 때는 **취소가 아니라 흘려보낸다.**
  useEffect(() => () => { void flushSave() }, [])

  // 이전 작업 — **묻기만 한다.** 스스로 되살리는 길은 없다.
  // 치워 둔 것까지 함께 보여 준다 — 거절했던 작업에 재시작 뒤에도 닿을 수 있어야 한다.
  const [restore, setRestore] = useState<RestoreChoice[] | null>(null)
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
        useSynthesisCards.getState().replaceAll(h.cards, h.joins)
      } catch { if (alive.current) setNotice('이전 작업을 불러오지 못했습니다') }
    })()
  }

  const locked = busy || loading
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
  const active = modal && 'id' in modal ? state.cards.find(c => c.id === modal.id) : null
  return <div data-testid="synthesis-card-workspace" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }} onDrop={e => { if (e.dataTransfer.files.length) drop(e) }} style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
    <style>{`.af-card-progress{appearance:none;border:0;border-radius:3px;overflow:hidden;background:var(--border-subtle)}.af-card-progress::-webkit-progress-bar{background:var(--border-subtle)}.af-card-progress::-webkit-progress-value{background:var(--accent);border-radius:3px}.af-effect-slider{appearance:none;height:4px;border-radius:3px;background:linear-gradient(to right,var(--accent) var(--fill),var(--border-subtle) var(--fill));cursor:pointer}.af-effect-slider::-webkit-slider-thumb{appearance:none;width:15px;height:15px;border-radius:50%;background:var(--accent-light);box-shadow:0 0 0 4px rgba(139,92,246,.12)}.af-effect-slider:disabled{opacity:.4;cursor:not-allowed}.af-effect-group summary::-webkit-details-marker{display:none}.af-effect-group .af-effect-chevron{transition:transform 150ms ease;color:var(--text-muted)}.af-effect-group:not([open]) .af-effect-chevron{transform:rotate(180deg)}.af-card-modal::backdrop{background:rgba(5,7,12,.68);backdrop-filter:blur(4px)}.af-card-modal[open]{animation:af-card-open 150ms ease-out}.af-generation-card:focus-within{border-color:var(--accent)!important}.af-card-work-button:disabled{cursor:not-allowed;opacity:.4}@keyframes af-card-open{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){.af-card-modal[open]{animation:none}}`}</style>
    <div style={{ ...row, paddingBottom: 2 }}><span style={{ fontSize: 13, fontWeight: 600 }}>생성 카드 <span style={{ ...muted, marginLeft: 5 }}>{state.cards.length}</span></span><span style={{ flex: 1 }}/><button type="button" data-testid="open-legacy-synthesis" disabled={locked} style={{ ...button, background: 'transparent' }} title="기존 문장별 제작·대본 배역 작업을 그대로 엽니다" onClick={() => state.setView('legacy')}>이전 작업</button></div>
    {notice && <div role="status" style={{ ...row, fontSize: 12, color: 'var(--amber)' }}><span style={{ flex: 1 }}>{notice}</span><Action icon="close" label="알림 닫기" onClick={() => setNotice('')}/></div>}
    {save.phase === 'failed' && <div role="alert" data-testid="card-save-failed" style={{ ...row, fontSize: 12, color: 'var(--rose)', padding: '9px 12px', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderLeft: '3px solid var(--rose)', borderRadius: 8 }}>
      <span tabIndex={0} style={{ flex: 1 }} title={`저장 실패 코드: ${save.code || '알 수 없음'}`}>저장 실패</span>
      <button type="button" style={button} onClick={() => { void retrySave() }}>다시 저장</button></div>}
    {state.cards.map((card, index) => {
      const chosen = card.takes.find(t => t.id === card.adoptedId)
      // '수정 전' 판정은 shared/synthesisCardJob 이 소유한다 — 생성본 팝업과 같은 잣대를 쓴다.
      const changed = chosen && takeIsStale(
        { text: chosen.text, sourcePath: chosen.source.path, settings: chosen.settings, applied: chosen.applied },
        { text: card.text, sourcePath: card.source?.path || '', settings: card.settings })
      const ref = state.refs[card.id]
      // ★엔진이 못 받는 설정을 **말한다.** 조용히 무시하거나 적용된 척하지 않는다.
      const notes = cardApplied(card.settings).notes
      const fault = cardGenerateFault({
        hasSource: !!card.source, text: card.text,
        refReady: !!(ref && ref.phase === 'ready' && ref.clip),
        refMessage: ref?.message || '', busy: locked || !!state.job,
      })
      const mine = state.job?.cardId === card.id
      const dropHere = over?.id === card.id
      return <article key={card.id} data-testid="generation-card" data-card-id={card.id} className="af-generation-card" aria-label={`${index + 1}번 생성 카드`} onDragOver={e => {
        if (!dragging || locked) return; e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setOver({ id: card.id, after: e.clientY > r.top + r.height / 2 })
      }} onDrop={e => {
        if (!dragging || locked) return; e.preventDefault(); e.stopPropagation(); const from = state.cards.findIndex(c => c.id === dragging); let to = index + (over?.after ? 1 : 0); if (from < to) to--; state.move(dragging, to); setDragging(null); setOver(null)
      }} style={{ position: 'relative', border: `1px solid ${hover === card.id ? 'var(--accent)' : 'var(--border-subtle)'}`, borderRadius: 14, background: 'var(--bg-card)', boxShadow: '0 7px 24px rgba(0,0,0,.10)', opacity: dragging === card.id ? .5 : 1, overflowWrap: 'anywhere' }}>
        {dropHere && <div style={{ position: 'absolute', left: 0, right: 0, [over.after ? 'bottom' : 'top']: -9, height: 2, background: 'var(--accent)', pointerEvents: 'none' }}/>}
        <div style={{ ...row, padding: '13px 16px 0' }}>
          <button type="button" data-testid="card-drag-handle" title="카드 이동 · Alt+↑/↓" aria-label={`${index + 1}번 카드 이동`} disabled={locked} draggable={!locked} onDragStart={e => { e.dataTransfer.setData('application/x-audioforge-card', card.id); e.dataTransfer.effectAllowed = 'move'; setDragging(card.id) }} onDragEnd={() => { setDragging(null); setOver(null) }} onKeyDown={e => { if (!locked && e.altKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); state.move(card.id, index + (e.key === 'ArrowUp' ? -1 : 1)) } }} style={{ ...button, padding: 5, border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'grab' }}><Icon name="grip"/></button>
          <span style={{ ...muted, fontVariantNumeric: 'tabular-nums' }}>{String(index + 1).padStart(2, '0')}</span>
          <input aria-label={`${index + 1}번 카드 이름`} value={card.label} disabled={locked} onChange={e => state.update(card.id, { label: e.target.value })} style={{ ...field, flex: '1 1 120px', padding: '6px 8px', background: 'transparent', borderColor: 'transparent', fontWeight: 600 }}/>
          <Action icon="copy" label={`${index + 1}번 카드 복제`} title="목소리·설정 복제 — 대사와 생성본은 새로 시작" disabled={locked} onClick={() => state.clone(card.id)}/>
          <Action icon="settings" label={`${index + 1}번 카드 고급 옵션`} disabled={locked} onClick={() => setModal({ type: 'settings', id: card.id })}/>
          <Action icon="trash" label={`${index + 1}번 카드 삭제`} disabled={locked} onClick={() => state.remove(card.id)}/>
        </div>
        <div style={{ padding: '6px 20px 0' }} onDragOver={e => { if (!dragging && !locked && e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); setHover(card.id) } }} onDragLeave={() => setHover(null)} onDrop={e => { if (!dragging) drop(e, card.id) }}>
          <div style={{ ...row, marginBottom: 1 }}><span title={card.source?.path} style={{ ...muted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.source?.name || '목소리 미선택'}</span><button type="button" aria-label={`${index + 1}번 카드 음원 변경`} disabled={locked} onClick={() => void pick(card.id)} style={{ ...button, minHeight: 26, padding: '3px 7px', background: 'transparent', border: 0, fontSize: 11 }}>변경</button></div>
          {card.source && !modal && <CompactVoiceWaveform path={ref?.audio || card.source.path} name={card.source.name} region={card.settings.reference === 'manual' ? { start: card.settings.start, duration: card.settings.end - card.settings.start } : null} disabled={locked}/>}
          {card.source && modal && <div style={{ height: 40 }}/>}
          <textarea data-testid="card-script" aria-label={`${index + 1}번 카드 대사`} placeholder="대사를 입력하세요" rows={2} spellCheck={false} disabled={locked} value={card.text} onChange={e => state.update(card.id, { text: e.target.value })} style={{ ...field, width: '100%', resize: 'vertical', minHeight: 76, fontSize: 15, lineHeight: 1.75, border: '1px solid var(--border-subtle)', background: 'var(--bg-base)', padding: '11px 13px', margin: '9px 0 0' }}/>
        </div>
        {(mine || (ref && ref.phase !== 'ready') || notes.length > 0) && (
          <div data-testid="card-status" style={{ ...row, gap: 7, padding: '8px 20px 10px', minHeight: 22 }}>
            {ref && ref.phase !== 'ready' && ref.message && (
              <span tabIndex={0} title={ref.message} style={{ ...badge, color: ref.phase === 'failed' ? 'var(--rose)' : ref.phase === 'needs_region' ? 'var(--amber)' : 'var(--text-muted)' }}>{ref.phase === 'failed' ? '준비 실패' : ref.phase === 'needs_region' ? '구간 확인 필요' : '목소리 준비 중'}</span>
            )}
            {/* ★엔진이 못 받는 설정을 그대로 말한다 — 조용히 버리지 않는다. */}
            {notes.map(n => <span key={n.field} tabIndex={0} title={n.reason} style={{ ...badge, color: 'var(--amber)' }}>{n.field === 'emotion' ? '감정 미적용' : n.field === 'pitch' ? '음높이 보정' : '속도 보정'}</span>)}
            {mine && (
              <span title={state.job?.message} role="status" style={{ ...row, flex: '1 1 180px', fontSize: 11, color: 'var(--text-secondary)' }}>{state.job?.cancelling ? '멈추는 중' : '생성 중'}<progress className="af-card-progress" aria-label="음성 생성 진행률" max={100} value={Math.max(0, Math.min(100, state.job?.percent || 0))} style={{ flex: '1 1 70px', height: 4, accentColor: 'var(--accent)' }}/>{Math.max(0, Math.min(100, Math.round(state.job?.percent || 0)))}%</span>
            )}
          </div>
        )}
        <div style={{ ...row, padding: '12px 20px', borderTop: '1px solid var(--border-subtle)' }}>
          <button type="button" data-testid="card-takes" onClick={() => setModal({ type: 'takes', id: card.id })} style={{ ...button, background: 'transparent' }}><Icon name="history"/>생성본 <span style={muted}>{card.takes.length}</span></button>
          {chosen && <span style={{ ...muted, color: changed ? 'var(--amber)' : 'var(--text-muted)' }} title={changed ? '채택한 생성본은 수정 전 대사·목소리·설정으로 생성되었습니다' : '최종 연결에 사용할 생성본'}>#{card.takes.indexOf(chosen) + 1} 채택{changed ? ' · 수정 전' : ''}</span>}
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
    <button type="button" data-testid="add-generation-card" aria-label="음원으로 카드 추가" title="클릭하거나 음성·영상 파일을 끌어 놓아 카드를 추가합니다" disabled={locked} onClick={() => void pick()}
      onDragOver={e => { if (!locked && !dragging && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setHover('add') } }} onDragLeave={() => setHover(null)} onDrop={e => drop(e)}
      style={{ ...button, minHeight: state.cards.length ? 64 : 180, width: '100%', border: `1px dashed ${hover === 'add' ? 'var(--accent)' : 'var(--border-default, var(--border-subtle))'}`, background: hover === 'add' ? 'var(--bg-elevated)' : 'transparent', color: 'var(--text-muted)' }}><Icon name="plus"/>{loading ? '불러오는 중' : state.cards.length ? null : '음원 추가'}</button>
    {state.removed && <div role="status" style={{ ...row, ...muted }}><span>카드 삭제됨</span><button type="button" disabled={locked} style={button} onClick={state.undo}>되돌리기</button></div>}
    <footer style={{ ...row, position: 'sticky', bottom: 0, zIndex: 2, marginTop: 4, padding: '15px 18px', background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)', borderRadius: 12, boxShadow: '0 -8px 30px rgba(0,0,0,.12)' }}>
      <div style={{ flex: '1 1 130px' }}><div style={{ ...row, fontSize: 13, fontWeight: 600 }}>최종 음성 <span title={DISCONNECTED} style={{ ...muted, fontWeight: 400 }}>연결 준비 중</span></div><div style={{ ...muted, marginTop: 4 }}>{state.cards.filter(c => c.takes.some(t => t.id === c.adoptedId)).length} / {state.cards.length} 채택</div></div>
      <Action icon="play" label="전체 이어 듣기" disabled title={DISCONNECTED}/><Action icon="link" label="연결 조정" disabled={locked || !state.cards.length} onClick={() => setModal({ type: 'join' })}>연결 조정</Action><button type="button" className="af-card-work-button" disabled title={DISCONNECTED} style={primary}><Icon name="save"/>파일로 저장</button>
    </footer>
    {modal?.type === 'settings' && active && <Settings key={active.id} card={active} disabled={busy} close={() => setModal(null)}/>}
    {modal?.type === 'takes' && active && <Takes key={active.id} card={active} disabled={busy} close={() => setModal(null)}/>}
    {modal?.type === 'join' && <Join cards={state.cards} disabled={busy} close={() => setModal(null)}/>}
    {restore && <Modal title="이전 작업을 불러올까요?" subtitle={`${restore.length}개`} close={laterRestore}
      footer={<button type="button" style={button} title="불러오기를 닫고 현재 카드로 계속합니다"
        onClick={laterRestore}>현재 작업 계속</button>}>
      <div style={{ display: 'grid', gap: 8 }}>{restore.map((c) => (
        <div key={`${c.slot}:${c.index}`} style={{ ...row, gap: 12, padding: '14px', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 10 }}>
          <span style={{ color: 'var(--accent-light)', display: 'flex' }}><Icon name="history"/></span>
          <div style={{ flex: '1 1 160px', minWidth: 0 }}>
            <div style={{ ...row, gap: 7, marginBottom: 5 }}><span title={c.work.cards.map(card => card.label || card.sourceName).join(' · ')} style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{c.work.cards[0]?.label || c.work.cards[0]?.sourceName || '카드 작업'}</span>
              {c.slot === 'kept' && <span style={badge} title="이전에 보관한 작업입니다">보관됨</span>}
            </div><div style={muted}>{c.summary}</div>
          </div>
          <button type="button" style={button} onClick={() => takeRestore(c)}>불러오기</button>
        </div>
      ))}</div>
    </Modal>}
  </div>
}
