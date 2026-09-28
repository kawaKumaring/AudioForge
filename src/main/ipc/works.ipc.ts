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
import { ipcMain, app } from 'electron'
import { join } from 'path'
import {
  listRecords, readRecord, writeRecord, deleteRecord, clearKind, migrateKind,
} from '../services/work-store'
import { readSettingsFile, setSettingsKey } from '../services/settings-store'
import { isWorkKind, type WorkKind } from '../../shared/workRecord'
import { currentBuildInfo } from './app-version.ipc'

function host() {
  return { root: app.getPath('userData'), now: () => Date.now() }
}

function settingsPath(): string { return join(app.getPath('userData'), 'settings.json') }

function readLegacy(key: string): unknown {
  try {
    const got = readSettingsFile(settingsPath())
    return got.kind === 'ok' ? (got.settings as Record<string, unknown>)[key] : undefined
  } catch { return undefined }
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
  moved.add(kind)
  try { migrateKind(host(), kind, readLegacy, dropLegacy) } catch { /* 다음 요청에서 다시 보지 않는다 */ }
}

export function registerWorksIpc(): void {
  ipcMain.handle('works:list', (_e, kind: unknown) => {
    if (!isWorkKind(kind)) return { error: '알 수 없는 갈래입니다.' }
    ensureMoved(kind)
    const got = listRecords(host(), kind)
    // ★깨진 파일을 조용히 버리지 않는다. 화면이 몇 개가 안 읽혔는지 말할 수 있어야 한다.
    return { records: got.records, broken: got.broken.length }
  })

  ipcMain.handle('works:read', (_e, kind: unknown, key: unknown) => {
    if (!isWorkKind(kind) || typeof key !== 'string') return { error: '알 수 없는 갈래입니다.' }
    ensureMoved(kind)
    return { record: readRecord(host(), kind, key) }
  })

  ipcMain.handle('works:write', (_e, kind: unknown, key: unknown, data: unknown) => {
    if (!isWorkKind(kind) || typeof key !== 'string' || !key) {
      return { ok: false, why: '알 수 없는 갈래입니다.' }
    }
    ensureMoved(kind)
    const r = writeRecord(host(), kind, key, data)
    return r.ok ? { ok: true } : { ok: false, why: r.why }
  })

  /** ★지우기는 **그 파일 하나만** 지운다. 남의 기록을 다시 쓰는 일이 없다. */
  ipcMain.handle('works:delete', (_e, kind: unknown, key: unknown) => {
    if (!isWorkKind(kind) || typeof key !== 'string') {
      return { ok: false, why: '알 수 없는 갈래입니다.' }
    }
    ensureMoved(kind)
    const r = deleteRecord(host(), kind, key)
    return r.ok ? { ok: true, removed: r.removed } : { ok: false, why: r.why }
  })

  /** 갈래 하나를 통째로 비운다 — '쌓인 것 비우기' 만 쓴다. */
  ipcMain.handle('works:clear', (_e, kind: unknown) => {
    if (!isWorkKind(kind)) return { ok: false, why: '알 수 없는 갈래입니다.' }
    ensureMoved(kind)          // 옮기기 전에 비우면 옛 열쇠가 남아 되살아난다
    return { ok: true, removed: clearKind(host(), kind) }
  })
}
