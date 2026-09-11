// 볼륨이 사용자가 정한 값을 기억하는가 (2026-09-10 사용자 보고 "소리가 항상 최대").
//
// 무슨 일이 있었나: 볼륨 슬라이더는 원래 두 곳(원본 파형·결과 트랙)에 있었지만 각각
// 컴포넌트 지역 상태였다. 그래서 파일을 다시 불러오거나 앱을 다시 켜면 100% 로 되돌아갔고,
// 슬라이더가 없는 재생 지점(참조 구간 미리듣기·목소리 미리듣기·감정 표본·분리 편집 파형)은
// 어떤 값을 정하든 늘 최대로 나갔다.
//
// 여기서 확인하는 것 — 조절 수단은 **새로 만들지 않았다**. 있는 슬라이더가 기억하는지를 본다.
//   1) 원본 파형의 볼륨 슬라이더를 키보드로 움직인다
//   2) 그 값이 화면에 있는 소리 요소에 걸린다(슬라이더가 닿지 않던 자리)
//   3) 실제 재생이 시작되는 순간의 음량이 그 값이다 (화면 밖 요소까지)
//   4) 그 값이 보관된다
//   5) 파일을 다시 불러도 슬라이더와 새 요소가 최대로 되돌아가지 않는다 (증상의 핵심)
//   6) 앱을 다시 켜면 그 값으로 시작한다
//
// 관측 지점 두 가지 — 재생 지점 일곱 곳 중 화면(DOM)에 붙는 것은 참조 구간 미리듣기뿐이고,
// 그것도 구간 편집기를 펼쳐야 생긴다. 나머지는 화면에 붙지 않는 요소라 DOM 질의로 보이지
// 않으므로, play() 가 불리는 순간의 volume 을 시험 쪽에서 엿본다(제품 코드는 건드리지 않는다).
//
// 실행: node test/e2e/playback-volume.e2e.mjs   (사전: npm run build. GPU·합성 불필요)
//   AF_E2E_REFERENCE 로 실제 말이 든 참조를 준다(없으면 저장소 fixture).
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedInput, cleanupIsolated, isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
const SRC = (process.env.AF_E2E_REFERENCE || '').trim()
  || path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav')
if (!fs.existsSync(SRC)) { console.error(`참조 없음: ${SRC}`); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const SHOT = path.join(APP, '_local', 'artifacts', 'diagnostics', 'e2e-shots')
fs.mkdirSync(SHOT, { recursive: true })
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
const TARGET = 0.35      // 슬라이더 칸이 0.05 이므로 Home 에서 오른쪽 7번
let failed = 0
const logLines = []
const log = (...a) => {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  logLines.push(s)
  console.log('[playback-volume]', s)
}
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }
const near = (v) => typeof v === 'number' && Math.abs(v - TARGET) < 0.005

const { dir: ISO, input: REF } = isolatedInput(SRC)
const UD = isolatedUserData()   // 두 번의 실행이 같은 보관 자리를 쓴다 — 사이에 지우지 않는다.
const pageErrors = []

// 화면에 실제로 붙어 있는 소리 요소들의 volume. 하나라도 1.0 이면 그 자리는 최대로 나간다.
const domVolumes = (win) => win.evaluate(() =>
  [...document.querySelectorAll('audio, video')].map((el) => el.volume))

// 재생이 시작되는 순간의 음량을 기록한다 — 화면에 붙지 않는 요소까지 잡는 유일한 관측 지점.
const installPlayProbe = (win) => win.evaluate(() => {
  window.__volProbe = []
  const orig = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function patched(...a) {
    window.__volProbe.push(this.volume)
    return orig.apply(this, a)
  }
})
const sliderValue = (win) => win.getByTestId('waveform-volume').inputValue().then(Number)

async function launch() {
  const app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
  })
  const win = await app.firstWindow()
  win.on('pageerror', (e) => pageErrors.push(e.message))
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

async function loadFile(win) {
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
}

/** 기본 목소리의 구간 편집기를 펼친다 — DOM 소리 요소가 생기는 유일한 자리. */
async function openRegionEditor(win) {
  const btn = win.getByRole('button', { name: '사용 구간 바꾸기' })
  await btn.waitFor({ timeout: 60000 })
  await btn.click()
  await win.waitForFunction(() => document.querySelectorAll('audio, video').length > 0,
    undefined, { timeout: 30000 })
}

