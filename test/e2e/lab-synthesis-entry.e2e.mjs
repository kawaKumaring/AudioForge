// 합성 진입 구조 통합 — 표적 확인.
//
// 소리를 **새로 만들지 않는다.** 이미 있는 fixture 음성을 생성본처럼 얹고 화면 구조만 본다.
//
//   1) 파일 없이 '합성 > 일반' 에 들어가 대본을 쓸 수 있다. 고급은 예전처럼 파일이 필요하다.
//   2) 일반↔고급 전환 뒤에도 **각자의 작업이 그대로** 있다(대사·생성본·선택·고급 원문).
//   3) 고급의 인원 전환이 좌우 화살표다. 끝에서 반대편으로 돌지 않는다.
//   4) 테스트개발 탭은 안내만 있고, 작업실 화면을 두 곳에 두지 않는다.
//   5) 숨어야 할 공용 실행 버튼이 어느 자리에도 나오지 않는다.
//
// 실행: node test/e2e/lab-synthesis-entry.e2e.mjs   (사전: npm run build. 참조·GPU 불필요)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedInput, cleanupIsolated, isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const A = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav')
if (!fs.existsSync(A)) { console.error('fixture 없음'); process.exit(2) }

const { dir: ISO, input: SRC } = isolatedInput(A)
const UD = isolatedUserData()
let failed = 0
const log = (...a) => console.log('[entry]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }

let app = null
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, AF_E2E_SELECT_FILE: SRC },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.__afStore && !!window.__labStore, undefined, { timeout: 30000 })

  // ── 1) 파일 없이 합성 > 일반 ────────────────────────────────────────────
  ok(await win.evaluate(() => !window.__afStore.getState().fileInfo), '원본 파일이 없는 상태다')
  await win.getByTestId('open-lab').click()          // 첫 화면의 '합성(일반) — 파일 없이 …'
  await win.waitForTimeout(800)
  ok(await win.evaluate(() => window.__afStore.getState().mode) === 'tts', "상위 모드가 '합성' 이다")
  ok(await win.getByTestId('synthesis-tabs').count() === 1, '합성 안에 일반/고급 탭이 있다')
  ok(await win.evaluate(() => window.__afStore.getState().synthesisTab) === 'basic', '첫 진입이 일반이다')
  ok(await win.getByTestId('lab-workspace').count() === 1, '파일 없이도 작업실이 열린다')
  const note = await win.getByTestId('synthesis-scope-note').textContent()
  ok((note || '').trim() === '일반과 고급의 작업은 각각 저장됩니다.', '작업이 각각 저장된다는 안내가 있다')

  // 일반에 대본을 쓰고 생성본을 얹는다(이미 있는 음성을 쓴다 — 새로 만들지 않는다)
  await win.evaluate((a) => {
    const s = window.__labStore.getState()
    s.setDoc({
      voicePath: a, voiceLabel: 'A',
      lines: [{ id: 'ln_1', text: '일반에서 쓴 대사입니다.', adoptedTakeId: 'tk_1',
        takes: [{ id: 'tk_1', path: a, text: '일반에서 쓴 대사입니다.', voiceKey: a, createdAt: 1 }] }],
      settings: s.doc.settings, updatedAt: Date.now(),
    })
    s.setRef({ clip: a, region: null, phase: 'ready', message: '', reqId: s.ref.reqId })
    s.markLoaded()
  }, SRC)
  await win.waitForTimeout(500)

  // 고급은 예전처럼 파일이 필요하다 — 다만 탭 줄은 남아 돌아올 수 있다
  await win.getByTestId('synthesis-tab-advanced').click()
  await win.waitForTimeout(600)
  ok(await win.getByTestId('synthesis-need-file').count() === 1,
    '고급은 원본 파일을 먼저 불러와야 한다는 조건이 그대로다')
  ok(await win.getByTestId('synthesis-tabs').count() === 1, '그래도 탭 줄이 남아 일반으로 돌아올 수 있다')
  await win.getByTestId('synthesis-tab-basic').click()
  await win.waitForTimeout(600)
  ok(await win.getByTestId('lab-line-input').first().inputValue() === '일반에서 쓴 대사입니다.',
    '고급에 다녀와도 일반의 대사가 그대로다')

  // ── 파일을 불러오고 고급으로 ────────────────────────────────────────────
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
  }, SRC)
  await win.waitForTimeout(600)
  await win.getByTestId('synthesis-tab-advanced').click()
  await win.waitForTimeout(1000)
  ok(await win.getByTestId('dialogue-tabs').count() === 1, '고급에 기존 합성 화면이 나온다')
  ok(await win.getByTestId('lab-workspace').count() === 0, '고급에는 작업실이 섞여 나오지 않는다')

  // 고급에 원문을 넣는다(고급 쪽 작업)
  await win.evaluate(() => window.__afStore.setState({ ttsText: '고급에서 쓴 원문입니다.' }))
  await win.waitForTimeout(400)

  // ── 3) 인원 좌우 전환 ───────────────────────────────────────────────────
  const left = win.getByTestId('dialogue-left')
  const right = win.getByTestId('dialogue-right')
  const current = () => win.getByTestId('dialogue-current').textContent()
  ok((await current() || '').includes('한 명'), '지금은 한 명이다', `"${await current()}"`)
  ok(await left.isDisabled() && !(await right.isDisabled()),
    '한 명에서는 왼쪽이 꺼지고 오른쪽이 켜진다')
  ok((await right.getAttribute('aria-label') || '').includes('여러 명'),
    '오른쪽 화살표가 어디로 가는지 이름으로 알려 준다', await right.getAttribute('aria-label'))
  ok((await right.getAttribute('title') || '').includes('여러 명'), '툴팁도 전환 대상을 알려 준다')

  await right.click()
  await win.waitForTimeout(700)
  ok((await current() || '').includes('여러 명'), '오른쪽을 누르면 여러 명으로 바뀐다', `"${await current()}"`)
  ok(await win.evaluate(() => window.__afStore.getState().mode) === 'tts'
     && await win.evaluate(() => window.__afStore.getState().synthesisTab) === 'advanced',
    '화살표는 인원만 바꾼다 — 일반/고급은 그대로다')
  ok(!(await left.isDisabled()) && await right.isDisabled(),
    '여러 명에서는 왼쪽이 켜지고 오른쪽이 꺼진다 — 반대편으로 돌지 않는다')

  await left.click()
  await win.waitForTimeout(700)
  ok((await current() || '').includes('한 명'), '왼쪽을 누르면 한 명으로 돌아온다')
  ok(await win.evaluate(() => window.__afStore.getState().ttsText) === '고급에서 쓴 원문입니다.',
    '인원을 오가도 고급의 원문이 그대로다')

  // ── 2) 일반↔고급 각자 보존 ──────────────────────────────────────────────
  await win.getByTestId('synthesis-tab-basic').click()
  await win.waitForTimeout(700)
  await win.getByTestId('lab-line-input').first().click()
  await win.waitForTimeout(400)
  ok(await win.getByTestId('lab-line-input').first().inputValue() === '일반에서 쓴 대사입니다.',
    '일반의 대사가 남아 있다')
  ok(await win.getByTestId('lab-take').count() === 1, '일반의 생성본이 남아 있다')
  ok(await win.evaluate(() =>
    document.querySelector('[data-testid="lab-take"]').getAttribute('data-adopted')) === '1',
    '일반에서 고른 음성이 그대로다')
  ok(await win.evaluate(() => window.__afStore.getState().ttsText) === '고급에서 쓴 원문입니다.',
    '일반에 있는 동안에도 고급의 원문이 지워지지 않는다')

  // ── 4) 테스트개발 탭 ────────────────────────────────────────────────────
  ok(await win.getByTestId('mode-lab').count() === 1, '상위 테스트개발 탭은 그대로 있다')
  await win.getByTestId('mode-lab').click()
  await win.waitForTimeout(700)
  ok(await win.getByTestId('lab-placeholder').count() === 1, '테스트개발에는 안내만 있다')
  ok(await win.getByTestId('lab-workspace').count() === 0, '작업실을 두 곳에 두지 않는다')
  const text = await win.getByTestId('lab-placeholder').textContent()
  for (const phrase of ['아이디어 준비 중',
    '새로운 기능을 준비하면 이곳에서 먼저 사용해 볼 수 있습니다',
    '기존 작업실은 ‘합성 > 일반’으로 이동했습니다']) {
    ok((text || '').includes(phrase), `안내에 "${phrase.slice(0, 14)}…" 가 있다`)
  }
  await win.getByTestId('lab-goto-basic').click()
  await win.waitForTimeout(700)
  ok(await win.evaluate(() => window.__afStore.getState().mode) === 'tts'
     && await win.evaluate(() => window.__afStore.getState().synthesisTab) === 'basic',
    "'일반 합성 열기' 가 합성>일반으로 데려간다")
  ok(await win.getByTestId('lab-line-input').first().inputValue() === '일반에서 쓴 대사입니다.',
    '돌아와도 일반의 작업이 그대로다')

  // ── 5) 공용 실행 버튼이 새지 않는다 ─────────────────────────────────────
  for (const [where, go] of [
    ['합성>일반', async () => { await win.getByTestId('synthesis-tab-basic').click() }],
    ['합성>고급', async () => { await win.getByTestId('synthesis-tab-advanced').click() }],
    ['테스트개발', async () => { await win.getByTestId('mode-lab').click() }],
  ]) {
    await go()
    await win.waitForTimeout(700)
    const body = await win.evaluate(() => document.body.innerText)
    ok(!/텍스트 추출 시작|음악 분리 시작|트랙 분할 시작|대화 분리 시작/.test(body),
      `${where} 에 다른 모드의 실행 버튼이 나오지 않는다`)
  }
} catch (e) {
  failed++
  log('FAIL 예외:', e && e.message)
} finally {
  if (app) await app.close().catch(() => {})
  cleanupIsolated(ISO)
  cleanupUserData(UD)
}

log(failed === 0 ? '전부 통과 — 진입 구조 통합 확인(음성 생성 없음).' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
