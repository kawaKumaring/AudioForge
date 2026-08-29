// 취소 lifecycle E2E (공용 마감 K) — GPU·Qwen·Whisper·사용자 미디어 없음.
// synthetic 프로세스 트리(fixtures/synthetic_tree.py)를 AF_E2E_TTS_SCRIPT로 띄워 실제 취소 경로
// (PythonRunner.cancel/taskkill /T → child close 확인 → settlement → done → cancelled → idle)를 검증한다.
// 상대 순서(cancel_clicked ≤ cancelling ≤ child_exit ≤ idle)와 race 승자·kill 실패·tree 종료·중복 신호 0을 단언.
import { _electron as electron } from 'playwright'
import { execSync } from 'child_process'
import fs from 'fs'; import path from 'path'; import os from 'os'
import { snapshotTree, refClipDirs, qwenVenvPids, qwenJobDirs } from './_e2e-helper.mjs'

const APP = process.cwd()
const FIXTURE = path.join(APP, 'test', 'e2e', 'fixtures', 'synthetic_tree.py')
const RES_DIR = path.join(APP, 'resources')
const SHOT = path.join(APP, '_local', 'artifacts', 'diagnostics', 'e2e-shots'); fs.mkdirSync(SHOT, { recursive: true })
let failed = 0
const logLines = []
const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); logLines.push(s); console.log('[cancel]', s) }
const ok = (c, m) => { log(c ? 'PASS' : 'FAIL', m); if (!c) failed++ }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
if (!fs.existsSync(FIXTURE)) { console.error('fixture 없음'); process.exit(2) }

// Windows PID 생존 확인(테스트 프로세스 내부 전용 — 사용자 경로·미디어 없음).
const isAlive = (pid) => {
  if (pid == null) return false
  try { return execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf-8' }).includes(String(pid)) }
  catch { return false }
}
const killTree = (pid) => { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* noop */ } }

const resBefore = snapshotTree(RES_DIR)
const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af_cancel_'))
const inputPath = path.join(isoDir, 'in.wav')  // 존재하지 않아도 됨(합성은 fixture로 대체)
const pidFile = path.join(isoDir, 'pids.json')
const OUT_BASE = path.join(isoDir, 'AudioForge_output')  // main이 dirname(input)/AudioForge_output에 output 생성

const launchEnv = {
  ...process.env, AF_E2E: '1',
  AF_E2E_TTS_SCRIPT: FIXTURE, AF_E2E_PIDFILE: pidFile, AF_E2E_FIXTURE_MODE: 'hang'
}
const pageErrors = [], crashes = []
const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: launchEnv })
const win = await app.firstWindow()
win.on('pageerror', e => pageErrors.push(e.message))
win.on('crash', () => crashes.push('crash'))

// ── 메인 프로세스 제어 헬퍼(테스트 시임 — production 무영향) ──
const installSendCounter = () => app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  globalThis.__afSent = {}
  if (!globalThis.__afSendPatched) {
    const orig = w.webContents.send.bind(w.webContents)
    w.webContents.send = (channel, ...args) => {
      globalThis.__afSent[channel] = (globalThis.__afSent[channel] || 0) + 1
      return orig(channel, ...args)
    }
    globalThis.__afSendPatched = true
  }
})
const resetSent = () => app.evaluate(() => { globalThis.__afSent = {} })
const getSent = () => app.evaluate(() => globalThis.__afSent || {})
const setFixtureMode = (m) => app.evaluate((_e, mm) => { process.env.AF_E2E_FIXTURE_MODE = mm }, m)
const setSeam = (s) => app.evaluate((_e, ss) => {
  globalThis.__afSimulateKillFail = !!ss.killFail
  if (ss.exitMs) globalThis.__afCancelExitMs = ss.exitMs; else delete globalThis.__afCancelExitMs
}, s)
const injectResult = () => app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0].webContents.send('audio:result', { tracks: [{ name: 'stray', label: '늦은 결과', path: 'X/o.wav' }], outputDir: 'X', metadata: {} })
})
// 취소 phase telemetry(AF_E2E 전용, main 프로세스 globalThis에 최초 관측 ms 기록).
const resetPhases = () => app.evaluate(() => { globalThis.__afCancelPhases = {} })
const getPhases = () => app.evaluate(() => globalThis.__afCancelPhases || {})
const setCleanupFail = (n) => app.evaluate((_e, nn) => { globalThis.__afCleanupFailCount = nn }, n)
// 상대 순서 단언: 배열 [ [name, t], ... ]에서 인접쌍이 a<=b (역전 금지, 동일 ms 허용).
const assertOrder = (pairs) => {
  for (let i = 1; i < pairs.length; i++) {
    const [pa, ta] = pairs[i - 1], [pb, tb] = pairs[i]
    ok(typeof ta === 'number' && typeof tb === 'number' && ta <= tb, `순서 ${pa}(${ta}) ≤ ${pb}(${tb})`)
  }
}

