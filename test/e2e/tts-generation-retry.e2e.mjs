// 생성상한 오류 → 사용자 명시 재시도 E2E (공용 마감 J). GPU·Qwen·실합성·미디어 없음.
// audio:process를 '메인 프로세스에서' 테스트 전용으로 가로채(removeHandler+handle) 결정적으로
// audio:error(code=GENERATION_LIMIT_EXCEEDED) / audio:result를 보낸다 — production 코드는 손대지 않는다.
// 검증: 실제 IPC 오류 경로 → 전용 카드(제목·설명·버튼 3) → '다시 시도' 1클릭=1 process → 성공,
//       중복 트리거 dedup(2 bump→1 process), '닫기'/'참조 전사 확인'은 재합성 안 함, 일반 오류는 기존 카드.
import { _electron as electron } from 'playwright'
import fs from 'fs'; import path from 'path'
import { snapshotTree, refClipDirs, qwenVenvPids } from './_e2e-helper.mjs'

const APP = process.cwd()
const RES_DIR = path.join(APP, 'resources')
const SHOT = path.join(APP, '_local', 'artifacts', 'diagnostics', 'e2e-shots'); fs.mkdirSync(SHOT, { recursive: true })
let failed = 0
const logLines = []
const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); logLines.push(s); console.log('[gen-retry]', s) }
const ok = (c, m) => { log(c ? 'PASS' : 'FAIL', m); if (!c) failed++ }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const resBefore = snapshotTree(RES_DIR)
const pageErrors = [], crashes = []
const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
const win = await app.firstWindow()
win.on('pageerror', e => pageErrors.push(e.message))
win.on('crash', () => crashes.push('crash'))

// 메인 프로세스에 테스트 전용 audio:process 핸들러 설치(production 무영향). mode로 error/result 분기.
const installMock = () => app.evaluate(({ ipcMain }) => {
  globalThis.__afCalls = 0
  globalThis.__afMode = 'error' // 'error' | 'result'
  try { ipcMain.removeHandler('audio:process') } catch { /* noop */ }
  ipcMain.handle('audio:process', async (event) => {
    const n = ++globalThis.__afCalls
    const wc = event.sender
    const mode = globalThis.__afMode
    setTimeout(() => {
      if (mode === 'error') {
        wc.send('audio:error', {
          message: "GENERATION_LIMIT_EXCEEDED — 감정 'default' 문장이 동적 생성 상한(max_new_tokens=256)에 도달했습니다(생성 반복 256).",
          code: 'GENERATION_LIMIT_EXCEEDED'
        })
      } else {
        wc.send('audio:result', {
          tracks: [{ name: 'synthesized', label: '합성 음성', path: 'X:/out/synthesized.wav' }],
          outputDir: 'X:/out', metadata: { requested_engine: 'auto', actual_engine: 'qwen3', device: 'cpu' }
        })
      }
    }, 40)
    return { outputDir: 'X:/out' }
  })
  return true
})
// app.evaluate(fn, arg)는 첫 인자로 Electron 모듈을 주입한다 — 사용자 인자는 '두 번째' 파라미터.
const setMode = (m) => app.evaluate((_electron, mm) => { globalThis.__afMode = mm; return globalThis.__afMode }, m)
const resetCalls = () => app.evaluate(() => { globalThis.__afCalls = 0; return 0 })
const getCalls = () => app.evaluate(() => globalThis.__afCalls)

// tts 모드 + 재합성 가능한 최소 store 상태 주입(차단 사유 없음: 대사 있음·참조 준비·pitch 0).
// 가짜 경로 → 참조 패널이 자동 분석에 실패해 ttsRefReady를 false로 만든다. 정착을 기다린 뒤 테스트용으로
// ttsRefReady=true를 덮어쓴다(path/clipKey 불변이라 패널이 재분석하며 되돌리지 않는다).
const armStore = async () => {
  await win.evaluate(() => {
    window.__afStore.setState({
      fileInfo: { path: 'X:/in.wav', name: 'in.wav', duration: 5, channels: 1, sampleRate: 24000, format: 'wav' },
      fileUrl: null, mode: 'tts', status: 'idle', error: null, errorInfo: null, tracks: [],
      ttsText: '안녕하세요, 재시도 테스트 문장입니다.', ttsPitch: 0, ttsPitchCapability: null,
      ttsEmotionRefState: {}, ttsReferencePrompts: {}, ttsReferenceClip: ''
    })
  })
  await win.waitForTimeout(800)  // 참조 자동 분석(가짜 경로→실패) 정착 대기
  await win.evaluate(() => { window.__afStore.setState({ ttsRefReady: true, ttsRefMessage: '', status: 'idle', error: null, errorInfo: null }) })
  await win.waitForFunction(() => window.__afStore.getState().ttsRefReady === true, undefined, { timeout: 5000 })
}
const st = () => win.evaluate(() => { const g = window.__afStore.getState(); return { status: g.status, error: g.error, code: g.errorInfo?.code || null, retryNonce: g.retryNonce, tracks: g.tracks.length } })
const rootText = () => win.evaluate(() => document.getElementById('root')?.innerText || '')

