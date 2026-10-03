import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_EFFECTS, type PlaybackEffects } from '../../shared/playbackEffects'
import { effectsPanelOpen, effectsSaveFailed, getPlaybackEffects, onPlaybackEffects, openEffectsPanel, savePlaybackEffects, setPlaybackEffects } from '../lib/playbackEffects'
import { Icon, button } from './kit'
export default function PlaybackEffectsPanel({ embedded = false }: { embedded?: boolean }) {
 const [, render] = useState(0)
 const close = useRef<HTMLButtonElement>(null)
 useEffect(() => onPlaybackEffects(() => render(n => n + 1)), [])
 const open = effectsPanelOpen(), s = getPlaybackEffects()
 useEffect(() => { if (!open || embedded) return; const before = document.activeElement as HTMLElement | null; close.current?.focus(); return () => { if (before?.isConnected) before.focus() } }, [open, embedded])
 if (!open && !embedded) return null
 const change = (next: Partial<PlaybackEffects>) => setPlaybackEffects(next)
 const commit = () => { void savePlaybackEffects() }
 const preset = (next: Partial<PlaybackEffects>) => { change({ ...DEFAULT_EFFECTS, enabled: true, ...next }); commit() }
 const content = <section role={embedded ? undefined : "dialog"} aria-modal={embedded ? undefined : false} aria-label="소리 다듬기" data-testid="playback-effects-panel" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); openEffectsPanel(false) } }}
  style={embedded ? { padding: '8px 0', color: 'var(--text-primary)' } : { position: 'fixed', zIndex: 9000, right: 14, top: 64, bottom: 20, width: 'min(344px, calc(100vw - 28px))', maxHeight: 650, boxSizing: 'border-box', overflowY: 'auto', padding: 22, borderRadius: 18, border: '1px solid var(--border-subtle)', background: '#1b1f29', boxShadow: '0 14px 60px #0008', color: 'var(--text-primary)' }}>
  <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}><h2 style={{ margin: 0, fontSize: 19 }}>소리 다듬기</h2>{!embedded && <button ref={close} style={button} aria-label="소리 다듬기 닫기" onClick={() => openEffectsPanel(false)}><Icon name="close"/></button>}</header>
  <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 22 }} title="모든 작업실의 재생에 함께 적용합니다. 저장 파일은 바뀌지 않습니다.">모든 작업실 · 듣는 소리만</div>
  <button data-testid="effects-bypass" style={{ ...button, width: '100%', justifyContent: 'center', color: s.enabled ? 'var(--cyan)' : undefined, marginBottom: 20 }} aria-pressed={!s.enabled}
   title="음량과 증폭은 유지하고 음색·압축 효과만 비교합니다" onClick={() => { change({ enabled: !s.enabled }); commit() }}>{s.enabled ? '원래 음색과 비교' : '다듬은 소리 듣기'}</button>
  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 24 }}>
   <button style={button} onClick={() => preset({ clarity: 3, bass: -1 })}>선명하게</button>
   <button style={button} onClick={() => preset({ bass: 2, treble: -3 })}>부드럽게</button>
   <button style={button} onClick={() => preset({ compress: true, softenPeaks: true })}>편안하게</button>
  </div>
  {([['bass','저음'],['clarity','말소리 선명도'],['treble','고음']] as const).map(([key,label]) => <label key={key} style={{ display: 'grid', gap: 12, marginBottom: 22 }}>
   <span style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>{label}<span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{s[key] > 0 ? '+' : ''}{s[key]} dB</span></span>
   <input data-testid={'effects-' + key} aria-label={label} type="range" min="-6" max="6" step="0.5" value={s[key]} onChange={e => change({ [key]: Number(e.target.value), enabled: true })} onPointerUp={commit} onKeyUp={commit} onBlur={commit} style={{ width: '100%', accentColor: 'var(--accent-light)' }}/>
  </label>)}
  <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 18, display: 'grid', gap: 18 }}>
   <label title="컴프레서로 큰 말과 작은 말의 차이를 줄입니다" style={{ display: 'flex', gap: 10, fontSize: 13 }}><input type="checkbox" data-testid="effects-compress" checked={s.compress} onChange={e => { change({ compress: e.target.checked, enabled: true }); commit() }}/>음량 차이 줄이기</label>
   <label title="급격한 큰 소리를 압축합니다. 최대 출력의 절대 상한을 보장하는 기능은 아닙니다" style={{ display: 'flex', gap: 10, fontSize: 13 }}><input type="checkbox" data-testid="effects-peaks" checked={s.softenPeaks} onChange={e => { change({ softenPeaks: e.target.checked, enabled: true }); commit() }}/>갑자기 큰 소리 완화</label>
  </div>
  <button style={{ ...button, marginTop: 26, width: '100%', justifyContent: 'center' }} onClick={() => { change(DEFAULT_EFFECTS); commit() }}>음향 효과 초기화</button>
  {effectsSaveFailed() && <div role="alert" style={{ marginTop: 14, color: 'var(--rose)', fontSize: 12 }}>설정을 저장하지 못했습니다 <button style={button} onClick={commit}>다시 저장</button></div>}
 </section>
 return embedded ? content : createPortal(content, document.body)
}
