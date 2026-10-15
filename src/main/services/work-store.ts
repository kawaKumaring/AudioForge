// @ts-ignore TS5097
import {writeFileDurable} from './durable-write.ts'
// @ts-ignore TS5097
import {writeWorkTransaction,recoverWorkTransaction} from './work-transaction.ts'
/**
 * 작업 기록 창고 — **기록 하나가 파일 하나.**
 *
 * ★지시 (2026-09-28)
 * > "셋팅.json 에 저장하는게 아닌 생성한 파일마다 정보를 따로 가지고있어서
 * >  그 파일만 삭제하게 하도록한다"
 *
 * 여기서 지키는 것
 *   · **지우기는 그 파일 하나만 지운다.** 남의 기록을 다시 쓰는 일이 없다.
 *   · 쓰기는 임시본 → 이름 바꾸기. 쓰다 멈춰도 **반쯤 쓴 파일이 남지 않는다.**
 *   · 깨진 파일 하나가 나머지를 가리지 않는다 — 그 파일만 건너뛰고 사유를 남긴다.
 *   · 옮기기는 **한 번만**, 그리고 옮긴 뒤 옛 열쇠를 지운다.
 *     남겨 두면 지운 기록이 다음 실행에 되살아난다(실제로 그렇게 됐다).
 */
import { existsSync, mkdirSync, renameSync,
  readFileSync, readdirSync, rmSync, statSync, lstatSync } from 'fs'
import { join } from 'path'
// ★확장자를 붙인다 — `node --test` 가 이 파일을 곧바로 읽는다(dub-job 과 같은 관례).
//   붙이지 않으면 실행 시점에 모듈을 못 찾는다.
// @ts-ignore TS5097
import {
  WORK_DIR_NAME, LEGACY_KEY_OF, fileNameOf, isWorkFile, makeRecord, parseRecord, splitLegacyMap,
// @ts-ignore TS5097
} from '../../shared/workRecord.ts'
import type { WorkKind, WorkRecord } from '../../shared/workRecord'

export interface WorkStoreHost {
  /** 기록이 사는 뿌리(보통 userData). */
  root: string
  /** 지금 시각(밀리초). 검사가 흔들리지 않게 밖에서 준다. */
  now: () => number
}

function dirOf(host: WorkStoreHost, kind: WorkKind): string {
  return join(host.root, WORK_DIR_NAME, kind)
}

/** 기록 하나를 **원자적으로** 쓴다. 성공 여부를 돌려준다. */
export function writeRecord(
  host: WorkStoreHost, kind: WorkKind, key: string, data: unknown,
): { ok: true; file: string } | { ok: false; why: string } {
  const dir = dirOf(host, kind)
  const file = join(dir, fileNameOf(key))
  const temp = `${file}.${process.pid}.tmp`
  try {
    recoverWorkTransaction(dir)
    mkdirSync(dir, { recursive: true })
    const body = JSON.stringify(makeRecord(key, data, host.now()), null, 2)
    writeFileDurable(temp, body)
    renameSync(temp, file)   // 이름 바꾸기는 한 번에 일어난다
    return { ok: true, file }
  } catch (e) {
    try { if (existsSync(temp)) rmSync(temp, { force: true }) } catch { /* 다음에 */ }
    return { ok: false, why: (e as Error)?.message || '쓰지 못했습니다' }
  }
}

/** 파일을 합치지 않고 교체의 성공·복구만 한 묶음으로 처리한다. */
export function writeRecordBatch(host:WorkStoreHost,kind:WorkKind,items:{key:string;data:unknown}[]):{ok:true}|{ok:false;why:string}{
  try{
    writeWorkTransaction(dirOf(host,kind),items.map(x=>({name:fileNameOf(x.key),body:JSON.stringify(makeRecord(x.key,x.data,host.now()),null,2)})))
    return {ok:true}
  }catch(e){return {ok:false,why:(e as Error).message}}
}

