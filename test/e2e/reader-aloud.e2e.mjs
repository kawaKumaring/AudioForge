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
//   7) 글과 목소리 파일을 **실제 단추로** 고르고, 불러온 폴더를 **각자** 기억한다
//      (목소리를 바꾸면 만들어 둔 것을 버리는 규칙은 `readerQueue.test.ts` 가 지킨다)
//   8) 읽는 **구절**을 칠하고 화면 안에 둔다 · 따라가기·괄호 속 한자 설정이 껐다 켜도 남는다
//
// 실행: node test/e2e/reader-aloud.e2e.mjs   (사전: npm run build. GPU 불필요)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { installAudioProbe } from './_audio-probe.mjs'
import { isolatedUserData, cleanupUserData, cleanupIsolated, makeSyntheticWav } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const UD = isolatedUserData()
// 글과 목소리 파일은 **서로 다른 폴더**에 둔다 — 각자 따로 기억하는지 보려고.
// 폴더 이름은 한글로 둔다 — 사용자의 실제 폴더가 그렇다.
const ISO = path.join(os.tmpdir(), 'audioforge_e2e_' + randomUUID())
const TEXT_DIR = path.join(ISO, '소설')
const VOICE_DIR = path.join(ISO, '목소리')
const BOOK_PATH = path.join(TEXT_DIR, '밤의 집.txt')
const VOICE_PATH = path.join(VOICE_DIR, '참조.wav')
const savedSetting = (key) => {
  try { return JSON.parse(fs.readFileSync(path.join(UD, 'settings.json'), 'utf-8'))[key] } catch { return undefined }
}
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
fs.mkdirSync(TEXT_DIR, { recursive: true })
fs.writeFileSync(BOOK_PATH, BOOK, 'utf-8')
makeSyntheticWav(VOICE_PATH, 3)

