// 하단 조작 정리 — 표적 확인.
//
// 소리를 **새로 만들지 않는다.** 이미 있는 fixture 음성을 생성본처럼 얹고 본다.
//
//   1) 일괄 생성 단추가 화면에서 사라졌다(다른 이름으로 대체되지도 않았다).
//      문장별 '생성 / 추가 생성' 은 그대로다.
//   2) '문장 조합 내보내기' 로 이름이 바뀌고 '전체 듣기' 와 한 묶음이다.
//   3) 전체 듣기와 내보내기가 **같은 생성본·같은 순서**를 쓴다. 문장을 옮기면 둘 다 따라간다.
//      최신 생성본이라는 이유로 고른 음성을 바꾸지 않는다.
//   4) 못 내보낼 때 이유가 문장마다 구체적이다(만들기 / 고르기 / 다시 만들기).
//      해소되면 예전 경고가 지워진다.
//
// 실행: node test/e2e/lab-compose-export.e2e.mjs   (사전: npm run build. 참조·GPU 불필요)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const A = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav')
const B = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')
for (const f of [A, B]) if (!fs.existsSync(f)) { console.error(`fixture 없음: ${path.basename(f)}`); process.exit(2) }
const sizeOf = (f) => fs.statSync(f).size - 44      // WAV 머리 44바이트를 뺀 소리 몸통

