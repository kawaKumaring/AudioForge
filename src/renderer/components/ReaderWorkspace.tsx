import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { create } from 'zustand'
import { useReadAloud, voiceKeyOf, type ReaderVoicePick } from '@/hooks/useReadAloud'
import { useAppStore } from '@/stores/app.store'
import { Icon, Modal, button as kitButton, muted } from './kit'
import VoicePicker from './VoicePicker'
import type { PreviewMaker } from '../lib/voicePreview'
import { runVoicePrep } from '@/lib/voicePrepRunner'
import { opLog, nameOnly } from '@/lib/opLog'
import { chunkAt, TEXT_FILE_LIMIT } from '../../shared/readerChunks'
import { decodeBookText, encodingLabel } from '../../shared/readerDecode'
import PlaybackRateSelect from './PlaybackRateSelect'
import { WINDOW_FROM, estimateHeight, offsetsOf, visibleRange, scrollTopFor } from '../../shared/readerWindow'
import { DEFAULT_READER_PREFS, parseReaderPrefs, rememberVoice, READER_PREFS_STORAGE_KEY, READER_FONT_MAX, READER_FONT_MIN, type ReaderPrefs } from '../../shared/readerText'
import type { BuiltinVoiceRef } from '../../shared/synthesisCardVoice'