let app = null
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, HF_HUB_OFFLINE: '1', AF_E2E_SELECT_FILE: BOOK_PATH },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)

  // 쓸 수 있는 기본 목소리가 없으면 건너뛴다 — 없는 것을 있는 척하지 않는다.
  const listed = await win.evaluate(() => window.api.cards.builtinVoices())
  const voices = listed?.data?.voices || []
  if (!voices.length) {
    console.log('SKIP 이 환경에는 쓸 수 있는 기본 목소리가 없습니다')
    await app.close(); cleanupUserData(UD); cleanupIsolated(ISO); process.exit(0)
  }
  console.log('  [증거] 목소리:', voices[0].label)

  // ── 1. 낭독 화면 ──────────────────────────────────────────────────────
  await win.getByTestId('mode-reader').click()
  await win.waitForSelector('[data-testid="reader-workspace"]')
  ok(true, '낭독 화면이 열린다')

  // 책을 넣는다 — **실제 단추**를 누른다. 검사는 운영체제 선택창만 대신하고,
  //   그 뒤(읽기·기억)는 사용자가 누를 때와 같다.
  // ★예전에는 숨은 입력칸에 파일을 직접 얹어서 단추도, 여는 자리도 지나지 않았다.
  await win.getByTestId('reader-add-text').click()
  await win.waitForSelector('[data-testid="reader-paragraph"]')
  const paras = await win.getByTestId('reader-paragraph').count()
  ok(paras === 3, '문단이 펼쳐진다', paras)
  ok(savedSetting('lastTextDir') === TEXT_DIR, '★글을 불러온 폴더를 기억한다', savedSetting('lastTextDir'))
  ok(savedSetting('lastDir') === undefined, '글을 고른 것이 음원 기억을 덮지 않는다', savedSetting('lastDir'))

  // ── 2. 목소리는 본체가 확인한 것만 ────────────────────────────────────
  await win.getByTestId('reader-settings').click()
  await win.getByRole('dialog', { name: '낭독 설정' }).waitFor()
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
  // 읽는 **구절** — 문단보다 작은 단위다. 칠해진 글이 실제 책의 글이고, 화면 안에 있다.
  const phrase = await win.evaluate(() => {
    const els = [...document.querySelectorAll('[data-testid="reader-phrase"]')]
    const r = els[0]?.getBoundingClientRect()
    return { n: els.length, text: els.map((e) => e.textContent).join(''),
      inView: !!r && r.bottom > 0 && r.top < window.innerHeight }
  })
  ok(phrase.n >= 1 && phrase.text.length > 10 && BOOK.includes(phrase.text.slice(0, 10)),
    '★지금 읽는 구절을 칠한다', { n: phrase.n, len: phrase.text.length })
  ok(phrase.inView, '★읽는 구절이 화면 안에 있다 — 따라간다', phrase)

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

  // ★동시에 여럿을 요청해도 **모두** 만든다 (2026-09-30 사용자 신고: "붉은색으로 경로가 빠르게
  //   보였다 사라진다"). 목소리·설정을 바꾸면 앞 작업이 도는 채로 새 작업이 들어온다 — 예전에는
  //   둘이 같은 자리·같은 이름에 쓰다가 하나가 "다른 프로세스가 파일을 사용 중" 으로 죽었다.
  const burst = await win.evaluate(async (v) => {
    const stamp = Date.now()
    const texts = [0, 1, 2].map((k) => `동시에 만드는 시험 문장 ${k}번입니다. ${stamp}`)
    const got = await Promise.all(texts.map((t) =>
      window.api.reader.speak(t, { kind: 'builtin', path: v.path, engineId: v.engineId }, 'burst')))
    return got.map((r) => ({ ok: !!r.data?.path, error: r.error || '', name: (r.data?.path || '').split(/[\\/]/).pop() }))
  }, voices[0])
  ok(burst.every((b) => b.ok), '★동시에 셋을 요청해도 셋 다 만든다', burst)
  ok(new Set(burst.map((b) => b.name)).size === 3, '셋이 서로 다른 소리다 — 남의 소리를 가져가지 않는다', burst)
  ok(burst.every((b) => !/Command failed|[A-Za-z]:[\\/]/.test(b.error)), '실패해도 명령줄·폴더 경로를 보이지 않는다', burst)
  const workLeft = fs.existsSync(path.join(madeDir, 'work')) ? fs.readdirSync(path.join(madeDir, 'work')) : []
  ok(workLeft.length === 0, '작업 자리를 남기지 않는다', workLeft)
  await win.getByTestId('reader-play').click()

  // ── 8. 목소리 파일을 고른다 — 불러온 폴더를 기억한다 ────────────────────
  // ★예전 이 자리의 검사는 **아무것도 보지 않고 통과했다**(2026-09-29 재조사에서 찾음).
  //   목소리를 바꾸면 만들어 둔 것을 버리는 규칙은 `readerQueue.test.ts` 가 지킨다.
  //   여기서는 실제 단추로 목소리 파일을 고르는 길을 본다. 재생은 하지 않는다 —
  //   참조 목소리 합성은 GPU 로 수십 초가 들고, 이 검사가 보려는 것이 아니다.
  await win.evaluate((p) => window.api.audio.e2eSetSelectFile(p), VOICE_PATH)
  await win.getByTestId('reader-settings').click()
  await win.getByRole('dialog', { name: '낭독 설정' }).waitFor()
  await win.getByTestId('reader-voice-file').click()
  const picked = await win.waitForFunction(() =>
    (document.querySelector('[data-testid="reader-settings"]')?.textContent || '').includes('참조.wav'),
  null, { timeout: 10000 }).then(() => true).catch(() => false)
  ok(picked, '★고른 목소리 파일로 바뀐다')
  ok(savedSetting('lastVoiceDir') === VOICE_DIR, '★목소리를 불러온 폴더를 기억한다', savedSetting('lastVoiceDir'))
  ok(savedSetting('lastTextDir') === TEXT_DIR, '목소리를 고른 것이 글 기억을 덮지 않는다', savedSetting('lastTextDir'))
  const cleared = await win.evaluate(() => window.api.reader.clearCache())
  ok(cleared.removed >= 1, '★쌓아 둔 낭독 조각을 비울 수 있다', cleared)
  ok(fs.readdirSync(madeDir).filter((f) => f.endsWith('.wav')).length === 0, '실제로 비워졌다')
  // ── 9. ★껐다 켜도 책과 읽던 자리가 남는다 (인수인계 6항) ──────────────
  await win.getByTestId('reader-paragraph').nth(2).click()
  await win.waitForTimeout(900)              // 저장은 편집이 멎은 뒤에 쓴다
  const bookFiles = fs.existsSync(path.join(UD, 'works', 'books'))
    ? fs.readdirSync(path.join(UD, 'works', 'books')).filter((f) => f.endsWith('.json')) : []
  ok(bookFiles.length === 1, '★책 하나가 파일 하나다', bookFiles)
  // 낭독 설정을 바꿔 둔다 — 껐다 켠 뒤에도 남아야 한다(저장 허용 목록을 끝에서 끝까지 본다).
  ok(await win.getByTestId('reader-follow').getAttribute('aria-pressed') === 'true', '따라가기는 처음에 켜져 있다')
  await win.getByTestId('reader-follow').click()
  await win.getByTestId('reader-settings').click()
  await win.getByRole('dialog', { name: '낭독 설정' }).waitFor()
  ok(!(await win.getByTestId('reader-skip-hanja').isChecked()), '괄호 속 한자 건너뛰기는 처음에 꺼져 있다')
  await win.getByTestId('reader-skip-hanja').check()
  await win.keyboard.press('Escape')
  await win.waitForTimeout(400)
  const savedPrefs = savedSetting('readerPrefs')
  ok(savedPrefs?.follow === false && savedPrefs?.skipHanjaInParens === true, '★낭독 설정이 설정 파일에 적힌다', savedPrefs)
  await app.close(); app = null

  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, HF_HUB_OFFLINE: '1' },
  })
  const win2 = await app.firstWindow()
  win2.setDefaultTimeout(30000)
  await win2.waitForFunction(() => !!window.__afStore)
  await win2.getByTestId('mode-reader').click()
  await win2.waitForSelector('[data-testid="reader-paragraph"]')
  const back = await win2.getByTestId('reader-paragraph').count()
  ok(back === 3, '★껐다 켜도 책이 그대로 있다', back)
  const where = await win2.getByTestId('reader-state').innerText()
  ok(where.includes('3 / 3'), '★읽던 자리도 그대로다', where)
  // ★저장은 되는데 다시 켜면 사라지는 일이 있었다(읽기 목록 누락, 2026-09-28) — 그것까지 본다.
  await win2.waitForFunction(() => document.querySelector('[data-testid="reader-follow"]')?.getAttribute('aria-pressed') === 'false',
    null, { timeout: 5000 }).catch(() => {})
  ok(await win2.getByTestId('reader-follow').getAttribute('aria-pressed') === 'false', '★껐다 켜도 따라가기 설정이 남는다')
  await win2.getByTestId('reader-settings').click()
  await win2.getByRole('dialog', { name: '낭독 설정' }).waitFor()
  ok(await win2.getByTestId('reader-skip-hanja').isChecked(), '★껐다 켜도 괄호 속 한자 설정이 남는다')
  await win2.keyboard.press('Escape')

  // 목록에서 빼면 **그 파일만** 사라진다
  // 책 목록은 서재 팝업에 있다(2026-09-30 피드백: 본문 옆 칸이 화면을 채웠다).
  await win2.getByTestId('reader-library').click()
  await win2.locator('[aria-label$="목록에서 빼기"]').first().click()
  await win2.waitForTimeout(700)
  const left = fs.existsSync(path.join(UD, 'works', 'books'))
    ? fs.readdirSync(path.join(UD, 'works', 'books')).filter((f) => f.endsWith('.json')) : []
  ok(left.length === 0, '★빼면 그 기록이 실제로 지워진다', left)
} catch (e) {
  console.error('FAIL', e?.message || e)
  fails.push(String(e?.message || e))
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
  cleanupIsolated(ISO)
}
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
