import { useState } from 'react'
import { useAppStore } from '@/stores/app.store'

export default function Options() {
  const { mode, trimSilence, silenceGap, transcribe, translate, exportSrt, outputFormat, whisperModel, demucsModel, nSpeakers,
    setTrimSilence, setSilenceGap, setTranscribe, setTranslate, setExportSrt, setOutputFormat, setWhisperModel, setDemucsModel, setNSpeakers, status } = useAppStore()
  const disabled = status === 'processing'
  const [open, setOpen] = useState(false)

  const isTranscribeMode = mode === 'transcribe'
  const isSplitMode = mode === 'split'

  const chip = (checked: boolean, color: string, label: string, onChange: (v: boolean) => void) => (
    <label style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
      borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer',
      background: checked ? `${color}18` : 'var(--bg-elevated)',
      border: `1px solid ${checked ? color : 'var(--border-subtle)'}`,
      opacity: disabled ? 0.5 : 1, fontSize: 11, fontWeight: 500,
      color: checked ? color : 'var(--text-muted)', transition: 'all 0.15s'
    }}>
      <input type="checkbox" checked={checked} onChange={(e) => !disabled && onChange(e.target.checked)}
        disabled={disabled} style={{ display: 'none' }} />
      {label}
    </label>
  )

  return (
    <div style={{ borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
      {/* Toggle header */}
      <button onClick={() => setOpen(!open)} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        width: '100%', padding: '10px 16px', border: 'none', cursor: 'pointer',
        background: 'transparent', fontFamily: 'inherit', outline: 'none'
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>옵션</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Active options preview (when collapsed) */}
          {!open && (
            <div style={{ display: 'flex', gap: 4 }}>
              {!isTranscribeMode && trimSilence && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--accent-glow)', color: 'var(--accent)' }}>무음제거</span>}
              {!isTranscribeMode && transcribe && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--cyan-glow)', color: 'var(--cyan)' }}>텍스트</span>}
              {translate && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--emerald-glow)', color: 'var(--emerald)' }}>번역</span>}
              {exportSrt && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'rgba(251,191,36,0.15)', color: 'var(--amber)' }}>SRT</span>}
              {!isTranscribeMode && outputFormat !== 'wav' && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>{outputFormat.toUpperCase()}</span>}
            </div>
          )}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round"
            style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </button>

      {/* Expandable content */}
      {open && (
        <div style={{ padding: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Chips row */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {!isTranscribeMode && !isSplitMode && chip(trimSilence, 'var(--accent)', '무음 구간 제거', setTrimSilence)}
            {!isTranscribeMode && !isSplitMode && chip(transcribe, 'var(--cyan)', '텍스트 변환', setTranscribe)}
            {isSplitMode && chip(transcribe, 'var(--cyan)', '트랙별 가사 추출', setTranscribe)}
            {chip(translate, 'var(--emerald)', '한국어 번역', setTranslate)}
            {chip(exportSrt, 'var(--amber)', 'SRT 자막', setExportSrt)}
          </div>

          {/* Sub-options row */}
          <div style={{ display: 'flex', gap: 10 }}>
            {trimSilence && !isTranscribeMode && !isSplitMode && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 8, background: 'var(--bg-elevated)' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>무음 간격</span>
                <input type="range" min="0" max="2" step="0.1" value={silenceGap}
                  onChange={(e) => setSilenceGap(parseFloat(e.target.value))} disabled={disabled}
                  style={{ flex: 1, accentColor: 'var(--accent)', cursor: 'pointer', height: 4 }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-light)', fontVariantNumeric: 'tabular-nums', minWidth: 32 }}>{silenceGap.toFixed(1)}초</span>
              </div>
            )}
            {!isTranscribeMode && !isSplitMode && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'var(--bg-elevated)' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>출력</span>
                {(['wav', 'mp3', 'flac'] as const).map((fmt) => (
                  <button key={fmt} onClick={() => !disabled && setOutputFormat(fmt)} disabled={disabled} style={{
                    padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer',
                    fontSize: 10, fontWeight: 600, textTransform: 'uppercase', fontFamily: 'inherit',
                    background: outputFormat === fmt ? 'var(--accent)' : 'transparent',
                    color: outputFormat === fmt ? '#fff' : 'var(--text-muted)'
                  }}>{fmt}</button>
                ))}
              </div>
            )}
          </div>

          {/* Model selection row */}
          <div style={{ display: 'flex', gap: 10 }}>
            {/* Whisper model */}
            {(transcribe || isTranscribeMode || isSplitMode) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'var(--bg-elevated)' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Whisper</span>
                {(['small', 'medium', 'large-v3'] as const).map((m) => (
                  <button key={m} onClick={() => !disabled && setWhisperModel(m)} disabled={disabled} style={{
                    padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer',
                    fontSize: 10, fontWeight: 600, fontFamily: 'inherit',
                    background: whisperModel === m ? 'var(--cyan)' : 'transparent',
                    color: whisperModel === m ? '#fff' : 'var(--text-muted)'
                  }}>{m === 'large-v3' ? 'Large' : m.charAt(0).toUpperCase() + m.slice(1)}</button>
                ))}
              </div>
            )}
            {/* Speaker count (conversation mode) */}
            {mode === 'conversation' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'var(--bg-elevated)' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>화자 수</span>
                {[2, 3, 4, 5].map((n) => (
                  <button key={n} onClick={() => !disabled && setNSpeakers(n)} disabled={disabled} style={{
                    padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer',
                    fontSize: 10, fontWeight: 600, fontFamily: 'inherit',
                    background: nSpeakers === n ? 'var(--cyan)' : 'transparent',
                    color: nSpeakers === n ? '#fff' : 'var(--text-muted)'
                  }}>{n}명</button>
                ))}
              </div>
            )}
            {/* Demucs model */}
            {mode === 'music' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'var(--bg-elevated)' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Demucs</span>
                {(['htdemucs', 'htdemucs_ft'] as const).map((m) => (
                  <button key={m} onClick={() => !disabled && setDemucsModel(m)} disabled={disabled} style={{
                    padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer',
                    fontSize: 10, fontWeight: 600, fontFamily: 'inherit',
                    background: demucsModel === m ? 'var(--accent)' : 'transparent',
                    color: demucsModel === m ? '#fff' : 'var(--text-muted)'
                  }}>{m === 'htdemucs' ? '기본' : '고품질'}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
