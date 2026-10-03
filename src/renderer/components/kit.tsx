import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
/**
 * 화면 공용 부품 — 아이콘 · 단추 모양 · 팝업(Modal) · 아이콘 단추(Action).
 * ★처음엔 음성 합성 화면 안에만 있었다(2026-10-01 옮김). 낭독 화면이 제 팝업·글자 단추(‹ › ▶ ×)를 따로 만들어
 *   화면마다 모양과 키보드 동작이 달랐다 — 같은 부품을 쓴다.
 */
export type IconName = 'back' | 'list' | 'stop' | 'reset' | 'plus' | 'grip' | 'settings' | 'copy' | 'trash' | 'play' | 'folder' | 'text' | 'history' | 'close' | 'check' | 'link' | 'save' | 'file'
  | 'prev' | 'next' | 'book' | 'voice' | 'follow' | 'volume' | 'mute'
export function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    back: <path d="m14 6-6 6 6 6"/>,
    list: <><path d="M9 6h12M9 12h12M9 18h12M3 6h.01M3 12h.01M3 18h.01"/></>,
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
    prev: <path d="M6 6v12M18 6l-9 6 9 6z"/>, next: <path d="M18 6v12M6 6l9 6-9 6z"/>,
    book: <path d="M12 5v16M12 5C9 3 5 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 1Z"/>,
    voice: <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>,
    follow: <><path d="M4 7h16M4 12h10M4 17h13"/><path d="m17 10 3 2-3 2"/></>,
    volume: <><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></>,
    mute: <><path d="M4 9v6h4l5 4V5L8 9z"/><path d="m16 9 5 6M21 9l-5 6"/></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'grip' ? 3 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
export const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }
export const muted: CSSProperties = { fontSize: 11, color: 'var(--text-muted)' }
export const badge: CSSProperties = { ...muted, display: 'inline-flex', alignItems: 'center', padding: '3px 7px', borderRadius: 5, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', lineHeight: 1.3 }
export const field: CSSProperties = { font: 'inherit', fontSize: 13, color: 'var(--text-primary)', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '9px 11px', minWidth: 0, boxSizing: 'border-box' }
export const button: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 34, padding: '7px 11px', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-elevated)', color: 'var(--text-secondary)', font: 'inherit', fontSize: 12, cursor: 'pointer', flexShrink: 0 }
export const primary: CSSProperties = { ...button, background: 'var(--accent, #8b5cf6)', color: '#fff', borderColor: 'transparent' }
export function Action({ icon, label, onClick, disabled = false, children, title, testId, pressed, expanded, controls }: { icon: IconName; label: string; onClick?: () => void; disabled?: boolean; children?: ReactNode; title?: string; testId?: string; pressed?: boolean; expanded?: boolean; controls?: string }) {
  return <button type="button" data-testid={testId} aria-label={label} aria-pressed={pressed} aria-expanded={expanded} aria-controls={controls} title={title || label} disabled={disabled} onClick={onClick} style={{ ...button, padding: children ? '7px 11px' : 8, opacity: disabled ? .4 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}><Icon name={icon}/>{children}</button>
}
export function Modal({ title, subtitle, close, children, footer, back, width = 650 }: { title: string; subtitle?: string; close: () => void; children: ReactNode; footer?: ReactNode; back?: () => void; width?: number }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const el = ref.current; el?.showModal(); return () => el?.close() }, [title])
  return <><style>{`.af-card-modal::backdrop{background:rgba(5,7,12,.68);backdrop-filter:blur(4px)}.af-card-modal[open]{display:flex;flex-direction:column;animation:af-dialog-arrive 150ms ease-out}@keyframes af-dialog-arrive{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){.af-card-modal[open]{animation:none}}`}</style><dialog ref={ref} className="af-card-modal" aria-label={title} onCancel={e => { e.preventDefault(); close() }}
    style={{ margin: 'auto', width, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100dvh - 32px)', padding: 0, border: '1px solid var(--border-default, var(--border-subtle))', borderRadius: 16, background: 'var(--bg-card)', color: 'var(--text-primary)', boxShadow: '0 24px 100px rgba(0,0,0,.5)' }}>
    <div style={{ ...row, flexShrink: 0, padding: '16px clamp(14px, 3vw, 22px)', borderBottom: '1px solid var(--border-subtle)' }}>{back && <Action icon="back" label="최종 음성 구성으로 돌아가기" onClick={back}/>}<div style={{ flex: 1, minWidth: 0 }}><h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>{subtitle && <div style={{ ...muted, marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</div>}</div><Action icon="close" label="팝업 닫기" onClick={close}/></div>
    <div className="af-card-modal-body" style={{ padding: '18px clamp(14px, 3vw, 22px)', overflowY: 'auto', minHeight: 0, overscrollBehavior: 'contain' }}>{children}</div>
    {footer && <div style={{ ...row, flexShrink: 0, padding: '14px clamp(14px, 3vw, 22px)', justifyContent: 'flex-end', borderTop: '1px solid var(--border-subtle)' }}>{footer}</div>}
  </dialog></>
}
