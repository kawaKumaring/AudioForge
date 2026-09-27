// 대화 분리 작업실 — **인물 카드와 시간순 발언 목록을 한 자리에서** 다룬다.
//
// 예전에는 결과 트랙 목록과 구간 수정 목록이 서로 모르는 채 따로 쌓여 있었다.
// 여기서는 하나다 — 카드를 고르면 그 사람의 발언만 남고, 발언을 고치면 카드가 따라 바뀐다.
//
// ★화자 분석 모델을 다시 돌리지 않는다. 원본 구간을 인물별로 **배정**할 뿐이다.
// ★겹쳐 말한 자리를 한 사람의 깨끗한 목소리로 갈라내지 않는다.
// ★소리는 **공용 원본 파형**에게 부탁해 튼다. 여기서 오디오를 따로 들지 않는다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/stores/app.store'
// 결과 듣기·내보내기는 **음악 화면과 같은 부품**을 쓴다(길이를 알고 끌어 이동할 수 있다).
import { ResultPlayer, styleOf } from '@/components/ResultPlayer'
import { ResultToolbar, useResultExport } from '@/components/ResultActions'
import { formatMinSec } from '../../shared/timeFormat'
import { saveSetting, saveFailureText } from '../../shared/saveSetting'
import {
  DIALOGUE_DRAFTS_STORAGE_KEY, LEGACY_DIALOGUE_KEY, draftFor, draftsOfSource, migrateLegacy,
  parseStore, putDraft, emptyStore, type DraftStore,
} from '../../shared/dialogueDrafts'
import {
  adoptFault, analysisBasis, autoRestoreFault, displayNameOf, editedSegmentCount,
  effectiveSegment, emptyDraft, exportPlan,
  isSegmentEdited, mergeSpeakers, problemText, segmentProblem, speakerRows, unmergeSpeakers,
  type DialogueAnalysis, type DialogueDraft, type SpeakerId,
} from '../../shared/dialogueWorkspace'
import {
  linkCues, parseTimestampLines, rawTimestampFile, timelineNote, type Cue,
} from '../../shared/dialogueTranscript'
import {
  canRedo, canUndo, emptyHistory, pushHistory, redo as redoStep, sealHistory,
  undo as undoStep, type History,
} from '../../shared/undoHistory'

const fmt = (sec: number) => formatMinSec(sec)
const cloneDraft = (d: DialogueDraft): DialogueDraft => ({
  ...d, names: { ...d.names }, merges: { ...d.merges },
  edits: Object.fromEntries(Object.entries(d.edits).map(([k, v]) => [k, { ...v }])),
})
/** 지금 교정의 모양 — '이 모양으로 음원을 만들었는가' 를 이 값으로 판단한다. */
const signature = (d: DialogueDraft) => JSON.stringify([d.names, d.merges, d.edits])
/** 분석 한 벌을 가리키는 열쇠. 늦게 온 응답을 가려낼 때 쓴다. */
const keyOf = (a: DialogueAnalysis) => `${a.sourceKey}${a.runId}${a.segments.length}`
/** 엔진이 붙인 식별자에서 트랙 이름으로(화자 A → speaker_a). */
const trackOf = (id: SpeakerId) => `speaker_${(id.match(/[A-Za-z0-9]+/g) || []).join('').toLowerCase()}`

const btn = (bg: string, fg: string, off?: boolean): React.CSSProperties => ({
  padding: '5px 10px', borderRadius: 7, border: 'none', fontFamily: 'inherit', fontSize: 11,
  fontWeight: 600, background: bg, color: fg, cursor: off ? 'not-allowed' : 'pointer',
  opacity: off ? 0.45 : 1, whiteSpace: 'nowrap',
})

/** 교정본 만들기의 **단계**. 요청을 넣은 것과 결과를 받은 것은 다른 일이다. */
type ApplyState = 'idle' | 'sent' | 'running' | 'cancelling' | 'applied' | 'failed' | 'cancelled'
const APPLY_TEXT: Record<ApplyState, string> = {
  idle: '', sent: '요청을 보냈습니다', running: '교정본을 만드는 중입니다',
  // ★'멈추는 중' 과 '멈췄다' 는 다른 일이다. 멈추기가 실패하면 작업은 계속 돈다.
  cancelling: '멈추는 중입니다', applied: '',
  failed: '만들지 못했습니다 — 고친 내용은 그대로 있습니다',
  cancelled: '멈췄습니다 — 고친 내용은 그대로 있습니다',
}

interface Lines {
  text: Record<number, string>
  /** 자리가 확실하지 않은 대사 — **버리지 않고** 따로 둔다. */
  unsure: Record<number, string>
  /** 어느 발언에도 붙지 못한 원문. */
  orphans: { who: SpeakerId; cue: Cue }[]
  notes: string[]
}
const NO_LINES: Lines = { text: {}, unsure: {}, orphans: [], notes: [] }

