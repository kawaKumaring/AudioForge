// reset 정리 회귀 — 구간 확정으로 파생 클립 폴더 생성 후 store.reset()이 그 폴더를 실제 삭제하는지.
// 합성 없이 빠름. 실행: node test/e2e/reset-cleanup.e2e.mjs  (사전 npm run build)
import { _electron as electron } from 'playwright'
import { randomUUID } from 'crypto'
import fs from 'fs'; import path from 'path'; import os from 'os'
import { isolatedInput, cleanupIsolated, snapshotTree, makeSyntheticWav, cleanupSyntheticWav } from './_e2e-helper.mjs'
const APP = process.cwd()
// 사용자 미디어 미사용: AF_E2E_REFERENCE가 있으면 그것을, 없으면 이번 실행 전용 synthetic WAV(30s)를 생성해 쓴다.
const SYNTH = (process.env.AF_E2E_REFERENCE || '').trim() ? null : makeSyntheticWav(path.join(os.tmpdir(), 'af_e2e_synth_' + randomUUID() + '.wav'), 30)
const SRC = SYNTH || process.env.AF_E2E_REFERENCE.trim()
const RES_DIR = path.join(APP, 'resources')
let failed = 0; const ok = (c, m) => { console.log(c ? '[e2e] PASS' : '[e2e] FAIL', m); if (!c) failed++ }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const resBefore = snapshotTree(RES_DIR)
const { dir: ISO, input: REF } = isolatedInput(SRC)
const refclipDirs = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('audioforge_refclip_'))

const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
const win = await app.firstWindow()
try {
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
  // 참조 분석 완료 = '이 구간으로 확정' 버튼 등장(지속시간 텍스트 하드코딩 대신 의미 기반 대기 — synthetic 길이 무관).
  await win.getByText('이 구간으로 확정').waitFor({ timeout: 30000 })
  const before = refclipDirs().length
  await win.getByText('이 구간으로 확정').click({ timeout: 20000 })
  await win.waitForFunction(() => window.__afStore?.getState().ttsRefReady === true, undefined, { timeout: 40000 })
  const clip = await win.evaluate(() => window.__afStore.getState().ttsReferenceClip)
  ok(!!clip && fs.existsSync(clip), `구간 확정 → 파생 클립 파일 생성(${clip ? path.basename(path.dirname(clip)) : 'none'})`)
  ok(refclipDirs().length === before + 1, '파생 참조 폴더 1개 생성')

  // reset → 파생 폴더 삭제 + 참조 상태 초기화
  await win.evaluate(() => window.__afStore.getState().reset())
  const t = Date.now()
  while (fs.existsSync(clip) && Date.now() - t < 10000) await win.waitForTimeout(300)
  ok(!fs.existsSync(clip), 'reset 후 파생 클립 폴더 실제 삭제됨')
  const st = await win.evaluate(() => {
    const s = window.__afStore.getState()
    return { clip: s.ttsReferenceClip, ready: s.ttsRefReady, msg: s.ttsRefMessage, region: s.ttsReferenceRegion, file: s.fileInfo }
  })
  ok(st.clip === '' && st.ready === false && st.msg === '' && st.region === null, 'reset 후 참조 상태 초기화')
  ok(st.file === null, 'reset 후 fileInfo 초기화')
} catch (e) {
  failed++; console.log('[e2e] EXCEPTION', e?.message || String(e))
} finally {
  try { await app.close() } catch { /* ignore */ }
  ok(snapshotTree(RES_DIR) === resBefore, 'resources/ 원본 불변')
  cleanupIsolated(ISO)  // 예외에도 반드시 정리
  if (SYNTH) cleanupSyntheticWav(SYNTH)  // 이번 실행이 만든 synthetic 소스만 정리
}
console.log('[e2e] SUMMARY', JSON.stringify({ failed }))
process.exit(failed === 0 ? 0 : 1)
