import { useReaderFollow } from '../hooks/useReaderFollow'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { create } from 'zustand'
import { useReadAloud, voiceKeyOf, type ReaderVoicePick } from '@/hooks/useReadAloud'
import { useAppStore } from '@/stores/app.store'
import { Icon, Modal, button as kitButton, muted, field as kitField, primary as kitPrimary } from './kit'
import { classifyIncoming, mapPosition, moveInGroup, pushHistory, suggestGroupName, sortGroup, naturalCompare, samePath, planDrop, type LibBook, type ScanResult, type ScanFile, type BookSource } from '../../shared/readerLibrary'
import VoicePicker from './VoicePicker'
import ReaderShelf from './ReaderShelf'
import './reader.css'
import type { PreviewMaker } from '../lib/voicePreview'
import { runVoicePrep } from '@/lib/voicePrepRunner'
import { opLog, nameOnly } from '@/lib/opLog'
import { trace } from '@/lib/readerTrace'
import { chunkAt, TEXT_FILE_LIMIT } from '../../shared/readerChunks'
import { decodeBookText, encodingLabel } from '../../shared/readerDecode'
import PlaybackRateSelect from './PlaybackRateSelect'
import SpeakerControl from './SpeakerControl'
import { WINDOW_FROM, estimateHeight, offsetsOf, visibleRange, scrollTopFor } from '../../shared/readerWindow'
import { bookSaver, prefsSaver, PREFS_KEY } from '../lib/readerSaves'
import { DEFAULT_READER_PREFS, parseReaderPrefs, rememberVoice, READER_PREFS_STORAGE_KEY, READER_FONT_MAX, READER_FONT_MIN, type ReaderPrefs, type SavedReaderVoice } from '../../shared/readerText'
import type { BuiltinVoiceRef } from '../../shared/synthesisCardVoice'
import { groupVoices } from '../../shared/voiceGroups'

/** 들어 보기 문장 — 책 읽는 문장이어야 낭독 목소리를 고를 수 있다. */
const SAMPLE_TEXT = '그는 천천히 문을 열고 어두운 복도를 내다보았다. 멀리서 물이 떨어지는 소리만 일정하게 이어졌다.'
// 낭독 화면. 합성은 `useReadAloud`, 책·자리 보관은 `works/books`, 파일 고르기는 본체 대화상자가 맡는다.
type Book = LibBook
/** 글 → 문단(빈 줄 빼고). 파일 가져오기와 폴더 가져오기가 같은 규칙. */
const toParagraphs = (text: string): string[] => text.replace(/^\uFEFF/, '').split(/\r?\n/).map(p => p.trim()).filter(Boolean)
/** 원본 바이트의 지문(sha256) — 같은 책 판정에 쓴다. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))      // 복사본 — IPC 로 받은 버퍼가 공유 버퍼일 수 있다
  return Array.from(new Uint8Array(d), x => x.toString(16).padStart(2, '0')).join('')
}
/** 폴더에서 가져올 글 하나. */
type ImportItem = { path: string; name: string; group?: string; order?: number; root?: string; coverPath?: string }
/** 건너뛴 것 한 줄 — 개수만. */
const skippedText = (s: ScanResult): string => [s.unsupported ? `지원하지 않는 형식 ${s.unsupported}` : '', s.tooLarge ? `10MB 초과 ${s.tooLarge}` : '',
  s.links ? `연결 ${s.links}` : '', s.missing.length ? `열 수 없는 자리 ${s.missing.length}` : '', s.truncated ? '너무 많아 일부만' : ''].filter(Boolean).join(' · ')
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

/** 저장본의 목소리 지정 → 낭독이 쓰는 지정. 기본 목소리는 경로 없이(목록에서 찾기 전까지) — 경로가 아니라 엔진 + 모델 이름으로 저장돼 있다. */
function pickOfSaved(v: SavedReaderVoice): ReaderVoicePick {
  return v.kind === 'builtin'
    ? { kind: 'builtin', path: '', engineId: v.engineId, modelId: v.modelId, label: v.label }
    : { kind: 'reference', path: v.path, label: v.label }
}

