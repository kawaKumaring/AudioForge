import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type DragEvent } from 'react'
import { useAppStore } from '../stores/app.store'
import { useSynthesisCards, type SynthesisCard, type CardSource, type CardSettings, type CardTake, type JoinSettings } from '../stores/synthesisCards.store'
import { isCancelCleanupBusy } from '../../shared/cancelContract'
import CompactVoiceWaveform from './CompactVoiceWaveform'
import { createManagedAudio } from '../lib/playbackVolume'

type IconName = 'plus' | 'grip' | 'settings' | 'copy' | 'trash' | 'play' | 'folder' | 'text' | 'history' | 'close' | 'check' | 'link' | 'save' | 'file'
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
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
const field: CSSProperties = { font: 'inherit', fontSize: 13, color: 'var(--text-primary)', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '9px 11px', minWidth: 0, boxSizing: 'border-box' }
const button: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 34, padding: '7px 11px', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-elevated)', color: 'var(--text-secondary)', font: 'inherit', fontSize: 12, cursor: 'pointer' }
const primary: CSSProperties = { ...button, background: 'var(--accent, #8b5cf6)', color: '#fff', borderColor: 'transparent' }
const DISCONNECTED = '카드별 준비·생성·저장 경로 연결 전입니다. 기존 생성 기능은 이전 작업에서 사용할 수 있습니다.'
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
  const [draft, setDraft] = useState<CardSettings>({ ...card.settings })
  const set = (patch: Partial<CardSettings>) => setDraft(s => ({ ...s, ...patch }))
  const duration = card.source?.duration || 0
  const valid = draft.reference === 'auto' || duration > 0 && draft.end > draft.start && draft.end <= duration && draft.start >= 0
  return <Modal title="고급 옵션" subtitle={card.label} close={close} footer={<><button type="button" style={button} onClick={close}>취소</button><button type="button" style={{ ...primary, opacity: disabled || !valid ? .4 : 1 }} disabled={disabled || !valid} onClick={() => { useSynthesisCards.getState().update(card.id, { settings: { ...draft } }); close() }}>적용</button></>}>
    <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 23 }}>
      <label style={{ display: 'grid', gap: 10 }}><span style={{ ...row, justifyContent: 'space-between' }}>말하기 속도 <span style={muted}>{draft.speed.toFixed(2)}×</span></span><input style={{ accentColor: 'var(--accent)' }} aria-label="말하기 속도" type="range" min="0.7" max="1.3" step="0.05" value={draft.speed} onChange={e => set({ speed: +e.target.value })}/></label>
      <label style={{ display: 'grid', gap: 10 }}><span style={{ ...row, justifyContent: 'space-between' }}>음높이 <span style={muted}>{draft.pitch > 0 ? '+' : ''}{draft.pitch}</span></span><input style={{ accentColor: 'var(--accent)' }} aria-label="음높이" type="range" min="-4" max="4" step="1" value={draft.pitch} onChange={e => set({ pitch: +e.target.value })}/></label>
      <label style={{ display: 'grid', gap: 8 }}>감정<select aria-label="감정" style={field} value={draft.emotion} onChange={e => set({ emotion: e.target.value })}>{['자연스럽게', '기쁨', '슬픔', '차분하게', '화남'].map(v => <option key={v}>{v}</option>)}</select></label>
      <div style={{ display: 'grid', gap: 12, borderTop: '1px solid var(--border-subtle)', paddingTop: 19 }}><div style={{ ...row, justifyContent: 'space-between' }}><span>참조 구간</span><select aria-label="참조 구간 방식" style={field} value={draft.reference} onChange={e => set({ reference: e.target.value as CardSettings['reference'] })}><option value="auto">자동</option><option value="manual">직접 지정</option></select></div>
        {card.source && <CompactVoiceWaveform path={card.source.path} name={card.source.name} disabled={disabled} region={draft.reference === 'manual' && valid ? { start: draft.start, duration: draft.end - draft.start } : null}/>}
        {draft.reference === 'manual' && <div style={row}><label style={{ ...row, flex: '1 1 130px' }}>시작<input aria-label="참조 시작 초" style={{ ...field, width: 95 }} type="number" min="0" max={duration} step=".1" value={draft.start} onChange={e => set({ start: +e.target.value })}/>초</label><label style={{ ...row, flex: '1 1 130px' }}>끝<input aria-label="참조 끝 초" style={{ ...field, width: 95 }} type="number" min="0" max={duration} step=".1" value={draft.end} onChange={e => set({ end: +e.target.value })}/>초</label>{!valid && <span role="alert" style={{ color: 'var(--rose)', fontSize: 12 }}>구간 확인 필요</span>}</div>}
      </div>
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
      <div style={row}><button type="button" disabled={disabled} aria-label={`생성본 ${i + 1} 채택`} aria-pressed={take.id === card.adoptedId} title="최종 연결에 사용할 생성본" onClick={() => useSynthesisCards.getState().update(card.id, { adoptedId: take.id })} style={{ ...button, color: take.id === card.adoptedId ? 'var(--accent-light)' : 'var(--text-muted)' }}><Icon name="check"/></button>
      <div style={{ flex: '1 1 130px' }}><div style={{ fontSize: 13 }}>생성본 {String(i + 1).padStart(2, '0')}{card.adoptedId === take.id && <span style={{ ...muted, marginLeft: 8 }}>채택</span>}</div><time style={muted}>{new Date(take.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div>
      <Action icon="play" label={`생성본 ${i + 1} ${playing === take.id ? '정지' : '재생'}`} onClick={() => void play(take)} disabled={disabled}/>
      <Action icon="folder" label={`생성본 ${i + 1} 파일 위치`} onClick={() => { void window.api.app.revealFile(take.path).catch(() => setError('파일 위치 열기 실패')) }}/>
      <Action icon="text" label={`생성본 ${i + 1} 대사 보기`} onClick={() => inspect(inspected === take.id ? null : take.id)}/></div>
      {inspected === take.id && <div style={{ padding: '13px 8px 3px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13 }}><div style={{ ...muted, marginBottom: 8 }} title="생성 요청 당시의 목소리와 설정">{take.source.name} · {take.settings.speed.toFixed(2)}× · {take.settings.emotion}</div>{take.text}</div>}
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
    <style>{`.af-card-modal::backdrop{background:rgba(5,7,12,.68);backdrop-filter:blur(4px)}.af-card-modal[open]{animation:af-card-open 150ms ease-out}.af-generation-card:focus-within{border-color:var(--accent)!important}.af-card-work-button:disabled{cursor:not-allowed;opacity:.4}@keyframes af-card-open{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){.af-card-modal[open]{animation:none}}`}</style>
    <div style={{ ...row, paddingBottom: 2 }}><span style={{ fontSize: 13, fontWeight: 600 }}>생성 카드 <span style={{ ...muted, marginLeft: 5 }}>{state.cards.length}</span></span><span style={{ ...muted, padding: '3px 7px', border: '1px solid var(--border-subtle)', borderRadius: 5 }} title="GUI 검토 단계입니다. 카드 구성은 현재 실행 중에만 유지됩니다. 생성·영구 저장·연결 처리는 아직 연결하지 않았습니다.">연결 전</span><span style={{ flex: 1 }}/><button type="button" data-testid="open-legacy-synthesis" disabled={locked} style={{ ...button, background: 'transparent' }} title="기존 문장별 제작·대본 배역 작업을 그대로 엽니다" onClick={() => state.setView('legacy')}>이전 작업</button></div>
    {notice && <div role="status" style={{ ...row, fontSize: 12, color: 'var(--amber)' }}><span style={{ flex: 1 }}>{notice}</span><Action icon="close" label="알림 닫기" onClick={() => setNotice('')}/></div>}
    {state.cards.map((card, index) => {
      const chosen = card.takes.find(t => t.id === card.adoptedId), changed = chosen && (chosen.text !== card.text || chosen.source.path !== card.source?.path || JSON.stringify(chosen.settings) !== JSON.stringify(card.settings))
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
          {card.source && !modal && <CompactVoiceWaveform path={card.source.path} name={card.source.name} region={card.settings.reference === 'manual' ? { start: card.settings.start, duration: card.settings.end - card.settings.start } : null} disabled={locked}/>}
          {card.source && modal && <div style={{ height: 40 }}/>}
          <textarea data-testid="card-script" aria-label={`${index + 1}번 카드 대사`} placeholder="대사를 입력하세요" rows={2} spellCheck={false} disabled={locked} value={card.text} onChange={e => state.update(card.id, { text: e.target.value })} style={{ ...field, width: '100%', resize: 'vertical', minHeight: 66, fontSize: 15, lineHeight: 1.75, border: 0, background: 'transparent', padding: '11px 0', margin: '3px 0 0' }}/>
        </div>
        <div style={{ ...row, padding: '12px 20px', borderTop: '1px solid var(--border-subtle)' }}>
          <button type="button" data-testid="card-takes" onClick={() => setModal({ type: 'takes', id: card.id })} style={{ ...button, background: 'transparent' }}><Icon name="history"/>생성본 <span style={muted}>{card.takes.length}</span></button>
          {chosen && <span style={{ ...muted, color: changed ? 'var(--amber)' : 'var(--text-muted)' }} title={changed ? '채택한 생성본은 수정 전 대사·목소리·설정으로 생성되었습니다' : '최종 연결에 사용할 생성본'}>#{card.takes.indexOf(chosen) + 1} 채택{changed ? ' · 수정 전' : ''}</span>}
          <span style={{ flex: 1 }}/><span style={muted}>{card.text.length}자</span>
          <button type="button" data-testid="card-generate" className="af-card-work-button" title={DISCONNECTED} disabled style={primary}><Icon name="play"/>생성</button>
        </div>
      </article>
    })}
    <button type="button" data-testid="add-generation-card" aria-label="음원으로 카드 추가" title="클릭하거나 음성·영상 파일을 끌어 놓아 카드를 추가합니다" disabled={locked} onClick={() => void pick()}
      onDragOver={e => { if (!locked && !dragging && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setHover('add') } }} onDragLeave={() => setHover(null)} onDrop={e => drop(e)}
      style={{ ...button, minHeight: state.cards.length ? 64 : 180, width: '100%', border: `1px dashed ${hover === 'add' ? 'var(--accent)' : 'var(--border-default, var(--border-subtle))'}`, background: hover === 'add' ? 'var(--bg-elevated)' : 'transparent', color: 'var(--text-muted)' }}><Icon name="plus"/>{loading ? '불러오는 중' : state.cards.length ? null : '음원 추가'}</button>
    {state.removed && <div role="status" style={{ ...row, ...muted }}><span>카드 삭제됨</span><button type="button" disabled={locked} style={button} onClick={state.undo}>되돌리기</button></div>}
    <footer style={{ ...row, position: 'sticky', bottom: 0, zIndex: 2, marginTop: 4, padding: '15px 18px', background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)', borderRadius: 12, boxShadow: '0 -8px 30px rgba(0,0,0,.12)' }}>
      <div style={{ flex: '1 1 130px' }}><div style={{ fontSize: 13, fontWeight: 600 }}>최종 음성</div><div style={{ ...muted, marginTop: 4 }}>{state.cards.filter(c => c.takes.some(t => t.id === c.adoptedId)).length} / {state.cards.length} 채택</div></div>
      <Action icon="play" label="전체 이어 듣기" disabled title={DISCONNECTED}/><Action icon="link" label="연결 조정" disabled={locked || !state.cards.length} onClick={() => setModal({ type: 'join' })}>연결 조정</Action><button type="button" className="af-card-work-button" disabled title={DISCONNECTED} style={primary}><Icon name="save"/>파일로 저장</button>
    </footer>
    {modal?.type === 'settings' && active && <Settings key={active.id} card={active} disabled={busy} close={() => setModal(null)}/>}
    {modal?.type === 'takes' && active && <Takes key={active.id} card={active} disabled={busy} close={() => setModal(null)}/>}
    {modal?.type === 'join' && <Join cards={state.cards} disabled={busy} close={() => setModal(null)}/>}
  </div>
}
