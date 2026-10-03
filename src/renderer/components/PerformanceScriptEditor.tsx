import { useEffect, useLayoutEffect, useId, useRef, useState, type CSSProperties } from 'react'
import {
  beginHistory, commitHistory, editText, inferEdit, markActing, stepHistory,
  type Acting, type PerformanceDocument, type SelectionRange,
} from '../../shared/performanceDocument'

export interface ActingChoice {
  id: string
  label: string
  /** Presentation only; never translated into an engine instruction here. */
  tone?: 'warm' | 'cool' | 'intense' | 'soft'
  verified: boolean
  reason?: string
  strengths?: NonNullable<Acting['strength']>[]
  transitions?: NonNullable<Acting['transition']>[]
}
export interface PerformanceScriptEditorProps {
  value: PerformanceDocument
  onChange: (value: PerformanceDocument) => void
  /** Only the host's verified engine capabilities may enable controls. Empty by default. */
  choices: ActingChoice[]
  disabled?: boolean
  /** Playback of an existing matching take, never an implicit generation request. */
  onListen?: (selection: SelectionRange, revision: number) => void
}

const button: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  minHeight: 32, padding: '5px 9px', borderRadius: 7, border: '1px solid var(--border-subtle, #343440)',
  color: 'var(--text-primary, #ececf3)', background: 'var(--bg-elevated, #272733)', font: 'inherit', fontSize: 12,
}
const tones = {
  warm: { ink: '#e9bc87', wash: 'rgba(233,188,135,.09)' },
  cool: { ink: '#9abfe7', wash: 'rgba(154,191,231,.09)' },
  intense: { ink: '#e9a29c', wash: 'rgba(233,162,156,.09)' },
  soft: { ink: '#c0afe9', wash: 'rgba(192,175,233,.09)' },
}
const toneFor = (choice?: ActingChoice) => tones[choice?.tone || 'soft']
const typography: CSSProperties = {
  boxSizing: 'border-box', width: '100%', margin: 0, padding: '14px 14px 52px',
  fontFamily: 'inherit', fontSize: 14, lineHeight: '1.75', letterSpacing: 'normal',
  whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'break-word', tabSize: 4,
  border: 0,
}
function Symbol({ kind }: { kind: 'emotion' | 'play' | 'undo' | 'redo' | 'close' }) {
  const paths = {
    emotion: 'M5 4h14v12H9l-4 4V4zm4 4h.01M15 8h.01M9 11q3 3 6 0',
    play: 'm8 5 11 7-11 7V5', undo: 'M4 5v6h6M4 11a8 8 0 1 1 1 7',
    redo: 'M20 5v6h-6M20 11a8 8 0 1 0-1 7', close: 'm6 6 12 12M6 18 18 6',
  }
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[kind]}/></svg>
}

