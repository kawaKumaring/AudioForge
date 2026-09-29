import { useEffect, useRef, useState } from 'react'
import { useAppStore, type RestorableSession } from '@/stores/app.store'
import ModeSelector, { WORKSPACES } from '@/components/ModeSelector'
import SourceCard from '@/components/SourceCard'
import ProcessButton from '@/components/ProcessButton'
import ProgressBar from '@/components/ProgressBar'
import TrackList from '@/components/TrackList'
import Options from '@/components/Options'
import AppOptions from '@/components/AppOptions'
import SplitEditor from '@/components/SplitEditor'
import SynthesisTabs from '@/components/SynthesisTabs'
import { useSynthesisCards } from '@/stores/synthesisCards.store'
import TranscriptEditor from '@/components/TranscriptEditor'
import DialogueWorkspace from '@/components/DialogueWorkspace'
import LabPlaceholder from '@/components/LabPlaceholder'
import SongWorkspace from '@/components/SongWorkspace'
import ReaderWorkspace from '@/components/ReaderWorkspace'
import TtsResultInfo from '@/components/TtsResultInfo'
import AppVersionLabel from '@/components/AppVersionLabel'
import { loadPlaybackVolume } from '@/lib/playbackVolume'
import ConsolePanel, { loadConsolePref } from '@/components/ConsolePanel'
import { opLog } from '@/lib/opLog'
import { isCancelCleanupBusy } from '../shared/cancelContract'

