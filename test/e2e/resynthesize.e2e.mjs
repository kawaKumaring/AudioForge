// 연속 합성 E2E — 구간 확정 후 같은 파생 클립으로 2회 합성 모두 완료(수명 + result/ready race 회귀).
// result 표시 시점엔 backend가 이미 free(main이 done 이후에만 result 전달)이므로, 결과 직후
// '다른 모드로 재처리' → 합성 시작을 '정상 UI 조작 1회'로 재합성한다(강제 status 변경/재클릭 없음).
// 실행: node test/e2e/resynthesize.e2e.mjs  (사전 npm run build). 실제 합성 2회 → 수 분.
// 완료 대기 = 350초. 근거: E2E 350 > Electron watchdog 300 > Qwen 무응답 280(synthesize-complete 주석 참조).
//   production 내부 안전장치가 발동하기 전에 E2E가 먼저 포기하지 않도록. production timeout은 불변.
import { _electron as electron } from 'playwright'
import fs from 'fs'; import path from 'path'
import { isolatedInput, cleanupIsolated, snapshotTree, refClipDirs, qwenJobDirs, qwenVenvPids } from './_e2e-helper.mjs'
const WAIT_MS = 350000
const APP = process.cwd()
const SRC = path.join(APP, 'resources', 'speaker_b.wav')
const RES_DIR = path.join(APP, 'resources')
const SHOT = path.join(APP, '_local', 'artifacts', 'diagnostics', 'e2e-shots'); fs.mkdirSync(SHOT, { recursive: true })
let failed = 0; const ok = (c, m) => { console.log(c ? '[e2e] PASS' : '[e2e] FAIL', m); if (!c) failed++ }
const resBefore = snapshotTree(RES_DIR)
const { dir: ISO, input: REF } = isolatedInput(SRC)
const pageErrors = []
const step = (m) => console.log('[e2e][step]', m)
const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
const win = await app.firstWindow(); win.on('pageerror', e => { pageErrors.push(e.message); console.log('[e2e] PAGEERROR', e.message) })

async function synthOnce(label) {
  const err0 = pageErrors.length
  step(`${label}: 합성 시작 클릭(정상 UI 1회)`)
  await win.getByText('음성 합성 시작', { exact: false }).click({ timeout: 8000 })
  // 강제 status 변경/재클릭 없이 1회 클릭으로 processing 진입해야 한다.
  await win.waitForFunction(() => window.__afStore?.getState().status === 'processing', undefined, { timeout: 8000 })
  ok(true, `${label}: 1회 클릭으로 processing 진입`)
  step(`${label}: 완료 대기(최대 ${WAIT_MS / 1000}s)`)
  await win.waitForFunction(() => ['done', 'error'].includes(window.__afStore?.getState().status), undefined, { timeout: WAIT_MS })
  const st = await win.evaluate(() => ({ status: window.__afStore.getState().status, err: window.__afStore.getState().error }))
  ok(st.status === 'done', `${label}: 합성 완료(status=done, error=${st.err || '없음'})`)
  ok(!(st.err && /이미 처리 중/.test(st.err)), `${label}: "이미 처리 중" 오류 없음`)
  ok(!(st.err && /TOO_LONG|10\.0s|부적합|만료/.test(st.err)), `${label}: TOO_LONG/만료 오류 없음`)
  ok(pageErrors.length === err0, `${label}: pageerror 0`)
}

try {
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
  step('111.08 분석 대기'); await win.waitForFunction(() => /111\.08/.test(document.getElementById('root')?.innerText || ''), undefined, { timeout: 30000 })
  step('구간 확정 클릭'); await win.getByText('이 구간으로 확정').click({ timeout: 20000 })
  step('ttsRefReady 대기'); await win.waitForFunction(() => window.__afStore?.getState().ttsRefReady === true, undefined, { timeout: 40000 })
  const clip1 = await win.evaluate(() => window.__afStore.getState().ttsReferenceClip)
  ok(!!clip1 && fs.existsSync(clip1), `구간 확정 → 클립 준비(${clip1 ? path.basename(path.dirname(clip1)) : 'none'})`)
  // 대사 입력(정상 UI): textarea에 타이핑
  const ta = win.locator('textarea').first()
  await ta.fill('첫 번째 합성입니다.')

  // 합성 1
  await synthOnce('1회차')
  const clipAfter1 = await win.evaluate(() => window.__afStore.getState().ttsReferenceClip)
  ok(clipAfter1 === clip1 && fs.existsSync(clipAfter1), '합성 후 파생 클립 유지(삭제 안 됨)')

  // 합성 2 — 결과 직후 '다른 모드로 재처리'(setIdle)로 입력 화면 복귀 → 정상 UI 1회 클릭 재합성.
  // main이 done 이후에만 result를 전달하므로 이 시점 backend는 이미 free → "이미 처리 중" 없이 1회로 진입.
  step('다른 모드로 재처리 클릭')
  await win.getByText('다른 모드로 재처리', { exact: false }).click({ timeout: 8000 })
  await win.waitForFunction(() => window.__afStore?.getState().status === 'idle', undefined, { timeout: 8000 })
  const clipReidle = await win.evaluate(() => window.__afStore.getState().ttsReferenceClip)
  ok(clipReidle === clip1 && fs.existsSync(clipReidle), '재처리 복귀 후에도 파생 클립 유지')
  ok(await win.evaluate(() => window.__afStore.getState().ttsRefReady === true), '재처리 후 ttsRefReady 유지')
  await win.locator('textarea').first().fill('두 번째 합성입니다.')
  await synthOnce('2회차')
  await win.screenshot({ path: path.join(SHOT, 'e2e_resynth.png') })
} catch (e) {
  failed++; console.log('[e2e] EXCEPTION', e?.message || String(e))
  try { await win.screenshot({ path: path.join(SHOT, 'e2e_resynth_FAIL.png') }) } catch { /* ignore */ }
} finally {
  try { await app.close() } catch { /* ignore */ }
  const OUT_BASE = path.join(path.dirname(REF), 'AudioForge_output')
  const pids = qwenVenvPids()
  ok(pids.length === 0, `종료 후 Qwen venv 자식 프로세스 0(잔존=${pids.join(',') || '없음'})`)
  ok(qwenJobDirs(OUT_BASE).length === 0, `종료 후 .qwen-job-* 정리(leftover=${qwenJobDirs(OUT_BASE).length})`)
  ok(refClipDirs().length === 0, `종료 후 파생 참조 임시폴더 정리(leftover=${refClipDirs().length})`)
  ok(snapshotTree(RES_DIR) === resBefore, 'resources/ 원본·기존 출력 불변(size/hash/목록)')
  cleanupIsolated(ISO)  // 예외에도 반드시 정리
}
console.log('[e2e] SUMMARY', JSON.stringify({ failed, pageErrors: pageErrors.length }))
process.exit(failed === 0 ? 0 : 1)
