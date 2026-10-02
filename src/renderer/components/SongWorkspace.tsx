import WorkspaceDock from './WorkspaceDock'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { FileInfo } from '../../shared/types'
import { useAppStore } from '@/stores/app.store'
import { isCancelCleanupBusy } from '../../shared/cancelContract'
import DubWorkspace from './DubWorkspace'
import MediaImportCard from './MediaImportCard'
import SongResultCard from './SongResultCard'
import {
  songRequestFault, songEventFault,
  type SongResult, type SongProgress,
} from '../../shared/songJob'

// 선택은 화면이 소유하고, 엔진 요청은 `window.api.song` 이 맡는다(원본은 읽기만 한다).
const draft: { source: FileInfo | null; voice: FileInfo | null; initialized: boolean } = { source: null, voice: null, initialized: false }
const panel: CSSProperties = { padding: 20, border: '1px solid var(--border-subtle)', borderRadius: 16, background: 'var(--bg-card)', minWidth: 0 }
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }
const btn: CSSProperties = { font: 'inherit', fontSize: 12, padding: '8px 12px', borderRadius: 9, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: 'pointer' }

export default function SongWorkspace() {
  const [tab, setTab] = useState<'song' | 'dub'>('song')
  const status = useAppStore(s => s.status), errorInfo = useAppStore(s => s.errorInfo)
  const locked = status === 'processing' || isCancelCleanupBusy(status) || !!errorInfo?.childAlive
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
    <div role="tablist" aria-label="노래 변환 작업" style={{ ...row, gap: 4, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 10 }}>
      {(['song', 'dub'] as const).map((key, index) => <button key={key} type="button" role="tab" id={`song-tab-${key}`} aria-controls={`song-panel-${key}`} aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} disabled={locked} style={{ ...btn, borderColor: tab === key ? 'var(--border-accent)' : 'transparent', color: tab === key ? 'var(--accent-light)' : 'var(--text-muted)', background: tab === key ? 'var(--accent-glow)' : 'transparent' }}
        onClick={() => setTab(key)} onKeyDown={e => { if (locked || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); const next = e.key === 'Home' ? 'song' : e.key === 'End' ? 'dub' : index === 0 ? 'dub' : 'song'; setTab(next); document.getElementById(`song-tab-${next}`)?.focus() }}>
        {key === 'song' ? '노래 변환' : '기존 더빙'}
      </button>)}
    </div>
    <div role="tabpanel" id={`song-panel-${tab}`} aria-labelledby={`song-tab-${tab}`}>
      {tab === 'song' ? <SongCards disabled={locked}/> : <DubWorkspace/>}
    </div>
  </div>
}

