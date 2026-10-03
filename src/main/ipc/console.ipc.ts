/**
 * 콘솔 창 통로 — 앱 로그의 **최근 줄**을 화면에 주고, 새 줄을 실시간으로 흘려 보낸다.
 * 화면의 동작 기록도 여기로 받아 같은 로그에 남긴다.
 *
 * ★창을 켜지 않아도 기록은 남는다 — 로그 파일이 권위이고, 이 통로는 보여 주기만 한다.
 * ★화면이 보내는 글은 믿지 않는다: 경로는 파일 이름만 남기고, 길이를 자르고, 꼬리표를 정한다.
 *   복사해 건네도 되는 기록이어야 하기 때문이다.
 */
import { ipcMain, BrowserWindow } from 'electron'
import { appLog } from '../services/app-log'
import { scrubPathsForLog } from '../services/log-scrub'
import { CONSOLE_MESSAGE_MAX, uiLevel, uiTag } from '../../shared/appConsole'

let registered = false

export function registerConsoleIpc(): void {
  // 창을 다시 만들어도 한 번만 — 두 번 구독하면 줄이 두 번씩 보인다.
  if (registered) return
  registered = true
  ipcMain.handle('console:recent', () => appLog()?.recent() ?? [])

  ipcMain.handle('console:write', (_e, level: unknown, tag: unknown, message: unknown) => {
    const text = scrubPathsForLog(String(message ?? '')).replace(/\s+/g, ' ').trim().slice(0, CONSOLE_MESSAGE_MAX)
    if (!text) return false
    appLog()?.write(uiLevel(level), uiTag(tag), text)
    return true
  })

  // 새 줄이 생기면 열린 창 모두에 보낸다. 창이 없으면 아무것도 하지 않는다.
  appLog()?.subscribe((line) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (!w.isDestroyed()) w.webContents.send('console:line', line) } catch { /* 닫히는 중 */ }
    }
  })
}
