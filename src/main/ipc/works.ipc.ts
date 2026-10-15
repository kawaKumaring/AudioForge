import {recoverWorkTransaction} from '../services/work-transaction'
import {resolveLegacyInput} from '../services/legacy-input-store'
import { saveCardInput, separateCardWork, restoreCardWork, planCardFileRemoval, readStandaloneCardInput } from '../services/card-input-store'
import { parseSavedWork, type SavedWork, type SavedCard } from '../../shared/synthesisCardSave'
import { OUTPUT_ROOT_DIRNAME } from '../../shared/outputLayout'
import { outputBase } from '../services/appPaths'
/**
 * 작업 기록 통로 — **기록 하나가 파일 하나.**
 *
 * ★지시 (2026-09-28)
 * > "셋팅.json 에 저장하는게 아닌 생성한 파일마다 정보를 따로 가지고있어서
 * >  그 파일만 삭제하게 하도록한다"
 *
 * 화면은 **갈래와 열쇠만** 말한다. 어느 파일인지는 여기서 정한다 —
 * 화면이 경로를 만들어 보내면 언젠가 엉뚱한 자리를 지운다(설정 비우기에서 이미 겪었다).
 *
 * ★옮기기는 **처음 읽을 때 한 번.** 옛 `settings.json` 의 열쇠를 기록 파일로 가르고,
 *   다 옮겼을 때만 옛 열쇠를 지운다. 남겨 두면 지운 기록이 다음 실행에 되살아난다.
 */
import { ipcMain, app, dialog } from 'electron'
import { join } from 'path'
import {
  listRecords, readRecordChecked, writeRecord, writeRecordBatch, deleteRecord, clearKind, migrateKind,
} from '../services/work-store'
import { readSettingsFile, setSettingsKey } from '../services/settings-store'
import { isWorkKind, type WorkKind } from '../../shared/workRecord'
import { currentBuildInfo } from './app-version.ipc'

function host() {
  return { root: app.getPath('userData'), now: () => Date.now() }
}

function settingsPath(): string { return join(app.getPath('userData'), 'settings.json') }

function readLegacy(key: string): unknown {
  const got = readSettingsFile(settingsPath())
  if(got.kind==='corrupt')throw Error('이전 작업 설정을 읽지 못했습니다. 원본을 유지합니다')
  return got.kind === 'ok' ? resolveLegacyInput((got.settings as Record<string, unknown>)[key]) : undefined
}

function dropLegacy(key: string): boolean {
  try {
    return setSettingsKey(settingsPath(), key, undefined,
      { writtenBy: currentBuildInfo().version }).ok
  } catch { return false }
}

/**
 * 이 실행에서 이미 옮긴 갈래. **한 번만 옮긴다.**
 *
 * `migrateKind` 자체도 파일이 있으면 건너뛰지만, 모든 기록을 지운 뒤라면 파일이
 * 없어서 다시 옮기게 된다 — 그러면 **사용자가 지운 것이 되살아난다.**
 * 그래서 실행 중에도 기억한다.
 */
const moved = new Set<WorkKind>()

function ensureMoved(kind: WorkKind): void {
  if (moved.has(kind)) return
  const result=migrateKind(host(),kind,readLegacy,dropLegacy,kind==='cards'?data=>prepareCardData(data,true):undefined)
  if(result.failed.length)throw Error(result.failed[0].why)
  moved.add(kind)
}