// ── 렌더러/store 헬퍼 ──
const armStore = async () => {
  await win.evaluate((p) => {
    window.__afStore.setState({
      fileInfo: { path: p, name: 'in.wav', duration: 5, channels: 1, sampleRate: 24000, format: 'wav' },
      fileUrl: null, mode: 'tts', status: 'idle', error: null, errorInfo: null, tracks: [],
      ttsText: '취소 테스트 문장입니다.', ttsPitch: 0, ttsPitchCapability: null,
      ttsEmotionRefState: {}, ttsReferencePrompts: {}, ttsReferenceClip: ''
    })
  }, inputPath)
  await win.waitForTimeout(700)  // 참조 자동 분석(가짜 경로→실패) 정착 대기
  await win.evaluate(() => window.__afStore.setState({ ttsRefReady: true, ttsRefMessage: '', status: 'idle', error: null, errorInfo: null }))
  await win.waitForFunction(() => window.__afStore.getState().ttsRefReady === true, undefined, { timeout: 5000 })
}
const status = () => win.evaluate(() => window.__afStore.getState().status)
const waitStatus = (s, t = 15000) => win.waitForFunction((ss) => window.__afStore.getState().status === ss, s, { timeout: t })
const rootText = () => win.evaluate(() => document.getElementById('root')?.innerText || '')
const readPids = () => { try { return JSON.parse(fs.readFileSync(pidFile, 'utf-8')) } catch { return null } }
const clickSynth = () => win.getByRole('button', { name: '음성 합성 시작' }).first().click({ timeout: 8000 })
const startSynth = async () => {
  fs.rmSync(pidFile, { force: true })
  await clickSynth()
  await waitStatus('processing', 12000)
  await win.waitForFunction((pf) => true, pidFile)  // no-op await tick
  // pidfile 기록 대기
  for (let i = 0; i < 40 && !readPids(); i++) await win.waitForTimeout(50)
  return readPids()
}

