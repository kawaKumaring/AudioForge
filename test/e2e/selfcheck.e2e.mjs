// 기능 검사 탭 — 기능별로 눌러 **그 기능만** 확인하고, 통과는 초록 · 문제는 붉은 표시.
//
// ★지시 (2026-09-30): "검사 기능을 각각 분리해서 따로 검사할 수 있게, 설정에서 기능 검사 탭을 따로 만든 뒤
//   각 기능별 검사 버튼 … 문제가 없을 때 색상, 문제가 있을 시 붉은색의 아이콘." 진단 묶음도 이 안으로.
//
// 여기서 보는 것
//   1) 설정에 [일반] [기능 검사] 탭 — 기능 검사 탭에 기능별 줄과 단추가 있다(전체 한 번에 돌리기는 없다)
//   2) 눌러 보면 **실제로** 돌고 초록이 된다 — 파이썬 · ffmpeg · 모델 파일 · 낭독 기본 목소리 · 설정 · 동작 기록
//   3) 문제가 있으면 **붉은 표시와 이유**가 뜬다(검사 전용 길로 일부러 실패시킨다)
//   4) 문제 보고용 복사 — 결과와 동작 기록을 한 번에(안 돌린 검사는 '안 돌림')
//   5) 결과가 동작 기록과 진단 묶음에 실린다
//   ★참조 목소리 검사는 GPU 로 1분 안팎이라 여기서는 돌리지 않는다(AF_E2E_GPU=1 이면 돌린다).
//
// 실행: node test/e2e/selfcheck.e2e.mjs   (사전: npm run build)
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
const DIAG = path.join(os.tmpdir(), 'audioforge_e2e_' + randomUUID())
fs.mkdirSync(DIAG, { recursive: true })
let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}
const launch = (extra = {}) => electron.launch({
  args: ['out/main/index.js'], cwd: APP,
  env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, AF_E2E_DIAG_DIR: DIAG, HF_HUB_OFFLINE: '1', ...extra },
})
const openChecks = async (win) => {
  await win.getByTestId('open-app-options').click()
  await win.getByTestId('app-options').waitFor()
  await win.getByTestId('options-tab-checks').click()
  await win.getByTestId('options-checks').waitFor()
}
const stateOf = (win, id) => win.getByTestId(`check-${id}`).getAttribute('data-state')
const runAndWait = async (win, id, timeout = 120000) => {
  await win.getByTestId(`check-run-${id}`).click()
  await win.waitForFunction((x) => {
    const s = document.querySelector(`[data-testid="check-${x}"]`)?.getAttribute('data-state')
    return s === 'ok' || s === 'fail'
  }, id, { timeout })
  return { state: await stateOf(win, id), note: await win.getByTestId(`check-note-${id}`).innerText() }
}
const logText = () => fs.readdirSync(path.join(UD, 'logs')).map((n) => fs.readFileSync(path.join(UD, 'logs', n), 'utf-8')).join('')