let app1 = null, app2 = null
try {
  // ── 1차 실행 ──────────────────────────────────────────────────────────────
  const first = await launch(); app1 = first.app
  const win = first.win
  await loadFile(win)

  const range = win.getByTestId('waveform-volume')
  await range.waitFor({ timeout: 20000 })
  ok(true, '원본 파형의 볼륨 슬라이더가 있다(새로 만든 것이 아니다)')
  const initial = await sliderValue(win)
  ok(initial === 1, '처음에는 최대다(예전 동작 유지)', String(initial))

  // 걸 대상이 실제로 있어야 의미가 있다 — 구간 편집기를 펼쳐 미리듣기 요소를 만든다.
  await openRegionEditor(win)
  const vol0 = await domVolumes(win)
  ok(vol0.length > 0, `화면에 소리 요소가 있다(${vol0.length}개)`, JSON.stringify(vol0))

  // 키보드로 실제 조작한다 — Home 으로 0, 거기서 오른쪽 7번(0.05 칸) = 0.35.
  await range.focus()
  await range.press('Home')
  for (let i = 0; i < 7; i++) await range.press('ArrowRight')
  const moved = await sliderValue(win)
  ok(near(moved), `키보드로 ${TARGET} 까지 움직인다`, String(moved))

  const vol1 = await domVolumes(win)
  ok(vol1.length > 0 && vol1.every(near),
    '슬라이더가 닿지 않던 재생 지점(참조 미리듣기)도 함께 내려간다', JSON.stringify(vol1))

  // 실제 재생 순간의 음량 — 화면에 붙지 않는 목소리 미리듣기 요소까지 여기서 잡힌다.
  await installPlayProbe(win)
  await win.getByRole('button', { name: '지금 쓰는 목소리 재생' }).click({ timeout: 10000 })
  await win.waitForFunction(() => (window.__volProbe || []).length > 0,
    undefined, { timeout: 30000 }).catch(() => {})
  const plays = await win.evaluate(() => window.__volProbe || [])
  ok(plays.length > 0 && plays.every(near),
    '재생이 시작되는 순간의 음량이 정한 값이다', JSON.stringify(plays))

  const stored1 = await win.evaluate(async () => (await window.api.settings.get()).playbackVolume)
  ok(near(stored1), '움직인 값이 보관된다', JSON.stringify(stored1))

  // ★ 증상의 핵심 — 파일을 다시 불러도 슬라이더와 새 요소가 최대로 되돌아가지 않아야 한다.
  await win.evaluate(() => window.__afStore.getState().reset())
  await win.waitForFunction(() => document.querySelectorAll('audio, video').length === 0,
    undefined, { timeout: 20000 }).catch(() => {})
  await loadFile(win)
  await win.getByTestId('waveform-volume').waitFor({ timeout: 20000 })
  const again = await sliderValue(win)
  ok(near(again), '다시 불러도 슬라이더가 최대로 되돌아가지 않는다', String(again))
  await openRegionEditor(win)
  const vol2 = await domVolumes(win)
  ok(vol2.length > 0 && vol2.every(near),
    '다시 불러 새로 만들어진 요소도 정한 값이다', JSON.stringify(vol2))

  await win.screenshot({ path: path.join(SHOT, 'playback-volume.png') })
  await app1.close(); app1 = null

  // ── 2차 실행: 앱을 다시 켜면 그 값으로 시작한다 ─────────────────────────
  const second = await launch(); app2 = second.app
  const win2 = second.win
  await loadFile(win2)
  await win2.getByTestId('waveform-volume').waitFor({ timeout: 20000 })
  const restored = await sliderValue(win2)
  ok(near(restored), '앱을 다시 켜면 정해 둔 값으로 시작한다', String(restored))

  await openRegionEditor(win2)
  const vol3 = await domVolumes(win2)
  ok(vol3.length > 0 && vol3.every(near),
    '다시 켠 뒤의 소리 요소에도 그 값이 걸린다', JSON.stringify(vol3))

  ok(pageErrors.length === 0, '전 구간 렌더러 예외 0', pageErrors.join(' | '))
} catch (e) {
  failed++
  log('EXCEPTION', e?.message || String(e))
} finally {
  for (const a of [app1, app2]) { if (a) { try { await a.close() } catch { /* ignore */ } } }
  cleanupIsolated(ISO)
  cleanupUserData(UD)
  const tag = failed === 0 ? 'ok' : 'FAIL'
  const NL = String.fromCharCode(10)
  fs.writeFileSync(path.join(SHOT, `playback-volume-${STAMP}-${tag}.txt`), logLines.join(NL), 'utf-8')
}
log(failed === 0 ? '전부 통과' : `실패 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
