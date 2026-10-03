import { useEffect, useRef, useState } from 'react'
import { usePlaybackVolume } from '../hooks/usePlaybackVolume'
import { getPlaybackBoost, getBoostFailure, onPlaybackBoostChange, setPlaybackBoost, savePlaybackBoost } from '../lib/playbackBoost'
import { getPlaybackEffects, onPlaybackEffects, setPlaybackEffects, savePlaybackEffects } from '../lib/playbackEffects'
import { DEFAULT_EFFECTS } from '../../shared/playbackEffects'
import { Icon, button } from './kit'
/** 스피커 팝오버와 설정이 같은 값을 읽고 조절한다. */
export default function SpeakerQuickSettings({ details, basicsOnly = false }: { details?: () => void; basicsOnly?: boolean }) {
 const {volume,change,commit,saveFailed}=usePlaybackVolume()
 const [boost,refreshBoost]=useState(getPlaybackBoost),[error,setError]=useState('')
 const [effects,refreshEffects]=useState(getPlaybackEffects)
 const last=useRef(volume||1);if(volume>0)last.current=volume
 useEffect(()=>onPlaybackBoostChange(()=>{refreshBoost(getPlaybackBoost());setError(getBoostFailure())}),[])
 useEffect(()=>onPlaybackEffects(()=>refreshEffects(getPlaybackEffects())),[])
 const saveBoost=()=>{void savePlaybackBoost().then(ok=>setError(ok?getBoostFailure():'증폭 설정을 저장하지 못했습니다'))}
 const preset=(key:'clear'|'soft'|'comfortable')=>{setPlaybackEffects({...DEFAULT_EFFECTS,enabled:true,...(key==='clear'?{clarity:3,bass:-1}:key==='soft'?{bass:2,treble:-3}:{compress:true,softenPeaks:true})});void savePlaybackEffects()}
 const row={display:'grid',gridTemplateColumns:'minmax(0, 1fr) 48px',gap:10,alignItems:'center'} as const
 return <div data-testid="speaker-quick-settings" style={{display:'grid',gap:14,padding:10,fontSize:12}}>
  <div style={{display:'grid',gridTemplateColumns:'36px minmax(0,1fr)',gap:10,alignItems:'center'}}>
   <button aria-label={volume?'소리 끄기':'소리 켜기'} title="소리 켜기·끄기" style={{...button,width:36,height:46,padding:0,display:'grid',placeItems:'center'}} onClick={()=>{change(volume?0:last.current);commit()}}><Icon name={volume?'volume':'mute'} size={23}/></button>
   <div style={{display:'grid',gap:8,minWidth:0}}>
    <label><span style={{...row,fontSize:10,marginBottom:2,color:'var(--text-secondary)'}}><span>앱 재생 소리</span><span style={{textAlign:'right',fontVariantNumeric:'tabular-nums'}}>{Math.round(volume*100)}%</span></span>
     <input data-testid="quick-volume" aria-label="앱 재생 음량" type="range" min="0" max="1" step="0.01" value={volume} onChange={e=>change(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} style={{display:'block',width:'100%',margin:0,minWidth:0,accentColor:'var(--accent-light)'}}/>
    </label>
    <label><span style={{...row,fontSize:10,marginBottom:2,color:'var(--text-secondary)'}}><span>작은 소리 증폭</span><span style={{textAlign:'right',fontVariantNumeric:'tabular-nums'}}>{boost.toFixed(1)}배</span></span>
     <input data-testid="quick-boost" aria-label="작은 소리 증폭" type="range" min="1" max="3" step="0.1" value={boost} onChange={e=>setPlaybackBoost(Number(e.target.value))} onPointerUp={saveBoost} onKeyUp={saveBoost} onBlur={saveBoost} style={{display:'block',width:'100%',margin:0,accentColor:'var(--accent-light)'}}/>
    </label>
   </div>
  </div>
  {!basicsOnly && <><div style={{display:'flex',gap:4,flexWrap:'wrap',borderTop:'1px solid var(--border-subtle)',paddingTop:12}}>{(['clear','soft','comfortable'] as const).map((key,i)=><button key={key} style={{...button,padding:'4px 7px',fontSize:11}} onClick={()=>preset(key)}>{['선명하게','부드럽게','편안하게'][i]}</button>)}</div>
  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}><label style={{display:'flex',alignItems:'center',gap:6}}><input data-testid="quick-effects-enabled" type="checkbox" checked={effects.enabled} onChange={e=>{setPlaybackEffects({enabled:e.target.checked});void savePlaybackEffects()}}/>음향 효과</label>{details&&<button data-testid="speaker-details" style={{...button,padding:'4px 7px',fontSize:11}} onClick={details}>세부 조절 →</button>}</div></>}
  {(error||saveFailed)&&<span role="alert" style={{fontSize:11,color:'var(--rose)'}}>{error||'음량을 저장하지 못했습니다'}</span>}
 </div>
}