let app = null
try {
  app = await launch({ AF_E2E_SELFCHECK_FAIL: 'ffmpeg' })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)
  await enterStudio(win)        // 시작 화면의 '작업실 시작'(2026-10-03)

  // ── 1. 탭과 줄 ───────────────────────────────────────────────────────
  await openChecks(win)
  const ids = ['python', 'ffmpeg', 'models', 'reader-builtin', 'reader-reference', 'settings', 'log']
  for (const id of ids) ok(await win.getByTestId(`check-${id}`).count() === 1 && await stateOf(win, id) === 'idle', `기능 검사 줄이 있다 — ${id}`)
  ok(/GPU/.test(await win.getByTestId('check-reader-reference').innerText()), '★오래 걸리는 검사는 미리 말한다')
  ok(await win.getByText('전체 검사', { exact: false }).count() === 0, '전체를 한 번에 돌리는 단추는 없다(지시)')

  // ── 2. 실제로 돌려 초록 ─────────────────────────────────────────────
  for (const id of ['python', 'models', 'settings', 'log', 'reader-builtin']) {
    const got = await runAndWait(win, id)
    ok(got.state === 'ok', `★눌러 보면 실제로 돌고 초록이 된다 — ${id}`, got)
    ok(!/[A-Za-z]:[\\/]/.test(got.note), `결과 글에 폴더 경로가 없다 — ${id}`, got.note)
  }
  const settingsFile = JSON.parse(fs.readFileSync(path.join(UD, 'settings.json'), 'utf-8'))
  ok(!('selfCheckProbe' in settingsFile), '설정 검사는 써 본 값을 남기지 않는다')
  const selfDir = path.join(UD, 'readerChunks', 'selfcheck')
  ok(!fs.existsSync(selfDir) || fs.readdirSync(selfDir).length === 0, '낭독 검사는 만든 소리를 남기지 않는다')

  // ── 3. 문제가 있으면 붉은 표시와 이유 ───────────────────────────────
  const bad = await runAndWait(win, 'ffmpeg')
  ok(bad.state === 'fail' && /일부러 실패/.test(bad.note), '★문제가 있으면 붉은 표시와 이유가 뜬다', bad)
  const dotColor = await win.getByTestId('check-ffmpeg').locator('span[aria-label="문제 있음"]').evaluate((e) => getComputedStyle(e).backgroundColor)
  ok(/rgb\(2(4[0-9]|5[0-5]), 1[0-4][0-9], 1[0-9]{2}\)/.test(dotColor), '실패 아이콘은 붉은색이다', dotColor)
  const okColor = await win.getByTestId('check-python').locator('span[aria-label="통과"]').evaluate((e) => getComputedStyle(e).backgroundColor)
  ok(okColor === 'rgb(74, 222, 128)', '통과 아이콘은 초록색이다', okColor)

  // ── 4. 문제 보고용 복사 — 사용자 클립보드는 건드리지 않는다 ─────────
  await app.evaluate(({ clipboard }) => { globalThis.__copied = null; clipboard.writeText = (t) => { globalThis.__copied = String(t) } })
  await win.getByTestId('check-report-copy').click()
  await win.waitForFunction(() => /복사했습니다/.test(document.querySelector('[data-testid="check-report-note"]')?.textContent || ''))
  const copied = await app.evaluate(() => globalThis.__copied) || ''
  ok(/\[기능 검사\]/.test(copied) && /● 파이썬 통과/.test(copied) && /✕ ffmpeg 실패/.test(copied), '★복사한 보고에 검사 결과가 실린다', copied.slice(0, 200))
  ok(/○ 낭독 · 참조 목소리 안 돌림/.test(copied), '안 돌린 검사는 "안 돌림" 으로 적힌다')
  ok(/\[최근 동작 기록 \d+건\]/.test(copied) && /\[check\]/.test(copied), '같은 보고에 동작 기록도 실린다')
  ok(!/[A-Za-z]:[\\/]/.test(copied), '보고 어디에도 폴더 경로가 없다')

  // ── 5. 동작 기록 · 진단 묶음 ────────────────────────────────────────
  ok(/\[check\] 파이썬 통과/.test(logText()) && /\[check\] ffmpeg 실패/.test(logText()), '결과가 동작 기록(로그 파일)에 남는다')
  await win.getByTestId('export-diagnostics').click()
  await win.getByTestId('export-diagnostics-result').waitFor({ timeout: 15000 })
  const bundle = fs.readdirSync(DIAG).find((n) => n.startsWith('AudioForge_진단_'))
  const summary = bundle ? fs.readFileSync(path.join(DIAG, bundle, 'summary.txt'), 'utf-8') : ''
  ok(/\[기능 검사\]/.test(summary) && /● 파이썬 통과/.test(summary) && /✕ ffmpeg 실패/.test(summary), '★진단 묶음에도 검사 결과가 실린다')

  // ── (선택) 참조 목소리 — GPU ────────────────────────────────────────
  if (process.env.AF_E2E_GPU === '1') {
    const ref = await runAndWait(win, 'reader-reference', 300000)
    ok(ref.state === 'ok', '참조 목소리 검사가 통과한다(GPU)', ref)
  } else console.log('SKIP 참조 목소리 검사 — GPU 를 쓴다(AF_E2E_GPU=1 이면 돌린다)')
} catch (e) {
  console.error('FAIL', e?.message || e)
  fails.push(String(e?.message || e))
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
  cleanupIsolated(DIAG)
}
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