/** 기록 하나를 읽는다. 없거나 깨졌으면 null — **빈 기록으로 꾸미지 않는다.** */
export function readRecordChecked(host:WorkStoreHost,kind:WorkKind,key:string):{record:WorkRecord|null;error?:string}{
  const file=join(dirOf(host,kind),fileNameOf(key))
  try{
    recoverWorkTransaction(dirOf(host,kind))
    let info
    try{info=lstatSync(file)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {record:null};throw e}
    if(!info.isFile()||info.isSymbolicLink())throw Error('작업 파일이 연결이거나 파일이 아닙니다')
    const record=parseRecord(JSON.parse(readFileSync(file,'utf8')))
    if(!record||record.key!==key)throw Error('작업 기록의 내용 또는 열쇠가 다릅니다')
    return {record}
  }catch(e){return {record:null,error:(e as Error).message}}
}
/** 기존 읽기 전용 소비자는 null을 받되, 복원 화면은 checked의 사유를 사용한다. */
export function readRecord(host:WorkStoreHost,kind:WorkKind,key:string):WorkRecord|null {
  return readRecordChecked(host,kind,key).record
}

export interface ListResult {
  records: WorkRecord[]
  /** 깨져서 읽지 못한 파일 이름들. **조용히 버리지 않는다.** */
  broken: string[]
  /** 폴더 전체 읽기 실패. 없음과 구분해 쓰기를 차단한다. */
  error?: string
}

