// 생성 카드의 **연결 경계** 회귀 검사 — 실제 Electron, 실제 설정 파일.
//
// 2026-09-27 검수에서 격리 재현으로 드러난 다섯 가지를 그대로 옮겼다.
//   1. 빠른 메뉴 이동에서 마지막 편집이 저장되지 않는다.
//   2. 저장 실패 응답을 버린다.
//   3. 복원을 거절하고 새 작업을 편집하면 이전 문서가 덮어써진다.
//   4. 삭제 되돌리기 후 목소리 준비 상태가 사라진다.
//   5. 생성 결과 수신부에서 요청 ID를 대조하지 않는다.
// 여기에 관리자 지시의 **취소·실패·재시작 복원**을 더했다.
//
// ★모델·GPU·음성 생성을 쓰지 않는다. 합성 이벤트는 주입한다 —
//   이것은 **수신부 계약** 검사이지 음질 검사가 아니다.
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import { isolatedUserData, cleanupUserData, makeSyntheticWav } from './_e2e-helper.mjs'

const root = process.cwd()
const ud = isolatedUserData()
const src = makeSyntheticWav(path.join(ud, 'card-conn.wav'), 8)
let passed = 0
const fails = []
const check = (v, label) => { if (v) { passed++; console.log('PASS', label) } else { fails.push(label); console.log('FAIL', label) } }