/** 들어 보기 문장 — 책 읽는 문장이어야 낭독 목소리를 고를 수 있다. */
const SAMPLE_TEXT = '그는 천천히 문을 열고 어두운 복도를 내다보았다. 멀리서 물이 떨어지는 소리만 일정하게 이어졌다.'
// 낭독 화면. 합성은 `useReadAloud`, 책·자리 보관은 `works/books`, 파일 고르기는 본체 대화상자가 맡는다.
type Book = { id: string; name: string; paragraphs: string[]; position: number }
/** 책으로 받을 파일 — 대화상자와 끌어 놓기가 **같은 규칙**을 타게 이름·크기·읽기만 본다. */
type TextSource = { name: string; size: number; read: () => Promise<ArrayBuffer | Uint8Array> }
const useReader = create<{
  books: Book[]; active: string; voice: string
  /** ★실제로 합성에 쓸 지정. 이름만 들고 있으면 낭독을 시작할 수 없다. */
  pick: ReaderVoicePick | null
}>(() => ({ books: [], active: '', voice: '기본 목소리', pick: null }))
// 검사·개발툴 MCP 전용 — 낭독 상태를 읽을 수 있게(생성 카드 저장소와 같은 규칙: 검사 모드에서만).
if (typeof window !== 'undefined' && window.api?._e2e) Object.assign(window, { __readerStore: useReader })
const panel: CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 14 }
const button: CSSProperties = { fontFamily: 'inherit', color: 'var(--text-secondary)', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', whiteSpace: 'nowrap' }
function BookIcon({ size = 26 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M12 5v16M12 5C9 3 5 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 1Z"/></svg> }

const PHRASE_MARK: CSSProperties = { background: 'rgba(102, 204, 204, 0.2)', color: 'var(--text-primary)', borderRadius: 3, padding: '1px 0', boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone' }

/**
 * 문단 한 줄 — **바뀐 줄만** 다시 그린다.
 * ★큰 책에서 문단 하나를 누르면 모든 문단을 다시 그려 한 번에 120~170ms 가 걸렸다(3만 문단 · 5.5MB 실측).
 *   덩이가 넘어갈 때마다도 그랬다. 줄마다 자기 몫(고른 자리·읽는 중·칠할 글자 범위)만 받게 한다.
 * ★큰 책은 보이는 문단만 그린다(아래 `readerWindow`). `content-visibility` 는 누름을 오히려 느리게 해 쓰지 않는다.
 */
const ReaderParagraph = memo(function ReaderParagraph({ text, index, chosen, reading, from, to, fontSize, onPick }: {
  text: string; index: number; chosen: boolean; reading: boolean
  /** 이 문단 안에서 칠할 글자 범위. 없으면 -1. */
  from: number; to: number
  fontSize: number; onPick: (index: number) => void
}) {
  return <button data-testid="reader-paragraph" data-index={index}
    onClick={() => onPick(index)}
    aria-current={reading ? 'true' : chosen ? 'location' : undefined}
    data-reading={reading ? '1' : '0'}
    title={reading ? '지금 읽고 있는 곳입니다' : '이 문단을 낭독 시작 위치로 선택'}
    style={{ display: 'block', width: '100%', textAlign: 'left', fontFamily: 'inherit', fontSize, lineHeight: 1.95, padding: '12px 16px', marginBottom: 8, border: 'none', borderLeft: `2px solid ${reading ? 'var(--cyan)' : chosen ? 'var(--accent-light)' : 'transparent'}`, borderRadius: 7, background: reading ? 'var(--accent-glow)' : 'transparent', color: (reading || chosen) ? 'var(--text-primary)' : 'var(--text-secondary)', cursor: 'pointer', overflowWrap: 'anywhere' }}>
    {from >= 0 && from < to
      ? <>{text.slice(0, from)}<mark data-testid="reader-phrase" style={PHRASE_MARK}>{text.slice(from, to)}</mark>{text.slice(to)}</>
      : text}
  </button>
})

export default function ReaderWorkspace() {
  const { books, active, voice, pick } = useReader()
  const book = books.find(b => b.id === active)
  const bodyRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLElement>(null)
  const voiceButton = useRef<HTMLButtonElement>(null)
  const settingsButton = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  /** 참조 목소리를 준비하는 중이면 그 한 줄. 비면 준비 중이 아니다. */
  const [prep, setPrep] = useState('')
  const [dragging, setDragging] = useState(false)
  /** 읽기 설정(글자 크기·괄호 속 한자·따라가기). ★목소리는 따로 고른다(2026-10-01 — 한 창에 섞여 있었다). */
  const [settings, setSettings] = useState(false)
  /** 목소리 고르기 — 음성 합성과 같은 창(VoicePicker). */
  const [picking, setPicking] = useState(false)
  // ★책 목록은 **서재 팝업**에 모은다 (2026-09-30 지시: 불러올수록 화면이 차고 본문이 오른쪽으로 쏠린다).
  const [library, setLibrary] = useState(false)
  /** 설치된 기본 목소리. ★표시값이 아니라 **본체가 확인한 것**이다(인수인계 1항). */
  const [builtins, setBuiltins] = useState<BuiltinVoiceRef[] | null>(null)
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
    setPrefs((cur) => ({ ...cur, ...patch }))
  }
  // 바꾼 뒤 멎으면 한 번 쓴다 — 글자 크기를 끄는 동안 설정 파일을 수십 번 쓰지 않는다.
  useEffect(() => {
    if (!prefsTouched.current) return
    const t = setTimeout(() => {
      void window.api.settings.set(READER_PREFS_STORAGE_KEY, prefs)
        .then((r: { ok?: boolean } | undefined) => { if (r && r.ok === false) setError('낭독 설정을 저장하지 못했습니다 — 다시 켜면 예전 값으로 돌아갑니다.') })
        .catch(() => setError('낭독 설정을 저장하지 못했습니다 — 다시 켜면 예전 값으로 돌아갑니다.'))
    }, 250)
    return () => clearTimeout(t)
  }, [prefs])
  const fontSize = prefs.fontSize
  useEffect(() => {
    void (async () => {
      try {
        const got = await window.api.cards.builtinVoices()
        const list = got?.data?.voices || []
        setBuiltins(list)
        if (!list.length) setVoiceNote('쓸 수 있는 기본 목소리가 없습니다.')
        // 아직 고른 적이 없으면 첫 기본 목소리를 쓴다 — 바로 들을 수 있게.
        // ★골라 둔 기본 목소리가 **목록에서 빠졌으면**(2026-09-30 piper 제거) 첫 기본 목소리로 바꾼다 —
        //   보이지 않는 목소리로 계속 읽지 않는다. 참조 목소리(파일)는 목록과 무관하니 그대로 둔다.
        const listed = (st: { pick: ReaderVoicePick | null }) =>
          st.pick && (st.pick.kind !== 'builtin' || list.some((b: { path: string }) => b.path === st.pick!.path))
        useReader.setState((st) => listed(st) ? st : (list[0]
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
  /**
   * 본문 칸 **안에서만** 굴린다 (2026-09-30 신고: "따라가기가 작동을 안 되는 경우가 많다",
   * "하단의 실행 버튼이 휠에 영향을 받아서 움직인다").
   * ★scrollIntoView 는 바깥 페이지까지 함께 굴려 아래 막대가 움직였고, 두 겹의 부드러운 굴리기가
   *   겹치며 중간에 끊겼다. 본문 칸의 자리만 계산해 옮긴다.
   */
  const scrollInBody = (el: Element | null | undefined, how: 'nearest' | 'center', smooth: boolean) => {
    const box = bodyRef.current
    if (!box || !el) return
    const b = box.getBoundingClientRect(), r = el.getBoundingClientRect()
    if (how === 'nearest' && r.top >= b.top && r.bottom <= b.bottom) return
    const tall = r.height > box.clientHeight * 0.8            // 칸보다 긴 구절은 머리를 맞춘다
    const top = how === 'center' && !tall
      ? box.scrollTop + (r.top - b.top) - (box.clientHeight - r.height) / 2
      : box.scrollTop + (r.top - b.top) - 16
    box.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' })
  }
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
  /**
   * 지금 **소리가 읽고 있는 구절** — 문단 안에서 그 글자만 칠한다. 읽지 않을 때는 없다.
   * ★2026-10-01 이전에는 덩이(약 20초) 전체를 칠했다. 이제 구절(문장 끝·쉼표) 단위로 소리를 따라간다(readerTiming).
   */
  const phrase = read.spot
  // ★멈춰 있을 때는 **고른 자리**에 맞춰 둔다 — 엔진이 그 자리부터 미리 만들어 두어,
  //   누르는 순간 곧바로 들린다(2026-09-29 지시: "읽어오면 빠르게 만들어서").
  // ★오류가 떠 있으면 건드리지 않는다 (2026-09-30 신고: "붉은색으로 경로가 빠르게 보였다 사라진다").
  //   멈추자마자 자리를 맞추면서 오류 문구까지 지워, 무엇이 틀렸는지 읽을 수 없었다.
  const { playing: readPlaying, seekToChar, fault: readFault } = read
  useEffect(() => {
    if (!readPlaying && !readFault) seekToChar(charOfParagraph[position] ?? 0)
  }, [readPlaying, readFault, seekToChar, position, charOfParagraph])
  /** 지금 **실제로 읽고 있는** 문단. 사용자가 고른 자리와 다르다(인수인계 5항). */
  /** 원문 글자 자리 → 문단 번호(나눠 찾기). */
  const paragraphOfChar = useCallback((c: number) => {
    let lo = 0, hi = charOfParagraph.length - 1, idx = 0
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (charOfParagraph[mid] <= c) { idx = mid; lo = mid + 1 } else hi = mid - 1 }
    return idx
  }, [charOfParagraph])
  const readingParagraph = useMemo(() => {
    const start = phrase?.start ?? read.chunks[read.at]?.start ?? -1
    return start < 0 ? -1 : paragraphOfChar(start)
  }, [phrase?.start, read.chunks, read.at, paragraphOfChar])

  // ── 큰 책은 **보이는 문단만** 그린다(자리 계산은 readerWindow) ─────────────
  // ★3천 문단 이하는 전부 그린다 — 그때는 빨랐고(누름 20ms 실측) 지금까지 검사한 그대로 둔다.
  const paragraphCount = book?.paragraphs.length ?? 0
  const windowed = paragraphCount > WINDOW_FROM
  const [view, setView] = useState({ top: 0, h: 600, w: 640 })
  /** 문단 높이 — 처음엔 글자 수로 어림하고, 그려진 문단은 잰 값으로 바꾼다. 책·글자 크기·너비가 바뀌면 다시 어림한다. */
  const heights = useRef<{ key: string; h: Float64Array }>({ key: '', h: new Float64Array(0) })
  const [measured, setMeasured] = useState(0)
  const heightKey = `${book?.id}|${fontSize}|${Math.round(view.w / 40)}`
  if (windowed && book && heights.current.key !== heightKey) {
    const g = { fontSize, contentWidth: Math.max(120, view.w), lineHeight: 1.95, chrome: 24 + 8 }
    const h = new Float64Array(book.paragraphs.length)
    book.paragraphs.forEach((p, i) => { h[i] = estimateHeight(p.length, g) })
    heights.current = { key: heightKey, h }
  }
  const offsets = useMemo(() => windowed ? offsetsOf(heights.current.h) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [windowed, heightKey, measured])
  const range = offsets ? visibleRange(offsets, view.top, view.h) : { start: 0, end: paragraphCount }
  // 본문 칸의 크기·굴린 자리를 따라간다(창을 쓸 때만). 글 너비 = 칸 너비 − 좌우 여백 − 문단 안쪽 여백·테두리.
  useEffect(() => {
    const box = bodyRef.current
    if (!box || !windowed) return
    const sync = () => {
      const cs = getComputedStyle(box)
      const w = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 34
      setView({ top: box.scrollTop, h: box.clientHeight, w })
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(box)
    return () => ro.disconnect()
  }, [windowed, book?.id])
  // ★본문 칸 높이를 **아래 막대 위 남은 자리**에 맞춘다 (2026-10-01 · MCP 로 잼).
  //   예전엔 높이가 고정(58vh)이라 아래 막대가 본문 아래쪽을 가렸다 — 1280×860 에서 6px, 1000×720 에서 64px, 800×600 에서 136px(본문의 40%).
  //   낭독은 **본문 칸 안에서** 읽는 자리를 옮기므로, 가려진 곳에 읽는 구절이 설 수 있었다. 창·막대 크기가 바뀌면 다시 잰다.
  const [bodyHeight, setBodyHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    const box = bodyRef.current, foot = footerRef.current
    if (!box || !foot) return
    const scroller = box.closest('[data-testid="workspace-content"]') as HTMLElement | null
    const fit = () => {
      const view = scroller ? scroller.getBoundingClientRect() : { top: 0, height: window.innerHeight }
      const scrolled = scroller ? scroller.scrollTop : 0
      const topInContent = box.getBoundingClientRect().top - view.top + scrolled   // 굴림과 무관한 자리
      const avail = view.height - topInContent - foot.offsetHeight - 16
      // 최소 180px — 최소 창(800×600)에서 남는 자리가 196px 였다. 가리는 것보다 작은 칸이 낫다.
      setBodyHeight((h) => { const next = Math.max(180, Math.min(900, Math.round(avail))); return h === next ? h : next })
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(foot)
    if (scroller) ro.observe(scroller)
    window.addEventListener('resize', fit)
    return () => { ro.disconnect(); window.removeEventListener('resize', fit) }
  }, [book?.id])
  const scrollFrame = useRef(0)
  const onBodyScroll = () => {
    if (scrollFrame.current) return
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0
      const box = bodyRef.current
      if (box) setView((v) => (v.top === box.scrollTop ? v : { ...v, top: box.scrollTop }))
    })
  }
  /**
   * 문단(또는 읽는 구절)을 본문 칸에 보이게 한다. **아직 그려지지 않은 문단**이면 어림 자리로 먼저 굴리고,
   * 그려진 뒤 실제 자리로 맞춘다(`pendingReveal`).
   */
  const pendingReveal = useRef<{ index: number; how: 'nearest' | 'center'; phrase: boolean } | null>(null)
  const findTarget = (index: number, phrase: boolean) => bodyRef.current?.querySelector(
    phrase ? '[data-testid="reader-phrase"]' : `[data-index="${index}"]`)
  const reveal = (index: number, how: 'nearest' | 'center', smooth: boolean, phrase: boolean) => {
    const box = bodyRef.current
    if (!box || index < 0) return
    const el = findTarget(index, phrase)
    if (el || !offsets) { pendingReveal.current = null; scrollInBody(el, how, smooth); return }
    box.scrollTop = scrollTopFor(offsets, index, box.clientHeight, 'center')
    pendingReveal.current = { index, how: 'center', phrase }
    setView((v) => ({ ...v, top: box.scrollTop }))
  }
  // 그린 뒤 — 문단 높이를 재고, 기다리던 '보이게 하기' 를 실제 자리로 맞춘다.
  useLayoutEffect(() => {
    if (!windowed) return
    const box = bodyRef.current
    if (!box) return
    const h = heights.current.h
    let changed = false
    box.querySelectorAll<HTMLElement>('[data-index]').forEach((el) => {
      const i = Number(el.dataset.index)
      const m = el.offsetHeight + 8                          // 아래 간격(marginBottom) 포함
      if (i < h.length && Math.abs(h[i] - m) > 1) { h[i] = m; changed = true }
    })
    if (changed) setMeasured((v) => v + 1)
    const want = pendingReveal.current
    if (want) {
      const el = findTarget(want.index, want.phrase)
      if (el) { pendingReveal.current = null; scrollInBody(el, want.how, false) }
    }
  })
  useEffect(() => { reveal(position, 'nearest', false, false) }, [active, position])
  /**
   * ★읽는 **줄**을 화면이 따라간다 (2026-10-01 사용자 신고: "소리가 읽어 주는 뷰어상의 텍스트 줄바꿈에 맞춰서
   *   따라가길 원했는데, 생성된 음원의 처음에 서 있다가 다음 음원의 처음 부분에 쭉 서 있는 것 같다").
   *   예전에는 덩이가 넘어갈 때만(약 20초마다) 옮겼다. 이제 매 화면마다 **소리가 닿은 글자**(read.caret)의 줄을 찾아,
   *   그 줄을 본문 칸 위에서 35% 자리에 둔다 — 줄이 바뀔 때마다 한 줄만큼 부드럽게 올라간다(노래방 자막처럼).
   *   ★처음엔 '읽기 띠(18~60%) 밖으로 나가면 옮기기' 로 만들었다가, 한 문단을 다 읽도록 가만히 있어 줄을 따라가지 않았다(검사로 확인).
   * ★사용자가 휠·손가락·키로 굴리면 3초 동안 따라가지 않는다 — 앞뒤를 둘러보는 중에 끌어당기지 않는다.
   * 끄면 그대로 둔다.
   */
  const userScrolledAt = useRef(0)
  const revealRef = useRef(reveal); revealRef.current = reveal
  useEffect(() => {
    if (!read.playing || !prefs.follow) return
    const calm = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const range = document.createRange()
    let raf = 0, movedAt = 0, lastPara = -1
    const lineAt = (el: Element, offset: number): { y: number; h: number } | null => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let left = offset
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const len = n.textContent?.length ?? 0
        if (left < len) {
          range.setStart(n, left); range.setEnd(n, Math.min(len, left + 1))
          const r = range.getClientRects()[0] || range.getBoundingClientRect()
          return r.height ? { y: r.top + r.height / 2, h: r.height } : null
        }
        left -= len
      }
      return null
    }
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const now = performance.now()
      if (now - userScrolledAt.current < 3000 || now - movedAt < 280) return
      const box = bodyRef.current
      const c = read.caret()
      if (!box || c < 0) return
      const para = paragraphOfChar(c)
      const el = box.querySelector(`[data-index="${para}"]`)
      if (!el) {
        // 아직 그리지 않은 문단(큰 책) — 어림 자리로 먼저 옮기면 그려진 뒤 다음 화면에서 줄을 맞춘다.
        if (para !== lastPara) { lastPara = para; movedAt = now; revealRef.current(para, 'center', false, false) }
        return
      }
      lastPara = para
      const line = lineAt(el, Math.max(0, c - (charOfParagraph[para] ?? 0)))
      if (!line) return
      const b = box.getBoundingClientRect()
      const off = line.y - b.top - b.height * 0.35
      // 같은 줄 안에서는 움직이지 않는다(글자가 옮겨 가도 줄은 그대로다). 칸 끝에 닿으면 더 굴릴 수 없다.
      if (Math.abs(off) < Math.max(10, line.h * 0.6)) return
      const top = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, box.scrollTop + off))
      if (Math.abs(top - box.scrollTop) < 2) return
      movedAt = now
      box.scrollTo({ top, behavior: calm ? 'auto' : 'smooth' })
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [read.playing, prefs.follow, book?.id, paragraphOfChar, charOfParagraph, read.caret])
  const markUserScroll = () => { userScrolledAt.current = performance.now() }

  const closeSettings = () => { setSettings(false); settingsButton.current?.focus() }
  /**
   * 목소리 **들어 보기** — 같은 **책 읽는 문장**으로 (2026-09-30 지시: "하나씩 사용자가 들어 보고 선택하게").
   * 낭독 통로를 그대로 타서 한 번 만든 것은 쌓아 두고, 다시 들을 때는 곧바로 나온다.
   * ★재생·상태는 음성 합성과 같은 미리듣기(voicePreview)가 맡는다 — 만드는 길만 낭독 것이다.
   */
  const previewMaker: PreviewMaker = async (path, engineId) => {
    if (read.playing) read.stop()                 // 두 소리가 겹치지 않게
    useAppStore.getState().claimAudio('reader')
    const v: ReaderVoicePick = { kind: 'builtin', path, engineId, label: '' }
    const t0 = Date.now()
    const name = builtins?.find((b) => b.path === path)?.label || nameOnly(path)
    const r = await window.api.reader.speak(SAMPLE_TEXT, { kind: 'builtin', path, engineId }, voiceKeyOf(v))
    if (r.error || !r.data?.path) {
      opLog('reader', `들어 보기 실패 — ${name}: ${r.error || '만들지 못함'}`, 'WARN')
      throw new Error(r.error || '들어 볼 소리를 만들지 못했습니다')
    }
    opLog('reader', `들어 보기 — ${name}${r.data.cached ? ' (쌓아 둔 것)' : ` · ${((Date.now() - t0) / 1000).toFixed(1)}s`}`)
    return r.data.path
  }
  /** 기본 목소리를 쓴다. GPU 목소리(소희)는 고르는 순간 미리 연다 — 첫 소리의 모델 열기(약 10초)를 누르기 전에 치른다. */
  const chooseBuiltin = (b: BuiltinVoiceRef) => {
    const v: ReaderVoicePick = { kind: 'builtin', path: b.path, engineId: b.engineId, label: b.label }
    useReader.setState({ voice: b.label, pick: v })
    if (b.engineId === 'qwen-custom') void window.api.reader.warm?.({ kind: 'builtin', path: b.path, engineId: b.engineId })?.catch(() => { /* 누를 때 연다 */ })
    voiceButton.current?.focus()
  }
  const choosePosition = (value: number) => {
    if (!book) return
    useReader.setState(s => ({ books: s.books.map(b => b.id === book.id ? { ...b, position: Math.max(0, Math.min(value, b.paragraphs.length - 1)) } : b) }))
  }
  // 문단 누름 — 줄마다 같은 함수를 받아야 바뀌지 않은 줄이 다시 그려지지 않는다. 최신 상태는 ref 로 읽는다.
  const pickRef = useRef<(i: number) => void>(() => {})
  pickRef.current = (i: number) => { choosePosition(i); if (read.playing) read.seekToChar(charOfParagraph[i] ?? 0) }
  const pickParagraph = useCallback((i: number) => pickRef.current(i), [])
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
  /**
   * 음성 파일에서 목소리를 고른다 — **준비를 거친 조각**으로 읽는다.
   *
   * ★원본을 그대로 넘기면 파이썬이 파일 전체를 받아 적어 목소리를 따라 하는데, 그 전사가 소리와
   *   어긋나면 모델이 끝맺지 못하고 생성 상한까지 말을 이어 갔다 (2026-09-30 사용자 로그 2회:
   *   125자에 필요한 양 약 160토큰을 넘겨 256 에서 멈춤, 79초). 생성 카드·더빙은 3~10초의 깨끗한
   *   구간을 골라 잘라 쓴다 — 낭독도 **같은 준비 실행기**를 쓴다. 상한을 없애는 것은 답이 아니다.
   */
  const pickVoiceFile = async () => {
    const at = await window.api.audio.selectFile(false, 'voice')
    if (typeof at !== 'string' || !at) return      // 취소
    const label = nameOnly(at)
    setError('')
    // ★준비도 파이썬을 띄운다 — 낭독이 참조 목소리로 만들던 것과 겹치면 공용 판정이 거절한다.
    //   읽기를 멈추고, 만들던 부분까지 마치기를 기다린 뒤 준비한다(거절 대신 기다림).
    if (read.playing) read.stop()
    setPrep('읽던 부분을 마치는 중입니다…')
    await window.api.reader.idle?.()
    setPrep('목소리를 살펴보는 중입니다…')
    opLog('reader', `참조 목소리 준비 시작 — ${label}`)
    let clip = ''
    let said = ''
    const outcome = await runVoicePrep({
      clipKey: 'reader', path: at, reqId: `reader-${Date.now()}`,
      engine: 'auto', refTargetSec: 0, plain: true,
      committedNow: () => null,
      report: (p) => {
        if (p.phase === 'ready') clip = p.clip ?? ''
        if (p.message) { said = p.message; setPrep(p.message) }
      },
    })
    setPrep('')
    if (outcome === 'ready') {
      // 조각이 비면 원본이 그대로 쓸 만하다는 뜻이다(3~10초 · 품질 통과).
      useReader.setState({ voice: label, pick: { kind: 'reference', path: clip || at, label } })
      // 다음에 목소리 고르기에서 다시 고를 수 있게 — 준비를 다시 하지 않는다.
      updatePrefs({ recentVoices: rememberVoice(prefs.recentVoices, { path: clip || at, label }) })
      opLog('reader', `참조 목소리 준비됨 — ${label} · ${clip ? '구간을 잘라 씀' : '원본 그대로'}`)
      return
    }
    const why = outcome === 'needs_region'
      ? '이 파일은 쓸 구간을 스스로 고르지 못했습니다 — 3~10초짜리 깨끗한 말소리 파일을 고르거나, 생성 카드에서 구간을 정한 목소리를 쓰세요.'
      : outcome === 'failed' ? (said || '이 파일에서 목소리를 준비하지 못했습니다 — 다른 파일을 골라 주세요.')
      : ''
    if (why) { setError(why); opLog('reader', `참조 목소리 준비 안 됨(${outcome}) — ${label}: ${why}`, 'WARN') }
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
          // ★UTF-8 · UTF-16 · CP949(EUC-KR) 를 알아서 읽는다 — 다시 저장하라고 떠넘기지 않는다(readerDecode).
          const got = decodeBookText(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
          if (!got) { rejected.push(`${file.name}: 글자 방식을 알아보지 못했습니다(UTF-8 · UTF-16 · CP949 만 읽습니다)`); continue }
          if (got.encoding !== 'utf-8') opLog('reader', `글 파일 ${nameOnly(file.name)} — ${encodingLabel(got.encoding)} 로 읽음`)
          const text = got.text
          const paragraphs = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(p => p.trim()).filter(Boolean)
          if (!paragraphs.length) { rejected.push(`${file.name}: 내용 없음`); continue }
          added.push({ id: crypto.randomUUID(), name: file.name.replace(/\.txt$/i, ''), paragraphs, position: 0 })
        } catch { rejected.push(`${file.name}: 읽지 못했습니다`) }
      }
      if (added.length) {
        useReader.setState(s => ({ books: [...s.books, ...added], active: s.active || added[0].id }))
        // ★새 책은 **곧바로** 저장한다 (2026-10-01 · MCP 로 찾음). 저장은 '열려 있는 책' 이 바뀔 때만 일어나서, 다른 책을 연 채
        //   더한 책은 한 번도 저장되지 않고 다시 켜면 사라졌다(두 권 중 한 권만 남음 — 재현). "껐다 켜도 남습니다" 가 거짓이었다.
        //   다른 책은 건드리지 않는다 — 이 책 파일만 쓴다.
        for (const b of added) void window.api.works.write('books', b.id, b).catch(() => { /* 열 때 다시 쓴다 */ })
      }
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
  const progress = book ? `${position + 1} / ${book.paragraphs.length} 문단` : ''
  const iconButton: CSSProperties = { ...kitButton, padding: 8, minWidth: 36 }
  return <section data-testid="reader-workspace" aria-label="낭독 작업실" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <button style={kitButton} data-testid="reader-library" aria-haspopup="dialog"
        onClick={() => setLibrary(true)} title="서재 — 불러온 책을 모아 둔 곳"><Icon name="book"/>서재{books.length ? ` ${books.length}` : ''}</button>
      <button style={kitButton} onClick={() => { void pickTexts() }} disabled={loading} data-testid="reader-add-text"><Icon name="plus"/>텍스트 추가</button>
      <span data-testid="reader-notice"
        title="책과 읽던 자리는 앱을 껐다 켜도 남습니다. 목록에서 빼면 그 기록만 지워지고 원본 파일은 그대로입니다. 목소리를 바꾸면 만들어 둔 소리는 버리고 다시 만듭니다."
        style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
        {read.playing ? '읽는 중' : books.length ? `책 ${books.length}권` : ''}
      </span>
    </div>
    {error && <div role="alert" style={{ color: 'var(--rose, #fb7185)', fontSize: 12 }}>{error}</div>}
    <div onDragOver={e => { e.preventDefault(); setDragging(true) }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }} onDrop={e => { e.preventDefault(); setDragging(false); dropTexts(Array.from(e.dataTransfer.files)) }} style={{ display: 'flex', gap: 16, flexWrap: 'wrap', outline: dragging ? '2px solid var(--accent-light)' : undefined, borderRadius: 14 }}>
      <article style={{ ...panel, flex: '4 1 340px', minWidth: 0, overflow: 'hidden' }}>
        {!book ? <button onClick={() => { void pickTexts() }} disabled={loading} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, width: 'calc(100% - 32px)', minHeight: 330, margin: 16, border: '1px dashed var(--border-accent)', borderRadius: 12, background: 'var(--bg-base)', color: 'var(--text-primary)', fontFamily: 'inherit', cursor: 'pointer' }}>
          <span style={{ color: 'var(--accent-light)', padding: 17, borderRadius: 14, background: 'var(--accent-glow)' }}><BookIcon /></span>
          <strong style={{ fontSize: 17 }}>{loading ? '책을 불러오는 중' : '읽고 싶은 글을 가져오세요'}</strong>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>끌어 놓거나 클릭해서 선택</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>TXT · 여러 파일</span>
        </button> : <>
          <header style={{ padding: '16px 24px', display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 10, borderBottom: '1px solid var(--border-subtle)' }}>
            <h2 style={{ margin: 0, fontSize: 17, flex: 1, overflowWrap: 'anywhere' }}>{book.name}</h2>
            <span style={muted}>{progress}</span>
          </header>
          <div ref={bodyRef} data-testid="reader-body" aria-label="책 본문" data-windowed={windowed ? '1' : '0'}
            onScroll={windowed ? onBodyScroll : undefined} onWheel={markUserScroll} onTouchMove={markUserScroll}
            onKeyDown={e => { if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key)) markUserScroll() }}
            style={{ height: bodyHeight ?? 'clamp(320px, 58vh, 900px)', overflowY: 'auto', overscrollBehavior: 'contain', padding: '22px clamp(12px, 3vw, 32px)', background: 'var(--bg-base)' }}>
            {/* ★고른 자리와 **읽는 자리**를 구분해 보인다(인수인계 5항).
                누른 곳은 '여기서 시작' 이고, 색이 찬 곳은 '지금 읽는 중' 이다. */}
            {offsets && <div aria-hidden="true" style={{ height: offsets[range.start] }} />}
            {book.paragraphs.slice(range.start, range.end).map((p, k) => {
              const i = range.start + k
              const at = charOfParagraph[i] ?? 0
              // 이 문단 안에서 칠할 몫 — 걸치지 않는 문단은 늘 -1 이라 다시 그려지지 않는다.
              const from = phrase ? Math.max(at, phrase.start) - at : -1
              const to = phrase ? Math.min(at + p.length, phrase.end) - at : -1
              const hit = from >= 0 && from < to
              return <ReaderParagraph key={`${book.id}-${i}`} text={p} index={i}
                chosen={i === position} reading={read.playing && i === readingParagraph}
                from={hit ? from : -1} to={hit ? to : -1} fontSize={fontSize} onPick={pickParagraph} />
            })}
            {offsets && <div aria-hidden="true" style={{ height: offsets[paragraphCount] - offsets[range.end] }} />}
          </div>
        </>}
      </article>
    </div>
    {/* ★아래 막대는 **움직이지 않는다** (2026-09-30 신고: 낭독을 위한 작동 단추가 휠에 영향을 받으면 안 된다).
        자리(2026-10-01 정리): 왼쪽 = 목소리 · 가운데 = 이전/재생/다음 · 오른쪽 = 상태 · 따라가기 · 빠르기 · 설정. */}
    <footer ref={footerRef} data-testid="reader-controls" style={{ ...panel, position: 'sticky', bottom: 0, zIndex: 20, boxShadow: '0 -8px 20px #0006', padding: '12px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)', alignItems: 'center', gap: 8 }}>
      <button ref={voiceButton} data-testid="reader-voice" aria-haspopup="dialog" onClick={() => setPicking(true)} disabled={!!prep}
        title={prep ? '목소리를 준비하는 중입니다' : '목소리 고르기'}
        style={{ ...kitButton, justifyContent: 'flex-start', minWidth: 0, padding: '6px 10px', textAlign: 'left' }}>
        <Icon name="voice"/>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)' }}>목소리</span>
          <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>{prep ? '준비 중…' : voice}</span>
        </span>
      </button>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
        <button style={iconButton} aria-label="이전 문단" disabled={!book || position === 0} title={!book ? '책을 먼저 여세요' : position === 0 ? '첫 문단입니다' : '이전 문단'} onClick={() => choosePosition(position - 1)}><Icon name="prev"/></button>
        <button data-testid="reader-play" aria-label={read.playing ? '낭독 멈추기' : '낭독 시작'}
          disabled={!book || !pick || !!prep}
          title={!book ? '먼저 책을 고르세요' : !pick ? '먼저 목소리를 고르세요' : prep ? '목소리를 준비하는 중입니다' : read.playing ? '멈춥니다' : '이 자리부터 읽습니다'}
          onClick={() => {
            if (read.playing) { read.stop(); return }
            // 고른 문단부터 읽는다 — '시작 위치' 와 '읽는 자리' 는 다른 것이다(인수인계 5항).
            read.seekToChar(charOfParagraph[position] ?? 0)
            read.start()
          }}
          style={{ ...kitButton, width: 46, height: 46, borderRadius: '50%', padding: 0, color: 'var(--accent-light)', background: 'var(--accent-glow)', cursor: (!book || !pick) ? 'not-allowed' : 'pointer' }}>
          <Icon name={read.playing ? 'stop' : 'play'} size={20}/>
        </button>
        <button style={iconButton} aria-label="다음 문단" disabled={!book || position >= book.paragraphs.length - 1} title={!book ? '책을 먼저 여세요' : position >= book.paragraphs.length - 1 ? '마지막 문단입니다' : '다음 문단'} onClick={() => choosePosition(position + 1)}><Icon name="next"/></button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
        <span data-testid="reader-state" style={{ flex: '1 1 110px', textAlign: 'right', fontSize: 12, color: read.fault ? 'var(--rose, #fb7185)' : 'var(--text-muted)', overflowWrap: 'anywhere' }}>
          {read.fault || prep || read.wait || (book ? progress : '책을 선택하세요')}
        </span>
        <button data-testid="reader-follow" aria-pressed={prefs.follow} title={prefs.follow ? '읽는 줄을 화면이 따라갑니다 — 누르면 멈춥니다' : '누르면 읽는 줄을 화면이 따라갑니다'}
          onClick={() => updatePrefs({ follow: !prefs.follow })}
          style={{ ...kitButton, color: prefs.follow ? 'var(--cyan)' : 'var(--text-muted)', borderColor: prefs.follow ? 'var(--cyan)' : undefined }}><Icon name="follow"/>따라가기</button>
        {/* ★듣는 빠르기 — 만든 소리를 다시 만들지 않고 빠르게/느리게 듣는다(2026-09-30 지시). 낭독 전용. */}
        <PlaybackRateSelect testId="reader-rate" />
        <button ref={settingsButton} data-testid="reader-settings" aria-haspopup="dialog" aria-label="읽기 설정" title="읽기 설정 — 글자 크기 · 괄호 속 한자 · 따라가기"
          onClick={() => setSettings(true)} style={iconButton}><Icon name="settings"/></button>
      </div>
    </footer>
    {picking && <VoicePicker close={() => setPicking(false)} builtins={builtins} why={voiceNote}
      current={pick} onChoose={chooseBuiltin} onFile={() => { void pickVoiceFile() }}
      recent={prefs.recentVoices}
      onRecent={(r) => {
        useReader.setState({ voice: r.label, pick: { kind: 'reference', path: r.path, label: r.label } })
        updatePrefs({ recentVoices: rememberVoice(prefs.recentVoices, r) })
      }}
      confirmLabel="이 목소리로 읽기" fileLabel="음성·영상 파일에서 목소리 만들기" make={previewMaker} disabled={!!prep}
      ids={{ chip: 'reader-voice-builtin', confirm: 'reader-voice-confirm', file: 'reader-voice-file', preview: 'reader-voice-try', recent: 'reader-voice-recent' }}/>}
    {settings && <Modal title="읽기 설정" close={closeSettings}>
      <div data-testid="reader-settings-dialog" style={{ display: 'grid', gap: 20 }}>
        <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
          <span>글자 크기 <span style={{ color: 'var(--text-muted)' }}>{prefs.fontSize}px</span></span>
          <input data-testid="reader-font-size" type="range" min={READER_FONT_MIN} max={READER_FONT_MAX} step={1}
            value={prefs.fontSize} onChange={e => updatePrefs({ fontSize: Number(e.target.value) })} />
        </label>
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
          <input data-testid="reader-skip-hanja" type="checkbox" checked={prefs.skipHanjaInParens}
            onChange={e => updatePrefs({ skipHanjaInParens: e.target.checked })} style={{ marginTop: 3 }} />
          <span>괄호 속 한자는 읽지 않기
            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>예: 학교(學校) → "학교" 만 읽습니다. 본문에는 그대로 보입니다.</span>
          </span>
        </label>
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
          <input data-testid="reader-follow-setting" type="checkbox" checked={prefs.follow}
            onChange={e => updatePrefs({ follow: e.target.checked })} style={{ marginTop: 3 }} />
          <span>읽는 줄 따라가기
            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>소리가 읽는 줄을 본문 위쪽 3분의 1 자리에 두고, 줄이 바뀔 때마다 한 줄씩 올립니다. 직접 굴리면 3초 동안 쉽니다.</span>
          </span>
        </label>
      </div>
    </Modal>}
    {library && <Modal title="서재" subtitle={books.length ? `${books.length}권` : undefined} close={() => setLibrary(false)}>
      <div data-testid="reader-library-dialog" style={{ display: 'grid', gap: 10 }}>
        <button style={{ ...kitButton, justifySelf: 'start' }} disabled={loading} onClick={() => { setLibrary(false); void pickTexts() }}><Icon name="plus"/>텍스트 추가</button>
        {!books.length && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>아직 불러온 책이 없습니다. 끌어 놓거나 '텍스트 추가' 로 가져오세요.</span>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {books.map((b, i) => <div key={b.id} style={{ display: 'flex', gap: 4, borderRadius: 9, background: active === b.id ? 'var(--accent-glow)' : 'transparent' }}>
            <button data-testid="reader-library-book" onClick={() => { useReader.setState({ active: b.id }); setLibrary(false) }} aria-current={active === b.id ? 'true' : undefined}
              style={{ ...button, flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{String(i + 1).padStart(2, '0')}</span>{b.name}
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 5 }}>{b.position + 1} / {b.paragraphs.length} 문단</span>
            </button>
            <button aria-label={`${b.name} 목록에서 빼기`} title="목록에서 빼기 · 원본 파일은 유지" onClick={() => removeBook(b.id)}
              style={{ ...iconButton, background: 'transparent', border: 'none', alignSelf: 'flex-start' }}><Icon name="close"/></button>
          </div>)}
        </div>
      </div>
    </Modal>}
  </section>
}
