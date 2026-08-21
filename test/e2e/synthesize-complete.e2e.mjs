// Electron 완료 E2E — 실제 Qwen 합성을 끝까지 실행해 결과물/결과 GUI를 검증(1회).
// 실행: node test/e2e/synthesize-complete.e2e.mjs   (사전: npm run build). 수 분 소요(실제 합성).
import { _electron as electron } from 'playwright'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const APP = process.cwd()
const REF = path.join(APP, 'resources', 'speaker_b.wav')
const SHOT = path.join(APP, '작업파일', 'e2e_shots')
const PY = 'E:/AI/ComfyUI_windows_portable_python3.12/python_embeded/python.exe'
fs.mkdirSync(SHOT, { recursive: true })
let failed = 0
const ok = (c, m) => { console.log(c ? '[e2e] PASS' : '[e2e] FAIL', m); if (!c) failed++ }
if (!fs.existsSync(REF)) { console.error('필수 파일 없음:', REF); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const OUT_BASE = path.join(path.dirname(REF), 'AudioForge_output')
try { fs.rmSync(OUT_BASE, { recursive: true, force: true }) } catch { /* ignore */ }

const pageErrors = [], crashes = []
const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
const win = await app.firstWindow()
win.on('pageerror', e => pageErrors.push(e.message))
win.on('crash', () => crashes.push('crash'))

try {
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async (p) => {
    const s = window.__afStore
    const info = await window.api.audio.getFileInfo(p)
    const url = await window.api.audio.getFileUrl(p)
    s.getState().setFile(info, url); s.getState().setMode('tts')
  }, REF)
  await win.waitForFunction(() => /111\.08/.test(document.getElementById('root')?.innerText || ''), { timeout: 30000 })
  await win.getByText('이 구간으로 확정').click({ timeout: 20000 })
  await win.waitForFunction(() => window.__afStore?.getState().ttsRefReady === true, { timeout: 40000 })
  await win.evaluate(() => window.__afStore.setState({ ttsText: '안녕하세요.' }))
  await win.getByText('음성 합성 시작', { exact: false }).click({ timeout: 8000 })
  await win.waitForFunction(() => window.__afStore?.getState().status === 'processing', { timeout: 8000 })
  ok(true, '합성 시작(processing)')

  // 실제 합성 완료까지 대기(최대 240s). 오류로 마감되면 즉시 실패.
  await win.waitForFunction(() => ['done', 'error'].includes(window.__afStore?.getState().status), { timeout: 240000 })
  const st = await win.evaluate(() => ({
    status: window.__afStore.getState().status,
    outputDir: window.__afStore.getState().outputDir,
    tracks: window.__afStore.getState().tracks,
    meta: window.__afStore.getState().resultMetadata,
    error: window.__afStore.getState().error,
  }))
  ok(st.status === 'done', `합성 완료(status=done, error=${st.error || '없음'})`)

  // synthesized.wav 존재·디코딩·NaN 없음(python+soundfile로 실제 검증)
  const wav = (st.tracks && st.tracks[0] && st.tracks[0].path) || (st.outputDir && path.join(st.outputDir, 'synthesized.wav'))
  ok(!!wav && fs.existsSync(wav), `synthesized.wav 존재(${wav})`)
  if (wav && fs.existsSync(wav)) {
    const probe = execFileSync(PY, ['-X', 'utf8', '-c',
      `import soundfile as sf,numpy as np,sys;d,sr=sf.read(sys.argv[1]);` +
      `print('OK',len(d),sr,bool(np.all(np.isfinite(d))),float(np.max(np.abs(d))) if len(d) else 0)`,
      wav], { encoding: 'utf-8' }).trim().split('\n').pop()
    const [, n, sr, finite, peak] = probe.split(' ')
    ok(+n > 0 && +sr > 0, `디코딩 OK(frames=${n}, sr=${sr})`)
    ok(finite === 'True', `NaN/Inf 없음(finite=${finite})`)
    ok(+peak > 0, `무음 아님(peak=${peak})`)
  }

  // 결과 GUI + metadata 표시
  ok(st.meta && st.meta.actual_engine, `resultMetadata 표시(actual_engine=${st.meta?.actual_engine}, device=${st.meta?.device})`)
  const gui = await win.evaluate(() => document.getElementById('root')?.innerText || '')
  ok(/합성 정보/.test(gui) && /(실제 엔진|Qwen3|GPT-SoVITS)/.test(gui), '결과 GUI(합성 정보) 표시')
  await win.screenshot({ path: path.join(SHOT, 'e2e_complete_result.png') })
  ok(pageErrors.length === 0 && crashes.length === 0, '완료까지 pageerror/crash 0')
} catch (e) {
  failed++; console.log('[e2e] EXCEPTION', e?.message || String(e))
  try { await win.screenshot({ path: path.join(SHOT, 'e2e_complete_FAIL.png') }) } catch { /* ignore */ }
}

await app.close()
console.log('[e2e] SUMMARY', JSON.stringify({ failed, pageErrors: pageErrors.length, crashes: crashes.length }))
process.exit(failed === 0 ? 0 : 1)
