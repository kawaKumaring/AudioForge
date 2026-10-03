import { useRef, useState, type CSSProperties } from 'react'
import type { FileInfo } from '../../shared/types'

export function MediaGlyph({ voice = false }: { voice?: boolean }) {
  return <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={voice ? 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8' : 'M3 15v6h18v-6M12 16V3m-5 5 5-5 5 5'}/></svg>
}
const small: CSSProperties = { font: 'inherit', fontSize: 12, border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '7px 10px', background: 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: 'pointer' }

/** Shared visual language for media input; the parent owns loading and its destination. */
export default function MediaImportCard({ file, voice = false, busy = false, disabled = false, onPick, onDrop, onClear, pickerLabel, testId }: {
  pickerLabel?: string; testId?: string
  file: FileInfo | null; voice?: boolean; busy?: boolean; disabled?: boolean
  onPick: () => void; onDrop: (path: string) => void; onClear: () => void
}) {
  const [drag, setDrag] = useState(false), depth = useRef(0)
  const locked = busy || disabled
  return <div data-testid={testId || (voice ? 'song-voice-input' : 'song-source-input')}
    onDragEnter={e => { e.preventDefault(); if (e.dataTransfer.types.includes('Files')) { depth.current++; if (!locked) setDrag(true) } }}
    onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = locked ? 'none' : 'copy' }}
    onDragLeave={e => { e.preventDefault(); if (--depth.current <= 0) { depth.current = 0; setDrag(false) } }}
    onDrop={e => { e.preventDefault(); depth.current = 0; setDrag(false); if (locked) return; const item = e.dataTransfer.files[0]; if (item) { const path = window.api.utils.getPathForFile(item); if (path) onDrop(path) } }}
    style={{ minWidth: 0, borderRadius: 14, border: `1px ${file ? 'solid' : 'dashed'} ${drag ? 'var(--accent)' : 'var(--border-accent, var(--border-subtle))'}`, background: drag ? 'var(--accent-glow)' : 'var(--bg-base)', overflow: 'hidden' }}>
    {!file ? <button type="button" className="source-dropzone" onClick={onPick} disabled={locked} aria-label={pickerLabel || (voice ? '목소리 음원 또는 영상 선택' : '원곡 음원 또는 영상 선택')}
      style={{ width: '100%', minHeight: 180, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 11, padding: '22px 12px', border: 0, background: 'transparent', color: 'var(--text-primary)', font: 'inherit', cursor: locked ? 'default' : 'pointer' }}>
      <span style={{ display: 'grid', placeItems: 'center', width: 48, height: 48, borderRadius: 14, background: 'var(--accent-glow)', color: 'var(--accent-light)' }}><MediaGlyph voice={voice}/></span>
      <span style={{ fontSize: 14, fontWeight: 600 }}>{busy ? '파일을 여는 중…' : voice ? '어떤 목소리로 부를까요?' : '오디오나 영상 파일을 가져오세요'}</span>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>끌어 놓거나 클릭해서 선택</span>
      {!voice && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>WAV · MP3 · M4A · FLAC · MP4 · MKV</span>}
    </button> : <div style={{ padding: 18, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <span style={{ color: 'var(--accent-light)' }}><MediaGlyph voice={voice}/></span>
      <div style={{ flex: '1 1 140px', minWidth: 0 }}>
        <div title={file.path} style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>{busy ? '파일을 여는 중…' : `${Math.floor(file.duration / 60)}:${String(Math.floor(file.duration % 60)).padStart(2, '0')} · ${file.format.toUpperCase()}`}</div>
      </div>
      <button type="button" style={small} disabled={locked} onClick={onPick} aria-label={voice ? '목소리 파일 변경' : '원곡 파일 변경'}>변경</button>
      <button type="button" style={small} disabled={locked} onClick={onClear} aria-label={voice ? '목소리 파일 닫기' : '원곡 파일 닫기'} title="선택만 비웁니다. 원본 파일은 그대로 남습니다.">×</button>
    </div>}
  </div>
}
