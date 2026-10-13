import {useState} from 'react'
import {Action,Modal,button,primary,muted} from './kit'
import {useSynthesisCards,type SynthesisCard} from '../stores/synthesisCards.store'
import {serializeWork} from '../lib/cardSynthesis'
import {flushSave,configureCardAutoSave,removeCardFromSave} from '../lib/cardWorkSaver'
const joins={gap:.35,level:true,edges:true,gaps:{}}
export default function CardStorageActions({card,disabled,autoSave}:{card:SynthesisCard;disabled:boolean;autoSave:boolean}){
 const [ask,setAsk]=useState(false),[busy,setBusy]=useState(false),[fault,setFault]=useState(''),[saved,setSaved]=useState('')
 const fingerprint=JSON.stringify([card.text,card.settings.h3Direction,card.settings.emotion])
 const save=async()=>{
  setBusy(true);setFault('')
  try{
   const r=await window.api.cards.saveInput(serializeWork([card],joins).cards[0])
   if(!r.ok||!r.path)throw Error(r.why||'대사·지시를 저장하지 못했습니다')
   const live=useSynthesisCards.getState().cards.find(c=>c.id===card.id)
   if(live)useSynthesisCards.getState().update(card.id,{contentPath:r.path,contentPaths:[...new Set([...(live.contentPaths||[]),...(live.contentPath?[live.contentPath]:[])])],contentFault:''})
   setSaved(fingerprint)
  }catch(e){setFault((e as Error).message)}finally{setBusy(false)}
 }
 const load=async()=>{
  setBusy(true);setFault('')
  try{const r=await window.api.cards.loadInput();if(r.canceled)return;if(!r.ok||typeof r.text!=='string')throw Error(r.why||'대사·지시를 읽지 못했습니다')
    const live=useSynthesisCards.getState().cards.find(c=>c.id===card.id)
    if(live)useSynthesisCards.getState().update(card.id,{text:r.text,settings:{...live.settings,...r.settings},contentFault:''})
    setSaved('')
  }catch(e){setFault((e as Error).message)}finally{setBusy(false)}
 }
 const remove=async(audio:boolean)=>{
  setBusy(true);setFault('')
  try{
   // 마지막 예약 저장부터 끝낸 뒤 본체 기록을 지운다. 이전 예약이 되살리지 못한다.
   await flushSave();configureCardAutoSave(false)
   const st=useSynthesisCards.getState(),live=st.cards.find(c=>c.id===card.id)
   if(!live)throw Error('카드가 이미 바뀌었습니다')
   const protectedPaths=st.cards.filter(c=>c.id!==card.id).flatMap(c=>[c.source?.path||'',...c.takes.map(t=>t.path)])
   const r=await window.api.cards.remove(serializeWork([live],joins).cards[0],audio,protectedPaths)
   if(!r.ok)throw Error(r.why||'카드를 삭제하지 못했습니다')
   removeCardFromSave(card.id)
   st.remove(card.id)
   // 파일을 지우는 삭제는 메모리 되돌리기와 섞지 않는다.
   useSynthesisCards.setState({removed:null})
   setAsk(false)
  }catch(e){setFault((e as Error).message)}finally{configureCardAutoSave(autoSave);setBusy(false)}
 }
 return <>
  <Action icon="text" label={`${card.label} 대사·연기 지시 불러오기`} title="따로 저장한 대사·지시 파일을 엽니다. 목소리와 생성본은 바꾸지 않습니다." disabled={disabled||busy} onClick={()=>void load()}/>
  <Action icon="save" label={`${card.label} 대사·연기 지시 저장`} title={saved===fingerprint?'대사·지시 저장됨':'대사와 연기 지시를 결과 위치에 따로 저장합니다'} pressed={saved===fingerprint} disabled={disabled||busy} onClick={()=>void save()}/>
  <Action icon="trash" label={`${card.label} 카드 제거`} disabled={disabled||busy} onClick={()=>setAsk(true)}/>
  {(fault||card.contentFault)&&<span role="alert" title={fault||card.contentFault} style={{...muted,color:'var(--rose)'}}>입력 기록 확인 필요</span>}
  {ask&&<Modal title="카드 제거" subtitle={card.label} close={()=>{if(!busy)setAsk(false)}} footer={<>
   <button style={button} disabled={busy} onClick={()=>setAsk(false)}>취소</button>
   <button style={button} disabled={busy} onClick={()=>void remove(false)}>음원 유지</button>
   <button style={{...primary,color:'var(--rose)'}} disabled={busy} onClick={()=>void remove(true)}>음원도 삭제</button>
  </>}><p style={{fontSize:13}}>카드 정보와 저장한 대사·연기 지시를 제거합니다. 생성된 음원도 삭제할까요?</p>
  <p style={muted}>원본과 다른 카드가 쓰는 파일은 삭제하지 않습니다. 파일 삭제는 되돌릴 수 없습니다.</p>
  {fault&&<p role="alert" style={{fontSize:12,color:'var(--rose)'}}>{fault}</p>}
  </Modal>}
 </>
}
