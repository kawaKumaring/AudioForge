// 대화 분리 작업실 — **인물 카드와 시간순 발언 목록을 한 자리에서** 다룬다.
//
// 예전에는 결과 트랙 목록과 구간 수정 목록이 서로 모르는 채 따로 쌓여 있었다.
// 여기서는 하나다 — 카드를 고르면 그 사람의 발언만 남고, 발언을 고치면 카드가 따라 바뀐다.
//
// ★화자 분석 모델을 다시 돌리지 않는다. 원본 구간을 인물별로 **배정**할 뿐이다.
// ★겹쳐 말한 자리를 한 사람의 깨끗한 목소리로 갈라내지 않는다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/stores/app.store'
import { createManagedAudio } from '@/lib/playbackVolume'
import { formatMinSec } from '../../shared/timeFormat'
import { saveSetting, saveFailureText } from '../../shared/saveSetting'
import {
  DIALOGUE_DRAFTS_STORAGE_KEY, LEGACY_DIALOGUE_KEY, draftFor, migrateLegacy,
  parseStore, putDraft, emptyStore, type DraftStore,
} from '../../shared/dialogueDrafts'
import {
  displayNameOf, draftMatches, editedSegmentCount, effectiveSegment, emptyDraft, exportPlan,
  isSegmentEdited, mergeSpeakers, problemText, segmentProblem, speakerRows, unmergeSpeakers,
  type DialogueDraft, type SpeakerId,
} from '../../shared/dialogueWorkspace'
import {
  assignCues, checkTimeline, parseTimestampLines, rawTimestampFile,
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
/** 지금 교정의 모양 — '적용했는가' 를 이 값으로 판단한다. */
const signature = (d: DialogueDraft) => JSON.stringify([d.names, d.merges, d.edits])

const btn = (bg: string, fg: string, off?: boolean): React.CSSProperties => ({
  padding: '5px 10px', borderRadius: 7, border: 'none', fontFamily: 'inherit', fontSize: 11,
  fontWeight: 600, background: bg, color: fg, cursor: off ? 'not-allowed' : 'pointer',
  opacity: off ? 0.45 : 1, whiteSpace: 'nowrap',
})

export default function DialogueWorkspace() {
  const { dialogueAnalysis, dialogueNotice, fileInfo, fileUrl, status } = useAppStore()
  const analysis = dialogueAnalysis
  const [store, setStore] = useState<DraftStore>(emptyStore)
  const [draft, setDraft] = useState<DialogueDraft | null>(null)
  const [history, setHistory] = useState<History<DialogueDraft>>(() => emptyHistory<DialogueDraft>())
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [mergePick, setMergePick] = useState<Set<SpeakerId>>(new Set())
  const [only, setOnly] = useState<SpeakerId | null>(null)
  const [showTimes, setShowTimes] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [appliedSig, setAppliedSig] = useState<string | null>(null)
  const [lines, setLines] = useState<{ text: Record<number, string>; notes: string[] }>({ text: {}, notes: [] })
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const stopAtRef = useRef<number | null>(null)
  const loadedFor = useRef('')

  const draftRef = useRef<DialogueDraft | null>(null)
  draftRef.current = draft

  // ── 교정 문서 불러오기 — **이 원본의 이 실행**에 속한 것만 ──────────────
  useEffect(() => {
    if (!analysis) { setDraft(null); loadedFor.current = ''; return }
    const key = `${analysis.sourceKey}|${analysis.runId}|${analysis.segments.length}`
    if (loadedFor.current === key) return
    loadedFor.current = key
    setDraft(emptyDraft(analysis.sourceKey, analysis.runId))
    setHistory(emptyHistory<DialogueDraft>())
    setPicked(new Set()); setMergePick(new Set()); setOnly(null)
    setAppliedSig(null); setMessage(''); setError('')
    void (async () => {
      try {
        const got = await window.api.settings.get() as Record<string, unknown>
        // ★옛 한 칸(`dialogueEdits`)의 기록을 버리지 않는다 — 같은 모양으로 옮겨 담는다.
        const next = migrateLegacy(parseStore(got?.[DIALOGUE_DRAFTS_STORAGE_KEY]), got?.[LEGACY_DIALOGUE_KEY])
        setStore(next)
        const saved = draftFor(next, analysis.sourceKey)
        if (saved && draftMatches(saved, analysis)) {
          setDraft({ ...saved, runId: analysis.runId })
          setMessage(saved.fromLegacy ? '이전에 고친 내용을 이어서 불러왔습니다.' : '고친 내용을 이어서 불러왔습니다.')
        }
      } catch { /* 없으면 새로 시작한다 */ }
    })()
  }, [analysis])

  // ── 저장 — 파일별로 나눠 담는다 ──────────────────────────────────────────
  const storeRef = useRef(store); storeRef.current = store
  useEffect(() => {
    if (!draft) return
    const save = () => {
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
  }, [draft])

  // ── 받아쓴 대본 얹기 — 시간축이 같을 때만 ────────────────────────────────
  useEffect(() => {
    setLines({ text: {}, notes: [] })
    if (!analysis || !analysis.transcribe || !analysis.outputDir || !draft) return
    let alive = true
    void (async () => {
      const text: Record<number, string> = {}
      const notes: string[] = []
      const rows = speakerRows(analysis, draft)
      for (const row of rows) {
        const segs = analysis.segments
          .map((_s, i) => ({ i, cur: effectiveSegment(analysis, draft, i) }))
          .filter((x) => x.cur.speaker === row.id)
          .map((x) => ({ index: x.i, start: x.cur.start, end: x.cur.end }))
        // 트랙 이름은 엔진이 붙인 식별자에서 온다(화자 A → speaker_a).
        const track = `speaker_${(row.id.match(/[A-Za-z0-9]+/g) || []).join('').toLowerCase()}`
        let raw = ''
        try {
          raw = await window.api.dialogue.readTranscript(analysis.outputDir, rawTimestampFile(track))
        } catch { raw = '' }
        if (!raw) continue
        const { cues } = parseTimestampLines(raw)
        const verdict = checkTimeline(cues, segs, analysis.durationSec)
        if (!verdict.ok) { notes.push(`${row.name}: ${verdict.reason}`); continue }
        const { text: got, unplaced } = assignCues(cues, segs)
        Object.assign(text, got)
        if (unplaced > 0) notes.push(`${row.name}: 구간에 붙지 못한 줄 ${unplaced}개`)
      }
      if (alive) setLines({ text, notes })
    })()
    return () => { alive = false }
    // draft 전체가 아니라 배정이 바뀔 때만 다시 얹는다.
  }, [analysis, draft?.merges, draft?.edits])

  // ── 재생 ─────────────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    const el = audioRef.current
    try { el?.pause() } catch { /* noop */ }
    if (el) el.ontimeupdate = null
    stopAtRef.current = null
    setPlaying(null)
  }, [])
  useEffect(() => stop, [stop, fileUrl])

  const playRange = useCallback((token: string, start: number, end: number) => {
    if (!fileUrl) return
    if (playing === token) { stop(); return }
    stop()
    const el = audioRef.current || createManagedAudio()
    audioRef.current = el
    if (el.src !== fileUrl) el.src = fileUrl
    stopAtRef.current = end
    el.currentTime = Math.max(0, start)
    el.ontimeupdate = () => {
      const until = stopAtRef.current
      if (until != null && el.currentTime >= until) stop()
    }
    el.onended = () => stop()
    setPlaying(token)
    el.play().catch(() => { setError('원본을 재생하지 못했습니다.'); stop() })
  }, [fileUrl, playing, stop])

  // ── 고치기 ───────────────────────────────────────────────────────────────
  const change = useCallback((kind: string, fn: (d: DialogueDraft) => DialogueDraft, seal = true) => {
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
  const dirty = draft ? signature(draft) !== (appliedSig ?? signature(emptyDraft('', ''))) : false
  const hasEdits = changed > 0 || renamed > 0 || merged > 0
  const running = status === 'processing' || busy

  // ── 교정본 만들기 ────────────────────────────────────────────────────────
  const rebuild = useCallback(async () => {
    if (!analysis || !draft || !plan || !fileInfo?.path) return
    setError(''); setMessage('')
    if (!plan.segments.length) { setError('쓸 수 있는 구간이 없습니다.'); return }
    setBusy(true)
    stop()
    try {
      const r = await window.api.audio.process(fileInfo.path, 'dialogue-rebuild', {
        dialogueSegments: plan.segments,
      })
      if (r && (r as { error?: unknown }).error) setError(String((r as { error?: unknown }).error))
      else {
        setAppliedSig(signature(draft))
        setMessage('고친 내용으로 인물별 음원을 새로 만들고 있습니다. 원래 결과는 그대로 둡니다.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '다시 만들지 못했습니다.')
    } finally { setBusy(false) }
  }, [analysis, draft, plan, fileInfo?.path, stop])

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

  const applyToPicked = (id: SpeakerId) => {
    if (!picked.size) return
    change(`assign:${Date.now()}`, (d) => {
      const edits = { ...d.edits }
      for (const i of picked) edits[i] = { ...(edits[i] || {}), speaker: id }
      return { ...d, edits }
    })
    setPicked(new Set())
  }

  return (
    <div data-testid="dialogue-workspace" style={{
      display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 12,
      background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
    }}>
      {/* ── 머리: 상태와 되돌리기 ───────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>대화 작업실</span>
        <span data-testid="dialogue-state" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          인물 {rows.length}명 · 발언 {analysis.segments.length}개
          {hasEdits ? ` · 고친 곳 ${changed + renamed + merged}` : ''}
        </span>
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

      {/* ── 인물 카드 줄 — 좁으면 가로로 민다 ──────────────────────────── */}
      <div data-testid="dialogue-cards" style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
        <button type="button" data-testid="dialogue-card-all" onClick={() => setOnly(null)}
          aria-pressed={only === null} title="모든 인물의 발언을 봅니다"
          style={{
            ...btn(only === null ? 'var(--bg-elevated)' : 'transparent', 'var(--text-primary)'),
            flex: '0 0 auto', minWidth: 64, border: `1px solid ${only === null ? 'var(--cyan)' : 'var(--border-subtle)'}`,
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
                    const n = new Set(s); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n
                  })}
                  aria-label={`${r.name} 합치기 대상`} title="합칠 인물을 고릅니다"
                  style={{ accentColor: 'var(--cyan)', cursor: 'pointer', flexShrink: 0 }} />
                <input data-testid="dialogue-card-name" value={displayNameOf(draft, r.id)}
                  onChange={(e) => change(`name:${r.id}`, (d) => ({ ...d, names: { ...d.names, [r.id]: e.target.value } }), false)}
                  onBlur={() => setHistory((h) => sealHistory(h))}
                  aria-label={`${r.id} 이름`} title="이 인물의 표시 이름입니다. 파일 이름은 따로 안전하게 만듭니다."
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
                  title="이 인물의 **가장 긴** 구간을 들려줍니다"
                  style={{ ...btn('var(--bg-elevated)', 'var(--text-primary)', !r.longest), padding: '2px 8px' }}>
                  {playing === token ? '■' : '▶'}
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
                onClick={() => applyToPicked(r.id)} title={`고른 발언을 ${r.name} 에게 옮깁니다`}
                style={btn('var(--bg-elevated)', 'var(--text-primary)')}>{r.name}</button>
            ))}
            <button type="button" onClick={() => setPicked(new Set())} style={btn('transparent', 'var(--text-muted)')}>해제</button>
          </span>
        )}
        <button type="button" data-testid="dialogue-toggle-times" onClick={() => setShowTimes((v) => !v)}
          aria-pressed={showTimes} title="시작·끝을 직접 고칩니다"
          style={{ ...btn('transparent', showTimes ? 'var(--cyan)' : 'var(--text-muted)'), marginLeft: 'auto' }}>
          시간 고치기
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 360, overflowY: 'auto' }}>
        {visible.map((i) => {
          const cur = effectiveSegment(analysis, draft, i)
          const edited = isSegmentEdited(analysis, draft, i)
          const problem = segmentProblem(cur, analysis.durationSec)
          const token = `seg:${i}`
          return (
            <div key={i} data-testid="dialogue-row" data-edited={edited ? '1' : '0'} data-problem={problem || ''}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '3px 5px', borderRadius: 7,
                flexWrap: 'wrap',
                background: playing === token ? 'var(--bg-elevated)' : 'transparent',
                borderLeft: `3px solid ${edited ? 'var(--cyan)' : 'transparent'}`,
                outline: problem ? '1px solid var(--rose, #fb7185)' : 'none',
              }}>
              <input type="checkbox" data-testid="dialogue-pick" checked={picked.has(i)}
                onChange={() => setPicked((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n })}
                aria-label={`${i + 1}번째 발언 고르기`}
                style={{ accentColor: 'var(--cyan)', cursor: 'pointer', flexShrink: 0 }} />
              <button type="button" data-testid="dialogue-play" onClick={() => playRange(token, cur.start, cur.end)}
                aria-label={`${i + 1}번째 발언 듣기`}
                style={{ ...btn('transparent', 'var(--text-primary)'), padding: '2px 5px' }}>
                {playing === token ? '■' : '▶'}
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
              <span data-testid="dialogue-text" style={{
                flex: '1 1 160px', minWidth: 0, fontSize: 11,
                color: lines.text[i] ? 'var(--text-primary)' : 'var(--text-muted)',
              }}>
                {lines.text[i] || (analysis.transcribe ? '—' : '')}
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

      {/* ── 적용·저장 ───────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" data-testid="dialogue-rebuild" onClick={() => { void rebuild() }}
          disabled={running || !plan?.segments.length || !hasEdits}
          title="고친 내용으로 인물별 음원을 새로 만듭니다. 화자 분석을 다시 돌리지 않고, 원래 결과도 그대로 둡니다."
          style={btn('var(--cyan)', '#fff', running || !plan?.segments.length || !hasEdits)}>
          교정본 만들기
        </button>
        {/* ★고친 것과 **만든 것**을 구분해 말한다. 아직 만들지 않았으면 '저장됨' 이라고 하지 않는다. */}
        <span data-testid="dialogue-apply-state" style={{ fontSize: 10, color: dirty ? 'var(--amber, #d4a017)' : 'var(--text-muted)' }}>
          {!hasEdits ? '고친 곳이 없습니다'
            : dirty ? '고친 내용이 아직 음원에 반영되지 않았습니다 (교정은 저장됩니다)'
              : '고친 내용으로 음원을 만들었습니다'}
        </span>
      </div>

      {plan && plan.blocked.length > 0 && (
        <div data-testid="dialogue-blocked" role="alert" style={{ fontSize: 10, lineHeight: 1.6, color: 'var(--rose, #fb7185)' }}>
          시간이 올바르지 않은 발언 {plan.blocked.length}개는 빠집니다 —
          {plan.blocked.slice(0, 3).map((b) => ` ${b.index + 1}번(${problemText(b.problem)})`)}
        </div>
      )}
      {lines.notes.length > 0 && (
        <div data-testid="dialogue-text-note" style={{ fontSize: 10, lineHeight: 1.6, color: 'var(--amber, #d4a017)' }}>
          {lines.notes.slice(0, 3).join(' · ')}
        </div>
      )}
      {analysis.overlaps.length > 0 && (
        <div data-testid="dialogue-overlaps" style={{
          fontSize: 10, lineHeight: 1.6, color: 'var(--amber, #d4a017)',
          padding: '6px 8px', borderRadius: 7, background: 'var(--bg-elevated)',
        }}>
          두 사람 이상이 동시에 말한 구간 {analysis.overlaps.length}곳 — 찾았다는 뜻일 뿐,
          그 부분의 목소리를 사람마다 갈라낸 것은 아닙니다.
        </div>
      )}
      {(error || message) && (
        <div data-testid="dialogue-message" role="status" style={{
          fontSize: 11, lineHeight: 1.6, color: error ? 'var(--rose, #fb7185)' : 'var(--text-secondary)',
        }}>{error || message}</div>
      )}
    </div>
  )
}
