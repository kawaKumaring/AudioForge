// 생성 카드 — **본체를 통과하는** 요청 식별자 검사.
//
// ★왜 따로 있나 (2026-09-27 2차 검수)
//   연결 검사(synthesis-cards-connection)는 이벤트를 화면에 **직접 주입**한다. 그래서
//   본체가 마감 이벤트에서 식별자를 잃는 것을 잡지 못했다 — `done` 에서 값을 비웠는데
//   result 와 보류된 error 는 그 **뒤에** 나갔다.
//   여기서는 실제 `audio:process` IPC 와 PythonRunner 를 탄다. 모델만 저장소의
//   `fixtures/synthetic_tree.py` 로 갈아 끼운다. 사용자 음원·GPU·모델을 쓰지 않는다.
//
// 경로: 화면 → 본체 → 작업 프로세스 → 본체 → 카드. 성공·오류·취소 셋 다 본다.
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData, makeSyntheticWav } from './_e2e-helper.mjs'

const APP = process.cwd()
const FIXTURE = path.join(APP, 'test', 'e2e', 'fixtures', 'synthetic_tree.py')
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }
if (!fs.existsSync(FIXTURE)) { console.error('fixture 없음'); process.exit(2) }

let passed = 0
const fails = []
const check = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}

/** 한 판 띄운다. 모델만 fixture 로 갈아 끼우고 **합성 통로는 진짜**다. */
// ★판마다 **새 저장소**를 쓴다. 같은 자리를 쓰면 앞 판의 작업이 되살리기 물음으로 끼어들어
//   뒤 판이 자기 카드를 못 만든다(첫 실행에서 실제로 막혔다).
async function launch(mode) {
  const ud = isolatedUserData()
  const src = makeSyntheticWav(path.join(ud, 'main-path.wav'), 8)
  const app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: {
      ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: ud, AUDIOFORGE_NO_WARMUP: '1', HF_HUB_OFFLINE: '1',
      AF_E2E_TTS_SCRIPT: FIXTURE, AF_E2E_FIXTURE_MODE: mode,
    },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore && !!window.__synthesisCards)
  // 준비(참조 분석)는 이 검사의 대상이 아니다 — 합성 통로만 진짜로 둔다.
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
  }, src)
  // 본체가 실제로 실어 보내는 식별자를 그대로 적는다 — 보고에 쓸 증거다.
  await win.evaluate(() => {
    window.__ev = []
    const note = (kind) => (d) => window.__ev.push([kind, (d && d.clientRequestId) ?? null])
    window.api.audio.onProgress(note('progress'))
    window.api.audio.onResult(note('result'))
    window.api.audio.onError(note('error'))
    window.api.audio.onCancelled(note('cancelled'))
  })
  await win.evaluate((p) => window.__afStore.setState({
    fileInfo: { path: p, name: 'main-path.wav', duration: 8, channels: 1, sampleRate: 24000, format: 'wav' },
  }), src)
  await win.getByTestId('mode-tts').click()
  await win.getByTestId('generation-card').first().waitFor()
  // 준비된 목소리를 얹어 생성 단추를 연다(준비 경로는 다른 검사가 본다).
  await win.evaluate((p) => {
    const s = window.__synthesisCards.getState()
    s.setRef(s.cards[0].id, { phase: 'ready', clip: p, audio: p, region: { start: 0, duration: 5 }, message: '', reqId: 'ready-main' })
  }, src)
  await win.getByTestId('card-script').first().fill('본체 통과 검사 대사')
  await win.waitForTimeout(250)
  return { app, win, ud }
}

const evOf = (win) => win.evaluate(() => window.__ev)
/** 본체가 실제로 실어 보낸 식별자를 사람이 읽을 한 줄로. 보고에 그대로 쓴다. */
const trace = (label, ev, req) => console.log('  [증거]', label,
  ev.map(([k, id]) => `${k} ID=${id === null ? 'undefined' : (id === req ? '요청과 같음' : id)}`).join(' → '))
const jobReq = (win) => win.evaluate(() => window.__synthesisCards.getState().job?.reqId ?? null)
const cardState = (win) => win.evaluate(() => {
  const s = window.__synthesisCards.getState()
  // 알림은 role="status" 줄에 뜬다. **무슨 글자인지까지 적어 둔다** — 보고의 증거다.
  const box = document.querySelector('[role="status"]')
  return {
    job: !!s.job, takes: s.cards[0].takes.map((t) => t.text),
    notice: (box?.textContent || '').trim(),
  }
})

