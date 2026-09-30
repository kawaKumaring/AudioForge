/**
 * 검사·개발툴 MCP 전용 — 창을 **화면 밖**에 띄운다(AF_E2E=1 이고 AF_E2E_OFFSCREEN=1 일 때만).
 *
 * ★왜 (2026-09-30 · 개발툴 MCP): AI 가 앱을 켜고 조작하며 확인할 때 창이 사용자 화면을 가리거나
 *   포커스를 빼앗으면 사람이 하던 일을 방해한다. 검사 모드(AF_E2E)는 이미 포커스를 가져오지 않는데(showInactive),
 *   MCP 는 오래 켜 두므로 **보이지도 않게** 화면 밖(-30000)으로 둔다. 캡처·조작은 그대로 된다.
 * ★보통 실행과 기존 검사는 달라지지 않는다 — 두 스위치가 모두 켜졌을 때만.
 * ★화면 밖·가려진 창은 브라우저가 그리기를 멈춘다 → 스로틀링 해제 스위치(ready 전)와 창마다 setBackgroundThrottling(false).
 *   (Spine2DManager 개발툴 MCP 에서 실측한 함정 — doc/MCP-DEVTOOL 참고)
 */
import type { App, BrowserWindow } from 'electron'

export const OFFSCREEN = process.env.AF_E2E === '1' && process.env.AF_E2E_OFFSCREEN === '1'
const OFF = -30000

/** 창 옵션에 섞을 값 — 꺼져 있으면 빈 값. */
export function offscreenWindowOptions(): { x?: number; y?: number; skipTaskbar?: boolean } {
  return OFFSCREEN ? { x: OFF, y: OFF, skipTaskbar: true } : {}
}

/** app ready 전에 한 번 — 가려진 창도 그리게 한다. */
export function applyOffscreenSwitches(app: App): void {
  if (!OFFSCREEN) return
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
}

/** 만든 창마다 — 그리기를 멈추지 않게, 앱이 창을 옮겨도 화면 밖에 두게. */
export function keepOffscreen(win: BrowserWindow): void {
  if (!OFFSCREEN) return
  try { win.webContents.setBackgroundThrottling(false) } catch { /* 닫혔다 */ }
  win.on('move', () => {
    try { const [x, y] = win.getPosition(); if (x !== OFF || y !== OFF) win.setPosition(OFF, OFF) } catch { /* 닫혔다 */ }
  })
}
