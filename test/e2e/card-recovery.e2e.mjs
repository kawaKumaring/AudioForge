// 카드 화면 — **실패한 자리에서 바로 다시 할 수 있는가.**
//
// 실제 앱에서 본다. 실패는 본체 통로를 잠깐 막아 만든다(모델을 돌리지 않는다).
//   1) 최종 이어 듣기가 실패하면 **그 줄에** 사유와 '다시 시도' 가 뜬다
//   2) 실패해도 카드·대사·채택이 그대로다
//   3) 통로를 되돌리고 '다시 시도' 를 누르면 이어진다
//   4) 카드 생성이 실패하면 **그 카드 줄에** 사유와 '다시 생성' 이 뜬다
//
// 실행: node test/e2e/card-recovery.e2e.mjs   (사전: npm run build)
//
// ★이 검사는 `SynthesisCardWorkspace.tsx` 의 **미커밋 변경**(카드·최종 실패 복구 UI)에
//   기댄다. 그 파일은 Codex 의 미커밋 GUI 작업 위에 얹혀 있어 따로 커밋하지 않았다.
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
      id: `c${i}`, text: `대사 ${i}`, source: null,
      voice: { kind: 'builtin', engineId: 'piper', modelId: 'm', label: 'm', language: 'ko', path: wav },
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

  // ── 3. 카드 생성 실패는 이 검사로 **확인하지 못했다** ─────────────────
  //   `audio:process` 를 거절하도록 바꾸고(통로 거절은 확인됨) 생성을 눌렀지만
  //   카드 실패 표시도, 예전의 전역 알림도 뜨지 않았다. 즉 **이 화면은 시작 거절을
  //   삼키고 있다** — 내 변경 이전부터 그랬다. 원인을 찾지 못해 여기서는 통과로 적지
  //   않는다(확인하지 않은 것을 통과로 만들지 않는다).
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
