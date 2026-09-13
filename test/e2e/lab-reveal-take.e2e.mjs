// 생성본의 '폴더에서 보기' — 표적 확인.
//
// 소리를 **새로 만들지 않는다.** 이미 있는 fixture 음성을 생성본처럼 얹고,
// 단추가 **그 생성본이 실제로 재생에 쓰는 파일**을 가리키는지만 본다.
//
// ★탐색기 창을 실제로 띄우지는 않는다 — **메인 프로세스의 탐색기 호출을 가로채** 어떤 경로가
//   넘어가는지 본다. 그래서 단추→preload→IPC→탐색기까지의 사슬 전체를 실제로 지난다.
//   (`window.api` 는 contextBridge 로 굳어 있어 화면 쪽에서는 바꿔 낄 수 없다.)
//
// 실행: node test/e2e/lab-reveal-take.e2e.mjs   (사전: npm run build. 참조·GPU 불필요)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const A = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav')
const B = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')
for (const f of [A, B]) if (!fs.existsSync(f)) { console.error(`fixture 없음: ${path.basename(f)}`); process.exit(2) }

const UD = isolatedUserData()
let failed = 0
const log = (...a) => console.log('[lab-reveal]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }

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

  // 생성본 두 개 — 서로 **다른 파일**이라 어느 것을 가리키는지 구분된다.
  await win.evaluate(([a, b]) => {
    const s = window.__labStore.getState()
    s.setDoc({
      voicePath: a, voiceLabel: 'A',
      lines: [{
        id: 'ln_1', text: '하나입니다.', adoptedTakeId: 'tk_1',
        takes: [
          { id: 'tk_1', path: a, text: '하나입니다.', voiceKey: a, createdAt: 1 },
          { id: 'tk_2', path: b, text: '하나입니다.', voiceKey: a, createdAt: 2 },
        ],
      }],
      settings: s.doc.settings, updatedAt: Date.now(),
    })
    s.markLoaded()
    s.selectLine('ln_1')
  }, [A, B])
  await win.waitForTimeout(500)

  // 탐색기 창을 띄우지 않고, 넘어가는 경로만 가로챈다(메인 프로세스 쪽).
  await app.evaluate(({ shell }) => {
    globalThis.__revealed = []
    shell.showItemInFolder = (p) => { globalThis.__revealed.push(p) }
  })

  // ── 생김새 ──────────────────────────────────────────────────────────────
  const btns = win.getByTestId('lab-take-reveal')
  ok(await btns.count() === 2, '생성본마다 폴더 아이콘이 하나씩 있다', String(await btns.count()))
  ok(await btns.first().getAttribute('title') === '폴더에서 보기', '툴팁이 "폴더에서 보기" 다')
  ok(await btns.first().getAttribute('aria-label') === '폴더에서 보기', '접근성 이름이 "폴더에서 보기" 다')
  // 축소된 범위 — 별도 메뉴·경로 표시·경로 복사는 만들지 않는다
  const body = await win.evaluate(() => document.body.innerText)
  ok(!body.includes('파일 경로 복사') && !body.includes('경로 복사'), '경로 복사 단추를 만들지 않았다')
  ok(!body.includes(A.replace(/\//g, '\\')) && !body.includes(A), '화면에 경로를 늘어놓지 않는다')

  // ── 대상 파일이 맞는가 ──────────────────────────────────────────────────
  await btns.nth(0).click()
  await win.waitForTimeout(300)
  await btns.nth(1).click()
  await win.waitForTimeout(300)
  const got = await app.evaluate(() => globalThis.__revealed)
  ok(got.length === 2, '누를 때마다 한 번씩 요청한다', String(got.length))
  ok(got[0] === A, '첫 생성본은 그 생성본이 재생에 쓰는 파일을 가리킨다',
    got[0] ? got[0].split(/[\\/]/).pop() : '')
  ok(got[1] === B, '둘째 생성본은 **다른** 그 파일을 가리킨다 — 문장의 사용 중 음성이 아니다',
    got[1] ? got[1].split(/[\\/]/).pop() : '')

  // 재생이 실제로 쓰는 경로와 같은 값인가(같은 출처를 본다)
  const playPaths = await win.evaluate(() =>
    window.__labStore.getState().doc.lines[0].takes.map((t) => t.path))
  ok(JSON.stringify(got) === JSON.stringify(playPaths),
    '재생에 쓰는 경로와 같은 값을 넘긴다', JSON.stringify(playPaths.map((p) => p.split(/[\\/]/).pop())))

  // ── 파일이 없으면 ───────────────────────────────────────────────────────
  // 없는 파일이면 탐색기를 부르기 전에 막아야 한다.
  const before = (await app.evaluate(() => globalThis.__revealed)).length
  const missing = await win.evaluate(() => window.api.app.revealFile('C:/없는폴더/없는파일.wav'))
  ok(missing?.ok === false, '없는 파일은 성공으로 처리하지 않는다', JSON.stringify(missing))
  ok(missing?.reason === '음원 파일을 찾을 수 없습니다', '"음원 파일을 찾을 수 없습니다" 로 알린다',
    JSON.stringify(missing))
  ok((await app.evaluate(() => globalThis.__revealed)).length === before,
    '없는 파일로 탐색기를 부르지 않는다')

  // 화면에서 눌렀을 때도 같은 안내가 뜬다 — 없는 파일을 가진 생성본을 하나 더 얹어 눌러 본다.
  await win.evaluate(() => {
    const s = window.__labStore.getState()
    s.addTake('ln_1', { id: 'tk_gone', path: 'C:/없는폴더/없는파일.wav',
      text: '하나입니다.', voiceKey: s.doc.voicePath, createdAt: 3 })
  })
  await win.waitForTimeout(400)
  await win.getByTestId('lab-take-reveal').nth(2).click()
  await win.waitForTimeout(500)
  const shownErr = await win.evaluate(() => window.__labStore.getState().error || '')
  ok(shownErr === '음원 파일을 찾을 수 없습니다', '화면에서도 짧게 알린다', `"${shownErr}"`)
  ok((await app.evaluate(() => globalThis.__revealed)).length === before,
    '없는 파일을 눌러도 탐색기를 부르지 않는다')
} catch (e) {
  failed++
  log('FAIL 예외:', e && e.message)
} finally {
  if (app) await app.close().catch(() => {})
  cleanupUserData(UD)
}

log(failed === 0 ? '전부 통과 — 대상 파일 확인(음성 생성 없음).' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