/** Not mounted in the production workspace until engine evidence and persistence are connected. */
export default function PerformanceScriptEditor({ value, onChange, choices, disabled = false, onListen }: PerformanceScriptEditorProps) {
  const area = useRef<HTMLTextAreaElement>(null), overlay = useRef<HTMLDivElement>(null)
  const history = useRef(beginHistory(value))
  const composing = useRef(false), inputHint = useRef<SelectionRange | undefined>(undefined)
  const compositionBase = useRef<PerformanceDocument | null>(null)
  const [draftText, setDraftText] = useState(value.text)
  const [selection, setSelection] = useState<SelectionRange>({ start: 0, end: 0 })
  const [focused, setFocused] = useState(false)
  const [, refresh] = useState(0)
  const [popup, setPopup] = useState<{ range: SelectionRange; revision: number } | null>(null)
  const [acting, setActing] = useState<Acting>({ emotion: '' })
  const dialog = useRef<HTMLDialogElement>(null)
  const pendingSelection = useRef<SelectionRange | null>(null)
  const heading = useId(), description = useId()
  const doc = history.current.present
  useEffect(() => {
    if (value !== history.current.present && JSON.stringify(value) !== JSON.stringify(history.current.present)) {
      history.current = beginHistory(value)
      compositionBase.current = null; composing.current = false; inputHint.current = undefined
      setDraftText(value.text); setPopup(null); setSelection({ start: 0, end: 0 }); refresh(n => n + 1)
    }
  }, [value])

  const emit = (next: PerformanceDocument) => {
    if (next === history.current.present) return
    history.current = commitHistory(history.current, next)
    setDraftText(next.text); refresh(n => n + 1); onChange(next)
  }
  useLayoutEffect(() => {
    const range = pendingSelection.current
    if (!range) return
    pendingSelection.current = null
    const el = area.current
    if (!el) return
    const top = el.scrollTop
    el.focus(); el.setSelectionRange(range.start, range.end); el.scrollTop = top
    setSelection(range)
  })
  const restoreSelection = (range: SelectionRange) => { pendingSelection.current = range; refresh(n => n + 1) }
  const travel = (direction: 'undo' | 'redo') => {
    if (disabled || composing.current) return
    const next = stepHistory(history.current, direction)
    if (next === history.current) return
    history.current = next; setDraftText(next.present.text); setPopup(null); refresh(n => n + 1)
    onChange(next.present)
    restoreSelection({ start: Math.min(selection.start, next.present.text.length), end: Math.min(selection.end, next.present.text.length) })
  }
  const active = doc.ranges.find(r => selection.start === selection.end
    ? r.start <= selection.start && selection.start < r.end
    : r.start <= selection.start && selection.end <= r.end)
  const selected = selection.end > selection.start ? selection : active ? { start: active.start, end: active.end } : null
  const selectedChoice = choices.find(c => c.id === active?.acting.emotion)
  const open = () => {
    if (disabled || composing.current || !selected) return
    setActing(active ? { ...active.acting } : { emotion: '' })
    setPopup({ range: { ...selected }, revision: history.current.present.revision })
  }
  const close = () => {
    const saved = popup?.range
    setPopup(null)
    if (saved) restoreSelection(saved)
  }
  useEffect(() => {
    if (!popup) return
    const el = dialog.current, anchor = area.current
    if (!el || !anchor) return
    el.showModal()
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const scale = el.getBoundingClientRect().width / el.offsetWidth || 1
      el.style.maxWidth = `${(window.innerWidth - 24) / scale}px`
      el.style.maxHeight = `${(window.innerHeight - 24) / scale}px`
      const size = el.getBoundingClientRect()
      el.style.left = `${Math.max(12, Math.min(rect.left + 12, window.innerWidth - size.width - 12)) / scale}px`
      el.style.top = `${Math.max(12, Math.min(rect.bottom - 40, window.innerHeight - size.height - 12)) / scale}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(el)
    window.addEventListener('resize', place)
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 120, easing: 'ease-out' })
    }
    return () => { observer.disconnect(); window.removeEventListener('resize', place); el.close() }
  }, [popup])
  const chosen = choices.find(c => c.id === acting.emotion)
  const tint = toneFor(chosen)
  const canApply = !!chosen?.verified && (!acting.strength || !!chosen.strengths?.includes(acting.strength))
    && (!acting.transition || !!chosen.transitions?.includes(acting.transition))
  const apply = (remove: boolean) => {
    if (!popup || disabled || popup.revision !== history.current.present.revision || (!remove && !canApply)) return
    emit(markActing(history.current.present, popup.range, remove ? null : acting)); close()
  }
  const segments: { text: string; acting?: Acting }[] = []
  let cursor = 0
  for (const range of doc.ranges) {
    if (range.start > cursor) segments.push({ text: doc.text.slice(cursor, range.start) })
    segments.push({ text: doc.text.slice(range.start, range.end), acting: range.acting }); cursor = range.end
  }
  segments.push({ text: doc.text.slice(cursor) })
  return <div data-testid="performance-editor" style={{ position: 'relative', minWidth: 0 }}
    onFocus={() => setFocused(true)}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false) }}>
    <div style={{ position: 'relative', background: 'var(--bg-base, #101116)', border: '1px solid var(--border-subtle, #343440)', borderRadius: 14, overflow: 'hidden', boxShadow: focused ? '0 0 0 2px rgba(192,175,233,.12)' : 'inset 0 1px 6px #0002' }}>
      <div ref={overlay} aria-hidden="true" style={{ ...typography, position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', color: 'transparent' }}>
        {composing.current ? draftText : segments.map((s, i) => <span key={i} style={s.acting ? { textDecorationLine: 'underline', textDecorationColor: toneFor(choices.find(c => c.id === s.acting?.emotion)).ink, textDecorationThickness: 2, textUnderlineOffset: 5, background: toneFor(choices.find(c => c.id === s.acting?.emotion)).wash } : undefined}>{s.text}</span>)}{'\u200b'}
      </div>
      <textarea ref={area} aria-label="대사" aria-describedby={doc.ranges.length ? description : undefined} data-testid="performance-text"
        disabled={disabled} value={draftText} rows={5} spellCheck={false}
        style={{ ...typography, display: 'block', position: 'relative', resize: 'vertical', minHeight: 145, background: 'transparent', color: 'var(--text-primary, #ececf3)', caretColor: 'var(--text-primary, #ececf3)' }}
        onSelect={e => setSelection({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })}
        onScroll={e => { if (overlay.current) { overlay.current.scrollTop = e.currentTarget.scrollTop; overlay.current.scrollLeft = e.currentTarget.scrollLeft } }}
        onBeforeInput={() => { const el = area.current; if (el && !composing.current) inputHint.current = { start: el.selectionStart, end: el.selectionEnd } }}
        onChange={e => {
          const text = e.currentTarget.value
          setDraftText(text)
          if (!composing.current) {
            const before = history.current.present.text
            let hint = inputHint.current
            // Deleting repeated characters is ambiguous in a string diff. The resulting caret
            // identifies a pure deletion; inferEdit still verifies the unchanged prefix/suffix.
            if (text.length < before.length && (!hint || hint.start === hint.end)) {
              hint = { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionStart + before.length - text.length }
            }
            emit(editText(history.current.present, inferEdit(before, text, hint))); inputHint.current = undefined
          }
        }}
        onCompositionStart={() => { composing.current = true; refresh(n => n + 1); compositionBase.current = history.current.present; const el = area.current; if (el) inputHint.current = { start: el.selectionStart, end: el.selectionEnd } }}
        onCompositionEnd={e => {
          composing.current = false
          const base = compositionBase.current
          compositionBase.current = null
          if (base && base === history.current.present) emit(editText(base, inferEdit(base.text, e.currentTarget.value, inputHint.current)))
          inputHint.current = undefined
          setDraftText(history.current.present.text)
        }}
        onKeyDown={e => {
          if (composing.current || e.nativeEvent.isComposing) return
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); travel(e.shiftKey ? 'redo' : 'undo') }
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); travel('redo') }
          if ((e.altKey && e.key === 'Enter') || (e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') { e.preventDefault(); open() }
        }} onContextMenu={e => { if (selected && !disabled && !composing.current) { e.preventDefault(); open() } }}/>
      {(focused || popup) && !composing.current && <div role="toolbar" aria-label="대사 편집" style={{ position: 'absolute', bottom: 8, right: 10, left: 10, display: 'flex', gap: 5, alignItems: 'center' }} onMouseDown={e => e.preventDefault()}>
        {selected && <>
          <button type="button" style={button} disabled={disabled} aria-label="선택 구절 연출" title="구절 연출 · Alt+Enter" onClick={open}><Symbol kind="emotion"/>{selectedChoice?.label || (active ? active.acting.emotion : '연출')}</button>
          {onListen && <button type="button" style={button} disabled={disabled} aria-label="선택 구절 듣기" title="생성된 소리에서 선택 구절 듣기" onClick={() => onListen(selected, doc.revision)}><Symbol kind="play"/></button>}
        </>}
        <span style={{ flex: 1 }}/>
        <button type="button" style={button} disabled={disabled || !history.current.past.length} aria-label="되돌리기" title="되돌리기 · Ctrl+Z" onClick={() => travel('undo')}><Symbol kind="undo"/></button>
        <button type="button" style={button} disabled={disabled || !history.current.future.length} aria-label="다시 적용" title="다시 적용 · Ctrl+Shift+Z" onClick={() => travel('redo')}><Symbol kind="redo"/></button>
      </div>}
    </div>
    {doc.ranges.length > 0 && <span id={description} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>{doc.ranges.map(r => `${r.start + 1}~${r.end}: ${choices.find(c => c.id === r.acting.emotion)?.label || r.acting.emotion}`).join(', ')}</span>}
    {popup && <dialog ref={dialog} aria-labelledby={heading} onCancel={e => { e.preventDefault(); close() }}
      style={{ position: 'fixed', margin: 0, width: 390, maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', boxSizing: 'border-box', padding: 0, border: '1px solid #51495e', borderRadius: 18, background: 'var(--bg-card, #1c1d25)', color: 'var(--text-primary, #ececf3)', boxShadow: '0 20px 64px #0008' }}>
      <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Symbol kind="emotion"/><strong id={heading} style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>구절 연출</strong>
        <button type="button" aria-label="닫기" title="닫기 · Esc" style={{ ...button, background: 'transparent', borderColor: 'transparent' }} onClick={close}><Symbol kind="close"/></button>
      </div>
      <div data-testid="acting-excerpt" style={{ margin: '0 18px 18px', padding: '16px 18px', borderRadius: 12, background: '#101116', borderLeft: `2px solid ${tint.ink}`, maxHeight: 112, overflowY: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 16, lineHeight: 1.8 }}>
        {doc.text.slice(popup.range.start, popup.range.end)}
      </div>
      <div role="group" aria-label="연출 선택" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, padding: '0 18px' }}>
        {choices.length ? choices.map(c => {
          const selected = acting.emotion === c.id, tone = toneFor(c)
          return <button key={c.id} type="button" aria-pressed={selected} disabled={!c.verified || disabled} title={c.verified ? c.label : c.reason || '이 목소리에서 아직 검증되지 않았습니다'}
            style={{ ...button, minHeight: 48, justifyContent: 'flex-start', padding: '10px 12px', borderRadius: 11, borderColor: selected ? tone.ink : 'var(--border-subtle, #343440)', background: selected ? tone.wash : 'transparent', color: selected ? tone.ink : 'inherit', opacity: c.verified ? 1 : .4 }} onClick={() => setActing({ emotion: c.id })}>
            <span aria-hidden="true" style={{ width: 6, height: 6, flexShrink: 0, borderRadius: '50%', background: tone.ink }}/>
            <span style={{ flex: 1, textAlign: 'left', overflowWrap: 'anywhere' }}>{c.label}</span>
            {selected && <span aria-hidden="true">✓</span>}
          </button>
        }) : <span role="status" title="이 목소리에서 검증된 연출이 아직 없습니다" style={{ fontSize: 12, gridColumn: '1 / -1', color: 'var(--text-secondary, #aaa)' }}>지원 연출 없음</span>}
      </div>
      {!!chosen?.strengths?.length && <div role="group" aria-label="감정 강도" style={{ padding: '16px 18px 0', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ marginRight: 'auto', fontSize: 12 }}>세기</span>
        {[undefined, ...chosen.strengths].map(s => <button key={s || 'default'} type="button" aria-pressed={acting.strength === s} disabled={!chosen.verified || disabled} style={{ ...button, background: acting.strength === s ? tint.wash : 'transparent', borderColor: acting.strength === s ? tint.ink : 'transparent' }} onClick={() => setActing({ ...acting, strength: s })}>{s ? { low: '은은하게', normal: '보통', high: '강하게' }[s] : '기본'}</button>)}
      </div>}
      {!!chosen?.transitions?.length && <div role="group" aria-label="감정 전환" style={{ padding: '12px 18px 0', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ marginRight: 'auto', fontSize: 12 }}>변화</span>
        {[undefined, ...chosen.transitions].map(t => <button key={t || 'default'} type="button" aria-pressed={acting.transition === t} disabled={!chosen.verified || disabled} style={{ ...button, background: acting.transition === t ? tint.wash : 'transparent', borderColor: acting.transition === t ? tint.ink : 'transparent' }} onClick={() => setActing({ ...acting, transition: t })}>{t ? t === 'gradual' ? '서서히' : '바로' : '기본'}</button>)}
      </div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '16px 18px', marginTop: 18, borderTop: '1px solid var(--border-subtle, #343440)' }}>
        <button type="button" style={{ ...button, background: 'transparent', borderColor: 'transparent', color: 'var(--text-secondary, #aaa)' }} disabled={disabled || !doc.ranges.some(r => r.start < popup.range.end && popup.range.start < r.end)} onClick={() => apply(true)}>해제</button>
        <span style={{ flex: 1 }}/>
        <button type="button" style={{ ...button, minWidth: 82, borderRadius: 9, color: '#18141e', background: tint.ink, borderColor: 'transparent', opacity: canApply ? 1 : .45 }} disabled={disabled || !canApply} onClick={() => apply(false)}>적용</button>
      </div>
    </dialog>}
  </div>
}
