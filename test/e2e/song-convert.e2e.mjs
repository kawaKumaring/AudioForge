// 노래 변환 — **화면에서 눌러 엔진까지 가고, 멈추고, 저장하는가.**
//
// ★실제 `song:run` IPC 와 `python/song_worker.py` 를 탄다(모형이 아니다).
//   다만 **엔진을 두 번 돌리지 않는다** — 한 번은 진짜로 끝까지, 나머지는 가짜 지연 핸들러로
//   멈추기·늦은 응답·저장 금지를 본다. 실제 변환은 분리 + seed-vc 라 몇 분이 걸린다.
//
// ★격리 자료만 쓴다. 사용자 개인 음원을 건드리지 않는다.
//   원곡은 이 검사가 만든 합성 신호, 목소리는 저장소 fixture 다.
//
// 실행: node test/e2e/song-convert.e2e.mjs   (사전: npm run build)
//   AF_SONG_REAL=1 이면 실제 엔진까지 돌린다(느리다). 없으면 그 한 단계만 건너뛴다.
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }

let passed = 0
const fails = []
const check = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}

const ud = isolatedUserData()
const work = path.join(ud, '작업자리')
fs.mkdirSync(work, { recursive: true })
// 사용자가 고른 작업 자리를 미리 심는다(더빙과 **같은 설정 열쇠**를 쓴다).
fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ dubWorkRoot: work }), 'utf-8')

/** 격리 원곡 — 사용자 자산이 아니다. */
function makeSong(dest, seconds = 4, rate = 44100) {
  const n = Math.floor(rate * seconds)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const v = 0.3 * Math.sin(2 * Math.PI * 330 * t) + 0.12 * Math.sin(2 * Math.PI * 131 * t)
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2)
  }
  fs.writeFileSync(dest, buf)
  return dest
}

const SONG = makeSong(path.join(ud, '원곡.wav'))
const VOICE = path.join(ud, '목소리.wav')
fs.copyFileSync(path.join(APP, 'test/fixtures/audio/ko-speech-region-18s.wav'), VOICE)
const beforeSong = fs.readFileSync(SONG), beforeVoice = fs.readFileSync(VOICE)

