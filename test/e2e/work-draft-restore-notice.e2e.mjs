// 파일을 열 때 이전 작업이 되살아나면 **무엇이 돌아왔는지 말하고, 버릴 길을 준다.**
//
// 실사용(2026-09-17): 저장된 작업(한 명 모드, 대사에 인물 셋, 목소리 0명)이 파일을 여는 순간
// 조용히 되살아났다. 사용자는 방금 지정한 한 명만 생각했고 "셋팅했는데 셋팅하라고 한다" 가 됐다.
// 되살리는 동작 자체는 유지한다(합성하지 않고 닫아도 남는 것이 목적). 다만 **보여 주고 고르게** 한다.
//
// 실행: node test/e2e/work-draft-restore-notice.e2e.mjs   (사전: npm run build. GPU 불필요)
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
const log = (...a) => console.log('[restore]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function launch() {
  const app = await electron.launch({
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
  await sleep(1500)
  return { app, win }
}
const state = (win) => win.evaluate(() => {
  const s = window.__afStore.getState()
  return { text: (s.ttsText || '').length, speakers: Object.keys(s.ttsSpeakerRefState), mode: s.ttsSpeakerMode }
})

let app = null
try {
  // ── 1회차: 인물 셋짜리 작업을 만들고 저장되게 둔 뒤 닫는다 ─────────────────
  ;({ app } = await launch())
  let win = await app.firstWindow()
  await win.evaluate((p) => {
    const st = window.__afStore.getState()
    st.setTtsSpeakerMode('multi')
    for (const id of ['인물a', '인물b', '인물c']) st.registerSpeakerRef(id, p, id)
    window.__afStore.setState({
      ttsText: ['[화자 인물a]', '안녕하세요.', '[화자 인물b]', '반갑습니다.', '[화자 인물c]', '네, 시작하죠.'].join('\n'),
    })
  }, SRC)
  await sleep(2500)                                   // 자동 저장(700ms 지연) 이 쓰이도록
  ok(!(await win.getByTestId('work-draft-restored').count()), '지금 만든 작업에는 "되살렸습니다" 가 뜨지 않는다')
  await app.close(); app = null

  // ── 2회차: 같은 파일을 열면 되살아난다 — **보여 준다** ───────────────────────
  ;({ app } = await launch())
  win = await app.firstWindow()
  await sleep(1500)
  const s2 = await state(win)
  ok(s2.speakers.length === 3 && s2.mode === 'multi' && s2.text > 0, '이전 작업이 되살아난다(기존 동작 유지)', JSON.stringify(s2))
  // 되살린 대본이 편집기 → 분석(첫 요청은 worker 가 차가워 수 초) → 카드로 흐를 시간을 준다.
  let shown2 = { rows: 0, tab: '' }
  for (let i = 0; i < 15 && shown2.rows !== 3; i++) {
    await sleep(2000)
    shown2 = await win.evaluate(() => ({
      rows: document.querySelectorAll('[data-testid="dialogue-row"]').length,
      tab: window.__afStore.getState().ttsSpeakerMode,
    }))
  }
  ok(shown2.rows === 3, '**화면(인물 카드)도 되살린 대본을 보여 준다** — store 만 바뀌고 화면은 옛 글을 보이면 안 된다', JSON.stringify(shown2))
  const notice = win.getByTestId('work-draft-restored')
  ok(await notice.count() === 1, '**되살렸다는 사실을 화면에 알린다**')
  const txt = (await notice.textContent()) || ''
  ok(txt.includes('인물 3명') && txt.includes('대사 3줄') && txt.includes('여러 명'),
    '무엇이 돌아왔는지 수치로 말한다', `"${txt.trim().slice(0, 60)}"`)
  ok(!/안녕하세요|반갑습니다/.test(txt), '대사 본문은 알림에 내지 않는다')

  // 새로 시작 — 대본·인물·방식을 비운다
  await win.getByTestId('work-draft-discard').click()
  await sleep(1500)
  const s3 = await state(win)
  ok(s3.text === 0 && s3.speakers.length === 0 && s3.mode === 'single',
    '"새로 시작" 은 대본·인물·방식을 비운다', JSON.stringify(s3))
  ok(await win.getByTestId('work-draft-restored').count() === 0, '알림도 닫힌다')
  const shown3 = await win.evaluate(() => ({
    rows: document.querySelectorAll('[data-testid="dialogue-row"]').length,
    editor: [...document.querySelectorAll('textarea')].map((e) => e.value.length).reduce((a, b) => a + b, 0),
  }))
  ok(shown3.rows === 0 && shown3.editor === 0, '**화면(편집기·카드)도 비워진다**', JSON.stringify(shown3))
  ok(await win.evaluate(() => window.__afStore.getState().fileInfo?.path !== ''), '불러온 파일은 그대로다')
  await app.close(); app = null

  // ── 3회차: 다시 열어도 옛 작업이 돌아오지 않는다 ─────────────────────────────
  ;({ app } = await launch())
  win = await app.firstWindow()
  await sleep(1500)
  const s4 = await state(win)
  ok(s4.speakers.length === 0 && s4.text === 0, '"새로 시작" 한 뒤에는 다시 열어도 되살아나지 않는다', JSON.stringify(s4))
  ok(await win.getByTestId('work-draft-restored').count() === 0, '되살린 것이 없으니 알림도 없다')
} catch (e) {
  failed++
  log('FAIL 예외:', e && e.message)
} finally {
  if (app) await app.close().catch(() => {})
  cleanupUserData(UD)
  cleanupIsolated(ISO)
}

log(failed === 0 ? '전부 통과 — 되살린 작업을 알리고, 새로 시작할 수 있다.' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
