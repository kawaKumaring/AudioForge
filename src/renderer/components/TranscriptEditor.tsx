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
import { formatMinSec } from '../../shared/timeFormat'
import { saveFailureText } from '../../shared/saveSetting'

import { useAppStore } from '@/stores/app.store'
import {
  basisOfTranscript, buildCorrectedSrt, buildCorrectedTxt, editedCount,
  effectiveText, isEdited, saveNoteText, saveNotes, transcriptAdoptFault,
  type TranscriptDoc,
} from '../../shared/transcriptEdit'
import {
  emptyTranscriptStore, isBlankTranscriptDoc, parseTranscriptStore, putTranscriptDoc,
  transcriptDocFor, transcriptKey,
  type TranscriptDraftStore,
} from '../../shared/transcriptDrafts'

const fmt = (sec: number) => {
  // ★계산은 shared/timeFormat 한 곳이 소유한다(2026-09-24 2차 감사).
  return formatMinSec(sec)
}

const btn = (bg: string, fg: string, off?: boolean): React.CSSProperties => ({
  padding: '5px 10px', borderRadius: 7, border: 'none', fontFamily: 'inherit', fontSize: 11,
  fontWeight: 600, background: bg, color: fg,
  cursor: off ? 'not-allowed' : 'pointer', opacity: off ? 0.45 : 1,
})

