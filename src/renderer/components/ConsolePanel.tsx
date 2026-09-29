/**
 * 콘솔 창 — 동작 기록을 **실시간으로 보고, 한 번에 복사한다.**
 *
 * ★지시 (2026-09-30): "작동 동작 관련 콘솔 창을 복사해서 붙여 넣으면 문제를 찾는 게 수월할 것 같다."
 * ★이 창은 **보여 주기만** 한다. 기록은 창을 켜든 끄든 앱 로그 파일에 남는다.
 *   켜는 곳은 설정의 '문제 확인' 칸이다. 껐다 켜도 켜 둔 상태가 남는다.
 * ★보이는 줄에는 글 내용·폴더 경로가 없다 — 본체가 쓸 때부터 씻는다.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { create } from 'zustand'
import { CONSOLE_POPUP_STORAGE_KEY, CONSOLE_RECENT_MAX, parseConsolePopup } from '../../shared/appConsole'

export const useConsolePanel = create<{ open: boolean }>(() => ({ open: false }))

/** 앱을 켤 때 한 번 — 켜 두었던 창을 다시 띄운다. */
export async function loadConsolePref(): Promise<void> {
  try {
    const all = await window.api.settings.get() as Record<string, unknown>
    useConsolePanel.setState({ open: parseConsolePopup(all?.[CONSOLE_POPUP_STORAGE_KEY]) })
  } catch { /* 못 읽으면 닫힌 채로 */ }
}

/** 켜고 끈다 — 설정 파일에 남긴다. 저장 결과를 돌려준다(실패를 성공으로 바꾸지 않는다). */
export async function setConsoleOpen(open: boolean): Promise<boolean> {
  useConsolePanel.setState({ open })
  try {
    const r = await window.api.settings.set(CONSOLE_POPUP_STORAGE_KEY, open) as { ok?: boolean } | undefined
    return !(r && r.ok === false)
  } catch { return false }
}

const button: CSSProperties = {
  background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)',
  borderRadius: 7, padding: '5px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
}

const colorOf = (line: string): string =>
  / ERROR /.test(line) ? 'var(--rose, #f89)' : / WARN /.test(line) ? 'var(--amber, #edc46d)' : 'var(--text-secondary)'

export default function ConsolePanel() {
  const open = useConsolePanel((s) => s.open)
  const [lines, setLines] = useState<string[]>([])
  const [note, setNote] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)          // 맨 아래를 보고 있으면 새 줄을 따라간다

  useEffect(() => {
    if (!open) return
    let alive = true
    void window.api.logs.recent().then((got) => { if (alive) setLines(got.slice(-CONSOLE_RECENT_MAX)) }).catch(() => {})
    const off = window.api.logs.onLine((line) => {
      setLines((cur) => { const next = cur.concat(line); return next.length > CONSOLE_RECENT_MAX ? next.slice(-CONSOLE_RECENT_MAX) : next })
    })
    return () => { alive = false; off() }
  }, [open])

  useEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lines])

  if (!open) return null

  const copyAll = async () => {
    try {
      await window.api.utils.copyToClipboard(lines.join('\n'))
      setNote(`복사했습니다 — ${lines.length}줄`)
    } catch { setNote('복사하지 못했습니다') }
  }

  return (
    <section data-testid="console-panel" role="dialog" aria-label="콘솔 — 동작 기록" style={{
      position: 'fixed', right: 16, bottom: 16, zIndex: 90,
      width: 'min(720px, calc(100vw - 32px))', height: 'min(320px, 45vh)',
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-card)', border: '1px solid var(--border-accent, var(--border-subtle))',
      borderRadius: 12, boxShadow: '0 10px 30px #0008',
    }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
        <strong style={{ fontSize: 13, flex: '0 0 auto' }}>콘솔</strong>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1, minWidth: 0 }}>
          {note || '동작 기록 · 글 내용과 폴더 경로는 적지 않습니다'}
        </span>
        <button type="button" data-testid="console-copy" style={button} onClick={() => { void copyAll() }}>전체 복사</button>
        <button type="button" data-testid="console-close" style={button} onClick={() => { void setConsoleOpen(false) }}>닫기</button>
      </header>
      <div ref={box} data-testid="console-lines"
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}
        style={{ flex: 1, overflow: 'auto', padding: '8px 10px', fontFamily: 'Consolas, "D2Coding", monospace', fontSize: 12, lineHeight: 1.55, userSelect: 'text' }}>
        {lines.length === 0 && <div style={{ color: 'var(--text-muted)' }}>아직 기록이 없습니다.</div>}
        {lines.map((l, i) => <div key={i} style={{ color: colorOf(l), whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{l}</div>)}
      </div>
    </section>
  )
}