function resultRoot(): string {
  const chosen = readLegacy('outputRoot')
  return join(typeof chosen === 'string' && chosen.trim() ? chosen : outputBase(__dirname, process.env), OUTPUT_ROOT_DIRNAME)
}
function prepareCardData(data: unknown, migrate = false): unknown {
  if (Array.isArray(data)) return data.map(x => prepareCardData(x, migrate))
  if (data === null) return null
  const w = parseSavedWork(data)
  if (!w) throw Error('카드 기록이 손상되어 저장하지 않았습니다')
  return separateCardWork(w, resultRoot(), migrate)
}
function readCardData(data: unknown): unknown {
  return Array.isArray(data) ? data.map(readCardData) : data === null ? null : restoreCardWork(data)
}
function writeWork(kind: WorkKind, key: string, data: unknown) {
  try { return writeRecord(host(), kind, key, kind === 'cards' ? prepareCardData(data) : data) }
  catch(e) { return { ok: false as const, why: (e as Error).message } }
}
function handle(channel:string,listener:Parameters<typeof ipcMain.handle>[1]):void {
  ipcMain.handle(channel,async(event,...args)=>{
    try{
      if(channel.startsWith('cards:')&&channel!=='cards:recover-removals'){
        const recovery=recoverWorkTransaction(join(host().root,'works','cards'))
        if(recovery.pending)throw Error(recovery.message||'이전 파일 정리가 남았습니다')
      }
      return await listener(event,...args)
    }
    catch(e){const why=(e as Error)?.message||'작업 기록을 처리하지 못했습니다';return {ok:false,why,error:why}}
  })
}
function writeBatch(kind:unknown,items:unknown){
  if(!isWorkKind(kind)||!Array.isArray(items)||!items.length||items.length>256)return {ok:false,why:'저장할 작업 묶음이 올바르지 않습니다'}
  const valid=items.every(x=>x&&typeof x==='object'&&typeof x.key==='string'&&x.key)
  if(!valid||new Set(items.map(x=>x.key)).size!==items.length)return {ok:false,why:'저장할 작업 열쇠가 없거나 겹칩니다'}
  ensureMoved(kind)
  return writeRecordBatch(host(),kind,items.map(x=>({key:x.key,data:kind==='cards'?prepareCardData(x.data):x.data})))
}
export function registerWorksIpc(): void {
  // 실행 때 복구를 먼저 시도한다. 실패는 앱 전체를 닫지 않고 카드 통로에서 표시한다.
  try{recoverWorkTransaction(join(host().root,'works','cards'))}catch{/* 사본을 보존하고 화면의 재시도로 연결 */}
  handle('cards:recover-removals',()=>({ok:true,...recoverWorkTransaction(join(host().root,'works','cards'))}))
  handle('works:write-batch',(_e,kind,items)=>writeBatch(kind,items))
  ipcMain.on('works:write-batch-sync',(event,kind,items)=>{try{event.returnValue=writeBatch(kind,items)}catch(e){event.returnValue={ok:false,why:(e as Error).message}}})
  handle('cards:load-input', async () => {
    try {
      const picked=await dialog.showOpenDialog({properties:['openFile'],defaultPath:resultRoot(),filters:[{name:'대사·연기 지시',extensions:['json']}]})
      if(picked.canceled || !picked.filePaths[0])return {ok:false,canceled:true}
      return {ok:true,...readStandaloneCardInput(picked.filePaths[0])}
    }catch(e){return {ok:false,why:(e as Error).message}}
  })
  handle('cards:save-input', (_e, raw: unknown) => {
    try {
      const w = parseSavedWork({cards:[raw],joins:{},savedAt:Date.now()})
      if (!w?.cards.length) throw Error('저장할 카드가 없습니다')
      return {ok:true, path:saveCardInput(w.cards[0],resultRoot())}
    } catch(e) {return {ok:false,why:(e as Error).message}}
  })
  handle('cards:remove', (_e, raw: unknown, audio: boolean, protectedPaths: string[]) => {
    try {
      const w=parseSavedWork({cards:[raw],joins:{},savedAt:Date.now()})
      if (!w?.cards.length) throw Error('삭제할 카드가 없습니다')
      const card=w.cards[0]
      ensureMoved('cards')
      const stored=listRecords(host(),'cards')
      if(stored.error)throw Error(stored.error)
      if(stored.broken.length)throw Error('읽지 못한 카드 기록이 있어 삭제하지 않았습니다')
      if(typeof audio!=='boolean')throw Error('음원 삭제 선택이 올바르지 않습니다')
      const others:string[]=[], inputPaths:string[]=[]
      const takeKey=(t:{id:string;path:string})=>t.id+'\0'+t.path
      const takeMap=new Map(card.takes.map(t=>[takeKey(t),t]))
      const collect=(data:unknown):void=>{
        if(Array.isArray(data)){data.forEach(collect);return}
        const work=parseSavedWork(data);if(!work)return
        for(const c of work.cards){if(c.id!==card.id){others.push(c.sourcePath,c.contentPath||'',...(c.contentPaths||[]),...c.takes.flatMap(t=>[t.path,t.sourcePath,t.contentPath||'']))}else{inputPaths.push(...(c.contentPaths||[]));if(c.contentPath)inputPaths.push(c.contentPath);for(const t of c.takes){if(t.contentPath)inputPaths.push(t.contentPath);if(!takeMap.has(takeKey(t)))takeMap.set(takeKey(t),t)}}}
      }
      stored.records.forEach(r=>collect(r.data))
      card.takes=[...takeMap.values()]
      const removals=planCardFileRemoval(card,audio,[...others,...(Array.isArray(protectedPaths)?protectedPaths:[])],inputPaths)
      const prune=(data:unknown):unknown=>{
        if(Array.isArray(data))return data.map(prune)
        const work=parseSavedWork(data);if(!work)return data
        return {...work,cards:work.cards.filter(c=>c.id!==card.id)}
      }
      const saved=writeRecordBatch(host(),'cards',stored.records.map(r=>({key:r.key,data:prune(r.data)})),removals)
      if(!saved.ok)throw Error(saved.why)
      return {ok:true,cleanupPending:saved.cleanupPending||0}
    }catch(e){return {ok:false,why:(e as Error).message}}
  })
  handle('works:list', (_e, kind: unknown) => {
    if (!isWorkKind(kind)) return { error: '알 수 없는 갈래입니다.' }
    ensureMoved(kind)
    const got = listRecords(host(), kind)
    if(got.error)return {error:got.error}
    if (kind === 'cards') {
      try {
        // 한 번 옮겨 저장에 성공한 뒤에만 내부 원문이 빠진다. 실패하면 원본을 유지한다.
        for (const r of got.records) {
          const pending=(data:unknown):boolean=>{
            if(Array.isArray(data))return data.some(pending)
            const w=parseSavedWork(data)
            return !!w?.cards.some(c=>c.text || 'h3Direction' in c.settings || 'emotion' in c.settings || c.takes.some(t=>t.text || 'h3Direction' in t.settings || 'h3Direction' in t.applied))
          }
          if (pending(r.data)) {
            const moved = prepareCardData(r.data, true)
            const saved = writeRecord(host(), kind, r.key, moved)
            if (!saved.ok) throw Error(saved.why)
            r.data = moved
          }
          r.data = readCardData(r.data)
        }
      } catch(e) { return { error: (e as Error).message } }
    }
    // ★깨진 파일을 조용히 버리지 않는다. 화면이 몇 개가 안 읽혔는지 말할 수 있어야 한다.
    return { records: got.records, broken: got.broken.length }
  })

  handle('works:read', (_e, kind: unknown, key: unknown) => {
    if (!isWorkKind(kind) || typeof key !== 'string') return { error: '알 수 없는 갈래입니다.' }
    ensureMoved(kind)
    const got=readRecordChecked(host(),kind,key)
    if(got.error)return {error:got.error}
    const record=got.record
    if (kind === 'cards' && record) record.data = readCardData(record.data)
    return { record }
  })

  handle('works:write', (_e, kind: unknown, key: unknown, data: unknown) => {
    if (!isWorkKind(kind) || typeof key !== 'string' || !key) {
      return { ok: false, why: '알 수 없는 갈래입니다.' }
    }
    ensureMoved(kind)
    const r = writeWork(kind, key, data)
    return r.ok ? { ok: true } : { ok: false, why: r.why }
  })

  /** ★지우기는 **그 파일 하나만** 지운다. 남의 기록을 다시 쓰는 일이 없다. */
  handle('works:delete', (_e, kind: unknown, key: unknown) => {
    if (!isWorkKind(kind) || typeof key !== 'string') {
      return { ok: false, why: '알 수 없는 갈래입니다.' }
    }
    ensureMoved(kind)
    const r = deleteRecord(host(), kind, key)
    return r.ok ? { ok: true, removed: r.removed } : { ok: false, why: r.why }
  })

  /**
   * 창이 닫히기 직전용 **동기** 통로.
   *
   * ★비동기 요청은 창이 닫히면 그대로 사라진다 — 마지막 편집 직후 종료하면 잃는다.
   *   동기 통로는 본체가 파일을 쓰고 답할 때까지 렌더러를 붙잡으므로 그 사이 닫히지 않는다.
   *   (설정 저장이 쓰던 길과 같다.)
   */
  ipcMain.on('works:write-sync', (event, kind: unknown, key: unknown, data: unknown) => {
    if (!isWorkKind(kind) || typeof key !== 'string' || !key) {
      event.returnValue = { ok: false, why: '알 수 없는 갈래입니다.' }
      return
    }
    try {
      ensureMoved(kind)
      const r = writeWork(kind, key, data)
      event.returnValue = r.ok ? { ok: true } : { ok: false, why: r.why }
    } catch(e){event.returnValue={ok:false,why:(e as Error).message}}
  })

  /** 갈래 하나를 통째로 비운다 — '쌓인 것 비우기' 만 쓴다. */
  handle('works:clear', (_e, kind: unknown) => {
    if (!isWorkKind(kind)) return { ok: false, why: '알 수 없는 갈래입니다.' }
    ensureMoved(kind)          // 옮기기 전에 비우면 옛 열쇠가 남아 되살아난다
    return { ok: true, removed: clearKind(host(), kind) }
  })
}
