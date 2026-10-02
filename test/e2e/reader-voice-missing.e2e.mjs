// 낭독 — 이미 고른 기본 목소리를 **조용히 다른 목소리로 바꾸지 않는다**. 누락은 상태로 남기고, 조회 실패는 삭제로 보지 않는다.
// 왜(2026-10-02 관리자 검수 · 실제 앱 재현): 골라 둔 기본 목소리가 목록에 없으면 화면이 열릴 때 첫 기본 목소리(Supertonic 여성 1)로 조용히 바꿨다.
//   목소리 조회가 일부만 실패해도(런타임 불러오기 실패 등) 같은 일이 났다.
// 실제 화면 · 실제 목소리 조회(파이썬). 조회 실패/부분 실패는 본체의 조회 통로를 **검사용 프로세스에서 잠시 바꿔** 만든다.
// 사용자 책은 쓰지 않는다 — 검사용 TXT. GPU 없음.
// 실행: node test/e2e/reader-voice-missing.e2e.mjs     (사전: npm run build)
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
fs.mkdirSync(ISO, { recursive: true })
const BOOK = path.join(ISO, '목소리 검사 책.txt')
fs.writeFileSync(BOOK, Array.from({ length: 10 }, (_, i) => `목소리 검사 ${i + 1}번째 문단입니다.`).join('\n'), 'utf-8')
let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}

