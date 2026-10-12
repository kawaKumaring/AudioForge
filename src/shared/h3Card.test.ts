import test from 'node:test'
import assert from 'node:assert/strict'
import { cardVoiceOf, voiceSupports, cardScriptWithEmotion } from './synthesisCardVoice.ts'
import { cardApplied, takeMark } from './synthesisCardJob.ts'
test('H3 선택이 카드별 목소리 계약에 남고 미지원 손잡이를 닫는다',()=>{
  const settings={engine:'minimax-h3' as const,speed:1.2,pitch:1,emotion:'화남',reference:'auto' as const,start:0,end:8}
  const voice=cardVoiceOf({source:{path:'A.wav',name:'A',duration:8},settings})
  assert.equal(voice.kind,'reference');if(voice.kind!=='reference')throw Error('참조 계약')
  assert.equal(voice.engine,'minimax-h3')
  assert.deepEqual(voiceSupports(voice),{speed:false,pitch:false,region:true,emotion:false})
  const applied=cardApplied(settings,voice)
  assert.equal(applied.engine,'minimax-h3');assert.equal(applied.speed,1);assert.equal(applied.pitch,0)
  assert.equal(applied.notes.length,3)
  assert.equal(cardScriptWithEmotion('원문 그대로!',settings.emotion,voice),'원문 그대로!')
})
test('생성 방식을 바꾸면 이전 생성본을 현재 설정과 같은 것으로 표시하지 않는다',()=>{
  const settings={speed:1,pitch:0,emotion:'자연스럽게',reference:'auto' as const,start:0,end:8}
  assert.equal(takeMark({text:'원문',sourcePath:'A.wav',settings},{text:'원문',sourcePath:'A.wav',settings:{...settings,engine:'minimax-h3'}}),'stale')
})
