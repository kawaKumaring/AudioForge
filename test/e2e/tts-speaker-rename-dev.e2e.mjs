// 인물 이름 변경 — 개발 앱(격리 userData) 표적 확인 1회. GPU·음성 생성 없음(7.5초 원본 = 구간 없이 통째로 유효, 전사 검증 없음).
// 카드 상세 '이름 바꾸기' → 같은 인물의 모든 발화 표기 + 목소리 슬롯(준비 상태·유효 참조) 이동 / 다른 인물과 충돌 시 거부·무변경 /
// 고급 원문 편집으로 표기를 바꾸면 슬롯은 옮기지 않고 알림만(구분 처리).
import { spawn, execFileSync } from 'child_process'
import { chromium } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isolatedInput, cleanupIsolated } from './_e2e-helper.mjs'

const APP = process.cwd()
const iso = isolatedInput(path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav'))
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'af-rename-'))
const PORT = 9950 + (process.pid % 40)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const ok = (id, pass, what, detail = '') => { results.push({ id, pass: !!pass, what, detail }); console.log(`[rename] ${pass ? 'PASS' : 'FAIL'} ${id} ${what}${detail ? ' — ' + detail : ''}`) }
const child = spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], { cwd: APP, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: USER_DATA, AF_E2E_CDP_PORT: String(PORT) } })
const childLog = []
child.stdout.setEncoding('utf-8'); child.stdout.on('data', (s) => childLog.push(String(s)))
child.stderr.setEncoding('utf-8'); child.stderr.on('data', (s) => childLog.push(String(s)))
let childExited = false
child.on('exit', () => { childExited = true })
const killOwnTree = () => { if (childExited || !child.pid) return; try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* */ } }
async function waitForCdp(ms) { const t0 = Date.now(); for (;;) { if (childExited) return false; try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return true } catch { /* */ } if (Date.now() - t0 > ms) return false; await sleep(500) } }

