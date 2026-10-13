import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setSettingsKey} from './settings-store.ts'
import {preserveLegacyHistory} from './legacy-work-history.ts'
import {legacyWorks,revealTarget,removeLegacy} from '../../shared/legacyCardImport.ts'
const draft=(text:string,updatedAt='2026-10-14')=>({sourcePath:'A.wav',ttsText:text,updatedAt,speakers:{}})
test('같은 파일 자동 저장이 이전 대사를 보존하고 가져오기 목록에도 남긴다',()=>{
 const s=mkdtempSync(join(tmpdir(),'af-legacy-history-'));const p=join(s,'settings.json')
 try {
  assert.equal(setSettingsKey(p,'workDrafts',{drafts:{A:draft('첫 대사')}}).ok,true)
  assert.equal(setSettingsKey(p,'workDrafts',{drafts:{A:draft('둘째 대사')}}).ok,true)
  const all=JSON.parse(readFileSync(p,'utf8'));const list=legacyWorks(all,1)
  assert.equal(list.length,2);assert.deepEqual(new Set(list.map(x=>x.doc.cards[0].text)),new Set(['첫 대사','둘째 대사']))
  const old=list.find(x=>x.work.key.startsWith('history:'))!
  assert.equal(revealTarget(all,old.work),'A.wav')
  const patch=removeLegacy(all,old.work)!;assert.equal(patch.key,'legacyWorkHistory');assert.deepEqual(patch.value,{})
 }finally{rmSync(s,{recursive:true,force:true})}
})
test('시각만 변한 자동 저장은 이전 저장을 중복으로 만들지 않는다',()=>{
 const base={workDrafts:{drafts:{A:draft('첫 대사','어제')}}}
 const next=preserveLegacyHistory(base,'workDrafts',{drafts:{A:draft('첫 대사','오늘')}})
 assert.deepEqual(next.legacyWorkHistory,{})
})
test('명시적으로 지운 기록은 새 보관본으로 되살리지 않는다',()=>{
 const base={workDrafts:{drafts:{A:draft('첫 대사')}}}
 assert.deepEqual(preserveLegacyHistory(base,'workDrafts',{drafts:{}}).legacyWorkHistory,{})
})
test('문장별 제작도 대사와 생성본을 함께 보존한다',()=>{
 const old={voicePath:'A.wav',lines:[{id:'1',text:'첫 대사',takes:[{id:'t',path:'result.wav',createdAt:1,text:'첫 대사'}]}]}
 const base={labWorkspace:old}
 const next=preserveLegacyHistory(base,'labWorkspace',{...old,lines:[{id:'2',text:'둘째 대사',takes:[]}]})
 const list=legacyWorks({...next,labWorkspace:{...old,lines:[]}},1)
 assert.equal(list.length,1);assert.equal(list[0].doc.cards[0].takes[0].path,'result.wav')
})
