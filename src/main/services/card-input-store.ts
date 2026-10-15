// @ts-ignore TS5097
import {replaceFileAtomically} from './durable-write.ts'
import {createHash} from 'node:crypto'
import {existsSync,readFileSync,lstatSync,realpathSync} from 'node:fs'
import {dirname,join,resolve,extname,basename} from 'node:path'
// @ts-ignore TS5097
import {withoutCardInput,CARD_INPUT_FIELDS} from '../../shared/cardPersistencePolicy.ts'
// @ts-ignore TS5097
import {parseSavedWork,type SavedCard,type SavedWork} from '../../shared/synthesisCardSave.ts'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,24)
const obj=(v:unknown):Record<string,unknown>=>v && typeof v==='object' && !Array.isArray(v)?v as Record<string,unknown>:{}
const inputs=(s:Record<string,unknown>)=>Object.fromEntries(CARD_INPUT_FIELDS.filter(k=>k in s).map(k=>[k,s[k]]))
function atomic(path:string,data:unknown){replaceFileAtomically(path,JSON.stringify(data,null,2))}
export function cardContentFile(card:SavedCard,outputRoot:string):string {
 const newest=[...card.takes].sort((a,b)=>b.createdAt-a.createdAt).find(t=>existsSync(t.path))
 return join(newest?dirname(newest.path):join(outputRoot,'음성합성','작업대본'),'card-'+hash(card.id)+'.input.json')
}
export function saveCardInput(card:SavedCard,outputRoot:string):string {
 const path=cardContentFile(card,outputRoot)
 atomic(path,{version:1,kind:'card-input',cardId:card.id,text:card.text,settings:inputs(card.settings)})
 return path
}
/** 메타 저장은 현재 입력을 덮지 않는다. 생성본의 확정 대사만 음원 옆에 기록한다. */
export function separateCardWork(work:SavedWork,outputRoot:string,migrate=false):SavedWork {
 return {...work,cards:work.cards.map(c=>{
  let contentPath=c.contentPath||''
  if(migrate && !contentPath && (c.text || Object.keys(inputs(c.settings)).length))contentPath=saveCardInput(c,outputRoot)
  const takes=c.takes.map(t=>{
   let takeContentPath=t.contentPath||''
   if(!takeContentPath){
    takeContentPath=join(existsSync(t.path)?dirname(t.path):join(outputRoot,'음성합성','작업대본'),'take-'+hash(c.id+'\0'+t.id)+'.input.json')
    atomic(takeContentPath,{version:1,kind:'take-input',cardId:c.id,takeId:t.id,text:t.text,settings:inputs(t.settings),applied:inputs(t.applied)})
   }
   return {...t,text:'',settings:withoutCardInput(t.settings),applied:withoutCardInput(t.applied),contentPath:takeContentPath}
  })
  return {...c,text:'',settings:withoutCardInput(c.settings),contentPath,takes}
 })}
}
function readInput(path:string,cardId:string,takeId?:string){
 const o=obj(JSON.parse(readFileSync(path,'utf8')))
 if(o.version!==1 || o.cardId!==cardId || (takeId?o.kind!=='take-input'||o.takeId!==takeId:o.kind!=='card-input'))throw Error('입력 기록의 소유자가 다릅니다')
 if(typeof o.text!=='string')throw Error('입력 기록이 손상되었습니다')
 for(const k of ['h3Direction','emotion'])if(k in obj(o.settings) && typeof obj(o.settings)[k]!=='string')throw Error('지시 기록이 손상되었습니다')
 return o
}
export function restoreCardWork(raw:unknown):SavedWork|null {
 const w=parseSavedWork(raw);if(!w)return null
 return {...w,cards:w.cards.map(c=>{
  let text=c.text,settings=c.settings,contentFault=''
  if(c.contentPath){try{const r=readInput(c.contentPath,c.id);text=r.text as string;settings={...settings,...obj(r.settings)}}catch{contentFault='저장한 대사·연기 지시를 읽지 못했습니다'}}
  return {...c,text,settings,contentFault,takes:c.takes.map(t=>{
   if(!t.contentPath)return t
   try{const r=readInput(t.contentPath,c.id,t.id);return {...t,text:r.text as string,settings:{...t.settings,...obj(r.settings)},applied:{...t.applied,...obj(r.applied)}}}catch{return {...t,contentFault:'생성 당시 입력 기록을 읽지 못했습니다'}}
  })}
 })}
}
/** 카드의 사용자 입력만 지운다. 경로를 믿지 않고 정해진 이름과 소유 표를 확인한다. */
export function planCardFileRemoval(card:SavedCard,removeAudio:boolean,protectedPaths:string[],extraInputs:string[]=[]):string[] {
 const canonical=(p:string)=>existsSync(p)?realpathSync(p).toLowerCase():resolve(p).toLowerCase()
 const protectedSet=new Set([card.sourcePath,...card.takes.map(t=>t.sourcePath),...protectedPaths].filter(Boolean).map(canonical))
 const inputsToDelete=[...(card.contentPaths||[]),card.contentPath,...card.takes.map(t=>t.contentPath),...extraInputs].filter(Boolean) as string[]
 const planned:string[]=[]
 for(const path of new Set(inputsToDelete)){
  if(!existsSync(path))continue
  if(!/^\w+-[a-f0-9]{24}\.input\.json$/.test(basename(path)))throw Error('입력 기록 파일 이름이 다릅니다')
  if(protectedSet.has(canonical(path)))throw Error('원본 입력은 삭제하지 않습니다')
  if(lstatSync(path).isSymbolicLink())throw Error('연결 파일은 삭제하지 않습니다')
  const r=obj(readJsonOr(path,'입력 기록 파일이 손상되어 삭제 대상을 확인할 수 없습니다'))
  if(r.version!==1 || r.cardId!==card.id || !['card-input','take-input'].includes(String(r.kind)) || r.kind==='take-input'&&!card.takes.some(t=>t.id===r.takeId))throw Error('다른 카드의 입력 기록은 삭제할 수 없습니다')
  planned.push(path)
 }
 if(removeAudio)for(const t of card.takes){
  if(!existsSync(t.path))continue
  if(protectedSet.has(canonical(t.path)))throw Error('원본이나 다른 카드가 쓰는 음원은 삭제할 수 없습니다')
  if(lstatSync(t.path).isSymbolicLink() || !['.wav','.flac','.mp3','.m4a'].includes(extname(t.path).toLowerCase()) || !existsSync(join(dirname(t.path),'session.json')))throw Error('앱 생성 결과로 확인되지 않은 음원은 삭제할 수 없습니다')
  const session=obj(readJsonOr(join(dirname(t.path),'session.json'),'결과 기록(session.json)이 손상되어 삭제할 음원을 확인할 수 없습니다'))
  if(session.mode!=='tts' || !Array.isArray(session.tracks) || !session.tracks.some(x=>typeof obj(x).path==='string' && canonical(obj(x).path as string)===canonical(t.path)))throw Error('음성합성 결과로 확인되지 않았습니다')
  planned.push(t.path)
 }
 return [...new Set(planned)]
}

/** JSON 기록을 읽는다. 손상이면 영어 SyntaxError 대신 한국어 사유로 던진다(2026-10-16 점검). */
function readJsonOr(path:string,why:string):unknown{try{return JSON.parse(readFileSync(path,'utf8'))}catch{throw Error(why)}}

export function readStandaloneCardInput(path:string):{text:string;settings:Record<string,unknown>} {
 const r=obj(JSON.parse(readFileSync(path,'utf8')))
 if(r.version!==1 || !['card-input','take-input'].includes(String(r.kind)) || typeof r.text!=='string')throw Error('대사·지시 저장 파일이 아닙니다')
 const settings=inputs(obj(r.settings))
 for(const k of ['h3Direction','emotion'])if(k in settings && typeof settings[k]!=='string')throw Error('연기 지시 형식이 올바르지 않습니다')
 return {text:r.text,settings}
}