try {
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.__afStore, undefined, { timeout: 30000 })
  await installSendCounter()
  await armStore()

  // ── 시나리오 1: 정상 취소 — phase 상대 순서 + tree-dead-before-idle + 중복 0 ──
  await setFixtureMode('hang'); await setSeam({}); await setCleanupFail(0); await resetSent(); await resetPhases()
  let pids = await startSynth()
  ok(pids && pids.parent, 'synthetic 트리 spawn(pidfile 기록)')
  ok(isAlive(pids.parent) && isAlive(pids.child), '취소 전 parent+grandchild 생존')
  const t_click = Date.now()
  await win.getByRole('button', { name: '처리 취소' }).first().click({ timeout: 8000 })
  // 단일 poll 루프로 cancelling·tree-dead·idle 시점을 각각 최초 관측 시각으로 수집(고정 sleep 추정 아님).
  let t_cancelling = 0, t_treeDead = 0, t_idle = 0
  for (let i = 0; i < 500 && !t_idle; i++) {
    const s = await status()
    if (!t_cancelling && s === 'cancelling') t_cancelling = Date.now()
    if (!t_treeDead && !isAlive(pids.parent) && !isAlive(pids.child)) t_treeDead = Date.now()
    if (s === 'idle') { t_idle = Date.now(); break }
    await win.waitForTimeout(20)
  }
  ok(t_cancelling > 0, 'cancelling 표시 관측')
  ok(t_treeDead > 0, '취소 후 parent+grandchild 모두 종료(tree kill 관측)')
  ok(t_idle > 0, 'idle 전환 관측')
  ok(t_treeDead <= t_idle, `tree 종료(${t_treeDead}) ≤ idle(${t_idle}) — child 생존 중 idle 금지`)
  // phase telemetry로 인과 순서 단언(동일 ms 허용, 역전 금지). parent close·taskkill close·done은 사실상 동시
  // 사건이라 그들끼리의 선형 순서 대신 '인과적으로 보장되는 간선'만 단언한다(정직한 DAG).
  const ph = await getPhases()
  // (1) 메인 인과 사슬: 클릭 → cancelling 전송 → kill 요청 → runner done → cleanup → cancelled → idle
  assertOrder([
    ['cancel_clicked', t_click], ['cancelling_sent', ph.cancelling_sent], ['kill_requested', ph.kill_requested],
    ['runner_done', ph.runner_done], ['cleanup_done', ph.cleanup_done], ['cancelled_sent', ph.cancelled_sent], ['idle_rendered', t_idle]
  ])
  // (2) tree kill 확인은 kill 이후·cleanup 이전(트리 종료를 확인한 뒤에만 정리·완료)
  assertOrder([['kill_requested', ph.kill_requested], ['tree_kill_confirmed', ph.tree_kill_confirmed], ['cleanup_done', ph.cleanup_done]])
  // (3) 렌더러 표시 사슬: 클릭 → cancelling 렌더 → idle 렌더(취소 정리 표시가 idle 이전)
  assertOrder([['cancel_clicked', t_click], ['cancelling_rendered', t_cancelling], ['idle_rendered', t_idle]])
  const sent1 = await getSent()
  ok((sent1['audio:cancelled'] || 0) === 1, `audio:cancelled 정확히 1회(=${sent1['audio:cancelled'] || 0})`)
  ok((sent1['audio:error'] || 0) === 0 && (sent1['audio:result'] || 0) === 0, '취소 시 error/result 전송 0(중복·spurious 없음)')
  ok((await status()) === 'idle', '정상 취소 → idle')

  // ── 시나리오 2: 취소 더블클릭 → kill 요청/ cancelling 1회 ──
  await setFixtureMode('hang'); await setSeam({}); await resetSent()
  pids = await startSynth()
  const cancelBtn = win.getByRole('button', { name: '처리 취소' }).first()
  await cancelBtn.click({ timeout: 8000 }).catch(() => {})
  await cancelBtn.click({ timeout: 500 }).catch(() => {})  // 두 번째는 cancelling 전환으로 사라져 무시됨
  await waitStatus('idle', 12000)
  const sent2 = await getSent()
  ok((sent2['audio:cancelling'] || 0) === 1, `더블클릭에도 audio:cancelling 1회(=${sent2['audio:cancelling'] || 0})`)
  ok((sent2['audio:cancelled'] || 0) === 1, '더블클릭에도 audio:cancelled 1회')
  ok(!isAlive(pids.parent), '더블클릭 취소 후 트리 종료')

  // ── 시나리오 3: progress 직후 취소 ──
  await setFixtureMode('hang'); await setSeam({}); await resetSent()
  pids = await startSynth()
  await win.waitForFunction(() => (window.__afStore.getState().progress || 0) > 0, undefined, { timeout: 8000 }).catch(() => {})
  await win.getByRole('button', { name: '처리 취소' }).first().click({ timeout: 8000 })
  await waitStatus('idle', 12000)
  ok(!isAlive(pids.parent), 'progress 직후 취소 → 트리 종료·idle')

  // ── 시나리오 4: cancel 승리 → 늦은 result 미채택 ──
  await setFixtureMode('hang'); await setSeam({}); await resetSent()
  pids = await startSynth()
  await win.getByRole('button', { name: '처리 취소' }).first().click({ timeout: 8000 })
  await waitStatus('cancelling', 8000)
  await injectResult()  // 취소 승리 후 늦게 도착한 result → 채택 금지
  await waitStatus('idle', 12000)
  await win.waitForTimeout(150)
  ok((await status()) === 'idle', '취소 승리 시 늦은 result 미채택(→ idle 유지, done 아님)')

  // ── 시나리오 5: result 먼저 정착 → 늦은 cancel no-op ──
  await setFixtureMode('result'); await setSeam({}); await resetSent()
  await clickSynth()
  await waitStatus('done', 12000)
  await win.evaluate(() => window.api.audio.cancel())  // 늦은 취소
  await win.waitForTimeout(300)
  const sent5 = await getSent()
  ok((await status()) === 'done', 'result 먼저 → 늦은 cancel no-op(done 유지)')
  ok((sent5['audio:cancelled'] || 0) === 0 && (sent5['audio:cancelling'] || 0) === 0, '늦은 cancel은 cancelling/cancelled 미전송')

  // ── 시나리오 6: error 먼저 정착 → 늦은 cancel no-op ──
  await win.evaluate(() => window.__afStore.getState().reset())
  await armStore()
  await setFixtureMode('error'); await setSeam({}); await resetSent()
  await clickSynth()
  await waitStatus('error', 12000)
  await win.evaluate(() => window.api.audio.cancel())
  await win.waitForTimeout(300)
  ok((await status()) === 'error', 'error 먼저 → 늦은 cancel no-op(error 유지)')

  // ── 시나리오 7+8: kill 실패/exit timeout → cancel-failed → 다시 취소 성공 ──
  await win.evaluate(() => window.__afStore.getState().clearError())
  await win.evaluate(() => window.__afStore.getState().reset())
  await armStore()
  await setFixtureMode('hang'); await setSeam({ killFail: true, exitMs: 1200 }); await resetSent()
  pids = await startSynth()
  await win.getByRole('button', { name: '처리 취소' }).first().click({ timeout: 8000 })
  // kill 시임으로 exitMs(1200ms) 동안 cancelling이 유지된다 — 이 창에서 취소 정리 메시지·aria-busy 확인.
  await waitStatus('cancelling', 4000)
  ok(/작업을 취소하고 정리하는 중/.test(await rootText()), 'cancelling 메시지 렌더(취소 정리 중)')
  await win.waitForFunction(() => window.__afStore.getState().errorInfo?.code === 'CANCEL_FAILED', undefined, { timeout: 8000 })
  ok(isAlive(pids.parent), 'kill 실패 시 child 여전히 생존')
  const s7 = await win.evaluate(() => { const g = window.__afStore.getState(); return { status: g.status, code: g.errorInfo?.code, childAlive: g.errorInfo?.childAlive } })
  ok(s7.status === 'error' && s7.code === 'CANCEL_FAILED' && s7.childAlive === true, 'cancel-failed(조용한 idle 아님·childAlive 표면화)')
  ok(/취소하지 못했습니다/.test(await rootText()), 'cancel-failed 안내 메시지(role=alert)')
  // 새 합성 차단 확인: 합성 버튼 없음(이전 작업 종료 대기 표시)
  ok((await win.getByRole('button', { name: '음성 합성 시작' }).count()) === 0, 'cancel-failed·childAlive 중 합성 버튼 차단')
  // 다시 취소(kill 시임 해제) → 성공 → idle
  await setSeam({ exitMs: 8000 })  // killFail 해제
  await win.getByRole('button', { name: '다시 취소' }).first().click({ timeout: 8000 })
  await waitStatus('idle', 12000)
  ok(!isAlive(pids.parent) && !isAlive(pids.child), '다시 취소 → 트리 종료·idle')

  // ── 시나리오 9: 취소 중 generation retry 차단 (결정적 불변식) ──
  // transient 'cancelling'이 특정 시간 유지되는지가 아니라, 재시도가 '실제로 차단됐는지'를 권위로 단언한다:
  //  retryNonce 불변(store 가드 no-op) · 재합성 spawn 0(취소 대상 PID 교체 없음) · status가 processing으로 복귀 없음.
  // cancelling 창은 cleanup 재시도 시임으로 결정적 확보(6회≈720ms<deadline → 이후 정상 완료). timeout 늘리기 아님.
  await setFixtureMode('hang'); await setSeam({}); await setCleanupFail(6); await resetSent()
  pids = await startSynth()
  const pidBefore9 = readPids()
  await win.getByRole('button', { name: '처리 취소' }).first().click({ timeout: 8000 })
  await waitStatus('cancelling', 8000)
  // A. 취소가 실제 시작됨
  const ph9 = await getPhases()
  ok(!!ph9.cancelling_sent || !!ph9.kill_requested, 'A: 취소 실제 시작(cancelling_sent/kill_requested 관측)')
  // B. cancelling 상태에서 bumpRetry를 원자적으로 호출하고 before/after를 같은 tick에 관측(가드 no-op 증명)
  const g9 = await win.evaluate(() => {
    const s = window.__afStore
    const before = { status: s.getState().status, nonce: s.getState().retryNonce }
    s.getState().bumpRetry()  // 취소 중 재시도 시도 — 가드로 no-op이어야 함
    return { before, after: { status: s.getState().status, nonce: s.getState().retryNonce } }
  })
  ok(g9.before.status === 'cancelling', `B(전제): bumpRetry 시점 status=cancelling(${g9.before.status})`)
  ok(g9.after.nonce === g9.before.nonce, `B: bumpRetry가 retryNonce 증가 안 함(가드 no-op, ${g9.before.nonce}→${g9.after.nonce})`)
  ok(g9.after.status !== 'processing', `B: status가 processing으로 복귀 안 함(${g9.after.status})`)
  const pidAfter9 = readPids()
  ok(!!pidBefore9 && !!pidAfter9 && pidAfter9.parent === pidBefore9.parent,
    `B: 취소 대상 PID 교체 없음(재합성 spawn 0, ${pidBefore9 && pidBefore9.parent}→${pidAfter9 && pidAfter9.parent})`)
  ok((await getSent())['audio:cancelling'] === 1, 'B: cancelling 신호 1회(재시도로 새 취소/합성 사이클 없음)')
  // C. 정상 완료
  await setCleanupFail(0)
  await waitStatus('idle', 12000)
  ok((await status()) === 'idle', 'C: 최종 idle')
  let dead9 = false
  for (let i = 0; i < 60; i++) { if (!isAlive(pids.parent) && !isAlive(pids.child)) { dead9 = true; break } await win.waitForTimeout(50) }
  ok(dead9, 'C: 원래 child tree dead')
  ok(qwenJobDirs(OUT_BASE).length === 0, 'C: .qwen-job-* 0')
  ok((await win.evaluate(() => window.__afStore.getState().tracks.length)) === 0, 'C: 결과 track 생성 없음')
  ok(((await getSent())['audio:cancel-failed'] || 0) === 0, 'C: CANCEL_FAILED 없음')

  // ── 시나리오 10: 취소 완료 후 새 합성 1회 정상 ──
  await setFixtureMode('result'); await setSeam({}); await resetSent()
  await clickSynth()
  await waitStatus('done', 12000)
  ok((await status()) === 'done', '취소 완료 후 새 합성 1회 정상(done)')
  const sent10 = await getSent()
  ok((sent10['audio:result'] || 0) === 1, '새 합성 결과 1회(중복 0)')

  // ── 시나리오 11: 지연 cleanup — 첫 sweep 실패·재시도 성공 → 정상 idle ──
  await win.evaluate(() => window.__afStore.getState().reset()); await armStore()
  await setFixtureMode('hang'); await setSeam({}); await setCleanupFail(1); await resetSent()
  pids = await startSynth()
  await win.getByRole('button', { name: '처리 취소' }).first().click({ timeout: 8000 })
  await waitStatus('idle', 12000)
  ok(!isAlive(pids.parent), '지연 cleanup(1회 실패): 트리 종료')
  const s11 = await getSent()
  ok((s11['audio:cancelled'] || 0) === 1, '지연 cleanup 성공 후 cancelled 1회 → idle')
  await setCleanupFail(0)

  // ── 시나리오 12: cleanup 전부 실패 → cancel-failed(cleanupPending)·새 합성 차단 ──
  await win.evaluate(() => window.__afStore.getState().reset()); await armStore()
  await setFixtureMode('hang'); await setSeam({}); await setCleanupFail(50); await resetSent()
  pids = await startSynth()
  await win.getByRole('button', { name: '처리 취소' }).first().click({ timeout: 8000 })
  await win.waitForFunction(() => window.__afStore.getState().errorInfo?.code === 'CANCEL_FAILED', undefined, { timeout: 10000 })
  ok(!isAlive(pids.parent), 'cleanup 실패라도 트리는 종료(tree kill 확인됨)')
  ok((await status()) === 'error', 'cleanup 전부 실패 → cancel-failed(조용한 idle 아님)')
  const blocked = await win.evaluate(async () => { try { await window.api.audio.process('X:/in.wav', 'tts', { ttsText: 'x' }); return 'ok' } catch { return 'blocked' } })
  ok(blocked === 'blocked', 'cleanupPending 중 새 합성 차단(main 거부)')
  await setCleanupFail(0)

  ok(pageErrors.length === 0 && crashes.length === 0, `pageerror/crash 0(pe=${pageErrors.length},cr=${crashes.length})`)
} catch (e) {
  failed++; log('EXCEPTION', e?.message || String(e))
} finally {
  try { const p = readPids(); if (p?.parent) killTree(p.parent) } catch { /* noop */ }
  try { await app.close() } catch { /* ignore */ }
  ok(qwenVenvPids().length === 0, '종료 후 Qwen venv 자식 0')
  ok(refClipDirs().length === 0, '종료 후 refclip 임시폴더 0')
  ok(snapshotTree(RES_DIR) === resBefore, 'resources/ 원본 불변')
  try { fs.rmSync(isoDir, { recursive: true, force: true }) } catch { /* noop */ }
  fs.writeFileSync(path.join(SHOT, 'tts-cancel-lifecycle_log.txt'), logLines.join('\n'), 'utf-8')
}

