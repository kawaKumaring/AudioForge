// 재생 '멈춤' 이 정말 멈추는가 — 표적 확인.
//
// 증상: 멈춤을 눌러도 소리가 계속됐고, 전체 듣기는 다음 문장이 이어졌다.
// 원인: 멈춤 단추의 **글자만** 바뀌고 누르면 다시 재생을 부르고 있었다(같은 onClick).
//
// 여기서 보는 것 — 소리를 **새로 만들지 않는다.** 저장소 fixture 음성을 이미 만든 결과인 것처럼
// 작업실에 얹고, 재생 요소가 실제로 멈추는지(paused)와 다음 문장이 시작되지 않는지를 본다.
//   1) 한 문장 듣기 → 멈춤 → 실제로 멈춘다
//   2) 전체 듣기 → 멈춤 → 멈추고 **다음 문장이 자동으로 시작되지 않는다**
//   3) 재생 중지는 합성 작업 취소가 아니다 — 작업 상태를 건드리지 않는다
//
// 실행: node test/e2e/lab-stop-playback.e2e.mjs   (사전: npm run build. 참조·GPU 불필요)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
// 이미 있는 음성만 쓴다 — 이 검사는 합성을 한 번도 부르지 않는다.
const A = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav')
const B = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')
for (const f of [A, B]) if (!fs.existsSync(f)) { console.error(`fixture 없음: ${path.basename(f)}`); process.exit(2) }

