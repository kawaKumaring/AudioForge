// Electron 완료 E2E — 실제 Qwen 합성을 끝까지 실행해 결과물/결과 GUI를 검증(1회).
// 실행: node test/e2e/synthesize-complete.e2e.mjs   (사전: npm run build). 수 분 소요(실제 합성).
//
// 완료 대기 = 350초. 근거(타임아웃 계층): E2E 350 > Electron watchdog 300(audio.ipc.ts, 무진행)
//   > Qwen 무응답 280(tts_worker.py _QWEN_INACTIVITY_SEC). 240초였을 때 production 내부 안전장치가
//   발동하기 '전에' E2E가 먼저 포기해 device/source/최종 상태를 관측하지 못하고 Playwright Timeout만
//   났다(2026-08-22 develop 감사에서 실측). 350초면 완료 / 280초 무응답 오류 / 300초 watchdog 오류가
//   모두 이 창 안에서 관측된다. production timeout(280/300)은 변경하지 않는다.
// 타임아웃/완료 무관하게 종료 후 잔존(venv 자식·.qwen-job-*·refclip)이 0임을 단언한다.
import { _electron as electron } from 'playwright'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { isolatedInput, cleanupIsolated, snapshotTree, refClipDirs, qwenJobDirs, qwenVenvPids, nvidiaSmiGpu0, requireE2EReference } from './_e2e-helper.mjs'

const WAIT_MS = 350000  // > watchdog 300 > 무응답 280 (위 근거 참조)
const APP = process.cwd()
const SRC = requireE2EReference()   // 명시 AF_E2E_REFERENCE 단일 권위(speaker_b.wav 하드코딩·fallback 없음)
const RES_DIR = path.join(APP, 'resources')
const SHOT = path.join(APP, '_local', 'artifacts', 'diagnostics', 'e2e-shots')
// 검증용 파이썬. 특정 PC 의 절대 경로를 박으면 다른 곳에서 재현되지 않는다 — 명시 env 로만 받는다.
const PY = (process.env.AF_E2E_PYTHON || '').trim()
if (!PY || !fs.existsSync(PY)) {
  console.error('prerequisite: AF_E2E_PYTHON 미설정 또는 경로 없음 — 검증용 파이썬이 필요합니다.')
  process.exit(2)
}
fs.mkdirSync(SHOT, { recursive: true })
let failed = 0
const logLines = []
const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); logLines.push(s); console.log('[e2e]', s) }
const ok = (c, m) => { log(c ? 'PASS' : 'FAIL', m); if (!c) failed++ }
// (참조 자산 검증은 requireE2EReference가 처리 — 경로·내용 미출력)
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
// resources/ 삭제 금지 — 입력을 격리 tmp로 복사, 출력도 그 안에 생성.
const resBefore = snapshotTree(RES_DIR)
const { dir: ISO, input: REF } = isolatedInput(SRC)
const OUT_BASE = path.join(path.dirname(REF), 'AudioForge_output')

const pageErrors = [], crashes = [], mainOut = []
log('시작 nvidia-smi GPU0(used/free MiB):', nvidiaSmiGpu0() || '측정 실패')
const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
app.process().stdout.on('data', d => mainOut.push(String(d)))
app.process().stderr.on('data', d => mainOut.push(String(d)))
const win = await app.firstWindow()
win.on('pageerror', e => pageErrors.push(e.message))
win.on('crash', () => crashes.push('crash'))

