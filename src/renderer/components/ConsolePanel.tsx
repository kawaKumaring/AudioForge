/**
 * 콘솔 — **앱 밖에 따로 뜨는 창**에서 동작 기록을 보고, 한 번에 복사한다.
 *
 * ★지시 (2026-09-30): "작동 동작 관련 콘솔 창을 복사해서 붙여 넣으면 문제를 찾는 게 수월할 것 같다."
 * ★앱 화면 안에 두지 않는다 — 떠 있는 창·아래 서랍·창 늘리기 모두 작업 화면을 건드렸다(같은 날 피드백 셋).
 *   사용자 제안대로 **별도 창**이다. 켜고 끄는 곳은 설정의 '콘솔 켜기' 하나이고, 콘솔 창을 닫으면 꺼진다.
 * ★이 창은 **보여 주기만** 한다. 기록은 켜든 끄든 앱 로그 파일에 남는다.
 * ★보이는 줄에는 글 내용·폴더 경로가 없다 — 본체가 쓸 때부터 씻는다.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { create } from 'zustand'
import { CONSOLE_POPUP_STORAGE_KEY, CONSOLE_RECENT_MAX, parseConsolePopup } from '../../shared/appConsole'

/** 콘솔 창이 떠 있는가(설정). 앱 화면의 체크 상자가 본다. */
export const useConsolePanel = create<{ open: boolean }>(() => ({ open: false }))

/** 앱을 켤 때 한 번 — 설정을 읽어 체크 상자를 맞추고, 사용자가 콘솔 창을 닫으면 따라 끈다. */
export async function loadConsolePref(): Promise<() => void> {
  const off = window.api.consoleWindow?.onClosed?.(() => useConsolePanel.setState({ open: false })) ?? (() => {})
  try {
    const all = await window.api.settings.get() as Record<string, unknown>
    useConsolePanel.setState({ open: parseConsolePopup(all?.[CONSOLE_POPUP_STORAGE_KEY]) })
  } catch { /* 못 읽으면 꺼진 채로 */ }
  return off
}

/** 켜고 끈다 — 본체가 창을 열고 닫고 설정에 남긴다. */
export async function setConsoleOpen(open: boolean): Promise<boolean> {
  useConsolePanel.setState({ open })
  try { return await window.api.consoleWindow.set(open) } catch { return false }
}

const button: CSSProperties = {
  background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)',
  borderRadius: 7, padding: '5px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
}

const colorOf = (line: string): string =>
  / ERROR /.test(line) ? 'var(--rose, #f89)' : / WARN /.test(line) ? 'var(--amber, #edc46d)' : 'var(--text-secondary)'

/** 콘솔 창의 화면 — 창 전체가 기록이다. */
export default function ConsoleWindow() {
  const [lines, setLines] = useState<string[]>([])
  const [note, setNote] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)          // 맨 아래를 보고 있으면 새 줄을 따라간다

  useEffect(() => {
    document.title = 'AudioForge — 콘솔'
    let alive = true
    void window.api.logs.recent().then((got) => { if (alive) setLines(got.slice(-CONSOLE_RECENT_MAX)) }).catch(() => {})
    const off = window.api.logs.onLine((line) => {
      setLines((cur) => { const next = cur.concat(line); return next.length > CONSOLE_RECENT_MAX ? next.slice(-CONSOLE_RECENT_MAX) : next })
    })
    return () => { alive = false; off() }
  }, [])

  useEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lines])

  const copyAll = async () => {
    try {
      await window.api.utils.copyToClipboard(lines.join('\n'))
      setNote(`복사했습니다 — ${lines.length}건`)
    } catch { setNote('복사하지 못했습니다') }
  }
  const warns = lines.filter((l) => / (WARN|ERROR) /.test(l)).length

  return (
    <section data-testid="console-window" aria-label="콘솔 — 동작 기록"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-primary)' }}>
        <strong style={{ fontSize: 13 }}>콘솔</strong>
        <span style={{ fontSize: 11, color: warns ? 'var(--amber, #edc46d)' : 'var(--text-muted)' }}>
          {lines.length}건{warns ? ` · 경고·오류 ${warns}` : ''}
        </span>
        <span data-testid="console-note" style={{ flex: 1, minWidth: 0, fontSize: 11, color: note ? 'var(--accent-light)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {note || '동작 기록 · 글 내용과 폴더 경로는 적지 않습니다'}
        </span>
        <button type="button" data-testid="console-copy" style={button} onClick={() => { void copyAll() }}>전체 복사</button>
      </header>
      <div ref={box} data-testid="console-lines"
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}
        style={{ flex: 1, overflow: 'auto', padding: '8px 12px 12px', fontFamily: 'Consolas, "D2Coding", monospace', fontSize: 12, lineHeight: 1.55, userSelect: 'text' }}>
        {lines.length === 0 && <div style={{ color: 'var(--text-muted)' }}>아직 기록이 없습니다.</div>}
        {lines.map((l, i) => <div key={i} style={{ color: colorOf(l), whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{l}</div>)}
      </div>
    </section>
  )
}
