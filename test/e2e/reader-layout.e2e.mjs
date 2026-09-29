// 낭독 화면 — **긴 책**에서 따라가기·고정된 작동 막대·글자 크기·서재 팝업.
//
// ★왜 생겼나 (2026-09-30 사용 피드백)
//   "따라가기가 작동을 안 되는 경우가 많다" · "하단의 실행 버튼이 휠에 영향을 받아서 움직인다" ·
//   "텍스트 크기가 크다 — 옵션에서 조절" · "텍스트를 불러올 때마다 화면이 가득 찬다 — 서재 팝업".
//   예전 검사(`reader-aloud.e2e.mjs`)는 문단 셋짜리 책이라 모든 글이 한 화면에 들어왔다 —
//   "읽는 구절이 화면 안에 있다" 가 **늘 참**이었다. 여기서는 60문단으로 화면 밖을 만든다.
//
// 실행: node test/e2e/reader-layout.e2e.mjs   (사전: npm run build. GPU 불필요, 실제 piper)
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
const BOOK_PATH = path.join(ISO, '긴 책.txt')
fs.mkdirSync(ISO, { recursive: true })
// 문단 60개 — 문단마다 번호를 넣어 어디를 읽는지 알 수 있게 한다.
fs.writeFileSync(BOOK_PATH, Array.from({ length: 60 }, (_, i) =>
  `${i + 1}번째 문단이다. 그는 천천히 문을 열고 어두운 복도를 내다보았다. 멀리서 물이 떨어지는 소리만 이어졌다.`).join('\n'), 'utf-8')

let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}
const launch = (extra = {}) => electron.launch({
  args: ['out/main/index.js'], cwd: APP,
  env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, HF_HUB_OFFLINE: '1', ...extra },
})
const settingsJson = () => { try { return JSON.parse(fs.readFileSync(path.join(UD, 'settings.json'), 'utf-8')) } catch { return {} } }
/** 구절이 본문 칸 안에 보이는가 · 페이지와 아래 막대의 자리. */
const where = (win) => win.evaluate(() => {
  const box = document.querySelector('[data-testid="reader-body"]')
  const mark = document.querySelector('[data-testid="reader-phrase"]')
  const bar = document.querySelector('[data-testid="reader-controls"]')
  const main = document.querySelector('[data-testid="workspace-content"]')
  const b = box?.getBoundingClientRect(), m = mark?.getBoundingClientRect(), f = bar?.getBoundingClientRect()
  return {
    phraseInBox: !!(b && m) && m.bottom > b.top && m.top < b.bottom,
    boxTop: box?.scrollTop ?? -1, pageTop: main?.scrollTop ?? -1,
    barTop: f ? Math.round(f.top) : -1, barVisible: !!f && f.bottom <= window.innerHeight + 1 && f.top >= 0,
    phraseText: (mark?.textContent || '').slice(0, 12),
  }
})