try {
  await win.waitForLoadState('domcontentloaded')
  await installMock()
  await win.waitForFunction(() => !!window.__afStore, undefined, { timeout: 30000 })

  // ── Phase 0: 실제 IPC 오류 경로 → 전용 카드 ──
  await setMode('error'); await resetCalls(); await armStore()
  // 합성 시작 버튼 클릭(실제 handleProcess → mock audio:process → audio:error(code)).
  await win.getByRole('button', { name: '음성 합성 시작' }).first().click({ timeout: 8000 })
  await win.waitForFunction(() => window.__afStore.getState().status === 'error', undefined, { timeout: 15000 })
  let s = await st()
  ok(s.code === 'GENERATION_LIMIT_EXCEEDED', `실 IPC 오류 code 전달(store.errorInfo.code=${s.code})`)
  ok((await getCalls()) === 1, '초기 합성 process 1회')
  let txt = await rootText()
  ok(/생성이 비정상적으로 길어 안전하게 중단됐습니다\./.test(txt), '전용 오류 카드 제목')
  ok(/참조 음성과 전사문이 일치하는지 확인하거나 다시 시도하세요\./.test(txt), '전용 오류 카드 설명')
  ok(/다시 시도/.test(txt) && /참조 전사 확인/.test(txt) && /닫기/.test(txt), '버튼 3종(다시 시도·참조 전사 확인·닫기)')
  ok(!/synthesized\.wav|X:\/out|Traceback|max_new_tokens/.test(txt), '카드에 경로·원시 메시지 미노출')

  // ── Phase 1: '다시 시도' 1클릭 = 1 process → 성공 ──
  await setMode('result')
  await win.getByRole('button', { name: '다시 시도' }).first().click({ timeout: 8000 })
  await win.waitForFunction(() => window.__afStore.getState().status === 'done', undefined, { timeout: 15000 })
  s = await st()
  ok(s.status === 'done' && s.error === null && s.code === null, '재시도 성공 → done·오류 해제')
  ok((await getCalls()) === 2, '재시도로 process 정확히 1회 추가(총 2)')

  // ── Phase 2: dedup — 오류 상태에서 2회 연속 bump → process 1회만 ──
  await setMode('result'); await resetCalls()
  await win.evaluate(() => { window.__afStore.getState().setError('GENERATION_LIMIT_EXCEEDED — 상한 도달', { code: 'GENERATION_LIMIT_EXCEEDED' }) })
  await win.waitForFunction(() => window.__afStore.getState().status === 'error', undefined, { timeout: 8000 })
  await win.evaluate(() => { const g = window.__afStore.getState(); g.bumpRetry(); g.bumpRetry() })
  await win.waitForFunction(() => window.__afStore.getState().status === 'done', undefined, { timeout: 15000 })
  ok((await getCalls()) === 1, 'dedup: 연속 2 bump에도 process 1회')

  // ── Phase 3: '닫기' → 재합성 없이 오류만 해제 ──
  await setMode('result'); await resetCalls()
  await win.evaluate(() => { window.__afStore.getState().setError('GENERATION_LIMIT_EXCEEDED — 상한 도달', { code: 'GENERATION_LIMIT_EXCEEDED' }) })
  await win.waitForFunction(() => window.__afStore.getState().status === 'error', undefined, { timeout: 8000 })
  await win.getByRole('button', { name: '닫기' }).first().click({ timeout: 8000 })
  await win.waitForFunction(() => window.__afStore.getState().status === 'idle', undefined, { timeout: 8000 })
  s = await st()
  ok(s.status === 'idle' && s.error === null, "'닫기' → idle·오류 해제")
  await win.waitForTimeout(120)
  ok((await getCalls()) === 0, "'닫기'는 재합성 안 함(process 0)")

  // ── Phase 4: '참조 전사 확인' → 오류 해제 + 전사 섹션 존재(스크롤 대상) ──
  await setMode('result'); await resetCalls()
  await win.evaluate(() => { window.__afStore.getState().setError('GENERATION_LIMIT_EXCEEDED — 상한 도달', { code: 'GENERATION_LIMIT_EXCEEDED' }) })
  await win.waitForFunction(() => window.__afStore.getState().status === 'error', undefined, { timeout: 8000 })
  ok(await win.evaluate(() => !!document.getElementById('tts-reference-transcript')), '참조 전사 스크롤 대상 존재')
  await win.getByRole('button', { name: '참조 전사 확인' }).first().click({ timeout: 8000 })
  await win.waitForFunction(() => window.__afStore.getState().status === 'idle', undefined, { timeout: 8000 })
  await win.waitForTimeout(120)
  ok((await getCalls()) === 0, "'참조 전사 확인'은 재합성 안 함(process 0)")

  // ── Phase 5: 일반 오류(code 없음) → 기존 카드(전용 제목 없음) ──
  await win.evaluate(() => { window.__afStore.getState().setError('음성 합성 실패: 알 수 없는 오류', null) })
  await win.waitForFunction(() => window.__afStore.getState().status === 'error', undefined, { timeout: 8000 })
  txt = await rootText()
  ok(/음성 합성 실패: 알 수 없는 오류/.test(txt), '일반 오류: 메시지 그대로 표시')
  ok(!/생성이 비정상적으로 길어/.test(txt), '일반 오류: 전용 제목 없음')
  ok(!/참조 전사 확인/.test(txt), '일반 오류: 참조 전사 확인 버튼 없음')

  ok(pageErrors.length === 0 && crashes.length === 0, `pageerror/crash 0(pe=${pageErrors.length},cr=${crashes.length})`)
} catch (e) {
  failed++; log('EXCEPTION', e?.message || String(e))
} finally {
  try { await app.close() } catch { /* ignore */ }
  ok(qwenVenvPids().length === 0, '종료 후 Qwen venv 자식 0')
  ok(refClipDirs().length === 0, '종료 후 refclip 임시폴더 0')
  ok(snapshotTree(RES_DIR) === resBefore, 'resources/ 원본 불변')
  fs.writeFileSync(path.join(SHOT, 'tts-generation-retry_log.txt'), logLines.join('\n'), 'utf-8')
}
log('SUMMARY', JSON.stringify({ failed, pageErrors: pageErrors.length, crashes: crashes.length }))
process.exit(failed === 0 ? 0 : 1)
