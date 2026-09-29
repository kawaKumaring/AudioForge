// 큰 책 — **보이는 문단만 그려도** 고르기 · 먼 자리로 가기 · 따라가기가 그대로인가.
//
// ★왜 (2026-09-30 실측, 3만 문단 · 5.5MB): 문단을 전부 그리면 열 때 3.7초, 문단을 누를 때마다 120~170ms 가
//   걸렸다(거의 전부 브라우저의 배치·그리기). 3천 문단을 넘는 책은 보이는 곳 근처만 그린다(`readerWindow.ts`).
//   그리지 않은 문단은 화면에 **없으므로**, 거기로 가야 하는 기능(고른 자리로 가기 · 읽는 구절 따라가기)이
//   조용히 멈출 수 있다 — 그것을 여기서 붙든다. 3천 문단 이하 책은 그대로다(reader-layout 이 60문단 전부를 본다).
//
// 여기서 보는 것
//   1) 큰 책이 빨리 열리고, 그려진 문단은 한 줌이다 · 첫 문단부터 보인다
//   2) 가운데로 굴리면 그 자리 문단이 그려진다(빈칸이 아니다)
//   3) 문단 누름이 빠르다 · 고른 자리로 표시된다
//   4) 맨 위로 굴려 둔 뒤 '다음 문단' — 그리지 않았던 자리로 **데려가서** 보인다
//   5) 그 자리에서 읽으면 읽는 구절이 칸 안에 보이고, 그 문단부터 읽는다(따라가기)
//
// 실행: node test/e2e/reader-bigbook.e2e.mjs   (사전: npm run build. 기본 목소리로 읽는다 — CPU)
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
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
const N = 30000
const BOOK = path.join(ISO, '큰 책.txt')
fs.writeFileSync(BOOK, Array.from({ length: N }, (_, i) =>
  `${i + 1}번째 문단이다. 그는 천천히 문을 열고 어두운 복도를 내다보았다. 멀리서 물이 떨어지는 소리만 일정하게 이어졌다.`).join('\n'), 'utf-8')

let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}
/** 칸 안에 보이는 문단들의 번호(1부터 · 글의 머리에서 읽는다). */
const visible = (win) => win.evaluate(() => {
  const b = document.querySelector('[data-testid="reader-body"]').getBoundingClientRect()
  return [...document.querySelectorAll('[data-testid="reader-paragraph"]')]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.bottom > b.top && r.top < b.bottom })
    .map((e) => Number((e.textContent || '').match(/^(\d+)번째/)?.[1] || -1))
})

let app = null
try {
  app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, AF_E2E_SELECT_FILE: BOOK, HF_HUB_OFFLINE: '1' } })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)
  const listed = await win.evaluate(() => window.api.cards.builtinVoices())
  if (!(listed?.data?.voices || []).length) {
    console.log('SKIP 이 환경에는 쓸 수 있는 기본 목소리가 없습니다')
    await app.close(); cleanupUserData(UD); cleanupIsolated(ISO); process.exit(0)
  }
  await win.getByTestId('mode-reader').click()

  // ── 1. 열기 ─────────────────────────────────────────────────────────
  const t0 = Date.now()
  await win.getByTestId('reader-add-text').first().click()
  await win.waitForSelector('[data-testid="reader-paragraph"]')
  const openMs = Date.now() - t0
  const drawn = await win.getByTestId('reader-paragraph').count()
  ok(await win.getByTestId('reader-body').getAttribute('data-windowed') === '1', '3만 문단 책은 보이는 곳만 그린다')
  ok(drawn > 0 && drawn < 120, '★그려진 문단은 한 줌이다', drawn)
  ok(openMs < 2000, '큰 책이 빨리 열린다(전부 그릴 때 3.7초 실측)', openMs)
  ok((await visible(win))[0] === 1, '첫 문단부터 보인다', await visible(win))

  // ── 2. 가운데로 굴리기 ──────────────────────────────────────────────
  await win.evaluate(() => { const b = document.querySelector('[data-testid="reader-body"]'); b.scrollTop = b.scrollHeight / 2 })
  await win.waitForTimeout(300)
  const mid = await visible(win)
  ok(mid.length > 0 && mid.every((n) => n > N * 0.3 && n < N * 0.7), '★가운데로 굴리면 그 자리 문단이 그려진다(빈칸이 아니다)', mid)

  // ── 3. 누름 ─────────────────────────────────────────────────────────
  const pickedNo = mid[1] ?? mid[0]
  const clickMs = await win.evaluate(async (no) => {
    const el = [...document.querySelectorAll('[data-testid="reader-paragraph"]')].find((e) => (e.textContent || '').startsWith(`${no}번째`))
    const t = performance.now()
    el.click()
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return Math.round(performance.now() - t)
  }, pickedNo)
  ok(clickMs < 100, '★문단 누름이 빠르다(전부 그릴 때 120~170ms 실측)', clickMs)
  const chosen = await win.evaluate(() => (document.querySelector('[aria-current="location"]')?.textContent || '').match(/^(\d+)번째/)?.[1])
  ok(Number(chosen) === pickedNo, '누른 문단이 시작 자리로 표시된다', { chosen, pickedNo })

  // ── 4. 그리지 않은 자리로 데려가기 ──────────────────────────────────
  await win.evaluate(() => { document.querySelector('[data-testid="reader-body"]').scrollTop = 0 })
  await win.waitForTimeout(300)
  ok(!(await visible(win)).includes(pickedNo), '(맨 위로 굴려 두면 고른 문단은 그려지지 않는다)')
  await win.getByRole('button', { name: '다음 문단' }).click()
  const came = await win.waitForFunction((no) => {
    const b = document.querySelector('[data-testid="reader-body"]').getBoundingClientRect()
    const el = document.querySelector('[aria-current="location"]')
    const r = el?.getBoundingClientRect()
    return !!r && (el.textContent || '').startsWith(`${no}번째`) && r.bottom > b.top && r.top < b.bottom
  }, pickedNo + 1, { timeout: 5000 }).then(() => true).catch(() => false)
  ok(came, '★그리지 않았던 자리로 데려가서 고른 문단을 보인다', await visible(win))

  // ── 5. 그 자리에서 읽기 — 따라가기 ──────────────────────────────────
  await win.evaluate(() => { document.querySelector('[data-testid="reader-body"]').scrollTop = 0 })
  await win.waitForTimeout(300)
  await win.getByTestId('reader-play').click()
  await win.waitForSelector('[data-testid="reader-phrase"]', { timeout: 90000 })
  const followed = await win.waitForFunction(() => {
    const b = document.querySelector('[data-testid="reader-body"]').getBoundingClientRect()
    const m = document.querySelector('[data-testid="reader-phrase"]')?.getBoundingClientRect()
    return !!m && m.bottom > b.top && m.top < b.bottom
  }, null, { timeout: 8000 }).then(() => true).catch(() => false)
  const phraseText = await win.evaluate(() => (document.querySelector('[data-testid="reader-phrase"]')?.textContent || '').slice(0, 12))
  ok(followed, '★먼 자리에서 읽기 시작하면 따라가서 구절을 보인다(그리지 않았던 곳)', phraseText)
  ok(phraseText.startsWith(`${pickedNo + 1}번째`), '고른 자리부터 읽는다', { phraseText, want: pickedNo + 1 })
  await win.getByTestId('reader-play').click()
} catch (e) {
  console.error('FAIL', e?.message || e)
  fails.push(String(e?.message || e))
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
  cleanupIsolated(ISO)
}
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