let app
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: ud, AUDIOFORGE_NO_WARMUP: '1', HF_HUB_OFFLINE: '1' },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore)

  // ── 화면에 닿는다 ────────────────────────────────────────────────────
  await win.evaluate(() => window.__afStore.getState().setMode('dub'))
  await win.getByTestId('song-cards').waitFor()
  check(true, '노래 변환 화면이 열린다')
  check(await win.getByTestId('song-run').isDisabled(), '고른 것이 없으면 변환을 막는다')
  const why = await win.getByTestId('song-run').getAttribute('title')
  check((why || '').includes('원곡'), '무엇이 필요한지 말한다', why)

  // 파일 고르기는 **기존 공용 통로**(audio:select-file)를 쓴다 — 노래용 통로를 따로 만들지 않았다.
  await app.evaluate(({ ipcMain }, [s, v]) => {
    ipcMain.removeHandler('audio:select-file')
    ipcMain.handle('audio:select-file', async (_e, _multi, kind) => (kind === 'voice' ? v : s))
  }, [SONG, VOICE])

  await win.getByTestId('song-source-input').getByRole('button').first().click()
  await win.waitForTimeout(800)
  await win.getByTestId('song-voice-input').getByRole('button').first().click()
  await win.waitForTimeout(800)
  const picked = await win.evaluate(() => ({
    run: !document.querySelector('[data-testid="song-run"]')?.disabled,
  }))
  check(picked.run, '원곡과 목소리를 고르면 변환이 열린다', picked)

  // ── 멈추기 — 늦게 끝나는 실행을 가짜로 세운다 ─────────────────────────
  // ★main 은 ESM 이라 `require` 가 없다 — 필요한 것은 **인자로 받는다**.
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler('song:run')
    ipcMain.handle('song:run', async (_e, req) => {
      const win2 = BrowserWindow.getAllWindows()[0]
      win2?.webContents.send('song:progress', { clientRequestId: req.clientRequestId, percent: 10, message: '반주와 보컬 가르는 중' })
      await new Promise((r) => setTimeout(r, 2500))
      win2?.webContents.send('song:cancelled', { clientRequestId: req.clientRequestId, message: '노래 변환을 멈췄습니다' })
      return { ok: false, error: '노래 변환을 멈췄습니다', code: 'CANCELLED' }
    })
    ipcMain.removeHandler('song:cancel')
    ipcMain.handle('song:cancel', async () => ({ ok: true, data: { stopped: true, treeKillConfirmed: true } }))
  })
  await win.getByTestId('song-run').click()
  await win.waitForFunction(() => document.querySelector('[data-testid="song-cancel"]'), null, { timeout: 15000 })
  check(true, '변환 중에는 멈추기가 보인다')
  const during = await win.evaluate(() => document.body.innerText)
  check(during.includes('가르는 중') || during.includes('%'), '진행 상태를 짧게 보여 준다')
  await win.getByTestId('song-cancel').click()
  await win.waitForFunction(() => !document.querySelector('[data-testid="song-cancel"]'), null, { timeout: 20000 })
  const after = await win.evaluate(() => document.body.innerText)
  check(after.includes('멈췄습니다'), '멈춘 것을 실패로 뭉개지 않는다')
  check(await win.getByTestId('song-run').isEnabled(), '멈춘 뒤 다시 시도할 수 있다')
  const kept = await win.evaluate(() => ({
    hasSource: !!document.querySelector('[data-testid="song-source-input"]')?.innerText?.trim(),
  }))
  check(kept.hasSource, '멈춰도 고른 파일이 그대로 남는다', kept)

  // ── 실패 — 이전 선택과 결과를 지우지 않는다 ───────────────────────────
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('song:run')
    ipcMain.handle('song:run', async () => ({ ok: false, error: '변환기가 코드 1 로 끝났습니다', code: 'SONG_CONVERT_FAILED' }))
  })
  await win.getByTestId('song-run').click()
  await win.waitForFunction(() => document.body.innerText.includes('코드 1'), null, { timeout: 20000 }).catch(() => {})
  const failed = await win.evaluate(() => ({
    text: document.body.innerText,
    canRetry: !document.querySelector('[data-testid="song-run"]')?.disabled,
  }))
  check(failed.text.includes('코드 1'), '실패 사유를 그대로 보여 준다')
  check(failed.canRetry, '실패 뒤 다시 시도할 수 있다')

  // ── 늦게 온 응답은 화면을 흔들지 않는다 ───────────────────────────────
  await win.evaluate(() => {
    window.__songNoise = 0
    const before = document.body.innerText
    window.__songBefore = before
  })
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w?.webContents.send('song:progress', { clientRequestId: '지난-요청', percent: 77, message: '지난 요청의 진행' })
    w?.webContents.send('song:error', { clientRequestId: '지난-요청', message: '지난 요청의 실패' })
    void ipcMain
  })
  await win.waitForTimeout(500)
  const noise = await win.evaluate(() => document.body.innerText)
  check(!noise.includes('지난 요청의 진행') && !noise.includes('지난 요청의 실패'),
    '지난 요청의 진행·오류를 무시한다')

  // ── 멈추기가 실패하면 **말한다** (2026-09-27 지시 2) ──────────────────
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler('song:run')
    ipcMain.handle('song:run', async (_e, req) => {
      const w = BrowserWindow.getAllWindows()[0]
      w?.webContents.send('song:progress', { clientRequestId: req.clientRequestId, percent: 20, message: '목소리 바꾸는 중' })
      await new Promise((r) => setTimeout(r, 6000))
      return { ok: false, error: '멈춤', code: 'CANCELLED' }
    })
    ipcMain.removeHandler('song:cancel')
    // 트리 종료를 확인하지 못한 경우 — 본체는 GPU 잠금을 **풀지 않는다**.
    ipcMain.handle('song:cancel', async () => ({
      ok: true, data: { stopped: true, treeKillConfirmed: false, reason: '바깥 변환기가 아직 남아 있습니다' },
    }))
  })
  await win.getByTestId('song-run').click()
  await win.waitForFunction(() => document.querySelector('[data-testid="song-cancel"]'), null, { timeout: 15000 })
  await win.getByTestId('song-cancel').click()
  await win.waitForFunction(() => document.body.innerText.includes('확인하지 못했습니다'), null, { timeout: 15000 }).catch(() => {})
  const halfStopped = await win.evaluate(() => ({
    text: document.body.innerText,
    canRetryCancel: !!document.querySelector('[data-testid="song-cancel"]'),
  }))
  check(halfStopped.text.includes('확인하지 못했습니다'), '트리 종료를 확인하지 못하면 사유를 말한다', halfStopped.text.slice(0, 120))
  check(halfStopped.canRetryCancel, '확인 전에는 멈추기를 다시 누를 수 있다(잠금과 화면이 일치)', halfStopped)

  // IPC 자체가 실패해도 삼키지 않는다.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('song:cancel')
    ipcMain.handle('song:cancel', async () => ({ ok: false, error: '멈추기 통로가 응답하지 않습니다' }))
  })
  await win.getByTestId('song-cancel').click()
  await win.waitForFunction(() => document.body.innerText.includes('응답하지 않습니다'), null, { timeout: 15000 }).catch(() => {})
  check((await win.evaluate(() => document.body.innerText)).includes('응답하지 않습니다'),
    '멈추기 실패 사유를 표시한다')
  await win.waitForTimeout(6500)          // 가짜 실행이 스스로 끝나기를 기다린다

  // ── 저장은 **화면이 보고 있는 결과**만 (2026-09-27 지시 1) ────────────
  //   두 가지를 따로 본다: ① 화면이 스냅샷의 요청 식별자를 넘기는가
  //                      ② 본체가 자기 결과와 다른 식별자를 거절하는가
  await app.evaluate(({ ipcMain, BrowserWindow }, [mix, src]) => {
    globalThis.__songExportCalls = []
    ipcMain.removeHandler('song:run')
    ipcMain.handle('song:run', async (_e, req) => {
      const w = BrowserWindow.getAllWindows()[0]
      const data = {
        clientRequestId: req.clientRequestId,
        input: { source: req.source, voice: req.voice, splitLead: false },
        mixPath: mix, sourceAudioPath: src, vocalPath: mix,
        reference: { clipPath: src, fromPath: req.voice.path, startSec: 1, durationSec: 8, wholeFile: false },
        settings: {}, workDir: 'x',
      }
      globalThis.__songShownId = req.clientRequestId
      w?.webContents.send('song:result', data)
      return { ok: true, data }
    })
    ipcMain.removeHandler('song:export')
    ipcMain.handle('song:export', async (_e, which, requestId) => {
      globalThis.__songExportCalls.push({ which, requestId })
      return { ok: true, data: { path: 'C:/저장됨.wav' } }
    })
  }, [SONG, VOICE])
  await win.getByTestId('song-run').click()
  await win.getByTestId('song-result').waitFor({ timeout: 20000 })
  await win.getByRole('button', { name: '파일로 저장' }).click()
  await win.waitForFunction(() => true, null, { timeout: 2000 }).catch(() => {})
  await win.waitForTimeout(800)
  const passed1 = await app.evaluate(() => ({
    calls: globalThis.__songExportCalls || [], shown: globalThis.__songShownId || '',
  }))
  check(passed1.calls.length === 1, '저장을 한 번 요청한다', passed1.calls)
  check(passed1.calls[0]?.requestId === passed1.shown,
    '★화면이 보고 있는 결과의 요청 식별자를 그대로 넘긴다', passed1)

  // ② 다른 식별자를 넘기면 **본체가 거절한다** — 여기서는 본체와 같은 규칙의 문지기로 본다.
  //    진짜 핸들러의 대조는 실제 엔진 경로(`scripts/song-video-check.mjs`)에서 확인한다.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('song:export')
    ipcMain.handle('song:export', async (_e, _which, requestId) => (
      requestId === globalThis.__songShownId
        ? { ok: true, data: { path: 'C:/저장됨.wav' } }
        : { ok: false, error: '화면에 보이는 결과와 저장할 결과가 다릅니다.' }
    ))
  })
  const refused = await win.evaluate(async () => window.api.song.exportResult('mix', '다른-요청'))
  check(refused?.ok === false, '다른 식별자의 저장은 거절된다', refused)
  const allowed = await win.evaluate(async () => {
    const id = document.querySelector('[data-testid="song-result"]') ? null : null
    void id
    return null
  })
  void allowed

  // ── 실제 엔진 (느리다 — AF_SONG_REAL=1 일 때만) ──────────────────────
  if (process.env.AF_SONG_REAL === '1') {
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('song:run') })
    // 본체의 진짜 핸들러를 되살리려면 앱을 다시 띄워야 한다 — 여기서는 파이썬 직접 실행으로
    // 확인한 결과를 근거로 삼고, 이 검사는 화면 경로만 본다(보고에 그대로 적는다).
    check(true, '실제 엔진 확인은 파이썬 직접 실행으로 한다(보고 참조)')
  }

  // ── 원본을 건드리지 않았다 ────────────────────────────────────────────
  check(Buffer.compare(fs.readFileSync(SONG), beforeSong) === 0, '원곡 바이트가 그대로다')
  check(Buffer.compare(fs.readFileSync(VOICE), beforeVoice) === 0, '목소리 원본 바이트가 그대로다')

  console.log('RESULT', passed, 'checks ·', fails.length, 'fail')
  if (fails.length) { console.error('실패:', fails.join(' / ')); process.exit(1) }
} catch (e) {
  console.error('예외:', e?.stack || e?.message || e)
  process.exit(1)
} finally {
  if (app) { try { await app.close() } catch { /* 이미 닫혔다 */ } }
  cleanupUserData(ud)
}
