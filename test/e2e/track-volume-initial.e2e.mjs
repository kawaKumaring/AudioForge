// 결과 트랙을 **처음 재생할 때** 음량이 사용자가 정한 값인가 (2026-09-11 표적 확인).
//
// 무엇이 문제였나: 결과 트랙 재생기는 파일 주소를 기다린 뒤에 만들어지는데, 음량을 거는 효과는
// 그 전에 이미 끝난다. 그래서 재생기가 만들어질 때 아무도 음량을 걸어 주지 않았고,
// **첫 재생만 최대 음량**으로 나갔다. 슬라이더를 한 번 움직이면 그때부터는 맞았다.
//
// 이 검사는 그 한 지점만 본다.
//   1) 원본 파형의 볼륨을 낮춘다(실제 슬라이더, 키보드 조작)
//   2) 결과 트랙 자리에 **이미 있는 음원**을 놓는다 — 새로 합성하지 않는다
//   3) 트랙을 **처음** 재생한다
//   4) 재생이 시작되는 순간의 실제 음량을 읽는다
//
// 관측 방법: 이 재생기는 HTML 오디오 요소를 쓰지 않는다(실측 — 화면에 audio 요소가 0개).
// 그래서 실제 소리 크기가 걸리는 자리인 **오디오 그래프의 게인**을 시험 쪽에서 엿본다.
// 제품 코드는 건드리지 않는다.
//
// 이 검사가 헛돌지 않음을 확인했다 — 고친 한 줄을 되돌리면 게인이 1(최대)로 나오고 실패한다.
//
// 실행: node test/e2e/track-volume-initial.e2e.mjs   (사전: npm run build. GPU·합성 불필요)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedInput, cleanupIsolated, isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
const SRC = (process.env.AF_E2E_REFERENCE || '').trim()
  || path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')
if (!fs.existsSync(SRC)) { console.error(`음원 없음: ${SRC}`); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const SHOT = path.join(APP, '_local', 'artifacts', 'diagnostics', 'e2e-shots')
fs.mkdirSync(SHOT, { recursive: true })
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
const TARGET = 0.35            // 슬라이더 칸이 0.05 이므로 Home 에서 오른쪽 7번
let failed = 0
const logLines = []
const log = (...a) => {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  logLines.push(s)
  console.log('[track-volume]', s)
}
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }
const near = (v) => typeof v === 'number' && Math.abs(v - TARGET) < 0.005

const { dir: ISO, input: INPUT } = isolatedInput(SRC)
const UD = isolatedUserData()
const pageErrors = []
let app = null

try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
  })
  const win = await app.firstWindow()
  win.on('pageerror', (e) => pageErrors.push(e.message))
  await win.waitForLoadState('domcontentloaded')

  // ── 1) 음량을 낮춘다 (실제 슬라이더) ────────────────────────────────────
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('split')
  }, INPUT)
  const range = win.getByTestId('waveform-volume')
  await range.waitFor({ timeout: 20000 })
  await range.focus()
  await range.press('Home')
  for (let i = 0; i < 7; i++) await range.press('ArrowRight')
  const moved = Number(await range.inputValue())
  ok(near(moved), `음량을 ${TARGET} 로 낮춘다`, String(moved))

  // ── 2) 결과 트랙 자리에 이미 있는 음원을 놓는다 (합성하지 않는다) ────────
  await win.evaluate((p) => {
    window.__afStore.setState({
      status: 'done', mode: 'split', playingTrack: null,
      tracks: [{ name: 'vocals', label: '보컬', path: p }],
    })
  }, INPUT)

  // ── 3) 처음 재생될 때의 실제 음량을 엿본다 ─────────────────────────────
  // ★이 재생기는 HTML 오디오 요소를 쓰지 않는다(실측 확인 — 화면에 audio 요소가 0개다).
  //   그래서 play() 를 엿보는 방법은 통하지 않는다. 실제 소리 크기가 걸리는 자리는
  //   오디오 그래프의 **게인**이므로 그것을 본다. 제품 코드는 건드리지 않는다.
  await win.evaluate(() => {
    window.__gains = []
    const orig = AudioContext.prototype.createGain
    AudioContext.prototype.createGain = function patched(...a) {
      const g = orig.apply(this, a)
      window.__gains.push(g)          // 이 시점 이후 만들어진 것만 담긴다
      return g
    }
  })
  const playBtn = win.getByRole('button', { name: /보컬 재생/ })
  await playBtn.waitFor({ timeout: 20000 })
  await playBtn.click()
  await win.waitForFunction(() => (window.__gains || []).length > 0,
    undefined, { timeout: 30000 }).catch(() => {})
  // 재생이 실제로 시작될 때까지 잠깐 둔다(값이 걸리는 시점을 놓치지 않도록).
  await win.waitForFunction(() => window.__afStore.getState().playingTrack === 'vocals',
    undefined, { timeout: 20000 }).catch(() => {})
  const gains = await win.evaluate(() => (window.__gains || []).map((g) => g.gain.value))
  ok(gains.length > 0, `결과 트랙 재생기가 만들어졌다(게인 ${gains.length}개)`, JSON.stringify(gains))
  ok(gains.length > 0 && gains.every(near),
    '★첫 재생의 음량이 정한 값이다 — 최대(1.0)로 나가지 않는다', JSON.stringify(gains))

  // ── 4) 이후 슬라이더 변경이 실시간 반영되는지도 그대로인지 본다 ─────────
  const trackRange = win.getByTestId('track-volume')
  if (await trackRange.count() > 0) {
    await trackRange.first().focus()
    await trackRange.first().press('ArrowRight')
    const after = Number(await trackRange.first().inputValue())
    ok(after > moved - 0.001, '결과 트랙 슬라이더가 그대로 동작한다', String(after))
  } else {
    ok(false, '결과 트랙 슬라이더를 찾지 못했다')
  }

  ok(pageErrors.length === 0, '렌더러 예외 0', pageErrors.join(' | '))
  await win.screenshot({ path: path.join(SHOT, 'track-volume-initial.png') })
} catch (e) {
  failed++
  log('EXCEPTION', e?.message || String(e))
} finally {
  if (app) { try { await app.close() } catch { /* ignore */ } }
  cleanupIsolated(ISO)
  cleanupUserData(UD)
  const tag = failed === 0 ? 'ok' : 'FAIL'
  const NL = String.fromCharCode(10)
  fs.writeFileSync(path.join(SHOT, `track-volume-initial-${STAMP}-${tag}.txt`), logLines.join(NL), 'utf-8')
}
log(failed === 0 ? '전부 통과' : `실패 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
