/**
 * 콘솔 창 — **앱 밖에 따로 뜨는 창**에서 동작 기록을 보고 복사한다.
 *
 * ★왜 따로 띄우나 (2026-09-30 피드백 셋이 이어졌다)
 *   1) 떠 있는 창 → "은근히 방해가 심하다"
 *   2) 아래 서랍 → "위로 올라와서 UX 를 해친다"
 *   3) 창을 아래로 늘리기 → "최대 창 크기가 변하지 않으니 결국 위로 밀려나는 건 똑같다"
 *   앱 화면 안에 두는 한 어떤 모양이든 작업 화면을 건드린다. 별도 창이면 **작업 화면에 영향이 없고**,
 *   모니터가 둘이면 옆 화면에 둘 수 있다(사용자 제안: "개발 틀에서 벗어난 외부로 따로 띄운다").
 *
 * 규칙
 *   · 설정의 '콘솔 켜기' 가 권위다. 켜면 뜨고, 끄면 닫힌다. **콘솔 창을 닫으면 설정도 꺼진다.**
 *   · 켜 둔 채 앱을 다시 켜면 **지난 자리·크기**로 다시 뜬다. 앱을 닫을 때 함께 닫히는 것은 '끔' 이 아니다.
 *   · 화면 밖에 저장된 자리면 버리고 기본 자리로 연다(모니터를 뺀 뒤 보이지 않는 창이 되지 않게).
 */
import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { dialogFolderHost } from './audio.ipc'
import { appLog } from '../services/app-log'
import { CONSOLE_POPUP_STORAGE_KEY, parseConsolePopup } from '../../shared/appConsole'

const BOUNDS_KEY = 'consoleWindowBounds'
let win: BrowserWindow | null = null
let owner: BrowserWindow | null = null
let preload = ''
let withApp = false            // 앱이 닫히며 함께 닫히는 중 — 설정을 끄지 않는다
let saveTimer: ReturnType<typeof setTimeout> | null = null

type Bounds = { x: number; y: number; width: number; height: number }

function savedBounds(): Bounds | null {
  try {
    const raw = dialogFolderHost().read(BOUNDS_KEY)
    const b = typeof raw === 'string' ? JSON.parse(raw) as Bounds : null
    if (!b || ![b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n))) return null
    // 보이는 화면과 겹치는가 — 모니터를 뺀 뒤에도 창을 잃지 않게.
    const d = screen.getDisplayMatching(b).workArea
    const visible = b.x < d.x + d.width - 60 && b.x + b.width > d.x + 60 && b.y < d.y + d.height - 40 && b.y + 30 > d.y
    return visible ? b : null
  } catch { return null }
}

function remember(): void {
  if (!win || win.isDestroyed()) return
  if (saveTimer) clearTimeout(saveTimer)
  const b = win.getBounds()
  saveTimer = setTimeout(() => { dialogFolderHost().write(BOUNDS_KEY, JSON.stringify(b)) }, 400)
}

function setPref(on: boolean): void {
  dialogFolderHost().write(CONSOLE_POPUP_STORAGE_KEY, on as unknown as string)
}

function open(): void {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return }
  const b = savedBounds()
  win = new BrowserWindow({
    ...(b ?? { width: 780, height: 460 }),
    minWidth: 420, minHeight: 200,
    title: 'AudioForge — 콘솔',
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    // 검사에서는 사람이 하던 일을 빼앗지 않게 앞으로 튀어나오지 않는다(앱 창과 같은 규칙).
    ...(process.env.AF_E2E === '1' ? { show: false } : {}),
    webPreferences: { preload, sandbox: false },
  })
  if (process.env.AF_E2E === '1') win.once('ready-to-show', () => { try { win?.showInactive() } catch { /* 닫혔다 */ } })
  win.setMenuBarVisibility(false)
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('move', remember)
  win.on('resize', remember)
  win.on('closed', () => {
    win = null
    if (withApp) return
    // 사용자가 콘솔 창을 닫았다 — 설정도 끈다. 앱 화면의 체크 상자에 알린다.
    setPref(false)
    appLog()?.info('console', '콘솔 창 닫음')
    try { owner?.webContents.send('console-window:closed') } catch { /* 앱 창이 닫히는 중 */ }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#console`)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'console' })
  appLog()?.info('console', '콘솔 창 엶')
}

function close(): void {
  if (win && !win.isDestroyed()) win.close()
}

let registered = false

/** 앱 창을 만든 뒤 한 번. 켜 두었으면 콘솔 창도 연다. */
export function registerConsoleWindowIpc(main: BrowserWindow, preloadPath: string): void {
  owner = main
  preload = preloadPath
  withApp = false
  main.on('close', () => { withApp = true; close() })
  if (!registered) {
    registered = true
    ipcMain.handle('console-window:set', (_e, on: unknown) => {
      const want = on === true
      setPref(want)
      if (want) open()
      else close()
      return true
    })
  }
  if (parseConsolePopup(dialogFolderHost().read(CONSOLE_POPUP_STORAGE_KEY))) {
    main.once('ready-to-show', () => open())
  }
}
