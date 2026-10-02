// 최종 음성 — **카드 순서대로 이어 듣고 한 파일로 저장한다.**
//
// ★2026-09-27 지시 4항 ⑤⑥을 그대로 옮겼다.
//   서로 다른 레이트·채널의 짧은 검사 WAV로 순서·간격·길이·클리핑·끝부분 보존을 본다.
//   실제 `card:join` IPC 와 `python/card_join.py` 를 탄다(모형이 아니다).
//   ★소리를 귀로 듣는 것은 이 검사의 몫이 아니다 — 길이·피크·원본 보존만 본다.
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData, makeSyntheticWav, enterStudio } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

let passed = 0
const fails = []
const check = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}
const ud = isolatedUserData()
// 서로 다른 레이트·주파수로 만든다 — 맞춰 붙이는지 길이로 본다.
const A = makeSyntheticWav(path.join(ud, 'take-a.wav'), 1, 22050, 180)
const B = makeSyntheticWav(path.join(ud, 'take-b.wav'), 1, 48000, 300)
const saveTo = path.join(ud, '최종음성.wav')

let app
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: ud, AUDIOFORGE_NO_WARMUP: '1', HF_HUB_OFFLINE: '1' },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore && !!window.__synthesisCards)
  await enterStudio(win)        // 시작 화면의 '작업실 시작'(2026-10-03)
  await app.evaluate(({ ipcMain, dialog }, dest) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: dest })
    ipcMain.removeHandler('audio:analyze-reference')
    ipcMain.handle('audio:analyze-reference', () => ({ needs_region: true, duration_sec: 8, sample_rate: 24000, channels: 1, policy: { engine: 'qwen3', required: { min_sec: 1, max_sec: null }, recommended: { min_sec: 3, max_sec: 5 } }, recommend: { ok: false } }))
  }, saveTo)
  await win.getByTestId('mode-tts').click()

  // 카드 둘 — 생성본을 하나씩 채택한다.
  await win.evaluate(([a, b]) => {
    const s = window.__synthesisCards.getState()
    const mk = (id, label, p) => ({
      id, label, source: null,
      builtin: { engineId: 'piper', modelId: 'x', label, language: 'ko', path: 'x.onnx', sampleRate: 22050 },
      text: label, adoptedId: `t-${id}`,
      settings: { speed: 1, pitch: 0, emotion: '자연스럽게', reference: 'auto', start: 0, end: 0 },
      takes: [{ id: `t-${id}`, path: p, createdAt: 1, text: label, source: { path: '', name: label, duration: 0 }, settings: { speed: 1, pitch: 0, emotion: '자연스럽게', reference: 'auto', start: 0, end: 0 }, applied: { speed: 1, pitch: 0, notes: [] } }],
    })
    window.__synthesisCards.setState({ cards: [mk('a', '첫째', a), mk('b', '둘째', b)], seeded: true })
    s.setJoins({ gap: 0.5, level: false, edges: false, gaps: {} })
  }, [A, B])
  await win.getByTestId('generation-card').first().waitFor()

  const beforeA = fs.readFileSync(A), beforeB = fs.readFileSync(B)

  // ── 이어 듣기 ────────────────────────────────────────────────────────
  check(await win.getByTestId('join-play').isEnabled(), '채택이 다 있으면 이어 들을 수 있다')
  await win.getByTestId('join-play').click()
  // 미리듣기 소리 요소는 화면에 붙지 않는다(createManagedAudio). 단추 이름으로 본다.
  await win.waitForFunction(() => {
    const b = document.querySelector('[data-testid="join-play"]')
    return b && b.getAttribute('aria-label') === '이어 듣기 멈춤'
  }, null, { timeout: 120000 }).catch(() => {})
  const playing = await win.evaluate(() =>
    document.querySelector('[data-testid="join-play"]')?.getAttribute('aria-label'))
  check(playing === '이어 듣기 멈춤', '이어 듣기가 실제로 울린다', playing)
  await win.getByTestId('join-play').click()          // 멈춘다

  // ── 파일로 저장 ─────────────────────────────────────────────────────
  await win.getByTestId('join-save').click()
  await win.waitForFunction((p) => document.body.innerText.includes(p), saveTo, { timeout: 120000 }).catch(() => {})
  check(fs.existsSync(saveTo) && fs.statSync(saveTo).size > 1000, '한 파일로 저장된다',
    { path: saveTo, bytes: fs.existsSync(saveTo) ? fs.statSync(saveTo).size : 0 })

  // 길이 = 1초 + 0.5초(빈 자리) + 1초 = 2.5초. 레이트가 달라도 변하지 않는다.
  // ★WAV 머리는 **검사 프로세스에서** 읽는다 — main 은 ESM 이라 동적 불러오기를 못 쓴다.
  const info = (() => {
    const buf = fs.readFileSync(saveTo)
    const rate = buf.readUInt32LE(24), bits = buf.readUInt16LE(34), ch = buf.readUInt16LE(22)
    let off = 12, dataLen = 0
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4), sz = buf.readUInt32LE(off + 4)
      if (id === 'data') { dataLen = sz; break }
      off += 8 + sz + (sz % 2)
    }
    return { rate, bits, ch, seconds: dataLen / (rate * ch * (bits / 8)) }
  })()
  check(Math.abs(info.seconds - 2.5) < 0.05, '순서와 간격이 길이에 그대로 나온다', info)
  check(info.rate === 48000, '높은 레이트로 맞춘다(있던 소리를 잃지 않는다)', info)

  // ★원본 생성본은 읽기만 했다.
  check(Buffer.compare(fs.readFileSync(A), beforeA) === 0 && Buffer.compare(fs.readFileSync(B), beforeB) === 0,
    '원본 생성본을 덮어쓰지 않는다')

  // ── 입력 생성본 위에는 저장할 수 없다 ───────────────────────────────
  // ★2026-09-27 검수 1항 [P1] 재현: 저장 자리를 입력 A 로 고르니 ok=true 로 A 가 늘어났다.
  //   같은 파일을 **다른 이름으로** 부르는 경우(대소문자)까지 막아야 한다.
  const aliasOfA = path.join(path.dirname(A), path.basename(A).toUpperCase())
  // ★알리는 줄이 **여럿**이다 (2026-09-28 에 첫 줄만 보고 있던 것을 고침).
  //   '재생 중' 같은 다른 status 가 앞에 오면 거절 안내를 놓친다 —
  //   제품은 멀쩡히 막고 있는데 검사만 눈뜬장님이 됐다. 이제 다 훑는다.
  const sayAll = () => win.evaluate(() => [...document.querySelectorAll('[role="status"],[role="alert"]')]
    .map((e) => (e.textContent || '').trim()).filter(Boolean).join(' | '))
  for (const [target, label] of [[A, '같은 이름'], [aliasOfA, '대소문자만 다른 이름']]) {
    await app.evaluate(({ dialog }, dest) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: dest }) }, target)
    await win.getByTestId('join-save').click()
    await win.waitForFunction(() => [...document.querySelectorAll('[role="status"],[role="alert"]')]
      .some((e) => (e.textContent || '').includes('저장할 수 없습니다')),
    null, { timeout: 60000 }).catch(() => {})
    const why2 = await sayAll()
    check(why2.includes('저장할 수 없습니다'), `입력 생성본 위에 저장하려 하면 거절한다(${label})`, why2)
    check(Buffer.compare(fs.readFileSync(A), beforeA) === 0, `거절한 뒤에도 입력 바이트가 그대로다(${label})`)
    check(!fs.existsSync(A + '.part'), `쓰다 만 임시 파일을 남기지 않는다(${label})`)
  }
  // 취소해도 입력은 그대로다.
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }) })
  await win.getByTestId('join-save').click()
  await win.waitForTimeout(800)
  check(Buffer.compare(fs.readFileSync(A), beforeA) === 0 && Buffer.compare(fs.readFileSync(B), beforeB) === 0,
    '저장을 취소해도 입력 바이트가 그대로다')

  // ── 채택이 빠지면 조용히 건너뛰지 않는다 ────────────────────────────
  await win.evaluate(() => {
    const s = window.__synthesisCards.getState()
    s.update(s.cards[1].id, { adoptedId: null })
  })
  await win.waitForTimeout(300)
  check(await win.getByTestId('join-play').isDisabled(), '채택이 빠지면 이어 듣기를 막는다')
  check(await win.getByTestId('join-save').isDisabled(), '채택이 빠지면 저장도 막는다')
  const why = await win.getByTestId('join-save').getAttribute('title')
  check((why || '').includes('채택'), '무엇이 필요한지 말한다', why)

  // ── 준비 중에 계획이 바뀌면 이전 결과를 재생하지 않는다 ────────────────────
  // ★2026-09-27 검수 2항 [P2] 재현: A 채택으로 시작 → 계획을 바꿈 → A 응답이 오자
  //   `old-plan-a-preview.wav` 가 그대로 울렸다. 여기서는 **응답을 늦춰** 그 창을 만든다.
  const OLD = makeSyntheticWav(path.join(ud, 'old-plan-preview.wav'), 1, 22050, 440)
  await win.evaluate(() => {
    const s = window.__synthesisCards.getState()
    s.update(s.cards[1].id, { adoptedId: 't-b' })      // 앞 단계에서 뺀 채택을 되돌린다
  })
  await win.evaluate(() => {
    window.__playedSrc = []
    const orig = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function patched(...a) {
      window.__playedSrc.push(this.src)
      return orig.apply(this, a)
    }
  })
  await app.evaluate(({ ipcMain }, oldPath) => {
    ipcMain.removeHandler('card:join')
    ipcMain.handle('card:join', async () => {
      await new Promise((r) => setTimeout(r, 2500))          // 사용자가 화면을 바꿀 만큼의 시간
      return { ok: true, data: { path: oldPath, seconds: 1, peak: 0.5, sampleRate: 22050 } }
    })
  }, OLD)

  await win.waitForTimeout(300)
  await win.getByTestId('join-play').click()
  await win.waitForTimeout(400)
  // 준비 중에 간격을 바꾼다 — 계획 지문이 달라진다.
  await win.evaluate(() => window.__synthesisCards.getState().setJoins({ gap: 1.4, level: false, edges: false, gaps: {} }))
  await win.waitForTimeout(3000)
  const late = await win.evaluate(() => ({
    played: window.__playedSrc.length,
    notice: (document.querySelector('[role="status"]')?.textContent || '').trim(),
    label: document.querySelector('[data-testid="join-play"]')?.getAttribute('aria-label'),
  }))
  check(late.played === 0, '계획이 바뀌면 늦게 온 이전 결과를 재생하지 않는다', late)
  check(late.notice.includes('다시 들어'), '왜 울리지 않았는지 말한다', late.notice)
  check(late.label === '전체 이어 듣기', '준비 중 표시에 갇히지 않는다', late.label)

  // 화면을 떠난 사이에 온 응답도 재생하지 않는다.
  await win.evaluate(() => { window.__playedSrc = [] })
  await win.getByTestId('join-play').click()
  await win.waitForTimeout(400)
  await win.evaluate(() => window.__synthesisCards.getState().setView('legacy'))
  await win.waitForTimeout(3000)
  const gone = await win.evaluate(() => window.__playedSrc.length)
  check(gone === 0, '화면을 떠난 뒤 온 결과도 재생하지 않는다', gone)

  console.log('RESULT', passed, 'checks ·', fails.length, 'fail')
  console.log('  [증거] 저장 파일:', saveTo)
  if (fails.length) { console.error('실패:', fails.join(' / ')); process.exit(1) }
} catch (e) {
  console.error('예외:', e?.stack || e?.message || e)
  process.exit(1)
} finally {
  if (app) await app.close()
  cleanupUserData(ud)
}