const UD = isolatedUserData()
let failed = 0
const log = (...a) => console.log('[lab-stop]', ...a)
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
  await win.waitForFunction(() => !!window.__labStore, undefined, { timeout: 30000 })
  await win.getByTestId('open-lab').click()
  await win.waitForTimeout(800)

  // 이미 만들어 둔 결과 두 개를 얹는다(새로 만들지 않는다).
  await win.evaluate(([a, b]) => {
    const s = window.__labStore.getState()
    const mk = (id, text, p) => ({
      id: `ln_${id}`, text, adoptedTakeId: `tk_${id}`,
      takes: [{ id: `tk_${id}`, path: p, text, voiceKey: a, createdAt: 1 }],
    })
    s.setDoc({
      voicePath: a, voiceLabel: 'A',
      lines: [mk('1', '첫 문장입니다.', a), mk('2', '둘째 문장입니다.', b)],
      settings: s.doc.settings, updatedAt: Date.now(),
    })
    s.markLoaded()
    s.selectLine('ln_1')
  }, [A, B])
  await win.waitForTimeout(500)

  // 재생 요소를 엿본다 — 화면에 붙지 않는 요소라 DOM 질의로는 보이지 않는다.
  await win.evaluate(() => {
    window.__plays = []
    window.__els = []
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function patched(...a) {
      window.__plays.push({ src: this.src, at: Date.now() })
      if (!window.__els.includes(this)) window.__els.push(this)
      return play.apply(this, a)
    }
  })
  const paused = () => win.evaluate(() => window.__els.map((e) => e.paused))
  const playCount = () => win.evaluate(() => window.__plays.length)

  // ── 1) 한 문장 듣기 → 멈춤 ──────────────────────────────────────────────
  const one = win.getByTestId('lab-line-play')
  await one.click()
  await sleep(1200)
  ok((await paused()).some((p) => p === false), '듣기를 누르면 실제로 재생된다')
  ok(((await one.textContent()) || '').includes('멈춤'), '단추가 "멈춤" 으로 바뀐다')

  const before = await playCount()
  await one.click()                       // ■ 멈춤
  await sleep(800)
  ok((await paused()).every((p) => p === true), '멈춤을 누르면 실제로 멈춘다(소리가 계속되지 않는다)')
  ok(await playCount() === before, '멈춤이 재생을 다시 시작하지 않는다',
    `(재생 호출 ${before} → ${await playCount()})`)
  ok(((await one.textContent()) || '').includes('듣기'), '단추가 "듣기" 로 돌아온다')

  // ── 2) 전체 듣기 → 멈춤 → 다음 문장이 이어지지 않는다 ────────────────────
  const all = win.getByTestId('lab-play-all')
  await all.click()
  await sleep(1500)
  ok((await paused()).some((p) => p === false), '전체 듣기가 재생을 시작한다')
  const beforeAll = await playCount()
  await all.click()                       // ■ 멈춤
  await sleep(800)
  ok((await paused()).every((p) => p === true), '전체 듣기 중 멈춤이 실제로 멈춘다')
  const rightAfter = await playCount()
  await sleep(3000)                       // 첫 문장이 끝났을 법한 시간을 지난다
  const later = await playCount()
  ok(later === rightAfter, '멈춘 뒤 다음 문장이 자동으로 시작되지 않는다',
    `(멈춤 직후 ${rightAfter} → 3초 뒤 ${later}, 멈추기 전 ${beforeAll})`)
  ok(((await all.textContent()) || '').includes('전체 듣기'), '전체 듣기 단추가 원래대로 돌아온다')

  // ── 3) 재생 중지는 합성 취소가 아니다 ───────────────────────────────────
  const st = await win.evaluate(() => ({
    appStatus: window.__afStore.getState().status,
    job: !!window.__labStore.getState().job,
    notice: window.__labStore.getState().notice,
  }))
  ok(st.appStatus !== 'processing' && !st.job && !st.notice,
    '재생을 멈춰도 작업 상태·알림을 건드리지 않는다', JSON.stringify(st))
  ok(await win.getByTestId('lab-cancel').count() === 0,
    '만들기 취소 단추는 만드는 중에만 나온다(재생 멈춤과 다른 자리)')

  // ── 용어 ────────────────────────────────────────────────────────────────
  const gen = (await win.getByTestId('lab-line-generate').textContent() || '').trim()
  ok(gen === '추가 생성', '"추가 생성" 으로 쓴다', `"${gen}"`)
  ok(await win.getByTestId('lab-line-generate').getAttribute('title')
     === '이전 음성은 보관하고 새 음성을 추가합니다.', '"추가 생성" 툴팁이 붙는다')
  const chip = (await win.locator('[data-testid="lab-take"]').first().textContent() || '')
  ok(chip.includes('생성본 1'), '"생성본 N" 으로 쓴다', `"${chip.trim()}"`)
  ok(chip.includes('사용 중'), '고른 것은 "사용 중" 으로 쓴다')
  const guide = await win.evaluate(() =>
    [...document.querySelectorAll('span')].some((e) => e.textContent === '들어보고 사용할 음성을 고르세요.'))
  ok(guide, '결과 목록에 안내 한 줄이 있다')

  // '이 음성 사용' 은 아직 고르지 않은 것에만 나온다 — 둘째 줄을 열어 확인한다
  await win.getByTestId('lab-line-input').nth(1).click()
  await win.waitForTimeout(400)
  await win.evaluate(() => window.__labStore.getState().addTake('ln_2', {
    id: 'tk_2b', path: window.__labStore.getState().doc.lines[1].takes[0].path,
    text: '둘째 문장입니다.', voiceKey: window.__labStore.getState().doc.voicePath, createdAt: 2,
  }))
  await win.waitForTimeout(400)
  const adoptBtns = await win.getByTestId('lab-take-adopt').allTextContents()
  ok(adoptBtns.includes('이 음성 사용'), '"이 음성 사용" 으로 쓴다', JSON.stringify(adoptBtns))
  ok(await win.getByTestId('lab-take-adopt').nth(1).getAttribute('title')
     === '전체 듣기와 내보내기에 이 음성을 사용합니다.', '"이 음성 사용" 툴팁이 붙는다')
} catch (e) {
  failed++
  log('FAIL 예외:', e && e.message)
} finally {
  if (app) await app.close().catch(() => {})
  cleanupUserData(UD)
}

log(failed === 0 ? '전부 통과 — 멈춤과 용어 확인(음성 생성 없음).' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