export default function ReaderWorkspace() {
  const { books, active, voice, pick } = useReader()
  const book = books.find(b => b.id === active)
  const bodyRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLElement>(null)
  const voiceButton = useRef<HTMLButtonElement>(null)
  const settingsButton = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [removedBooks, setRemovedBooks] = useState<Book[]>([])
  const changingBooks = useRef(false)
  /** 참조 목소리를 준비하는 중이면 그 한 줄. 비면 준비 중이 아니다. */
  const [prep, setPrep] = useState('')
  const [dragging, setDragging] = useState(false)
  /** 읽기 설정(글자 크기·괄호 속 한자·따라가기). ★목소리는 따로 고른다(2026-10-01 — 한 창에 섞여 있었다). */
  const [settings, setSettings] = useState(false)
  /** 목소리 고르기 — 음성 합성과 같은 창(VoicePicker). */
  const [picking, setPicking] = useState(false)
  // ★책 목록은 **서재 팝업**에 모은다 (2026-09-30 지시: 불러올수록 화면이 차고 본문이 오른쪽으로 쏠린다).
  const [library, setLibrary] = useState(true)
  const shelfScroll = useRef<HTMLDivElement>(null)
  const shelfScrollTop = useRef(0)
  const [shelfTarget, setShelfTarget] = useState<{ name: string; key: number } | null>(null)
  const [pendingPlayback, setPendingPlayback] = useState<string | null>(null)
  const completedRef = useRef<(id: string) => void>(() => {})
  useLayoutEffect(() => { if (library && shelfScroll.current) shelfScroll.current.scrollTop = shelfScrollTop.current }, [library])
  const [finding, setFinding] = useState(false)
  const [findText, setFindText] = useState('')
  const [seekPosition, setSeekPosition] = useState<number | null>(null)
  useEffect(() => {
    setSeekPosition(null)
    bodyRef.current?.closest('[data-testid="workspace-content"]')?.scrollTo({ top: 0 })
  }, [library, active])
  /** 설치된 기본 목소리. ★표시값이 아니라 **본체가 확인한 것**이다(인수인계 1항). */
  const [builtins, setBuiltins] = useState<BuiltinVoiceRef[] | null>(null)
  const [voiceNote, setVoiceNote] = useState('')
  /**
   * 낭독 설정 — 따라가기·괄호 속 한자. **껐다 켜도 남는다**(설정 파일 한 칸).
   * ★읽기 전에 바꾼 값을 읽어 온 값이 덮지 않게 한다.
   */
  const [prefs, setPrefs] = useState<ReaderPrefs>(DEFAULT_READER_PREFS)
  const prefsTouched = useRef(false)
  /** 저장된 설정을 읽었는가 — 읽기 전에는 첫 기본 목소리를 정하지 않는다(저장된 목소리를 덮지 않게). */
  const [prefsLoaded, setPrefsLoaded] = useState(false)
  useEffect(() => {
    void (async () => {
      try {
        // ★지난 방문에서 아직 못 쓴 설정이 있으면 먼저 남긴 뒤 읽는다 — 옛 값을 읽어 와 방금 바꾼 것을 덮지 않게.
        await prefsSaver.flush()
        const all = await window.api.settings.get() as Record<string, unknown>
        const saved = parseReaderPrefs(all?.[READER_PREFS_STORAGE_KEY])
        if (!prefsTouched.current) setPrefs(saved)
        else if (saved.voice) setPrefs((cur) => cur.voice ? cur : { ...cur, voice: saved.voice })      // 읽기 전에 바꾼 값이 저장된 목소리를 지우지 않게
        // ★고른 목소리를 되살린다(2026-10-02 재검수) — 이 실행에서 이미 고른 것이 있으면 그것이 먼저다.
        //   기본 목소리는 경로 없이(목록에서 찾기 전까지) 두고, 파일·모델이 없어도 **다른 목소리로 바꾸지 않는다**(아래 voiceGone).
        if (saved.voice) useReader.setState((st) => st.pick ? st : { voice: saved.voice!.label, pick: pickOfSaved(saved.voice!) })
      } catch { /* 못 읽으면 기본값으로 읽는다 */ } finally { setPrefsLoaded(true) }
    })()
  }, [])
  const updatePrefs = (patch: Partial<ReaderPrefs>) => {
    prefsTouched.current = true
    setPrefs((cur) => ({ ...cur, ...patch }))
  }
  // 바꾼 뒤 멎으면 한 번 쓴다 — 글자 크기를 끄는 동안 설정 파일을 수십 번 쓰지 않는다.
  // ★타이머는 **저장기가 화면 밖에서** 쥔다(2026-10-02 관리자 검수 — 서재 보기를 바꾸고 바로 메뉴를 옮기면 정리 함수가 타이머를 취소해 설정 파일에 null 이 남았다).
  //   값은 쓰는 순간의 최신을 읽는다. 창을 닫는 순간은 저장기가 동기 통로로 남긴다. 실패는 아래 저장 상태 줄이 알린다.
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  useEffect(() => {
    if (!prefsTouched.current) return
    prefsSaver.queue(PREFS_KEY, () => prefsRef.current)
  }, [prefs])
  /** 저장 실패 상태(읽던 자리·설정). 실패를 성공으로 두지 않는다 — 짧은 상태 한 줄과 다시 저장. */
  const [saveFailed, setSaveFailed] = useState({ prefs: false, books: false })
  useEffect(() => {
    const sync = () => setSaveFailed({ prefs: prefsSaver.failed().length > 0, books: bookSaver.failed().length > 0 })
    sync()
    const offs = [prefsSaver.onState(sync), bookSaver.onState(sync)]
    return () => offs.forEach(off => off())
  }, [])
  const saveNote = [saveFailed.books ? '읽던 자리' : '', saveFailed.prefs ? '낭독 설정' : ''].filter(Boolean).join('·')
  const fontSize = prefs.fontSize
  /** 목소리 조회 결과 — 성공(목록 + 건너뛴 사유) / 실패. ★실패는 '그 목소리가 없다' 가 아니다. */
  const [voiceCheck, setVoiceCheck] = useState<{ phase: 'loading' | 'ok' | 'failed'; skipped: Array<{ engineId?: string; why?: string }> }>({ phase: 'loading', skipped: [] })
  const [voiceTick, setVoiceTick] = useState(0)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const got = await window.api.cards.builtinVoices()
        if (!alive) return
        // ★조회가 실패하면 고른 목소리에는 손대지 않는다(2026-10-02 관리자 검수) — 못 읽은 것을 '사라진 것' 으로 취급해 바꾸지 않는다.
        if (got?.error || !got?.data) {
          setBuiltins((prev) => prev ?? []); setVoiceCheck({ phase: 'failed', skipped: [] }); setVoiceNote('기본 목소리를 확인하지 못했습니다.')
          return
        }
        const list = got.data.voices || []
        setBuiltins(list)
        setVoiceCheck({ phase: 'ok', skipped: Array.isArray(got.data.skipped) ? got.data.skipped : [] })
        setVoiceNote(list.length ? '' : '쓸 수 있는 기본 목소리가 없습니다.')
      } catch {
        if (alive) { setBuiltins((prev) => prev ?? []); setVoiceCheck({ phase: 'failed', skipped: [] }); setVoiceNote('기본 목소리를 확인하지 못했습니다.') }
      }
    })()
    return () => { alive = false }
  }, [voiceTick])
  // 목록을 읽고 저장된 설정도 읽은 뒤에만 정한다:
  //  · 고른 기본 목소리 → 엔진 + 모델 이름으로 **지금의 경로**를 찾아 잇는다(경로가 달라져도 같은 목소리). 없으면 그대로 두고 아래 voiceGone 이 상태를 보인다.
  //  · 고른 적이 없다 → 첫 기본 목소리가 기본값(처음 쓰는 사람만). ★이미 고른 목소리는 **다른 것으로 바꾸지 않는다**(2026-10-02).
  useEffect(() => {
    if (!prefsLoaded || voiceCheck.phase !== 'ok' || !builtins?.length) return
    useReader.setState((st) => {
      const p = st.pick
      if (p) {
        if (p.kind !== 'builtin' || !p.modelId) return st
        const b = builtins.find((x) => x.engineId === p.engineId && x.modelId === p.modelId)
        return b && (b.path !== p.path || b.label !== p.label)
          ? { pick: { ...p, path: b.path, label: b.label, engineId: b.engineId }, voice: b.label } : st
      }
      const b = builtins[0]
      return { pick: { kind: 'builtin', path: b.path, engineId: b.engineId, modelId: b.modelId, label: b.label }, voice: b.label }
    })
  }, [prefsLoaded, voiceCheck.phase, builtins])
  /** 고른 '내 목소리 파일' 이 아직 있는가(자리만 본다). 확인하지 못하면 판단하지 않는다 — 못 본 것을 없는 것으로 치지 않는다. */
  const [refState, setRefState] = useState<{ path: string; state: 'ok' | 'missing' | 'unknown' }>({ path: '', state: 'unknown' })
  useEffect(() => {
    if (!pick || pick.kind !== 'reference' || !pick.path) return
    const target = pick.path
    let alive = true
    void window.api.app.pathsExist([target]).then((r) => {
      if (alive) setRefState({ path: target, state: r?.[target] === true ? 'ok' : r?.[target] === false ? 'missing' : 'unknown' })
    }).catch(() => { if (alive) setRefState({ path: target, state: 'unknown' }) })
    return () => { alive = false }
  }, [pick?.kind, pick?.path])
  /** 고른 목소리를 쓸 수 없는 사유 — 있으면 null. 조회가 실패했거나 아직이면 판단하지 않는다(실패 ≠ 없음). */
  const voiceGone = useMemo(() => {
    if (!pick) return null
    if (pick.kind === 'reference') return refState.path === pick.path && refState.state === 'missing' ? '내 목소리 파일을 찾지 못했습니다' : null
    if (voiceCheck.phase !== 'ok' || !builtins) return null
    const found = builtins.some((b) => (pick.path ? b.path === pick.path : false) || (!!pick.modelId && b.engineId === pick.engineId && b.modelId === pick.modelId))
    if (found) return null
    const why = voiceCheck.skipped.find((s) => s.engineId === pick.engineId)?.why
    return why ? `지금 쓸 수 없습니다 — ${why}` : '목소리 목록에 없습니다'
  }, [pick?.path, pick?.kind, pick?.engineId, pick?.modelId, builtins, voiceCheck, refState])
  /** 저장본에서 되살린 기본 목소리가 아직 목록에서 경로를 찾지 못한 상태(조회 중이거나 조회 실패) — 읽을 수 없다. */
  const voiceUnresolved = !!pick && pick.kind === 'builtin' && !pick.path

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
        await bookSaver.flush()          // 지난 방문에서 아직 못 쓴 읽던 자리를 먼저 남긴 뒤 읽는다
        const got = await window.api.works.list('books')
        if (got.error) { setError('서재를 읽지 못했습니다. 화면을 다시 열어 주세요.'); return }
        const saved = (got.records || [])
          .map((r) => r.data as Book | null)
          .filter((b): b is Book => !!b && Array.isArray(b.paragraphs) && b.paragraphs.length > 0)
        if (saved.length) useReader.setState((st) => st.books.length ? st : { books: saved, active: [...saved].filter(b => b.readAt).sort((a, b) => (b.readAt || 0) - (a.readAt || 0))[0]?.id || '' })
      } catch { setError('서재를 읽지 못했습니다. 화면을 다시 열어 주세요.') }
      finally { loadedBooks.current = true }
    })()
  }, [])

  const position = book?.position ?? 0
  // ★읽기 전에는 쓰지 않는다 — 빈 서가가 저장본을 지운다(다른 화면에서 겪은 사고다).
  // ★저장기가 화면 밖에서 쥔다(2026-10-02 관리자 검수 — 문단을 누르고 600ms 안에 메뉴를 옮기면 정리 함수가 타이머를 취소해 메모리 25 · 디스크 0 이었다).
  //   책마다 열쇠가 따로라 빠른 책 전환에서도 앞 책의 마지막 자리가 남고, 값은 쓰는 순간의 최신을 읽는다.
  //   묶기·지우기와는 저장기의 '미루기'·'버리기'로 겨룬다(아래).
  useEffect(() => {
    if (!loadedBooks.current || !book) return
    const id = book.id
    bookSaver.queue(id, () => useReader.getState().books.find(b => b.id === id))
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
  // ★감정 담아 읽기 — 고른 목소리가 감정 지시를 받을 때만(Qwen 지정 목소리 + 1.7B, 지금 목록 기준).
  const emotionUsable = !!pick && pick.kind === 'builtin' && pick.engineId === 'qwen-custom'
    && !!builtins?.find((b) => b.path === pick.path)?.emotion
  const read = useReadAloud(body, voiceGone || voiceUnresolved ? null : pick, { skipHanjaInParens: prefs.skipHanjaInParens, emotion: prefs.emotion && emotionUsable, documentId: active, onEnded: id => completedRef.current(id) })
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
    if (!readPlaying && !readFault && !read.starting && !pendingPlayback) seekToChar(charOfParagraph[position] ?? 0)
  }, [readPlaying, readFault, read.starting, pendingPlayback, seekToChar, position, charOfParagraph])
  useEffect(() => {
    if (!pendingPlayback || pendingPlayback !== active || voiceUnresolved || prep) return
    setPendingPlayback(null)
    if (voiceGone || !pick) { setPicking(true); return }
    read.startAt(charOfParagraph[position] ?? 0)
  }, [pendingPlayback, active, voiceUnresolved, voiceGone, prep, pick, position, charOfParagraph, read.startAt])
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
    if (!box || !windowed || library) return
    const sync = () => {
      const cs = getComputedStyle(box)
      const w = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 34
      setView({ top: box.scrollTop, h: box.clientHeight, w })
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(box)
    return () => ro.disconnect()
  }, [windowed, book?.id, library])
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
    if (!box || index < 0 || library) return
    const el = findTarget(index, phrase)
    if (el || !offsets) { pendingReveal.current = null; scrollInBody(el, how, smooth); return }
    box.scrollTop = scrollTopFor(offsets, index, box.clientHeight, 'center')
    pendingReveal.current = { index, how: 'center', phrase }
    setView((v) => ({ ...v, top: box.scrollTop }))
  }
  // 그린 뒤 — 문단 높이를 재고, 기다리던 '보이게 하기' 를 실제 자리로 맞춘다.
  useLayoutEffect(() => {
    if (!windowed || library) return
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
  useEffect(() => { reveal(position, 'nearest', false, false) }, [active, position, library])
  const { followPaused, resumeFollow, markUserScroll } = useReaderFollow({
    body: bodyRef, playing: read.playing, enabled: prefs.follow, visible: !library, documentId: book?.id,
    caret: read.caret, paragraphAt: paragraphOfChar, offsets: charOfParagraph, reveal,
  })

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
  /** 목록을 여는 순간 Qwen 실행기를 모델 없이 띄운다 — 불러오기(약 6.5초)를 고르기 전에 치른다(그래픽카드 메모리는 잡지 않는다). */
  const prepareQwen = () => {
    // 미리 읽을 모델 — 지금 고른 Qwen 목소리, 없으면 목록의 첫 Qwen 목소리(소희).
    const q = builtins?.find((b) => b.engineId === 'qwen-custom' && b.path === pick?.path) || builtins?.find((b) => b.engineId === 'qwen-custom')
    if (!q) return
    // 관측 — 목록 열기(실행기 띄우기·라이브러리·모델 파일 미리 읽기)의 시작과 끝.
    trace('prepare-request', { engine: q.engineId })
    void window.api.reader.prepare?.({ kind: 'builtin', path: q.path, engineId: q.engineId }, { emotion: prefs.emotion && q.emotion === true })
      ?.then((r) => trace('prepare-done', { prepared: !!r?.data?.prepared, ms: r?.data?.ms }))?.catch(() => { /* 고를 때 연다 */ })
  }
  /** 목소리 확정 뒤 모델 미리 열기 — 시작·끝·줄 대기·실제 준비·모델 처음 엶·첫 생성 준비를 기록한다(동작은 기록을 읽지 않는다). */
  const warmVoice = (v: { kind: 'builtin' | 'reference'; path: string; engineId?: string }, opts?: { emotion?: boolean }) => {
    trace('warm-request', { kind: v.kind, engine: v.engineId || '' })
    void window.api.reader.warm?.(v, opts)?.then((r) => trace('warm-done', { kind: v.kind, engine: v.engineId || '', warmed: !!r?.data?.warmed, why: r?.data?.why,
      loadedNow: r?.data?.loadedNow, primeSec: r?.data?.primeSec, primeSkipped: r?.data?.primeSkipped, waitMs: r?.data?.waitMs, ms: r?.data?.ms }))?.catch(() => { /* 누를 때 연다 */ })
  }
  /** 기본 목소리를 쓴다. GPU 목소리(소희)는 고르는 순간 미리 연다 — 첫 소리의 모델 열기(약 10초)를 누르기 전에 치른다. */
  const chooseBuiltin = (b: BuiltinVoiceRef) => {
    const v: ReaderVoicePick = { kind: 'builtin', path: b.path, engineId: b.engineId, modelId: b.modelId, label: b.label }
    useReader.setState({ voice: b.label, pick: v })
    updatePrefs({ voice: { kind: 'builtin', engineId: b.engineId, modelId: b.modelId, label: b.label } })      // 지정만 저장 — 경로가 아니라 엔진 + 모델 이름
    // 감정 담아 읽기가 켜져 있으면 1.7B 를 연다(덩이 전체를 그 모델로 읽는다).
    trace('voice-confirm', { kind: 'builtin', engine: b.engineId })
    if (b.engineId === 'qwen-custom') warmVoice({ kind: 'builtin', path: b.path, engineId: b.engineId }, { emotion: prefs.emotion && b.emotion === true })
    voiceButton.current?.focus()
  }
  const choosePosition = (value: number) => {
    if (!book) return
    useReader.setState(s => ({ books: s.books.map(b => b.id === book.id ? { ...b, position: Math.max(0, Math.min(value, b.paragraphs.length - 1)), completed: false, readAt: Date.now() } : b) }))
  }
  /** 책을 연다 — 마지막으로 읽은 때를 남긴다(묶음 이어 읽기가 쓴다). */
  const openBook = (id: string) => {
    if (id !== active) { read.stop(); setPendingPlayback(null) }
    useReader.setState(s => ({ active: id, books: s.books.map(b => b.id === id ? { ...b, readAt: Date.now() } : b) }))
    bookSaver.queue(id, () => useReader.getState().books.find(b => b.id === id))
    setLibrary(false)
  }
  const listenBook = (id: string, fromStart = false, showBody = true) => {
    const target = useReader.getState().books.find(b => b.id === id)
    if (!target) return
    read.stop()
    useReader.setState(s => ({ active: id, books: s.books.map(b => b.id === id ? { ...b, position: fromStart || b.completed ? 0 : b.position, completed: false, readAt: Date.now() } : b) }))
    bookSaver.queue(id, () => useReader.getState().books.find(b => b.id === id))
    if (showBody) setLibrary(false)
    setPendingPlayback(id)
  }
  const chapters = book?.group ? sortGroup(books.filter(b => b.group === book.group && !b.archived)) : book ? [book] : []
  const chapterIndex = chapters.findIndex(b => b.id === active)
  const moveChapter = (delta: number) => {
    const target = chapters[chapterIndex + delta]
    if (!target) return
    if (read.playing || read.starting) listenBook(target.id, false, false)
    else { openBook(target.id); if (library) setLibrary(true) }
  }
  completedRef.current = (id) => {
    const st = useReader.getState()
    if (st.active !== id) return
    const current = st.books.find(b => b.id === id)
    if (!current) return
    useReader.setState(s => ({ books: s.books.map(b => b.id === id ? { ...b, completed: true, position: b.paragraphs.length - 1 } : b) }))
    bookSaver.queue(id, () => useReader.getState().books.find(b => b.id === id))
    if (!prefs.autoNext || !current.group || current.archived) return
    const list = sortGroup(st.books.filter(b => b.group === current.group && !b.archived))
    const next = list[list.findIndex(b => b.id === id) + 1]
    if (next) listenBook(next.id, true, false)
  }
  const showChapters = () => { setShelfTarget({ name: book?.group || '', key: Date.now() }); setLibrary(true) }
  // 문단 누름 — 줄마다 같은 함수를 받아야 바뀌지 않은 줄이 다시 그려지지 않는다. 최신 상태는 ref 로 읽는다.
  const pickRef = useRef<(i: number) => void>(() => {})
  pickRef.current = (i: number) => { resumeFollow(); choosePosition(i); if (read.playing) read.seekToChar(charOfParagraph[i] ?? 0) }
  const pickParagraph = useCallback((i: number) => pickRef.current(i), [])
  // ★불러온 자리를 기억한다(2026-09-29 지시). 브라우저식 파일 입력칸은 여는 자리를
  //   운영체제가 정해서 다른 툴 폴더로 열렸다 — 본체 대화상자가 용도별로 기억한다.
  const pickTexts = async () => {
    if (loading) return
    try {
    const got = await window.api.reader.pickTexts()
    if (got.error) { setError(got.error); return }
    const list = got.data || []
    if (!list.length) return                       // 취소
    await importFiles(list.map(f => ({
      name: f.name, size: f.size,
      read: async () => { if (!f.bytes) throw new Error('읽지 못함'); return f.bytes },
    })))
    } catch { setError('책을 불러오지 못했습니다. 다시 선택해 주세요.') }
  }
  const dropTexts = (files: File[], dirs: boolean[] = [], blocked = false) => {
    // ★받지 못하면 사유를 띄운다 — 작업 중 · 빈 끌기 · 폴더 위치를 못 읽음(shared/readerLibrary planDrop).
    const plan = planDrop(files.map((f, i) => ({ path: window.api.utils.getPathForFile(f) || '', dir: !!dirs[i] })), blocked || loading || !!importRun || changingBooks.current)
    if (plan.kind === 'refuse') { setNotice(''); setError(plan.reason); opLog('reader', `끌어 놓기 받지 않음 — ${plan.reason}`); return }
    // 폴더가 섞여 있으면 본체가 훑는다(하위 폴더·작품 묶음) — 파일과 폴더가 섞인 끌기도 같은 길로.
    if (plan.kind === 'paths') { void importPaths(plan.paths); return }
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
  const pickVoiceFile = async (droppedPath?: string) => {
    try {
    const at = droppedPath || await window.api.audio.selectFile(false, 'voice')
    if (typeof at !== 'string' || !at) return      // 취소
    setPicking(false)
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
      // 조각이 비면 원본이 그대로 쓸 만하다는 뜻이다(3~10초 · 품질 통과) — 원본 경로를 그대로 쓴다(복사하지 않는다).
      // ★잘라 쓴 조각은 임시 자리에 있다(켤 때·끌 때 치움) — 앱이 관리하는 자리에 보관한 경로를 쓴다(2026-10-03: 다시 켜면 목소리가 사라졌다).
      let path = at
      let lasting = true
      if (clip) {
        const keep = [...prefs.recentVoices.map((r) => r.path), prefs.voice?.kind === 'reference' ? prefs.voice.path : ''].filter(Boolean)
        const kept = await window.api.reader.keepVoice(clip, keep)
        if (kept.data?.path) path = kept.data.path
        else { path = clip; lasting = false }
      }
      useReader.setState({ voice: label, pick: { kind: 'reference', path, label } })
      // ★참조 목소리도 고르는 순간 그 모델 하나를 미리 연다(2026-10-03) — 첫 덩이가 모델 열기를 기다리지 않게.
      trace('voice-confirm', { kind: 'reference' })
      warmVoice({ kind: 'reference', path })
      // 다음에 목소리 고르기에서 다시 고를 수 있게 — 준비를 다시 하지 않는다. 고른 목소리 지정도 함께 남긴다.
      // ★보관하지 못한 임시 조각은 저장하지 않는다 — 다음 실행에 없는 경로를 남기지 않는다(이번 실행에서만 쓴다).
      if (lasting) updatePrefs({ recentVoices: rememberVoice(prefs.recentVoices, { path, label }), voice: { kind: 'reference', path, label } })
      else setError('이 목소리를 보관하지 못해 이번 실행에서만 씁니다 — 다시 켜면 다시 골라 주세요.')
      opLog('reader', `참조 목소리 준비됨 — ${label} · ${clip ? (lasting ? '구간을 잘라 씀 · 보관함' : '구간을 잘라 씀 · 보관 못 함') : '원본 그대로'}`)
      return
    }
    const why = outcome === 'needs_region'
      ? '이 파일은 쓸 구간을 스스로 고르지 못했습니다 — 3~10초짜리 깨끗한 말소리 파일을 고르거나, 생성 카드에서 구간을 정한 목소리를 쓰세요.'
      : outcome === 'failed' ? (said || '이 파일에서 목소리를 준비하지 못했습니다 — 다른 파일을 골라 주세요.')
      : ''
    if (why) { setError(why); opLog('reader', `참조 목소리 준비 안 됨(${outcome}) — ${label}: ${why}`, 'WARN') }
    } catch (e) { setError(e instanceof Error ? e.message : '목소리를 불러오지 못했습니다.') }
    finally { setPrep('') }
  }
  const importFiles = async (files: TextSource[]) => {
    if (changingBooks.current || !loadedBooks.current) return
    changingBooks.current = true
    setLoading(true); setError(''); setNotice('')
    const added: Book[] = []; const rejected: string[] = []
    let duplicate = 0
    let existingId = ''
    try {
      for (const file of files) {
        if (!/\.txt$/i.test(file.name) || file.size > TEXT_FILE_LIMIT) { rejected.push(`${file.name}: TXT · 10MB 이하만 지원`); continue }
        try {
          const bytes = await file.read()
          // ★UTF-8 · UTF-16 · CP949(EUC-KR) 를 알아서 읽는다 — 다시 저장하라고 떠넘기지 않는다(readerDecode).
          const got = decodeBookText(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
          if (!got) { rejected.push(`${file.name}: 글자 방식을 알아보지 못했습니다(UTF-8 · UTF-16 · CP949 만 읽습니다)`); continue }
          if (got.encoding !== 'utf-8') opLog('reader', `글 파일 ${nameOnly(file.name)} — ${encodingLabel(got.encoding)} 로 읽음`)
          const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
          const paragraphs = toParagraphs(got.text)
          if (!paragraphs.length) { rejected.push(`${file.name}: 내용 없음`); continue }
          const name = file.name.replace(/\.txt$/i, '')
          // ★같은 책: 지문이 같거나(이름이 달라도), 지문 없는 예전 책은 이름 + 본문 전체가 같을 때(shared/readerLibrary).
          const sha256 = await sha256Hex(raw)
          const same = classifyIncoming({ sha256, name, paragraphs }, [...useReader.getState().books, ...added])
          if (same.kind === 'duplicate') { duplicate++; existingId = same.id; continue }
          const next: Book = { id: crypto.randomUUID(), name, paragraphs, position: 0, addedAt: Date.now(), source: { path: '', size: raw.byteLength, mtimeMs: 0, sha256 } }
          const saved = await window.api.works.write('books', next.id, next)
          if (!saved.ok) { rejected.push(`${file.name}: 저장하지 못했습니다`); continue }
          added.push(next)
        } catch { rejected.push(`${file.name}: 읽지 못했습니다`) }
      }
      if (added.length) {
        useReader.setState(s => ({ books: [...s.books, ...added], active: added.length === 1 ? added[0].id : s.active }))
        // 저장에 성공한 책만 넣는다. 한 권은 바로 열고 여러 권은 서재에서 고른다.
        setLibrary(added.length > 1)
      }
      if (!added.length && duplicate === 1 && files.length === 1) { useReader.setState({ active: existingId }); setLibrary(false) }
      setNotice([added.length ? `${added.length}권 추가됨` : '', duplicate ? `이미 있는 책 ${duplicate}권` : ''].filter(Boolean).join(' · '))
      setError(rejected.join(' · '))
    } finally { changingBooks.current = false; setLoading(false) }
  }
  const removeBooks = async (ids: string[]) => {
    if (changingBooks.current) return
    changingBooks.current = true; setLoading(true); setError('')
    const removed = new Set<string>(); const failed: string[] = []
    const snapshots: Book[] = []
    try {
    for (const id of ids) {
      // 지우는 책은 더 쓰지 않는다 — 쓰던 것이 있으면 끝나길 기다린다(지운 책이 늦은 저장으로 되살아나지 않게).
      await bookSaver.flush(id)
      const snapshot = useReader.getState().books.find(b => b.id === id)
      await bookSaver.discard(id)
      try {
        const result = await window.api.works.remove('books', id)
        if (!result.ok) throw new Error('remove failed')
        removed.add(id)
        if (snapshot) snapshots.push(snapshot)
        bookSaver.forget(id)
      } catch {
        bookSaver.restore(id)            // 지우지 못했다 — 읽던 자리 저장을 되살린다
        failed.push(useReader.getState().books.find(b => b.id === id)?.name || '책')
      }
    }
    if (removed.has(useReader.getState().active)) { read.stop(); setPendingPlayback(null) }
    useReader.setState(s => {
      const next = s.books.filter(b => !removed.has(b.id))
      return { books: next, active: removed.has(s.active) ? '' : s.active }
    })
    if (snapshots.length) setRemovedBooks(prev => [...prev.filter(b => !removed.has(b.id)), ...snapshots])
    setNotice(removed.size ? `${removed.size}권을 서재에서 뺐습니다` : '')
    if (failed.length) setError(`목록에서 빼지 못했습니다: ${failed.join(', ')}`)
    } finally { changingBooks.current = false; setLoading(false) }
  }
  const undoRemove = async () => {
    if (changingBooks.current) return
    changingBooks.current = true; setLoading(true); setError('')
    const restored = new Set<string>()
    try {
      for (const b of removedBooks) {
        bookSaver.restore(b.id)
        const code = await bookSaver.writeNow(b.id, b)
        if (code) { setError('일부 책을 되돌리지 못했습니다. 다시 시도해 주세요.'); continue }
        restored.add(b.id)
        useReader.setState(s => ({ books: s.books.some(x => x.id === b.id) ? s.books : [...s.books, b], active: s.active || b.id }))
      }
      setRemovedBooks(prev => prev.filter(b => !restored.has(b.id)))
      setNotice(restored.size ? `${restored.size}권을 되돌렸습니다` : '')
    } finally { changingBooks.current = false; setLoading(false) }
  }
  const setCover = async (ids: string[], clear = false) => {
    if (changingBooks.current) return
    changingBooks.current = true; setLoading(true); setError('')
    const release = bookSaver.hold()
    try {
      const got = clear ? { data: '' } : await window.api.reader.cover()
      if (got.error) throw new Error(got.error)
      if (got.data === null || got.data === undefined) return
      for (const id of ids) {
        await bookSaver.flush(id)
        const current = useReader.getState().books.find(b => b.id === id)
        if (!current) continue
        const cover = got.data || undefined
        if (await bookSaver.writeNow(id, { ...current, cover })) throw new Error('표지를 저장하지 못했습니다. 다시 시도해 주세요.')
        useReader.setState(s => ({ books: s.books.map(b => b.id === id ? { ...b, cover } : b) }))
      }
    } catch (e) { setError((e as Error).message) }
    finally { release(); changingBooks.current = false; setLoading(false) }
  }
  const archiveGroup = async (group: string, archived: boolean) => {
    if (changingBooks.current) return false
    changingBooks.current = true; setLoading(true); setError('')
    const release = bookSaver.hold(); let ok = true
    try {
      const ids = useReader.getState().books.filter(b => b.group === group).map(b => b.id)
      for (const id of ids) {
        await bookSaver.flush(id)
        const b = useReader.getState().books.find(x => x.id === id)
        if (!b) continue
        const next = { ...b, archived }
        if (await bookSaver.writeNow(id, next)) { ok = false; continue }
        useReader.setState(s => ({ books: s.books.map(x => x.id === id ? { ...x, archived } : x) }))
      }
      if (!ok) setError('일부 책의 보관 상태를 저장하지 못했습니다. 다시 시도해 주세요.')
      else setNotice(`‘${group}’ 묶음을 ${archived ? '보관했습니다' : '내 서재로 꺼냈습니다'}`)
      return ok
    } finally { release(); changingBooks.current = false; setLoading(false) }
  }
  // 작품 이름은 책의 메타데이터다. 원본 TXT와 본문은 바꾸지 않고 저장 성공분만 반영한다.
  const groupBooks = async (ids: string[], name: string): Promise<boolean> => {
    if (changingBooks.current) return false
    changingBooks.current = true; setLoading(true); setError('')
    const updated = new Map<string, Book>(); const failed: string[] = []
    // 묶는 동안 읽던 자리 저장은 **미룬다** — 같은 책 파일을 둘이 덮어쓰며 묶음이 되돌려지지 않게(저장기가 한 줄로 세운다).
    const release = bookSaver.hold()
    try {
      for (const id of ids) {
        try {
          await bookSaver.flush(id)        // 마지막 읽던 자리를 먼저 남긴 뒤 그 책을 읽는다
          const current = useReader.getState().books.find(b => b.id === id)
          if (!current) continue
          const target = name.trim().slice(0, 120)
          // 다른 묶음으로 옮기면 그 묶음의 끝 차례로, 꺼내면 차례를 지운다.
          const base = target ? Math.max(-1, ...useReader.getState().books.filter(b => b.group === target && !ids.includes(b.id)).map(b => b.order ?? -1), ...[...updated.values()].map(b => b.order ?? -1)) + 1 : 0
          const next = { ...current, group: target || undefined, order: target ? (current.group === target ? current.order : base) : undefined }
          const code = await bookSaver.writeNow(id, next)
          if (code) throw new Error('save failed')
          updated.set(id, next)
        } catch { failed.push(useReader.getState().books.find(b => b.id === id)?.name || '책') }
      }
      useReader.setState(s => ({ books: s.books.map(b => updated.has(b.id) ? { ...b, group: updated.get(b.id)!.group, order: updated.get(b.id)!.order } : b) }))
      if (failed.length) setError(`묶음을 저장하지 못했습니다: ${failed.join(', ')}`)
      else setNotice(name.trim() ? `${updated.size}권을 ‘${name.trim()}’에 모았습니다` : `${updated.size}권을 묶음에서 꺼냈습니다`)
      return !failed.length
    } finally { release(); changingBooks.current = false; setLoading(false) }
  }
  // ── 폴더 가져오기 · 작품 묶음 (2026-10-03) ─────────────────────────────────────────
  // ★원본은 읽기만 한다. 저장에 성공한 책만 서재에 넣는다. 취소하면 이미 넣은 것은 남기고 나머지는 넣지 않는다.
  const [preview, setPreview] = useState<null | { scan: ScanResult; works: Array<{ root: string; name: string; include: boolean; files: ScanFile[]; coverPath?: string }> }>(null)
  const [importRun, setImportRun] = useState<null | { total: number; processed: number }>(null)
  const [importResult, setImportResult] = useState<null | { added: number; duplicate: number; failed: ImportItem[]; cancelled: number }>(null)
  const [conflicts, setConflicts] = useState<null | Array<{ id: string; item: ImportItem; next: { name: string; paragraphs: string[]; source: BookSource }; choice: 'replace' | 'separate' | 'skip' }>>(null)
  const [groupFault, setGroupFault] = useState<null | { group: string; root: string }>(null)
  const cancelImport = useRef(false)
  const nextOrder = (group: string) => Math.max(-1, ...useReader.getState().books.filter(b => b.group === group).map(b => b.order ?? -1)) + 1
  /** 훑은 결과 → 미리 보기(묶음이 있을 때) 또는 곧바로(낱권만). */
  const openScan = (scan: ScanResult | null | undefined) => {
    if (!scan) return
    const skipped = skippedText(scan)
    if (!scan.works.length && !scan.loose.length) { setNotice(`가져올 TXT 가 없습니다${skipped ? ` · 건너뜀: ${skipped}` : ''}`); return }
    const books = useReader.getState().books
    if (!scan.works.length) { void runImport(scan.loose.map(f => ({ path: f.path, name: f.name }))); return }
    setPreview({ scan, works: scan.works.map(w => ({ root: w.root, name: suggestGroupName(w, books), include: true, files: w.files, coverPath: w.coverPath })) })
  }
  const importFolder = async () => {
    if (loading || importRun) return
    const got = await window.api.reader.pickFolders()
    if (got.error) { setError(got.error); return }
    openScan(got.data)
  }
  const importPaths = async (paths: string[]) => {
    if (!paths.length) return
    const got = await window.api.reader.scanPaths(paths)
    if (got.error) { setError(got.error); return }
    openScan(got.data)
  }
  const importPathsRef = useRef(importPaths)
  importPathsRef.current = importPaths
  useEffect(() => {
    // 검사 전용 — 끌어 놓은 자리(파일·폴더)를 화면이 받은 뒤의 길을 그대로 탄다(OS 끌기 사건은 만들 수 없다).
    if (window.api?._e2e) Object.assign(window, { __readerImportPaths: (p: string[]) => importPathsRef.current(p) })
  }, [])
  const confirmPreview = () => {
    if (!preview) return
    const items: ImportItem[] = []
    for (const w of preview.works) {
      if (!w.include || !w.name.trim()) continue
      const group = w.name.trim().slice(0, 120)
      const base = nextOrder(group)
      w.files.forEach((f, i) => items.push({ path: f.path, name: f.name, group, order: base + i, root: w.root, coverPath: w.coverPath }))
    }
    for (const f of preview.scan.loose) items.push({ path: f.path, name: f.name })
    setPreview(null)
    void runImport(items)
  }
  const runImport = async (items: ImportItem[]) => {
    if (!items.length || changingBooks.current || !loadedBooks.current) return
    changingBooks.current = true
    cancelImport.current = false
    setError(''); setNotice(''); setImportResult(null)
    setImportRun({ total: items.length, processed: 0 })
    const failed: ImportItem[] = [], found: NonNullable<typeof conflicts> = []
    const batch: Book[] = []
    const covers = new Map<string, string | undefined>()
    let added = 0, duplicate = 0, cancelled = 0, processed = 0
    const flush = () => { if (batch.length) { const add = batch.splice(0); useReader.setState(s => ({ books: [...s.books, ...add] })) } }
    try {
      for (let i = 0; i < items.length; i++) {
        if (cancelImport.current) { cancelled = items.length - i; break }
        const it = items[i]
        try {
          const r = await window.api.reader.readTextPath(it.path)
          if (r.error || !r.data) throw new Error(r.error || '읽지 못함')
          const raw = r.data.bytes instanceof Uint8Array ? r.data.bytes : new Uint8Array(r.data.bytes)
          const got = decodeBookText(raw)
          if (!got) throw new Error('글자 방식을 알아보지 못함')
          const paragraphs = toParagraphs(got.text)
          if (!paragraphs.length) throw new Error('내용 없음')
          const name = it.name.replace(/\.txt$/i, '')
          const sha256 = await sha256Hex(raw)
          const source: BookSource = { path: it.path, root: it.root, size: r.data.size, mtimeMs: r.data.mtimeMs, sha256 }
          const c = classifyIncoming({ path: it.path, sha256, name, paragraphs }, [...useReader.getState().books, ...batch])
          if (c.kind === 'duplicate') duplicate++
          else if (c.kind === 'changed') found.push({ id: c.id, item: it, next: { name, paragraphs, source }, choice: 'skip' })
          else {
            if (it.coverPath && !covers.has(it.coverPath)) {
              const image = await window.api.reader.cover(it.coverPath)
              covers.set(it.coverPath, image.data || undefined)
              if (image.error) setError(image.error)
            }
            const next: Book = { cover: it.coverPath ? covers.get(it.coverPath) : undefined, id: crypto.randomUUID(), name, paragraphs, position: 0, addedAt: Date.now(), group: it.group, order: it.order, source }
            const saved = await window.api.works.write('books', next.id, next)
            if (!saved.ok) throw new Error(saved.why || '저장하지 못함')     // ★저장 실패를 성공으로 두지 않는다
            batch.push(next); added++
          }
        } catch { failed.push(it) }
        processed++
        if (processed % 10 === 0 || processed === items.length) {
          flush(); setImportRun({ total: items.length, processed })
          await new Promise(r => setTimeout(r, 0))          // 화면이 멈추지 않게 한 박자
        }
      }
    } finally {
      flush(); changingBooks.current = false; setImportRun(null)
    }
    setImportResult({ added, duplicate, failed, cancelled })
    if (added) setLibrary(true)
    if (found.length) setConflicts(found)
  }
  /** 변경된 원본 — 사람이 고른 대로(교체/별도 등록/건너뜀). 조용히 덮지 않는다. */
  const applyConflicts = async () => {
    if (!conflicts || changingBooks.current) return
    changingBooks.current = true
    const release = bookSaver.hold()
    let replaced = 0, separated = 0, skipped = 0, reset = 0
    const failedNames: string[] = []
    try {
      for (const c of conflicts) {
        if (c.choice === 'skip') { skipped++; continue }
        const old = useReader.getState().books.find(b => b.id === c.id)
        if (!old) { skipped++; continue }
        if (c.choice === 'replace') {
          await bookSaver.flush(old.id)
          const cur = useReader.getState().books.find(b => b.id === c.id) || old
          const mapped = mapPosition(cur.paragraphs, cur.position, c.next.paragraphs)
          const upd: Book = { ...cur, paragraphs: c.next.paragraphs, source: { ...c.next.source, root: cur.source?.root ?? c.next.source.root }, position: mapped.position, history: pushHistory(cur, Date.now()) }
          const code = await bookSaver.writeNow(cur.id, upd)
          if (code) { failedNames.push(cur.name); continue }
          useReader.setState(s => ({ books: s.books.map(b => b.id === cur.id ? upd : b) }))
          replaced++; if (!mapped.kept) reset++
        } else {
          const next: Book = { id: crypto.randomUUID(), name: `${c.next.name} (새 판)`, paragraphs: c.next.paragraphs, position: 0, addedAt: Date.now(),
            group: old.group, order: old.group ? nextOrder(old.group) : undefined, source: c.next.source }
          const saved = await window.api.works.write('books', next.id, next)
          if (!saved.ok) { failedNames.push(c.next.name); continue }
          useReader.setState(s => ({ books: [...s.books, next] })); separated++
        }
      }
    } finally { release(); changingBooks.current = false; setConflicts(null) }
    setNotice([replaced ? `교체 ${replaced}` : '', separated ? `별도 등록 ${separated}` : '', skipped ? `건너뜀 ${skipped}` : '',
      reset ? `읽던 자리를 새 본문에서 찾지 못해 처음으로 ${reset}권(이전 기록은 남김)` : ''].filter(Boolean).join(' · '))
    if (failedNames.length) setError(`저장하지 못했습니다: ${failedNames.join(', ')}`)
  }
  /** 묶음 안 차례를 한 칸 옮긴다. */
  const reorderBook = async (group: string, id: string, delta: -1 | 1) => {
    if (changingBooks.current) return
    const members = useReader.getState().books.filter(b => b.group === group)
    const plan = moveInGroup(members, id, delta)
    if (!plan) return
    changingBooks.current = true
    const release = bookSaver.hold()
    try {
      for (const { id: bid, order } of plan) {
        const cur = useReader.getState().books.find(b => b.id === bid)
        if (!cur || cur.order === order) continue
        await bookSaver.flush(bid)
        const upd = { ...useReader.getState().books.find(b => b.id === bid)!, order }
        const code = await bookSaver.writeNow(bid, upd)
        if (code) { setError(`차례를 저장하지 못했습니다: ${cur.name}`); break }
        useReader.setState(s => ({ books: s.books.map(b => b.id === bid ? { ...b, order } : b) }))
      }
    } finally { release(); changingBooks.current = false }
  }
  /** 묶음 해제 — 책은 서재에 남는다. */
  const ungroup = (group: string) => groupBooks(useReader.getState().books.filter(b => b.group === group).map(b => b.id), '')
  /** 원본 폴더에서 새 회차를 찾는다 — 사람이 누를 때만. 원본에서 사라진 책은 지우지 않는다. */
  const checkNew = async (group: string) => {
    const members = useReader.getState().books.filter(b => b.group === group)
    const roots = Array.from(new Set(members.map(b => b.source?.root).filter((r): r is string => !!r)))
    if (!roots.length) { setNotice('이 묶음은 폴더로 가져오지 않아 확인할 원본 폴더가 없습니다'); return }
    const r = await window.api.reader.scanPaths(roots)
    if (r.error || !r.data) { setError(r.error || '원본 폴더를 훑지 못했습니다'); return }
    const lost = roots.find(x => r.data!.missing.some(m => samePath(m, x)))
    if (lost) { setGroupFault({ group, root: lost }); return }
    setGroupFault(null)
    const files = r.data.works.filter(w => roots.some(x => samePath(x, w.root))).flatMap(w => w.files.map(f => ({ ...f, root: w.root })))
    const known = useReader.getState().books
    const fresh = files.filter(f => !known.some(b => samePath(b.source?.path, f.path))).sort((a, b) => naturalCompare(a.name, b.name))
    const gone = members.filter(b => b.source?.path && !files.some(f => samePath(f.path, b.source!.path))).length
    const goneText = gone ? ` · 원본 폴더에 없는 책 ${gone}권(서재에는 그대로 둡니다)` : ''
    if (!fresh.length) { setNotice(`새 회차가 없습니다${goneText}`); return }
    const base = nextOrder(group)
    await runImport(fresh.map((f, i) => ({ path: f.path, name: f.name, group, order: base + i, root: f.root })))
    if (goneText) setNotice(n => (n ? n + goneText : goneText.slice(3)))
  }
  /** 원본 폴더를 다시 고른다 — 그 묶음의 원본 기록만 새 자리로 잇는다(책·읽던 자리는 그대로). */
  const relinkFolder = async () => {
    if (!groupFault || changingBooks.current) return
    const got = await window.api.reader.pickFolders()
    if (got.error) { setError(got.error); return }
    const root = got.data?.works[0]?.root
    if (!root) { if (got.data) setNotice('고른 폴더에 TXT 가 없습니다'); return }
    const { group, root: lost } = groupFault
    changingBooks.current = true
    const release = bookSaver.hold()
    try {
      for (const b of useReader.getState().books.filter(x => x.group === group && samePath(x.source?.root, lost))) {
        // 원본 자리도 새 폴더의 같은 파일 이름으로 잇는다 — 예전 자리로 남겨 두면 '새 파일 확인' 이 모든 책을 '원본에 없음' 으로 셌다(2026-10-03 캡처로 확인).
        const sep = root.includes('\\') ? '\\' : '/'
        const file = (b.source!.path || '').split(/[\\/]/).pop() || ''
        const upd = { ...b, source: { ...b.source!, root, path: file ? root.replace(/[\\/]+$/, '') + sep + file : b.source!.path } }
        if (await bookSaver.writeNow(b.id, upd)) { setError(`원본 폴더를 바꾸지 못했습니다: ${b.name}`); return }
        useReader.setState(s => ({ books: s.books.map(x => x.id === b.id ? upd : x) }))
      }
    } finally { release(); changingBooks.current = false }
    setGroupFault(null)
    await checkNew(group)
  }
  // ★스피커 음량 (2026-10-01 지시: "낭독에서 스피커 음 조절 기능이 필요하다") — 앱의 **공용 재생 음량**(다른 화면 슬라이더와 같은 값, 보관됨).
  const iconButton: CSSProperties = { ...kitButton, padding: 8, minWidth: 36 }
  const displayPosition = read.playing && readingParagraph >= 0 ? readingParagraph : position
  const narratorName = useMemo(() => groupVoices(builtins || []).flatMap(g => g.voices).find(v => v.voice.path === pick?.path)?.short || voice, [builtins, pick?.path, voice])
  const narratorButton = <button ref={voiceButton} data-testid="reader-voice" aria-haspopup="dialog" onClick={() => { setPicking(true); prepareQwen() }} disabled={!!prep}
        title={prep ? '목소리를 준비하는 중입니다' : voiceGone ? `${voice} — ${voiceGone}` : `${voice} · 낭독자 바꾸기`}
        style={{ ...kitButton, justifyContent: 'flex-start', minWidth: 0, padding: '3px 0', maxWidth: '100%', background: 'transparent', border: 'none', textAlign: 'left' }}>
        <Icon name="voice"/>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)' }}>낭독자</span>
          <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>{prep ? '준비 중…' : voiceGone ? '목소리를 골라 주세요' : narratorName}</span>
        </span>
      </button>
  const finishSeek = () => { if (seekPosition !== null) { pickParagraph(seekPosition); setSeekPosition(null) } }
  const matches = useMemo(() => {
    const term = findText.trim().toLocaleLowerCase()
    if (!term || !book) return []
    return book.paragraphs.flatMap((text, index) => text.toLocaleLowerCase().includes(term) ? [{ text, index }] : [])
  }, [book?.paragraphs, findText])
  return <section data-testid="reader-workspace" aria-label="낭독 작업실" style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%', minHeight: 0 }}>
    <header data-testid="reader-heading" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 14, flexShrink: 0, paddingBottom: 18, borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ flex: 1, minWidth: 160 }}>
        <span style={{ display: 'block', fontSize: 10, color: '#b5aa95', letterSpacing: '.16em', marginBottom: 7 }}>AUDIOFORGE · READER</span>
        <h1 style={{ margin: 0, fontSize: 25, fontWeight: 600, letterSpacing: '-.04em' }}>{library || !book ? '내 서재' : book.group || '책 읽는 시간'}</h1>
      </div>
      {!book && narratorButton}

    </header>
    {!!removedBooks.length && <button data-testid="reader-remove-undo" style={kitButton} disabled={loading} onClick={() => void undoRemove()}>서재 제거 되돌리기 ({removedBooks.length}권)</button>}
    {!!notice && <span role="status" data-testid="reader-notice" style={{ ...muted, marginTop: -10 }}>{notice}</span>}
    {!!importRun && <span role="status" data-testid="reader-import-progress" style={{ ...muted, marginTop: -10 }}>
      가져오는 중 {importRun.processed} / {importRun.total}
      <button data-testid="reader-import-cancel" onClick={() => { cancelImport.current = true }} title="남은 파일은 가져오지 않습니다 — 이미 넣은 책은 남습니다" style={{ ...kitButton, marginLeft: 8, padding: '2px 10px' }}>취소</button>
    </span>}
    {!!importResult && !importRun && <span role="status" data-testid="reader-import-result" style={{ ...muted, marginTop: -10 }}>
      완료 {importResult.added} · 중복 {importResult.duplicate} · 실패 {importResult.failed.length}{importResult.cancelled ? ` · 취소로 미처리 ${importResult.cancelled}` : ''}
      {!!importResult.failed.length && <button data-testid="reader-import-retry" onClick={() => { const f = importResult.failed; void runImport(f) }} title="실패한 파일만 다시 가져옵니다" style={{ ...kitButton, marginLeft: 8, padding: '2px 10px' }}>실패한 {importResult.failed.length}개 다시</button>}
    </span>}
    {!!groupFault && <span role="status" data-testid="reader-group-fault" style={{ ...muted, marginTop: -10, color: 'var(--rose)' }}>
      ‘{groupFault.group}’ 원본 폴더를 찾지 못했습니다 — {nameOnly(groupFault.root)}
      <button data-testid="reader-group-relink" onClick={() => { void relinkFolder() }} title="원본 폴더를 다시 고릅니다 — 서재의 책은 그대로입니다" style={{ ...kitButton, marginLeft: 8, padding: '2px 10px' }}>폴더 다시 선택</button>
    </span>}
    {!!voiceGone && <span role="status" data-testid="reader-voice-missing" style={{ ...muted, marginTop: -10, color: 'var(--rose)' }}>
      ‘{voice}’ — {voiceGone}
      <button data-testid="reader-voice-pick-other" onClick={() => { setPicking(true); prepareQwen() }} style={{ ...kitButton, marginLeft: 8, padding: '2px 10px' }}>다른 목소리 고르기</button>
    </span>}
    {voiceCheck.phase === 'failed' && <span role="status" data-testid="reader-voice-lookup-failed" style={{ ...muted, marginTop: -10, color: 'var(--rose)' }}>
      목소리 목록을 확인하지 못했습니다 — 고른 목소리는 그대로 둡니다
      <button data-testid="reader-voice-recheck" onClick={() => { setVoiceCheck({ phase: 'loading', skipped: [] }); setVoiceTick((n) => n + 1) }} style={{ ...kitButton, marginLeft: 8, padding: '2px 10px' }}>다시 확인</button>
    </span>}
    {!!saveNote && <span role="status" data-testid="reader-save-status" style={{ ...muted, marginTop: -10, color: 'var(--rose)' }}>
      {saveNote}을 저장하지 못했습니다
      <button data-testid="reader-save-retry" onClick={() => { void bookSaver.retry(); void prefsSaver.retry() }} title="저장을 다시 시도합니다 — 자동으로도 다시 시도합니다"
        style={{ ...kitButton, marginLeft: 8, padding: '2px 10px' }}>다시 저장</button>
    </span>}
    <div ref={shelfScroll} onScroll={e => { if (library) shelfScrollTop.current = e.currentTarget.scrollTop }} data-testid="reader-shelf-scroll" style={{ display: library || !book ? 'block' : 'none', flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', padding: '4px 4px 18px' }}>
    {<ReaderShelf books={books} active={active} busy={loading} error={error} onDrop={dropTexts}
      view={prefs.shelfView} grouped={prefs.shelfGrouped} onView={shelfView => updatePrefs({ shelfView })} onGrouped={shelfGrouped => updatePrefs({ shelfGrouped })} onGroup={groupBooks}
      onAdd={() => { void pickTexts() }} onAddFolder={() => { void importFolder() }} onRemove={removeBooks} onOpen={openBook} onListen={listenBook} onCover={setCover} revealGroup={shelfTarget}
      onArchive={archiveGroup} onReorder={reorderBook} onUngroup={ungroup} onCheckNew={g => { void checkNew(g) }}/>}
    </div>
    <div style={{ display: library || !book ? 'none' : 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }} onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
      onDrop={e => {
        e.preventDefault(); setDragging(false)
        const items = Array.from(e.dataTransfer.items).filter(i => i.kind === 'file')
        dropTexts(Array.from(e.dataTransfer.files), items.map(i => !!(i as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory?: boolean } | null }).webkitGetAsEntry?.()?.isDirectory))
      }}>
      {!library && error && <div role="alert" style={{ color: 'var(--rose)', fontSize: 12, marginBottom: 10 }}>{error}</div>}
      <article className="reader-view-enter" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, border: '1px solid var(--border-subtle)', borderRadius: 18, overflow: 'hidden', outline: dragging ? '2px solid var(--accent-light)' : undefined }}>
        <header style={{ padding: '12px 18px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, background: '#1b1e27' }}>
          <button data-testid="reader-library" style={{ ...iconButton, border: 'none', background: 'transparent' }} onClick={() => setLibrary(true)} title="서재로 돌아가기" aria-label="서재로 돌아가기"><Icon name="back"/></button>
          <h2 data-testid="reader-now-reading" style={{ margin: 0, fontSize: 14, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{book?.name}</h2>
          <button style={iconButton} aria-label="이전 문단" title="이전 문단" disabled={displayPosition === 0} onClick={() => pickParagraph(displayPosition - 1)}><Icon name="prev" size={14}/></button>
          <button style={iconButton} aria-label="다음 문단" title="다음 문단" disabled={!book || displayPosition >= book.paragraphs.length - 1} onClick={() => pickParagraph(displayPosition + 1)}><Icon name="next" size={14}/></button>
          <button data-testid="reader-find" style={iconButton} aria-label="본문 찾기" title="본문 찾기" onClick={() => setFinding(true)}><Icon name="text"/></button>
        <button data-testid="reader-follow" aria-label={followPaused ? '읽는 곳으로 돌아가기' : '읽는 줄 따라가기'} aria-pressed={prefs.follow && !followPaused} title={followPaused ? '직접 스크롤하여 따라가기를 쉬고 있습니다 — 읽는 곳으로 돌아가기' : prefs.follow ? '읽는 줄을 화면이 따라갑니다 — 누르면 멈춥니다' : '누르면 읽는 줄을 화면이 따라갑니다'}
          onClick={() => { if (followPaused) { resumeFollow(); if (!read.playing) reveal(Math.max(0, readingParagraph), 'center', true, false) } else { resumeFollow(); updatePrefs({ follow: !prefs.follow }) } }}
          style={{ ...kitButton, color: followPaused ? 'var(--amber)' : prefs.follow ? 'var(--cyan)' : 'var(--text-muted)', borderColor: followPaused ? 'var(--amber)' : prefs.follow ? 'var(--cyan)' : undefined }}><Icon name="follow"/>{followPaused && <span style={{ fontSize: 11 }}>읽는 곳으로</span>}</button>
        </header>
        {book && <div data-testid="reader-viewer" style={{ display: 'grid', gridTemplateColumns: chapters.length > 1 ? '34px minmax(0, 1fr) 34px' : 'minmax(0, 1fr)', flex: 1, minHeight: 0, background: '#14171e' }}>
          {chapters.length > 1 && <button type="button" className="reader-chapter-edge" data-testid="reader-prev-chapter" aria-label="이전 회차" title="이전 회차" disabled={chapterIndex <= 0} onClick={() => moveChapter(-1)} style={{ border: 0, padding: 0, minWidth: 0, cursor: 'pointer', visibility: chapterIndex <= 0 ? 'hidden' : 'visible' }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg></button>}
          <div ref={bodyRef} className="reader-prose" data-testid="reader-body" aria-label="책 본문" data-windowed={windowed ? '1' : '0'}
            onScroll={windowed ? onBodyScroll : undefined} onWheel={markUserScroll} onTouchMove={markUserScroll}
            onPointerDown={e => { const el = e.currentTarget; if (e.clientX >= el.getBoundingClientRect().right - 16) markUserScroll() }}
            onKeyDown={e => { if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key)) markUserScroll() }}
            style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '26px max(18px, calc((100% - 760px) / 2))', background: '#14171e' }}>
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
          {chapters.length > 1 && <button type="button" className="reader-chapter-edge" data-testid="reader-next-chapter" aria-label="다음 회차" title="다음 회차" disabled={chapterIndex < 0 || chapterIndex >= chapters.length - 1} onClick={() => moveChapter(1)} style={{ border: 0, padding: 0, minWidth: 0, cursor: 'pointer', visibility: chapterIndex >= chapters.length - 1 ? 'hidden' : 'visible' }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button>}
        </div>}
      </article>
    </div>
    {book && <footer ref={footerRef} data-testid="reader-controls" style={{ ...panel, flexShrink: 0, boxShadow: '0 -4px 20px #0003', padding: '12px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)', alignItems: 'center', gap: 8 }}>
      <div data-testid="reader-narrator-status" style={{ minWidth: 0, paddingLeft: 5 }}>
        {narratorButton}
        <span data-testid="reader-state" title={read.fault || prep || read.wait || undefined} style={{ display: 'block', fontSize: 11, marginTop: 5, color: read.fault ? 'var(--rose)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{read.fault || prep || read.wait || (pendingPlayback || read.starting ? '낭독을 준비하고 있습니다' : read.playing ? '읽는 중' : book.completed ? '끝까지 들었습니다' : '이어 들을 준비가 됐습니다')}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
        <button data-testid="reader-play" aria-label={read.playing ? '낭독 멈추기' : '낭독 시작'}
          disabled={!book || !pick || !!prep || !!voiceGone || voiceUnresolved}
          title={!book ? '먼저 책을 고르세요' : !pick ? '먼저 목소리를 고르세요' : prep ? '목소리를 준비하는 중입니다' : read.playing ? '멈춥니다' : '이 자리부터 읽습니다'}
          onClick={() => {
            if (read.playing) { choosePosition(displayPosition); read.stop(); return }
            resumeFollow()
            // 고른 문단부터 읽는다 — '시작 위치' 와 '읽는 자리' 는 다른 것이다(인수인계 5항).
            if (book.completed) listenBook(book.id, true, false)
            else read.startAt(charOfParagraph[position] ?? 0)
          }}
          style={{ ...kitButton, width: 52, height: 52, borderRadius: '50%', padding: 0, color: '#fff', background: 'var(--accent)', cursor: (!book || !pick) ? 'not-allowed' : 'pointer' }}>
          <Icon name={read.playing ? 'stop' : 'play'} size={20}/>
        </button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {library && <button data-testid="reader-return-to-book" style={kitButton} onClick={() => setLibrary(false)}>본문으로</button>}
        {/* ★듣는 빠르기 — 만든 소리를 다시 만들지 않고 빠르게/느리게 듣는다(2026-09-30 지시). 낭독 전용. */}
        <PlaybackRateSelect testId="reader-rate" />
        <button ref={settingsButton} data-testid="reader-settings" aria-haspopup="dialog" aria-label="읽기 설정" title="읽기 설정 — 글자 크기 · 괄호 속 한자 · 따라가기"
          onClick={() => setSettings(true)} style={iconButton}><Icon name="settings"/></button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0, gridColumn: '1 / -1', borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
        <button data-testid="reader-chapters" style={{ ...kitButton, minHeight: 28, padding: '3px 8px' }} onClick={showChapters}><Icon name="list" size={14}/>{book.group ? '회차 ' + (chapterIndex + 1) + ' / ' + chapters.length : '서재'}</button>
        <span style={{ ...muted, minWidth: 48 }} title={`${displayPosition + 1} / ${book.paragraphs.length} 문단`}>{book.completed ? 100 : Math.round(displayPosition / Math.max(1, book.paragraphs.length) * 100)}% 읽음</span>
        <input data-testid="reader-position" type="range" aria-label="본문 위치" aria-valuetext={String((seekPosition ?? displayPosition) + 1) + '번째 문단'} min={0} max={Math.max(0, (book?.paragraphs.length || 1) - 1)} value={seekPosition ?? displayPosition}
          onChange={e => setSeekPosition(Number(e.target.value))} onPointerUp={finishSeek} onKeyUp={finishSeek} onBlur={finishSeek}
          style={{ flex: '1 1 100px', minWidth: 50, accentColor: 'var(--accent-light)' }}/>
        <SpeakerControl id="reader" />

      </div>
    </footer>}
    {finding && <Modal title="본문 찾기" close={() => setFinding(false)}>
      <input data-testid="reader-find-input" aria-label="찾을 문장" autoFocus placeholder="기억나는 문장이나 단어" value={findText} onChange={e => setFindText(e.target.value)} style={{ width: '100%', padding: 12, borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--bg-base)', color: 'var(--text-primary)', font: 'inherit', boxSizing: 'border-box' }}/>
      <div style={{ ...muted, margin: '14px 0' }}>{findText.trim() ? matches.length + '곳' : '찾을 단어를 입력하세요'}</div>
      <div style={{ display: 'grid', gap: 8, maxHeight: '50vh', overflowY: 'auto' }}>
        {matches.slice(0, 100).map(m => <button data-testid="reader-find-result" key={m.index} style={{ ...kitButton, display: 'block', textAlign: 'left', whiteSpace: 'normal', lineHeight: 1.7, padding: 12 }} onClick={() => { pickParagraph(m.index); setFinding(false); requestAnimationFrame(() => reveal(m.index, 'center', false, false)) }}>
          <span style={{ ...muted, display: 'block' }}>{m.index + 1}번째 문단</span>{m.text.length > 180 ? m.text.slice(Math.max(0, m.text.toLocaleLowerCase().indexOf(findText.trim().toLocaleLowerCase()) - 35), Math.max(0, m.text.toLocaleLowerCase().indexOf(findText.trim().toLocaleLowerCase()) - 35) + 180) + '…' : m.text}
        </button>)}
        {matches.length > 100 && <span style={muted}>앞의 100곳 · 검색어를 더 입력해 범위를 좁히세요</span>}
      </div>
    </Modal>}

    {picking && <VoicePicker title="낭독자 고르기" close={() => setPicking(false)} builtins={builtins} why={voiceNote}
      current={pick} onChoose={chooseBuiltin} onFile={() => { void pickVoiceFile() }} keepOpenOnFile
      onDropFile={file => { const path = window.api.utils.getPathForFile(file); if (path) void pickVoiceFile(path); else setError('이 파일의 위치를 읽지 못했습니다. 파일 선택을 사용해 주세요.') }}
      recent={prefs.recentVoices}
      onRecent={(r) => {
        useReader.setState({ voice: r.label, pick: { kind: 'reference', path: r.path, label: r.label } })
        updatePrefs({ recentVoices: rememberVoice(prefs.recentVoices, r), voice: { kind: 'reference', path: r.path, label: r.label } })
      }}
      confirmLabel="목소리 적용" fileLabel="음성·영상 파일에서 목소리 만들기" make={previewMaker} disabled={!!prep}
      ids={{ chip: 'reader-voice-builtin', confirm: 'reader-voice-confirm', file: 'reader-voice-file', preview: 'reader-voice-try', recent: 'reader-voice-recent' }}/>}
    {preview && <Modal title="폴더 가져오기" close={() => setPreview(null)}
      footer={<><button style={kitButton} onClick={() => setPreview(null)}>취소</button>
        <button data-testid="reader-import-confirm" style={kitPrimary} disabled={!preview.works.some(w => w.include && w.name.trim()) && !preview.scan.loose.length} onClick={confirmPreview}>
          <Icon name="folder"/>가져오기 {preview.works.filter(w => w.include).reduce((n, w) => n + w.files.length, 0) + preview.scan.loose.length}개</button></>}>
      <div data-testid="reader-import-preview" style={{ display: 'grid', gap: 8 }}>
        {preview.works.map((w, i) => <label key={w.root} data-testid="reader-import-work" title={w.root} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
          <input type="checkbox" aria-label={`${w.name} 가져오기`} checked={w.include} onChange={e => setPreview(p => p && ({ ...p, works: p.works.map((x, k) => k === i ? { ...x, include: e.target.checked } : x) }))}/>
          <input aria-label="작품 이름" data-testid="reader-import-work-name" maxLength={120} value={w.name} onChange={e => setPreview(p => p && ({ ...p, works: p.works.map((x, k) => k === i ? { ...x, name: e.target.value } : x) }))} style={{ ...kitField, flex: 1, minWidth: 0 }}/>
          <span style={{ ...muted, whiteSpace: 'nowrap' }}>{w.files.length}개</span>
        </label>)}
        {!!preview.scan.loose.length && <span style={muted}>묶지 않은 TXT {preview.scan.loose.length}개</span>}
        {!!skippedText(preview.scan) && <span data-testid="reader-import-skipped" style={muted}>건너뜀: {skippedText(preview.scan)}</span>}
      </div>
    </Modal>}
    {conflicts && <Modal title="내용이 바뀐 원본" close={() => setConflicts(null)}
      footer={<><button style={kitButton} onClick={() => setConflicts(null)}>모두 건너뛰기</button>
        <button data-testid="reader-conflict-apply" style={kitPrimary} onClick={() => { void applyConflicts() }}>적용</button></>}>
      <div data-testid="reader-conflicts" style={{ display: 'grid', gap: 10 }}>
        {conflicts.map((c, i) => <div key={c.item.path} data-testid="reader-conflict" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
          <span title={c.item.path} style={{ flex: '1 1 160px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.next.name}</span>
          <select aria-label={`${c.next.name} 처리`} data-testid="reader-conflict-choice" value={c.choice} style={kitField}
            title="교체: 이 책의 본문을 새 내용으로(읽던 자리는 같은 문단이 있을 때만 유지) · 별도 등록: 새 책으로 하나 더"
            onChange={e => setConflicts(cs => cs && cs.map((x, k) => k === i ? { ...x, choice: e.target.value as 'replace' | 'separate' | 'skip' } : x))}>
            <option value="skip">건너뛰기</option><option value="replace">교체</option><option value="separate">별도 등록</option>
          </select>
        </div>)}
      </div>
    </Modal>}
    {settings && <Modal title="읽기 설정" close={closeSettings}>
      <div data-testid="reader-settings-dialog" style={{ display: 'grid', gap: 20 }}>
        <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}><input data-testid="reader-auto-next" type="checkbox" checked={prefs.autoNext} onChange={e => updatePrefs({ autoNext: e.target.checked })}/>다음 회차 자동으로 듣기</label>
        <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
          <span>글자 크기 <span style={{ color: 'var(--text-muted)' }}>{prefs.fontSize}px</span></span>
          <input data-testid="reader-font-size" type="range" min={READER_FONT_MIN} max={READER_FONT_MAX} step={1}
            value={prefs.fontSize} onChange={e => updatePrefs({ fontSize: Number(e.target.value) })} />
        </label>
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
          <input data-testid="reader-skip-hanja" type="checkbox" checked={prefs.skipHanjaInParens}
            onChange={e => updatePrefs({ skipHanjaInParens: e.target.checked })} style={{ marginTop: 3 }} />
          <span><span title="학교(學校)는 학교만 읽고, 본문에는 그대로 표시합니다">괄호 속 한자는 읽지 않기</span>
          </span>
        </label>
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
          <input data-testid="reader-follow-setting" type="checkbox" checked={prefs.follow}
            onChange={e => { resumeFollow(); updatePrefs({ follow: e.target.checked }) }} style={{ marginTop: 3 }} />
          <span>읽는 줄 따라가기
          </span>
        </label>
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
          <input data-testid="reader-emotion" type="checkbox" checked={prefs.emotion}
            onChange={e => updatePrefs({ emotion: e.target.checked })} style={{ marginTop: 3 }} />
          <span>대사에 감정 담아 읽기
            <span data-testid="reader-emotion-note" style={{ display: 'block', fontSize: 11, color: emotionUsable ? 'var(--text-muted)' : 'var(--amber, #d4a017)', marginTop: 3 }}>
              {emotionUsable
                ? '지원하는 목소리 · 준비 시간 증가'
                : '현재 목소리는 지원하지 않습니다'}
            </span>
          </span>
        </label>
      </div>
    </Modal>}


  </section>
}