export default function App() {
  const { fileInfo, mode, synthesisTab, status, resultMode, errorInfo, restorable, restoreSession, setRestorable } = useAppStore()

  const [restoring, setRestoring] = useState(false)
  /** 설정 화면. 작업 화면을 덮지 않고 **그 자리에서** 연다. */
  const [showOptions, setShowOptions] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  useEffect(() => { void loadPlaybackVolume() }, [])
  // 콘솔 창 — 켜 두었으면 다시 띄운다. 화면을 옮긴 것도 동작 기록에 남긴다(2026-09-30).
  useEffect(() => { void loadConsolePref() }, [])
  useEffect(() => { opLog('mode', `화면 ${mode}`) }, [mode])
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0 }, [mode, synthesisTab])
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const motion = pageRef.current?.animate([
      { opacity: 0.45, transform: 'translateY(6px)' },
      { opacity: 1, transform: 'translateY(0)' }
    ], { duration: 180, easing: 'cubic-bezier(.2,.7,.3,1)' })
    return () => motion?.cancel()
  }, [mode, synthesisTab])

  const synthesisView = useSynthesisCards(s => s.view)
  const workspace = WORKSPACES[mode]
  const showSharedRun = mode !== 'tts' && mode !== 'lab' && mode !== 'dub' && mode !== 'reader'
  const busy = status === 'processing' || isCancelCleanupBusy(status) || !!errorInfo?.childAlive
  const ownResult = resultMode === mode
  const sharedResults = ownResult && (showSharedRun || (mode === 'tts' && synthesisView === 'legacy' && synthesisTab === 'advanced'))
  const done = ownResult && status === 'done'
  const resetRun = () => useAppStore.setState({ status: 'idle', tracks: [], resultMode: null, error: null, errorInfo: null, progress: 0 })


  return <div data-testid="workspace-shell" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
    <div className="titlebar-drag" style={{ display: 'flex', alignItems: 'center', height: 36, flexShrink: 0, padding: '0 18px', background: 'var(--bg-primary)', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 10v4M7 6v12M12 3v18M17 7v10M21 10v4"/></svg>
        <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.02em' }}>AudioForge</span>
      </div>
    </div>
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <aside data-testid="workspace-sidebar" style={{ width: 196, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 24, padding: '28px 12px 18px', background: 'var(--bg-primary)', borderRight: '1px solid var(--border-subtle)', overflowY: 'auto' }}>
        <ModeSelector />
        <div style={{ marginTop: 'auto', padding: '18px 0 0', borderTop: '1px solid var(--border-subtle)' }}>
          <button type="button" data-testid="open-app-options" onClick={() => setShowOptions(v => !v)}
            aria-pressed={showOptions} className="btn btn-ghost"
            title="만든 것을 둘 자리와 쌓인 것 비우기"
            style={{ width: '100%', fontSize: 11, padding: '7px 8px', marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>
            </svg>
            설정
          </button>
          <AppVersionLabel />
        </div>
      </aside>
      {/* 설정 — 팝업으로 띄운다(2026-09-28 지시). 레이아웃 흐름 밖에 둔다. */}
      {showOptions && <AppOptions close={() => setShowOptions(false)}/>}
      <main ref={scrollRef} data-testid="workspace-content" style={{ flex: 1, minWidth: 0, overflowY: 'auto', scrollbarGutter: 'stable' }}>
        <div ref={pageRef} style={{ width: '100%', maxWidth: 1120, margin: '0 auto', padding: '30px clamp(18px, 3vw, 40px) 48px' }}>
          <header style={{ marginBottom: mode === 'tts' ? 20 : 26 }}>
            {mode !== 'tts' && <div style={{ marginBottom: 9, fontSize: 11, color: 'var(--text-muted)' }}>{workspace.group}</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h1 title={workspace.description} style={{ fontSize: 25, lineHeight: 1.35, fontWeight: 600, letterSpacing: '-.035em' }}>{workspace.label}</h1>
              {mode === 'dub' && <span style={{ padding: '3px 7px', border: '1px solid var(--border-subtle)', borderRadius: 5, color: 'var(--text-muted)', fontSize: 10 }}>개발 중</span>}
              {busy && <span role="status" data-testid="workspace-activity" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginLeft: 'auto', fontSize: 11, color: 'var(--accent-light)' }}>
                <span className="workspace-activity" aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, height: 18 }}>
                  {[0, 1, 2, 3].map(i => <span key={i} style={{ width: 3, height: 14, borderRadius: 2, background: 'currentColor', animationDelay: `${i * 110}ms` }} />)}
                </span>
                {status === 'cancelling' ? '작업 정리 중' : status === 'processing' ? '작업 중' : '작업 종료 확인 중'}
              </span>}
            </div>

          </header>

          {showSharedRun && <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <ol aria-label="작업 흐름" style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap', listStyle: 'none', paddingBottom: 18, borderBottom: '1px solid var(--border-subtle)' }}>
              {['원본 선택', '설정과 실행', '결과 확인'].map((label, i) => {
                const step = !fileInfo ? 0 : done ? 2 : 1
                return <li key={label} aria-current={step === i ? 'step' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: step === i ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', fontSize: 10, background: step === i ? 'var(--accent-glow)' : 'var(--bg-elevated)', color: step === i ? 'var(--accent-light)' : 'inherit' }}>{i + 1}</span>{label}
                </li>
              })}
            </ol>
            <SourceCard />
            {fileInfo && restorable && status === 'idle' && <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderRadius: 10, padding: 14, background: 'var(--accent-glow)', border: '1px solid var(--border-accent)' }}>
              <span style={{ flex: '1 1 200px', fontSize: 12 }}>이 원본으로 만든 이전 결과가 있습니다.</span>
              <button type="button" className="btn btn-ghost" onClick={() => restoreSession(restorable.dir, restorable.session)} style={{ fontSize: 12 }}>결과 불러오기</button>
              <button type="button" className="btn btn-ghost" onClick={() => setRestorable(null)} style={{ fontSize: 12 }}>새로 작업</button>
            </div>}
            {fileInfo && <>
              {mode === 'split' ? <SplitEditor /> : <Options />}
              <ProcessButton />
              <ProgressBar />
            </>}
          </div>}

          {mode === 'tts' && <SynthesisTabs />}
          {mode === 'dub' && <SongWorkspace />}
          {mode === 'reader' && <ReaderWorkspace />}
          {mode === 'lab' && <LabPlaceholder />}

          {sharedResults && (status === 'done' || status === 'error') && <section data-testid="shared-results" aria-label="현재 작업 결과" style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: 24 }}>
            {status === 'done' && <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid var(--border-subtle)', paddingTop: 20 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--emerald)' }}/>
              <h2 style={{ fontSize: 14, fontWeight: 600 }}>{workspace.label} 결과</h2>
            </div>}
            <TtsResultInfo />
            <TrackList />
            {mode === 'transcribe' && done && <TranscriptEditor />}
            {mode === 'conversation' && done && <DialogueWorkspace />}
            {showSharedRun && done && <button type="button" className="btn btn-ghost" onClick={resetRun} style={{ alignSelf: 'flex-start', fontSize: 12 }}>설정을 바꿔 다시 작업</button>}
          </section>}
        </div>
      </main>
    </div>
    {/* 콘솔 서랍 — 설정에서 켜면 맨 아래에 생긴다. 떠 있지 않아 본문을 가리지 않는다(2026-09-30 피드백). */}
    <ConsolePanel />
  </div>
}
