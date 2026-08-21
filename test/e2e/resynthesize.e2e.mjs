// 연속 합성 E2E — 구간 확정 후 같은 파생 클립으로 2회 합성 모두 완료(수명 버그 회귀).
// 실행: node test/e2e/resynthesize.e2e.mjs  (사전 npm run build). 실제 합성 2회 → 수 분.
import { _electron as electron } from 'playwright'
import fs from 'fs'; import path from 'path'
import { isolatedInput, cleanupIsolated, snapshotTree } from './_e2e-helper.mjs'
const APP = process.cwd()
const SRC = path.join(APP, 'resources', 'speaker_b.wav')  // 111s(>10s) → 구간 선택 경로. 원본은 읽기만.
const RES_DIR = path.join(APP, 'resources')
const SHOT = path.join(APP, '작업파일', 'e2e_shots'); fs.mkdirSync(SHOT, { recursive: true })
let failed = 0; const ok = (c, m) => { console.log(c ? '[e2e] PASS' : '[e2e] FAIL', m); if (!c) failed++ }
// resources/를 삭제하지 않는다 — 입력을 격리 tmp 폴더로 복사해 주입하고 출력도 그 안에 생성.
const resBefore = snapshotTree(RES_DIR)
const { dir: ISO, input: REF } = isolatedInput(SRC)
const pageErrors = []
const mainOut = []
const step = (m) => console.log('[e2e][step]', m)
const exits = () => (mainOut.join('').match(/Process exited/g) || []).length
const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
app.process().stdout.on('data', d => { mainOut.push(String(d)); process.stdout.write('[main] ' + d) })
app.process().stderr.on('data', d => { mainOut.push(String(d)); process.stdout.write('[main:err] ' + d) })
const win = await app.firstWindow(); win.on('pageerror', e => { pageErrors.push(e.message); console.log('[e2e] PAGEERROR', e.message) })

async function clickSynthUntilProcessing(label) {
  // result(done)와 worker 프로세스 exit(runner=null) 사이 간극에서 재클릭 시 "이미 처리 중"이 날 수 있다.
  // 앱은 프로세스 종료 후 재합성을 허용하므로, processing 진입까지 최대 몇 회 재시도(사용자 재클릭 모델).
  for (let i = 0; i < 8; i++) {
    await win.getByText('음성 합성 시작', { exact: false }).click({ timeout: 8000 })
    try {
      await win.waitForFunction(() => window.__afStore?.getState().status === 'processing', undefined, { timeout: 4000 })
      return
    } catch {
      const s = await win.evaluate(() => ({ status: window.__afStore.getState().status, err: window.__afStore.getState().error }))
      if (s.status === 'error' && /이미 처리 중/.test(s.err || '')) {
        step(`${label}: 이전 worker 종료 대기 후 재클릭(${i + 1})`)
        await win.evaluate(() => window.__afStore.setState({ status: 'idle', error: null }))
        await win.waitForTimeout(1500)
        continue
      }
      throw new Error(`${label}: processing 진입 실패(status=${s.status}, err=${s.err})`)
    }
  }
  throw new Error(`${label}: processing 진입 재시도 소진`)
}

async function synthOnce(label) {
  const err0 = pageErrors.length
  const exit0 = exits()
  step(`${label}: 합성 버튼 클릭 시도`)
  await clickSynthUntilProcessing(label)
  step(`${label}: processing 진입 — 완료 대기(최대 240s)`)
  await win.waitForFunction(() => ['done', 'error'].includes(window.__afStore?.getState().status), undefined, { timeout: 240000 })
  const st = await win.evaluate(() => ({ status: window.__afStore.getState().status, err: window.__afStore.getState().error, dir: window.__afStore.getState().outputDir }))
  ok(st.status === 'done', `${label}: 합성 완료(status=done, error=${st.err || '없음'})`)
  ok(!(st.err && /TOO_LONG|10\.0s|부적합|만료/.test(st.err)), `${label}: TOO_LONG/만료 오류 없음`)
  ok(pageErrors.length === err0, `${label}: pageerror 0`)
  // 다음 합성을 위해 worker 프로세스가 완전히 종료(runner=null)될 때까지 대기 — result와 exit 사이 간극 해소.
  const t = Date.now()
  while (exits() <= exit0 && Date.now() - t < 15000) await win.waitForTimeout(300)
  return st
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
  ok(!!clip1 && fs.existsSync(clip1), `구간 확정 → 클립 준비(${clip1 ? path.basename(clip1) : 'none'})`)
  await win.evaluate(() => window.__afStore.setState({ ttsText: '첫 번째 합성입니다.' }))

  // 합성 1
  await synthOnce('1회차')
  const clipAfter1 = await win.evaluate(() => window.__afStore.getState().ttsReferenceClip)
  ok(clipAfter1 === clip1 && fs.existsSync(clipAfter1), '합성 후 파생 클립 유지(삭제 안 됨)')

  // 합성 2 — 재확정 없이 같은 클립으로. done 화면에서 '다른 모드로 재처리'(setIdle)로 입력 화면 복귀
  // (클립·ready 유지) → 대사 변경 → 다시 합성. 이 경로에서 예전엔 삭제된 클립 때문에 TOO_LONG이 났다.
  await win.getByText('다른 모드로 재처리', { exact: false }).click({ timeout: 8000 })
  await win.waitForFunction(() => window.__afStore?.getState().status === 'idle', undefined, { timeout: 8000 })
  const clipReidle = await win.evaluate(() => window.__afStore.getState().ttsReferenceClip)
  ok(clipReidle === clip1 && fs.existsSync(clipReidle), '재처리 복귀 후에도 파생 클립 유지')
  ok(await win.evaluate(() => window.__afStore.getState().ttsRefReady === true), '재처리 후 ttsRefReady 유지')
  await win.evaluate(() => window.__afStore.setState({ ttsText: '두 번째 합성입니다.' }))
  const canClick = await win.getByText('음성 합성 시작', { exact: false }).isVisible().catch(() => false)
  ok(canClick, '2회차: 합성 시작 버튼 재노출')
  await synthOnce('2회차')
  await win.screenshot({ path: path.join(SHOT, 'e2e_resynth.png') })
} catch (e) {
  failed++; console.log('[e2e] EXCEPTION', e?.message || String(e))
  try { await win.screenshot({ path: path.join(SHOT, 'e2e_resynth_FAIL.png') }) } catch {}
}
await app.close()
// 원본 resources/ 불변 단언 후 격리 폴더만 삭제
ok(snapshotTree(RES_DIR) === resBefore, 'resources/ 원본·기존 출력 불변(size/hash/목록)')
cleanupIsolated(ISO)
console.log('[e2e] SUMMARY', JSON.stringify({ failed, pageErrors: pageErrors.length }))
process.exit(failed === 0 ? 0 : 1)
