/**
 * 생성 카드 작업을 **저장하는 자리** — 화면 밖.
 *
 * ★왜 화면 밖으로 나왔나 (2026-09-27 검수 재현)
 *   저장이 화면 안의 effect 였다. 그래서 화면을 떠날 때 **대기 중인 저장 타이머를 취소**했고,
 *   마지막 편집(대사 B)이 통째로 사라졌다 — 디스크에는 A 가 남았다.
 *   화면 수명과 저장 수명은 다른 것이다. 여기서는 화면이 사라져도 타이머가 계속 산다.
 *
 * ★순서가 뒤집히지 않는다
 *   쓰기를 **한 줄로 세운다.** 앞 쓰기가 느려도 뒤 쓰기가 먼저 닿지 않는다.
 *   뒤늦게 끝난 앞 쓰기의 결과로 상태를 되돌리지도 않는다(번호로 가린다).
 *
 * ★실패를 삼키지 않는다
 *   `saveSetting` 은 실패를 던지지 않고 **돌려준다.** 그 값을 버리면 사용자는 저장된 줄 안다.
 *   여기서 받아 상태로 올리고, 화면이 '저장 실패' 와 다시 저장을 내놓는다.
 *
 * ★이전 문서를 덮지 않는다
 *   되살리기를 거절하면 그 문서를 **옆으로 치운다**(`keepAside`). 새 작업은 빈 자리에 쓴다.
 *   생성한 소리 파일이 남는 것과 작업 문서가 남는 것은 다른 일이다.
 */
import {
  adoptFromKept, emptySavedFile, keepAside, parseSavedFile, removeWork,
  type SavedFile, type SavedWork,
// @ts-ignore TS5097
} from '../../shared/synthesisCardSave.ts'
// @ts-ignore TS5097
import { applyImport } from '../../shared/legacyCardImport.ts'
// @ts-ignore TS5097

export type SavePhase = 'idle' | 'saving' | 'saved' | 'failed'
export interface SaveState {
  phase: SavePhase
  /** 실패 코드. 화면은 툴팁에만 쓴다. */
  code: string
  at: number
}

/** 편집이 멎은 뒤 이만큼 기다렸다 쓴다. */
export const SAVE_DELAY_MS = 600

let file: SavedFile = emptySavedFile()
let loaded = false
let readFailed = false
let timer: ReturnType<typeof setTimeout> | null = null
/** 쓰기를 한 줄로 세운다. */
let lane: Promise<unknown> = Promise.resolve()
let issued = 0
let settled = 0
let state: SaveState = { phase: 'idle', code: '', at: 0 }
const listeners = new Set<(s: SaveState) => void>()

function publish(next: SaveState): void {
  state = next
  for (const cb of listeners) cb(next)
}

