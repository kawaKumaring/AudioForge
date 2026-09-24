// 대화 구간 수정 — 자동 배정이 틀렸을 때 **재분석 없이** 고친다.
//
// 분석이 낸 구간을 줄로 펼치고, 구간을 누르면 **원본의 그 부분**을 들려준다. 화자 배정과
// 시작·끝을 고칠 수 있고, 고친 구간으로 트랙을 다시 만들 수 있다.
//
// ★화자 분석 모델을 다시 돌리지 않는다. 원본에서 그 구간을 떠다 화자별 트랙에 올릴 뿐이다.
// ★겹친 발화를 한 사람의 깨끗한 목소리로 갈라낸 것이 아니다 — 이 화면이 하는 것은 **배정**이다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatMinSec } from '../../shared/timeFormat'
import { saveSetting, saveFailureText } from '../../shared/saveSetting'

import { useAppStore } from '@/stores/app.store'
import { createManagedAudio } from '@/lib/playbackVolume'
import {
  DIALOGUE_EDIT_STORAGE_KEY, editedSegmentCount, effectiveSegment, exportSegments,
  isSegmentEdited, parseDialogueDoc, problemText, segmentProblem,
  type DialogueDoc,
} from '../../shared/dialogueEdit'

const fmt = (sec: number) => {
  // ★계산은 shared/timeFormat 한 곳이 소유한다(2026-09-24 2차 감사).
  return formatMinSec(sec)
}
const btn = (bg: string, fg: string, off?: boolean): React.CSSProperties => ({
  padding: '5px 10px', borderRadius: 7, border: 'none', fontFamily: 'inherit', fontSize: 11,
  fontWeight: 600, background: bg, color: fg, cursor: off ? 'not-allowed' : 'pointer',
  opacity: off ? 0.45 : 1,
})

