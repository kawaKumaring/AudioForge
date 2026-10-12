import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EXPRESSION_ICONS, type ExpressionIcon } from '../../shared/expressionIcons'
import { Action, Icon, button, muted, row } from './kit'
export default function ExpressionPalette({ target, insert, close, disabled, supported }: {
  target: string; insert: (cue: ExpressionIcon) => void; close: () => void; disabled: boolean; supported: boolean
}) {
  const [position, setPosition] = useState({ x: Math.max(8, window.innerWidth - 330), y: 100 })
  const panel = useRef<HTMLElement>(null)
  const constrain = (x: number, y: number) => ({ x: Math.max(8, Math.min(x, window.innerWidth - Math.min(310, window.innerWidth - 16) - 8)), y: Math.max(8, Math.min(y, window.innerHeight - (panel.current?.getBoundingClientRect().height || 300) - 8)) })
  useEffect(() => { const resize = () => setPosition(p => constrain(p.x, p.y)); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize) }, [])
  return createPortal(<aside ref={panel} role="region" aria-label="감정 도구" data-testid="expression-palette"
    style={{ position: 'fixed', left: position.x, top: position.y, width: 310, maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100vh - 16px)', overflowY: 'auto', zIndex: 1000, border: '1px solid var(--border-subtle)', borderRadius: 13, background: 'var(--bg-card)', color: 'var(--text-primary)', boxShadow: '0 14px 44px #0007' }}>
    <div style={{ ...row, flexWrap: 'nowrap', padding: '9px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
      <button type="button" aria-label="감정 도구 이동" title="드래그로 이동 · 화살표로 이동" style={{ ...button, flex: 1, justifyContent: 'flex-start', border: 0, background: 'transparent', cursor: 'grab', touchAction: 'none' }}
        onPointerDown={e => { e.preventDefault(); const el = e.currentTarget, start = { x: e.clientX - position.x, y: e.clientY - position.y }; el.setPointerCapture(e.pointerId)
          const move = (event: PointerEvent) => setPosition(constrain(event.clientX - start.x, event.clientY - start.y))
          const stop = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', stop); el.removeEventListener('pointercancel', stop) }
          el.addEventListener('pointermove', move); el.addEventListener('pointerup', stop); el.addEventListener('pointercancel', stop)
        }} onKeyDown={e => { const delta: Record<string, number[]> = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, -12], ArrowDown: [0, 12] }; if (delta[e.key]) { e.preventDefault(); const [x, y] = delta[e.key]; setPosition(p => constrain(p.x + x, p.y + y)) } }}><Icon name="grip"/>감정 도구</button>
      <Action icon="close" label="감정 도구 닫기" onClick={close}/>
    </div>
    <div style={{ padding: 12 }}><div style={{ ...muted, marginBottom: 9, overflowWrap: 'anywhere' }}>{target || '대사 입력칸을 먼저 선택하세요'}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 7 }}>
        {EXPRESSION_ICONS.map(cue => <button key={cue.id} type="button" aria-label={cue.label} title={`${cue.label} — ${cue.description}`} disabled={disabled || !target}
          onPointerDown={e => e.preventDefault()} onClick={() => insert(cue)} style={{ ...button, padding: 6, minHeight: 42, fontSize: 23, opacity: disabled || !target ? .4 : 1 }}>{cue.icon}</button>)}
      </div>
      <div style={{ ...muted, marginTop: 9 }}>{supported ? '커서 위치에 연출 표시 · 대사는 유지' : '이 목소리는 감정 미지원 · 표시는 저장되지만 생성은 차단'}</div>
      <div style={{ ...muted, marginTop: 7 }} title="웃음·가벼운 웃음·호흡·한숨은 H3 비교 음성에서 시험 중이며 카드 생성에는 연결되지 않았습니다.">웃음·호흡은 H3 청취 시험 중</div>
    </div>
  </aside>, document.body)
}