let browser = null
try {
  ok('boot', await waitForCdp(240000), '개발 앱 기동')
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  let page = null
  for (let i = 0; i < 60 && !page; i += 1) { for (const ctx of browser.contexts()) for (const p of ctx.pages()) { if (await p.evaluate(() => !!window.api).catch(() => false)) { page = p; break } } if (!page) await sleep(500) }
  if (!page) throw new Error('NO_PAGE')
  const pageErrors = []; page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.api?.audio?.process, null, { timeout: 60000 })
  const st = (fn) => page.evaluate(fn)
  const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel)
  const waitUntil = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(200) } return false }
  const store = () => st(() => { const s = window.__afStore.getState(); return { text: s.ttsText, refs: s.ttsSpeakerRefState, labels: s.ttsSpeakerLabels, refReady: s.ttsRefReady, enabled: s.ttsSpeakerEmotionEnabled } })
  const cardVoices = () => st(() => [...document.querySelectorAll('[data-testid="dialogue-row"] [data-testid="card-voice-status"]')].map((b) => b.textContent.trim()))

  await page.evaluate(async (fp) => { const s = window.__afStore; s.getState().setFile(await window.api.audio.getFileInfo(fp), await window.api.audio.getFileUrl(fp)); s.getState().setMode('tts') }, iso.input)
  await page.waitForSelector('[data-testid="dialogue-tabs"]', { timeout: 60000 })
  await waitUntil(async () => (await store()).refReady === true, 60000)
  await page.click('[data-testid="dialogue-tabs"] [data-tab="multi"]'); await sleep(200)
  await waitUntil(async () => (await store()).refs['인물1']?.ready === true, 20000)
  // 두 발화 + 다른 인물 하나
  await page.click('[data-testid="starter-card"] [data-testid="starter-line"]'); await page.fill('[data-testid="starter-card"] [data-testid="starter-line"]', '하나'); await page.keyboard.press('Tab')
  await waitUntil(async () => (await count('[data-testid="dialogue-row"]')) === 1, 15000)
  await page.click('[data-testid="dialogue-add-open"]'); await page.click('[data-testid="dialogue-add-done"]')
  await waitUntil(async () => st(() => document.activeElement?.getAttribute('data-testid') === 'pending-line'), 3000)
  await page.keyboard.type('둘'); await page.keyboard.press('Tab')
  await waitUntil(async () => (await count('[data-testid="dialogue-row"]')) === 2, 15000)
  await page.click('[data-testid="dialogue-add-open"]'); await page.getByLabel('새 인물').check(); await page.fill('[data-testid="dialogue-add-name"]', '지은'); await page.click('[data-testid="dialogue-add-done"]')
  await waitUntil(async () => (await count('[data-testid="starter-card"]')) === 1, 3000)
  await page.click('[data-testid="starter-card"] [data-testid="starter-line"]'); await page.fill('[data-testid="starter-card"] [data-testid="starter-line"]', '셋'); await page.keyboard.press('Tab')
  await waitUntil(async () => (await count('[data-testid="dialogue-row"]')) === 3, 15000)
  const s0 = await store()
  ok('setup', s0.text === '[화자 인물1]\n하나\n[화자 인물1]\n둘\n[화자 지은]\n셋' && s0.refs['인물1']?.ready === true, '인물1 발화 2 + 지은 1, 인물1 준비됨', JSON.stringify({ text: s0.text, refs: Object.keys(s0.refs) }))
  // 감정별 설정 켬 표시(슬롯 이동에 같이 가는지 확인용)
  await st(() => window.__afStore.getState().setSpeakerEmotionEnabled('인물1', true))

  // 1) 이름 바꾸기(카드 머리의 이름 옆) → 모든 발화 표기 + 슬롯 이동
  await page.click('[data-testid="dialogue-row"][data-index="0"] [data-testid="card-rename"]')
  await waitUntil(async () => (await count('[data-testid="speaker-rename"]')) === 1, 3000)
  await page.fill('[data-testid="speaker-rename-input"]', '철수')
  await page.click('[data-testid="speaker-rename-apply"]')
  const renamed = await waitUntil(async () => { const s = await store(); return s.text === '[화자 철수]\n하나\n[화자 철수]\n둘\n[화자 지은]\n셋' }, 10000)
  const s1 = await store()
  const rowsRenamed = await waitUntil(async () => (await st(() => [...document.querySelectorAll('[data-testid="dialogue-row"]')].map((r) => r.getAttribute('data-speaker')))).join(',') === '철수,철수,지은', 10000)
  ok('1', renamed && rowsRenamed && !s1.refs['인물1'] && s1.refs['철수']?.ready === true && s1.refs['철수'].clip === s0.refs['인물1'].clip && s1.labels['철수'] === '철수' && s1.enabled['철수'] === true && (await cardVoices())[0]?.includes('준비됨') && (await cardVoices())[1]?.includes('준비됨'),
    '이름 변경 → 같은 인물의 모든 표기·카드가 철수, 목소리 슬롯(준비·유효 참조)·감정별 설정 이동', JSON.stringify({ text: s1.text, refs: Object.keys(s1.refs), ready: s1.refs['철수']?.ready, enabled: s1.enabled, cards: await cardVoices() }))
  ok('1b', (await count('[data-testid="speaker-rename"]')) === 0 && (await count('[data-testid="speaker-rename-problem"]')) === 0, '성공 시 입력창이 닫힌다')

  // 2) 다른 기존 인물과 충돌 → 거부·무변경(병합 없음)
  await page.click('[data-testid="dialogue-row"][data-index="0"] [data-testid="card-rename"]')
  await waitUntil(async () => (await count('[data-testid="speaker-rename"]')) === 1, 3000)
  await page.fill('[data-testid="speaker-rename-input"]', '지은')
  await page.click('[data-testid="speaker-rename-apply"]')
  await sleep(300)
  const s2 = await store()
  ok('2', (await count('[data-testid="speaker-rename-problem"]')) === 1 && s2.text === s1.text && JSON.stringify(s2.refs) === JSON.stringify(s1.refs),
    '충돌하는 이름은 거부 안내, 원문·슬롯 무변경', (await st(() => document.querySelector('[data-testid="speaker-rename-problem"]')?.textContent)) ?? '')

  // 3) 고급 원문 편집으로 표기를 직접 바꾸는 것은 다른 동작 — 알림만, 슬롯은 옮기지 않는다
  await page.click('[data-testid="direct-edit-toggle"]'); await sleep(150)
  const RAW = 'section[aria-label="인물과 대사"] div[data-af-tts-editor] textarea'
  await page.evaluate(([sel, v]) => { const ta = document.querySelector(sel); Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, v); ta.dispatchEvent(new Event('input', { bubbles: true })) }, [RAW, '[화자 영희]\n하나\n[화자 영희]\n둘\n[화자 지은]\n셋'])
  await sleep(600)
  const s3 = await store()
  ok('3', s3.text.startsWith('[화자 영희]') && s3.refs['철수']?.ready === true && !s3.refs['영희'], '원문 직접 편집은 슬롯을 옮기지 않는다(철수 슬롯 유지, 영희 슬롯 없음) — 카드에서 이름 바꾸기와 구분', JSON.stringify(Object.keys(s3.refs)))
  ok('err', pageErrors.length === 0, 'renderer 오류 0', pageErrors.slice(0, 2).join(' | '))
} catch (e) {
  ok('fatal', false, '치명 오류', String(e?.stack || e))
} finally {
  try { await browser?.close() } catch { /* */ }
  killOwnTree()
  for (let i = 0; i < 40 && !childExited; i += 1) await sleep(250)
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* */ }
  cleanupIsolated(iso.dir)
  const fails = results.filter((r) => !r.pass).length
  console.log(`[rename] SUMMARY pass=${results.length - fails} fail=${fails}`)
  process.exit(fails ? 1 : 0)
}
