import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** 서재 컨텍스트 메뉴. 모달·배경 덮개 없이 화면 가장자리 안에 배치한다. */
export default function ReaderContextMenu({ x, y, label, close, restoreFocus, children, controls = false }: {
  x: number; y: number; label: string; close: () => void; restoreFocus: () => void; children: ReactNode; controls?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [point, setPoint] = useState({ x, y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPoint({ x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) })
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [x, y, label])
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close() }
    const scroll = (e: Event) => { if (!ref.current?.contains(e.target as Node)) close() }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('wheel', scroll, true)
    window.addEventListener('resize', close)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('wheel', scroll, true); window.removeEventListener('resize', close) }
  }, [close])
  return createPortal(<div ref={ref} role={controls ? 'dialog' : 'menu'} aria-label={label} data-testid="reader-context-menu"
    onContextMenu={e => e.preventDefault()} onKeyDown={e => {
      const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
      const i = items.indexOf(document.activeElement as HTMLButtonElement)
      if (e.key === 'Escape') { e.preventDefault(); close(); restoreFocus() }
      else if (!controls && e.key === 'Tab') close()
      else if (!controls && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault()
        const j = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[j]?.focus()
      }
    }} style={{ position: 'fixed', left: point.x, top: point.y, zIndex: 10000, width: controls ? 280 : 218, maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100dvh - 16px)', overflowY: 'auto', padding: 5,
      border: '1px solid var(--border-default, var(--border-subtle))', borderRadius: 9, background: 'var(--bg-elevated)', color: 'var(--text-primary)', boxShadow: '0 8px 28px #0006' }}>
    {children}
  </div>, document.body)
}
