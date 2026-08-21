// Electron E2E 스모크 — 실제 앱을 실행해 검은 화면/크래시 회귀를 막는다.
// 실행: node test/e2e/synthesize.e2e.mjs   (사전: npm run build)
// 프로덕션 빌드(out/main/index.js, loadFile)를 단일 인스턴스로 띄우고, 파일 주입→TTS→구간 확정→
// 합성 클릭→취소→모드 전환→재진입을 실제로 구동하며 pageerror/crash/검은 화면이 없음을 단언한다.
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'

const APP = process.cwd()
const REF = path.join(APP, 'resources', 'speaker_b.wav')
const SHOT = path.join(APP, '작업파일', 'e2e_shots')
fs.mkdirSync(SHOT, { recursive: true })
const logLines = []
const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); logLines.push(s); console.log('[e2e]', s) }

let failed = 0
function ok(cond, msg) { if (cond) { log('PASS', msg) } else { failed++; log('FAIL', msg) } }

if (!fs.existsSync(REF)) { console.error('필수 검증 파일 없음:', REF); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }

const pageErrors = [], consoleErrors = [], crashes = []
const mainOut = []

const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
app.process().stdout.on('data', d => mainOut.push(String(d)))
app.process().stderr.on('data', d => mainOut.push(String(d)))
const win = await app.firstWindow()
win.on('pageerror', e => pageErrors.push(e.message))
win.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
win.on('crash', () => crashes.push('crash'))

async function measure() {
  return win.evaluate(() => {
    const root = document.getElementById('root')
    const txt = root?.innerText || ''
    const overlays = [...document.querySelectorAll('*')].filter(el => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el)
      return r.width >= innerWidth * 0.98 && r.height >= innerHeight * 0.98 &&
        (s.position === 'fixed' || s.position === 'absolute') && +(s.zIndex || 0) > 1000
    })
    return { len: txt.length, txt: txt.replace(/\s+/g, ' ').slice(0, 200), overlays: overlays.length }
  })
}

try {
  // 1) 단일 인스턴스 실행 + 초기 화면 non-empty
  await win.waitForLoadState('domcontentloaded')
  ok((await app.windows()).length === 1, '단일 윈도우')
  const init = await measure()
  await win.screenshot({ path: path.join(SHOT, 'e2e_01_initial.png') })
  ok(init.len > 20, `초기 화면 non-empty(len=${init.len})`)
  ok(init.overlays === 0, '초기 전체화면 overlay 없음')

  // 2) 파일 주입 + TTS 진입 → analyze/preflight 동시 초기화
  await win.evaluate(async (p) => {
    const s = window.__afStore
    const info = await window.api.audio.getFileInfo(p)
    const url = await window.api.audio.getFileUrl(p)
    s.getState().setFile(info, url); s.getState().setMode('tts')
  }, REF)
  await win.waitForFunction(() => /111\.08/.test(document.getElementById('root')?.innerText || ''), { timeout: 30000 })
  const tts = await measure()
  await win.screenshot({ path: path.join(SHOT, 'e2e_02_tts.png') })
  ok(/111\.08/.test(tts.txt), '111.08초 분석 결과 표시')
  const spawnedAnalyze = mainOut.join('').includes('refanalyze')
  const spawnedPreflight = mainOut.join('').includes('qwenpre')
  ok(spawnedAnalyze && spawnedPreflight, 'analyze + preflight 동시 초기화(둘 다 spawn)')
  ok(pageErrors.length === 0 && crashes.length === 0, 'TTS 진입: pageerror/crash 0')

  // 3) 구간 확정 → 파생 클립 ready
  await win.getByText('이 구간으로 확정').click({ timeout: 20000 })
  await win.waitForFunction(() => window.__afStore?.getState().ttsRefReady === true, { timeout: 40000 })
  ok(true, '구간 확정 → ttsRefReady=true')
  await win.evaluate(() => window.__afStore.setState({ ttsText: '안녕하세요. 테스트 문장입니다.' }))

  // 4) 합성 클릭 → audio:process 1회 + processing UI + 검은 화면/크래시 없음
  const beforeCfg = mainOut.join('').split('Config written').length - 1
  await win.getByText('음성 합성 시작', { exact: false }).click({ timeout: 8000 })
  await win.waitForTimeout(3000)
  const afterClick = await measure()
  await win.screenshot({ path: path.join(SHOT, 'e2e_03_after_synth_click.png') })
  const cfgCount = mainOut.join('').split('Config written').length - 1 - beforeCfg
  ok(cfgCount === 1, `audio:process 정확히 1회(config written=${cfgCount})`)
  ok(afterClick.len > 20, `합성 클릭 후 화면 non-empty(len=${afterClick.len})`)
  ok(afterClick.overlays === 0, '합성 클릭 후 검은 전체 overlay 없음')
  ok(pageErrors.length === 0 && crashes.length === 0, '합성 클릭: pageerror/crash 0')
  const processingUI = await win.evaluate(() => /처리 취소|중\.\.\.|Qwen|합성/.test(document.getElementById('root')?.innerText || ''))
  ok(processingUI, 'processing UI 표시 유지')

  // 5) 취소 → 정상 화면 복귀
  await win.getByText('처리 취소').click({ timeout: 8000 }).catch(() => log('취소 버튼 없음(이미 완료?)'))
  await win.waitForTimeout(1500)
  const afterCancel = await measure()
  ok(afterCancel.len > 20 && afterCancel.overlays === 0, '취소 후 정상 화면')

  // 6) 다른 모드 이동 후 합성 모드 재진입
  await win.evaluate(() => window.__afStore.getState().setMode('music'))
  await win.waitForTimeout(300)
  await win.evaluate(() => window.__afStore.getState().setMode('tts'))
  await win.waitForTimeout(500)
  const reenter = await measure()
  await win.screenshot({ path: path.join(SHOT, 'e2e_04_reenter.png') })
  ok(reenter.len > 20 && reenter.overlays === 0, 'TTS 재진입 정상')
  ok(pageErrors.length === 0 && crashes.length === 0, '전 과정 pageerror/crash 0')
} catch (e) {
  failed++; log('EXCEPTION', e?.message || String(e))
  try { await win.screenshot({ path: path.join(SHOT, 'e2e_FAIL.png') }) } catch { /* ignore */ }
}

await app.close()

// 7) 종료 후 임시 파생/작업 폴더 정리 확인(best-effort)
const os = await import('os')
const tmp = os.tmpdir()
const leftover = fs.readdirSync(tmp).filter(n => n.startsWith('audioforge_refclip_'))
ok(leftover.length === 0, `종료 후 파생 참조 임시폴더 정리(leftover=${leftover.length})`)

fs.writeFileSync(path.join(SHOT, 'e2e_log.txt'), logLines.join('\n') + '\n\n--- main ---\n' + mainOut.join(''), 'utf-8')
if (pageErrors.length) log('PAGEERRORS', pageErrors.join(' | '))
log('SUMMARY', { failed, pageErrors: pageErrors.length, consoleErrors: consoleErrors.length, crashes: crashes.length, shots: SHOT })
process.exit(failed === 0 ? 0 : 1)
