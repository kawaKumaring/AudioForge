// reset 정리 회귀 — 구간 확정으로 파생 클립 폴더 생성 후 store.reset()이 그 폴더를 실제 삭제하는지.
// 합성 없이 빠름. 실행: node test/e2e/reset-cleanup.e2e.mjs  (사전 npm run build)
import { _electron as electron } from 'playwright'
import fs from 'fs'; import path from 'path'; import os from 'os'
import { isolatedInput, cleanupIsolated, snapshotTree } from './_e2e-helper.mjs'
const APP = process.cwd()
// 참조 클립 생성(무음 경계로 자른 뒤 전사)을 지나야 하므로 **실제 말이 든 오디오**가 필요하다.
// 합성 사인파로는 지날 수 없다 — 전사가 비면 앱이 BLOCK_TRANSCRIBE_FAILED 로 막는다(정상 동작).
// 그래서 저장소가 직접 가진 fixture 하나만 쓴다. 저장소 밖을 보지 않으므로 clean clone·
// 다른 PC·CI 어디서나 같은 결과가 난다. 출처·SHA·좌표는 doc/test-fixtures.md 에 있다.
const FIXTURE = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')
const SRC = fs.existsSync(FIXTURE) ? FIXTURE : null
const RES_DIR = path.dirname(FIXTURE)   // 불변 검사 대상 = fixture 폴더
let failed = 0; const ok = (c, m) => { console.log(c ? '[e2e] PASS' : '[e2e] FAIL', m); if (!c) failed++ }
if (!SRC) { console.error(`fixture 없음: ${FIXTURE}`); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const resBefore = snapshotTree(RES_DIR)
const { dir: ISO, input: REF } = isolatedInput(SRC)
const refclipDirs = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('audioforge_refclip_'))

const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
const win = await app.firstWindow()
try {
  await win.waitForLoadState('domcontentloaded')
  // 이관(2026-08-31): 수동 '이 구간으로 확정' 은 접힌 구간 편집기 안으로 들어갔고,
  // 말이 든 자산에서는 앱이 구간을 스스로 골라 파생 클립까지 만든다. 이 테스트가 보는 것은
  // 그 폴더를 reset 이 실제로 지우는가이므로, 만들어지는 계기만 현행에 맞춘다.
  // 폴더 수는 파일 주입 **전에** 센다 — 주입 직후 자동으로 하나 늘기 때문이다.
  const before = refclipDirs().length
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
  await win.waitForFunction(() => window.__afStore?.getState().ttsRefReady === true, undefined, { timeout: 60000 })
  const clip = await win.evaluate(() => window.__afStore.getState().ttsReferenceClip)
  ok(!!clip && fs.existsSync(clip), `파생 클립 파일 생성(${clip ? path.basename(path.dirname(clip)) : 'none'})`)
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
  ok(snapshotTree(RES_DIR) === resBefore, 'fixture 원본 불변')
  cleanupIsolated(ISO)  // 예외에도 반드시 정리
}
console.log('[e2e] SUMMARY', JSON.stringify({ failed }))
process.exit(failed === 0 ? 0 : 1)