export default function TranscriptEditor() {
  const { tracks, outputDir, fileInfo, fileUrl } = useAppStore()
  const transcript = tracks.find((t) => t.name === 'transcript')
  const translation = tracks.find((t) => t.name === 'translation')
  const hasTranslation = !!translation

  const [doc, setDoc] = useState<TranscriptDoc | null>(null)
  const [playing, setPlaying] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [readFail, setReadFail] = useState('')
  const [copied, setCopied] = useState('')
  /** 보관만 하고 적용하지 않은 이전 교정의 관계. */
  const [pastNote, setPastNote] = useState('')
  /** 지금 보는 것 — 원문(교정 가능) 인가 번역(읽기 전용) 인가. */
  const [view, setView] = useState<'source' | 'translation'>('source')
  const [store, setStore] = useState<TranscriptDraftStore>(emptyTranscriptStore)
  const storeRef = useRef(store); storeRef.current = store
  /** 저장본을 실제로 읽어 왔는가. ★읽기 전에는 쓰지 않는다(빈 초안이 남의 기록을 지운다). */
  const loadedRef = useRef('')
  const touchedRef = useRef(false)
  const loadedFor = useRef<string>('')

  // ── 문서 만들기 / 저장본 되살리기 ────────────────────────────────────────
  const loadDrafts = useCallback(async (fresh: TranscriptDoc, key: string) => {
    let next: TranscriptDraftStore
    try {
      // ★기록 하나가 파일 하나다 (2026-09-29). 설정 한 칸에 모아 두지 않는다 —
      //   하나를 지우려 해도 전체를 다시 써야 했고, 그래서 지운 것이 되살아났다.
      //   옛 열쇠에서 파일로 옮기는 일은 **본체가 처음 읽을 때 한 번** 한다.
      const got = await window.api.works.list('transcript')
      if (got.error) throw new Error(got.error)
      const drafts: Record<string, unknown> = {}
      for (const r of got.records || []) drafts[r.key] = r.data
      next = parseTranscriptStore({ version: 1, drafts })
      if (got.broken) {
        setReadFail(`저장된 교정 ${got.broken}개를 읽지 못했습니다 — 나머지는 그대로 씁니다.`)
      }
    } catch (e) {
      // ★읽기 실패를 '저장된 교정 없음' 으로 단정하지 않는다. 저장을 열지 않는다.
      setReadFail(`저장된 교정을 읽지 못했습니다(${(e as Error)?.message || e}). 이번 편집은 저장되지 않습니다.`)
      return
    }
    if (loadedFor.current !== key) return          // 기다리는 사이 원본·결과가 바뀌었다
    setReadFail(''); setPastNote('')
    setStore(next); storeRef.current = next
    const saved = transcriptDocFor(next, fresh.sourcePath, fresh.base, fresh.segments.length)
    // ★같은 파일을 **다시 추출**했으면 문장이 달라졌을 수 있다. 지문이 같을 때만 이어 쓴다.
    //   아니면 보관해 두고 관계를 말한다 — 덮지도 버리지도 않는다.
    const why = saved ? transcriptAdoptFault(saved, fresh.segments) : ''
    if (saved && !touchedRef.current && !why) {
      setDoc({ ...fresh, edits: { ...saved.edits }, updatedAt: saved.updatedAt })
      setMessage('고친 내용을 이어서 불러왔습니다.')
    } else if (saved && why) {
      setPastNote(`이전 교정 ${Object.keys(saved.edits).length}건을 보관 중입니다 — ${why} 이번 결과에 적용하지 않았습니다.`)
    }
    loadedRef.current = key
  }, [])

  useEffect(() => {
    const segs = (transcript as any)?.segments as TranscriptDoc['segments'] | undefined
    const src = fileInfo?.path || ''
    if (!transcript || !src) { setDoc(null); loadedFor.current = ''; loadedRef.current = ''; return }
    const base = (transcript as any).base || ''
    const plain = (segs || []).map((x) => ({ start: x.start, end: x.end, text: x.text }))
    // ★열쇠에 **글 지문**까지 넣는다. 같은 파일을 다시 추출하면 이름도 문장 수도 같을 수
    //   있는데, 그때 이 화면이 다시 읽지 않으면 옛 교정이 새 결과 위에 그대로 남는다.
    const fp = basisOfTranscript(plain)
    const key = `${src}|${base}|${fp.segmentCount}|${fp.timesHash}|${fp.textHash}`
    if (loadedFor.current === key) return
    loadedFor.current = key
    loadedRef.current = ''
    touchedRef.current = false
    setMessage(null); setError(null); setReadFail(''); setCopied(''); setPastNote(''); setView('source')
    const fresh: TranscriptDoc = {
      sourcePath: src,
      base,
      language: (transcript as any).language || 'unknown',
      segments: plain,
      edits: {}, updatedAt: Date.now(),
      basis: fp,
    }
    setDoc(fresh)
    if (fresh.segments.length) void loadDrafts(fresh, key)
  }, [transcript, fileInfo?.path, loadDrafts])

  // 고친 내용 보관 — 파일별로 나눠 담는다. 600ms 쉬었다가 한 번에.
  const docRef = useRef<TranscriptDoc | null>(null)
  docRef.current = doc
  useEffect(() => {
    if (!doc || !doc.segments.length) return
    const key = loadedFor.current
    const save = () => {
      // ★읽기 전에는 쓰지 않는다 — 빈 초안이 남의 교정을 지운다.
      if (loadedRef.current !== key) return
      const cur = docRef.current
      if (!cur) return
      const now = { ...cur, updatedAt: Date.now() }
      const next = putTranscriptDoc(storeRef.current, now)
      storeRef.current = next
      setStore(next)
      // ★이 문서 **하나만** 쓴다. 남의 기록을 함께 다시 쓰지 않는다.
      //   고친 것이 없으면 그 파일을 지운다 — 빈 기록을 남겨 두지 않는다.
      const docKey = transcriptKey(now.sourcePath, now.base)
      const call = isBlankTranscriptDoc(now)
        ? window.api.works.remove('transcript', docKey)
        : window.api.works.write('transcript', docKey, now)
      void call.then((r) => { if (!r.ok) setError(saveFailureText(r.why || 'WRITE_FAILED')) })
        .catch((e) => setError(saveFailureText((e as Error)?.message || 'WRITE_FAILED')))
    }
    const t = setTimeout(save, 600)
    return () => { clearTimeout(t); save() }
  }, [doc])

  // ── 재생 — **공용 원본 파형**이 낸다(이 화면이 소리를 따로 들지 않는다) ──
  const waveRange = useAppStore((st) => st.waveRange)
  useEffect(() => { if (!waveRange) setPlaying(null) }, [waveRange])
  useEffect(() => () => { useAppStore.getState().clearWaveRange() }, [fileUrl])

  const playSegment = useCallback((index: number) => {
    if (!doc) return
    const st = useAppStore.getState()
    if (playing === index) { st.clearWaveRange(); setPlaying(null); return }
    const seg = doc.segments[index]
    if (!seg) return
    setPlaying(index)
    st.requestWaveRange(Math.max(0, seg.start), seg.end)
  }, [doc, playing])

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

  /** 지금 보는 글 — **화면에 보이는 것과 같은 글**이 복사·저장으로 간다. */
  const copyNow = useCallback(async () => {
    setCopied('')
    // 문장별 시간이 없으면 고칠 자리도 없다 — 엔진이 낸 글을 그대로 복사한다.
    const text = view === 'translation'
      ? (translation as { text?: string } | undefined)?.text || ''
      : (doc && doc.segments.length
        ? buildCorrectedTxt(doc)
        : (transcript as { text?: string } | undefined)?.text || '')
    if (!text) { setCopied('복사할 내용이 없습니다.'); return }
    try {
      await window.api.utils.copyToClipboard(text)
      setCopied(view === 'translation' ? '번역을 복사했습니다.' : '지금 글(고친 내용 반영)을 복사했습니다.')
    } catch (e) {
      setCopied(`복사하지 못했습니다: ${(e as Error)?.message || e}`)
    }
  }, [doc, view, translation, transcript])

  if (!doc) return null
  const changed = editedCount(doc)
  const hasTimes = doc.segments.length > 0
  const plainText = (transcript as { text?: string } | undefined)?.text || ''
  /** 실제로 있는 결과만 보여 준다 — 없는 형식을 탭으로 만들지 않는다. */
  const views: Array<['source' | 'translation', string]> = [['source', '원문']]
  if (translation) views.push(['translation', '한국어 번역'])
  const showing: 'source' | 'translation' = translation ? view : 'source'

  return (
    <div data-testid="transcript-editor" style={{
      display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 12,
      background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>텍스트 결과</span>
        {/* ★실제로 있는 결과만 탭으로 낸다. 번역이 없으면 탭도 없다. */}
        {views.length > 1 && (
          <span data-testid="transcript-views" role="group" aria-label="볼 내용" style={{ display: 'flex', gap: 2 }}>
            {views.map(([id, label]) => (
              <button type="button" key={id} data-testid={`transcript-view-${id}`}
                onClick={() => setView(id)} aria-pressed={showing === id}
                title={id === 'translation'
                  ? '번역은 읽기 전용입니다 — 원문을 고쳐도 번역은 다시 만들지 않습니다.'
                  : '인식한 원문입니다. 여기서 고칠 수 있습니다.'}
                style={{
                  ...btn(showing === id ? 'var(--bg-elevated)' : 'transparent',
                    showing === id ? 'var(--text-primary)' : 'var(--text-muted)'),
                  padding: '3px 9px', fontSize: 10,
                  border: `1px solid ${showing === id ? 'var(--cyan)' : 'transparent'}`,
                }}>{label}</button>
            ))}
          </span>
        )}
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}
          title={hasTimes
            ? '문장을 누르면 위 파형이 그 부분을 들려줍니다. 고친 내용은 교정본으로 따로 저장됩니다.'
            : '이 결과에는 문장별 시간이 없어 구간 듣기를 제공하지 않습니다.'}>
          {doc.language !== 'unknown' ? doc.language : ''}
          {hasTimes ? ` · ${doc.segments.length}문장` : ' · 시간 정보 없음'}
        </span>
        <span data-testid="transcript-edited-count" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)' }}>
          {showing === 'translation' ? '읽기 전용' : `고친 문장 ${changed}개`}
        </span>
      </div>

      {pastNote && (
        <div data-testid="transcript-past-note" role="status" style={{ fontSize: 10, color: 'var(--amber, #d4a017)' }}
          title="같은 파일을 다시 추출하면 문장이 갈라지는 자리가 달라질 수 있습니다. 번호로 매긴 교정을 그대로 옮기면 엉뚱한 문장이 바뀝니다.">
          {pastNote}
        </div>
      )}

      {readFail && (
        <div data-testid="transcript-read-fail" role="alert" style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          fontSize: 11, color: 'var(--rose, #fb7185)',
        }}>
          <span>{readFail}</span>
          <button type="button" data-testid="transcript-read-retry"
            onClick={() => { setReadFail(''); if (doc) void loadDrafts(doc, loadedFor.current) }}
            style={btn('var(--bg-elevated)', 'var(--text-primary)')}>다시 읽기</button>
        </div>
      )}

      {/* ★번역은 **읽기 전용**이다. 원문을 고쳐도 번역을 다시 만들지 않는다. */}
      {showing === 'translation' && (
        <div data-testid="transcript-translation" style={{
          maxHeight: 360, overflowY: 'auto', padding: 10, borderRadius: 8, whiteSpace: 'pre-wrap',
          background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
          fontSize: 12, lineHeight: 1.7, color: 'var(--text-primary)',
        }}>{(translation as { text?: string } | undefined)?.text || ''}</div>
      )}

      {/* 문장별 시간이 없는 결과 — **가짜 시간을 만들지 않고** 글만 보여 준다. */}
      {showing === 'source' && !hasTimes && (
        <div data-testid="transcript-plain" style={{
          maxHeight: 360, overflowY: 'auto', padding: 10, borderRadius: 8, whiteSpace: 'pre-wrap',
          background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
          fontSize: 12, lineHeight: 1.7, color: 'var(--text-primary)',
        }}>{plainText}</div>
      )}

      {showing === 'source' && hasTimes && (
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
                onChange={(e) => {
                  touchedRef.current = true
                  setDoc({ ...doc, edits: { ...doc.edits, [i]: e.target.value }, updatedAt: Date.now() })
                }}
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
                    touchedRef.current = true
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
      )}

      {/* 고쳤을 때만 나오는 안내 — 평소에는 화면을 채우지 않는다. */}
      {changed > 0 && (
        <span data-testid="transcript-notes" tabIndex={0}
          style={{ fontSize: 10, color: 'var(--amber, #d4a017)' }}
          title={'시간은 처음 인식한 구간을 따릅니다 — 고친 글자에 맞춰 다시 계산하지 않았습니다. '
            + '자막 파일은 겹치지 않게 끝을 아주 조금만 다듬습니다.'
            + (notes ? ' ' + saveNoteText(notes).join(' ') : '')}>
          알아 둘 점 {1 + (notes ? saveNoteText(notes).length : 0)}건
        </span>
      )}

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        paddingTop: 8, borderTop: '1px solid var(--border-subtle)',
      }}>
        {/* ★화면에 보이는 글이 그대로 복사된다(고친 내용 반영). */}
        <button type="button" data-testid="transcript-copy" onClick={() => { void copyNow() }}
          title={showing === 'translation' ? '번역을 그대로 복사합니다.' : '고친 내용을 반영한 글을 복사합니다.'}
          style={btn('var(--bg-elevated)', 'var(--text-primary)')}>
          {showing === 'translation' ? '번역 복사' : '글 복사'}
        </button>
        <button type="button" data-testid="transcript-save" onClick={() => { void save() }}
          disabled={!hasTimes}
          title={hasTimes
            ? '교정본 TXT·SRT 를 새 파일로 저장합니다. 처음 인식한 파일은 그대로 둡니다.'
            : '문장별 시간이 없어 교정본 자막을 만들 수 없습니다.'}
          style={btn('var(--cyan)', '#fff', !hasTimes)}>교정본 저장</button>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}
          title="처음 인식한 파일은 그대로 두고 _corrected 파일로 저장합니다.">
          최초 결과는 그대로 둡니다
        </span>
        {outputDir && (
          <button type="button" data-testid="transcript-folder"
            onClick={() => window.api.app.openFolder(outputDir)}
            title="결과가 저장된 폴더를 엽니다"
            style={{ ...btn('transparent', 'var(--text-secondary)'), marginLeft: 'auto', border: '1px solid var(--border-subtle)' }}>
            폴더
          </button>
        )}
      </div>

      {copied && (
        <div data-testid="transcript-copied" role="status" style={{ fontSize: 10, color: 'var(--text-muted)' }}>{copied}</div>
      )}

      {(error || message) && (
        <div data-testid="transcript-message" role="status" style={{
          fontSize: 11, lineHeight: 1.6, color: error ? 'var(--rose, #fb7185)' : 'var(--text-secondary)',
        }}>{error || message}</div>
      )}
    </div>
  )
}
