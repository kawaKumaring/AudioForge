import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cardSymbolReading, readSymbolReading } from './symbolDirection.ts'
import { takeIsStale } from './synthesisCardJob.ts'
const builtin={ kind:'builtin' as const, voice:{ engineId:'qwen-custom', modelId:'x', label:'x', language:'ko', path:'x',sampleRate:24000,emotion:true } }
const reference={kind:'reference' as const,source:{path:'r',name:'r',duration:8}}
const settings={symbolDirection:true, emotion:'자연스럽게'}
const plan=(t:string,v=builtin)=>cardSymbolReading(t,settings,v)
test('끔은 기존 대사 그대로',()=>{ const s='안녕♥ 3.14 -2 https://a.b/x~y'; assert.equal(cardSymbolReading(s,{...settings,symbolDirection:false},builtin).script,s) })
test('쉼을 추가해도 글자 순서와 원문 불변',()=>{ const s='안녕, 반가워. 다시 만나'; const p=plan(s); assert.equal(p.original,s); assert.equal(p.script,'안녕,[쉼 0.15] 반가워.[쉼 0.3] 다시 만나'); assert.equal(p.script.replace(/\[쉼 [0-9.]+\]/g,''),s) })
test('문장 마지막에는 불필요한 쉼 없음',()=>assert.equal(plan('안녕.').script,'안녕.'))
test('반복 부호로 쉼 폭증 없음',()=>assert.equal(plan('안녕,,, 반가워... 다시').script,'안녕,,, 반가워... 다시'))
test('숫자 범위 수식 주소 파일명 보존',()=>{ for(const s of ['3.14 1,000 1~3 -2','1 - 2 = -1','https://a.b/x~y a@b.com','v1.2 README.md a-b','번호 1. 다음']) assert.equal(plan(s).script,s,s) })
test('독립 대시만 추가 쉼',()=>{assert.equal(plan('잠깐 - 생각해 볼게').script,'잠깐 [쉼 0.2] 생각해 볼게');assert.equal(plan('a-b').script,'a-b')})
test('지원 목소리는 강조 요청, 고함 보장 아님',()=>{const p=plan('반가워!!');assert.equal(p.script,'[자신감] 반가워!!');assert.equal(p.entries[0].kind,'request')})
test('말끝 장식만 해석',()=>{assert.equal(plan('고마워♥').script,'[다정] 고마워');assert.equal(plan('안녕~').script,'[다정] 안녕');assert.equal(plan('A♥B a~b').script,'A♥B a~b')})
test('미지원 목소리를 바꾸지 않으며 미지원 표시',()=>{const p=cardSymbolReading('고마워♥',settings,reference);assert.equal(p.script,'고마워');assert.match(p.entries[0].label,/미지원/);assert.equal(p.entries[0].kind,'silent')})
test('사용자가 정한 감정 우선',()=>{const p=cardSymbolReading('안녕♥',{...settings,emotion:'슬픔'},builtin);assert.equal(p.script,'[슬픔] 안녕');assert.match(p.entries[0].label,/선택한 감정 우선/)})
test('직접 쓴 태그와 이스케이프 보존',()=>{for(const s of ['[기쁨] 안녕, 반가워♥','안녕 [쉼 0.2] 다시~',String.raw`안녕\~`]) assert.equal(plan(s).script,s)})
test('기호별 끄기',()=>assert.equal(cardSymbolReading('안녕, 다시♥',{...settings,symbolDisabled:[',','♥']},builtin).script,'안녕, 다시♥'))
test('원문 좌표로 정확한 기호를 표시',()=>{const s='😊 안녕, 다시\n고마워♥';for(const e of plan(s).entries) assert.equal(s.slice(e.start,e.end),e.symbol)})
test('저장된 해석만 복원, 손상 거절',()=>{const p=plan('고마워♥');assert.deepEqual(readSymbolReading(JSON.parse(JSON.stringify(p))),p);assert.equal(readSymbolReading({...p,entries:[{start:-1}]}),undefined)})
test('연출 설정 변경은 이전 생성과 구분',()=>{const s={speed:1,pitch:0,emotion:'자연스럽게',reference:'auto' as const,start:0,end:0};const snap={text:'안녕',sourcePath:'',settings:s,applied:{speed:1,pitch:0,notes:[]}};assert.equal(takeIsStale(snap,{text:'안녕',sourcePath:'',settings:{...s,symbolDirection:true}}),true)})

test('복합 쉼 표기는 중복 지시로 바꾸지 않음',()=>assert.equal(plan('안녕 - , 다시').script,'안녕 - , 다시'))


test('만든 기호 지시를 실제 파이썬 파서가 받고 발화 글자를 보존', async () => {
  const { execFileSync } = await import('node:child_process')
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const root=resolve(import.meta.dirname,'../..')
  const py=JSON.parse(readFileSync(resolve(root,'externals/env.json'),'utf8')).python
  const originals=['안녕, 반가워. 다시 만나','음 - 생각해 볼게','반가워!!','고마워♥','안녕~']
  const scripts=originals.map(s=>plan(s).script)
  const code='import sys,json;sys.path.insert(0,sys.argv[1]);from tts_grammar import parse_tts_script;print(json.dumps([parse_tts_script(s) for s in json.load(sys.stdin)],ensure_ascii=True))'
  const results=JSON.parse(execFileSync(py,['-c',code,resolve(root,'python')],{input:JSON.stringify(scripts),encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'},timeout:15000}))
  results.forEach((r:any,i:number)=>{
    assert.equal(r.ok,true,JSON.stringify(r))
    const spoken=r.plan.segments.map((s:any)=>s.spoken_text).join('')
    assert.equal(spoken.replace(/[^가-힣a-zA-Z0-9]/g,''),originals[i].replace(/[^가-힣a-zA-Z0-9]/g,''))
  })
})


test('한 글자 감탄사를 자동 쉼으로 독립 생성하지 않음',()=>{
  for(const s of ['음 - 생각해 볼게','음, 생각해 볼게','생각해 볼게, 응','다시, 음 - 생각해 볼게']) {
    const p=plan(s)
    assert.ok(!p.script.includes('음 [쉼') && !p.script.includes('음,[쉼') && !p.script.includes('[쉼 0.15] 응'),p.script)
    assert.match(p.entries.map(e=>e.label).join(' '),/짧은 발화/)
    assert.equal(p.original,s)
  }
})

test('짧은 감탄사 뒤 독립 대시는 읽을 글에서 제외하되 낱말은 보존',()=>{
  const p=cardSymbolReading('음 - 조금만 생각해 볼게',settings,reference)
  assert.equal(p.script,'음  조금만 생각해 볼게')
  assert.equal(p.entries[0].kind,'silent')
  assert.equal(p.script.replace(/\s/g,''),'음조금만생각해볼게')
  assert.equal(plan('수식 1 - 2').script,'수식 1 - 2')
})
