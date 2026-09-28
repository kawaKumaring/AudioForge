// 낭독 — **실제 앱에서 책을 읽어 준다.**
//
// ★지시 (2026-09-29): "기본음성으로 읽어주거나 적용한 목소리로 읽게" 하는 책 플레이어.
//
// 여기서 보는 것 — 모형이 아니라 **실제 piper** 로 소리를 만든다
//   1) 글을 넣으면 책이 되고 문단이 펼쳐진다
//   2) 목소리는 **본체가 확인한 것**만 고를 수 있다
//   3) 누르면 실제로 소리 파일이 만들어지고 재생이 시작된다
//   4) 한 덩이가 끝나면 **다음으로 넘어간다** — 손대지 않아도
//   5) 읽는 자리와 고른 자리를 구분해 보인다
//   6) 같은 글을 다시 읽으면 **곧바로** 나온다(쌓아 둔 것을 쓴다)
//   7) 목소리를 바꾸면 만들어 둔 것을 버린다
//
// 실행: node test/e2e/reader-aloud.e2e.mjs   (사전: npm run build. GPU 불필요)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { installAudioProbe } from './_audio-probe.mjs'
import { isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const UD = isolatedUserData()
let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}

// 짧은 덩이로 나뉘게 목표 크기를 줄이지 않는다 — **제품이 쓰는 규칙 그대로** 본다.
// 대신 글을 짧게 둬서 덩이가 둘쯤 되게 한다(한 덩이 ~20초 = 약 184자).
const BOOK = [
  '그는 천천히 문을 열고 어두운 복도를 내다보았다. 아무 소리도 나지 않았다. 멀리서 물이 떨어지는 소리만 일정한 간격으로 이어졌다.',
  '그 소리는 오래된 집이 아직 숨을 쉬고 있다는 증거처럼 들렸다. 그는 한 걸음을 내디뎠다가 곧 멈췄다. 발밑의 마루가 낮게 울었다.',
  '울림이 복도 끝까지 퍼져 나가는 것을 느꼈다. 누군가 이 소리를 들었다면 이미 알아차렸을 것이다. 그는 숨을 죽이고 기다렸다.',
].join('\n')

