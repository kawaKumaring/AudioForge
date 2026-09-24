// 텍스트 교정 — 인식 결과를 **들으면서** 고친다.
//
// 새 범용 편집기를 만들지 않았다. 이미 있는 전사 결과(문장·시작·끝)를 그대로 받아 줄로 펼치고,
// 줄을 누르면 **원본 음성의 그 구간**을 튼다. 고친 글자는 교정본으로 따로 저장한다.
//
// ★최초 인식 결과는 지우지 않는다. 고친 것은 그 위에 얹히는 별도의 층이고, '되돌리기' 로
//   언제든 원래 글자로 돌아온다.
// ★글자를 고쳐도 **시간은 인식이 말한 그대로** 둔다. 고친 글자에 맞는 새 시간을 계산하려면
//   정렬을 다시 해야 하는데 그것은 이번 범위가 아니다 — 그래서 "그 구간" 이라는 뜻만 유지한다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { saveSetting, saveFailureText } from '../../shared/saveSetting'

import { useAppStore } from '@/stores/app.store'
import { createManagedAudio } from '@/lib/playbackVolume'
import {
  TRANSCRIPT_EDIT_STORAGE_KEY, buildCorrectedSrt, buildCorrectedTxt, editedCount,
  effectiveText, isEdited, parseTranscriptDoc, saveNoteText, saveNotes,
  type TranscriptDoc,
} from '../../shared/transcriptEdit'

