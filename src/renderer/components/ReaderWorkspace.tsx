import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { create } from 'zustand'
import { useReadAloud, type ReaderVoicePick } from '@/hooks/useReadAloud'
import { chunkAt, TEXT_FILE_LIMIT } from '../../shared/readerChunks'
import { DEFAULT_READER_PREFS, parseReaderPrefs, READER_PREFS_STORAGE_KEY, type ReaderPrefs } from '../../shared/readerText'

// 낭독 화면. 합성은 `useReadAloud`, 책·자리 보관은 `works/books`, 파일 고르기는 본체 대화상자가 맡는다.
type Book = { id: string; name: string; paragraphs: string[]; position: number }
/** 책으로 받을 파일 — 대화상자와 끌어 놓기가 **같은 규칙**을 타게 이름·크기·읽기만 본다. */
type TextSource = { name: string; size: number; read: () => Promise<ArrayBuffer | Uint8Array> }
const useReader = create<{
  books: Book[]; active: string; fontSize: number; voice: string
  /** ★실제로 합성에 쓸 지정. 이름만 들고 있으면 낭독을 시작할 수 없다. */
  pick: ReaderVoicePick | null
}>(() => ({ books: [], active: '', fontSize: 19, voice: '기본 목소리', pick: null }))
const panel: CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 14 }
const button: CSSProperties = { fontFamily: 'inherit', color: 'var(--text-secondary)', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', whiteSpace: 'nowrap' }
function BookIcon() { return <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M12 5v16M12 5C9 3 5 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 1Z"/></svg> }

export default function ReaderWorkspace() {
  const { books, active, fontSize, voice, pick } = useReader()
  const book = books.find(b => b.id === active)
  const bodyRef = useRef<HTMLDivElement>(null)
  const voiceButton = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [settings, setSettings] = useState(false)
  const [shelf, setShelf] = useState(true)
  /** 설치된 기본 목소리. ★표시값이 아니라 **본체가 확인한 것**이다(인수인계 1항). */
  const [builtins, setBuiltins] = useState<{ modelId: string; label: string; path: string; engineId: string }[]>([])
  const [voiceNote, setVoiceNote] = useState('')
  /**
   * 낭독 설정 — 따라가기·괄호 속 한자. **껐다 켜도 남는다**(설정 파일 한 칸).
   * ★읽기 전에 바꾼 값을 읽어 온 값이 덮지 않게 한다.
   */
  const [prefs, setPrefs] = useState<ReaderPrefs>(DEFAULT_READER_PREFS)
  const prefsTouched = useRef(false)
  useEffect(() => {
    void (async () => {
      try {
        const all = await window.api.settings.get() as Record<string, unknown>
        if (!prefsTouched.current) setPrefs(parseReaderPrefs(all?.[READER_PREFS_STORAGE_KEY]))
      } catch { /* 못 읽으면 기본값으로 읽는다 */ }
    })()
  }, [])
  const updatePrefs = (patch: Partial<ReaderPrefs>) => {
    prefsTouched.current = true
    const next = { ...prefs, ...patch }
    setPrefs(next)
    void window.api.settings.set(READER_PREFS_STORAGE_KEY, next)
      .then((r: { ok?: boolean } | undefined) => { if (r && r.ok === false) setError('낭독 설정을 저장하지 못했습니다 — 다시 켜면 예전 값으로 돌아갑니다.') })
      .catch(() => setError('낭독 설정을 저장하지 못했습니다 — 다시 켜면 예전 값으로 돌아갑니다.'))
  }
  useEffect(() => {
    void (async () => {
      try {
        const got = await window.api.cards.builtinVoices()
        const list = got?.data?.voices || []
        setBuiltins(list)
        if (!list.length) setVoiceNote('쓸 수 있는 기본 목소리가 없습니다.')
        // 아직 고른 적이 없으면 첫 기본 목소리를 쓴다 — 바로 들을 수 있게.
        useReader.setState((st) => st.pick ? st : (list[0]
          ? { pick: { kind: 'builtin', path: list[0].path, engineId: list[0].engineId, label: list[0].label }, voice: list[0].label }
          : st))
      } catch { setVoiceNote('기본 목소리를 확인하지 못했습니다.') }
    })()
  }, [])

  /**
   * 책과 읽던 자리를 **파일로** 보관한다 (인수인계 6항).
   *
   * ★설정 한 칸에 넣지 않는다. 본문이 길어 한 칸이 감당하지 못하고, 하나를 지우려 해도
   *   전체를 다시 써야 한다 — 그래서 지운 것이 되살아났다(이 프로젝트에서 겪은 일).
   *   **책 하나가 파일 하나**다. 목록에서 빼면 그 파일만 지운다.
   */
  const loadedBooks = useRef(false)
  useEffect(() => {
    void (async () => {
      try {
        const got = await window.api.works.list('books')
        if (got.error) return
        const saved = (got.records || [])
          .map((r) => r.data as Book | null)
          .filter((b): b is Book => !!b && Array.isArray(b.paragraphs) && b.paragraphs.length > 0)
        if (saved.length) useReader.setState((st) => st.books.length ? st : { books: saved, active: saved[0].id })
      } catch { /* 못 읽으면 빈 서가로 시작한다 — 지우지는 않는다 */ }
      finally { loadedBooks.current = true }
    })()
  }, [])

  const position = book?.position ?? 0
  // ★읽기 전에는 쓰지 않는다 — 빈 서가가 저장본을 지운다(다른 화면에서 겪은 사고다).
  useEffect(() => {
    if (!loadedBooks.current || !book) return
    const t = setTimeout(() => {
      void window.api.works.write('books', book.id, book).catch(() => { /* 다음 편집에서 다시 쓴다 */ })
    }, 600)
    return () => clearTimeout(t)
  }, [book?.id, book?.position, book?.paragraphs])
  useEffect(() => { bodyRef.current?.querySelector('[aria-current="location"]')?.scrollIntoView({ block: 'nearest' }) }, [active, position])
  // ★본문 **전체**를 넘긴다. 표시용 문단과 합성용 덩이는 다른 단위다 —
  //   나누기 규칙은 `readerChunks` 가 갖는다(인수인계 3항).
  const PARAGRAPH_GAP = '\n\n'
  const body = useMemo(() => (book?.paragraphs || []).join(PARAGRAPH_GAP), [book?.id, book?.paragraphs])
  /** 문단 번호 → 원문 글자 자리. 두 단위를 잇는 고리다. */
  const charOfParagraph = useMemo(() => {
    const out: number[] = []
    let n = 0
    for (const p of book?.paragraphs || []) { out.push(n); n += p.length + 2 }
    return out
  }, [book?.id, book?.paragraphs])
  const read = useReadAloud(body, pick, { skipHanjaInParens: prefs.skipHanjaInParens })
  /** 지금 읽는 덩이 — 문단 안에서 그 글자만 칠한다. 읽지 않을 때는 없다. */
  const phrase = read.playing ? read.chunks[read.at] : undefined
  // ★읽는 구절을 **화면이 따라간다** (2026-09-29 지시: "현재 어느 구절을 읽고 있는지 따라가게").
  //   덩이가 넘어갈 때마다 그 구절을 가운데로 가져온다. 끄면 그대로 둔다 — 앞뒤를 둘러볼 때.
  useEffect(() => {
    if (!read.playing || !prefs.follow) return
    const el = bodyRef.current?.querySelector('[data-testid="reader-phrase"]')
    if (!el) return
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' })
  }, [read.playing, read.at, prefs.follow, book?.id])
  // ★멈춰 있을 때는 **고른 자리**에 맞춰 둔다 — 엔진이 그 자리부터 미리 만들어 두어,
  //   누르는 순간 곧바로 들린다(2026-09-29 지시: "읽어오면 빠르게 만들어서").
  // ★오류가 떠 있으면 건드리지 않는다 (2026-09-30 신고: "붉은색으로 경로가 빠르게 보였다 사라진다").
  //   멈추자마자 자리를 맞추면서 오류 문구까지 지워, 무엇이 틀렸는지 읽을 수 없었다.
  const { playing: readPlaying, seekToChar, fault: readFault } = read
  useEffect(() => {
    if (!readPlaying && !readFault) seekToChar(charOfParagraph[position] ?? 0)
  }, [readPlaying, readFault, seekToChar, position, charOfParagraph])
  /** 지금 **실제로 읽고 있는** 문단. 사용자가 고른 자리와 다르다(인수인계 5항). */
  const readingParagraph = useMemo(() => {
    const start = read.chunks[read.at]?.start ?? -1
    if (start < 0) return -1
    let idx = 0
    for (let i = 0; i < charOfParagraph.length; i++) { if (charOfParagraph[i] <= start) idx = i; else break }
    return idx
  }, [read.chunks, read.at, charOfParagraph])

  const closeSettings = () => { setSettings(false); voiceButton.current?.focus() }
  /**
   * 문단 글에서 **지금 읽는 덩이**에 든 글자만 칠한다. 덩이는 원문 글자 자리를 들고 있어
   * 여러 문단에 걸쳐도 각 문단의 제 몫만 칠해진다.
   */
  const withPhrase = (p: string, at: number) => {
    if (!phrase) return p
    const from = Math.max(at, phrase.start) - at
    const to = Math.min(at + p.length, phrase.end) - at
    if (from >= to) return p
    return <>{p.slice(0, from)}<mark data-testid="reader-phrase" style={{ background: 'rgba(102, 204, 204, 0.2)', color: 'var(--text-primary)', borderRadius: 3, padding: '1px 0', boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone' }}>{p.slice(from, to)}</mark>{p.slice(to)}</>
  }
  const choosePosition = (value: number) => {
    if (!book) return
    useReader.setState(s => ({ books: s.books.map(b => b.id === book.id ? { ...b, position: Math.max(0, Math.min(value, b.paragraphs.length - 1)) } : b) }))
  }
  // ★불러온 자리를 기억한다(2026-09-29 지시). 브라우저식 파일 입력칸은 여는 자리를
  //   운영체제가 정해서 다른 툴 폴더로 열렸다 — 본체 대화상자가 용도별로 기억한다.
  const pickTexts = async () => {
    if (loading) return
    const got = await window.api.reader.pickTexts()
    if (got.error) { setError(got.error); return }
    const list = got.data || []
    if (!list.length) return                       // 취소
    await importFiles(list.map(f => ({
      name: f.name, size: f.size,
      read: async () => { if (!f.bytes) throw new Error('읽지 못함'); return f.bytes },
    })))
  }
  const dropTexts = (files: File[]) => {
    // 끌어 온 것도 불러온 자리다 — 첫 글 파일의 폴더를 기억한다.
    const first = files.find(f => /\.txt$/i.test(f.name))
    const at = first ? window.api.utils.getPathForFile(first) : ''
    if (at) void window.api.reader.rememberTextDir(at)
    void importFiles(files.map(f => ({ name: f.name, size: f.size, read: () => f.arrayBuffer() })))
  }
  // 목소리 파일은 앱 전체의 '목소리' 기억을 함께 쓴다 — 카드에서 고른 폴더가 여기서도 열린다.
  const pickVoiceFile = async () => {
    setSettings(false)
    const at = await window.api.audio.selectFile(false, 'voice')
    if (typeof at !== 'string' || !at) return      // 취소
    const label = at.split(/[\\/]/).pop() || at
    useReader.setState({ voice: label, pick: { kind: 'reference', path: at, label } })
  }
  const importFiles = async (files: TextSource[]) => {
    if (loading) return
    setLoading(true); setError('')
    const added: Book[] = []; const rejected: string[] = []
    try {
      for (const file of files) {
        if (!/\.txt$/i.test(file.name) || file.size > TEXT_FILE_LIMIT) { rejected.push(`${file.name}: TXT · 10MB 이하만 지원`); continue }
        try {
          const bytes = await file.read()
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
  const removeBook = (id: string) => {
    // ★그 파일 하나만 지운다. 남의 책을 다시 쓰지 않는다.
    void window.api.works.remove('books', id).catch(() => { /* 다음에 다시 지운다 */ })
    useReader.setState(s => {
      const next = s.books.filter(b => b.id !== id)
      return { books: next, active: s.active === id ? next[0]?.id || '' : s.active }
    })
  }
  return <section data-testid="reader-workspace" aria-label="낭독 작업실" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <button style={button} aria-pressed={shelf} onClick={() => setShelf(v => !v)} title="책 목록 열기·닫기">☷ 책 목록 {books.length || ''}</button>
      <button style={button} onClick={() => { void pickTexts() }} disabled={loading} data-testid="reader-add-text">＋ 텍스트 추가</button>
      <span data-testid="reader-notice"
        title="책과 읽던 자리는 앱을 껐다 켜도 남습니다. 목록에서 빼면 그 기록만 지워지고 원본 파일은 그대로입니다. 목소리를 바꾸면 만들어 둔 소리는 버리고 다시 만듭니다."
        style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
        {read.playing ? '읽는 중' : books.length ? `책 ${books.length}권` : ''}
      </span>
    </div>
    {error && <div role="alert" style={{ color: 'var(--rose, #fb7185)', fontSize: 12 }}>{error}</div>}
    <div onDragOver={e => { e.preventDefault(); setDragging(true) }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }} onDrop={e => { e.preventDefault(); setDragging(false); dropTexts(Array.from(e.dataTransfer.files)) }} style={{ display: 'flex', gap: 16, flexWrap: 'wrap', outline: dragging ? '2px solid var(--accent-light)' : undefined, borderRadius: 14 }}>
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
        {!book ? <button onClick={() => { void pickTexts() }} disabled={loading} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, width: 'calc(100% - 32px)', minHeight: 330, margin: 16, border: '1px dashed var(--border-accent)', borderRadius: 12, background: 'var(--bg-base)', color: 'var(--text-primary)', fontFamily: 'inherit', cursor: 'pointer' }}>
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
            {/* ★고른 자리와 **읽는 자리**를 구분해 보인다(인수인계 5항).
                누른 곳은 '여기서 시작' 이고, 색이 찬 곳은 '지금 읽는 중' 이다. */}
            {book.paragraphs.map((p, i) => {
              const chosen = i === position
              const reading = read.playing && i === readingParagraph
              return <button key={`${book.id}-${i}`} data-testid="reader-paragraph"
                onClick={() => { choosePosition(i); if (read.playing) read.seekToChar(charOfParagraph[i] ?? 0) }}
                aria-current={reading ? 'true' : chosen ? 'location' : undefined}
                data-reading={reading ? '1' : '0'}
                title={reading ? '지금 읽고 있는 곳입니다' : '이 문단을 낭독 시작 위치로 선택'}
                style={{ display: 'block', width: '100%', textAlign: 'left', fontFamily: 'inherit', fontSize, lineHeight: 1.95, padding: '12px 16px', marginBottom: 8, border: 'none', borderLeft: `2px solid ${reading ? 'var(--cyan)' : chosen ? 'var(--accent-light)' : 'transparent'}`, borderRadius: 7, background: reading ? 'var(--accent-glow)' : 'transparent', color: (reading || chosen) ? 'var(--text-primary)' : 'var(--text-secondary)', cursor: 'pointer', overflowWrap: 'anywhere' }}>{withPhrase(p, charOfParagraph[i] ?? 0)}</button>
            })}
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
        <button data-testid="reader-play" aria-label={read.playing ? '낭독 멈추기' : '낭독 시작'}
          disabled={!book || !pick}
          title={!book ? '먼저 책을 고르세요' : !pick ? '먼저 목소리를 고르세요' : read.playing ? '멈춥니다' : '이 자리부터 읽습니다'}
          onClick={() => {
            if (read.playing) { read.stop(); return }
            // 고른 문단부터 읽는다 — '시작 위치' 와 '읽는 자리' 는 다른 것이다(인수인계 5항).
            read.seekToChar(charOfParagraph[position] ?? 0)
            read.start()
          }}
          style={{ ...button, width: 46, height: 46, borderRadius: '50%', color: 'var(--accent-light)', background: 'var(--accent-glow)', cursor: (!book || !pick) ? 'not-allowed' : 'pointer' }}>
          {read.playing ? '■' : '▶'}
        </button>
        <button style={button} aria-label="다음 문단" disabled={!book || position >= book.paragraphs.length - 1} onClick={() => choosePosition(position + 1)}>›</button>
        <button data-testid="reader-follow" aria-pressed={prefs.follow} title={prefs.follow ? '읽는 구절을 화면이 따라갑니다 — 누르면 멈춥니다' : '누르면 읽는 구절을 화면이 따라갑니다'}
          onClick={() => updatePrefs({ follow: !prefs.follow })}
          style={{ ...button, fontSize: 12, color: prefs.follow ? 'var(--cyan)' : 'var(--text-muted)', borderColor: prefs.follow ? 'var(--cyan)' : undefined }}>따라가기</button>
      </div>
      <span data-testid="reader-state" style={{ flex: '1 1 140px', textAlign: 'right', fontSize: 12, color: read.fault ? 'var(--rose, #fb7185)' : 'var(--text-muted)' }}>
        {read.fault || read.wait || (book ? `${position + 1} / ${book.paragraphs.length} 문단` : '책을 선택하세요')}
      </span>
    </footer>
    {settings && <div onKeyDown={e => {
      if (e.key === 'Escape') closeSettings()
      if (e.key === 'Tab') {
        const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button, input'))
        const first = buttons[0], last = buttons[buttons.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }} onClick={closeSettings} style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#0009', display: 'grid', placeItems: 'center', padding: 20 }}>
      <section role="dialog" aria-modal="true" aria-label="낭독 목소리" onClick={e => e.stopPropagation()} style={{ ...panel, width: '100%', maxWidth: 420, padding: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20 }}><h2 style={{ fontSize: 17, margin: 0 }}>낭독 목소리</h2><button autoFocus aria-label="닫기" onClick={closeSettings} style={{ ...button, marginLeft: 'auto' }}>×</button></div>
        {/* ★설치된 것만 보여 준다. 없는 목소리를 고르게 하면 눌러야 실패를 안다. */}
        {builtins.map(b => (
          <button key={b.modelId} data-testid="reader-voice-builtin"
            style={{ ...button, width: '100%', textAlign: 'left', marginBottom: 10 }}
            onClick={() => {
              useReader.setState({ voice: b.label, pick: { kind: 'builtin', path: b.path, engineId: b.engineId, label: b.label } })
              setSettings(false)
            }}>{b.label}</button>
        ))}
        {!builtins.length && <span style={{ display: 'block', fontSize: 12, color: 'var(--amber, #d4a017)', marginBottom: 10 }}>{voiceNote || '기본 목소리를 확인하는 중입니다'}</span>}
        <button data-testid="reader-voice-file" style={{ ...button, width: '100%', textAlign: 'left' }}
          title="가지고 있는 소리·영상의 목소리로 읽습니다. 기본 목소리보다 훨씬 느립니다 — 실측 4배."
          onClick={() => { void pickVoiceFile() }}>＋ 음성·영상에서 목소리 선택</button>
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 18, fontSize: 13, cursor: 'pointer' }}>
          <input data-testid="reader-skip-hanja" type="checkbox" checked={prefs.skipHanjaInParens}
            onChange={e => updatePrefs({ skipHanjaInParens: e.target.checked })} style={{ marginTop: 3 }} />
          <span>괄호 속 한자는 읽지 않기
            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>예: 학교(學校) → "학교" 만 읽습니다. 본문에는 그대로 보입니다.</span>
          </span>
        </label>
      </section>
    </div>}
  </section>
}
