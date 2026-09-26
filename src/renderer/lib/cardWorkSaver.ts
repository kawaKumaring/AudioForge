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
  CARD_STORAGE_KEY, adoptFromKept, emptySavedFile, keepAside, parseSavedFile,
  type SavedFile, type SavedWork,
// @ts-ignore TS5097
} from '../../shared/synthesisCardSave.ts'
// @ts-ignore TS5097
import { saveSetting } from '../../shared/saveSetting.ts'

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

/** 저장본을 한 번 읽는다. 두 번 부르면 읽어 둔 것을 돌려준다. */
export async function loadSavedFile(force = false): Promise<SavedFile> {
  if (loaded && !force) return file
  try {
    const got = await window.api.settings.get() as Record<string, unknown> | undefined
    file = parseSavedFile(got?.[CARD_STORAGE_KEY])
  } catch {
    file = emptySavedFile()          // 못 읽으면 없는 것으로 본다. **지우지는 않는다.**
  }
  loaded = true
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

let dirtyWork: SavedWork | null = null

/**
 * 저장을 예약한다. **화면이 사라져도 이 타이머는 산다.**
 * 같은 순간에 여러 번 불려도 마지막 값 하나만 쓴다.
 */
export function queueSave(work: SavedWork): void {
  dirtyWork = work
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; void writeNow() }, SAVE_DELAY_MS)
}

/** 대기 중인 저장을 **지금** 쓴다. 화면을 떠날 때·앱을 닫을 때 부른다. */
export function flushSave(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null }
  return writeNow()
}

/** 실패한 저장을 다시 시도한다. */
export function retrySave(): Promise<void> {
  return flushSave()
}

function writeNow(): Promise<void> {
  if (dirtyWork) { file = { ...file, current: dirtyWork } }
  if (!loaded && !dirtyWork) return Promise.resolve()
  const mine = ++issued
  const payload = { current: file.current, kept: file.kept }
  publish({ phase: 'saving', code: '', at: Date.now() })
  // ★한 줄로 세운다 — 디스크에 닿는 순서가 부른 순서와 같아야 한다.
  const queued = lane.then(async () => {
    const code = await saveSetting(window.api.settings.set, CARD_STORAGE_KEY, payload)
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
  if (timer) { clearTimeout(timer); timer = null }
  if (dirtyWork) file = { ...file, current: dirtyWork }
  if (!loaded && !dirtyWork) return
  try { window.api.settings.setSync(CARD_STORAGE_KEY, { current: file.current, kept: file.kept }) }
  catch { /* 닫히는 중이다. 여기서 더 할 수 있는 것이 없다 */ }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => { flushSaveSync() })
}
