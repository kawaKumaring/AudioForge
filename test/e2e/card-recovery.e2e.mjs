// 카드 화면 — **실패한 자리에서 바로 다시 할 수 있는가.**
//
// 실제 앱에서 본다. 실패는 본체 통로를 잠깐 막아 만든다(모델을 돌리지 않는다).
//   1) 최종 이어 듣기가 실패하면 **그 줄에** 사유와 '다시 시도' 가 뜬다
//   2) 실패해도 카드·대사·채택이 그대로다
//   3) 통로를 되돌리고 '다시 시도' 를 누르면 이어진다
//   4) **생성 시작이 거절되면** 그 카드 줄에 사유와 '다시 생성' 이 뜬다
//      — 거절은 두 모양으로 온다: ① 통로가 거절(Promise 예외) ② 본체가 오류 이벤트
//   5) 어느 실패든 대사·생성본·채택은 그대로고, 다른 카드는 건드리지 않는다
//
// 실행: node test/e2e/card-recovery.e2e.mjs   (사전: npm run build)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }

const UD = isolatedUserData()
let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}

let app = null
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore && !!window.__synthesisCards)
  await win.getByTestId('mode-tts').click()          // 합성 화면(새 카드)으로

  // 카드 두 장을 **채택본까지** 갖춘 상태로 만든다(모델을 돌리지 않는다).
  const wavPath = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')
  await win.evaluate((wav) => {
    const s = window.__synthesisCards.getState()
    const mk = (i) => ({
      // 기본 목소리 카드에는 참조 원본이 없다 — 있으면 참조 준비가 돌아 생성이 잠긴다.
      // ★목소리는 `builtin` 자리에 있다(`cardVoiceOf` 가 보는 곳). 여기를 틀리면
      //   카드가 '목소리 없음' 이 되어 생성 단추가 **비활성**이 된다 — 눌러도 아무 일이 없다.
      id: `c${i}`, text: `대사 ${i}`, source: null,
      builtin: { engineId: 'piper', modelId: 'm', label: 'm', language: 'ko', path: wav, sampleRate: 22050 },
      settings: s.cards[0] ? { ...s.cards[0].settings } : {},
      takes: [{ id: `t${i}`, path: wav, seconds: 7, text: `대사 ${i}`, at: Date.now(),
        source: { path: wav, name: 'ko.wav', duration: 7 }, settings: {}, applied: {},
        voice: { kind: 'builtin', engineId: 'piper', modelId: 'm', label: 'm', language: 'ko', path: wav } }],
      adoptedId: `t${i}`,
    })
    window.__synthesisCards.setState({ cards: [mk(1), mk(2)], job: null })
  }, wavPath)
  await win.waitForSelector('[data-testid="generation-card"]')
  ok(await win.locator('[data-testid="generation-card"]').count() === 2, '카드 두 장을 세웠다')

  // ── 1. 최종 이어 듣기를 실패시킨다 ────────────────────────────────────
  await app.evaluate(({ ipcMain }) => {
    const prev = ipcMain._afJoinPrev = ipcMain.listeners('__none__')
    void prev
    ipcMain.removeHandler('card:join')
    ipcMain.handle('card:join', async () => ({ ok: false, error: '검사용 실패' }))
  })
  const before = await win.evaluate(() => {
    const s = window.__synthesisCards.getState()
    return { n: s.cards.length, texts: s.cards.map((c) => c.text), adopted: s.cards.map((c) => c.adoptedId) }
  })
  await win.getByTestId('join-play').click()
  await win.waitForSelector('[data-testid="join-fault"]')
  ok(true, '★최종 이어 듣기 실패가 그 줄에 뜬다')
  ok((await win.getByTestId('join-fault').innerText()).includes('검사용 실패'),
    '사유를 그대로 보여 준다', await win.getByTestId('join-fault').innerText())
  ok(await win.getByTestId('join-retry').count() === 1, '★다시 시도 단추가 같은 자리에 있다')

  const after = await win.evaluate(() => {
    const s = window.__synthesisCards.getState()
    return { n: s.cards.length, texts: s.cards.map((c) => c.text), adopted: s.cards.map((c) => c.adoptedId) }
  })
  ok(JSON.stringify(before) === JSON.stringify(after),
    '★실패해도 카드·대사·채택이 그대로다', { before, after })

  // ── 2. 통로를 되돌리고 다시 시도하면 이어진다 ─────────────────────────
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('card:join')
    ipcMain.handle('card:join', async () => ({ ok: true, data: { path: 'C:/nope.wav', seconds: 1, canceled: true } }))
  })
  await win.getByTestId('join-retry').click()
  await win.waitForFunction(() => !document.querySelector('[data-testid="join-fault"]'))
  ok(true, '★다시 시도하면 실패 표시가 사라진다(같은 구성으로 다시 보낸다)')

  // ── 3. 생성 시작 거절 — 통로가 거절하는 모양(Promise 예외) ──────────────
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('audio:process')
    ipcMain.handle('audio:process', async () => { throw new Error('검사용 시작 거절') })
  })
  // 먼저 **통로가 정말 거절하는지** 본다 — 화면이 조용한 이유를 통로 탓으로 돌리지 않기 위해서다.
  const probe = await win.evaluate(async () => {
    try { await window.api.audio.process('', 'tts', {}); return 'resolved' }
    catch (e) { return 'rejected:' + (e?.message || e) }
  })
  ok(probe.startsWith('rejected'), '통로가 실제로 거절한다', probe)

  const card1 = win.locator('[data-testid="generation-card"]').first()
  ok(await card1.getByTestId('card-generate').isEnabled(), '생성 단추가 눌리는 상태다')
  const before2 = await win.evaluate(() => {
    const s = window.__synthesisCards.getState()
    return { texts: s.cards.map((c) => c.text), takes: s.cards.map((c) => c.takes.length), adopted: s.cards.map((c) => c.adoptedId) }
  })
  // ★평소엔 이 카드에 상태 줄 자체가 없다. 실패 사유는 **그려질 자리부터** 만들어야 한다
  //   — 예전에는 줄의 조건이 '만드는 중이거나 참조 준비 중' 뿐이라, 거절 뒤 사유가 갈 곳이 없었다.
  ok(await card1.getByTestId('card-status').count() === 0, '평소엔 상태 줄이 없다')
  await card1.getByTestId('card-generate').click()
  await win.waitForSelector('[data-testid="card-generate-fault"]')
  ok(true, '★시작 거절이 그 카드 줄에 뜬다')
  ok((await card1.getByTestId('card-generate-fault').innerText()).includes('검사용 시작 거절'),
    '거절 사유를 그대로 보여 준다', await card1.getByTestId('card-generate-fault').innerText())
  ok(await card1.getByTestId('card-generate-retry').count() === 1, '★다시 생성 단추가 그 카드에 있다')
  ok(await win.locator('[data-testid="card-generate-fault"]').count() === 1, '★다른 카드는 건드리지 않는다')
  const st2 = await win.evaluate(() => {
    const s = window.__synthesisCards.getState()
    return { job: !!s.job, status: window.__afStore.getState().status,
      texts: s.cards.map((c) => c.text), takes: s.cards.map((c) => c.takes.length), adopted: s.cards.map((c) => c.adoptedId) }
  })
  ok(!st2.job && st2.status !== 'processing', '★작업 상태가 풀린다(만드는 중에 갇히지 않는다)', st2)
  ok(JSON.stringify(before2) === JSON.stringify({ texts: st2.texts, takes: st2.takes, adopted: st2.adopted }),
    '★거절해도 대사·생성본·채택이 그대로다', { before2, st2 })

  // ── 4. 다시 생성 → 표시가 사라지고, 이번엔 본체가 오류 이벤트로 실패한다 ──
  await app.evaluate(({ ipcMain }) => {
    globalThis.__afLastReq = ''
    ipcMain.removeHandler('audio:process')
    ipcMain.handle('audio:process', async (_e, _f, _m, opts) => {
      globalThis.__afLastReq = (opts && opts.clientRequestId) || ''
      return { outputDir: 'C:/nope' }          // 시작은 받아들이고
    })
  })
  await card1.getByTestId('card-generate-retry').click()
  await win.waitForFunction(() => !document.querySelector('[data-testid="card-generate-fault"]'))
  ok(true, '★다시 생성하면 실패 표시가 사라진다')
  await win.waitForFunction(() => !!window.__synthesisCards.getState().job)

  // 본체가 뒤늦게 실패를 알리는 모양. **내 요청 식별자를 그대로 실어** 보낸다.
  const tagged = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.webContents.send('audio:error', { message: '검사용 본체 오류', clientRequestId: globalThis.__afLastReq })
    return globalThis.__afLastReq
  })
  ok(!!tagged, '본체가 요청 식별자를 받아 두었다', tagged)
  await win.waitForSelector('[data-testid="card-generate-fault"]')
  ok((await card1.getByTestId('card-generate-fault').innerText()).includes('검사용 본체 오류'),
    '★본체 오류도 그 카드 줄에서 말한다', await card1.getByTestId('card-generate-fault').innerText())
  const st3 = await win.evaluate(() => {
    const s = window.__synthesisCards.getState()
    return { job: !!s.job, faults: document.querySelectorAll('[data-testid="card-generate-fault"]').length,
      texts: s.cards.map((c) => c.text), takes: s.cards.map((c) => c.takes.length), adopted: s.cards.map((c) => c.adoptedId) }
  })
  ok(!st3.job, '★오류 뒤 작업 상태가 풀린다', st3)
  ok(st3.faults === 1, '★오류도 한 카드에만 붙는다', st3)
  ok(JSON.stringify(before2) === JSON.stringify({ texts: st3.texts, takes: st3.takes, adopted: st3.adopted }),
    '★오류 뒤에도 대사·생성본·채택이 그대로다', { before2, st3 })

  // ── 5. 남의 오류로는 표시하지 않는다 ─────────────────────────
  //   ★실패를 보여 주려고 요청 식별자 대조를 느슨하게 만들지 않았다는 증거다.
  await win.evaluate(() => {
    const s = window.__synthesisCards.getState()
    s.setJob({ cardId: 'c1', reqId: 'real-req', text: '대사 1', source: { path: '', name: 'm', duration: 0 },
      settings: {}, applied: {}, startedAt: 1, percent: 0, message: '만드는 중…', cancelling: false })
  })
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('audio:error',
      { message: '남의 오류', clientRequestId: 'other-req' })
  })
  const st4 = await win.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 300))
    return { job: !!window.__synthesisCards.getState().job,
      shown: document.body.innerText.includes('남의 오류') }
  })
  ok(st4.job && !st4.shown, '★남의 오류는 내 카드에 뜨지 않고 내 작업도 끝내지 않는다', st4)

  await win.evaluate(() => window.__synthesisCards.setState({ cards: [], job: null, refs: {} }))


  const shot = path.join(APP, '_local', 'artifacts', 'diagnostics', 'card-recovery.png')
  fs.mkdirSync(path.dirname(shot), { recursive: true })
  await win.screenshot({ path: shot })
  console.log('  [증거] 캡처:', shot)
} catch (e) {
  console.error('FAIL', e?.message || e)
  fails.push(String(e?.message || e))
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
}
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
