import test from 'node:test'
import assert from 'node:assert/strict'
import { cardVoiceOf, emotionSent, cardScriptWithEmotion } from './synthesisCardVoice.ts'
import { cardSymbolReading } from './symbolDirection.ts'
import { cardApplied, takeIsStale } from './synthesisCardJob.ts'
const source={path:'A.wav',name:'A',duration:9}
const settings={engine:'cosyvoice3' as const,speed:1,pitch:0,emotion:'자연스럽게',reference:'auto' as const,start:0,end:9}
const v=cardVoiceOf({source,settings})
test('Qwen 기본 경로와 참조 목소리 미지원 판정 유지',()=>{
 assert.equal(emotionSent('기쁨',cardVoiceOf({source})),false)
})
test('Cosy 참조 연출은 지원 목록만 전달',()=>{
 assert.equal(emotionSent('기쁨',v),true)
 assert.equal(emotionSent('질투',v),false)
 assert.equal(cardScriptWithEmotion('안녕하세요.','기쁨',v),'[기쁨] 안녕하세요.')
})
test('문장부호로 독립 합성 만들지 않고 원문 보호',()=>{
 const text='오늘은 일곱 번째 수업입니다, 만나서 반가워요. 다시 만나요!'
 const r=cardSymbolReading(text,{...settings,symbolDirection:true},v)
 assert.equal(r.original,text)
 assert.equal(r.script.includes('[쉼'),false)
 assert.ok(r.script.includes('[자신감]'))
})
test('전달값과 생성 방식 변경 판정',()=>{
 const applied=cardApplied(settings,v)
 assert.equal(applied.engine,'cosyvoice3')
 assert.equal(cardApplied({...settings,emotion:'기쁨'},v).notes.length,0)
 assert.equal(takeIsStale({text:'대사',sourcePath:'A.wav',settings,applied},{text:'대사',sourcePath:'A.wav',settings:{...settings,engine:'qwen3'}}),true)
})
