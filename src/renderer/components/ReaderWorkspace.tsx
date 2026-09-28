import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { create } from 'zustand'

// Renderer-only reading session. No settings writes, synthesis calls or simulated playback.
type Book = { id: string; name: string; paragraphs: string[]; position: number }
const useReader = create<{
  books: Book[]; active: string; fontSize: number; voice: string
}>(() => ({ books: [], active: '', fontSize: 19, voice: '기본 목소리' }))
const panel: CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 14 }
const button: CSSProperties = { fontFamily: 'inherit', color: 'var(--text-secondary)', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', whiteSpace: 'nowrap' }
function BookIcon() { return <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M12 5v16M12 5C9 3 5 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 1Z"/></svg> }

export default function ReaderWorkspace() {
  const { books, active, fontSize, voice } = useReader()
  const book = books.find(b => b.id === active)
  const fileInput = useRef<HTMLInputElement>(null)
  const voiceInput = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const voiceButton = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [settings, setSettings] = useState(false)
  const [shelf, setShelf] = useState(true)
  const position = book?.position ?? 0
  useEffect(() => { bodyRef.current?.querySelector('[aria-current="location"]')?.scrollIntoView({ block: 'nearest' }) }, [active, position])
  const closeSettings = () => { setSettings(false); voiceButton.current?.focus() }
  const choosePosition = (value: number) => {
    if (!book) return
    useReader.setState(s => ({ books: s.books.map(b => b.id === book.id ? { ...b, position: Math.max(0, Math.min(value, b.paragraphs.length - 1)) } : b) }))
  }
  const importFiles = async (files: File[]) => {
    if (loading) return
    setLoading(true); setError('')
    const added: Book[] = []; const rejected: string[] = []
    try {
      for (const file of files) {
        if (!/\.txt$/i.test(file.name) || file.size > 10 * 1024 * 1024) { rejected.push(`${file.name}: TXT · 10MB 이하만 지원`); continue }
        try {
          const bytes = await file.arrayBuffer()
          let text: string
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
          catch { rejected.push(`${file.name}: UTF-8로 저장한 뒤 다시 불러오세요`); continue }
          const paragraphs = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(p => p.trim()).filter(Boolean)
          if (!paragraphs.length) { rejected.push(`${file.name}: 내용 없음`); continue }
          added.push({ id: crypto.randomUUID(), name: file.name.replace(/\.txt$/i, ''), paragraphs, position: 0 })
        } catch { rejected.push(`${file.name}: 읽지 못했습니다`) }
      }
      if (added.length) useReader.setState(s => ({ books: [...s.books, ...added], active: s.active || added[0].id }))
      setError(rejected.join(' · '))
    } finally { setLoading(false) }
  }
  const removeBook = (id: string) => useReader.setState(s => {
    const next = s.books.filter(b => b.id !== id)
    return { books: next, active: s.active === id ? next[0]?.id || '' : s.active }
  })
  return <section data-testid="reader-workspace" aria-label="낭독 작업실" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <input ref={fileInput} type="file" accept=".txt,text/plain" multiple hidden onChange={e => { void importFiles(Array.from(e.target.files || [])); e.target.value = '' }} />
    <input ref={voiceInput} type="file" accept="audio/*,video/*" hidden onChange={e => { const f = e.target.files?.[0]; if (f) useReader.setState({ voice: f.name }); e.target.value = '' }} />
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <button style={button} aria-pressed={shelf} onClick={() => setShelf(v => !v)} title="책 목록 열기·닫기">☷ 책 목록 {books.length || ''}</button>
      <button style={button} onClick={() => fileInput.current?.click()} disabled={loading}>＋ 텍스트 추가</button>
      <span title="이번 실행에서는 파일 읽기와 화면 설정만 사용할 수 있습니다. 낭독 엔진·재시작 복원은 연결 예정입니다." style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>낭독 연결 예정</span>
    </div>
    {error && <div role="alert" style={{ color: 'var(--rose, #fb7185)', fontSize: 12 }}>{error}</div>}
    <div onDragOver={e => { e.preventDefault(); setDragging(true) }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }} onDrop={e => { e.preventDefault(); setDragging(false); void importFiles(Array.from(e.dataTransfer.files)) }} style={{ display: 'flex', gap: 16, flexWrap: 'wrap', outline: dragging ? '2px solid var(--accent-light)' : undefined, borderRadius: 14 }}>
      {shelf && books.length > 0 && <aside aria-label="책 목록" style={{ ...panel, flex: '1 1 190px', minWidth: 0, padding: 12, alignSelf: 'flex-start' }}>
        <div style={{ padding: '6px 8px 14px', fontSize: 11, color: 'var(--text-muted)' }}>내 책</div>
        <div style={{ maxHeight: 440, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {books.map((b, i) => <div key={b.id} style={{ display: 'flex', gap: 4, borderRadius: 9, background: active === b.id ? 'var(--accent-glow)' : 'transparent' }}>
            <button onClick={() => useReader.setState({ active: b.id })} aria-current={active === b.id ? 'true' : undefined} style={{ ...button, flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
              <span style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>{String(i + 1).padStart(2, '0')}</span>{b.name}
              <span style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', marginTop: 7 }}>{b.position + 1} / {b.paragraphs.length} 문단</span>
            </button>
            <button aria-label={`${b.name} 목록에서 빼기`} title="목록에서 빼기 · 원본 파일은 유지" onClick={() => removeBook(b.id)} style={{ ...button, padding: 6, background: 'transparent', border: 'none', alignSelf: 'flex-start' }}>×</button>
          </div>)}
        </div>
      </aside>}
      <article style={{ ...panel, flex: '4 1 340px', minWidth: 0, overflow: 'hidden' }}>
        {!book ? <button onClick={() => fileInput.current?.click()} disabled={loading} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, width: 'calc(100% - 32px)', minHeight: 330, margin: 16, border: '1px dashed var(--border-accent)', borderRadius: 12, background: 'var(--bg-base)', color: 'var(--text-primary)', fontFamily: 'inherit', cursor: 'pointer' }}>
          <span style={{ color: 'var(--accent-light)', padding: 17, borderRadius: 14, background: 'var(--accent-glow)' }}><BookIcon /></span>
          <strong style={{ fontSize: 17 }}>{loading ? '책을 불러오는 중' : '읽고 싶은 글을 가져오세요'}</strong>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>끌어 놓거나 클릭해서 선택</span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>TXT · 여러 파일</span>
        </button> : <>
          <header style={{ padding: '20px 24px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, borderBottom: '1px solid var(--border-subtle)' }}>
            <h2 style={{ margin: 0, fontSize: 17, flex: 1, overflowWrap: 'anywhere' }}>{book.name}</h2>
            <button style={button} aria-label="글자 작게" disabled={fontSize <= 15} onClick={() => useReader.setState({ fontSize: fontSize - 2 })}>가−</button>
            <button style={button} aria-label="글자 크게" disabled={fontSize >= 27} onClick={() => useReader.setState({ fontSize: fontSize + 2 })}>가＋</button>
          </header>
          <div ref={bodyRef} aria-label="책 본문" style={{ height: 'clamp(300px, 48vh, 620px)', overflowY: 'auto', padding: '22px clamp(12px, 3vw, 32px)', background: 'var(--bg-base)' }}>
            {book.paragraphs.map((p, i) => <button key={`${book.id}-${i}`} onClick={() => choosePosition(i)} aria-current={i === position ? 'location' : undefined} title="이 문단을 낭독 시작 위치로 선택" style={{ display: 'block', width: '100%', textAlign: 'left', fontFamily: 'inherit', fontSize, lineHeight: 1.95, padding: '12px 16px', marginBottom: 8, border: 'none', borderLeft: `2px solid ${i === position ? 'var(--accent-light)' : 'transparent'}`, borderRadius: 7, background: i === position ? 'var(--accent-glow)' : 'transparent', color: i === position ? 'var(--text-primary)' : 'var(--text-secondary)', cursor: 'pointer', overflowWrap: 'anywhere' }}>{p}</button>)}
          </div>
        </>}
      </article>
    </div>
    <footer style={{ ...panel, padding: '16px 12px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)', alignItems: 'center', gap: 8 }}>
      <button ref={voiceButton} onClick={() => setSettings(true)} style={{ ...button, minWidth: 0, textAlign: 'left', padding: 8 }} title="낭독 목소리 선택">
        <span style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', marginBottom: 5 }}>목소리</span><span style={{ overflowWrap: 'anywhere', whiteSpace: 'normal' }}>{voice}</span>
      </button>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
        <button style={button} aria-label="이전 문단" disabled={!book || position === 0} onClick={() => choosePosition(position - 1)}>‹</button>
        <button disabled aria-label="낭독 시작" title="낭독 엔진 연결 예정" style={{ ...button, width: 46, height: 46, borderRadius: '50%', color: 'var(--accent-light)', background: 'var(--accent-glow)', cursor: 'not-allowed' }}>▶</button>
        <button style={button} aria-label="다음 문단" disabled={!book || position >= book.paragraphs.length - 1} onClick={() => choosePosition(position + 1)}>›</button>
      </div>
      <span style={{ flex: '1 1 140px', textAlign: 'right', fontSize: 12, color: 'var(--text-muted)' }}>{book ? `${position + 1} / ${book.paragraphs.length} 문단` : '책을 선택하세요'}</span>
    </footer>
    {settings && <div onKeyDown={e => {
      if (e.key === 'Escape') closeSettings()
      if (e.key === 'Tab') {
        const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
        const first = buttons[0], last = buttons[buttons.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }} onClick={closeSettings} style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#0009', display: 'grid', placeItems: 'center', padding: 20 }}>
      <section role="dialog" aria-modal="true" aria-label="낭독 목소리" onClick={e => e.stopPropagation()} style={{ ...panel, width: '100%', maxWidth: 420, padding: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20 }}><h2 style={{ fontSize: 17, margin: 0 }}>낭독 목소리</h2><button autoFocus aria-label="닫기" onClick={closeSettings} style={{ ...button, marginLeft: 'auto' }}>×</button></div>
        <button style={{ ...button, width: '100%', textAlign: 'left', marginBottom: 10 }} onClick={() => { useReader.setState({ voice: '기본 목소리' }); setSettings(false) }}>기본 목소리</button>
        <button style={{ ...button, width: '100%', textAlign: 'left' }} title="현재는 파일 이름만 선택합니다. 목소리 준비와 합성은 연결 예정입니다." onClick={() => { voiceInput.current?.click(); setSettings(false) }}>＋ 음성·영상에서 목소리 선택</button>
      </section>
    </div>}
  </section>
}