export function saveState(): SaveState { return state }
export function onSaveState(cb: (s: SaveState) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** 검사용 — 지금 메모리에 든 문서. */
export function savedFileNow(): SavedFile { return file }

/**
 * 카드 작업을 **두 기록으로** 쓴다 — 하던 것과 보관함.
 *
 * 두 통로가 모두 끝난 뒤 성공을 표시한다. 예외도 저장 실패로 보고한다.
 * 본체는 두 파일 교체 중 실패·중단을 복구한다. 파일별 저장 구조는 유지한다.
 */
async function writeCards(next: SavedFile): Promise<string> {
  try {
    const result=await window.api.works.writeBatch('cards',[
      {key:'current',data:next.current},{key:'kept',data:next.kept},
    ])
    return result.ok?'':result.why||'WRITE_FAILED'
  } catch { return 'WRITE_EXCEPTION' }
}

/** 저장본을 한 번 읽는다. 두 번 부르면 읽어 둔 것을 돌려준다. */
export async function loadSavedFile(force = false): Promise<SavedFile> {
  if (loaded && !force) return file
  try {
    // ★기록 하나가 파일 하나다 (2026-09-29). 카드 작업은 **하던 것**과 **보관함**
    //   두 칸이라 파일도 둘이다. 설정 한 칸에 모아 두면 하나를 지울 때 전체를
    //   다시 써야 하고, 그래서 지운 것이 되살아났다 — 실제로 겪은 일이다.
    const got = await window.api.works.list('cards')
    if (got.error) throw new Error(got.error)
    if(got.broken)throw Error('읽지 못한 카드 기록이 있어 저장을 막았습니다')
    const bag: Record<string, unknown> = {}
    for (const r of got.records || []) bag[r.key] = r.data
    file = parseSavedFile({ current: bag.current ?? null, kept: bag.kept ?? [] })
  } catch {
    readFailed = true
    publish({phase:'failed',code:'READ_FAILED',at:Date.now()})
    throw Error('이전 작업을 읽지 못했습니다. 빈 기록으로 덮지 않습니다')
  }
  const recoveredRead=readFailed
  loaded = true; readFailed = false
  if(recoveredRead)publish({phase:'idle',code:'',at:Date.now()})
  return file
}

/** 지금 문서를 옆으로 치운다(되살리기 거절). 곧바로 디스크에도 남긴다. */
export async function keepCurrentAside(): Promise<void> {
  await loadSavedFile()
  file = keepAside(file)
  await flushSave()
}

/**
 * 치워 둔 문서 하나를 다시 '지금 것' 으로 삼는다(되살리기 선택).
 * **하던 작업은 보관함으로 옮긴다** — 규칙은 `shared/synthesisCardSave` 가 소유한다.
 */
export function adoptKept(index: number): void {
  file = adoptFromKept(file, index)
}

/**
 * 옛 작업에서 가져온 문서를 **지금 것**으로 삼는다. 성공하면 빈 문자열, 아니면 사유.
 *
 * ★반만 들어가지 않는다 (2026-09-27 지시)
 *   ① 하던 작업을 먼저 끝까지 **저장한다** — 보관함으로 옮기기 전에 최신이어야 한다.
 *   ② 디스크에 **먼저** 쓴다. 성공했을 때만 화면이 카드를 바꾼다.
 *   ③ 쓰기가 실패하면 **읽어 둔 문서를 통째로 되돌린다** — 카드 몇 장만 남는 일이 없다.
 * ★지우지 않는다. 하던 작업은 보관함 앞으로 갈 뿐이다.
 */
export async function importLegacyWork(doc: SavedWork): Promise<string> {
  await loadSavedFile()
  await flushSave()                    // 하던 작업의 마지막 편집까지 남긴 뒤에 옮긴다
  if(state.phase==='failed')return state.code||'WRITE_FAILED'
  const before = file
  const next = applyImport(file, doc)
  if(!autoSaveEnabled){file=next;dirtyWork=null;publish({phase:'idle',code:'SAVE_DISABLED',at:Date.now()});return ''}
  const writing = lane.then(() => writeCards(next))
  lane = writing.catch(() => {})
  const code = await writing
  if (code) {
    file = before                      // ★되돌린다 — 가져오기는 없던 일이 된다
    publish({ phase: 'failed', code, at: Date.now() })
    return code
  }
  file = next
  dirtyWork = null                     // 지난 문서를 다시 쓰지 않게 한다
  publish({ phase: 'saved', code: '', at: Date.now() })
  return ''
}

/**
 * 저장된 작업 하나를 지운다. 성공하면 빈 문자열, 아니면 사유.
 *
 * ★디스크에 **먼저** 쓰고 성공했을 때만 읽어 둔 문서를 바꾼다 —
 *   실패하면 없던 일이 된다. 지운 줄 알고 넘어가게 두지 않는다.
 * ★기다리던 저장이 지운 것을 되살리지 않게 먼저 흘려보낸다.
 */
export async function deleteSavedWork(slot: 'current' | 'kept', index: number, expected?:SavedWork): Promise<string> {
  await loadSavedFile()
  await flushSave()
  if(state.phase==='failed')return state.code||'WRITE_FAILED'
  if(expected){
    const identity=(w:SavedWork|null)=>w?JSON.stringify([w.savedAt,w.cards.map(c=>c.id)]):''
    const actual=slot==='current'?file.current:file.kept[index]??null
    if(identity(actual)!==identity(expected))return '작업 목록이 바뀌었습니다. 목록을 다시 열어 선택해 주세요'
  }
  const before = file
  const next = removeWork(file, slot, index)
  const writing = lane.then(() => writeCards(next))
  lane = writing.catch(() => {})
  const code = await writing
  if (code) {
    file = before
    publish({ phase: 'failed', code, at: Date.now() })
    return code
  }
  file = next
  if (slot === 'current') dirtyWork = null      // 지운 문서를 다시 쓰지 않는다
  publish({ phase: 'saved', code: '', at: Date.now() })
  return ''
}

let dirtyWork: SavedWork | null = null
let autoSaveEnabled = false
export function configureCardAutoSave(enabled: boolean): void {
  autoSaveEnabled = enabled
  if (!enabled) { if(timer)clearTimeout(timer);timer=null;dirtyWork=null }
}
export function removeCardFromSave(id: string): void {
  const prune=(w:SavedWork|null):SavedWork|null=>w?{...w,cards:w.cards.filter(c=>c.id!==id)}:null
  file={current:prune(file.current),kept:file.kept.map(w=>prune(w)!)}
  if(dirtyWork)dirtyWork=prune(dirtyWork)
}

/**
 * 저장을 예약한다. **화면이 사라져도 이 타이머는 산다.**
 * 같은 순간에 여러 번 불려도 마지막 값 하나만 쓴다.
 */
export function queueSave(work: SavedWork): void {
  if (!autoSaveEnabled) return
  dirtyWork = work
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; void writeNow() }, SAVE_DELAY_MS)
}

