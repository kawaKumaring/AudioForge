import { app, BrowserWindow, protocol, net } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { pathToFileURL } from 'url'
import { registerAudioIpc } from './ipc/audio.ipc'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const preloadPath = join(__dirname, '../preload/index.js')
  console.log(`[main] preload: ${preloadPath} · exists=${existsSync(preloadPath)}`)
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0a0f',
      symbolColor: '#a0a0b0',
      height: 36
    },
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: preloadPath,
      sandbox: false
    }
  })

  // ── Electron 진단 로그 — 검은 화면/크래시 원인 규명용(stdout으로 E2E·터미널이 수집) ──
  const wc = mainWindow.webContents
  wc.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[main][did-fail-load] code=${code} desc=${desc} url=${url}`)
  })
  wc.on('preload-error', (_e, path, error) => {
    console.error(`[main][preload-error] ${path}: ${error?.stack || error}`)
  })
  wc.on('render-process-gone', (_e, details) => {
    console.error(`[main][render-process-gone] reason=${details.reason} exitCode=${details.exitCode}`)
  })
  wc.on('unresponsive', () => console.error('[main][unresponsive] renderer 응답 없음'))
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    // renderer의 console + 아래 preload에서 잡은 pageerror가 여기로 올라온다
    if (level >= 2) console.error(`[main][renderer-console:${level}] ${message} (${sourceId}:${line})`)
  })

  // Prevent Electron from navigating when files are dropped
  wc.on('will-navigate', (e) => e.preventDefault())

  registerAudioIpc(mainWindow)

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Register local-file protocol for serving audio files
protocol.registerSchemesAsPrivileged([
  { scheme: 'local-file', privileges: { bypassCSP: true, stream: true, supportFetchAPI: true } }
])

// 단일 인스턴스 — 사용자가 관찰한 '여러 AudioForge 인스턴스' 혼란을 방지(방어적; 검은 화면의
// 근본 원인은 아님). 락을 못 얻으면 즉시 종료하고, 기존 인스턴스는 두 번째 실행 시 창을 복원/포커스.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    protocol.handle('local-file', async (request) => {
      const filePath = decodeURIComponent(request.url.replace('local-file://', ''))
      // 소비자(렌더러 미디어/fetch)가 로드를 포기하면 Electron 34.2.0이 알려주는 경로는
      // '우리가 돌려준 body의 cancel()' 하나뿐이다. request.signal은 존재하지만 어떤 취소
      // 시나리오에서도 발화하지 않고, net.fetch 응답 body를 cancel해도 상류 로더는 살아남아
      // 파일 핸들과 전송 버퍼가 세션 내내 남는다. 그래서 자체 AbortController를 net.fetch에
      // 넘기고, 반환한 body가 cancel될 때 정확히 그 요청만 abort한다.
      // 주의: 여기서는 어떤 로그도 남기지 않는다(경로·미디어 바이트가 로그에 닿을 수 없게).
      const upstream = new AbortController()
      const res = await net.fetch(pathToFileURL(filePath).href, { signal: upstream.signal })
      if (!res.body) return res
      const reader = res.body.getReader()
      return new Response(
        new ReadableStream({
          async pull(controller) {
            try {
              const { done, value } = await reader.read()
              if (done) controller.close()
              else controller.enqueue(value)
            } catch (err) {
              try { controller.error(err) } catch { /* 이미 닫힘 */ }
            }
          },
          cancel() { upstream.abort() }
        }),
        { status: res.status, statusText: res.statusText, headers: res.headers }
      )
    })

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
