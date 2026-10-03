import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
// 트랙 편집 — 길이 표시(2026-10-03). 불러오는 중에는 미확정('—'), 준비되면 실제 길이 · 메뉴 왕복 · 파일 교체 뒤 길이·분할점·저장 값이 맞는다.
// 왜: 화면 캡처에 10초 음원이 '0:00 / 0:00' 으로 보였다 — 해독 전의 0 을 그대로 길이로 그렸다(불러오는 중이었다).
// 실제 앱 · 길이를 아는 합성 톤(10초 · 6초) · 사용자 음원 없음. 실행: node test/e2e/split-duration.e2e.mjs   (사전: npm run build)
import fs from 'fs'
import path from 'path'
import { _electron as electron } from 'playwright'
import { isolatedUserData, cleanupUserData, makeSyntheticWav, enterStudio } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const UD = isolatedUserData()
const T10 = makeSyntheticWav(path.join(UD, 'tone10.wav'), 10), T6 = makeSyntheticWav(path.join(UD, 'tone6.wav'), 6, 24000, 330)
let passed = 0
const fails = []
const ok = (v, label, extra) => { if (v) { passed++; console.log('PASS', label) } else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) } }
let app = null
try {
  app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, AF_E2E_SELECT_FILE: T10, AUDIOFORGE_NO_WARMUP: '1' } })
  const win = await app.firstWindow(); win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore); await enterStudio(win)
  await win.getByTestId('mode-split').click()
  // 길이 칸을 불러오는 동안 계속 본다 — 한 번이라도 0:00 이 길이로 보이면 실패
  await win.evaluate(() => {
    window.__seenDur = []
    const tick = () => { const e = document.querySelector('[data-testid=split-duration]'); if (e) window.__seenDur.push([window.__afStore.getState().fileInfo?.path || '', e.textContent]); window.__durTimer = requestAnimationFrame(tick) }
    tick()
  })
  await win.getByTestId('source-open').click()
  await win.waitForFunction(() => document.querySelector('[data-testid=split-duration]')?.textContent === '0:10', null, { timeout: 30000 })
  const seen1 = await win.evaluate(() => [...new Set(window.__seenDur.map((x) => x[1]))])
  ok(!seen1.includes('0:00') && seen1.includes('0:10'), '★불러오는 동안 0:00 을 길이로 보이지 않고, 준비되면 0:10', seen1)
  ok(await win.evaluate(() => Math.round(window.__afStore.getState().fileInfo?.duration ?? -1)) === 10, '저장 값(파일 정보) 길이 10초와 표시가 맞다')

  // 분할점 하나(파형 가운데 두 번 클릭)
  const wave = await win.getByTestId('split-edit-wave').boundingBox()
  await win.mouse.dblclick(wave.x + wave.width / 2, wave.y + wave.height / 2)
  await win.waitForFunction(() => (window.__afStore.getState().splitMarkers || []).length === 1)
  const m = await win.evaluate(() => window.__afStore.getState().splitMarkers[0])
  ok(m > 3 && m < 7, '가운데 분할점은 길이의 절반 근처(3~7초)', m)

  // 메뉴 왕복 — 길이·분할점 그대로
  await win.getByTestId('mode-music').click(); await win.waitForTimeout(300)
  await win.getByTestId('mode-split').click()
  await win.waitForFunction(() => document.querySelector('[data-testid=split-duration]')?.textContent === '0:10', null, { timeout: 30000 })
  ok(await win.evaluate(() => (window.__afStore.getState().splitMarkers || []).length) === 1, '★메뉴를 다녀와도 길이 0:10 · 분할점 그대로')

  // 파일 교체 — 앞 파일의 길이·분할점이 남지 않는다
  await win.evaluate(() => { window.__seenDur = [] })
  await win.evaluate((p) => window.api.audio.e2eSetSelectFile(p), T6)
  await win.getByRole('button', { name: /파일 (변경|바꾸기)|다른 파일/ }).first().click().catch(async () => { await win.getByTestId('source-open').click() })
  await win.waitForFunction(() => document.querySelector('[data-testid=split-duration]')?.textContent === '0:06', null, { timeout: 30000 })
  // 새 파일이 지금 파일이 된 뒤의 칸만 본다 — 그 전(대화상자·파일 정보 읽기 중)에는 앞 파일이 지금 파일이라 0:10 이 맞다.
  const seen2 = await win.evaluate((p6) => { cancelAnimationFrame(window.__durTimer); return [...new Set(window.__seenDur.filter((x) => x[0] === p6).map((x) => x[1]))] }, T6)
  ok(!seen2.includes('0:00') && !seen2.includes('0:10') && seen2.includes('0:06'), '★새 파일이 들어온 뒤에는 앞 파일 길이(0:10)·0:00 을 보이지 않고 0:06', seen2)
  const after = await win.evaluate(() => ({ dur: Math.round(window.__afStore.getState().fileInfo?.duration ?? -1), markers: (window.__afStore.getState().splitMarkers || []).length, err: !!document.querySelector('[data-testid=split-edit-wave]')?.closest('section,div')?.textContent?.includes('파형을 읽지 못했습니다') }))
  ok(after.dur === 6 && after.markers === 0 && !after.err, '★교체 뒤 저장 값 6초 · 앞 파일의 분할점 없음 · 오류 표시 없음', after)
} catch (e) {
  fails.push('예외: ' + String(e?.message || e).split('\n')[0]); console.log('FAIL 예외', String(e?.message || e).split('\n')[0])
} finally {
  if (app) { try { await app.close() } catch { /* 이미 닫혔다 */ } }
  cleanupUserData(UD)
}
console.log(`RESULT ${passed + fails.length} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
