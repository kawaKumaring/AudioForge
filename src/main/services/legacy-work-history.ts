import { createHash } from 'node:crypto'
// @ts-ignore TS5097
import { LEGACY_HISTORY_KEY, legacyContent, type LegacyHistoryEntry } from '../../shared/legacyWorkHistory.ts'
const obj=(v:unknown):Record<string,unknown> => v && typeof v==='object' && !Array.isArray(v) ? v as Record<string,unknown> : {}
export function preserveLegacyHistory(base:Record<string,unknown>,key:string,value:unknown):Record<string,unknown> {
  if(key!=='labWorkspace' && key!=='workDrafts')return base
  // 명시적으로 지우는 요청은 보관으로 되살리지 않는다.
  if(value==null)return base
  const history={...obj(base[LEGACY_HISTORY_KEY])}
  const keep=(kind:LegacyHistoryEntry['kind'],sourceKey:string,old:unknown,next:unknown)=>{
    if(!old || !next || legacyContent(old)===legacyContent(next))return
    const data=obj(old)
    if(kind==='lab' && !Array.isArray(data.lines))return
    if(kind==='draft' && !data.ttsText && !Object.keys(obj(data.speakers)).length)return
    const id=createHash('sha256').update(kind+'\0'+sourceKey+'\0'+legacyContent(old)).digest('hex')
    history[id]={kind,sourceKey,data:old}
  }
  if(key==='labWorkspace')keep('lab','lab',base[key],value)
  else {
    const before=obj(obj(base[key]).drafts),after=obj(obj(value).drafts)
    for(const k of Object.keys(before))if(k in after)keep('draft',k,before[k],after[k])
  }
  return {...base,[LEGACY_HISTORY_KEY]:history}
}