const fmt = (sec: number) => {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

const btn = (bg: string, fg: string, off?: boolean): React.CSSProperties => ({
  padding: '5px 10px', borderRadius: 7, border: 'none', fontFamily: 'inherit', fontSize: 11,
  fontWeight: 600, background: bg, color: fg,
  cursor: off ? 'not-allowed' : 'pointer', opacity: off ? 0.45 : 1,
})

export default function TranscriptEditor() {
  const { tracks, outputDir, fileInfo, fileUrl } = useAppStore()
  const transcript = tracks.find((t) => t.name === 'transcript')
  const hasTranslation = tracks.some((t) => t.name === 'translation')

  const [doc, setDoc] = useState<TranscriptDoc | null>(null)
  const [playing, setPlaying] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const stopAtRef = useRef<number | null>(null)
  const loadedFor = useRef<string>('')

  // ── 문서 만들기 / 저장본 되살리기 ────────────────────────────────────────
  useEffect(() => {
    const segs = (transcript as any)?.segments as TranscriptDoc['segments'] | undefined
    const src = fileInfo?.path || ''
    if (!transcript || !segs?.length || !src) { setDoc(null); return }
    const key = src + '|' + segs.length
    if (loadedFor.current === key) return
    loadedFor.current = key
    const fresh: TranscriptDoc = {
      sourcePath: src,
      base: (transcript as any).base || '',
      language: (transcript as any).language || 'unknown',
      segments: segs.map((s) => ({ start: s.start, end: s.end, text: s.text })),
      edits: {}, updatedAt: Date.now(),
    }
    setDoc(fresh)
    // 같은 원본의 교정이 남아 있으면 되살린다 — 다른 파일의 교정이 섞이지 않게 원본 경로로 가린다.
    void (async () => {
      try {
        const got = await window.api.settings.get() as Record<string, unknown>
        const saved = parseTranscriptDoc(got?.[TRANSCRIPT_EDIT_STORAGE_KEY])
        if (saved && saved.sourcePath === src && saved.segments.length === segs.length) {
          setDoc({ ...fresh, edits: saved.edits })
        }
      } catch { /* 없으면 새로 시작한다 */ }
    })()
  }, [transcript, fileInfo?.path])

  // 고친 내용 보관 — 600ms 쉬었다가 한 번에. 화면이 사라질 때는 버리지 않고 바로 쓴다.
  const docRef = useRef<TranscriptDoc | null>(null)
  docRef.current = doc
  useEffect(() => {
    if (!doc) return
    // ★응답을 버리지 않는다 — 설정 파일이 깨지면 교정이 통째로 사라지는데
    //   예전에는 화면이 아무 말도 하지 않았다(2026-09-24 감사).
    const save = () => {
      void saveSetting(window.api.settings.set, TRANSCRIPT_EDIT_STORAGE_KEY, docRef.current)
        .then((why) => { if (why) setError(saveFailureText(why)) })
    }
    const t = setTimeout(save, 600)
    return () => { clearTimeout(t); save() }
  }, [doc])

  // ── 재생 ────────────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    const el = audioRef.current
    try { el?.pause() } catch { /* noop */ }
    if (el) el.ontimeupdate = null
    stopAtRef.current = null
    setPlaying(null)
  }, [])

  // 화면을 떠나거나 원본이 바뀌면 **이전 재생을 반드시 정리한다.**
  useEffect(() => stop, [stop, fileUrl])

  const playSegment = useCallback((index: number) => {
    if (!doc || !fileUrl) return
    if (playing === index) { stop(); return }     // 같은 줄을 다시 누르면 멈춘다
    stop()                                         // 다른 줄을 누르면 이전 것을 먼저 정리한다
    const seg = doc.segments[index]
    const el = audioRef.current || createManagedAudio()   // 음량은 공용 값을 따른다
    audioRef.current = el
    if (el.src !== fileUrl) el.src = fileUrl
    stopAtRef.current = seg.end
    el.currentTime = Math.max(0, seg.start)
    el.ontimeupdate = () => {
      const until = stopAtRef.current
      if (until != null && el.currentTime >= until) stop()
    }
    el.onended = () => stop()
    setPlaying(index)
    el.play().catch(() => { setError('원본 음성을 재생하지 못했습니다.'); stop() })
  }, [doc, fileUrl, playing, stop])

  // ── 저장 ────────────────────────────────────────────────────────────────
  const notes = useMemo(() => (doc ? saveNotes(doc, hasTranslation) : null), [doc, hasTranslation])
  const save = useCallback(async () => {
    if (!doc) return
    setError(null); setMessage(null)
    const r = await window.api.app.saveCorrectedTranscript(
      outputDir || '', doc.base, buildCorrectedTxt(doc), buildCorrectedSrt(doc))
    if (r?.ok) {
      const extra = notes ? saveNoteText(notes) : []
      setMessage(`교정본을 저장했습니다 — ${(r.files || []).join(', ')}`
        + (extra.length ? ` · ${extra.join(' ')}` : ''))
    } else {
      setError(r?.reason || '교정본을 저장하지 못했습니다.')
    }
  }, [doc, outputDir, notes])

  if (!doc || doc.segments.length === 0) return null
  const changed = editedCount(doc)

  return (
    <div data-testid="transcript-editor" style={{
      display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 12,
      background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>텍스트 교정</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          문장을 누르면 그 부분을 들려줍니다. 고친 내용은 교정본으로 따로 저장됩니다.
        </span>
        <span data-testid="transcript-edited-count" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)' }}>
          고친 문장 {changed}개
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 360, overflowY: 'auto' }}>
        {doc.segments.map((seg, i) => {
          const edited = isEdited(doc, i)
          return (
            <div key={i} data-testid="transcript-row" data-edited={edited ? '1' : '0'}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 6px', borderRadius: 8,
                background: playing === i ? 'var(--bg-elevated)' : 'transparent',
              }}>
              <button data-testid="transcript-play" onClick={() => playSegment(i)}
                title="이 문장의 원본 음성을 듣습니다."
                aria-label={`${i + 1}번째 문장 듣기`}
                style={{ ...btn('transparent', 'var(--text-primary)'), padding: '2px 5px', flexShrink: 0 }}>
                {playing === i ? '■' : '▶'}
              </button>
              <span data-testid="transcript-time" style={{
                fontSize: 10, color: 'var(--text-muted)', paddingTop: 6, flexShrink: 0,
                minWidth: 92, fontVariantNumeric: 'tabular-nums',
              }}>{fmt(seg.start)} → {fmt(seg.end)}</span>
              <textarea
                data-testid="transcript-input"
                value={effectiveText(doc, i)}
                onChange={(e) => setDoc({
                  ...doc, edits: { ...doc.edits, [i]: e.target.value }, updatedAt: Date.now(),
                })}
                rows={Math.max(1, Math.ceil(((effectiveText(doc, i).length) || 1) / 60))}
                style={{
                  flex: 1, minWidth: 0, resize: 'none', padding: '4px 8px', borderRadius: 6,
                  border: `1px solid ${edited ? 'var(--cyan)' : 'var(--border-subtle)'}`,
                  background: 'var(--bg-base)', color: 'var(--text-primary)',
                  fontFamily: 'inherit', fontSize: 12, lineHeight: 1.5,
                }} />
              {edited && (
                <button data-testid="transcript-revert"
                  onClick={() => {
                    const next = { ...doc.edits }
                    delete next[i]
                    setDoc({ ...doc, edits: next, updatedAt: Date.now() })
                  }}
                  title="이 문장을 처음 인식한 글자로 되돌립니다."
                  style={{ ...btn('transparent', 'var(--text-muted)'), flexShrink: 0, marginTop: 2 }}>
                  되돌리기
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* 고쳤을 때만 나오는 안내 — 평소에는 화면을 채우지 않는다. */}
      {changed > 0 && (
        <div data-testid="transcript-notes" style={{ fontSize: 10, lineHeight: 1.6, color: 'var(--amber, #d4a017)' }}>
          시간은 처음 인식한 구간 그대로입니다 — 고친 글자에 맞춰 다시 계산하지 않았습니다.
          {notes && saveNoteText(notes).map((s) => ` ${s}`)}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button data-testid="transcript-save" onClick={() => { void save() }}
          title="교정본 TXT·SRT 를 새 파일로 저장합니다. 처음 인식한 파일은 그대로 둡니다."
          style={btn('var(--cyan)', '#fff')}>교정본 저장</button>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          처음 인식한 파일은 그대로 두고 <code>_corrected</code> 파일로 저장합니다.
        </span>
      </div>

      {(error || message) && (
        <div data-testid="transcript-message" role="status" style={{
          fontSize: 11, lineHeight: 1.6, color: error ? 'var(--rose, #fb7185)' : 'var(--text-secondary)',
        }}>{error || message}</div>
      )}
    </div>
  )
}
