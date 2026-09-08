// 합성이 도는 동안 목소리 설정을 만져도 오류가 나지 않는가 (2026-09-08 실사용 보고).
//
// 무슨 일이 있었나: 사용자가 합성 중에 고급 설정의 '참조 목표 길이'를 움직였다. 그 값이 바뀌면
// 참조를 다시 살펴봐야 하는데, 워커는 한 번에 하나만 돌기 때문에 main 이
//   Error: 처리 중에는 참조 분석을 실행할 수 없습니다
// 로 거절했고, 그 거절이 화면에서 처리되지 않은 오류로 튀어나왔다.
//
// 고친 방향 두 가지를 여기서 함께 확인한다.
//   1) 슬라이더를 끄는 동안에는 설정에 바로 반영하지 않는다(손을 뗀 뒤 0.5초).
//   2) 합성 중에는 다시 살펴보기를 아예 부르지 않고, 합성이 끝나 조작이 풀리면 그때 한다.
//
// 실행: node test/e2e/analyze-during-synthesis.e2e.mjs   (사전: npm run build, GPU 사용)
//   AF_E2E_REFERENCE 로 실제 말이 든 참조를 준다(없으면 저장소 fixture).
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedInput, cleanupIsolated, isolatedUserData, cleanupUserData, nvidiaSmiGpu0 } from './_e2e-helper.mjs'

const APP = process.cwd()
const SRC = (process.env.AF_E2E_REFERENCE || '').trim()
  || path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav')
if (!fs.existsSync(SRC)) { console.error(`참조 없음: ${SRC}`); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const SHOT = path.join(APP, '_local', 'artifacts', 'diagnostics', 'e2e-shots')
fs.mkdirSync(SHOT, { recursive: true })
let failed = 0
// 로그는 실행마다 다른 이름으로 남긴다. 예전에는 한 이름을 덮어써서, 게이트 안에서 한 번
// 실패하고 다시 돌려 통과하면 **실패했던 실행의 근거가 사라졌다**(2026-09-09 실측).
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
const logLines = []
const log = (...a) => {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  logLines.push(s)
  console.log('[synth-settings]', s)
}
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { dir: ISO, input: REF } = isolatedInput(SRC)
const UD = isolatedUserData()
const pageErrors = [], mainOut = []
const app = await electron.launch({
  args: ['out/main/index.js'], cwd: APP,
  env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
})
app.process().stdout.on('data', (d) => mainOut.push(String(d)))
app.process().stderr.on('data', (d) => mainOut.push(String(d)))
const win = await app.firstWindow()
win.on('pageerror', (e) => pageErrors.push(e.message))

try {
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
  await win.waitForFunction(() => window.__afStore?.getState().ttsRefReady === true,
    undefined, { timeout: 180000 })
  ok(true, '참조 준비됨')

  await win.evaluate(() => window.__afStore.setState({ ttsText: '안녕하세요. 오늘은 날씨가 좋습니다.' }))
  await win.getByText('음성 합성 시작', { exact: false }).click({ timeout: 8000 })
  await win.waitForFunction(() => window.__afStore?.getState().status === 'processing',
    undefined, { timeout: 15000 })
  ok(true, '합성 시작(processing)')

  const errBefore = pageErrors.length
  const mainBefore = mainOut.join('').length

  // 합성이 도는 동안 목표 길이를 바꾼다 — 오류가 났던 바로 그 동작.
  await win.evaluate(() => window.__afStore.setState({ ttsRefTargetSec: 20 }))
  await sleep(3000)
  const during = mainOut.join('').slice(mainBefore)
  ok(!/처리 중에는 참조 분석을 실행할 수 없습니다/.test(during),
    '합성 중 설정을 바꿔도 참조 분석 거절 오류가 없다')
  ok(pageErrors.length === errBefore, '합성 중 렌더러 예외 0',
    pageErrors.slice(errBefore).join(' | '))
  const stillRunning = await win.evaluate(() => window.__afStore.getState().status)
  ok(stillRunning === 'processing', `설정 변경이 합성을 끊지 않는다(status=${stillRunning})`)

  // 합성이 끝나면 미뤄 둔 다시 살펴보기가 그때 돌아 추천이 새 길이로 갱신돼야 한다.
  await win.waitForFunction(() => ['done', 'error'].includes(window.__afStore?.getState().status),
    undefined, { timeout: 400000 })
  const final = await win.evaluate(() => window.__afStore.getState().status)
  if (final !== 'done') {
    // 왜 안 됐는지를 그 자리에서 남긴다 — 나중에 물어볼 곳이 없다.
    const snap = await win.evaluate(() => {
      const s = window.__afStore.getState()
      return { status: s.status, error: s.error, progress: s.progress, progressMessage: s.progressMessage }
    })
    log('미완료 원인 감사 — store:', snap)
    log('  nvidia-smi GPU0(used/free MiB):', nvidiaSmiGpu0() || '측정 실패')
  }
  ok(final === 'done', `합성이 끝까지 간다(status=${final})`)
  await win.waitForFunction(() => window.__afStore?.getState().ttsRefReady === true,
    undefined, { timeout: 180000 }).catch(() => {})
  const after = await win.evaluate(() => ({
    ready: window.__afStore.getState().ttsRefReady,
    target: window.__afStore.getState().ttsRefTargetSec,
  }))
  ok(after.ready === true && after.target === 20,
    '합성이 끝난 뒤 목소리가 다시 준비되고 바꾼 설정이 남아 있다', JSON.stringify(after))
  ok(pageErrors.length === 0, '전 구간 렌더러 예외 0', pageErrors.join(' | '))
  await win.screenshot({ path: path.join(SHOT, 'synth-settings.png') })
} catch (e) {
  failed++
  log('EXCEPTION', e?.message || String(e))
  try { await win.screenshot({ path: path.join(SHOT, 'synth-settings-FAIL.png') }) } catch { /* ignore */ }
} finally {
  try { await app.close() } catch { /* ignore */ }
  cleanupIsolated(ISO)
  cleanupUserData(UD)
  const tag = failed === 0 ? 'ok' : 'FAIL'
  const NL = String.fromCharCode(10)
  fs.writeFileSync(path.join(SHOT, `synth-settings-${STAMP}-${tag}.txt`),
    `${logLines.join(NL)}${NL}${NL}--- main ---${NL}${mainOut.join('')}`, 'utf-8')
}
log(failed === 0 ? '전부 통과' : `실패 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
