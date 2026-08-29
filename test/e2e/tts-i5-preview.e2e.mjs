// I5 감정 참조 미리듣기 Electron E2E (synthetic WAV, GPU·실합성 없음).
// 검증(PHASE 4 #4): file:// 직접 재생은 webSecurity에 막힘 → 앱 기존 안전 경로(getFileUrl → local-file://) 재사용.
//   미리듣기 재생 시작 / 다른 clip 전환(이전 정지) / 컴포넌트 해제(모드 전환) 정리. 보안완화·임의경로·외부전송 없음.
import { _electron as electron } from 'playwright'
import fs from 'fs'; import path from 'path'
import { isolatedInput, cleanupIsolated } from './_e2e-helper.mjs'

const APP = process.cwd()
const SRC = (process.env.AF_E2E_REFERENCE || '').trim() || path.join(APP, 'resources', 'speaker_b.wav')
let failed = 0
const log = (...a) => console.log('[i5-preview]', ...a)
const ok = (c, m) => { log(c ? 'PASS' : 'FAIL', m); if (!c) failed++ }
if (!fs.existsSync(SRC)) { console.error('prerequisite: 참조 자산 없음'); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const { dir: ISO, input: REF } = isolatedInput(SRC)
const pageErrors = []
const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
const win = await app.firstWindow()
win.on('pageerror', e => pageErrors.push(e.message))

try {
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
  await win.waitForFunction(() => (document.getElementById('root')?.innerText || '').includes('세부 표현'), undefined, { timeout: 30000 })

  // ── 1) 안전 경로 검증: getFileUrl은 local-file://; local-file은 재생 가능, raw file://는 막힘 ──
  const url = await win.evaluate((p) => window.api.audio.getFileUrl(p), REF)
  ok(typeof url === 'string' && url.startsWith('local-file://'), `getFileUrl → local-file:// 안전 프로토콜(${String(url).slice(0, 18)}…)`)
  const loadable = await win.evaluate((u) => new Promise((res) => {
    const a = new Audio(u); let done = false
    const fin = (v) => { if (!done) { done = true; res(v) } }
    a.addEventListener('canplay', () => fin('canplay'), { once: true })
    a.addEventListener('loadedmetadata', () => fin('loadedmetadata'), { once: true })
    a.addEventListener('error', () => fin('error'), { once: true })
    setTimeout(() => fin('timeout'), 4000)
  }), url)
  ok(loadable === 'canplay' || loadable === 'loadedmetadata', `local-file:// 오디오 로드 가능(=${loadable})`)
  // raw file:// 동작은 Electron webSecurity 구성에 따라 env-의존(막힐 수도, 될 수도). 어느 쪽이든 preview는
  // raw file://에 의존하지 않고 항상 local-file://(안전 경로)를 쓴다 — 아래 재생 src 단언이 이를 강제한다.
  // 여기선 관찰만 기록(실패 아님).
  const rawFile = 'file:///' + encodeURI(REF.replace(/\\/g, '/'))
  const rawResult = await win.evaluate((u) => new Promise((res) => {
    const a = new Audio(u); let done = false
    const fin = (v) => { if (!done) { done = true; res(v) } }
    a.addEventListener('canplay', () => fin('canplay'), { once: true })
    a.addEventListener('error', () => fin('error'), { once: true })
    setTimeout(() => fin('timeout'), 3000)
  }), rawFile)
  log('관찰(비단언): raw file:// 직접 재생 결과 =', rawResult, '— preview는 이와 무관하게 local-file:// 사용')

  // ── 2) play/pause 계측 래핑 + 감정 등록 ──
  await win.evaluate(() => {
    window.__pv = { play: 0, pause: 0, lastSrc: '' }
    const P = window.HTMLMediaElement.prototype
    const op = P.play, opa = P.pause
    P.play = function (...a) { window.__pv.play++; window.__pv.lastSrc = this.currentSrc || this.src || ''; return op.apply(this, a) }
    P.pause = function (...a) { window.__pv.pause++; return opa.apply(this, a) }
  })
  await win.evaluate(() => {
    window.__afStore.getState().registerEmotionRef('happy', 'X:/synthetic/happy.wav')
    window.__afStore.getState().registerEmotionRef('sad', 'X:/synthetic/sad.wav')
  })
  await win.waitForTimeout(150)
  // 관리 패널 열기(EmotionReferenceManager) — '관리' 버튼.
  await win.getByRole('button', { name: '관리', exact: true }).click({ timeout: 8000 })
  const previewBtns = win.getByRole('button', { name: /미리듣기/ })
  ok((await previewBtns.count()) >= 2, `등록 감정별 미리듣기 버튼 존재(=${await previewBtns.count()})`)

  // ── 3) 미리듣기 재생 시작(첫 clip) ──
  await previewBtns.first().click()
  await win.waitForTimeout(400)
  const pv1 = await win.evaluate(() => window.__pv)
  ok(pv1.play >= 1, `미리듣기 클릭 → play 호출(=${pv1.play})`)
  ok(String(pv1.lastSrc).startsWith('local-file://'), `재생 src가 local-file://(안전 경로)(${String(pv1.lastSrc).slice(0, 18)}…)`)

  // ── 4) 다른 clip 전환 → 이전 정지(pause) + 새 play ──
  await previewBtns.nth(1).click()
  await win.waitForTimeout(400)
  const pv2 = await win.evaluate(() => window.__pv)
  ok(pv2.play >= 2, `다른 clip 미리듣기 → play 재호출(=${pv2.play})`)
  ok(pv2.pause >= 1, `전환 시 이전 재생 정지(pause 호출=${pv2.pause})`)

  // ── 5) 컴포넌트 해제(모드 전환) 정리 ──
  await win.evaluate(() => window.__afStore.getState().setMode('split'))
  await win.waitForTimeout(300)
  const pv3 = await win.evaluate(() => window.__pv)
  ok(pv3.pause >= 2, `TTSEditor 해제 시 미리듣기 정리(pause 누적=${pv3.pause})`)

  ok(pageErrors.length === 0, `pageerror 0 (=${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0] : ''})`)
} catch (e) {
  failed++; log('EXCEPTION', e?.message || String(e))
} finally {
  await app.close().catch(() => {})
  cleanupIsolated(ISO)
}
log(failed === 0 ? 'ALL PASS' : `${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