let app = null
try {
  app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, AF_E2E_SELECT_FILE: BOOK } })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)
  await enterStudio(win)        // 시작 화면의 '작업실 시작'(2026-10-03)
  await win.getByTestId('mode-reader').click()
  await win.getByTestId('reader-add-text').first().click()
  await win.waitForSelector('[data-testid="reader-paragraph"]')
  const pick = () => win.evaluate(() => { const p = window.__readerStore.getState().pick; return p ? { label: p.label, path: String(p.path), engineId: p.engineId } : null })
  const remount = async () => { await win.getByTestId('mode-music').click(); await win.waitForTimeout(300); await win.getByTestId('mode-reader').click(); await win.waitForTimeout(1500) }
  const playDisabled = () => win.getByTestId('reader-play').isDisabled()

  // ── 1. 처음 쓰는 사람 — 첫 기본 목소리가 기본값으로 정해진다(유지) ─────────────────────────────
  await win.waitForFunction(() => !!window.__readerStore.getState().pick)
  const first = await pick()
  ok(!!first && first.path.length > 0, '처음 쓰는 사람은 첫 기본 목소리가 기본값으로 정해진다', first)
  const voices = (await win.evaluate(() => window.api.cards.builtinVoices()))?.data?.voices || []
  ok(voices.length >= 2, '검사 준비: 기본 목소리가 둘 이상 있다', voices.length)

  // ── 2. 고른 목소리가 목록에서 사라졌다 — 바꾸지 않고 상태를 보인다 ─────────────────────────────
  await win.evaluate(() => window.__readerStore.setState({ pick: { kind: 'builtin', path: 'X:/없는/자리/voice.json', engineId: 'qwen-custom', label: 'Qwen 사라진 목소리' }, voice: 'Qwen 사라진 목소리' }))
  await remount()
  const gone = await pick()
  ok(gone?.label === 'Qwen 사라진 목소리' && gone.path === 'X:/없는/자리/voice.json', '★고른 목소리가 목록에서 빠져도 다른 목소리로 바꾸지 않는다', gone)
  ok(await win.getByTestId('reader-voice-missing').count() === 1, '★누락 상태가 짧은 한 줄로 보인다')
  ok(await playDisabled(), '누락 상태에서는 낭독 시작이 막힌다(없는 목소리로 읽지 않는다)')
  ok(!/Qwen 사라진/.test(await win.getByTestId('reader-voice').innerText()) , '목소리 단추는 이름 대신 다시 고르라고 알린다')

  // ── 3. 사용자가 다른 목소리를 고른다 ───────────────────────────────────────────────────────
  await win.getByTestId('reader-voice-pick-other').click()
  await win.getByRole('dialog', { name: '낭독자 고르기' }).waitFor()
  const chip = win.getByTestId('reader-voice-builtin').first()
  const chosenLabel = await chip.getAttribute('aria-label')
  await chip.click()
  await win.getByTestId('reader-voice-confirm').click()
  await win.waitForTimeout(500)
  const chosen = await pick()
  ok(chosen?.label === chosenLabel && await win.getByTestId('reader-voice-missing').count() === 0, '★사용자가 고른 목소리로 바뀌고 누락 줄이 사라진다', { chosen, chosenLabel })
  ok(!(await playDisabled()), '다른 목소리를 고르면 낭독을 시작할 수 있다')

  // ── 4. 조회 자체가 실패했다 — 삭제로 보지 않고 고른 목소리를 그대로 둔다 ───────────────────────────
  await win.evaluate(() => window.__readerStore.setState({ pick: { kind: 'builtin', path: 'X:/없는/자리/voice.json', engineId: 'qwen-custom', label: 'Qwen 사라진 목소리' }, voice: 'Qwen 사라진 목소리' }))
  await app.evaluate(({ ipcMain }) => {
    const m = ipcMain._invokeHandlers
    globalThis.__origVoices = m.get('card:builtin-voices')
    m.set('card:builtin-voices', () => ({ error: '파이썬이 응답하지 않습니다' }))
  })
  await remount()
  const failedPick = await pick()
  ok(failedPick?.label === 'Qwen 사라진 목소리', '★목소리 조회가 실패해도 고른 목소리를 바꾸지 않는다', failedPick)
  ok(await win.getByTestId('reader-voice-lookup-failed').count() === 1 && await win.getByTestId('reader-voice-missing').count() === 0,
    '★조회 실패는 \'사라졌다\' 가 아니라 \'확인하지 못했다\' 로 보인다(다시 확인 단추)')
  await app.evaluate(({ ipcMain }) => { ipcMain._invokeHandlers.set('card:builtin-voices', globalThis.__origVoices) })
  await win.getByTestId('reader-voice-recheck').click()
  await win.waitForTimeout(1500)
  ok(await win.getByTestId('reader-voice-lookup-failed').count() === 0 && (await pick())?.label === 'Qwen 사라진 목소리' && await win.getByTestId('reader-voice-missing').count() === 1,
    '다시 확인하면 조회 실패 줄이 사라지고, 정말 없는 목소리는 누락으로 남는다(바뀌지 않는다)')

  // ── 5. 일부 엔진만 실패 — 건너뛴 사유를 누락 줄에 보인다 ──────────────────────────────────────
  await app.evaluate(({ ipcMain }) => {
    ipcMain._invokeHandlers.set('card:builtin-voices', async (e, ...a) => {
      const r = await globalThis.__origVoices(e, ...a)
      const voices = (r?.data?.voices || []).filter((v) => v.engineId !== 'qwen-custom')
      return { data: { voices, skipped: [...(r?.data?.skipped || []), { engineId: 'qwen-custom', why: 'Qwen 격리 환경이 없습니다' }] } }
    })
  })
  await remount()
  const reason = await win.getByTestId('reader-voice-missing').innerText().catch(() => '')
  ok(/Qwen 격리 환경이 없습니다/.test(reason) && (await pick())?.engineId === 'qwen-custom', '★일부 엔진만 못 불러온 경우 사유를 보이고 고른 목소리는 그대로다', reason)
  await app.evaluate(({ ipcMain }) => { ipcMain._invokeHandlers.set('card:builtin-voices', globalThis.__origVoices) })
} catch (e) {
  fails.push('예외: ' + (e?.message || e)); console.log('FAIL 예외', String(e?.message || e).split('\n')[0])
} finally {
  if (app) { try { await app.close() } catch { /* 이미 닫혔다 */ } }
  cleanupUserData(UD); cleanupIsolated(ISO)
}
console.log(`RESULT ${passed + fails.length} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
