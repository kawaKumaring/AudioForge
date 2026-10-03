// 콘솔 창 — 앱 밖에 **따로 뜨는 창**에서 동작 기록을 보고, 복사하고, 껐다 켜도 남는가.
//
// ★지시 (2026-09-30): "작동 동작 관련 콘솔 창을 복사해서 붙여 넣으면 문제를 찾는 게 수월할 것 같다.
//   콘솔 팝업을 활성화하지 않더라도 동작 관련 내용은 콘솔에 기록이 되어 있어야 한다."
// ★모양은 피드백 셋을 거쳐 **별도 창**이 됐다 — 떠 있는 창·아래 서랍·창 늘리기 모두 작업 화면을 건드렸다.
//   사용자 확인: "외부에 띄운 걸 봤다 이게 깔끔한 것 같아서 좋아 보인다."
//
// 여기서 보는 것
//   1) 설정에서 켜면 **앱 밖에 창이 하나 더** 뜨고, 앱 작업 화면의 크기는 그대로다
//   2) 켜기 **전에** 한 동작도 보인다 — 기록은 창과 무관하게 남는다
//   3) 새 동작이 실시간으로 붙고, 화면이 보낸 글의 폴더 경로는 이름만 남는다
//   4) 전체 복사(사용자 클립보드는 건드리지 않는다 — 앱 안에서 가로챈다)
//   5) 콘솔 창을 닫으면 설정도 꺼진다 · 켜 둔 채 다시 켜면 지난 자리로 다시 뜬다 · 설정에서 끄면 닫힌다
//
// 실행: node test/e2e/console-panel.e2e.mjs   (사전: npm run build. GPU 불필요)
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import fs from 'fs'
import path from 'path'
import { _electron as electron } from 'playwright'
import { isolatedUserData, cleanupUserData, enterStudio } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const UD = isolatedUserData()
let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}
const launch = () => electron.launch({
  args: ['out/main/index.js'], cwd: APP,
  env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, HF_HUB_OFFLINE: '1' },
})
const settingsJson = () => { try { return JSON.parse(fs.readFileSync(path.join(UD, 'settings.json'), 'utf-8')) } catch { return {} } }
const lineTexts = (w) => w.evaluate(() =>
  [...document.querySelectorAll('[data-testid="console-lines"] > div')].map((d) => d.textContent || ''))
/** 앱 창이 아닌 두 번째 창(콘솔)을 기다린다. */
const consoleWin = async (app, timeout = 10000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    for (const w of app.windows()) { if ((w.url() || '').includes('#console')) return w }
    await new Promise((r) => setTimeout(r, 150))
  }
  return null
}
const openChecksTab = async (win) => {
  await win.getByTestId('open-app-options').click()
  await win.getByTestId('app-options').waitFor()
  await win.getByTestId('options-tab-checks').click()   // 콘솔·진단 묶음은 '기능 검사' 탭에 있다
}
const mainHeight = (win) => win.evaluate(() => Math.round(document.querySelector('[data-testid="workspace-content"]').getBoundingClientRect().height))
const consoleBounds = (app) => app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('#console'))?.getBounds() ?? null)

