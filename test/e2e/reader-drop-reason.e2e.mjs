// 낭독 서재 — 끌어 놓은 것을 받지 못하면 사유를 띄운다(2026-10-03). 실제 앱 · 화면의 끌어 놓기 처리기.
// ★OS 끌기(탐색기 → 창)는 만들 수 없다 — 이 검사는 **받는 쪽**만 본다: 빈 끌기 → 사유, 파일 끌기 → 그대로 책 한 권.
//   폴더 위치 꺼내기(getPathForFile · webkitGetAsEntry)는 OS 끌기에서만 생긴다 — 여기서 확인하지 않는다.
// 사용자 자료 없음(검사가 만든 글 한 줄). 실행: node test/e2e/reader-drop-reason.e2e.mjs   (사전: npm run build)
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
const ok = (v, label, extra) => { if (v) { passed++; console.log('PASS', label) } else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) } }
let app = null
try {
  app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD } })
  const win = await app.firstWindow(); win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore); await enterStudio(win)
  await win.getByTestId('mode-reader').click()
  await win.waitForFunction(() => !!window.__readerStore)
  const drop = (files) => win.getByTestId('reader-library-dialog').evaluate((el, files) => {
    const dt = new DataTransfer()
    for (const f of files) dt.items.add(new File([f.text], f.name, { type: 'text/plain' }))
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  }, files)
  const alertText = () => win.locator('[data-testid=reader-library-dialog] [role=alert]').innerText().catch(() => '')

  await drop([])
  await win.waitForTimeout(300)
  const t1 = await alertText()
  ok(/파일이나 폴더를 찾지 못했습니다/.test(t1), '★빈 끌기(글 조각·링크 등) → 조용히 무시하지 않고 사유를 띄운다', t1)
  ok(await win.evaluate(() => window.__readerStore.getState().books.length) === 0, '빈 끌기로 책이 생기지 않는다')

  await drop([{ name: '끌기 시험.txt', text: '첫 문단입니다.\n둘째 문단입니다.' }])
  await win.waitForFunction(() => window.__readerStore.getState().books.length === 1, null, { timeout: 10000 })
  ok(await win.evaluate(() => window.__readerStore.getState().books[0].name) === '끌기 시험', '파일 끌기는 그대로 책 한 권(받는 길 회귀 없음)')
  ok(!(await alertText()), '정상으로 받으면 앞의 사유가 지워진다', await alertText())
} catch (e) {
  fails.push('예외: ' + String(e?.message || e).split('\n')[0]); console.log('FAIL 예외', String(e?.message || e).split('\n')[0])
} finally {
  if (app) { try { await app.close() } catch { /* 이미 닫혔다 */ } }
  cleanupUserData(UD)
}
console.log(`RESULT ${passed + fails.length} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
