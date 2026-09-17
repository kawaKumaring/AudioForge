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
import { createHash } from 'crypto'
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
    ok(card.includes('카드'), `${code} — 어디를 고쳐야 하는지 말한다`)
    ok(!card.includes('다시 시도'),
      `${code} — 목소리를 지정하기 전에는 "다시 시도" 라고 권하지 않는다`)
  }

  // ── **누구인지** 가 화면에 남아야 한다 ──────────────────────────────────
  // 실사용(2026-09-17): 인물 셋 중 하나만 목소리를 지정하고 만들기 → 화면 검사가
  // "(2번 대사: 인물b, 3번 대사: 인물c)" 까지 알려 줬는데, 오류 카드가 고정 문장으로 덮어 이름이 사라졌다.
  // 사용자는 방금 지정한 인물 얘기인 줄 알았다("셋팅했는데 셋팅하라고 한다").
  await win.evaluate(() => {
    const st = window.__afStore.getState()
    st.setError('이 인물의 목소리가 준비되지 않았습니다. 인물 카드에서 목소리를 지정해 주세요. (2번 대사: 인물b, 3번 대사: 인물c)',
      { code: 'SPEAKER_NOT_REGISTERED' })
  })
  await sleep(700)
  const named = await win.evaluate(() => document.querySelector('[role="alert"]')?.textContent || '')
  ok(named.includes('인물b') && named.includes('인물c'),
    '**화면 검사가 알려 준 인물 이름이 카드에 그대로 남는다**', `"${named.slice(0, 90)}…"`)
  ok(named.includes('2번 대사'), '어느 대사에서 막혔는지도 남는다')

  // 파이썬이 막은 경우(코드만 옴)에도 지문으로 인물을 찾아 이름을 붙인다.
  const sha12 = createHash('sha256').update('인물b', 'utf8').digest('hex').slice(0, 12)
  await win.evaluate((ref) => {
    const st = window.__afStore.getState()
    st.registerSpeakerRef('인물b', 'C:/voice/b.wav', '영희')
    st.setError('SPEAKER_NOT_REGISTERED', { code: 'SPEAKER_NOT_REGISTERED', speakerRef: ref })
  }, 'spk_' + sha12)
  await sleep(700)
  const byRef = await win.evaluate(() => document.querySelector('[role="alert"]')?.textContent || '')
  ok(byRef.includes('영희'), '파이썬이 막아도 **어느 인물인지** 이름으로 말한다', `"${byRef.slice(0, 90)}…"`)
  ok(!byRef.includes('SPEAKER_') && !byRef.includes('spk_'), '내부 코드·지문은 화면에 나오지 않는다')

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
