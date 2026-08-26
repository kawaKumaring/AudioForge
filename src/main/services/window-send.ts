// 렌더러 전송 가드 — 창이 이미 파괴된 뒤의 webContents.send는 throw한다(앱 종료 중, 창 닫힘 후 늦은 done 등).
//
// 코드베이스 전역에서 mainWindow.webContents.send(...)를 무가드로 호출하고 있어,
// 종료 시퀀스와 겹치면 IPC 핸들러가 예외로 중단되고 뒤따르는 정리(정착·러너 해제)가 통째로 날아간다.
// 이 모듈은 존재/파괴 여부를 확인하고, 전송이 '실제로' 일어났는지 boolean으로 돌려준다.
//
// Electron 의존성 없음 — 구조적 타이핑이라 테스트에서 fake로 주입 가능.

/** webContents 최소 형상(Electron.WebContents 호환). */
export interface SendableWebContents {
  send(channel: string, ...args: unknown[]): void
  isDestroyed?(): boolean
}

/** BrowserWindow 최소 형상(Electron.BrowserWindow 호환). */
export interface SendableWindow {
  webContents?: SendableWebContents | null
  isDestroyed?(): boolean
}

/**
 * webContents로 전송. 대상이 없거나 파괴됐으면 보내지 않고 false.
 * send 자체가 throw해도(레이스: 검사 직후 파괴) 삼키고 false — 호출부의 정리 로직을 끊지 않는다.
 */
export function sendToWebContents(
  wc: SendableWebContents | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!wc || typeof wc.send !== 'function') return false
  try {
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return false
  } catch {
    return false   // isDestroyed조차 실패 = 신뢰할 수 없는 대상
  }
  try {
    wc.send(channel, ...args)
    return true
  } catch {
    return false
  }
}

/**
 * 창을 통해 전송(창 파괴 여부도 함께 확인). audio.ipc.ts의 mainWindow를 그대로 넘기면 된다.
 * 반환값은 '실제로 보냈는가'.
 */
export function sendToWindow(
  win: SendableWindow | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!win) return false
  try {
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false
  } catch {
    return false
  }
  return sendToWebContents(win.webContents, channel, ...args)
}

/** 창에 고정된 전송기 — 핸들러마다 창을 다시 넘기지 않도록. */
export function createWindowSender(
  win: SendableWindow | null | undefined
): (channel: string, ...args: unknown[]) => boolean {
  return (channel: string, ...args: unknown[]) => sendToWindow(win, channel, ...args)
}