function SongCards({ disabled }: { disabled: boolean }) {
  const [files, setFiles] = useState(() => {
    if (!draft.initialized) { draft.source = useAppStore.getState().fileInfo; draft.initialized = true }
    return { source: draft.source, voice: draft.voice }
  })
  const [loading, setLoading] = useState<'source' | 'voice' | null>(null)
  const [error, setError] = useState('')
  const generation = useRef(0), pending = useRef(false)
  useEffect(() => () => { generation.current++ }, [])
  const update = (kind: 'source' | 'voice', info: FileInfo | null) => {
    draft[kind] = info; setFiles(current => ({ ...current, [kind]: info }))
  }
  const load = async (kind: 'source' | 'voice', path?: string) => {
    if (disabled || pending.current) return
    const id = ++generation.current
    pending.current = true; setLoading(kind); setError('')
    try {
      const selected = path || await window.api.audio.selectFile(false, kind)
      const target = Array.isArray(selected) ? selected[0] : selected
      if (!target || id !== generation.current) return
      const info = await window.api.audio.getFileInfo(target)
      const state = useAppStore.getState()
      if (id === generation.current && state.status !== 'processing' && !isCancelCleanupBusy(state.status) && !state.errorInfo?.childAlive) update(kind, info)
    } catch { if (id === generation.current) setError('파일을 열지 못했습니다. 다시 선택해 주세요.') }
    finally { if (id === generation.current) { pending.current = false; setLoading(null) } }
  }
  // ── 엔진 연결 ────────────────────────────────────────────────────────
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<SongProgress>({})
  const [result, setResult] = useState<SongResult | null>(null)
  const [notice, setNotice] = useState('')
  /** 지금 기다리는 요청. **늦게 온 응답이 화면을 흔들지 않게** 이것으로 대조한다. */
  const reqId = useRef('')
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  useEffect(() => {
    const offP = window.api.song.onProgress((raw: unknown) => {
      if (songEventFault(raw, reqId.current)) return
      if (alive.current) setProgress(raw as SongProgress)
    })
    const offE = window.api.song.onError((raw: unknown) => {
      if (songEventFault(raw, reqId.current)) return
      const m = (raw as { message?: string })?.message
      if (alive.current) { setError(m || '노래 변환에 실패했습니다'); setBusy(false) }
      reqId.current = ''
    })
    const offC = window.api.song.onCancelled((raw: unknown) => {
      if (songEventFault(raw, reqId.current)) return
      if (alive.current) { setNotice('노래 변환을 멈췄습니다.'); setBusy(false) }
      reqId.current = ''
    })
    return () => { offP(); offE(); offC() }
  }, [])

  const blocked = songRequestFault({
    source: files.source ? { path: files.source.path, name: files.source.name, duration: files.source.duration } : null,
    voice: files.voice ? { path: files.voice.path, name: files.voice.name, duration: files.voice.duration } : null,
  })

  const run = async () => {
    if (disabled || busy || blocked) return
    // ★요청 시점의 입력을 **여기서 굳힌다.** 도는 동안 선택을 바꿔도 결과에는 이 값이 붙는다.
    const source = { path: files.source!.path, name: files.source!.name, duration: files.source!.duration }
    const voice = { path: files.voice!.path, name: files.voice!.name, duration: files.voice!.duration }
    const id = crypto.randomUUID()
    reqId.current = id
    setBusy(true); setError(''); setNotice(''); setProgress({ percent: 0, message: '준비 중' })
    try {
      const r = await window.api.song.run({ clientRequestId: id, source, voice, splitLead: false }) as
        { ok: boolean; data?: SongResult; error?: string; code?: string }
      if (!alive.current || reqId.current !== id) return      // 지난 요청의 응답은 버린다
      if (!r?.ok) {
        // 멈춤은 실패가 아니다 — 취소 알림이 이미 말했다.
        if (r?.code !== 'CANCELLED') setError(r?.error || '노래 변환에 실패했습니다')
        return
      }
      // ★실패해도 **이전 결과와 선택을 지우지 않는다.** 성공했을 때만 갈아 끼운다.
      setResult(r.data!)
      setNotice('변환이 끝났습니다.')
    } catch (e) {
      if (alive.current && reqId.current === id) setError((e as Error)?.message || '노래 변환에 실패했습니다')
    } finally {
      if (alive.current && reqId.current === id) { setBusy(false); reqId.current = '' }
    }
  }

  /**
   * 멈추기. **실패를 삼키지 않는다**(2026-09-27 지시 2).
   *
   * ★트리 종료가 확인되지 않으면 본체는 GPU 잠금을 **풀지 않는다.** 화면도 같은 상태를
   *   유지해야 한다 — 멈춤 표시를 먼저 띄우면 사용자는 끝난 줄 알고 다음 작업을 누른다.
   *   그래서 여기서는 사유만 알리고 **'멈추기' 를 계속 눌러 다시 시도할 수 있게** 둔다.
   */
  const stop = async () => {
    setError(''); setNotice('')
    try {
      const r = await window.api.song.cancel() as
        { ok: boolean; data?: { stopped?: boolean; treeKillConfirmed?: boolean; reason?: string }; error?: string }
      if (!alive.current) return
      if (!r?.ok) { setError(r?.error || '멈추지 못했습니다. 다시 시도해 주세요.'); return }
      if (r.data?.stopped === false) { setNotice(r.data.reason || '돌고 있는 변환이 없습니다.'); return }
      if (r.data?.treeKillConfirmed === false) {
        setError(`아직 끝난 것을 확인하지 못했습니다 — ${r.data.reason || '바깥 변환기가 남아 있을 수 있습니다'}. `
          + '다시 누르면 한 번 더 시도합니다.')
      }
    } catch (e) {
      if (alive.current) setError((e as Error)?.message || '멈추지 못했습니다. 다시 시도해 주세요.')
    }
  }

  // ★결과 카드의 계약: 실패는 **던진다**(카드가 제 자리에 표시한다).
  //   저장 창을 사용자가 닫은 것은 실패가 아니다 — 조용히 돌아온다.
  const save = async (which: 'mix' | 'vocal' | 'withHarmony', requestId: string) => {
    setError(''); setNotice('')
    // ★**결과 카드가 보여 주고 있는** 요청의 식별자를 그대로 넘긴다.
    //   본체가 들고 있는 마지막 결과를 쓰면 화면의 옛 결과에서 눌렀을 때 다른 파일이 저장된다.
    const r = await window.api.song.exportResult(which, requestId) as
      { ok: boolean; data?: { path: string; canceled?: boolean }; error?: string }
    if (!r?.ok) throw new Error(r?.error || '저장하지 못했습니다')
    if (r.data?.canceled) return
    if (alive.current) setNotice(`저장했습니다: ${r.data!.path}`)
  }

  /** 결과가 놓인 자리를 연다. 여는 것은 **결과 파일**이지 작업 폴더 전체가 아니다. */
  const openFolder = async (mixPath: string) => {
    if (!mixPath) throw new Error('열 결과가 없습니다')
    const okOpen = await window.api.app.revealFile(mixPath)
    if (okOpen === false) throw new Error('결과 폴더를 열지 못했습니다')
  }

  const shared = useAppStore(s => s.fileInfo)
  return <div data-testid="song-cards" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 16, alignItems: 'start' }}>
    <section aria-label="원곡" style={panel}>
      <div style={{ ...row, marginBottom: 14 }}><span style={{ fontSize: 11, color: 'var(--accent-light)' }}>01</span><h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, flex: 1 }}>원곡</h2>
        {shared && files.source?.path !== shared.path && <button type="button" style={btn} disabled={disabled || !!loading} title={shared.name} onClick={() => update('source', shared)}>열어 둔 파일 사용</button>}
      </div>
      <MediaImportCard file={files.source} busy={loading === 'source'} disabled={disabled || !!loading} onPick={() => void load('source')} onDrop={path => void load('source', path)} onClear={() => update('source', null)}/>
    </section>
    <section aria-label="목소리" style={panel}>
      <div style={{ ...row, marginBottom: 14 }}><span style={{ fontSize: 11, color: 'var(--accent-light)' }}>02</span><h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, flex: 1 }}>목소리</h2><span title="이 목소리로 원곡을 부릅니다. 길어도 괜찮습니다 — 변환할 때 앱이 깨끗한 8초 토막을 골라 쓰고 원본은 그대로 둡니다." tabIndex={0} style={{ fontSize: 11, color: 'var(--text-muted)' }}>음원 · 영상</span></div>
      <MediaImportCard voice file={files.voice} busy={loading === 'voice'} disabled={disabled || !!loading} onPick={() => void load('voice')} onDrop={path => void load('voice', path)} onClear={() => update('voice', null)}/>
    </section>
    </div>
    <section aria-label="변환 방식" style={{ ...panel, padding: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 210px), 1fr))', gap: 10 }}>
        <div style={{ ...row, padding: 14, border: '1px solid var(--border-accent)', borderRadius: 12, background: 'var(--accent-glow)' }}>
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4"/></svg>
          <span style={{ fontSize: 13, flex: 1 }}>목소리 바꾸기</span><span aria-label="선택됨" style={{ color: 'var(--accent-light)' }}>✓</span>
        </div>
        <div tabIndex={0} title="원곡 목소리를 유지하며 번역 가사를 멜로디와 리듬에 맞춰 부르는 기능입니다. 후속 개발 예정입니다." style={{ ...row, padding: 14, border: '1px solid var(--border-subtle)', borderRadius: 12, color: 'var(--text-muted)' }}>
          <span aria-hidden="true" style={{ fontSize: 18 }}>文</span><span style={{ fontSize: 13, flex: 1 }}>다른 언어로 부르기</span><span style={{ fontSize: 11 }}>예정</span>
        </div>
      </div>
    </section>
    {error && <div role="alert" style={{ color: 'var(--rose)', fontSize: 12 }}>{error}</div>}
    {notice && <div role="status" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{notice}</div>}
    {/* 결과 재생·비교는 **Codex 의 컴포넌트**가 한다. 여기서는 결과와 콜백만 넘긴다. */}
    {result && <SongResultCard
      result={{
        id: result.clientRequestId,
        title: result.input.source.name,
        originalAudioPath: result.sourceAudioPath,
        mixPath: result.mixPath,
      }}
      disabled={disabled || busy}
      onSave={(snapshot) => save('mix', snapshot.id)}
      onOpenFolder={(snapshot) => openFolder(snapshot.mixPath)}/>}
    <WorkspaceDock><div data-testid="song-controls" style={{ ...row, justifyContent: 'space-between', marginTop: 10, padding: '14px 0 0', borderTop: '1px solid var(--border-subtle)' }}>
      <span tabIndex={0} title={busy ? (progress.message || '노래를 변환하는 중입니다') : (blocked || '원곡의 가락과 박자를 두고 목소리만 바꿉니다')}
        style={{ fontSize: 11, color: busy ? 'var(--accent-light)' : blocked ? 'var(--amber)' : 'var(--text-muted)' }}>
        {busy ? `${progress.percent ?? 0}% ${progress.message || ''}`.trim() : blocked || '준비됨'}
      </span>
      <div style={row}>
        {busy && <button type="button" data-testid="song-cancel" style={btn} onClick={() => void stop()}>멈추기</button>}
        <button type="button" data-testid="song-run" disabled={disabled || busy || !!blocked}
          title={blocked || '노래 변환을 시작합니다'}
          onClick={() => void run()}
          style={{ ...btn, minWidth: 160, background: 'var(--accent-glow)', color: blocked || busy ? 'var(--text-muted)' : 'var(--accent-light)', cursor: blocked || busy ? 'default' : 'pointer' }}>
          {busy ? '변환 중' : '노래 변환'}
        </button>
      </div>
    </div></WorkspaceDock>
  </div>
}
