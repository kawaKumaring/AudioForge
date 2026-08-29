// 참조 미리듣기 신뢰성 스트레스 E2E — 빠른 seek / 구간 변경 / 감정 후보 전환을 반복해도
// 재생이 무음이 되지 않고, UI가 '재생 중'에 갇히지 않는지 검증한다.
//
// 재현하려는 회귀(수정 전 실제 관측):
//  - 미리듣기 클릭마다 new Audio를 만들어 이전 요소를 놓쳤다 → 169개 생성 / 81개가 동시에 재생 중이고
//    정지 불가. play() 거부(AbortError)는 catch로 삼켜져 화면에 아무 표시도 없었다.
//  - 동시에 몰린 local-file:// 로드가 고갈되면 그 뒤 모든 미리듣기가 로드되지 않는다(영구 무음).
//
// GPU·실합성 없음. 사용자 미디어 미사용(이번 실행 전용 synthetic WAV). 격리 user-data-dir + 자체 정리.
// 실행: node test/e2e/reference-preview-stress.e2e.mjs  (사전 npm run build)
import { _electron as electron } from 'playwright'
import fs from 'fs'; import path from 'path'; import os from 'os'
import { randomUUID } from 'crypto'
import { cleanupIsolated, snapshotTree, refClipDirs, makeSyntheticWav, cleanupSyntheticWav } from './_e2e-helper.mjs'

const APP = process.cwd()
const RES_DIR = path.join(APP, 'resources')
const ITERATIONS = 32          // 요구 최소 30회 이상
let failed = 0
const log = (...a) => console.log('[ref-preview-stress]', ...a)
const ok = (c, m) => { log(c ? 'PASS' : 'FAIL', m); if (!c) failed++ }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요(npm run build)'); process.exit(2) }

// 참조 자산: 구간 선택 UI(10초 초과)가 필요하므로 항상 이번 실행 전용 30초 synthetic WAV를 만든다.
// AF_E2E_REFERENCE가 있어도 길이를 보장할 수 없어 대체하지 않는다(다른 e2e와 동일한 판단).
const SYNTH = makeSyntheticWav(path.join(os.tmpdir(), 'af_e2e_synth_' + randomUUID() + '.wav'), 30)
const ISO = path.join(os.tmpdir(), 'audioforge_e2e_' + randomUUID())
fs.mkdirSync(ISO, { recursive: true })
const DEF = path.join(ISO, 'default.wav'); fs.copyFileSync(SYNTH, DEF)
const EMOTIONS = ['happy', 'sad', 'angry'].map((id) => {
  const p = path.join(ISO, id + '.wav'); fs.copyFileSync(SYNTH, p); return { id, path: p }
})
// 격리 user-data-dir(다른 세션/사용자 프로필과 무관). prefix 가드로 이 폴더만 지운다.
const USER_DATA = path.join(os.tmpdir(), 'audioforge_e2e_' + randomUUID())
fs.mkdirSync(USER_DATA, { recursive: true })

const resBefore = fs.existsSync(RES_DIR) ? snapshotTree(RES_DIR) : null
const pageErrors = [], crashes = []
const app = await electron.launch({
  args: ['out/main/index.js', `--user-data-dir=${USER_DATA}`],
  cwd: APP,
  env: { ...process.env, AF_E2E: '1' },
})
const win = await app.firstWindow()
win.on('pageerror', (e) => pageErrors.push(e.message))
win.on('crash', () => crashes.push('crash'))

