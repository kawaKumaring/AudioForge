import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {saveCardInput,separateCardWork,restoreCardWork,removeCardFiles} from './card-input-store.ts'
import {setSettingsKey} from './settings-store.ts'
import {encodeLegacyInput,resolveLegacyInput} from './legacy-input-store.ts'
import type {SavedWork} from '../../shared/synthesisCardSave.ts'
const fixture=(root:string):SavedWork=>{
 const audio=join(root,'synthesized.wav');writeFileSync(audio,'검사 음원');writeFileSync(join(root,'session.json'),JSON.stringify({mode:'tts',tracks:[{path:audio}]}))
 return {savedAt:1,joins:{},cards:[{id:'card-1',label:'A',sourcePath:join(root,'source.wav'),sourceName:'A',sourceDuration:8,text:'사용자 대사',settings:{engine:'minimax-h3',h3Direction:'분노를 억누른다',emotion:'자연스럽게'},adoptedId:'take-1',takes:[{id:'take-1',path:audio,text:'생성 당시 대사',createdAt:1,sourcePath:'A.wav',sourceName:'A',sourceDuration:8,settings:{h3Direction:'생성 당시 연기 지시'},applied:{h3Direction:'생성 당시 연기 지시'}}]}]}
}
function scratch(run:(p:string)=>void){const p=mkdtempSync(join(tmpdir(),'audioforge-card-input-'));try{run(p)}finally{rmSync(p,{recursive:true,force:true})}}
test('카드 메타 자동 저장은 사용자 대사·지시를 내부에 넣지 않는다',()=>scratch(p=>{
 const w=fixture(p),meta=separateCardWork(w,p)
 const body=JSON.stringify(meta);for(const text of ['사용자 대사','분노를 억누른다','생성 당시 대사','생성 당시 연기 지시'])assert.ok(!body.includes(text))
 assert.equal(restoreCardWork(meta)?.cards[0].text,'')
 assert.equal(restoreCardWork(meta)?.cards[0].takes[0].text,'생성 당시 대사')
}))
test('명시 저장한 대사·지시만 경로를 따라 복원한다',()=>scratch(p=>{
 const w=fixture(p);w.cards[0].contentPath=saveCardInput(w.cards[0],p)
 assert.equal(dirname(w.cards[0].contentPath!),p)
 const meta=separateCardWork(w,p),r=restoreCardWork(meta)!
 assert.equal(r.cards[0].text,'사용자 대사');assert.equal(r.cards[0].settings.h3Direction,'분노를 억누른다')
 w.cards[0].text='저장하지 않은 변경';const next=separateCardWork(w,p)
 assert.equal(restoreCardWork(next)!.cards[0].text,'사용자 대사')
}))
test('생성 전 대사는 설정된 결과 폴더에 저장한다',()=>scratch(p=>{
 const w=fixture(p);w.cards[0].takes=[];const path=saveCardInput(w.cards[0],p)
 assert.equal(dirname(path),join(p,'음성합성','작업대본'));assert.ok(readFileSync(path,'utf8').includes('사용자 대사'))
}))
test('읽기 실패와 다른 카드 소유 기록을 없음으로 합격시키지 않는다',()=>scratch(p=>{
 const w=fixture(p);w.cards[0].contentPath=join(p,'missing.json')
 assert.ok(restoreCardWork(separateCardWork(w,p))!.cards[0].contentFault)
 const path=saveCardInput(w.cards[0],p);w.cards[0].contentPath=path
 writeFileSync(path,JSON.stringify({version:1,kind:'card-input',cardId:'남의 카드',text:'다른 대사'}))
 assert.ok(restoreCardWork(separateCardWork(w,p))!.cards[0].contentFault)
}))
test('기존 원문은 외부 저장 성공 후에만 메타에서 빠진다',()=>scratch(p=>{
 const w=fixture(p),meta=separateCardWork(w,p,true)
 assert.ok(meta.cards[0].contentPath);assert.equal(restoreCardWork(meta)!.cards[0].text,w.cards[0].text)
}))
test('음원 유지 선택은 카드 입력 파일만 지운다',()=>scratch(p=>{
 const w=fixture(p);w.cards[0].contentPath=saveCardInput(w.cards[0],p);const meta=separateCardWork(w,p)
 removeCardFiles(meta.cards[0],false,[])
 assert.ok(existsSync(w.cards[0].takes[0].path));assert.ok(!existsSync(meta.cards[0].contentPath!));assert.ok(!existsSync(meta.cards[0].takes[0].contentPath!))
}))
test('음원 삭제 선택은 확인된 생성 음원까지 지운다',()=>scratch(p=>{
 const w=fixture(p);w.cards[0].contentPath=saveCardInput(w.cards[0],p);const meta=separateCardWork(w,p)
 removeCardFiles(meta.cards[0],true,[]);assert.ok(!existsSync(w.cards[0].takes[0].path))
}))
test('다른 카드가 쓰는 음원이면 사전 점검에서 거절하고 입력도 보존한다',()=>scratch(p=>{
 const w=fixture(p);w.cards[0].contentPath=saveCardInput(w.cards[0],p);const meta=separateCardWork(w,p)
 assert.throws(()=>removeCardFiles(meta.cards[0],true,[w.cards[0].takes[0].path]));assert.ok(existsSync(meta.cards[0].contentPath!));assert.ok(existsSync(w.cards[0].takes[0].path))
}))
test('원본 경로와 같거나 생성 세션이 없으면 음원을 삭제하지 않는다',()=>scratch(p=>{
 const w=fixture(p);w.cards[0].sourcePath=w.cards[0].takes[0].path
 assert.throws(()=>removeCardFiles(w.cards[0],true,[]));w.cards[0].sourcePath='원본.wav';rmSync(join(p,'session.json'))
 assert.throws(()=>removeCardFiles(w.cards[0],true,[]));assert.ok(existsSync(w.cards[0].takes[0].path))
}))
test('음원이 없어도 생성 당시 대사를 분리 보존한다',()=>scratch(p=>{
 const w=fixture(p);rmSync(w.cards[0].takes[0].path);const meta=separateCardWork(w,p,true)
 assert.equal(restoreCardWork(meta)!.cards[0].takes[0].text,'생성 당시 대사')
}))
test('옛 대본도 내부에는 경로만 저장하고 내용 보기에 원문을 반환한다',()=>scratch(p=>{
 const raw={drafts:{A:{ttsText:'옛 대사',speakers:{},sourcePath:'A.wav'}}}
 const stored=encodeLegacyInput('workDrafts',raw,p)
 assert.ok(!JSON.stringify(stored).includes('옛 대사'));assert.deepEqual(resolveLegacyInput(stored),raw)
}))
test('옛 기록 파일 누락은 읽기 실패다',()=>scratch(p=>{
 const stored=encodeLegacyInput('labWorkspace',{lines:[{text:'대사'}]},p) as {inputFile:string}
 rmSync(stored.inputFile);assert.throws(()=>resolveLegacyInput(stored))
}))