export default function DialogueWorkspace() {
  const { dialogueAnalysis, dialogueNotice, fileInfo, status, waveRange, tracks } = useAppStore()
  const analysis = dialogueAnalysis
  const [store, setStore] = useState<DraftStore>(emptyStore)
  const [draft, setDraft] = useState<DialogueDraft | null>(null)
  const [history, setHistory] = useState<History<DialogueDraft>>(() => emptyHistory<DialogueDraft>())
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [mergePick, setMergePick] = useState<Set<SpeakerId>>(new Set())
  const [only, setOnly] = useState<SpeakerId | null>(null)
  const [showTimes, setShowTimes] = useState(false)
  const [playToken, setPlayToken] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [apply, setApply] = useState<ApplyState>('idle')
  const [appliedSig, setAppliedSig] = useState<string | null>(null)
  const [editedTracks, setEditedTracks] = useState<{ name: string; label: string; path: string }[]>([])
  const [lines, setLines] = useState<Lines>(NO_LINES)
  const [showOrphans, setShowOrphans] = useState(false)
  const [showPast, setShowPast] = useState(false)
  const [readFail, setReadFail] = useState('')
  /** 무엇을 내보낼 것인가 — 최초 결과인가 교정본인가. */
  const [target, setTarget] = useState<'original' | 'edited'>('original')
  /** 지금 펼쳐 듣는 결과 트랙 이름. 재생기는 한 번에 하나다. */
  const [openTrack, setOpenTrack] = useState<string | null>(null)
  const { note: exportNote, setNote: setExportNote, run: runExport } = useResultExport()

  const draftRef = useRef<DialogueDraft | null>(null)
  draftRef.current = draft
  /** 저장본을 실제로 읽어 왔는가. ★읽기 전에는 **절대 쓰지 않는다**(아래 설명). */
  const loadedRef = useRef('')
  const storeRef = useRef(store); storeRef.current = store
  /**
   * 사용자가 이 분석에서 **한 번이라도 고쳤는가.**
   *
   * ★장면 비교로 판단하면 안 된다 — 불러오기가 아주 빨리 끝나면 화면이 아직 앞 파일의
   *   장면을 들고 있어 '고치는 중' 으로 잘못 읽힌다(실제로 그렇게 걸렸다).
   */
  const touchedRef = useRef(false)

  // ── 교정 문서 불러오기 — **이 원본의 이 실행**에 속한 것만 ──────────────
  const loadDrafts = useCallback(async (a: DialogueAnalysis) => {
    const key = keyOf(a)
    let next: DraftStore
    try {
      const got = await window.api.settings.get() as Record<string, unknown>
      // ★옛 한 칸(`dialogueEdits`)의 기록을 버리지 않는다 — 같은 모양으로 옮겨 담는다.
      next = migrateLegacy(parseStore(got?.[DIALOGUE_DRAFTS_STORAGE_KEY]), got?.[LEGACY_DIALOGUE_KEY])
    } catch (e) {
      // ★읽기 실패를 '저장된 작업 없음' 으로 단정하지 않는다. **저장을 열지 않는다** —
      //   여기서 저장하면 읽지 못한 남의 교정까지 빈 보관함으로 덮어쓴다.
      setReadFail(`저장된 교정을 읽지 못했습니다(${(e as Error)?.message || e}). 이번 편집은 저장되지 않습니다.`)
      return
    }
    // ★늦게 온 응답이 **새 작업을 덮지 않는다.** 기다리는 사이 파일이 바뀌었을 수 있다.
    const now = useAppStore.getState().dialogueAnalysis
    if (!now || keyOf(now) !== key) return
    setReadFail('')
    setStore(next); storeRef.current = next
    const saved = draftFor(next, a.sourceKey, a.runId)
    // ★기다리는 사이 **사용자가 이미 고쳤으면** 덮지 않는다. 새 편집이 우선이다.
    const untouched = !touchedRef.current
    if (saved && untouched && !autoRestoreFault(saved, a)) {
      setDraft({ ...saved, runId: a.runId, basis: saved.basis || analysisBasis(a) })
      setMessage(saved.fromLegacy ? '이전에 고친 내용을 이어서 불러왔습니다.' : '고친 내용을 이어서 불러왔습니다.')
    } else if (saved && !untouched) {
      setMessage('저장본이 있지만 이미 고치는 중이라 덮어쓰지 않았습니다.')
    }
    loadedRef.current = key                    // 이제부터 저장해도 된다
  }, [])

  useEffect(() => {
    if (!analysis) { setDraft(null); loadedRef.current = ''; return }
    const key = keyOf(analysis)
    if (loadedRef.current === key) return
    loadedRef.current = ''                       // 아직 못 읽었다 — 저장을 막는다
    touchedRef.current = false
    setDraft({ ...emptyDraft(analysis.sourceKey, analysis.runId), basis: analysisBasis(analysis) })
    setHistory(emptyHistory<DialogueDraft>())
    setPicked(new Set()); setMergePick(new Set()); setOnly(null)
    setApply('idle'); setAppliedSig(null); setEditedTracks([]); setTarget('original')
    setMessage(''); setError(''); setReadFail(''); setExportNote(null)
    setShowOrphans(false); setShowPast(false)
    void loadDrafts(analysis)
  }, [analysis, loadDrafts])

  // ── 저장 — 파일별·실행별로 나눠 담는다 ───────────────────────────────────
  useEffect(() => {
    if (!draft || !analysis) return
    const key = keyOf(analysis)
    const save = () => {
      // ★**읽기 전에는 쓰지 않는다.** 예전에는 빈 초안이 먼저 저장돼 **저장본 전체를
      //   지웠다**(읽기가 늦으면 빈 보관함을 그대로 덮어썼다). 재현해서 고쳤다.
      if (loadedRef.current !== key) return
      const cur = draftRef.current
      if (!cur) return
      const next = putDraft(storeRef.current, { ...cur, updatedAt: Date.now() })
      storeRef.current = next
      setStore(next)
      void saveSetting(window.api.settings.set, DIALOGUE_DRAFTS_STORAGE_KEY, next)
        .then((why) => { if (why) setError(saveFailureText(why)) })
    }
    const t = setTimeout(save, 600)
    return () => { clearTimeout(t); save() }
  }, [draft, analysis])

  // ── 받아쓴 대본 — **최초 분석의 화자·발언**에 붙인다 ─────────────────────
  useEffect(() => {
    setLines(NO_LINES)
    if (!analysis || !analysis.transcribe || !analysis.outputDir) return
    const key = keyOf(analysis)
    let alive = true
    void (async () => {
      const out: Lines = { text: {}, unsure: {}, orphans: [], notes: [] }
      // ★최초 분석이 낸 화자 전부를 돈다. 합치기·재배정으로 화면에서 사라진 인물의
      //   대본 파일도 **빠뜨리지 않는다**(예전에는 지금 보이는 인물만 읽어 누락됐다).
      const original = [...new Set(analysis.segments.map((sg) => sg.speaker))]
      for (const id of original) {
        const segs = analysis.segments
          .map((sg, i) => ({ index: i, start: sg.start, end: sg.end, who: sg.speaker }))
          .filter((x) => x.who === id)
        let raw = ''
        try {
          raw = await window.api.dialogue.readTranscript(analysis.outputDir, rawTimestampFile(trackOf(id)))
        } catch { raw = '' }
        if (!raw) continue
        const { cues } = parseTimestampLines(raw)
        const link = linkCues(cues, segs)
        Object.assign(out.text, link.text)
        Object.assign(out.unsure, link.unsure)
        for (const c of link.orphans) out.orphans.push({ who: id, cue: c })
        const note = timelineNote(cues, link, segs, analysis.durationSec)
        if (note.reason) out.notes.push(`${id}: ${note.reason}`)
      }
      // ★대사는 **발언 번호**에 붙어 있다 — 나중에 그 발언을 다른 인물에게 옮겨도
      //   대사는 그 발언을 따라간다. 다른 발언으로 다시 붙이지 않는다.
      if (alive && keyOf(useAppStore.getState().dialogueAnalysis || analysis) === key) setLines(out)
    })()
    return () => { alive = false }
  }, [analysis])

  // ── 소리: 원본 구간은 공용 파형, 결과 트랙은 공용 재생기 ────────────────
  useEffect(() => { if (!waveRange && playToken?.startsWith('seg:')) setPlayToken(null) }, [waveRange, playToken])
  /** 결과 재생기를 닫는다 — 원본 구간을 틀기 전에 부른다(두 소리가 겹치지 않게). */
  const stopTrack = useCallback(() => { setOpenTrack(null) }, [])

  const playRange = useCallback((token: string, start: number, end: number) => {
    stopTrack()
    const st = useAppStore.getState()
    if (playToken === token) { st.clearWaveRange(); setPlayToken(null); return }
    setPlayToken(token)
    st.requestWaveRange(start, end)
  }, [playToken, stopTrack])

  /** 결과 트랙 듣기 — 파형·이동·음량·원곡 비교가 **음악 화면과 같다**. */
  const playTrack = useCallback((name: string) => {
    useAppStore.getState().clearWaveRange()
    setPlayToken(null)
    setOpenTrack((cur) => (cur === name ? null : name))
  }, [])

  // ── 고치기 ───────────────────────────────────────────────────────────────
  const change = useCallback((kind: string, fn: (d: DialogueDraft) => DialogueDraft, seal = true) => {
    touchedRef.current = true
    setHistory((h) => {
      const cur = draftRef.current
      return cur ? pushHistory(h, cur, kind, cloneDraft, ['name:']) : h
    })
    setDraft((d) => (d ? fn(d) : d))
    if (seal) setHistory((h) => sealHistory(h))
  }, [])

  const doUndo = useCallback(() => {
    const cur = draftRef.current
    if (!cur) return
    const r = undoStep(history, cur, cloneDraft)
    if (!r) return
    setHistory(r.history); setDraft(r.snap)
  }, [history])
  const doRedo = useCallback(() => {
    const cur = draftRef.current
    if (!cur) return
    const r = redoStep(history, cur, cloneDraft)
    if (!r) return
    setHistory(r.history); setDraft(r.snap)
  }, [history])

  const rows = useMemo(() => (analysis && draft ? speakerRows(analysis, draft) : []), [analysis, draft])
  const plan = useMemo(() => (analysis && draft ? exportPlan(analysis, draft) : null), [analysis, draft])
  const changed = analysis && draft ? editedSegmentCount(analysis, draft) : 0
  const renamed = draft ? Object.keys(draft.names).length : 0
  const merged = draft ? Object.keys(draft.merges).length : 0
  const hasEdits = changed > 0 || renamed > 0 || merged > 0
  const dirty = draft ? signature(draft) !== appliedSig : false
  const busy = apply === 'sent' || apply === 'running' || apply === 'cancelling'
  const running = status === 'processing' || busy
  /** 같은 원본의 **다른 실행**에 남아 있는 교정 — 지우지 않고 다시 꺼낼 수 있게 둔다. */
  const past = useMemo(() => (analysis
    ? draftsOfSource(store, analysis.sourceKey).filter((d) => d.runId !== analysis.runId)
    : []), [store, analysis])

  /**
   * 진행 중인 교정본 요청의 **구독 해제 손잡이.**
   *
   * ★예전에는 콜백 안에서만 끊었다. 그래서 화면을 떠나거나 분석이 바뀌면 통로가 남아,
   *   뒤늦게 온 남의 결과가 사라진 화면의 상태를 건드렸다.
   *   이제 화면이 손잡이를 쥐고, 떠날 때와 분석이 바뀔 때 반드시 끊는다.
   */
  const applyOff = useRef<() => void>(() => { /* noop */ })
  useEffect(() => () => { applyOff.current(); applyOff.current = () => { /* noop */ } }, [])
  useEffect(() => {
    // 분석이 바뀌면 지난 요청의 통로를 끊는다 — 그 결과는 이제 이 화면의 것이 아니다.
    return () => { applyOff.current(); applyOff.current = () => { /* noop */ } }
  }, [analysis?.runId])

  // ── 교정본 만들기 — **요청 접수와 완료를 나눈다** ────────────────────────
  const rebuild = useCallback(async () => {
    if (!analysis || !draft || !plan || !fileInfo?.path) return
    setError(''); setMessage(''); setExportNote(null)
    if (!plan.segments.length) { setError('쓸 수 있는 구간이 없습니다.'); return }
    // ★요청마다 식별자를 붙인다. **그 요청의 결과가 실제로 올 때만** 적용 완료로 본다.
    //   만드는 동안 더 고쳐도, 완성된 음원은 **요청할 때의 교정본**이다.
    const reqId = `dlgfix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const want = signature(draft)
    setApply('sent')
    useAppStore.getState().clearWaveRange()
    stopTrack()

    let offResult = () => { /* noop */ }
    let offError = () => { /* noop */ }
    let offCancelling = () => { /* noop */ }
    let offCancelled = () => { /* noop */ }
    let offCancelFailed = () => { /* noop */ }
    const finish = () => { offResult(); offError(); offCancelling(); offCancelled(); offCancelFailed() }
    applyOff.current()                 // 앞 요청이 남아 있으면 먼저 끊는다
    applyOff.current = finish
    const mine = (d: unknown) => (d as { clientRequestId?: string } | null)?.clientRequestId === reqId
    offResult = window.api.audio.onResult((data: unknown) => {
      if (!mine(data)) return                        // 내 요청의 결과가 아니다
      finish()
      const got = Array.isArray((data as { tracks?: unknown }).tracks)
        ? (data as { tracks: { name: string; label: string; path: string }[] }).tracks : []
      setEditedTracks(got)
      setAppliedSig(want)                            // **요청 당시** 교정본에 해당한다
      setApply('applied')
      if (got.length) setTarget('edited')
      setMessage(`요청한 교정본으로 인물별 음원 ${got.length}개를 만들었습니다. 최초 결과는 그대로 있습니다.`)
    })
    offError = window.api.audio.onError((data: unknown) => {
      if (!mine(data)) return
      finish()
      setApply('failed')
      setError((data as { message?: string })?.message || '교정본을 만들지 못했습니다.')
    })
    /**
     * ★취소는 **세 걸음**이다: 멈추는 중 → 멈췄다 / 멈추지 못했다.
     *   예전에는 첫 걸음에서 결과·오류 통로를 끊고 '멈췄다' 고 적었다. 그런데 멈추기가
     *   실패하면 작업은 계속 돌고, 그 결과가 올 통로는 이미 없다 —
     *   화면은 '멈췄다' 인데 음원이 만들어지는 상태가 된다.
     *   그래서 여기서는 **표시만 바꾸고 통로는 그대로 둔다.**
     */
    offCancelling = window.api.audio.onCancelling?.((d?: unknown) => {
      if (d && !mine(d)) return          // 식별자가 있으면 대조한다(없으면 기다리던 것이 내 것뿐이다)
      setApply('cancelling')
    }) || (() => { /* 이 통로가 없는 환경 */ })
    offCancelled = window.api.audio.onCancelled?.((d?: unknown) => {
      if (d && !mine(d)) return
      finish()                           // 정말 멈췄다 — 이제 올 것이 없다
      setApply('cancelled')
    }) || (() => { /* 이 통로가 없는 환경 */ })
    offCancelFailed = window.api.audio.onCancelFailed?.((d: unknown) => {
      if (d && !mine(d)) return
      // ★멈추지 못했다 — 작업은 계속 돈다. 통로를 **끊지 않는다.**
      setApply('running')
      setError('멈추지 못했습니다. 작업이 계속 돌고 있습니다 — 고친 내용은 그대로 있습니다.')
    }) || (() => { /* 이 통로가 없는 환경 */ })

    try {
      const r = await window.api.audio.process(fileInfo.path, 'dialogue-rebuild', {
        clientRequestId: reqId, dialogueSegments: plan.segments,
      })
      // ★접수 응답을 완료로 보지 않는다. 다음 단계로만 넘긴다.
      if (r && (r as { error?: unknown }).error) {
        finish(); setApply('failed'); setError(String((r as { error?: unknown }).error))
        return
      }
      setApply((cur) => (cur === 'sent' ? 'running' : cur))
    } catch (e) {
      finish(); setApply('failed')
      setError(e instanceof Error ? e.message : '교정본을 만들지 못했습니다.')
    }
  }, [analysis, draft, plan, fileInfo?.path, stopTrack])

  // ── 내보내기 — **무엇을 내보내는지 분명히** ──────────────────────────────
  const effTarget = editedTracks.length ? target : 'original'
  const shown = effTarget === 'edited' ? editedTracks : tracks
  if (!analysis || !draft) {
    if (!dialogueNotice) return null
    return (
      <div data-testid="dialogue-workspace" role="status" style={{
        padding: 12, borderRadius: 12, background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-muted)',
      }}>{dialogueNotice}</div>
    )
  }

  const visible = analysis.segments
    .map((_s, i) => i)
    .filter((i) => !only || effectiveSegment(analysis, draft, i).speaker === only)

  const unsureCount = Object.keys(lines.unsure).length + lines.orphans.length
  const applyText = !hasEdits ? '고친 곳이 없습니다'
    : APPLY_TEXT[apply] || (dirty
      ? '고친 내용이 아직 음원에 반영되지 않았습니다 (교정은 저장됩니다)'
      : '고친 내용으로 음원을 만들었습니다')

  return (
    <div data-testid="dialogue-workspace" style={{
      display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 12,
      background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
    }}>
      {/* ── 머리: 상태와 되돌리기 ───────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>대화 작업실</span>
        <span data-testid="dialogue-state" style={{ fontSize: 10, color: 'var(--text-muted)' }}
          title="인물 카드를 고르면 그 사람의 발언만 봅니다. 발언을 고쳐도 최초 분석값은 남습니다.">
          인물 {rows.length}명 · 발언 {analysis.segments.length}개
          {hasEdits ? ` · 고친 곳 ${changed + renamed + merged}` : ''}
        </span>
        {past.length > 0 && (
          <button type="button" data-testid="dialogue-past-toggle" onClick={() => setShowPast((v) => !v)}
            aria-pressed={showPast}
            title="같은 원본을 앞서 분석했을 때의 교정입니다. 지우지 않고 보관합니다. 구간이 달라졌을 수 있어 저절로 적용하지는 않습니다."
            style={{ ...btn('transparent', 'var(--text-muted)'), padding: '2px 6px', fontSize: 10 }}>
            이전 분석 교정 {past.length}건
          </button>
        )}
        <span style={{ display: 'flex', gap: 4, marginLeft: 'auto', flex: '0 0 auto' }}>
          {([['undo', '되돌리기', !canUndo(history), doUndo],
             ['redo', '다시 적용', !canRedo(history), doRedo]] as const).map(([k, label, off, act]) => (
            <button type="button" key={k} data-testid={`dialogue-${k}`} aria-label={label}
              title={off ? `${label}할 것이 없습니다` : label} disabled={off} onClick={act}
              style={{ ...btn('transparent', off ? 'var(--text-muted)' : 'var(--text-primary)', off), padding: '4px 8px' }}>
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                style={k === 'redo' ? { transform: 'scaleX(-1)' } : undefined}>
                <path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>
              </svg>
            </button>
          ))}
        </span>
      </div>

      {/* 저장을 못 읽었다 — 숨기지 않고, 다시 해 볼 길을 준다. */}
      {readFail && (
        <div data-testid="dialogue-read-fail" role="alert" style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          fontSize: 11, color: 'var(--rose, #fb7185)',
        }}>
          <span>{readFail}</span>
          <button type="button" data-testid="dialogue-read-retry"
            onClick={() => { setReadFail(''); void loadDrafts(analysis) }}
            style={btn('var(--bg-elevated)', 'var(--text-primary)')}>다시 읽기</button>
        </div>
      )}

      {/* 이전 분석의 교정 — 보관만 하고, **사용자가 고를 때만** 가져온다. */}
      {showPast && past.length > 0 && (
        <div data-testid="dialogue-past-list" style={{
          display: 'flex', flexDirection: 'column', gap: 4, padding: 8, borderRadius: 8,
          background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
        }}>
          {past.slice(0, 8).map((d) => {
            const n = Object.keys(d.edits).length + Object.keys(d.names).length + Object.keys(d.merges).length
            // ★runId 를 현재 값으로 바꿔치기해서 검증을 건너뛰지 않는다(2026-09-27 재현).
            const why = adoptFault(d, analysis)
            return (
              <div key={d.runId || 'legacy'} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  고친 곳 {n}개 · {d.updatedAt ? new Date(d.updatedAt).toLocaleString() : '시각 없음'}
                  {why ? ` · ${why}` : ''}
                </span>
                <button type="button" data-testid="dialogue-past-load" disabled={!!why}
                  data-fault={why}
                  title={why ? `${why} 보관은 그대로 둡니다.`
                    : '이 교정을 지금 분석에 가져옵니다. 되돌리기로 되돌릴 수 있습니다.'}
                  onClick={() => {
                    if (adoptFault(d, analysis)) return        // 누르는 순간에도 다시 본다
                    change('past:' + d.runId, () => ({
                      ...cloneDraft(d), sourceKey: analysis.sourceKey, runId: analysis.runId,
                      basis: analysisBasis(analysis),
                    }))
                    setMessage('이전 분석의 교정을 가져왔습니다. 되돌리기로 되돌릴 수 있습니다.')
                    setShowPast(false)
                  }}
                  style={{ ...btn('var(--bg-elevated)', 'var(--text-primary)', !!why), padding: '2px 8px', fontSize: 10 }}>
                  가져오기
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* ── 인물 카드 줄 — 좁으면 가로로 민다 ──────────────────────────── */}
      <div data-testid="dialogue-cards" style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
        <button type="button" data-testid="dialogue-card-all" onClick={() => setOnly(null)}
          aria-pressed={only === null} title="모든 인물의 발언을 봅니다"
          style={{
            ...btn(only === null ? 'var(--bg-elevated)' : 'transparent', 'var(--text-primary)'),
            flex: '0 0 auto', minWidth: 64, alignSelf: 'flex-start',
            border: `1px solid ${only === null ? 'var(--cyan)' : 'var(--border-subtle)'}`,
          }}>전체</button>
        {rows.map((r) => {
          const on = only === r.id
          const token = `spk:${r.id}`
          return (
            <div key={r.id} data-testid="dialogue-card" data-speaker={r.id} data-selected={on ? '1' : '0'}
              style={{
                flex: '0 0 auto', minWidth: 156, display: 'flex', flexDirection: 'column', gap: 5,
                padding: 8, borderRadius: 10, background: 'var(--bg-base)',
                border: `1px solid ${on ? 'var(--cyan)' : 'var(--border-subtle)'}`,
              }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <input data-testid="dialogue-card-merge" type="checkbox" checked={mergePick.has(r.id)}
                  onChange={() => setMergePick((s) => {
                    const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n
                  })}
                  aria-label={`${r.name} 합치기 대상`} title="합칠 인물을 고릅니다"
                  style={{ accentColor: 'var(--cyan)', cursor: 'pointer', flexShrink: 0 }} />
                <input data-testid="dialogue-card-name" value={displayNameOf(draft, r.id)}
                  onChange={(e) => change(`name:${r.id}`, (d) => ({ ...d, names: { ...d.names, [r.id]: e.target.value } }), false)}
                  onBlur={() => setHistory((h) => sealHistory(h))}
                  aria-label={`${r.id} 이름`} title="보여 줄 이름입니다. 파일 이름은 이것과 따로 안전하게 만듭니다."
                  style={{
                    flex: 1, minWidth: 0, padding: '3px 6px', borderRadius: 5, fontSize: 11,
                    border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
                    color: 'var(--text-primary)', fontFamily: 'inherit', outline: 'none',
                  }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button type="button" data-testid="dialogue-card-play"
                  onClick={() => r.longest && playRange(token, r.longest.start, r.longest.end)}
                  disabled={!r.longest} aria-label={`${r.name} 대표 구간 듣기`}
                  title="이 인물의 가장 긴 구간을 파형에서 들려줍니다"
                  style={{ ...btn('var(--bg-elevated)', 'var(--text-primary)', !r.longest), padding: '2px 8px' }}>
                  {playToken === token ? '■' : '▶'}
                </button>
                <span data-testid="dialogue-card-count" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  발언 {r.count}개 · {fmt(r.totalSec)}
                </span>
              </div>
              {r.absorbed.length > 0 && (
                <button type="button" data-testid="dialogue-card-unmerge"
                  onClick={() => change(`unmerge:${Date.now()}`, (d) => unmergeSpeakers(d, r.absorbed))}
                  title="합친 것을 되돌립니다"
                  style={{ ...btn('transparent', 'var(--amber, #d4a017)'), padding: '1px 5px', fontSize: 10 }}>
                  {r.absorbed.join('·')} 합침 — 풀기
                </button>
              )}
              <button type="button" data-testid="dialogue-card-filter" onClick={() => setOnly(on ? null : r.id)}
                aria-pressed={on} title="이 인물의 발언만 봅니다"
                style={{ ...btn('transparent', on ? 'var(--cyan)' : 'var(--text-muted)'), padding: '1px 5px', fontSize: 10 }}>
                {on ? '전체 보기' : '이 인물만'}
              </button>
            </div>
          )
        })}
      </div>

      {mergePick.size >= 2 && (
        <div data-testid="dialogue-merge-bar" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>고른 {mergePick.size}명을 하나로</span>
          {[...mergePick].map((id) => (
            <button type="button" key={id} data-testid="dialogue-merge-into"
              onClick={() => {
                const from = [...mergePick].filter((x) => x !== id)
                change(`merge:${Date.now()}`, (d) => mergeSpeakers(d, from, id))
                setMergePick(new Set())
                setMessage('합쳤습니다. 되돌리기 한 번으로 되돌릴 수 있습니다.')
              }}
              title={`${displayNameOf(draft, id)} 쪽으로 합칩니다`}
              style={btn('var(--cyan)', '#fff')}>{displayNameOf(draft, id)}(으)로</button>
          ))}
          <button type="button" onClick={() => setMergePick(new Set())} style={btn('transparent', 'var(--text-muted)')}>취소</button>
        </div>
      )}

      {/* ── 시간순 발언 목록 ────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>
          발언 {visible.length}개{only ? ` · ${displayNameOf(draft, only)}` : ''}
        </span>
        {picked.size > 0 && (
          <span data-testid="dialogue-bulk" style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{picked.size}개 선택 →</span>
            {rows.map((r) => (
              <button type="button" key={r.id} data-testid="dialogue-bulk-assign"
                onClick={() => {
                  change(`assign:${Date.now()}`, (d) => {
                    const edits = { ...d.edits }
                    for (const i of picked) edits[i] = { ...(edits[i] || {}), speaker: r.id }
                    return { ...d, edits }
                  })
                  setPicked(new Set())
                }}
                title={`고른 발언을 ${r.name} 에게 옮깁니다`}
                style={btn('var(--bg-elevated)', 'var(--text-primary)')}>{r.name}</button>
            ))}
            <button type="button" onClick={() => setPicked(new Set())} style={btn('transparent', 'var(--text-muted)')}>해제</button>
          </span>
        )}
        {unsureCount > 0 && (
          <button type="button" data-testid="dialogue-unsure-toggle" onClick={() => setShowOrphans((v) => !v)}
            aria-pressed={showOrphans}
            title="받아쓴 시각이 발언과 잘 맞지 않는 줄입니다. 원문을 버리지 않고 여기 남겨 둡니다."
            style={{ ...btn('transparent', 'var(--amber, #d4a017)'), padding: '2px 6px', fontSize: 10 }}>
            확인 필요 {unsureCount}
          </button>
        )}
        <button type="button" data-testid="dialogue-toggle-times" onClick={() => setShowTimes((v) => !v)}
          aria-pressed={showTimes} title="시작·끝을 직접 고칩니다"
          style={{ ...btn('transparent', showTimes ? 'var(--cyan)' : 'var(--text-muted)'), marginLeft: 'auto' }}>
          시간 고치기
        </button>
      </div>

      {showOrphans && lines.orphans.length > 0 && (
        <div data-testid="dialogue-orphans" style={{
          display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 120, overflowY: 'auto',
          padding: 8, borderRadius: 8, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
        }}>
          {lines.orphans.slice(0, 40).map((o, k) => (
            <div key={k} style={{ display: 'flex', gap: 6, fontSize: 10, color: 'var(--text-secondary)' }}>
              <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                {o.who} {fmt(o.cue.start)}
              </span>
              <span style={{ minWidth: 0 }}>{o.cue.text}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 360, overflowY: 'auto' }}>
        {visible.map((i) => {
          const cur = effectiveSegment(analysis, draft, i)
          const edited = isSegmentEdited(analysis, draft, i)
          const problem = segmentProblem(cur, analysis.durationSec)
          const token = `seg:${i}`
          const sure = lines.text[i]
          const maybe = lines.unsure[i]
          return (
            <div key={i} data-testid="dialogue-row" data-edited={edited ? '1' : '0'} data-problem={problem || ''}
              data-text={sure ? 'sure' : maybe ? 'unsure' : ''}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '3px 5px', borderRadius: 7,
                flexWrap: 'wrap',
                background: playToken === token ? 'var(--bg-elevated)' : 'transparent',
                borderLeft: `3px solid ${edited ? 'var(--cyan)' : 'transparent'}`,
                outline: problem ? '1px solid var(--rose, #fb7185)' : 'none',
              }}>
              <input type="checkbox" data-testid="dialogue-pick" checked={picked.has(i)}
                onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })}
                aria-label={`${i + 1}번째 발언 고르기`}
                style={{ accentColor: 'var(--cyan)', cursor: 'pointer', flexShrink: 0 }} />
              <button type="button" data-testid="dialogue-play" onClick={() => playRange(token, cur.start, cur.end)}
                aria-label={`${i + 1}번째 발언 듣기`} title="파형에서 이 구간을 들려줍니다"
                style={{ ...btn('transparent', 'var(--text-primary)'), padding: '2px 5px' }}>
                {playToken === token ? '■' : '▶'}
              </button>
              <select data-testid="dialogue-speaker" value={cur.speaker}
                onChange={(e) => change(`assign:${i}:${Date.now()}`, (d) => ({
                  ...d, edits: { ...d.edits, [i]: { ...(d.edits[i] || {}), speaker: e.target.value } },
                }))}
                aria-label={`${i + 1}번째 발언의 인물`}
                style={{
                  fontFamily: 'inherit', fontSize: 11, padding: '3px 5px', borderRadius: 6, flexShrink: 0,
                  border: `1px solid ${edited ? 'var(--cyan)' : 'var(--border-subtle)'}`,
                  background: 'var(--bg-base)', color: 'var(--text-primary)',
                }}>
                {rows.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                {!rows.some((r) => r.id === cur.speaker) && <option value={cur.speaker}>{cur.speaker}</option>}
              </select>
              <span data-testid="dialogue-time" style={{ fontSize: 10, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                {fmt(cur.start)}–{fmt(cur.end)}
              </span>
              <span data-testid="dialogue-text"
                title={maybe && !sure ? '받아쓴 시각이 이 발언과 잘 맞지 않습니다 — 확인해 주세요' : undefined}
                style={{
                  flex: '1 1 160px', minWidth: 0, fontSize: 11,
                  color: sure ? 'var(--text-primary)' : maybe ? 'var(--amber, #d4a017)' : 'var(--text-muted)',
                }}>
                {sure || (maybe ? '? ' + maybe : (analysis.transcribe ? '—' : ''))}
              </span>
              {showTimes && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  {(['start', 'end'] as const).map((k) => (
                    <input key={k} data-testid={`dialogue-${k}`} type="number" step="0.1" min="0" value={cur[k]}
                      onChange={(e) => change(`time:${i}:${Date.now()}`, (d) => ({
                        ...d, edits: { ...d.edits, [i]: { ...(d.edits[i] || {}), [k]: Number(e.target.value) } },
                      }))}
                      aria-label={`${i + 1}번째 발언 ${k === 'start' ? '시작' : '끝'}(초)`}
                      style={{
                        width: 70, fontFamily: 'inherit', fontSize: 11, padding: '2px 4px', borderRadius: 5,
                        border: '1px solid var(--border-subtle)', background: 'var(--bg-base)', color: 'var(--text-primary)',
                      }} />
                  ))}
                </span>
              )}
              {problem && <span style={{ fontSize: 10, color: 'var(--rose, #fb7185)' }}>{problemText(problem)}</span>}
              {edited && (
                <button type="button" data-testid="dialogue-revert"
                  onClick={() => change(`revert:${i}:${Date.now()}`, (d) => {
                    const edits = { ...d.edits }; delete edits[i]; return { ...d, edits }
                  })}
                  title="이 발언을 처음 분석한 값으로 되돌립니다"
                  style={{ ...btn('transparent', 'var(--text-muted)'), padding: '1px 5px', fontSize: 10 }}>되돌리기</button>
              )}
            </div>
          )
        })}
      </div>

      {/* ── 아래: 만들기와 내보내기 ─────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        paddingTop: 8, borderTop: '1px solid var(--border-subtle)',
      }}>
        <button type="button" data-testid="dialogue-rebuild" onClick={() => { void rebuild() }}
          disabled={running || !plan?.segments.length || !hasEdits}
          title="고친 내용으로 인물별 음원을 새로 만듭니다. 화자 분석을 다시 돌리지 않고, 최초 결과도 그대로 둡니다."
          style={btn('var(--cyan)', '#fff', running || !plan?.segments.length || !hasEdits)}>
          {busy ? '만드는 중…' : '교정본 만들기'}
        </button>
        {/* ★고친 것과 **만든 것**을 구분해 말한다. 요청을 넣은 것만으로 '만들었다' 고 하지 않는다. */}
        <span data-testid="dialogue-apply-state" style={{
          fontSize: 10,
          color: (apply === 'failed' || apply === 'cancelled') ? 'var(--rose, #fb7185)'
            : (hasEdits && dirty) ? 'var(--amber, #d4a017)' : 'var(--text-muted)',
        }}>{applyText}</span>

        <span style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap' }}>
          <ResultToolbar what={effTarget === 'edited' ? '교정본' : '최초 결과'}
            paths={shown.map((t) => t.path)} outputDir={analysis.outputDir} note={exportNote}
            onExport={(paths, what) => { void runExport(paths, what) }}>
            {/* ★무엇을 듣고 무엇을 내보내는지 한 곳에서 고른다. */}
            <span data-testid="dialogue-export-target" style={{ display: 'flex', gap: 2 }}>
              {([['original', '최초 결과'], ['edited', '교정본']] as const).map(([id, label]) => {
                const off = id === 'edited' && !editedTracks.length
                return (
                  <button type="button" key={id} data-testid={`dialogue-target-${id}`}
                    onClick={() => { stopTrack(); setPlayToken(null); setTarget(id) }} disabled={off}
                    aria-pressed={effTarget === id}
                    title={off ? '교정본을 아직 만들지 않았습니다' : `${label}을(를) 듣고 내보냅니다`}
                    style={{
                      ...btn(effTarget === id ? 'var(--bg-elevated)' : 'transparent',
                        effTarget === id ? 'var(--text-primary)' : 'var(--text-muted)', off),
                      padding: '3px 8px', fontSize: 10,
                      border: `1px solid ${effTarget === id ? 'var(--cyan)' : 'transparent'}`,
                    }}>{label}</button>
                )
              })}
            </span>
          </ResultToolbar>
        </span>
      </div>

      {/* 결과 듣기 — 지금 고른 쪽만 보여 준다(같은 결과를 두 군데에 쌓지 않는다). */}
      {shown.length > 0 && (
        <div data-testid="dialogue-result-tracks" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {shown.map((t) => {
              const on = openTrack === t.name
              return (
                <button type="button" key={t.name} data-testid="dialogue-track-play"
                  onClick={() => playTrack(t.name)} aria-pressed={on} aria-label={`${t.label} 듣기`}
                  title={`${effTarget === 'edited' ? '교정본' : '최초 결과'} — ${t.label}`}
                  style={{
                    ...btn(on ? 'var(--bg-elevated)' : 'transparent', 'var(--text-primary)'),
                    padding: '3px 9px', fontSize: 10,
                    border: `1px solid ${on ? styleOf(t.name).color : 'var(--border-subtle)'}`,
                  }}>
                  {on ? '■' : '▶'} {t.label}
                </button>
              )
            })}
          </div>
          {/* 펼친 것 하나만 재생기를 연다 — 소리가 겹치지 않는다. */}
          {shown.filter((t) => t.name === openTrack).map((t) => (
            <ResultPlayer key={`${effTarget}:${t.name}`} path={t.path} color={styleOf(t.name).color}
              paused={false} onClose={() => setOpenTrack(null)}
              originalPath={fileInfo?.path || null} originalLabel={fileInfo?.name} />
          ))}
        </div>
      )}


      {plan && plan.blocked.length > 0 && (
        <div data-testid="dialogue-blocked" role="alert" style={{ fontSize: 10, lineHeight: 1.6, color: 'var(--rose, #fb7185)' }}>
          시간이 올바르지 않은 발언 {plan.blocked.length}개는 빠집니다 —
          {plan.blocked.slice(0, 3).map((b) => ` ${b.index + 1}번(${problemText(b.problem)})`)}
        </div>
      )}
      {lines.notes.length > 0 && (
        <span data-testid="dialogue-text-note" tabIndex={0} style={{ fontSize: 10, color: 'var(--amber, #d4a017)' }}
          title={lines.notes.join(' · ')}>
          대본 확인 {lines.notes.length}건
        </span>
      )}
      {analysis.overlaps.length > 0 && (
        <span data-testid="dialogue-overlaps" tabIndex={0} style={{ fontSize: 10, color: 'var(--amber, #d4a017)' }}
          title="찾았다는 뜻일 뿐, 그 부분의 목소리를 사람마다 갈라낸 것은 아닙니다. 겹친 자리는 양쪽 트랙에 함께 들어갑니다.">
          동시에 말한 구간 {analysis.overlaps.length}곳
        </span>
      )}
      {(error || message) && (
        <div data-testid="dialogue-message" role="status" style={{
          fontSize: 11, lineHeight: 1.6, color: error ? 'var(--rose, #fb7185)' : 'var(--text-secondary)',
        }}>{error || message}</div>
      )}
    </div>
  )
}