let lastSnap = null
try {
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async (p) => {
    const s = window.__afStore
    const info = await window.api.audio.getFileInfo(p)
    const url = await window.api.audio.getFileUrl(p)
    s.getState().setFile(info, url); s.getState().setMode('tts')
  }, REF)
  await win.getByText('이 구간으로 확정').waitFor({ timeout: 30000 })   // 참조 패널 분석 완료 대기(파일별 duration 하드코딩 없음)
  await win.getByText('이 구간으로 확정').click({ timeout: 20000 })
  await win.waitForFunction(() => window.__afStore?.getState().ttsRefReady === true, undefined, { timeout: 40000 })
  await win.evaluate(() => window.__afStore.setState({ ttsText: '안녕하세요.' }))
  await win.getByText('음성 합성 시작', { exact: false }).click({ timeout: 8000 })
  await win.waitForFunction(() => window.__afStore?.getState().status === 'processing', undefined, { timeout: 8000 })
  ok(true, '합성 시작(processing)')

  // 완료 대기 = 폴링 루프. 매 초 store 상태를 lastSnap에 기록 → 타임아웃 시 device/source/최종 progress 관측.
  const deadline = Date.now() + WAIT_MS
  let settled = false
  while (Date.now() < deadline) {
    lastSnap = await win.evaluate(() => {
      const s = window.__afStore.getState()
      return { status: s.status, progress: s.progress, progressMessage: s.progressMessage, error: s.error }
    })
    if (['done', 'error'].includes(lastSnap.status)) { settled = true; break }
    await win.waitForTimeout(1000)
  }
  log('최종 store 스냅샷:', lastSnap)
  ok(settled, `완료 대기 ${WAIT_MS / 1000}s 내 정착(status=${lastSnap?.status}, progress=${lastSnap?.progress}, "${lastSnap?.progressMessage}")`)
  if (!settled) {
    // production이 아직 무진행이면(로딩/합성 정체) 여기서 device/source/nvidia-smi를 남겨 원인 감사.
    log('미정착 원인 감사 — nvidia-smi GPU0(used/free):', nvidiaSmiGpu0() || '측정 실패')
    log('  마지막 progress 메시지(장치/단계 근거):', lastSnap?.progressMessage || '(없음)')
  }

  const st = await win.evaluate(() => ({
    status: window.__afStore.getState().status,
    outputDir: window.__afStore.getState().outputDir,
    tracks: window.__afStore.getState().tracks,
    meta: window.__afStore.getState().resultMetadata,
    error: window.__afStore.getState().error,
  }))
  ok(st.status === 'done', `합성 완료(status=done, error=${st.error || '없음'})`)

  if (st.status === 'done') {
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
    ok(st.meta && st.meta.actual_engine, `resultMetadata 표시(actual_engine=${st.meta?.actual_engine}, device=${st.meta?.device}, source=${st.meta?.device_selection_source})`)
    const gui = await win.evaluate(() => document.getElementById('root')?.innerText || '')
    ok(/합성 정보/.test(gui) && /(실제 엔진|Qwen3|GPT-SoVITS)/.test(gui), '결과 GUI(합성 정보) 표시')
    await win.screenshot({ path: path.join(SHOT, 'e2e_complete_result.png') })
  }
  ok(pageErrors.length === 0 && crashes.length === 0, '완료까지 pageerror/crash 0')
} catch (e) {
  failed++; log('EXCEPTION', e?.message || String(e))
  log('예외 시점 store 스냅샷:', lastSnap)
  log('예외 시점 nvidia-smi GPU0(used/free):', nvidiaSmiGpu0() || '측정 실패')
  try { await win.screenshot({ path: path.join(SHOT, 'e2e_complete_FAIL.png') }) } catch { /* ignore */ }
} finally {
  try { await app.close() } catch { /* ignore */ }
  // 타임아웃/완료 무관하게: 종료 후 worker/venv 자식·중간 산출물·파생 클립이 남지 않아야 한다.
  const pids = qwenVenvPids()
  ok(pids.length === 0, `종료 후 Qwen venv 자식 프로세스 0(잔존=${pids.join(',') || '없음'})`)
  const jobs = qwenJobDirs(OUT_BASE)
  ok(jobs.length === 0, `종료 후 .qwen-job-* 정리(leftover=${jobs.length})`)
  const clips = refClipDirs()
  ok(clips.length === 0, `종료 후 파생 참조 임시폴더 정리(leftover=${clips.length})`)
  ok(snapshotTree(RES_DIR) === resBefore, 'resources/ 원본·기존 출력 불변(size/hash/목록)')
  cleanupIsolated(ISO)  // 격리 폴더만 삭제(예외에도 반드시)
  fs.writeFileSync(path.join(SHOT, 'e2e_complete_log.txt'), logLines.join('\n') + '\n\n--- main ---\n' + mainOut.join(''), 'utf-8')
}
log('SUMMARY', { failed, pageErrors: pageErrors.length, crashes: crashes.length })
process.exit(failed === 0 ? 0 : 1)
