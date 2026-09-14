// 테스트개발 작업실이 **합성 탭에서 독립인가** — 표적 확인.
//
// 여기서 보는 것은 딱 두 가지다. 이미 확인한 테이크·채택·내보내기 흐름은 다시 돌리지 않고,
// **음성도 새로 만들지 않는다**(이 검사는 합성을 한 번도 부르지 않는다).
//
//   1) 원본 파일을 불러오지 않아도 작업실에 들어가 대본을 쓸 수 있다.
//      다른 모드의 파일 요구 조건은 그대로다.
//   2) 생성 설정이 작업실 소유다 — 합성 탭에서 바꿔도 조용히 따라가지 않는다.
//      초기값은 제품 기본값이고, 작업실에서 바꾼 값은 저장되고 앱을 다시 켜도 살아 있다.
//
// 실행: node test/e2e/lab-independence.e2e.mjs   (사전: npm run build. 참조·GPU 불필요)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const UD = isolatedUserData()      // 두 번의 실행이 같은 보관 자리를 쓴다 — 사이에 지우지 않는다
let failed = 0
const log = (...a) => console.log('[lab-indep]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }

async function launch() {
  const app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.__afStore && !!window.__labStore, undefined, { timeout: 30000 })
  return { app, win }
}

const labSettings = (win) => win.evaluate(() => window.__labStore.getState().doc.settings)

let app1 = null, app2 = null
try {
  // ── 1회차 — 파일 없이 들어간다 ──────────────────────────────────────────
  const first = await launch()
  app1 = first.app
  const win = first.win

  const noFile = await win.evaluate(() => !window.__afStore.getState().fileInfo)
  ok(noFile, '원본 파일을 불러오지 않은 상태로 시작한다')
  ok(await win.getByTestId('lab-workspace').count() === 0, '처음에는 작업실이 열려 있지 않다')

  await win.getByTestId('open-lab').click()
  await win.waitForTimeout(600)
  ok(await win.getByTestId('lab-workspace').count() === 1, '파일 없이도 작업실이 열린다')
  ok(await win.evaluate(() => !window.__afStore.getState().fileInfo),
    '작업실에 들어가도 원본 파일이 생기지 않는다(합성 탭 상태 무변경)')

  // 탭 이름
  const tabText = (await win.getByTestId('mode-lab').textContent() || '').trim()
  ok(tabText.includes('테스트개발'), '탭 이름이 "테스트개발" 이다', `"${tabText}"`)

  // 빈 작업실에서 대본을 쓴다
  const input = win.getByTestId('lab-line-input').first()
  await input.click()
  await input.fill('첫 문장입니다.')
  await input.press('Enter')
  await win.waitForTimeout(300)
  await win.getByTestId('lab-line-input').nth(1).fill('둘째 문장입니다.')
  await win.waitForTimeout(300)
  const texts = await win.evaluate(() => window.__labStore.getState().doc.lines.map((l) => l.text))
  ok(texts.length === 2 && texts[0] === '첫 문장입니다.' && texts[1] === '둘째 문장입니다.',
    '파일 없이 대본을 쓰고 줄을 늘릴 수 있다', JSON.stringify(texts))
  ok(await win.getByTestId('lab-pick-voice').isEnabled(), '목소리 고르기를 바로 쓸 수 있다')

  // 다른 모드는 예전 그대로 — 파일을 먼저 불러와야 한다
  await win.getByTestId('mode-tts').click()
  await win.waitForTimeout(600)
  ok(await win.getByTestId('lab-workspace').count() === 0 && await win.getByTestId('open-lab').count() === 1,
    '파일 없이 합성 탭을 고르면 예전처럼 불러오기 화면으로 돌아간다')
  await win.getByTestId('open-lab').click()
  await win.waitForTimeout(500)

  // ── 설정 독립성 ─────────────────────────────────────────────────────────
  const init = await labSettings(win)
  ok(init.speed === 1.0 && init.silenceGap === 0.5 && init.pitch === 0.0
     && init.engine === 'auto' && init.referenceConditioningMode === 'auto',
    '작업실 설정 초기값이 제품 기본값이다', JSON.stringify(init))

  // 합성 탭에서 설정을 바꾼다(사용자가 그 탭에서 조절한 것과 같은 자리)
  await win.evaluate(() => {
    window.__afStore.setState({ ttsSpeed: 1.6, ttsSilenceGap: 1.2, ttsPitch: 3, ttsEngine: 'qwen' })
  })
  await win.waitForTimeout(500)
  const after = await labSettings(win)
  ok(after.speed === 1.0 && after.silenceGap === 0.5 && after.pitch === 0.0 && after.engine === 'auto',
    '합성 탭 설정을 바꿔도 작업실에 조용히 반영되지 않는다', JSON.stringify(after))

  // 작업실이 자기 설정을 바꾸면 합성 탭이 따라가지 않는다(반대 방향도 막힌다)
  await win.evaluate(() => { window.__labStore.getState().setSettings({ speed: 1.25, engine: 'qwen' }) })
  await win.waitForTimeout(900)      // 자동 저장 600ms
  const appAfter = await win.evaluate(() => {
    const s = window.__afStore.getState()
    return { speed: s.ttsSpeed, engine: s.ttsEngine }
  })
  ok(appAfter.speed === 1.6, '작업실 설정 변경이 합성 탭을 덮지 않는다', JSON.stringify(appAfter))

  // 저장되었는가
  const saved = await win.evaluate(async () => {
    const got = await window.api.settings.get()
    return got?.labWorkspace?.settings ?? null
  })
  ok(saved && saved.speed === 1.25 && saved.engine === 'qwen',
    '작업실 설정이 작업실 저장 열쇠에 담긴다', JSON.stringify(saved))

  await win.waitForTimeout(500)
  await app1.close()
  app1 = null

  // ── 2회차 — 앱을 다시 켜도 작업실 설정이 살아 있다 ──────────────────────
  const second = await launch()
  app2 = second.app
  const win2 = second.win
  await win2.getByTestId('open-lab').click()
  await win2.waitForTimeout(1500)
  const restored = await labSettings(win2)
  ok(restored.speed === 1.25 && restored.engine === 'qwen',
    '앱을 다시 켜도 작업실 설정이 그대로다', JSON.stringify(restored))
  const restoredText = await win2.getByTestId('lab-line-input').first().inputValue()
  ok(restoredText === '첫 문장입니다.', '파일 없이 쓴 대본도 복원된다')
  const appFresh = await win2.evaluate(() => window.__afStore.getState().ttsSpeed)
  ok(appFresh === 1.0, '합성 탭은 제 기본값으로 시작한다(작업실 값이 새지 않는다)', String(appFresh))
} catch (e) {
  failed++
  log('FAIL 예외:', e && e.message)
} finally {
  if (app1) await app1.close().catch(() => {})
  if (app2) await app2.close().catch(() => {})
  cleanupUserData(UD)
}

log(failed === 0 ? '전부 통과 — 진입 경로와 설정 독립성 확인(음성 생성 없음).' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
