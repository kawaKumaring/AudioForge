// 콘솔 창 — 동작 기록을 **보고, 복사하고, 껐다 켜도 남는가.**
//
// ★지시 (2026-09-30): "작동 동작 관련 콘솔 창을 복사해서 붙여 넣으면 문제를 찾는 게 수월할 것 같다.
//   설정 내부에 콘솔 팝업 활성화 기능과 버전 아래 있는 진단 묶음 내보내기를 설정 안으로 옮긴다.
//   콘솔 팝업을 활성화하지 않더라도 동작 관련 내용은 콘솔에 기록이 되어 있어야 한다."
//
// 여기서 보는 것
//   1) 진단 묶음은 버전 아래에 없고 **설정 안**에 있다
//   2) 콘솔을 **켜기 전에** 한 동작도 켠 뒤에 보인다 — 기록은 창과 무관하게 남는다
//   3) 새 동작이 실시간으로 붙고, 화면이 보낸 글의 폴더 경로는 이름만 남는다
//   4) 전체 복사가 된다(사용자 클립보드는 건드리지 않는다 — 앱 안에서 가로챈다)
//   5) 껐다 켜도 콘솔 창이 다시 뜬다 · 닫으면 꺼진다
//
// 실행: node test/e2e/console-panel.e2e.mjs   (사전: npm run build. GPU 불필요)
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import fs from 'fs'
import path from 'path'
import { _electron as electron } from 'playwright'
import { isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const UD = isolatedUserData()
let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}
const lineTexts = (win) => win.evaluate(() =>
  [...document.querySelectorAll('[data-testid="console-lines"] > div')].map((d) => d.textContent || ''))
const launch = () => electron.launch({
  args: ['out/main/index.js'], cwd: APP,
  env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, HF_HUB_OFFLINE: '1' },
})
const settingsJson = () => { try { return JSON.parse(fs.readFileSync(path.join(UD, 'settings.json'), 'utf-8')) } catch { return {} } }

let app = null
try {
  app = await launch()
  let win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)

  // ── 1. 진단 묶음은 설정 안으로 ───────────────────────────────────────
  ok(await win.getByTestId('export-diagnostics').count() === 0, '버전 아래에는 진단 묶음이 없다')
  ok(await win.getByTestId('console-panel').count() === 0, '처음에는 콘솔 창이 닫혀 있다')

  // ── 2. 켜기 **전에** 한 동작 ─────────────────────────────────────────
  await win.getByTestId('mode-reader').click()
  await win.waitForSelector('[data-testid="reader-workspace"]')
  await win.waitForTimeout(300)

  await win.getByTestId('open-app-options').click()
  await win.getByTestId('app-options').waitFor()
  ok(await win.getByTestId('export-diagnostics').count() === 1, '★설정 안에 진단 묶음 내보내기가 있다')
  ok(!(await win.getByTestId('options-console').isChecked()), '콘솔 창 보기는 처음에 꺼져 있다')
  await win.getByTestId('options-console').check()
  await win.getByTestId('options-close').click()
  await win.getByTestId('console-panel').waitFor()
  ok(true, '★설정에서 켜면 콘솔 창이 뜬다')

  let lines = await lineTexts(win)
  ok(lines.some((l) => /\[boot\]/.test(l)), '앱을 켤 때의 기록이 보인다', lines.slice(0, 3))
  ok(lines.some((l) => /\[ui:mode\] 화면 reader/.test(l)), '★창을 켜기 전에 한 동작도 보인다 — 기록은 창과 무관하게 남는다',
    lines.filter((l) => /ui:/.test(l)))

  // ── 3. 실시간 · 경로 가리기 ──────────────────────────────────────────
  await win.evaluate(() => window.api.logs.write('INFO', 'probe',
    ['E:', '검사폴더_PROBE9', '녹음_PROBE9.wav'].join(String.fromCharCode(92)) + ' 을 골랐다'))
  const live = await win.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="console-lines"] > div')].some((d) => (d.textContent || '').includes('녹음_PROBE9.wav')),
  null, { timeout: 5000 }).then(() => true).catch(() => false)
  ok(live, '★새 기록이 실시간으로 붙는다')
  lines = await lineTexts(win)
  const probe = lines.find((l) => l.includes('녹음_PROBE9.wav')) || ''
  ok(/\[ui:probe\]/.test(probe) && !probe.includes('검사폴더_PROBE9'), '★화면이 보낸 글의 폴더 경로는 이름만 남는다', probe)
  ok(!lines.some((l) => /[A-Za-z]:[\\/]/.test(l)), '보이는 기록 어디에도 폴더 경로가 없다',
    lines.filter((l) => /[A-Za-z]:[\\/]/.test(l)).slice(0, 2))
  const fileLog = fs.readdirSync(path.join(UD, 'logs')).map((n) => fs.readFileSync(path.join(UD, 'logs', n), 'utf-8')).join('')
  ok(fileLog.includes('[ui:mode] 화면 reader') && fileLog.includes('녹음_PROBE9.wav'), '같은 기록이 로그 파일에도 남는다')

  // ── 4. 전체 복사 — 사용자 클립보드는 건드리지 않는다 ───────────────────
  await app.evaluate(({ clipboard }) => {
    globalThis.__copied = null
    clipboard.writeText = (t) => { globalThis.__copied = String(t) }
  })
  await win.getByTestId('console-copy').click()
  await win.waitForTimeout(300)
  const copied = await app.evaluate(() => globalThis.__copied)
  // ★기록 한 건이 여러 줄일 수 있다(이어지는 줄은 들여 써서 한 건으로 묶인다) — 줄 수가 아니라 글 전체를 견준다.
  const shownText = (await lineTexts(win)).join('\n')
  ok(typeof copied === 'string' && copied.includes('녹음_PROBE9.wav') && copied === shownText,
    '★전체 복사가 보이는 기록을 그대로 담는다', { copiedLen: copied?.length, shownLen: shownText.length })

  // ── 5. 껐다 켜도 남는다 · 닫으면 꺼진다 ───────────────────────────────
  ok(settingsJson().consolePopup === true, '켜 둔 것이 설정 파일에 적힌다', settingsJson().consolePopup)
  await app.close(); app = null
  app = await launch()
  win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)
  const back = await win.waitForSelector('[data-testid="console-panel"]', { timeout: 8000 }).then(() => true).catch(() => false)
  ok(back, '★껐다 켜도 콘솔 창이 다시 뜬다')
  await win.getByTestId('console-close').click()
  await win.waitForTimeout(400)
  ok(await win.getByTestId('console-panel').count() === 0, '닫으면 사라진다')
  ok(settingsJson().consolePopup === false, '닫은 것도 설정 파일에 적힌다', settingsJson().consolePopup)
} catch (e) {
  console.error('FAIL', e?.message || e)
  fails.push(String(e?.message || e))
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
}
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
