// 낭독 — 글 파일을 **어떤 글자 방식이든** 알아서 읽는가(실제 앱의 불러오기 길).
//
// ★왜 (2026-09-30): UTF-8 이 아니면 "UTF-8로 저장한 뒤 다시 불러오세요" 로 거절했다. 한국어 소설 텍스트는
//   CP949(EUC-KR) 가 흔하고, 메모장의 "유니코드" 저장은 UTF-16 이다. 해독 규칙은 `readerDecode.ts`.
// ★CP949 확장 글자(똠·쀍 같은 것)는 **화면(크로미움)의 해독기**에만 있다 — Node 의 해독기에는 없어서
//   단위 검사로는 못 본다(실측). 그래서 여기서 실제 앱으로 확인한다.
//
// 여기서 보는 것
//   1) CP949 파일(확장 글자 포함)이 문단으로 펼쳐지고 글자가 맞다
//   2) UTF-16(머리표 있음) 파일이 펼쳐진다
//   3) 알아볼 수 없는 파일은 **거절하고 사유를 말한다** — 깨진 글을 펼치지 않는다
//   4) 어떤 방식으로 읽었는지 동작 기록에 남는다(글 내용 없이)
//
// 실행: node test/e2e/reader-encoding.e2e.mjs   (사전: npm run build. GPU 불필요)
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
// CP949: "똠방각하" 의 '똠'(8C 63)은 확장 글자 · "안녕하세요" · 줄바꿈 · "둘째 줄"
const CP949 = path.join(ISO, 'cp949 책.txt')
fs.writeFileSync(CP949, Buffer.from([
  0x8c, 0x63, 0xb9, 0xe6, 0xb0, 0xa2, 0xc7, 0xcf, 0x20, 0xbe, 0xc8, 0xb3, 0xe7, 0xc7, 0xcf, 0xbc, 0xbc, 0xbf, 0xe4, 0x0d, 0x0a,
  0xb5, 0xd1, 0xc2, 0xb0, 0x20, 0xc1, 0xd9,
]))
const UTF16 = path.join(ISO, 'utf16 책.txt')
const U16_TEXT = '첫째 문단이다.\r\n둘째 문단이다.\r\n셋째 문단이다.'
fs.writeFileSync(UTF16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(U16_TEXT, 'utf16le')]))
const BROKEN = path.join(ISO, '깨진 책.txt')
fs.writeFileSync(BROKEN, Buffer.from([0x80, 0xff, 0x00, 0xff, 0x81, 0x0a, 0x80, 0xff]))

let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}
const paragraphs = (win) => win.evaluate(() => [...document.querySelectorAll('[data-testid="reader-paragraph"]')].map((e) => e.textContent || ''))
const logText = () => fs.readdirSync(path.join(UD, 'logs')).map((n) => fs.readFileSync(path.join(UD, 'logs', n), 'utf-8')).join('')

let app = null
try {
  app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, HF_HUB_OFFLINE: '1' } })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)
  await win.getByTestId('mode-reader').click()

  // 서재 팝업을 열어 두고(이미 열려 있으면 그대로) 책 이름들을 읽는다.
  const libraryNames = async () => {
    if (!(await win.getByTestId('reader-library-book').count())) await win.getByTestId('reader-library').click()
    await win.getByTestId('reader-library-book').first().waitFor()
    return await win.evaluate(() => [...document.querySelectorAll('[data-testid="reader-library-book"]')].map((e) => e.textContent || ''))
  }
  const addFromLibrary = async (p) => {
    await win.evaluate((x) => window.api.audio.e2eSetSelectFile(x), p)
    await libraryNames()
    await win.getByRole('button', { name: '＋ 텍스트 추가' }).last().click()
  }

  // ── 1. CP949 ────────────────────────────────────────────────────────
  await win.evaluate((p) => window.api.audio.e2eSetSelectFile(p), CP949)
  await win.getByTestId('reader-add-text').first().click()
  await win.waitForSelector('[data-testid="reader-paragraph"]')
  const cp = await paragraphs(win)
  ok(cp.length === 2 && cp[0].includes('똠방각하 안녕하세요') && cp[1].includes('둘째 줄'), '★CP949 글이 펼쳐지고 확장 글자까지 맞다', cp)

  // ── 2. UTF-16 ───────────────────────────────────────────────────────
  await addFromLibrary(UTF16)
  await win.waitForFunction(() => [...document.querySelectorAll('[data-testid="reader-library-book"]')].some((e) => (e.textContent || '').includes('utf16 책'))
    || document.querySelectorAll('[data-testid="reader-library-book"]').length === 0, null, { timeout: 10000 }).catch(() => {})
  const names = await libraryNames()
  ok(names.some((n) => n.includes('utf16 책')), '★UTF-16 글이 서재에 들어온다', names)
  await win.getByTestId('reader-library-book').filter({ hasText: 'utf16 책' }).first().click()
  await win.waitForFunction(() => [...document.querySelectorAll('[data-testid="reader-paragraph"]')].some((e) => (e.textContent || '').includes('셋째 문단')))
  const u16 = await paragraphs(win)
  ok(u16.length === 3 && u16[0].includes('첫째 문단이다.'), 'UTF-16 글자가 맞다', u16)

  // ── 3. 알아볼 수 없는 파일 ─────────────────────────────────────────
  await addFromLibrary(BROKEN)
  const alert = win.getByRole('alert').filter({ hasText: '깨진 책' })
  await alert.waitFor({ timeout: 10000 }).catch(() => {})
  const said = await alert.innerText().catch(() => '')
  ok(/글자 방식을 알아보지 못했습니다/.test(said), '★알아볼 수 없는 파일은 거절하고 사유를 말한다', said)
  const namesAfter = await libraryNames()
  ok(namesAfter.length === 2 && !namesAfter.some((n) => n.includes('깨진 책')), '깨진 글은 서재에 들어오지 않는다(두 권 그대로)', namesAfter)


  // ── 4. 기록 ─────────────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 500))
  const log = logText()
  ok(/CP949\(EUC-KR\) 로 읽음/.test(log) && /UTF-16LE 로 읽음/.test(log), '어떤 방식으로 읽었는지 동작 기록에 남는다')
  ok(!/똠방각하|첫째 문단이다/.test(log), '기록에 글 내용은 없다')
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
