import { useAppStore } from '@/stores/app.store'
import DropZone from '@/components/DropZone'
import ModeSelector from '@/components/ModeSelector'
import Waveform from '@/components/Waveform'
import ProcessButton from '@/components/ProcessButton'
import ProgressBar from '@/components/ProgressBar'
import TrackList from '@/components/TrackList'
import Options from '@/components/Options'
import SplitEditor from '@/components/SplitEditor'
import TTSEditor from '@/components/TTSEditor'

export default function App() {
  const { fileInfo, mode, status, reset } = useAppStore()
  const setIdle = () => useAppStore.setState({ status: 'idle', tracks: [], error: null, progress: 0 })

  const handleRestore = async () => {
    const result = await window.api.audio.restoreFromFolder()
    if (result && result.tracks.length > 0) {
      useAppStore.setState({
        fileInfo: { path: '', name: '이전 결과 복원', duration: 0, channels: 0, sampleRate: 0, format: '' },
        fileUrl: null,
        status: 'done',
        tracks: result.tracks,
        outputDir: result.outputDir,
        mode: 'split'
      })
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-base)', color: 'var(--text-primary)', fontFamily: "'Inter', -apple-system, sans-serif" }}>
      {/* Title bar */}
      <div className="titlebar-drag" style={{
        display: 'flex', alignItems: 'center', height: 36, flexShrink: 0, padding: '0 16px',
        background: 'rgba(8,8,12,0.8)', borderBottom: '1px solid var(--border-subtle)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M12 3v18M8 7l4-4 4 4" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="12" cy="18" r="3" fill="var(--accent)" opacity="0.3" stroke="var(--accent)" strokeWidth="1.5" />
          </svg>
          <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-muted)' }}>
            AudioForge
          </span>
        </div>
      </div>

      {/* Background orbs */}
      <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
        <div style={{ position: 'absolute', left: -128, top: -128, width: 384, height: 384, borderRadius: '50%', opacity: 0.15, filter: 'blur(120px)', background: 'var(--accent)' }} />
        <div style={{ position: 'absolute', right: -128, bottom: -192, width: 384, height: 384, borderRadius: '50%', opacity: 0.08, filter: 'blur(120px)', background: 'var(--cyan)' }} />
      </div>

      {/* Content */}
      {!fileInfo ? (
        /* ── 초기 화면 ── */
        <div style={{ position: 'relative', zIndex: 1, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: '100%', maxWidth: 520, padding: '0 40px' }}>
            <div style={{ textAlign: 'center', marginBottom: 32 }}>
              <h1 style={{ fontSize: 28, fontWeight: 700, background: 'linear-gradient(135deg, var(--text-primary), var(--accent-light))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                AudioForge
              </h1>
              <p style={{ marginTop: 8, fontSize: 13, color: 'var(--text-muted)' }}>AI 기반 오디오 분리 · 텍스트 변환 · 번역</p>
            </div>
            <DropZone />
            <button onClick={handleRestore} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              width: '100%', marginTop: 16, padding: '10px 0', borderRadius: 10,
              border: '1px solid var(--border-subtle)', background: 'transparent',
              cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 500,
              color: 'var(--text-muted)'
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              이전 결과 폴더 열기
            </button>
          </div>
        </div>
      ) : (
        /* ── 작업 화면 ── */
        <div style={{ position: 'relative', zIndex: 1, flex: 1, overflowY: 'auto', display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: '100%', maxWidth: 720, padding: '24px 40px 40px' }}>
            {/* 파일 정보 + 파형 (합침) */}
            <div style={{
              borderRadius: 14, overflow: 'hidden', marginBottom: 16,
              background: 'var(--bg-card)', border: '1px solid var(--border-subtle)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                    background: 'var(--accent-glow)', border: '1px solid var(--border-accent)'
                  }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                    </svg>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {fileInfo.name}
                    </div>
                    <div style={{ marginTop: 3, display: 'flex', gap: 6 }}>
                      {[
                        `${Math.floor(fileInfo.duration / 60)}:${String(Math.floor(fileInfo.duration % 60)).padStart(2, '0')}`,
                        fileInfo.channels === 1 ? 'Mono' : 'Stereo',
                        `${(fileInfo.sampleRate / 1000).toFixed(1)}kHz`,
                        fileInfo.format.toUpperCase()
                      ].map((t, i) => (
                        <span key={i} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>{t}</span>
                      ))}
                    </div>
                  </div>
                </div>
                <button onClick={reset} style={{
                  display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px',
                  borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  fontSize: 11, fontWeight: 500, background: 'var(--bg-elevated)', color: 'var(--text-muted)'
                }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
              <Waveform />
            </div>

            {/* 모드 + 옵션 + 버튼 + 결과 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <ModeSelector />
              {mode === 'split' ? <SplitEditor /> : mode === 'tts' ? <TTSEditor /> : <Options />}
              <ProcessButton />
              <ProgressBar />
              <TrackList />
              {/* 재처리 버튼 (결과 나온 후) */}
              {status === 'done' && (
                <button onClick={setIdle} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  width: '100%', padding: '10px 0', borderRadius: 10,
                  border: '1px solid var(--border-subtle)', background: 'var(--bg-card)',
                  cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 500,
                  color: 'var(--text-secondary)'
                }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
                  </svg>
                  다른 모드로 재처리
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