// ── 시나리오 11: 앱 종료 중 실행 작업 tree cleanup(별도 인스턴스) ──
try {
  const iso2 = fs.mkdtempSync(path.join(os.tmpdir(), 'af_cancel2_'))
  const pf2 = path.join(iso2, 'pids.json')
  const app2 = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_TTS_SCRIPT: FIXTURE, AF_E2E_PIDFILE: pf2, AF_E2E_FIXTURE_MODE: 'hang' } })
  const win2 = await app2.firstWindow()
  await win2.waitForLoadState('domcontentloaded')
  await win2.waitForFunction(() => !!window.__afStore, undefined, { timeout: 30000 })
  await win2.evaluate((p) => window.__afStore.setState({ fileInfo: { path: p, name: 'in.wav', duration: 5, channels: 1, sampleRate: 24000, format: 'wav' }, mode: 'tts', status: 'idle', ttsText: '종료 테스트', ttsPitch: 0, ttsEmotionRefState: {} }), path.join(iso2, 'in.wav'))
  await win2.waitForTimeout(700)
  await win2.evaluate(() => window.__afStore.setState({ ttsRefReady: true, ttsRefMessage: '', status: 'idle' }))
  await win2.getByRole('button', { name: '음성 합성 시작' }).first().click({ timeout: 8000 })
  await win2.waitForFunction(() => window.__afStore.getState().status === 'processing', undefined, { timeout: 12000 })
  let p2 = null; for (let i = 0; i < 40 && !p2; i++) { try { p2 = JSON.parse(fs.readFileSync(pf2, 'utf-8')) } catch { await win2.waitForTimeout(50) } }
  ok(p2 && isAlive(p2.parent) && isAlive(p2.child), '(앱종료) 실행 중 트리 생존')
  await app2.close()  // will-quit → 트리 kill
  let dead2 = false
  for (let i = 0; i < 60; i++) { if (!isAlive(p2.parent) && !isAlive(p2.child)) { dead2 = true; break } await new Promise(r => setTimeout(r, 50)) }
  ok(dead2, '앱 종료 시 실행 작업 트리 cleanup(parent+grandchild 종료)')
  if (!dead2 && p2?.parent) killTree(p2.parent)
  try { fs.rmSync(iso2, { recursive: true, force: true }) } catch { /* noop */ }
} catch (e) {
  failed++; log('EXCEPTION(app-quit)', e?.message || String(e))
}

log('SUMMARY', JSON.stringify({ failed, pageErrors: pageErrors.length, crashes: crashes.length }))
process.exit(failed === 0 ? 0 : 1)
