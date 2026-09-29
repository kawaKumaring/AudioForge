/**
 * 콘솔 서랍 — 동작 기록을 **아래에서 펼쳐 보고, 한 번에 복사한다.**
 *
 * ★지시 (2026-09-30): "작동 동작 관련 콘솔 창을 복사해서 붙여 넣으면 문제를 찾는 게 수월할 것 같다."
 * ★펼치면 작업 화면 **아래로** 늘어난다 (같은 날 피드백: "콘솔이 위로 올라와서 UX 를 해친다").
 *   작업 화면의 높이는 그대로고, 제목 줄 아래 스크롤 영역이 아래로 내려가 기록을 보여 준다.
 * ★떠 있는 창이 아니다 (같은 날 피드백: "콘솔 팝업이 은근히 방해가 심하다 — 하단에 고정으로 토글을 넣어서
 *   확장하듯이 늘어나고 줄이게. 평소에는 토글이 없지만 옵션에서 콘솔을 활성화하면 하단에 토글이 생긴다").
 *   화면 배치의 맨 아래 한 칸이라 본문을 가리지 않는다 — 펼치면 그만큼 작업 화면이 줄어든다.
 * ★이 서랍은 **보여 주기만** 한다. 기록은 켜든 끄든 앱 로그 파일에 남는다.
 * ★보이는 줄에는 글 내용·폴더 경로가 없다 — 본체가 쓸 때부터 씻는다.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { create } from 'zustand'
import { CONSOLE_POPUP_STORAGE_KEY, CONSOLE_RECENT_MAX, parseConsolePopup } from '../../shared/appConsole'

/** `open` 은 **서랍을 두는가**(설정). 펼침은 서랍 안의 일이라 저장하지 않는다 — 켤 때마다 접힌 채로 시작한다. */
/** 접힌 막대의 높이 — 작업 화면이 이만큼만 양보한다. */
export const CONSOLE_BAR_PX = 32
/** 펼친 기록 칸의 높이 — 작업 화면을 줄이지 않고 **그 아래로** 붙는다. */
export const CONSOLE_BODY_PX = 300

export const useConsolePanel = create<{ open: boolean }>(() => ({ open: false }))

/** 앱을 켤 때 한 번 — 켜 두었던 서랍을 다시 둔다. */
export async function loadConsolePref(): Promise<void> {
  try {
    const all = await window.api.settings.get() as Record<string, unknown>
    useConsolePanel.setState({ open: parseConsolePopup(all?.[CONSOLE_POPUP_STORAGE_KEY]) })
  } catch { /* 못 읽으면 없는 채로 */ }
}

/** 두고 뺀다 — 설정 파일에 남긴다. 저장 결과를 돌려준다(실패를 성공으로 바꾸지 않는다). */
export async function setConsoleOpen(open: boolean): Promise<boolean> {
  useConsolePanel.setState({ open })
  try {
    const r = await window.api.settings.set(CONSOLE_POPUP_STORAGE_KEY, open) as { ok?: boolean } | undefined
    return !(r && r.ok === false)
  } catch { return false }
}

const button: CSSProperties = {
  background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)',
  borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
}

const colorOf = (line: string): string =>
  / ERROR /.test(line) ? 'var(--rose, #f89)' : / WARN /.test(line) ? 'var(--amber, #edc46d)' : 'var(--text-secondary)'

/** 한 줄 미리보기 — 시각은 빼고 무엇이 일어났는지만. */
const preview = (line: string): string => line.replace(/^\S+\s+/, '').split('\n')[0]

export default function ConsolePanel() {
  const open = useConsolePanel((s) => s.open)
  const [expanded, setExpanded] = useState(false)
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
  }, [lines, expanded])

  useEffect(() => { if (!open) setExpanded(false) }, [open])

  // 펼치면 아래로 내려가 기록을 보이고, 접으면 맨 위로 돌아온다.
  const shell = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const sc = shell.current?.closest('[data-testid="shell-scroll"]') as HTMLElement | null
    if (!sc) return
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    sc.scrollTo({ top: expanded ? sc.scrollHeight : 0, behavior: calm ? 'auto' : 'smooth' })
  }, [expanded])

  if (!open) return null

  const copyAll = async () => {
    try {
      await window.api.utils.copyToClipboard(lines.join('\n'))
      setNote(`복사했습니다 — ${lines.length}건`)
    } catch { setNote('복사하지 못했습니다') }
  }
  const last = lines[lines.length - 1] || ''
  const warns = lines.filter((l) => / (WARN|ERROR) /.test(l)).length

  return (
    <section ref={shell} data-testid="console-panel" aria-label="콘솔 — 동작 기록" style={{
      display: 'flex', flexDirection: 'column',
      height: expanded ? CONSOLE_BAR_PX + CONSOLE_BODY_PX : CONSOLE_BAR_PX,
      background: 'var(--bg-primary)', borderTop: '1px solid var(--border-subtle)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: CONSOLE_BAR_PX, flexShrink: 0, padding: '0 12px' }}>
        <button type="button" data-testid="console-toggle" aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)} title={expanded ? '콘솔 접기' : '콘솔 펼치기'}
          style={{ ...button, background: 'transparent', border: 'none', padding: '3px 4px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span aria-hidden="true">{expanded ? '▼' : '▲'}</span><strong style={{ fontSize: 12 }}>콘솔</strong>
        </button>
        <span style={{ fontSize: 11, color: warns ? 'var(--amber, #edc46d)' : 'var(--text-muted)', flexShrink: 0 }}>
          {lines.length}건{warns ? ` · 경고·오류 ${warns}` : ''}
        </span>
        {/* 접혀 있을 때도 무엇이 막 일어났는지 한 줄은 보인다. */}
        <span data-testid="console-last" style={{ flex: 1, minWidth: 0, fontSize: 11, color: note ? 'var(--accent-light)' : colorOf(last),
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: expanded || note ? 'inherit' : 'Consolas, "D2Coding", monospace' }}>
          {note || (expanded ? '동작 기록 · 글 내용과 폴더 경로는 적지 않습니다' : preview(last))}
        </span>
        <button type="button" data-testid="console-copy" style={button} onClick={() => { void copyAll() }}>전체 복사</button>
      </div>
      {expanded && <div ref={box} data-testid="console-lines"
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}
        style={{ flex: 1, overflow: 'auto', padding: '6px 12px 10px', borderTop: '1px solid var(--border-subtle)', fontFamily: 'Consolas, "D2Coding", monospace', fontSize: 12, lineHeight: 1.55, userSelect: 'text' }}>
        {lines.length === 0 && <div style={{ color: 'var(--text-muted)' }}>아직 기록이 없습니다.</div>}
        {lines.map((l, i) => <div key={i} style={{ color: colorOf(l), whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{l}</div>)}
      </div>}
    </section>
  )
}