let app = null
try {
  app = await launch({ AF_E2E_SELECT_FILE: BOOK_PATH })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)
  const listed = await win.evaluate(() => window.api.cards.builtinVoices())
  if (!(listed?.data?.voices || []).length) {
    console.log('SKIP 이 환경에는 쓸 수 있는 기본 목소리가 없습니다')
    await app.close(); cleanupUserData(UD); cleanupIsolated(ISO); process.exit(0)
  }
  await win.getByTestId('mode-reader').click()
  await win.getByTestId('reader-add-text').click()
  await win.waitForSelector('[data-testid="reader-paragraph"]')
  ok(await win.getByTestId('reader-paragraph').count() === 60, '긴 책이 펼쳐진다')

  // ── 서재 팝업 · 본문이 전체 폭 ─────────────────────────────────────────
  ok(await win.locator('aside[aria-label="책 목록"]').count() === 0, '★책 목록이 본문 옆 칸을 차지하지 않는다')
  await win.getByTestId('reader-library').click()
  await win.getByRole('dialog', { name: '서재' }).waitFor()
  ok(await win.getByTestId('reader-library-book').count() === 1, '★서재 팝업에 불러온 책이 모인다')
  await win.keyboard.press('Escape')
  ok(await win.getByRole('dialog', { name: '서재' }).count() === 0, 'Esc 로 닫힌다')

  // ── 글자 크기 ─────────────────────────────────────────────────────────
  const fs0 = await win.getByTestId('reader-paragraph').first().evaluate((e) => getComputedStyle(e).fontSize)
  ok(fs0 === '16px', '★처음 글자 크기는 16 — 예전 19 는 크다는 지시', fs0)
  await win.getByTestId('reader-settings').click()
  await win.getByRole('dialog', { name: '낭독 설정' }).waitFor()
  await win.getByTestId('reader-font-size').fill('20')
  await win.keyboard.press('Escape')
  await win.waitForTimeout(500)
  const fs1 = await win.getByTestId('reader-paragraph').first().evaluate((e) => getComputedStyle(e).fontSize)
  ok(fs1 === '20px', '설정에서 글자 크기를 바꾼다', fs1)
  ok(settingsJson().readerPrefs?.fontSize === 20, '바꾼 크기가 설정 파일에 남는다', settingsJson().readerPrefs)

  // ── 휠로 본문을 굴려도 아래 막대·페이지가 움직이지 않는다 ─────────────
  const before = await where(win)
  const box = await win.getByTestId('reader-body').boundingBox()
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 30; i++) await win.mouse.wheel(0, 600)       // 본문 끝을 한참 지나도록
  await win.waitForTimeout(400)
  const afterWheel = await where(win)
  ok(afterWheel.boxTop > before.boxTop, '본문은 휠로 굴러간다', { before: before.boxTop, after: afterWheel.boxTop })
  ok(afterWheel.pageTop === before.pageTop, '★본문 끝을 지나도 바깥 페이지는 움직이지 않는다', { before: before.pageTop, after: afterWheel.pageTop })
  ok(afterWheel.barTop === before.barTop && afterWheel.barVisible, '★작동 막대가 제자리에 보인다', { before, afterWheel })

  // ── 따라가기 — 먼 자리에서 시작해도 구절을 데려온다 ─────────────────────
  // 40번째 문단을 시작 자리로 고르고, 본문 칸을 맨 위로 되돌린 뒤 읽는다.
  await win.getByTestId('reader-paragraph').nth(39).click()
  await win.evaluate(() => { document.querySelector('[data-testid="reader-body"]').scrollTop = 0 })
  await win.waitForTimeout(200)
  const away = await where(win)
  await win.getByTestId('reader-play').click()
  await win.waitForSelector('[data-testid="reader-phrase"]', { timeout: 60000 })
  const cameBack = await win.waitForFunction(() => {
    const b = document.querySelector('[data-testid="reader-body"]')?.getBoundingClientRect()
    const m = document.querySelector('[data-testid="reader-phrase"]')?.getBoundingClientRect()
    return !!(b && m) && m.bottom > b.top && m.top < b.bottom
  }, null, { timeout: 5000 }).then(() => true).catch(() => false)
  const onStart = await where(win)
  ok(cameBack, '★먼 자리에서 읽기 시작하면 따라가서 구절을 보인다', { away, onStart })
  ok(/^40번째/.test(onStart.phraseText), '고른 자리부터 읽는다', onStart.phraseText)
  ok(onStart.pageTop === away.pageTop && onStart.barVisible, '★따라가도 바깥 페이지·작동 막대는 그대로다', { away, onStart })

  // 읽는 도중 본문을 다른 곳으로 굴려 두면, 다음 덩이로 넘어갈 때 다시 데려온다.
  const firstAt = onStart.phraseText
  await win.evaluate(() => { document.querySelector('[data-testid="reader-body"]').scrollTop = 0 })
  const next = await win.waitForFunction((t) => {
    const m = document.querySelector('[data-testid="reader-phrase"]')
    return !!m && !(m.textContent || '').startsWith(t)
  }, firstAt, { timeout: 90000 }).then(() => true).catch(() => false)
  await win.waitForTimeout(1200)                                  // 부드럽게 굴러오는 시간
  const onNext = await where(win)
  ok(next, '다음 덩이로 넘어간다', onNext.phraseText)
  ok(onNext.phraseInBox, '★덩이가 넘어가면 다시 따라간다 — 사용자가 굴려 둔 뒤에도', onNext)
  await win.getByTestId('reader-play').click()

  // 따라가기를 끄면 그대로 둔다
  await win.getByTestId('reader-follow').click()
  ok(await win.getByTestId('reader-follow').getAttribute('aria-pressed') === 'false', '따라가기를 끌 수 있다')
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