const spent = []


try {
  // ── 성공 경로 ────────────────────────────────────────────────────────
  {
    const { app, win, ud } = await launch('result'); spent.push(ud)
    await win.getByTestId('card-generate').first().click()
    const req = await jobReq(win)
    check(!!req, '생성이 시작되고 요청 식별자가 생긴다')
    await win.waitForFunction(() => !window.__synthesisCards.getState().job, null, { timeout: 25000 }).catch(() => {})
    const ev = await evOf(win)
    const st = await cardState(win)
    trace('성공 경로:', ev, req)
    const resultIds = ev.filter((e) => e[0] === 'result').map((e) => e[1])
    check(resultIds.length > 0 && resultIds.every((id) => id === req),
      '완료 신호가 요청 식별자를 그대로 달고 온다', { req, ev })
    check(st.takes.length === 1 && st.takes[0] === '본체 통과 검사 대사',
      '성공하면 생성본이 그때 대사와 함께 붙는다', st)
    check(st.job === false, '성공하면 작업이 풀린다', st)
    await app.close()
  }

  // ── 오류 경로 ────────────────────────────────────────────────────────
  {
    const { app, win, ud } = await launch('error'); spent.push(ud)
    await win.getByTestId('card-generate').first().click()
    const req = await jobReq(win)
    await win.waitForFunction(() => !window.__synthesisCards.getState().job, null, { timeout: 25000 }).catch(() => {})
    const ev = await evOf(win)
    const st = await cardState(win)
    trace('오류 경로:', ev, req)
    const errIds = ev.filter((e) => e[0] === 'error').map((e) => e[1])
    check(errIds.length > 0 && errIds.every((id) => id === req),
      '오류 신호가 요청 식별자를 그대로 달고 온다', { req, ev })
    check(st.job === false, '오류가 나면 작업이 풀린다 — 만드는 중에 갇히지 않는다', st)
    check(st.notice.length > 0, '오류를 화면이 알린다', st)
    // 실패 뒤에도 다시 만들 수 있어야 한다.
    check(await win.getByTestId('card-generate').first().isEnabled(), '실패 뒤 다시 만들 수 있다')
    await app.close()
  }

  // ── 취소 경로 ────────────────────────────────────────────────────────
  {
    const { app, win, ud } = await launch('hang'); spent.push(ud)
    // 먼저 생성본 하나를 남겨 둔다 — 취소가 그것을 지우지 않는지 보려면 필요하다.
    await win.evaluate(() => {
      const s = window.__synthesisCards.getState(), c = s.cards[0]
      s.addTake(c.id, {
        id: 'keep-me', path: 'before.wav', createdAt: 1, text: '취소 전 생성본',
        source: c.source, settings: c.settings, applied: { speed: 1, pitch: 0, notes: [] },
      })
    })
    await win.getByTestId('card-generate').first().click()
    const req = await jobReq(win)
    check(!!req, '멈추기 전에 작업이 서 있다')
    await win.getByTestId('card-stop').first().click()
    await win.waitForFunction(() => !window.__synthesisCards.getState().job, null, { timeout: 30000 }).catch(() => {})
    const ev = await evOf(win)
    const st = await cardState(win)
    trace('취소 경로:', ev, req)
    const cancelIds = ev.filter((e) => e[0] === 'cancelled').map((e) => e[1])
    check(cancelIds.length > 0 && cancelIds.every((id) => id === req),
      '취소 종료 신호가 요청 식별자를 그대로 달고 온다', { req, ev })
    check(st.job === false, '취소하면 작업이 풀린다', st)
    check(st.takes.length === 1 && st.takes[0] === '취소 전 생성본',
      '취소가 이전 생성본을 지우지 않는다', st)
    await app.close()
  }

  console.log('RESULT', passed, 'checks ·', fails.length, 'fail')
  if (fails.length) { console.error('실패:', fails.join(' / ')); process.exit(1) }
} catch (e) {
  console.error('예외:', e?.stack || e?.message || e)
  process.exit(1)
} finally {
  for (const d of spent) cleanupUserData(d)
}