try {
  await win.waitForLoadState('domcontentloaded')

  // ── 계측: new Audio 인스턴스 / play·pause 호출 / play() 거부 ──
  await win.evaluate(() => {
    const W = window
    W.__pvs = { made: [], plays: 0, pauses: 0, rejects: [], maxConcurrent: 0 }
    const OA = W.Audio
    W.Audio = function (...a) { const el = new OA(...a); W.__pvs.made.push(el); return el }
    W.Audio.prototype = OA.prototype
    const P = W.HTMLMediaElement.prototype, op = P.play, opa = P.pause
    P.play = function (...a) {
      W.__pvs.plays++
      const pr = op.apply(this, a)
      if (pr && pr.then) pr.then(undefined, (e) => W.__pvs.rejects.push(e.name))
      return pr
    }
    P.pause = function (...a) { W.__pvs.pauses++; return opa.apply(this, a) }
    // 동시에 소리를 내는 미디어 요소 수를 계속 관측한다(누수·중복 재생 감시).
    W.__pvsSample = () => {
      const all = [...document.querySelectorAll('audio'), ...W.__pvs.made]
      const playing = all.filter((e) => !e.paused && !e.ended).length
      if (playing > W.__pvs.maxConcurrent) W.__pvs.maxConcurrent = playing
      return playing
    }
    setInterval(W.__pvsSample, 40)
    // 프로토콜 건강도 프로브: 앱 코드와 무관하게 새 오디오가 로드되는가?
    W.__pvsFresh = async (p) => {
      const url = await window.api.audio.getFileUrl(p)
      const a = new OA(); a.preload = 'auto'; a.src = url
      const r = await new Promise((res) => {
        a.addEventListener('loadedmetadata', () => res('ok'), { once: true })
        a.addEventListener('error', () => res('error'), { once: true })
        setTimeout(() => res('timeout:rs' + a.readyState), 4000)
      })
      try { a.pause(); a.removeAttribute('src') } catch { /* noop */ }
      return r
    }
  })

  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, DEF)
  // 참조 분석 완료 = 구간 선택 UI 등장(지속시간 하드코딩 대신 의미 기반 대기)
  await win.getByText('이 구간으로 확정').waitFor({ timeout: 40000 })
  await win.evaluate((list) => { for (const e of list) window.__afStore.getState().registerEmotionRef(e.id, e.path) }, EMOTIONS)
  await win.waitForTimeout(200)
  await win.getByRole('button', { name: '관리', exact: true }).click({ timeout: 10000 })

  const regionPlay = win.getByRole('button', { name: '▶ 구간 미리듣기' })
  const regionStop = win.getByRole('button', { name: '■ 정지' })
  const emotionPreview = win.getByRole('button', { name: /참조 미리듣기$/ })
  const emotionCount = await emotionPreview.count()
  ok(emotionCount >= 3, `감정 후보 미리듣기 버튼 ${emotionCount}개(전환 대상)`)

  const setSlider = (label, v) => win.evaluate(({ l, x }) => {
    const inp = document.querySelector(`input[aria-label="${l}"]`)
    if (!inp) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(inp, String(x)); inp.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, { l: label, x: v })

  const regionState = () => win.evaluate(() => {
    const el = document.querySelector('audio')
    const btn = document.querySelector('[data-af-preview-phase]')
    return {
      ct: el ? el.currentTime : -1,
      paused: el ? el.paused : true,
      rs: el ? el.readyState : -1,
      err: el && el.error ? el.error.code : null,
      phase: btn ? btn.getAttribute('data-af-preview-phase') : 'none',
      playing: window.__pvsSample(),
    }
  })

  // ── 스트레스: 빠른 seek + 구간 길이 변경 + 감정 후보 전환을 섞어 반복 ──
  let advanced = 0, stuckPlaying = 0, notPausedAfterStop = 0
  const silentSamples = []
  for (let i = 0; i < ITERATIONS; i++) {
    await setSlider('참조 구간 시작 위치(초)', (i % 15) + 1)              // 빠른 seek
    if (i % 3 === 0) await setSlider('참조 구간 길이(초)', 3 + (i % 6))    // 구간 변경
    // 대기 없이 겹쳐 누른다 — 구간 재생 2연타 + 서로 다른 감정 후보 2개
    await Promise.all([
      regionPlay.click({ noWaitAfter: true, force: true }),
      regionPlay.click({ noWaitAfter: true, force: true }),
      emotionPreview.nth(i % emotionCount).click({ noWaitAfter: true, force: true }),
      emotionPreview.nth((i + 1) % emotionCount).click({ noWaitAfter: true, force: true }),
    ])
    await win.waitForTimeout(150)
    const s0 = await regionState()
    await win.waitForTimeout(350)
    const s1 = await regionState()
    // 들려야 할 때 실제로 소리가 진행하는가(무음이 아닌가)
    if (s1.ct - s0.ct > 0.05) advanced++
    else silentSamples.push({ i, s0: { ct: +s0.ct.toFixed(2), p: s0.paused, rs: s0.rs, ph: s0.phase }, s1: { ct: +s1.ct.toFixed(2), p: s1.paused, rs: s1.rs, ph: s1.phase, err: s1.err } })

    await regionStop.click({ force: true })
    await win.waitForTimeout(120)
    const after = await regionState()
    if (after.phase === 'playing') stuckPlaying++          // UI가 '재생 중'에 갇힘
    if (!after.paused) notPausedAfterStop++                 // 정지했는데 계속 재생
  }
  ok(advanced === ITERATIONS, `${ITERATIONS}회 반복 전부에서 재생이 실제로 진행함(=${advanced}/${ITERATIONS})${silentSamples.length ? ' 무음샘플=' + JSON.stringify(silentSamples.slice(0, 3)) : ''}`)
  ok(stuckPlaying === 0, `정지 후 UI가 '재생 중'에 갇힌 반복 0회(=${stuckPlaying})`)
  ok(notPausedAfterStop === 0, `정지 후에도 재생이 남은 반복 0회(=${notPausedAfterStop})`)

  const inst = await win.evaluate(() => ({
    made: window.__pvs.made.length,
    stillPlaying: window.__pvs.made.filter((e) => !e.paused).length,
    maxConcurrent: window.__pvs.maxConcurrent,
    plays: window.__pvs.plays,
    pauses: window.__pvs.pauses,
    rejects: window.__pvs.rejects.length,
  }))
  // 회귀 감시: 예전에는 클릭 수만큼 Audio가 늘고 수십 개가 동시에 울렸다.
  ok(inst.made <= 4, `미리듣기 Audio 인스턴스가 클릭 수만큼 늘지 않음(=${inst.made}, 클릭 ${ITERATIONS * 2}회)`)
  ok(inst.maxConcurrent <= 2, `동시에 소리 내는 미디어 요소 ≤2(구간 1 + 감정 1) (최대=${inst.maxConcurrent})`)
  log(`계측: play=${inst.plays} pause=${inst.pauses} play거부=${inst.rejects} 생성=${inst.made}`)

  // ── 반복 뒤에도 미리듣기가 여전히 동작하는가(영구 무음 회귀 감시) ──
  await emotionPreview.nth(0).click({ force: true })
  await win.waitForTimeout(1200)
  const finalPreview = await win.evaluate(() => {
    const els = window.__pvs.made
    return {
      playing: els.filter((e) => !e.paused && e.currentTime > 0.05).length,
      rs: els.map((e) => e.readyState),
      ct: els.map((e) => +e.currentTime.toFixed(2)),
    }
  })
  ok(finalPreview.playing >= 1, `${ITERATIONS}회 반복 후에도 감정 미리듣기가 실제로 재생됨(${JSON.stringify(finalPreview)})`)
  const freshProbe = await win.evaluate((p) => window.__pvsFresh(p), EMOTIONS[0].path)
  ok(freshProbe === 'ok', `반복 후에도 local-file:// 오디오 로드 가능(=${freshProbe})`)

  const regionFinal = await (async () => { await regionPlay.click({ force: true }); await win.waitForTimeout(600); return regionState() })()
  ok(!regionFinal.paused && regionFinal.ct > 0, `${ITERATIONS}회 반복 후에도 구간 미리듣기가 재생됨(${JSON.stringify({ p: regionFinal.paused, ct: +regionFinal.ct.toFixed(2), ph: regionFinal.phase })})`)
  await regionStop.click({ force: true })

  // ── 실패는 삼키지 않고 사용자 언어로 보인다(경로 미노출·자동 재시도 없음) ──
  await win.evaluate(() => window.__afStore.getState().registerEmotionRef('surprise', 'Z:\\\\없는폴더\\\\없는파일.wav'))
  await win.waitForTimeout(250)
  const brokenBtn = win.getByRole('button', { name: '놀람 참조 미리듣기' })
  await brokenBtn.click({ timeout: 8000 })
  await win.waitForFunction(() => document.querySelectorAll('[role="alert"]').length > 0, undefined, { timeout: 12000 }).catch(() => {})
  const alerts = await win.evaluate(() => Array.from(document.querySelectorAll('[role="alert"]')).map((n) => n.textContent || ''))
  const alertText = alerts.join(' | ')
  ok(alerts.length > 0, `로드 실패가 화면 오류로 노출됨(삼키지 않음): ${alertText.slice(0, 48)}`)
  ok(!/[\\/]|Z:|\.wav|local-file|Error|undefined/.test(alertText), `오류 문구에 경로·원시 오류 미노출(${alertText.slice(0, 48)})`)
  // 자동 재시도 없음: 가만히 두면 play 호출이 더 늘지 않는다
  const playsAtFail = await win.evaluate(() => window.__pvs.plays)
  await win.waitForTimeout(2500)
  const playsLater = await win.evaluate(() => window.__pvs.plays)
  ok(playsLater === playsAtFail, `실패 후 자동 재시도 없음(play 호출 ${playsAtFail} → ${playsLater})`)

  // ── 언마운트 정리: 모드 전환 후 남아서 우는 오디오 0 ──
  await win.evaluate(() => window.__afStore.getState().setMode('split'))
  await win.waitForTimeout(600)
  const leaked = await win.evaluate(() => {
    const all = [...document.querySelectorAll('audio'), ...window.__pvs.made]
    return all.filter((e) => !e.paused).length
  })
  ok(leaked === 0, `모드 전환(언마운트) 후 재생 중인 오디오 0(=${leaked})`)

  ok(pageErrors.length === 0, `pageerror 0 (=${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0] : ''})`)
  ok(crashes.length === 0, `crash 0 (=${crashes.length})`)
} catch (e) {
  failed++; log('EXCEPTION', e?.stack || String(e))
} finally {
  await app.close().catch(() => {})
}

ok(refClipDirs().length === 0, `앱 종료 후 파생 클립 폴더 0(=${refClipDirs().length})`)
if (resBefore !== null) ok(snapshotTree(RES_DIR) === resBefore, 'resources/ 원본 불변')
cleanupIsolated(ISO)
cleanupIsolated(USER_DATA)
cleanupSyntheticWav(SYNTH)
log(failed === 0 ? `ALL PASS (반복 ${ITERATIONS}회)` : `${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