/** 갈래 하나의 기록 전부. 최근 손댄 순. */
export function listRecords(host: WorkStoreHost, kind: WorkKind): ListResult {
  const dir = dirOf(host, kind)
  const out: WorkRecord[] = []
  const broken: string[] = []
  let names: string[] = []
  try { recoverWorkTransaction(dir); names = readdirSync(dir) } catch(e) {
    return (e as NodeJS.ErrnoException).code==='ENOENT'?{records:[],broken:[]}:{records:[],broken:[],error:'작업 기록 폴더를 읽지 못했습니다: '+(e as Error).message}
  }
  for (const n of names) {
    if (!isWorkFile(n)) continue
    try {
      const path=join(dir,n),info=lstatSync(path)
      if(!info.isFile()||info.isSymbolicLink())throw Error('작업 파일이 연결이거나 파일이 아닙니다')
      const got = parseRecord(JSON.parse(readFileSync(path, 'utf-8')))
      if (got && fileNameOf(got.key)===n) out.push(got)
      else broken.push(n)
    } catch { broken.push(n) }
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return { records: out, broken }
}

/**
 * 기록 하나를 지운다 — **그 파일만.**
 *
 * 이미 없으면 지운 것으로 본다(`removed: false`). 없는 것을 지우라는 요청은
 * 실패가 아니다 — 사용자가 원한 상태가 이미 이루어져 있다.
 */
export function deleteRecord(
  host: WorkStoreHost, kind: WorkKind, key: string,
): { ok: true; removed: boolean } | { ok: false; why: string } {
  const file = join(dirOf(host, kind), fileNameOf(key))
  try {
    recoverWorkTransaction(dirOf(host,kind))
    if (!existsSync(file)) return { ok: true, removed: false }
    rmSync(file, { force: true })
    return { ok: true, removed: true }
  } catch (e) {
    return { ok: false, why: (e as Error)?.message || '지우지 못했습니다' }
  }
}

/** 갈래 하나를 통째로 비운다. 쓰는 것은 '쌓인 것 비우기' 뿐이다. */
export function clearKind(host: WorkStoreHost, kind: WorkKind): number {
  const dir = dirOf(host, kind)
  let n = 0
  let names: string[] = []
  try { recoverWorkTransaction(dir); names = readdirSync(dir) } catch(e) {if((e as NodeJS.ErrnoException).code==='ENOENT')return 0;throw e}
  for (const name of names) {
    if (!isWorkFile(name)) continue        // 남의 파일은 세지도 지우지도 않는다
    try { rmSync(join(dir, name), { force: true }); n++ } catch { /* 다음에 */ }
  }
  return n
}

export interface MoveResult {
  kind: WorkKind
  /** 옮긴 기록 수. */
  moved: number
  /** 옮기지 못한 것 — 사유와 함께. */
  failed: { key: string; why: string }[]
  /** 지운 옛 열쇠들. */
  clearedKeys: string[]
}

/**
 * 옛 `settings.json` 의 한 덩어리를 **기록 여럿으로 옮긴다.**
 *
 * ★이미 그 갈래에 파일이 있으면 **건너뛴다.** 두 번 옮기면 사용자가 지운 것이
 *   되살아난다 — 이 프로젝트에서 실제로 겪은 사고다.
 * ★옮기기가 **다 성공했을 때만** 옛 열쇠를 지운다. 반쯤 옮기고 지우면 기록이 사라진다.
 */
export function migrateKind(
  host: WorkStoreHost,
  kind: WorkKind,
  readLegacy: (key: string) => unknown,
  dropLegacy: (key: string) => boolean,
  transform: (data:unknown)=>unknown = data=>data,
): MoveResult {
  const out: MoveResult = { kind, moved: 0, failed: [], clearedKeys: [] }
  const listed=listRecords(host,kind)
  if(listed.error){out.failed.push({key:kind,why:listed.error});return out}
  // 손상 파일이 있으면 이관 쓰기는 하지 않되, 읽을 수 있는 나머지 목록은 가리지 않는다.
  if(listed.broken.length)return out
  const marker=join(dirOf(host,kind),'.legacy-migration.json')
  if(existsSync(marker)){
    try{
      const done=JSON.parse(readFileSync(marker,'utf8'))
      if(done.version!==1||done.kind!==kind||!Array.isArray(done.keys)||done.keys.some((k:unknown)=>typeof k!=='string'||!LEGACY_KEY_OF[kind].includes(k)))throw Error('이전 작업 이관 표가 손상되었습니다')
      for(const key of done.keys){if(dropLegacy(key))out.clearedKeys.push(key);else out.failed.push({key,why:'이전 작업의 옛 저장 위치를 정리하지 못했습니다'})}
    }catch(e){out.failed.push({key:kind,why:(e as Error).message})}
    return out
  }
  if(listed.records.length)return out
  const items:WorkRecord[]=[],keys:string[]=[]
  for(const legacyKey of LEGACY_KEY_OF[kind]){
    let raw:unknown
    try{raw=readLegacy(legacyKey)}catch(e){out.failed.push({key:legacyKey,why:(e as Error).message});return out}
    if(raw===undefined||raw===null)continue
    const records=splitLegacyMap(raw,host.now())
    items.push(...(records.length?records:[makeRecord(legacyKey,raw,host.now())]));keys.push(legacyKey)
  }
  if(!keys.length)return out
  try{
    writeWorkTransaction(dirOf(host,kind),[
      ...items.map(r=>({name:fileNameOf(r.key),body:JSON.stringify({...r,data:transform(r.data)},null,2)})),
      {name:'.legacy-migration.json',body:JSON.stringify({version:1,kind,keys})},
    ])
    out.moved=items.length
    for(const key of keys){if(dropLegacy(key))out.clearedKeys.push(key);else out.failed.push({key,why:'이전 작업의 옛 저장 위치를 정리하지 못했습니다'})}
  }catch(e){out.failed.push({key:kind,why:(e as Error).message})}

  return out
}

/** 기록이 차지하는 크기(바이트). 비우기 안내에 쓴다. */
export function sizeOfKind(host: WorkStoreHost, kind: WorkKind): number {
  const dir = dirOf(host, kind)
  let n = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!isWorkFile(name)) continue
      try { n += statSync(join(dir, name)).size } catch { /* 건너뛴다 */ }
    }
  } catch { return 0 }
  return n
}
