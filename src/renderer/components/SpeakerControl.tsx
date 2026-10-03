import SpeakerQuickSettings from './SpeakerQuickSettings'
import { openEffectsPanel } from '../lib/playbackEffects'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { usePlaybackVolume } from '../hooks/usePlaybackVolume'
import { getPlaybackBoost, getBoostFailure, onPlaybackBoostChange } from '../lib/playbackBoost'
import ReaderContextMenu from './ReaderContextMenu'
import { Icon, button } from './kit'
/** 왼쪽 누름은 음소거, 오른쪽 누름/메뉴 단추는 공용 재생 옵션. */
export default function SpeakerControl({ id = 'speaker', children }: { id?: string; children?: ReactNode }) {
  const { volume, change, commit, saveFailed } = usePlaybackVolume()
  const [boost, setBoost] = useState(getPlaybackBoost)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const last = useRef(volume || 1)
  if (volume > 0) last.current = volume
  useEffect(() => onPlaybackBoostChange(() => { setBoost(getPlaybackBoost()); setError(getBoostFailure()) }), [])
  const mute = () => { change(volume ? 0 : last.current); commit() }
  return <div onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) }}
    style={{ display: children ? 'contents' : 'inline-flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', padding: '3px 7px', borderRadius: 9, background: '#12151c' }}
    title={error || (saveFailed ? '음량을 저장하지 못했습니다' : '앱 재생 음량 · 우클릭하면 스피커 옵션')}>
    {children || <><button ref={trigger} data-testid={id + '-mute'} aria-label={volume ? '소리 끄기' : '소리 켜기'} onClick={mute}
      style={{ ...button, width: 32, height: 32, padding: 0, display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={volume ? 'volume' : 'mute'} size={18}/></button>
    <input data-testid={id + '-volume'} aria-label="음량" type="range" min="0" max="1" step="0.01" value={volume}
      onChange={e => change(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit}
      style={{ width: 92, accentColor: 'var(--accent-light)' }}/>
    <span style={{ fontSize: 11, minWidth: 32, fontVariantNumeric: 'tabular-nums' }}>{Math.round(volume * 100)}%</span>
    <button data-testid={id + '-speaker-options'} aria-label="스피커 옵션" aria-haspopup="dialog" aria-expanded={!!menu}
      onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenu(menu ? null : { x: r.left, y: r.bottom }) }}
      style={{ ...button, minHeight: 28, padding: '3px 7px', color: boost > 1 ? 'var(--cyan)' : undefined }}>⋯</button></>}
    {error && <span role="alert" style={{ fontSize: 11, color: 'var(--rose)' }}>{error}</span>}
    {menu && <ReaderContextMenu {...menu} label="스피커 옵션" controls close={() => setMenu(null)} restoreFocus={() => trigger.current?.focus()}>
      <SpeakerQuickSettings details={() => { setMenu(null); openEffectsPanel() }}/>
    </ReaderContextMenu>}
  </div>
}
