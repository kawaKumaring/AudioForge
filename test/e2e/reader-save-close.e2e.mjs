// 낭독 — **마지막 편집 직후 창을 닫아도** 읽던 자리·서재 보기가 남는다. 실제 창 닫기 · 실제 파일 · 실제 다시 켜기.
// 왜(2026-10-02 관리자 검수): 저장이 화면 안 타이머라 문단을 누른 뒤 600ms 안에 메뉴를 옮기거나 닫으면 디스크에 남지 않았다.
//   저장은 이제 화면 밖(writeBehind)이고, 창이 닫히는 순간에는 동기 통로(beforeunload)로 마지막 값을 남긴다.
// 사용자 책은 쓰지 않는다 — 검사용 TXT 를 만든다. GPU 를 쓰지 않는다.
// 실행: node test/e2e/reader-save-close.e2e.mjs     (사전: npm run build)
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { _electron as electron } from 'playwright'
import { isolatedUserData, cleanupUserData, cleanupIsolated } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const UD = isolatedUserData()
const ISO = path.join(os.tmpdir(), 'audioforge_e2e_' + randomUUID())
fs.mkdirSync(ISO, { recursive: true })
const BOOK = path.join(ISO, '닫기 검사 책.txt')
fs.writeFileSync(BOOK, Array.from({ length: 60 }, (_, i) => `닫기 검사 ${i + 1}번째 문단입니다.`).join('\n'), 'utf-8')

let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}
const launch = () => electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, AF_E2E_SELECT_FILE: BOOK } })
/** 디스크에 적힌 책 기록(검사 프로세스가 파일을 직접 읽는다). */
const bookOnDisk = () => {
  const dir = path.join(UD, 'works', 'books')
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []
  for (const f of files) { try { const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); if (r?.data?.name === '닫기 검사 책') return r.data } catch { /* 건너뜀 */ } }
  return null
}
const prefsOnDisk = () => {
  try { const s = JSON.parse(fs.readFileSync(path.join(UD, 'settings.json'), 'utf-8')); return s.readerPrefs ?? null } catch { return null }
}

let app = null
try {
  app = await launch()
  let win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)
  await win.getByTestId('mode-reader').click()
  await win.getByTestId('reader-add-text').first().click()
  await win.waitForSelector('[data-testid="reader-paragraph"]')
  await win.waitForTimeout(1200)                     // 처음 저장이 끝난 뒤

  // ── 1. 문단을 누른 **직후** 창을 닫는다(사용자가 창의 닫기 단추를 누른 것과 같은 길) ────────────
  await win.locator('[data-index="30"]').click()
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
  await app.waitForEvent('close', { timeout: 15000 }).catch(() => {})
  app = null
  const rec = bookOnDisk()
  ok(!!rec && rec.position === 30, '★문단을 누른 직후 창을 닫아도 읽던 자리가 파일에 남는다', { position: rec?.position })

  // ── 2. 다시 켜면 그 자리다 ───────────────────────────────────────────────────────────────────
  app = await launch()
  win = await app.firstWindow(); win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)
  await win.getByTestId('mode-reader').click()
  await win.waitForFunction(() => window.__readerStore?.getState().books.length === 1)
  const pos = await win.evaluate(() => window.__readerStore.getState().books[0].position)
  ok(pos === 30, '★다시 켜면 읽던 자리가 복원된다', { pos })

  // ── 3. 서재 보기를 바꾼 직후 창을 닫는다 ─────────────────────────────────────────────────────
  await win.getByTestId('reader-library').click().catch(() => {})
  await win.getByTestId('reader-view-list').click()
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
  await app.waitForEvent('close', { timeout: 15000 }).catch(() => {})
  app = null
  const prefs = prefsOnDisk()
  ok(prefs && prefs.shelfView === 'list', '★서재 보기를 바꾼 직후 창을 닫아도 설정 파일에 남는다', prefs)

  app = await launch()
  win = await app.firstWindow(); win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)
  await win.getByTestId('mode-reader').click()
  await win.getByTestId('reader-library').click().catch(() => {})
  await win.waitForSelector('[data-testid="reader-view-list"]')
  ok(await win.getByTestId('reader-view-list').getAttribute('aria-pressed') === 'true', '★다시 켜면 그 서재 보기다')

  // ── 4. 저장 실패 — 성공으로 두지 않는다: 짧은 상태 한 줄 + 다시 저장 ──────────────────────────────
  //   본체의 쓰기 통로를 **검사용 프로세스에서** 잠시 거절로 바꾼다(실패를 일으키는 수단일 뿐 — 저장이 되었다는 증거는 실제 파일로 본다).
  await win.getByTestId('reader-view-list').click()           // 설정 저장이 끝나게 둔다
  await win.waitForTimeout(500)
  await win.locator('[data-testid="reader-library-book"]').first().click()
  await win.waitForSelector('[data-index="12"]')
  await app.evaluate(({ ipcMain }) => {
    const m = ipcMain._invokeHandlers
    globalThis.__origWrite = m.get('works:write')
    m.set('works:write', () => ({ ok: false, why: 'TEST_FAIL' }))
  })
  await win.locator('[data-index="12"]').click()
  await win.waitForSelector('[data-testid="reader-save-status"]', { timeout: 8000 }).catch(() => {})
  const statusText = await win.getByTestId('reader-save-status').textContent().catch(() => '')
  ok(/읽던 자리/.test(statusText || '') && !/설정/.test(statusText || ''), '★저장이 실패하면 짧은 상태가 보인다(성공으로 두지 않는다)', statusText)
  ok(bookOnDisk()?.position !== 12, '실패한 동안은 파일이 바뀌지 않았다', bookOnDisk()?.position)
  await app.evaluate(({ ipcMain }) => { ipcMain._invokeHandlers.set('works:write', globalThis.__origWrite) })
  await win.getByTestId('reader-save-retry').click()
  await win.waitForSelector('[data-testid="reader-save-status"]', { state: 'detached', timeout: 8000 }).catch(() => {})
  ok(bookOnDisk()?.position === 12 && (await win.getByTestId('reader-save-status').count()) === 0, '★다시 저장을 누르면 실제 파일에 남고 상태가 사라진다', { position: bookOnDisk()?.position })
} catch (e) {
  fails.push('예외: ' + (e?.message || e)); console.log('FAIL 예외', e?.message || e)
} finally {
  if (app) { try { await app.close() } catch { /* 이미 닫혔다 */ } }
  cleanupUserData(UD); cleanupIsolated(ISO)
}
console.log(`RESULT ${passed + fails.length} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
