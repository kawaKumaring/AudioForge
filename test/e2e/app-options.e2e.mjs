// 설정 화면 — **자리를 정하고, 쌓인 것을 비운다.** 실제 앱에서 본다.
//
// ★지시 (2026-09-28)
//   "옵션기능을 구현하면 그곳에 생성할 위치를 정하는 기능과 그아래 설정체크를 둬서
//    참조 목소리 원본파일 옆에 생성 … 체크를 하면 지금처럼 원본파일 옆에 생성"
//   "이런 캐쉬나 이전작업 등을 초기화하는 기능도 구현하는게 좋을듯하다"
//
// 여기서 보는 것:
//   1) 톱니바퀴로 열고 닫는다
//   2) 체크가 저장되고, 설정 값이 실제로 바뀐다
//   3) 비우기는 **먼저 묻는다**. 그대로 두기를 고르면 아무것도 안 지운다
//   4) 작업 기록 비우기는 **기록만** 지운다 — 앱 설정과 소리 파일은 그대로
//   5) 중간 산출물 비우기는 그 폴더만 지운다
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData, makeSyntheticWav } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }

const UD = isolatedUserData()
let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}

// 비워질 것과 남아야 할 것을 미리 만들어 둔다.
const mediaFile = makeSyntheticWav(path.join(UD, 'cardmedia', 'x', 'voice.wav'), 1)
const keepFile = makeSyntheticWav(path.join(UD, 'keep-me.wav'), 1)

let app = null
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore)

  // 작업 기록과 앱 설정을 함께 심는다 — 비우기가 **무엇을 건드리는지** 보려고.
  await win.evaluate(async () => {
    await window.api.settings.set('synthesisCards', {
      current: { cards: [{ id: 'a', label: 'A', sourcePath: '', sourceName: '', sourceDuration: 0, text: '기록', settings: {}, takes: [], adoptedId: null }], joins: {}, savedAt: 1 },
      kept: [],
    })
    await window.api.settings.set('playbackVolume', 0.42)
  })

  // ── 1. 열고 닫기 ──────────────────────────────────────────────────────
  await win.getByTestId('open-app-options').click()
  await win.waitForSelector('[data-testid="app-options"]')
  ok(true, '톱니바퀴로 설정이 열린다')
  ok(await win.evaluate(() => document.querySelector('[data-testid="app-options"]')?.tagName), 'DIALOG',
    '★팝업(dialog)으로 뜬다')
  ok(await win.evaluate(() => document.querySelector('[data-testid="app-options"]')?.open === true),
    '팝업이 열려 있다')

  // ── 2. 체크가 저장된다 ────────────────────────────────────────────────
  await win.getByTestId('options-beside').check()
  await win.waitForFunction(() =>
    document.querySelector('[data-testid="options-notice"]')?.textContent?.includes('저장'))
  const afterCheck = await win.evaluate(() => window.api.options.get())
  ok(afterCheck.beside === true, '★원본 옆 체크가 저장된다', afterCheck)
  ok((await win.getByTestId('options-place-notice').innerText()).includes('원본 파일 옆'),
    '어디에 쌓이는지 말한다', await win.getByTestId('options-place-notice').innerText())

  await win.getByTestId('options-beside').uncheck()
  await win.waitForFunction(() => document.querySelector('[data-testid="options-beside"]')?.checked === false)
  const afterUncheck = await win.evaluate(() => window.api.options.get())
  ok(afterUncheck.beside === false, '체크를 풀면 앱 자리로 돌아간다', afterUncheck)
  ok(typeof afterUncheck.appRoot === 'string' && afterUncheck.appRoot.length > 0,
    '앱 자리를 안다', afterUncheck.appRoot)

  // ── 3. 비우기는 먼저 묻는다 ───────────────────────────────────────────
  await win.getByTestId('options-wipe-works').click()
  await win.waitForSelector('[data-testid="options-wipe-ask"]')
  const askText = await win.getByTestId('options-wipe-ask').innerText()
  ok(askText.includes('소리 파일') && askText.includes('지우지 않습니다'),
    '★무엇이 남는지 먼저 말한다', askText)
  await win.getByTestId('options-wipe-cancel').click()
  await win.waitForFunction(() => !document.querySelector('[data-testid="options-wipe-ask"]'))
  const stillThere = await win.evaluate(async () => {
    const all = await window.api.settings.get()
    return { cards: !!all.synthesisCards, volume: all.playbackVolume }
  })
  ok(stillThere.cards, '★그대로 두기를 고르면 아무것도 안 지운다', stillThere)

  // ── 4. 작업 기록만 지운다 ─────────────────────────────────────────────
  await win.getByTestId('options-wipe-works').click()
  await win.getByTestId('options-wipe-yes').click()
  await win.waitForFunction(() =>
    document.querySelector('[data-testid="options-notice"]')?.textContent?.includes('비웠'))
  const afterWipe = await win.evaluate(async () => {
    const all = await window.api.settings.get()
    return { cards: !!all.synthesisCards, volume: all.playbackVolume }
  })
  ok(!afterWipe.cards, '★작업 기록이 지워졌다', afterWipe)
  ok(afterWipe.volume === 0.42, '★앱 설정(음량)은 그대로다', afterWipe)
  ok(fs.existsSync(keepFile), '★소리 파일은 그대로다')

  // ── 5. 중간 산출물만 지운다 ───────────────────────────────────────────
  ok(fs.existsSync(mediaFile), '지우기 전에 중간 산출물이 있다')
  await win.getByTestId('options-wipe-media').click()
  await win.getByTestId('options-wipe-yes').click()
  await win.waitForFunction(() =>
    document.querySelector('[data-testid="options-notice"]')?.textContent?.includes('비웠'))
  ok(!fs.existsSync(mediaFile), '★중간 산출물이 지워졌다')
  ok(fs.existsSync(keepFile), '★그 옆의 다른 파일은 그대로다')

  // ── 6. 사이드바에 있던 '이전 결과 폴더 열기' 가 여기로 왔다 ───────────
  //   ★이름이 하는 일과 달랐다 — 폴더를 여는 것이 아니라 결과를 되불러온다.
  ok(await win.getByTestId('options-restore-folder').count() === 1,
    '★결과 폴더에서 되살리기가 설정 안에 있다')
  ok(await win.getByTestId('restore-results').count() === 0,
    '★사이드바의 헷갈리던 단추는 없어졌다')

  await win.getByTestId('options-close').click()
  await win.waitForFunction(() => !document.querySelector('[data-testid="app-options"]'))
  ok(true, '설정을 닫으면 작업 화면으로 돌아온다')
} catch (e) {
  console.error('FAIL', e?.message || e)
  fails.push(String(e?.message || e))
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
}
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
