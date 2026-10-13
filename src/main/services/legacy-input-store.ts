import {createHash,randomUUID} from 'node:crypto'
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs'
import {dirname,join} from 'node:path'
const KEYS=new Set(['labWorkspace','workDrafts','legacyWorkHistory'])
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,24)
export function resolveLegacyInput(v:unknown):unknown {
 if(Array.isArray(v))return v.map(resolveLegacyInput)
 if(!v||typeof v!=='object')return v
 const o=obj(v)
 if(o.inputFileVersion===1){
  if(typeof o.inputFile!=='string')throw Error('옛 입력 경로가 손상되었습니다')
  const stored=obj(JSON.parse(readFileSync(o.inputFile,'utf8')))
  if(stored.kind!=='legacy-input'||stored.owner!==o.inputOwner)throw Error('옛 입력 기록의 소유자가 다릅니다')
  return stored.data
 }
 return Object.fromEntries(Object.entries(o).map(([k,x])=>[k,resolveLegacyInput(x)]))
}
/** 구형 저장도 원문 대신 경로만 유지한다. 기존 형식은 읽을 때 한 번 이전한다. */
export function encodeLegacyInput(key:string,value:unknown,outputRoot:string,previous:unknown=null):unknown {
 if(!KEYS.has(key)||value==null)return value
 const store=(id:string,data:unknown,prior:unknown)=>{
  if(obj(data).inputFileVersion===1)return data
  const active=obj(prior).inputFile
  const slot=typeof active==='string' && active.endsWith('.a.input.json')?'b':'a'
  const path=join(outputRoot,'음성합성','이전작업','legacy-'+hash(key+'\0'+id)+'.'+slot+'.input.json')
  mkdirSync(dirname(path),{recursive:true});const tmp=path+'.'+randomUUID()+'.tmp'
  try{writeFileSync(tmp,JSON.stringify({version:1,kind:'legacy-input',owner:key+':'+id,data},null,2),'utf8');renameSync(tmp,path)}finally{if(existsSync(tmp))unlinkSync(tmp)}
  return {inputFileVersion:1,inputOwner:key+':'+id,inputFile:path}
 }
 if(key==='labWorkspace')return store('current',value,previous)
 if(key==='workDrafts'){
  const v=obj(value),drafts=obj(v.drafts)
  return {...v,drafts:Object.fromEntries(Object.entries(drafts).map(([id,data])=>[id,store(id,data,obj(obj(previous).drafts)[id])]))}
 }
 return Object.fromEntries(Object.entries(obj(value)).map(([id,data])=>[id,store(id,data,obj(previous)[id])]))
}
