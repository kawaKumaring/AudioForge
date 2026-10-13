import test from 'node:test'
import assert from 'node:assert/strict'
import {h3DirectionFault,cardApplied,takeMark} from './synthesisCardJob.ts'
import {cardVoiceOf} from './synthesisCardVoice.ts'
const settings={engine:'minimax-h3' as const,speed:1,pitch:0,emotion:'자연스럽게',reference:'auto' as const,start:0,end:8,h3Direction:'절박하게 말한다'}
test('연기 지시는 H3에만 적용 기록으로 남는다',()=>{
 const voice=cardVoiceOf({source:{path:'A.wav',name:'A',duration:8},settings})
 assert.equal(cardApplied(settings,voice).h3Direction,'절박하게 말한다')
 const q={...settings,engine:'qwen3' as const}
 assert.equal(cardApplied(q,cardVoiceOf({source:{path:'A.wav',name:'A',duration:8},settings:q})).h3Direction,undefined)
})
test('연기 지시 변경은 H3 생성본의 수정 여부에 반영된다',()=>{
 const snap={text:'원문',sourcePath:'A.wav',settings}
 assert.equal(takeMark(snap,{...snap,settings:{...settings,h3Direction:'차분하게'}}),'stale')
 assert.equal(takeMark(snap,{...snap,settings:{...settings,h3Direction:'  절박하게 말한다  '}}),'same')
})
test('제어 태그와 길이 한도를 검사하고 정상 한국어는 유지한다',()=>{
 assert.equal(h3DirectionFault('절박하게 말한다'),'')
 for(const v of ['<d>원문</d>','[Shot 2]','가'.repeat(1201)])assert.ok(h3DirectionFault(v))
 assert.equal(h3DirectionFault('😀'.repeat(1200)),'')
})
