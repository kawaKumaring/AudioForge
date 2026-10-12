import test from 'node:test'
import assert from 'node:assert/strict'
const calls: unknown[][]=[]
;(globalThis as any).window={addEventListener:()=>{},api:{
  settings:{set:async()=>({ok:true}),get:async()=>({})},
  audio:{process:async(...args:unknown[])=>{calls.push(args)},releaseReferenceClip:async()=>{}},
  cards:{extractAudio:async(_:string,path:string)=>({ok:true,data:path}),releaseMedia:async()=>({ok:true})}
}}
const {useSynthesisCards,newCard}=await import('../stores/synthesisCards.store.ts')
const {useAppStore}=await import('../stores/app.store.ts')
const {startCardGeneration,endCardJob}=await import('./cardSynthesis.ts')
test('H3 요청은 카드의 원문과 참조·요청 ID를 전달하고 자동 기호 해석을 하지 않는다',async()=>{
  const card=newCard({path:'synthetic-A.wav',name:'A',duration:8},{engine:'minimax-h3',speed:1,pitch:0,emotion:'자연스럽게',reference:'auto',start:0,end:8})
  card.text='안녕하세요~ 반갑습니다!';card.settings.symbolDirection=true
  useSynthesisCards.setState({cards:[card],refs:{},job:null});useAppStore.setState({status:'idle',errorInfo:null})
  useSynthesisCards.getState().setRef(card.id,{phase:'ready',clip:'synthetic-reference.wav',region:{start:0,duration:8},audio:'synthetic-A.wav'})
  assert.equal(await startCardGeneration(card),'')
  assert.equal(calls.length,1)
  const options=calls[0][2] as Record<string,unknown>
  assert.equal(options.ttsEngine,'minimax-h3');assert.equal(options.ttsText,card.text)
  assert.equal(options.ttsTailMode,'off')
  assert.ok(options.clientRequestId);assert.equal(options.ttsReferenceOverride,'synthetic-reference.wav')
  endCardJob()
})