/** 앱을 띄우고 카드 화면까지 간다. 설정은 **진짜 파일**을 쓴다(재시작을 보려면 필요하다). */
async function launch() {
  const app = await electron.launch({
    args: ['out/main/index.js'], cwd: root,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: ud, AUDIOFORGE_NO_WARMUP: '1', HF_HUB_OFFLINE: '1', AF_E2E_SELECT_FILE: src },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(12000)
  await win.waitForFunction(() => !!window.__afStore && !!window.__synthesisCards)
  await app.evaluate(({ ipcMain }, s) => {
    const replace = (c, f) => { ipcMain.removeHandler(c); ipcMain.handle(c, f) }
    replace('card:extract-audio', () => ({ ok: true, data: s }))
    replace('analysis:prewarm', () => ({ ready: false }))
    replace('analysis:analyze', (_e, r) => ({ ok: false, requestId: r.requestId, code: 'WORKER_UNAVAILABLE', reason: 'e2e' }))
    replace('audio:analyze-reference', () => ({
      valid_whole: false, too_short: false, needs_region: true, duration_sec: 8, sample_rate: 24000, channels: 1,
      policy: { engine: 'qwen3', required: { min_sec: 1, max_sec: null }, recommended: { min_sec: 3, max_sec: 5 } },
      recommend: { ok: false },
    }))
    replace('audio:process', () => { throw Error('이 검사는 실제 합성을 돌리지 않는다') })
  }, src)
  await win.evaluate((p) => window.__afStore.setState({
    fileInfo: { path: p, name: 'card-conn.wav', duration: 8, channels: 1, sampleRate: 24000, format: 'wav' },
  }), src)
  await win.getByTestId('mode-tts').click()
  await win.getByTestId('generation-card').first().waitFor()
  return { app, win }
}

// 저장본은 **검사 프로세스에서 직접 읽는다** — main 은 ESM 이라 require 가 없다.
const SETTINGS = path.join(ud, 'settings.json')
const savedDoc = () => {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf-8')).synthesisCards ?? null } catch { return null }
}

try {
  // ── 1. 메뉴를 빨리 옮겨도 마지막 편집이 남는가 ───────────────────────
  let { app, win } = await launch()
  await win.getByTestId('card-script').first().fill('처음 대사')
  await win.waitForTimeout(900)                       // 한 번 저장되게 둔다
  await win.getByTestId('card-script').first().fill('떠나기 직전 대사')
  await win.getByTestId('mode-music').click()         // 600ms 안에 화면을 뜬다
  await win.waitForTimeout(1200)
  let doc = savedDoc()
  check(doc?.current?.cards?.[0]?.text === '떠나기 직전 대사',
    '메뉴를 옮겨도 마지막 편집이 저장된다')

  // ── 4. 삭제 → 되돌리기가 준비 상태를 되살리는가 ─────────────────────
  await win.getByTestId('mode-tts').click()
  await win.getByTestId('generation-card').first().waitFor()
  await win.evaluate((p) => {
    const s = window.__synthesisCards.getState()
    s.setRef(s.cards[0].id, { phase: 'ready', clip: p, audio: p, region: { start: 0, duration: 5 }, message: '', reqId: 'ready-1' })
  }, src)
  await win.waitForTimeout(150)
  await win.getByRole('button', { name: '1번 카드 삭제', exact: true }).click()
  await win.getByRole('button', { name: '되돌리기', exact: true }).click()
  await win.waitForTimeout(400)
  const undone = await win.evaluate(() => {
    const s = window.__synthesisCards.getState()
    return { ref: s.refs[s.cards[0].id] ?? null, disabled: document.querySelector('[data-testid="card-generate"]')?.disabled }
  })
  check(undone.ref?.phase === 'ready', '되돌리기가 목소리 준비 상태를 되살린다')
  check(undone.disabled === false, '되돌린 카드의 생성 단추가 풀린다')

  // ── 5. 지난 요청의 결과를 붙이지 않는가 ─────────────────────────────
  await win.evaluate(() => {
    const s = window.__synthesisCards.getState(), c = s.cards[0]
    s.setJob({
      cardId: c.id, reqId: 'NEW-request', text: '지금 요청의 대사', source: c.source, settings: c.settings,
      applied: { speed: 1, pitch: 0, notes: [] }, startedAt: Date.now(), percent: 0, message: '', cancelling: false,
    })
  })
  await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents
    .send('audio:result', { clientRequestId: 'OLD-request', tracks: [{ path: p }] }), src)
  await win.waitForTimeout(250)
  let after = await win.evaluate(() => {
    const s = window.__synthesisCards.getState()
    return { takes: s.cards[0].takes.length, job: !!s.job }
  })
  check(after.takes === 0, '지난 요청의 결과가 지금 대사와 묶이지 않는다')
  check(after.job === true, '남의 응답으로 내 작업을 끝내지 않는다')

  // 식별자 없는 결과도 마찬가지다.
  await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents
    .send('audio:result', { tracks: [{ path: p }] }), src)
  await win.waitForTimeout(250)
  after = await win.evaluate(() => window.__synthesisCards.getState().cards[0].takes.length)
  check(after === 0, '식별자 없는 결과도 붙이지 않는다')

  // 내 요청의 결과는 받는다 — **요청 당시 대사**와 함께.
  await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents
    .send('audio:result', { clientRequestId: 'NEW-request', tracks: [{ path: p }] }), src)
  await win.waitForTimeout(300)
  const mine = await win.evaluate(() => {
    const s = window.__synthesisCards.getState()
    return { n: s.cards[0].takes.length, text: s.cards[0].takes[0]?.text, job: !!s.job }
  })
  check(mine.n === 1 && mine.text === '지금 요청의 대사', '내 요청의 결과는 그때의 대사와 함께 붙는다')
  check(mine.job === false, '결과를 받으면 작업이 내려간다')

  // ── 실패 이벤트 ─────────────────────────────────────────────────────
  await win.evaluate(() => {
    const s = window.__synthesisCards.getState(), c = s.cards[0]
    s.setJob({
      cardId: c.id, reqId: 'FAIL-req', text: '실패할 대사', source: c.source, settings: c.settings,
      applied: { speed: 1, pitch: 0, notes: [] }, startedAt: Date.now(), percent: 0, message: '', cancelling: false,
    })
  })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents
    .send('audio:error', { clientRequestId: 'FAIL-req', message: '엔진이 멈췄습니다' }))
  await win.waitForTimeout(300)
  const failed = await win.evaluate(() => ({
    job: !!window.__synthesisCards.getState().job,
    takes: window.__synthesisCards.getState().cards[0].takes.length,
    shown: document.body.innerText.includes('엔진이 멈췄습니다'),
  }))
  check(failed.job === false, '실패하면 작업이 풀린다 — 만드는 중에 갇히지 않는다')
  check(failed.shown === true, '실패 사유를 화면이 말한다')
  check(failed.takes === 1, '실패가 이전 생성본을 지우지 않는다')

  // ── 취소 ────────────────────────────────────────────────────────────
  await win.evaluate(() => {
    const s = window.__synthesisCards.getState(), c = s.cards[0]
    s.setJob({
      cardId: c.id, reqId: 'CANCEL-req', text: '멈출 대사', source: c.source, settings: c.settings,
      applied: { speed: 1, pitch: 0, notes: [] }, startedAt: Date.now(), percent: 0, message: '', cancelling: false,
    })
  })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents
    .send('audio:cancelled', { clientRequestId: 'CANCEL-req' }))
  await win.waitForTimeout(300)
  const cancelled = await win.evaluate(() => ({
    job: !!window.__synthesisCards.getState().job,
    takes: window.__synthesisCards.getState().cards[0].takes.length,
  }))
  check(cancelled.job === false, '취소하면 작업이 풀린다')
  check(cancelled.takes === 1, '취소가 여기까지 만든 생성본을 지우지 않는다')

  // ★2차 검수: 식별자 없는 취소를 넣었더니 내 작업이 사라졌다('없으면 내 것' 예외 때문).
  await win.evaluate(() => {
    const s = window.__synthesisCards.getState(), c = s.cards[0]
    s.setJob({
      cardId: c.id, reqId: 'STRICT-req', text: '남의 취소에 끝나면 안 되는 대사', source: c.source, settings: c.settings,
      applied: { speed: 1, pitch: 0, notes: [] }, startedAt: Date.now(), percent: 0, message: '', cancelling: false,
    })
  })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('audio:cancelled', {}))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('audio:cancelled', { clientRequestId: 'SOMEONE-ELSE' }))
  await win.waitForTimeout(300)
  const strict = await win.evaluate(() => ({
    job: !!window.__synthesisCards.getState().job,
    notice: (document.querySelector('[role="status"]')?.textContent || '').trim(),
  }))
  check(strict.job === true, '식별자 없는 취소가 내 작업을 끝내지 않는다', strict)
  check(!strict.notice.includes('붙이지 못했습니다'), '남의 신호로 실패 알림을 띄우지 않는다', strict)
  await win.evaluate(() => window.__synthesisCards.getState().setJob(null))

  await app.close()

  // ── 3 + 재시작: 거절해도 이전 문서가 남는가 ─────────────────────────
  ;({ app, win } = await launch())
  await win.getByRole('button', { name: '현재 작업 계속', exact: true }).click()
  await win.getByTestId('card-script').first().fill('거절 뒤 새 작업')
  await win.waitForTimeout(1200)
  doc = savedDoc()
  check(doc?.current?.cards?.[0]?.text === '거절 뒤 새 작업', '새 작업이 저장된다')
  check(Array.isArray(doc?.kept) && doc.kept.length >= 1,
    '되살리기를 거절해도 이전 문서가 남는다')
  check(doc?.kept?.[0]?.cards?.[0]?.text === '떠나기 직전 대사',
    '남은 이전 문서가 그때 내용 그대로다')
  await app.close()

  // ── 재시작 뒤 이전 작업에 닿는가 ────────────────────────────────────
  ;({ app, win } = await launch())
  const choices = await win.getByRole('dialog').getByRole('button', { name: '불러오기', exact: true }).count()
  check(choices >= 2, '재시작 뒤 지금 작업과 보관된 작업을 모두 고를 수 있다')
  await win.getByRole('dialog').getByRole('button', { name: '불러오기', exact: true }).nth(1).click()
  await win.waitForTimeout(600)
  const loaded = await win.evaluate(() => window.__synthesisCards.getState().cards[0]?.text)
  check(loaded === '떠나기 직전 대사', '보관된 이전 작업을 실제로 되살린다')

  // ── 2. 저장 실패를 삼키지 않는가 ────────────────────────────────────
  // ★실제 파일 쓰기는 위 검사들이 이미 확인했다. 여기서 보는 것은 **실패를 알리는가**와
  //   **다시 시도가 같은 내용으로 통로까지 닿는가** 다.
  await app.evaluate(({ ipcMain }) => {
    globalThis.__failSave = true
    globalThis.__lastSave = null
    ipcMain.removeHandler('settings:set')
    ipcMain.handle('settings:set', (_e, k, v) => {
      if (globalThis.__failSave) return { ok: false, code: 'E2E_DISK_FULL' }
      globalThis.__lastSave = { key: k, value: v }
      return { ok: true }
    })
  })
  await win.getByTestId('card-script').first().fill('저장이 실패할 대사')
  await win.getByTestId('card-save-failed').waitFor()
  check(true, '저장 실패를 화면이 알린다')
  await app.evaluate(() => { globalThis.__failSave = false })
  await win.getByRole('button', { name: '다시 저장', exact: true }).click()
  await win.waitForTimeout(700)
  const retried = await app.evaluate(() => globalThis.__lastSave)
  check(retried?.key === 'synthesisCards', '다시 저장이 같은 자리로 간다')
  check(retried?.value?.current?.cards?.[0]?.text === '저장이 실패할 대사',
    '다시 저장이 마지막 내용을 그대로 보낸다')
  check(await win.getByTestId('card-save-failed').count() === 0, '성공하면 실패 표시가 사라진다')
  await app.close()

  // ── 마지막 편집 직후 종료 → 재시작 ─────────────────────────────────
  // ★비동기 저장은 창이 닫히면 사라진다. 동기 통로로 남기는지 본다.
  ;({ app, win } = await launch())
  await win.getByRole('button', { name: '현재 작업 계속', exact: true }).click().catch(() => {})
  await win.getByTestId('card-script').first().fill('닫기 직전에 친 대사')
  await app.close()                       // 기다리지 않고 바로 닫는다
  doc = savedDoc()
  check(doc?.current?.cards?.[0]?.text === '닫기 직전에 친 대사',
    '마지막 편집 직후 종료해도 남는다', doc?.current?.cards?.[0]?.text)

  // ── 보관본을 골라도 하던 작업이 남는가 (실제 설정 파일) ────────────
  // current=A, kept=[B] 로 세워 두고 B 를 고른 뒤 고쳐 저장한다.
  {
    const mk = (t) => ({
      savedAt: Date.now(), joins: { gap: .35 },
      cards: [{ id: 'card-' + t, label: t, sourcePath: src, sourceName: 'card-conn.wav', sourceDuration: 8, text: t, settings: { speed: 1, pitch: 0, emotion: '자연스럽게', reference: 'auto', start: 0, end: 8 }, takes: [], adoptedId: null }],
    })
    const before = JSON.parse(fs.readFileSync(SETTINGS, 'utf-8'))
    before.synthesisCards = { current: mk('작업 A'), kept: [mk('작업 B')] }
    fs.writeFileSync(SETTINGS, JSON.stringify(before), 'utf-8')
  }
  ;({ app, win } = await launch())
  await win.getByRole('dialog').getByRole('button', { name: '불러오기', exact: true }).nth(1).click()
  await win.waitForTimeout(700)
  check(await win.evaluate(() => window.__synthesisCards.getState().cards[0]?.text) === '작업 B',
    '보관본을 골라 불러온다')
  await win.getByTestId('card-script').first().fill('작업 B 를 고쳤다')
  await win.waitForTimeout(1200)
  doc = savedDoc()
  const keptTexts = (doc?.kept || []).map((w) => w.cards[0].text)
  check(doc?.current?.cards?.[0]?.text === '작업 B 를 고쳤다', '고른 작업이 지금 것이 된다')
  check(keptTexts.includes('작업 A'), '보관본을 꺼낼 때 하던 작업을 잃지 않는다', { keptTexts })
  await app.close()

  // 재시작 뒤 A 와 B 가 모두 잡히는가.
  ;({ app, win } = await launch())
  const both = await win.getByRole('dialog').getByRole('button', { name: '불러오기', exact: true }).count()
  check(both >= 2, '재시작 뒤에도 두 작업 모두 고를 수 있다', { both })
  await app.close()

  console.log('RESULT', passed, 'checks ·', fails.length, 'fail')
  if (fails.length) { console.error('실패:', fails.join(' / ')); process.exit(1) }
} catch (e) {
  console.error('예외:', e?.message || e)
  process.exit(1)
} finally {
  cleanupUserData(ud)
}