export default function DialogueSegments() {
  const { dialogueSegments, dialogueOverlaps, fileInfo, fileUrl, outputDir, status } = useAppStore()
  const [doc, setDoc] = useState<DialogueDoc | null>(null)
  const [playing, setPlaying] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const stopAtRef = useRef<number | null>(null)
  const loadedFor = useRef('')
  const duration = fileInfo?.duration || 0

  useEffect(() => {
    const src = fileInfo?.path || ''
    const segs = dialogueSegments
    if (!src || !segs?.length) { setDoc(null); return }
    const key = src + '|' + segs.length
    if (loadedFor.current === key) return
    loadedFor.current = key
    const fresh: DialogueDoc = {
      sourcePath: src,
      segments: segs.map((s) => ({ start: s.start, end: s.end, speaker: s.speaker })),
      speakers: [...new Set(segs.map((s) => s.speaker))].sort(),
      edits: {}, updatedAt: Date.now(),
    }
    setDoc(fresh)
    void (async () => {
      try {
        const got = await window.api.settings.get() as Record<string, unknown>
        const saved = parseDialogueDoc(got?.[DIALOGUE_EDIT_STORAGE_KEY])
        if (saved && saved.sourcePath === src && saved.segments.length === segs.length) {
          setDoc({ ...fresh, edits: saved.edits })
        }
      } catch { /* 없으면 새로 시작한다 */ }
    })()
  }, [dialogueSegments, fileInfo?.path])

  const docRef = useRef<DialogueDoc | null>(null)
  docRef.current = doc
  useEffect(() => {
    if (!doc) return
    // ★응답을 버리지 않는다 — 설정 파일이 깨지면 고친 내용이 통째로 사라지는데
    //   예전에는 화면이 아무 말도 하지 않았다(2026-09-24 감사).
    const save = () => {
      void saveSetting(window.api.settings.set, DIALOGUE_EDIT_STORAGE_KEY, docRef.current)
        .then((why) => { if (why) setError(saveFailureText(why)) })
    }
    const t = setTimeout(save, 600)
    return () => { clearTimeout(t); save() }
  }, [doc])

  // ── 구간 듣기 ───────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    const el = audioRef.current
    try { el?.pause() } catch { /* noop */ }
    if (el) el.ontimeupdate = null
    stopAtRef.current = null
    setPlaying(null)
  }, [])
  useEffect(() => stop, [stop, fileUrl])

  const play = useCallback((i: number) => {
    if (!doc || !fileUrl) return
    if (playing === i) { stop(); return }
    stop()
    const seg = effectiveSegment(doc, i)
    const el = audioRef.current || createManagedAudio()   // 공용 음량을 따른다
    audioRef.current = el
    if (el.src !== fileUrl) el.src = fileUrl
    stopAtRef.current = seg.end
    el.currentTime = Math.max(0, seg.start)
    el.ontimeupdate = () => {
      const until = stopAtRef.current
      if (until != null && el.currentTime >= until) stop()
    }
    el.onended = () => stop()
    setPlaying(i)
    el.play().catch(() => { setError('원본을 재생하지 못했습니다.'); stop() })
  }, [doc, fileUrl, playing, stop])

  const patch = useCallback((i: number, p: Partial<{ start: number; end: number; speaker: string }>) => {
    setDoc((d) => (d ? { ...d, edits: { ...d.edits, [i]: { ...(d.edits[i] || {}), ...p } }, updatedAt: Date.now() } : d))
  }, [])

  const revert = useCallback((i: number) => {
    setDoc((d) => {
      if (!d) return d
      const next = { ...d.edits }
      delete next[i]
      return { ...d, edits: next, updatedAt: Date.now() }
    })
  }, [])

  const plan = useMemo(() => (doc ? exportSegments(doc, duration) : null), [doc, duration])

  // ── 수정본 내보내기 — 모델을 다시 돌리지 않는다 ─────────────────────────
  const rebuild = useCallback(async () => {
    if (!doc || !plan || !fileInfo?.path) return
    setError(null); setMessage(null)
    if (plan.segments.length === 0) { setError('쓸 수 있는 구간이 없습니다.'); return }
    setBusy(true)
    stop()
    try {
      const r = await window.api.audio.process(fileInfo.path, 'dialogue-rebuild', {
        dialogueSegments: plan.segments,
      })
      if (r && (r as any).error) setError(String((r as any).error))
      else setMessage('수정한 구간으로 화자 트랙을 다시 만들고 있습니다.')
    } catch (e) {
      setError(e instanceof Error ? e.message : '다시 만들지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }, [doc, plan, fileInfo?.path, stop])

  if (!doc || doc.segments.length === 0) return null
  const changed = editedSegmentCount(doc)
  const running = status === 'processing' || busy

  return (
    <div data-testid="dialogue-segments" style={{
      display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 12,
      background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>대화 구간</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          구간을 누르면 원본의 그 부분을 들려줍니다. 화자와 시작·끝을 고칠 수 있습니다.
        </span>
        <span data-testid="dialogue-edited-count" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)' }}>
          고친 구간 {changed}개
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 340, overflowY: 'auto' }}>
        {doc.segments.map((_s, i) => {
          const cur = effectiveSegment(doc, i)
          const edited = isSegmentEdited(doc, i)
          const problem = segmentProblem(cur, duration)
          return (
            <div key={i} data-testid="dialogue-row" data-edited={edited ? '1' : '0'}
              data-problem={problem || ''}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '3px 5px', borderRadius: 7,
                background: playing === i ? 'var(--bg-elevated)' : 'transparent',
                border: problem ? '1px solid var(--rose, #fb7185)' : '1px solid transparent',
              }}>
              <button data-testid="dialogue-play" onClick={() => play(i)}
                aria-label={`${i + 1}번째 구간 듣기`} title="이 구간의 원본을 듣습니다."
                style={{ ...btn('transparent', 'var(--text-primary)'), padding: '2px 5px', flexShrink: 0 }}>
                {playing === i ? '■' : '▶'}
              </button>
              <select data-testid="dialogue-speaker" value={cur.speaker}
                onChange={(e) => patch(i, { speaker: e.target.value })}
                aria-label={`${i + 1}번째 구간의 화자`}
                style={{
                  fontFamily: 'inherit', fontSize: 11, padding: '3px 5px', borderRadius: 6,
                  border: `1px solid ${edited ? 'var(--cyan)' : 'var(--border-subtle)'}`,
                  background: 'var(--bg-base)', color: 'var(--text-primary)', flexShrink: 0,
                }}>
                {[...new Set([...doc.speakers, cur.speaker])].sort().map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <input data-testid="dialogue-start" type="number" step="0.1" min="0" value={cur.start}
                onChange={(e) => patch(i, { start: Number(e.target.value) })}
                aria-label={`${i + 1}번째 구간 시작(초)`}
                style={{
                  width: 74, fontFamily: 'inherit', fontSize: 11, padding: '3px 5px', borderRadius: 6,
                  border: '1px solid var(--border-subtle)', background: 'var(--bg-base)',
                  color: 'var(--text-primary)', flexShrink: 0,
                }} />
              <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>→</span>
              <input data-testid="dialogue-end" type="number" step="0.1" min="0" value={cur.end}
                onChange={(e) => patch(i, { end: Number(e.target.value) })}
                aria-label={`${i + 1}번째 구간 끝(초)`}
                style={{
                  width: 74, fontFamily: 'inherit', fontSize: 11, padding: '3px 5px', borderRadius: 6,
                  border: '1px solid var(--border-subtle)', background: 'var(--bg-base)',
                  color: 'var(--text-primary)', flexShrink: 0,
                }} />
              <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                {fmt(Math.max(0, cur.end - cur.start))}
              </span>
              {problem && (
                <span data-testid="dialogue-problem" style={{ fontSize: 10, color: 'var(--rose, #fb7185)' }}>
                  {problemText(problem)}
                </span>
              )}
              {edited && (
                <button data-testid="dialogue-revert" onClick={() => revert(i)}
                  title="이 구간을 처음 분석한 값으로 되돌립니다."
                  style={{ ...btn('transparent', 'var(--text-muted)'), marginLeft: 'auto', flexShrink: 0 }}>
                  되돌리기
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button data-testid="dialogue-rebuild" onClick={() => { void rebuild() }}
          disabled={running || !plan || plan.segments.length === 0}
          title="고친 구간으로 화자 트랙을 다시 만듭니다. 화자 분석을 다시 돌리지 않습니다."
          style={btn('var(--cyan)', '#fff', running || !plan || plan.segments.length === 0)}>
          수정본으로 다시 만들기
        </button>
        <span style={{ fontSize: 10, lineHeight: 1.6, color: 'var(--text-muted)' }}>
          화자 분석을 다시 돌리지 않습니다. 원본 구간을 화자별 트랙에 배정할 뿐이며,
          겹쳐 말한 부분을 한 사람의 목소리로 갈라내지는 않습니다.
        </span>
      </div>

      {/* 겹쳐 잡힌 구간 — 구간 목록과 **따로** 알린다.
          ★겹침을 찾았다는 것은 겹친 목소리를 갈라냈다는 뜻이 아니다. */}
      {dialogueOverlaps.length > 0 && (
        <div data-testid="dialogue-overlaps" style={{
          fontSize: 10, lineHeight: 1.6, color: 'var(--amber, #d4a017)',
          padding: '6px 8px', borderRadius: 7, background: 'var(--bg-elevated)',
        }}>
          두 사람 이상이 동시에 말한 구간 {dialogueOverlaps.length}곳을 찾았습니다 —
          {dialogueOverlaps.slice(0, 3).map((o) => ` ${fmt(o.start)}~${fmt(o.end)}`)}
          {dialogueOverlaps.length > 3 ? ` 외 ${dialogueOverlaps.length - 3}곳` : ''}.
          <br />
          찾았다는 뜻일 뿐, 그 부분의 목소리를 사람마다 갈라낸 것은 아닙니다.
        </div>
      )}

      {plan && plan.blocked.length > 0 && (
        <div data-testid="dialogue-blocked" role="alert" style={{ fontSize: 10, lineHeight: 1.6, color: 'var(--rose, #fb7185)' }}>
          시간이 올바르지 않은 구간 {plan.blocked.length}개는 빠집니다 —
          {plan.blocked.slice(0, 3).map((b) => ` ${b.index + 1}번(${problemText(b.problem)})`)}
        </div>
      )}
      {(error || message) && (
        <div data-testid="dialogue-message" role="status" style={{
          fontSize: 11, lineHeight: 1.6, color: error ? 'var(--rose, #fb7185)' : 'var(--text-secondary)',
        }}>{error || message}</div>
      )}
      {outputDir ? null : null}
    </div>
  )
}