const UD = isolatedUserData()
const OUTDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'af-lab-compose-'))
const EXPORT_TO = path.join(OUTDIR, 'lab-script.wav')
let failed = 0
const log = (...a) => console.log('[lab-compose]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let app = null
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, AF_E2E_EXPORT_PATH: EXPORT_TO },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.__labStore, undefined, { timeout: 30000 })
  await win.getByTestId('open-lab').click()
  await win.waitForTimeout(800)

  const setDoc = (lines) => win.evaluate(([ls, a]) => {
    const s = window.__labStore.getState()
    s.setDoc({ voicePath: a, voiceLabel: 'A', lines: ls, settings: s.doc.settings, updatedAt: Date.now() })
    // 목소리는 준비된 것으로 둔다(분석을 돌리지 않는다) — 여기서 볼 것은 조합·내보내기다.
    s.setRef({ clip: a, region: null, phase: 'ready', message: '', reqId: s.ref.reqId })
    s.markLoaded()
  }, [lines, A])
  const status = () => win.getByTestId('lab-status').textContent()
  const message = () => win.evaluate(() => window.__labStore.getState().notice || '')

  // ── 1) 일괄 생성 단추가 없다 ────────────────────────────────────────────
  await setDoc([{ id: 'ln_1', text: '하나입니다.', takes: [], adoptedTakeId: null }])
  await win.waitForTimeout(500)
  ok(await win.getByTestId('lab-generate-changed').count() === 0, '일괄 생성 단추가 없다')
  const bar = await win.getByTestId('lab-bottom-bar').textContent()
  ok(!/필요한 문장 생성|변경된 문장|일괄|모두 생성|전부 생성/.test(bar || ''),
    '다른 이름의 일괄 생성 단추로 대체하지도 않았다', `"${(bar || '').trim().slice(0, 60)}"`)
  await win.getByTestId('lab-line-input').first().click()
  await win.waitForTimeout(300)
  ok(await win.getByTestId('lab-line-generate').count() === 1, "문장별 '생성' 은 그대로 있다")

  // ── 2) 이름과 묶음 ──────────────────────────────────────────────────────
  const exp = win.getByTestId('lab-export')
  ok((await exp.textContent() || '').trim() === '문장 조합 내보내기', "'문장 조합 내보내기' 로 바뀌었다")
  ok(await exp.getAttribute('title')
     === '문장마다 선택한 음성을 순서대로 이어 하나의 파일로 저장합니다.', '툴팁이 붙는다')
  const grouped = await win.evaluate(() => {
    const a = document.querySelector('[data-testid="lab-play-all"]')
    const b = document.querySelector('[data-testid="lab-export"]')
    return !!a && !!b && a.parentElement === b.parentElement
  })
  ok(grouped, "'전체 듣기' 와 한 묶음으로 놓였다")

  // ── 4) 못 내보낼 때 이유 ────────────────────────────────────────────────
  ok(((await status()) || '').includes('1번 문장의 음성을 생성하세요.'),
    '음성이 없으면 "N번 문장의 음성을 생성하세요."', `"${((await status()) || '').trim()}"`)

  await setDoc([{ id: 'ln_1', text: '하나입니다.', adoptedTakeId: null,
    takes: [{ id: 'tk_1', path: A, text: '하나입니다.', voiceKey: A, createdAt: 1 }] }])
  await win.waitForTimeout(500)
  ok(((await status()) || '').includes('1번 문장에서 사용할 음성을 선택하세요.'),
    '맞는 생성본이 있는데 미선택이면 "선택하세요"', `"${((await status()) || '').trim()}"`)

  await setDoc([{ id: 'ln_1', text: '고친 말입니다.', adoptedTakeId: 'tk_1',
    takes: [{ id: 'tk_1', path: A, text: '하나입니다.', voiceKey: A, createdAt: 1 }] }])
  await win.waitForTimeout(500)
  ok(((await status()) || '').includes('1번 문장이 변경됐습니다. 음성을 다시 생성하세요.'),
    '맞는 생성본이 없으면 "변경됐습니다. 다시 생성하세요"', `"${((await status()) || '').trim()}"`)

  // 막힌 동안에는 단추가 잠기고 파일도 쓰이지 않는다
  ok(await exp.isDisabled(), '내보낼 수 없으면 단추가 잠긴다')
  ok(!fs.existsSync(EXPORT_TO), '막힌 상태에서는 파일을 쓰지 않는다')

  // 경고가 남아 있다가 문제가 풀리면 지워진다(예전 말과 '전부 준비됨' 이 충돌하지 않게)
  await win.evaluate(() => window.__labStore.getState().setNotice('1번 문장이 변경됐습니다. 음성을 다시 생성하세요.'))
  await win.waitForTimeout(300)
  ok((await message()).length > 0, '막힌 동안에는 경고가 남아 있다')
  await setDoc([
    { id: 'ln_1', text: '하나입니다.', adoptedTakeId: 'tk_1',
      takes: [{ id: 'tk_1', path: A, text: '하나입니다.', voiceKey: A, createdAt: 1 }] },
    { id: 'ln_2', text: '둘입니다.', adoptedTakeId: 'tk_2',
      takes: [{ id: 'tk_2', path: B, text: '둘입니다.', voiceKey: A, createdAt: 1 }] },
  ])
  await win.waitForTimeout(700)
  ok((await message()) === '', '문제가 풀리면 예전 경고가 지워진다', `"${await message()}"`)
  ok(((await status()) || '').includes('전부 준비됨'), "'전부 준비됨' 과 충돌하지 않는다",
    `"${((await status()) || '').trim()}"`)

  // ── 3) 전체 듣기와 내보내기가 같은 것을 본다 ────────────────────────────
  await win.evaluate(() => {
    window.__plays = []
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function patched(...a) { window.__plays.push(this.src); return play.apply(this, a) }
  })
  await win.getByTestId('lab-play-all').click()
  await sleep(1200)
  await win.getByTestId('lab-play-all').click()          // 멈춤
  await sleep(400)
  const firstPlayed = (await win.evaluate(() => window.__plays))[0] || ''
  ok(decodeURIComponent(firstPlayed).includes('ko-speech-region-18s'),
    '전체 듣기는 1번 문장에서 고른 음성부터 낸다', decodeURIComponent(firstPlayed).split(/[\\/]/).pop())

  await win.getByTestId('lab-export').click()
  await win.waitForTimeout(1500)
  ok(fs.existsSync(EXPORT_TO), '내보내기 파일이 만들어진다')
  const expected = sizeOf(A) + sizeOf(B)
  const got = fs.existsSync(EXPORT_TO) ? sizeOf(EXPORT_TO) : -1
  ok(got === expected, '고른 음성 두 개를 그대로 이어 붙였다', `${got} 바이트 (기대 ${expected})`)

  // 문장을 옮기면 둘 다 그 순서를 따른다
  fs.rmSync(EXPORT_TO)
  await win.evaluate(() => window.__labStore.getState().moveLine('ln_2', 0))
  await win.waitForTimeout(500)
  await win.evaluate(() => { window.__plays = [] })
  await win.getByTestId('lab-play-all').click()
  await sleep(1200)
  await win.getByTestId('lab-play-all').click()
  await sleep(400)
  const afterMove = decodeURIComponent((await win.evaluate(() => window.__plays))[0] || '')
  ok(afterMove.includes('ko-speech-7s'), '순서를 바꾸면 전체 듣기가 따라간다',
    afterMove.split(/[\\/]/).pop())
  await win.getByTestId('lab-export').click()
  await win.waitForTimeout(1500)
  const head = fs.readFileSync(EXPORT_TO).subarray(44, 44 + 2048)
  const bHead = fs.readFileSync(B).subarray(44, 44 + 2048)
  ok(head.equals(bHead), '내보내기도 같은 순서를 따른다 — 첫 조각이 2번이던 음성이다')

  // 최신 생성본이라는 이유로 고른 것을 바꾸지 않는다
  await win.evaluate((b) => window.__labStore.getState().addTake('ln_1', {
    id: 'tk_late', path: b, text: '하나입니다.', voiceKey: window.__labStore.getState().doc.voicePath, createdAt: 99,
  }), B)
  await win.waitForTimeout(500)
  const paths = await win.evaluate(() => {
    const d = window.__labStore.getState().doc
    return d.lines.map((l) => l.takes.find((t) => t.id === l.adoptedTakeId)?.path)
  })
  ok(decodeURIComponent(paths[1] || '').includes('18s'),
    '새 생성본이 생겨도 고른 음성이 그대로다', (paths[1] || '').split(/[\\/]/).pop())
} catch (e) {
  failed++
  log('FAIL 예외:', e && e.message)
} finally {
  if (app) await app.close().catch(() => {})
  cleanupUserData(UD)
  try { fs.rmSync(OUTDIR, { recursive: true, force: true }) } catch { /* noop */ }
}

log(failed === 0 ? '전부 통과 — 하단 조작 정리 확인(음성 생성 없음).' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