let app = null
try {
  app = await launch()
  let win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)
  await enterStudio(win)        // 시작 화면의 '작업실 시작'(2026-10-03)
  ok(app.windows().length === 1, '처음에는 콘솔 창이 없다')
  ok(await win.getByTestId('export-diagnostics').count() === 0, '버전 아래에는 진단 묶음이 없다')

  // ── 2. 켜기 **전에** 한 동작 ─────────────────────────────────────────
  await win.getByTestId('mode-reader').click()
  await win.waitForSelector('[data-testid="reader-workspace"]')
  await win.waitForTimeout(300)
  const h0 = await mainHeight(win)

  // ── 1. 설정에서 켜면 앱 밖에 창이 뜬다 ───────────────────────────────
  await openChecksTab(win)
  ok(await win.getByTestId('export-diagnostics').count() === 1, '설정 안에 진단 묶음 내보내기가 있다')
  ok(!(await win.getByTestId('options-console').isChecked()), '콘솔 켜기는 처음에 꺼져 있다')
  await win.getByTestId('options-console').check()
  await win.getByTestId('options-close').click()
  let cw = await consoleWin(app)
  ok(!!cw, '★설정에서 켜면 앱 밖에 콘솔 창이 따로 뜬다')
  await cw.waitForSelector('[data-testid="console-lines"]')
  ok(await win.getByTestId('console-panel').count() === 0, '앱 화면 안에는 콘솔이 없다')
  ok(await mainHeight(win) === h0, '★앱 작업 화면의 크기는 그대로다', { h0, now: await mainHeight(win) })

  let lines = await lineTexts(cw)
  ok(lines.some((l) => /\[boot\]/.test(l)), '앱을 켤 때의 기록이 보인다')
  ok(lines.some((l) => /\[ui:mode\] 화면 reader/.test(l)), '★켜기 전에 한 동작도 보인다 — 기록은 창과 무관하게 남는다')

  // ── 3. 실시간 · 경로 가리기 ──────────────────────────────────────────
  await win.evaluate(() => window.api.logs.write('INFO', 'probe',
    ['E:', '검사폴더_PROBE9', '녹음_PROBE9.wav'].join(String.fromCharCode(92)) + ' 을 골랐다'))
  const live = await cw.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="console-lines"] > div')].some((d) => (d.textContent || '').includes('녹음_PROBE9.wav')),
  null, { timeout: 5000 }).then(() => true).catch(() => false)
  ok(live, '★앱에서 한 동작이 콘솔 창에 실시간으로 붙는다')
  lines = await lineTexts(cw)
  const probe = lines.find((l) => l.includes('녹음_PROBE9.wav')) || ''
  ok(/\[ui:probe\]/.test(probe) && !probe.includes('검사폴더_PROBE9'), '★화면이 보낸 글의 폴더 경로는 이름만 남는다', probe)
  ok(!lines.some((l) => /[A-Za-z]:[\\/]/.test(l)), '보이는 기록 어디에도 폴더 경로가 없다')
  const fileLog = fs.readdirSync(path.join(UD, 'logs')).map((n) => fs.readFileSync(path.join(UD, 'logs', n), 'utf-8')).join('')
  ok(fileLog.includes('[ui:mode] 화면 reader') && fileLog.includes('녹음_PROBE9.wav'), '같은 기록이 로그 파일에도 남는다')

  // ── 4. 전체 복사 — 사용자 클립보드는 건드리지 않는다 ───────────────────
  await app.evaluate(({ clipboard }) => { globalThis.__copied = null; clipboard.writeText = (t) => { globalThis.__copied = String(t) } })
  await cw.getByTestId('console-copy').click()
  await cw.waitForTimeout(300)
  const copied = await app.evaluate(() => globalThis.__copied)
  const shownText = (await lineTexts(cw)).join('\n')
  ok(typeof copied === 'string' && copied.includes('녹음_PROBE9.wav') && copied === shownText, '★전체 복사가 보이는 기록을 그대로 담는다')

  // ── 5. 닫으면 꺼지고 · 다시 켜면 지난 자리로 · 설정에서 끄면 닫힌다 ──────
  ok(settingsJson().consolePopup === true, '켜 둔 것이 설정 파일에 적힌다')
  // 자리를 옮겨 둔다 — 다시 켤 때 그 자리로 와야 한다.
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('#console'))
    w.setBounds({ x: 120, y: 90, width: 640, height: 380 })
  })
  await win.waitForTimeout(800)
  const moved = await consoleBounds(app)
  await app.close(); app = null                       // 앱을 닫으며 함께 닫힌 것은 '끔' 이 아니다
  ok(settingsJson().consolePopup === true, '앱을 닫으며 함께 닫힌 것은 끔이 아니다')

  app = await launch()
  win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)
  await enterStudio(win)        // 시작 화면의 '작업실 시작'(2026-10-03)
  cw = await consoleWin(app)
  ok(!!cw, '★켜 둔 채 다시 켜면 콘솔 창도 다시 뜬다')
  const b = await consoleBounds(app)
  // 창 테두리 계산으로 몇 픽셀 어긋날 수 있다 — 옮겨 둔 자리와 견준다.
  const near = (p, q) => !!p && !!q && ['x', 'y', 'width', 'height'].every((k) => Math.abs(p[k] - q[k]) <= 16)
  ok(near(b, moved), '지난 자리·크기로 뜬다', { moved, b })

  // 사용자가 콘솔 창을 닫으면 설정이 꺼지고, 앱 화면의 체크 상자도 따라 꺼진다.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('#console'))?.close())
  await win.waitForTimeout(700)
  ok(app.windows().length === 1, '콘솔 창이 닫힌다')
  ok(settingsJson().consolePopup === false, '★콘솔 창을 닫으면 설정도 꺼진다')
  await openChecksTab(win)
  ok(!(await win.getByTestId('options-console').isChecked()), '앱 화면의 체크 상자도 따라 꺼진다')

  // 설정에서 다시 켜고 끄기
  await win.getByTestId('options-console').check()
  ok(!!(await consoleWin(app)), '설정에서 다시 켜면 뜬다')
  await win.getByTestId('options-console').uncheck()
  await win.waitForTimeout(700)
  ok(app.windows().length === 1 && settingsJson().consolePopup === false, '설정에서 끄면 닫히고 꺼진다')
} catch (e) {
  console.error('FAIL', e?.message || e)
  fails.push(String(e?.message || e))
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
}
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