test('옛 입력 갱신은 활성 파일을 덮지 않아 메타 저장 실패에도 앞 대사가 보존된다',()=>scratch(p=>{
 const old=encodeLegacyInput('labWorkspace',{lines:[{text:'앞 대사'}]},p)
 const next=encodeLegacyInput('labWorkspace',{lines:[{text:'뒤 대사'}]},p,old)
 assert.deepEqual(resolveLegacyInput(old),{lines:[{text:'앞 대사'}]})
 assert.deepEqual(resolveLegacyInput(next),{lines:[{text:'뒤 대사'}]})
}))

test('생성 세션이 다른 음원을 가리키면 삭제하지 않는다',()=>scratch(p=>{
 const w=fixture(p);writeFileSync(join(p,'session.json'),JSON.stringify({mode:'tts',tracks:[{path:join(p,'다른.wav')}]}))
 assert.throws(()=>removeCardFiles(w.cards[0],true,[]));assert.ok(existsSync(w.cards[0].takes[0].path))
}))

test('실제 설정 저장도 사용자 대사 대신 외부 경로를 기록한다',()=>scratch(p=>{
 const file=join(p,'settings.json')
 assert.equal(setSettingsKey(file,'outputRoot',p).ok,true)
 const raw={drafts:{A:{ttsText:'내부에 없어야 할 대사',sourcePath:'A.wav',speakers:{}}}}
 assert.equal(setSettingsKey(file,'workDrafts',raw).ok,true)
 const body=readFileSync(file,'utf8')
 assert.ok(!body.includes('내부에 없어야 할 대사'))
 assert.deepEqual(resolveLegacyInput(JSON.parse(body).workDrafts),raw)
}))
