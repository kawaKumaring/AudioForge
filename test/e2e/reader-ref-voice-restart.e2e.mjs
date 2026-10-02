// 낭독 — 구간을 잘라 쓴 **내 목소리**가 앱을 다시 켜도 살아 있는가(2026-10-03 관리자 검수).
// ★결함(코드에서 발견): 준비가 자른 조각은 임시 자리(userData/refclips/audioforge_refclip_*)에 있는데, 그 경로를 고른 목소리로 저장했다.
//   앱은 켤 때·끌 때 그 임시 자리를 전부 치운다 → 다시 켜면 '내 목소리 파일을 찾지 못했습니다'.
// 실제 앱 · 실제 준비(분석·구간 자르기) · 실제 창 닫기/다시 켜기. 목소리는 저장소의 검사용 말소리(test/fixtures, 사용자 승인 자산) 사본.
// GPU 없음(합성하지 않는다). 실행: node test/e2e/reader-ref-voice-restart.e2e.mjs   (사전: npm run build)
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { _electron as electron } from 'playwright'
import { isolatedUserData, cleanupUserData, cleanupIsolated, enterStudio } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const UD = isolatedUserData()
const ISO = path.join(os.tmpdir(), 'audioforge_e2e_' + randomUUID())
fs.mkdirSync(path.join(ISO, '목소리'), { recursive: true })
const BOOK = path.join(ISO, '목소리 검사 책.txt')
fs.writeFileSync(BOOK, Array.from({ length: 6 }, (_, i) => `목소리 검사 ${i + 1}번째 문단입니다.`).join('\n'), 'utf-8')
const LONG = path.join(ISO, '목소리', '긴 참조.wav')
const SHORT = path.join(ISO, '목소리', '짧은 참조.wav')
fs.copyFileSync(path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav'), LONG)
fs.copyFileSync(path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav'), SHORT)

let passed = 0
const fails = []
const ok = (v, label, extra) => { if (v) { passed++; console.log('PASS', label) } else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) } }
let app = null
const launch = async () => {
  app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, AF_E2E_SELECT_FILE: BOOK } })
  const win = await app.firstWindow(); win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore); await enterStudio(win)
  await win.getByTestId('mode-reader').click()
  await win.waitForFunction(() => !!window.__readerStore)
  return win
}
const closeWindow = async () => { await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() }); await app.waitForEvent('close', { timeout: 20000 }).catch(() => {}); app = null }
const pickPath = (win) => win.evaluate(() => { const p = window.__readerStore.getState().pick; return p ? { kind: p.kind, path: String(p.path), label: p.label } : null })
const tempClips = () => { const d = path.join(UD, 'refclips'); return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.startsWith('audioforge_refclip_')) : [] }
const chooseFile = async (win, file) => {
  await win.evaluate((p) => window.api.audio.e2eSetSelectFile(p), file)
  await win.getByTestId('reader-voice').click()
  await win.getByRole('dialog', { name: '낭독자 고르기' }).waitFor()
  await win.getByTestId('voice-source-reference').click()
  await win.getByTestId('reader-voice-file').click()
  const name = path.basename(file)
  return win.waitForFunction((n) => (window.__readerStore.getState().pick?.label || '').includes(n), name, { timeout: 120000 }).then(() => true).catch(() => false)
}

try {
  let win = await launch()
  await win.getByTestId('reader-add-text').first().click()
  await win.waitForSelector('[data-testid="reader-paragraph"]')

  // ── 1. 긴 파일 → 구간을 잘라 쓴다(실제 준비) ─────────────────────────────
  ok(await chooseFile(win, LONG), '준비: 긴 목소리 파일을 고르면 준비를 거쳐 바뀐다')
  const p1 = await pickPath(win)
  ok(!!p1 && p1.kind === 'reference' && p1.path !== LONG && fs.existsSync(p1.path), '준비: 원본이 아니라 잘라 둔 조각을 쓴다(지금은 있다)', p1)

  // ── 2. 창 닫기 → 다시 켜기 ────────────────────────────────────────────────
  await closeWindow()
  win = await launch()
  await win.waitForFunction(() => !!window.__readerStore.getState().pick, null, { timeout: 30000 }).catch(() => {})
  await win.waitForTimeout(1500)
  const p2 = await pickPath(win)
  ok(p2?.kind === 'reference' && p2.path === p1.path, '다시 켜도 고른 내 목소리가 그대로 골라져 있다', { p1: p1?.path && path.basename(p1.path), p2: p2?.path && path.basename(p2.path) })
  ok(!!p2 && fs.existsSync(p2.path), '★다시 켜도 고른 목소리의 소리 파일이 남아 있다', p2 && path.relative(UD, p2.path))
  ok(await win.getByTestId('reader-voice-missing').count() === 0, '★다시 켜도 \'내 목소리 파일을 찾지 못했습니다\' 가 뜨지 않는다')
  ok(!(await win.getByTestId('reader-play').isDisabled()), '다시 켜도 낭독을 시작할 수 있다')
  ok(!!p2 && path.relative(path.join(UD, 'refclips'), p2.path).startsWith('..'), '★고른 목소리는 임시 조각 자리(refclips)를 가리키지 않는다', p2 && path.relative(UD, p2.path))
  ok(tempClips().length === 0, '★임시 조각 청소는 그대로 돈다(켤 때 이전 실행의 임시 조각을 치움)', tempClips())
  // 최근 목소리 칩도 같은 파일 — 눌러서 곧바로 쓸 수 있다
  await win.getByTestId('reader-voice').click()
  await win.getByRole('dialog', { name: '낭독자 고르기' }).waitFor()
  await win.getByTestId('voice-source-reference').click()
  const recents = await win.getByTestId('reader-voice-recent').count()
  ok(recents >= 1, '최근 목소리 칩이 남아 있다', recents)
  await win.keyboard.press('Escape')

  // ── 3. 원본 그대로 쓰는 짧은 파일 — 원본 경로를 가리킨다(복사하지 않는다) ──────
  ok(await chooseFile(win, SHORT), '짧은 목소리 파일(3~10초)을 고른다')
  const p3 = await pickPath(win)
  ok(p3?.path === SHORT, '원본을 그대로 쓰는 목소리는 원본 경로 그대로(앱이 복사하지 않는다)', p3 && path.basename(p3.path))
} catch (e) {
  fails.push('예외: ' + String(e?.message || e).split('\n')[0]); console.log('FAIL 예외', String(e?.message || e).split('\n')[0])
} finally {
  if (app) { try { await app.close() } catch { /* 이미 닫혔다 */ } }
  cleanupUserData(UD)
  cleanupIsolated(ISO)
}
console.log(`RESULT ${passed + fails.length} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
