import {useEffect,useState} from 'react'
import {CARD_AUTOSAVE_KEY} from '../../shared/cardPersistencePolicy'
import {configureCardAutoSave} from '../lib/cardWorkSaver'
export function useCardAutoSave(){
 const [enabled,setEnabled]=useState<boolean|null>(null)
 useEffect(()=>{
  let live=true
  const read=()=>{void window.api.options.get().then(got=>{if(!live)return;const on=got.cardAutoSave===true;configureCardAutoSave(on);setEnabled(on)}).catch(()=>{if(live){configureCardAutoSave(false);setEnabled(false)}})}
  read();window.addEventListener('audioforge-card-autosave',read)
  return()=>{live=false;window.removeEventListener('audioforge-card-autosave',read)}
 },[])
 return enabled
}