/** 대기 중인 저장을 **지금** 쓴다. 화면을 떠날 때·앱을 닫을 때 부른다. */
export function flushSave(): Promise<void> {
  if (!autoSaveEnabled) return Promise.resolve()
  if (timer) { clearTimeout(timer); timer = null }
  return writeNow()
}

/** 실패한 저장을 다시 시도한다. */
export async function retrySave(): Promise<void> {
  try {
    if(readFailed)await loadSavedFile(true)
    await flushSave()
  } catch { publish({phase:'failed',code:'READ_FAILED',at:Date.now()}) }
}

function writeNow(): Promise<void> {
  if(!loaded&&!readFailed)return loadSavedFile().then(()=>writeNow()).catch(()=>{})
  if(readFailed){publish({phase:'failed',code:'READ_FAILED',at:Date.now()});return Promise.resolve()}
  if (dirtyWork) {
    const ids=new Set(dirtyWork.cards.map(c=>c.id))
    if(file.current?.cards.length && dirtyWork.cards.length && !file.current.cards.some(c=>ids.has(c.id))) file=keepAside(file)
    file = { ...file, current: dirtyWork }
  }
  if (!loaded && !dirtyWork) return Promise.resolve()
  const mine = ++issued
  const payload: SavedFile = { current: file.current, kept: file.kept }
  publish({ phase: 'saving', code: '', at: Date.now() })
  // ★한 줄로 세운다 — 디스크에 닿는 순서가 부른 순서와 같아야 한다.
  const queued = lane.then(async () => {
    const code = await writeCards(payload)
    // 늦게 끝난 앞 쓰기가 뒤 쓰기의 결과를 되돌리지 않게 한다.
    if (mine < settled) return
    settled = mine
    publish(code
      ? { phase: 'failed', code, at: Date.now() }
      : { phase: 'saved', code: '', at: Date.now() })
  })
  lane = queued.catch(() => {})
  return queued
}

/** 검사·재시작용 — 읽어 둔 것을 잊는다. */
export function resetSaverForTest(): void {
  autoSaveEnabled = true; readFailed = false
  file = emptySavedFile(); loaded = false; dirtyWork = null
  if (timer) { clearTimeout(timer); timer = null }
  issued = 0; settled = 0
  state = { phase: 'idle', code: '', at: 0 }
}

/**
 * 창이 닫히는 순간 **기다려 주는 통로**로 마지막 상태를 남긴다.
 *
 * ★비동기 요청은 창이 닫히면 그대로 사라진다 — 마지막 편집 직후 종료하면 잃는다.
 *   동기 통로는 본체가 파일을 쓰고 답할 때까지 렌더러를 붙잡으므로 그 사이 닫히지 않는다
 *   (자동 저장이 쓰던 길과 같다, 2026-09-27 2차 검수 지적).
 */
export function flushSaveSync(): void {
  if (!autoSaveEnabled || readFailed || !loaded) return
  if (timer) { clearTimeout(timer); timer = null }
  if (dirtyWork) file = { ...file, current: dirtyWork }
  if (!loaded && !dirtyWork) return
  try {
    const result=window.api.works.writeBatchSync('cards',[{key:'current',data:file.current},{key:'kept',data:file.kept}])
    if(!result.ok)publish({phase:'failed',code:result.why||'WRITE_FAILED',at:Date.now()})
  } catch { /* 닫히는 중이다. 여기서 더 할 수 있는 것이 없다 */ }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => { flushSaveSync() })
}