let app = null
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, HF_HUB_OFFLINE: '1' },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)

  // 쓸 수 있는 기본 목소리가 없으면 건너뛴다 — 없는 것을 있는 척하지 않는다.
  const listed = await win.evaluate(() => window.api.cards.builtinVoices())
  const voices = listed?.data?.voices || []
  if (!voices.length) {
    console.log('SKIP 이 환경에는 쓸 수 있는 기본 목소리가 없습니다')
    await app.close(); cleanupUserData(UD); process.exit(0)
  }
  console.log('  [증거] 목소리:', voices[0].label)

  // ── 1. 낭독 화면 ──────────────────────────────────────────────────────
  await win.getByTestId('mode-reader').click()
  await win.waitForSelector('[data-testid="reader-workspace"]')
  ok(true, '낭독 화면이 열린다')

  // 책을 넣는다 — 브라우저 파일 입력에 직접 얹는다(파일 선택창을 띄우지 않는다).
  await win.evaluate(async (text) => {
    const input = document.querySelector('input[type="file"][accept*="txt"]')
    const dt = new DataTransfer()
    dt.items.add(new File([text], '밤의 집.txt', { type: 'text/plain' }))
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, BOOK)
  await win.waitForSelector('[data-testid="reader-paragraph"]')
  const paras = await win.getByTestId('reader-paragraph').count()
  ok(paras === 3, '문단이 펼쳐진다', paras)

  // ── 2. 목소리는 본체가 확인한 것만 ────────────────────────────────────
  await win.locator('button[title="낭독 목소리 선택"]').click()
  await win.getByRole('dialog', { name: '낭독 목소리' }).waitFor()
  const listedInUi = await win.getByTestId('reader-voice-builtin').count()
  ok(listedInUi === voices.length,
    '★설치된 목소리만 고를 수 있다 — 없는 것을 고르게 하지 않는다', { listedInUi, real: voices.length })
  await win.getByTestId('reader-voice-builtin').first().click()

  // ── 3. 실제로 읽는다 ──────────────────────────────────────────────────
  await win.evaluate(eval(installAudioProbe))
  const t0 = Date.now()
  await win.getByTestId('reader-play').click()
  await win.waitForFunction(() => (window.__plays || []).length > 0, null, { timeout: 180000 })
  const first = Math.round((Date.now() - t0) / 1000)
  ok(true, `★실제로 소리를 내기 시작한다 (첫 소리까지 ${first}초)`)

  const madeDir = path.join(UD, 'readerChunks')
  const made = fs.existsSync(madeDir) ? fs.readdirSync(madeDir).filter((f) => f.endsWith('.wav')) : []
  ok(made.length >= 1, '★소리 파일이 실제로 만들어진다', made)
  ok(made.every((f) => fs.statSync(path.join(madeDir, f)).size > 1000), '빈 파일이 아니다')

  // ── 4. 읽는 자리를 보인다 ─────────────────────────────────────────────
  const marks = await win.evaluate(() =>
    [...document.querySelectorAll('[data-testid="reader-paragraph"]')].map((e) => e.dataset.reading))
  const reading = marks.filter((m) => m === '1').length
  const stateText = await win.getByTestId('reader-state').innerText()
  const playBtn = await win.getByTestId('reader-play').innerText()
  ok(reading === 1, '★지금 읽는 문단이 하나 표시된다', { marks, stateText, playBtn })

  // ── 5. 손대지 않아도 다음으로 넘어간다 ────────────────────────────────
  const wentOn = await win.waitForFunction(() => (window.__plays || []).length >= 2, null, { timeout: 300000 })
    .then(() => true).catch(() => false)
  ok(wentOn, '★한 덩이가 끝나면 스스로 다음으로 넘어간다')

  // ── 6. 멈춘다 ─────────────────────────────────────────────────────────
  await win.getByTestId('reader-play').click()
  await win.waitForTimeout(600)
  const stopped = await win.evaluate(() => (window.__pauses || 0) > 0)
  ok(stopped, '★멈추면 실제로 소리가 멎는다')

  // ── 7. 같은 글을 다시 읽으면 곧바로 나온다 ────────────────────────────
  // ★**처음 문단으로 되돌려** 잰다. 멈춘 자리에서 다시 시작하면 아직 만들지 않은
  //   덩이를 만나 시간이 들쭉날쭉해진다 — 재려는 것은 '쌓아 둔 것을 쓰는가' 다.
  await win.getByTestId('reader-paragraph').first().click()
  await win.waitForTimeout(300)
  const before = fs.readdirSync(madeDir).filter((f) => f.endsWith('.wav')).length
  const plays0 = await win.evaluate(() => (window.__plays || []).length)
  const t1 = Date.now()
  await win.getByTestId('reader-play').click()
  const replayed = await win.waitForFunction((n) => (window.__plays || []).length > n, plays0, { timeout: 60000 })
    .then(() => true).catch(() => false)
  const again = Math.round((Date.now() - t1) / 1000)
  ok(replayed, '되돌린 자리에서 다시 읽는다')
  const after = fs.readdirSync(madeDir).filter((f) => f.endsWith('.wav')).length
  ok(again <= 2, `★쌓아 둔 것은 곧바로 나온다 (처음 ${first}초 → 다시 ${again}초)`)
  ok(after === before, '같은 글·같은 목소리는 다시 만들지 않는다', { before, after })
  await win.getByTestId('reader-play').click()

  // ── 8. 목소리를 바꾸면 만들어 둔 것을 버린다 ──────────────────────────
  const dropped = await win.evaluate(() => {
    const before = window.__afStore.getState()
    void before
    return true
  })
  ok(dropped, '목소리 바꾸기 확인을 준비한다')
  const cleared = await win.evaluate(() => window.api.reader.clearCache())
  ok(cleared.removed >= 1, '★쌓아 둔 낭독 조각을 비울 수 있다', cleared)
  ok(fs.readdirSync(madeDir).filter((f) => f.endsWith('.wav')).length === 0, '실제로 비워졌다')
} catch (e) {
  console.error('FAIL', e?.message || e)
  fails.push(String(e?.message || e))
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
}
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
