// 인물 목소리가 없어 막혔을 때 **화면이 무엇을 보여 주는가**.
//
// 실사용 보고(2026-09-16): 화면에 'SPEAKER_NOT_REGISTERED' 가 그대로 떴다.
// 파이썬의 SpeakerReferenceError 는 message 없이 던져 **코드가 곧 문구**가 되는데,
// 화면은 사람 말 안내를 '취소 실패' 갈래 안에서만 쓰고 있어 일반 오류에서는 코드가 새어 나왔다.
// 소스 문자열 검사는 이걸 못 잡았다(문구가 있기는 했다 — 닿지 않았을 뿐이다). 그래서 화면을 본다.
//
// 실행: node test/e2e/speaker-block-notice.e2e.mjs   (사전: npm run build. GPU 불필요)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedInput, cleanupIsolated, isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const FIXTURE = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')
if (!fs.existsSync(FIXTURE)) { console.error('fixture 없음'); process.exit(2) }
const { dir: ISO, input: SRC } = isolatedInput(FIXTURE)
const UD = isolatedUserData()

let failed = 0
const log = (...a) => console.log('[spk]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let app = null
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.__afStore, undefined, { timeout: 30000 })
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.setState({ mode: 'tts', synthesisTab: 'advanced' })
  }, SRC)
  await sleep(1200)

  // 파이썬이 막은 그대로를 재현한다 — message 가 코드와 같다(SpeakerReferenceError 의 실제 모양).
  const push = (code) => win.evaluate((c) => {
    window.__afStore.setState({ status: 'error', error: c, errorInfo: { code: c } })
  }, code)

  for (const code of ['SPEAKER_NOT_REGISTERED', 'SPEAKER_REFERENCE_NOT_READY']) {
    await push(code)
    await sleep(700)
    const card = await win.evaluate(() => {
      const el = document.querySelector('[role="alert"]')
      return el ? el.textContent || '' : ''
    })
    ok(card.length > 0, `${code} — 오류 안내가 뜬다`)
    ok(!card.includes(code), `${code} — **내부 코드를 화면에 내지 않는다**`, `"${card.slice(0, 40)}…"`)
    ok(card.includes('인물 카드'), `${code} — 어디를 고쳐야 하는지 말한다`)
    ok(!card.includes('다시 시도'),
      `${code} — 목소리를 지정하기 전에는 "다시 시도" 라고 권하지 않는다`)
  }

  // 화자와 무관한 오류는 예전 그대로다(이 수정이 다른 안내를 덮지 않았다).
  await win.evaluate(() => {
    window.__afStore.setState({
      status: 'error', error: '알 수 없는 오류가 발생했습니다.', errorInfo: { code: 'SOMETHING_ELSE' },
    })
  })
  await sleep(700)
  const other = await win.evaluate(() => document.querySelector('[role="alert"]')?.textContent || '')
  ok(other.includes('알 수 없는 오류가 발생했습니다.'), '다른 오류의 안내는 그대로다')
  ok(other.includes('다시 시도'), '다른 오류에는 "다시 시도" 가 그대로 있다')
} catch (e) {
  failed++
  log('FAIL 예외:', e && e.message)
} finally {
  if (app) await app.close().catch(() => {})
  cleanupUserData(UD)
  cleanupIsolated(ISO)
}

log(failed === 0 ? '전부 통과 — 인물 차단 안내가 화면에 사람 말로 나온다.' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
