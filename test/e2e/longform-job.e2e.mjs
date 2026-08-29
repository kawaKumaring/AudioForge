// C1(장문 job 안정성) 전용 E2E — 실제 Electron main + 실제 PythonRunner + 실제 자식 프로세스.
// GPU·Qwen 모델·사용자 미디어 없음(합성 fixture 워커만). 격리 userData 사용.
//
// 왜 별도 E2E 인가:
//   - synthesize-complete 는 AF_E2E_REFERENCE(실 사용자 참조 음성) + 실 Qwen + GPU 를 요구한다 → 실행 금지.
//   - tts-result-metadata 는 resources/speaker_b.wav 또는 AF_E2E_REFERENCE 가 있어야 시작한다.
//   - tts-cancel-lifecycle 은 GPU-free 지만 window.__afStore(렌더러 번들)를 필요로 한다.
//   이 파일은 **렌더러 번들 없이** 돈다: main 의 ELECTRON_RENDERER_URL 시임으로 최소 페이지를 띄우고
//   preload 가 노출하는 window.api 로 직접 IPC 를 호출한다. 그래서 out/renderer 빌드에 의존하지 않는다.
//
// 검증 항목:
//   1) 정상 result 는 staging(.qwen-job-* 스윕) 확인 후 **정확히 한 번만** 공개된다
//   2) 취소 이후, main 이 붙들고 있던 result 는 폐기된다(공개 0)
//   3) 시간 초과(stall) 이후 도착/보류된 result 가 terminal 을 덮어쓰지 않는다(clobber 0)
//   4) 취소·시간 초과 후 timer / 자식 프로세스 / staging 잔존 0
//   5) 구조화 QWEN_NO_RESPONSE 가 일반 timeout 으로 뭉개지지 않고 code 가 보존된다
//   6) pageerror / crash 0
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { snapshotTree, qwenJobDirs } from './_e2e-helper.mjs'

const APP = process.cwd()
const FIXTURE = path.join(APP, 'test', 'e2e', 'fixtures', 'longform_job.py')
const RES_DIR = path.join(APP, 'resources')
let failed = 0
const log = (...a) => console.log('[longform]', ...a.map(x => typeof x === 'string' ? x : JSON.stringify(x)))
const ok = (c, m) => { log(c ? 'PASS' : 'FAIL', m); if (!c) failed++ }

if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요(out/main)'); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/preload/index.js'))) { console.error('빌드 필요(out/preload)'); process.exit(2) }
if (!fs.existsSync(FIXTURE)) { console.error('fixture 없음'); process.exit(2) }

const isAlive = (pid) => {
  if (pid == null) return false
  try { return execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf-8' }).includes(String(pid)) }
  catch { return false }
}

// 격리 작업공간 — 사용자 폴더·미디어 무접촉. 입력 wav 는 존재하지 않아도 된다(합성은 fixture 가 대체).
const ISO = fs.mkdtempSync(path.join(os.tmpdir(), 'af_longform_'))
const USERDATA = path.join(ISO, 'userdata')
const INPUT = path.join(ISO, 'in.wav')
const OUT_BASE = path.join(ISO, 'AudioForge_output')
const PIDFILE = path.join(ISO, 'pid.json')
// 렌더러 번들 대신 띄울 최소 페이지(main/index.ts 가 ELECTRON_RENDERER_URL 을 그대로 loadURL 한다).
const PAGE = path.join(ISO, 'harness.html')
fs.writeFileSync(PAGE, '<!doctype html><meta charset="utf-8"><title>af-e2e</title><div id="root">e2e</div>', 'utf-8')

const resBefore = snapshotTree(RES_DIR)
const pageErrors = [], crashes = []
const app = await electron.launch({
  args: ['out/main/index.js', `--user-data-dir=${USERDATA}`],
  cwd: APP,
  env: {
    ...process.env,
    AF_E2E: '1',
    AF_E2E_TTS_SCRIPT: FIXTURE,
    AF_E2E_PIDFILE: PIDFILE,
    ELECTRON_RENDERER_URL: 'file:///' + PAGE.replace(/\\/g, '/')
  }
})
const win = await app.firstWindow()
win.on('pageerror', e => pageErrors.push(e.message))
win.on('crash', () => crashes.push('crash'))

const readPid = () => { try { return JSON.parse(fs.readFileSync(PIDFILE, 'utf-8')).parent } catch { return null } }

// main 프로세스 시임 주입(AF_E2E=1 에서만 읽힌다). 분 단위 축을 초 단위로 재현하기 위한 것이며
// production 상수는 그대로다.
const setSeam = (s) => app.evaluate(({ }, v) => {
  globalThis.__afJobStallMs = v.stallMs
  globalThis.__afJobInactivityMs = v.inactivityMs
  globalThis.__afJobTickMs = v.tickMs
}, s)
const setFixtureMode = (m) => app.evaluate(({ }, v) => { process.env.AF_E2E_LONGFORM_MODE = v }, m)

// 렌더러 쪽 이벤트 수집기 — main 이 실제로 어떤 채널을 몇 번 보냈는지가 이 테스트의 관측 대상이다.
// 리스너는 **딱 한 번만** 건다. 시나리오마다 다시 걸면 같은 이벤트가 중복 집계되어 '정확히 1회'
// 단언이 거짓 실패한다(실제로 그렇게 한 번 잘못 만들었다). armEvents 는 카운터만 초기화한다.

const installListeners = () => win.evaluate(() => {
  window.__afEv = { result: [], error: [], cancelled: 0, cancelling: 0, cancelFailed: [], progress: 0 }
  window.api.audio.onResult((d) => window.__afEv.result.push(d))
  window.api.audio.onError((e) => window.__afEv.error.push(e))
  window.api.audio.onCancelled(() => { window.__afEv.cancelled++ })
  window.api.audio.onCancelling(() => { window.__afEv.cancelling++ })
  window.api.audio.onCancelFailed((d) => window.__afEv.cancelFailed.push(d))
  window.api.audio.onProgress(() => { window.__afEv.progress++ })
})
const armEvents = () => win.evaluate(() => {
  window.__afEv = { result: [], error: [], cancelled: 0, cancelling: 0, cancelFailed: [], progress: 0 }
})

const events = () => win.evaluate(() => JSON.parse(JSON.stringify(window.__afEv)))
/** 합성 시작 후 fixture 가 자기 pid 를 기록할 때까지 bounded 대기 → 그 pid 반환. */
const startSynth = async () => {
  fs.rmSync(PIDFILE, { force: true })   // 이전 시나리오의 죽은 pid 를 읽지 않도록
  await win.evaluate((p) =>
    window.api.audio.process(p, 'tts', { ttsText: '장문 안정성 확인', ttsPitch: 0 }), INPUT)
  await until(() => readPid() !== null, 15000, 25)
  return readPid()
}
/** 다음 시나리오가 '이미 처리 중'에 걸리지 않도록 backend 가 free 가 될 때까지 bounded 대기. */
const settleIdle = () => until(async () =>
  win.evaluate(() => window.api.audio.cancel().then(r => r.reasonCode === 'NO_ACTIVE_JOB')), 15000, 100)
const cancelSynth = () => win.evaluate(() => window.api.audio.cancel())
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
/** 조건이 참이 될 때까지 bounded 폴링(고정 sleep 추정 금지). */
const until = async (fn, ms = 15000, step = 50) => {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > ms) return false
    await sleep(step)
  }
}

try {
  await win.waitForLoadState('domcontentloaded')
  const hasApi = await win.evaluate(() => !!(window.api && window.api.audio))
  ok(hasApi, 'preload window.api 노출(렌더러 번들 없이 구동)')
  if (!hasApi) throw new Error('preload API 없음 — 이후 시나리오 진행 불가')
  await installListeners()

  // ── 1) 정상 경로: staging 확인 후 result 정확히 1회 ──────────────────────────
  await setSeam({}); await setFixtureMode('chunks-then-result'); await armEvents()
  await startSynth()
  ok(await until(async () => (await events()).result.length > 0, 20000), '정상 경로에서 result 수신')
  await sleep(600)  // 중복 공개가 뒤늦게 오는지 확인할 여유
  let ev = await events()
  ok(ev.result.length === 1, `result 공개 정확히 1회(관측 ${ev.result.length})`)
  ok(ev.error.length === 0, `정상 경로에 오류 0(관측 ${ev.error.length})`)
  ok(ev.progress > 0, '조각 진행 progress 수신')
  ok(qwenJobDirs(OUT_BASE).length === 0, 'staging 잔존(.qwen-job-*) 0')
  ok(!isAlive(readPid()), '정상 종료 후 fixture 자식 0')
  await settleIdle()

  // ── 2) 취소: terminal 1개 + 결과 공개 0 + 자식/staging 잔존 0 ──────────────
  // result 를 아직 내지 않은(=미정착) job 만 취소가 접수된다 — 이미 정착한 실행에 대한 늦은 취소는
  // ALREADY_SETTLED 로 거부되는 것이 기존 계약이고, 그 계약은 이번에 건드리지 않았다.
  await setSeam({ stallMs: 60000, inactivityMs: 60000, tickMs: 250 })
  await setFixtureMode('alive-no-progress'); await armEvents()
  const pid2 = await startSynth()
  ok(isAlive(pid2), '취소 전 fixture 자식 생존')
  await cancelSynth()
  ok(await until(async () => (await events()).cancelled > 0, 25000), '취소 terminal(audio:cancelled) 수신')
  await sleep(600)
  ev = await events()
  ok(ev.result.length === 0, `취소 후 result 공개 0(관측 ${ev.result.length})`)
  ok(ev.cancelled === 1, `cancelled terminal 정확히 1회(관측 ${ev.cancelled})`)
  ok(!isAlive(pid2), '취소 후 자식 프로세스 잔존 0')
  ok(qwenJobDirs(OUT_BASE).length === 0, '취소 후 staging 잔존 0')
  await settleIdle()

  // ── 3) 시간 초과 이후 '이미 붙들고 있던 result' 가 terminal 을 덮지 않는다 ──
  // 이번에 닫은 구멍 그 자체다: fixture 가 result 를 먼저 내고 종료하지 않는다. main 은 그것을
  // staging 게이트에 보류만 한 상태에서 stall 축이 터진다. 예전 코드라면 done 에서 pendingResult 를
  // 그대로 공개했다. 축을 초 단위로 줄여 재현한다(production 상수 불변 — AF_E2E 시임).
  await setSeam({ stallMs: 2500, inactivityMs: 60000, tickMs: 250 })
  await setFixtureMode('result-then-hang'); await armEvents()
  const pid3 = await startSynth()
  ok(await until(async () => (await events()).error.length > 0, 25000), 'stall 시간 초과 오류 수신')
  await sleep(800)
  ev = await events()
  ok(ev.error.length === 1, `시간 초과 terminal 정확히 1회(관측 ${ev.error.length})`)
  ok(/한 조각도 진행하지 못했습니다/.test(JSON.stringify(ev.error[0] ?? '')),
    'stall 은 일반 "5분간 응답 없음"이 아니라 무진행 사유로 보고된다')
  ok(ev.result.length === 0,
    `보류돼 있던 result 가 terminal 이후 공개되지 않는다 — clobber 0(관측 ${ev.result.length})`)
  ok(await until(() => !isAlive(pid3), 15000), '시간 초과 후 자식 프로세스 잔존 0')
  ok(qwenJobDirs(OUT_BASE).length === 0, '시간 초과 후 staging 잔존 0')
  // 타이머 잔존 0: 축이 이미 터졌으므로 그 뒤로 추가 terminal 이 나오면 타이머가 살아있다는 뜻이다.
  await sleep(1500)
  ev = await events()
  ok(ev.error.length === 1, '시간 초과 후 감시 타이머 재발화 0(타이머 잔존 없음)')
  ok(ev.result.length === 0, '지연 재스윕 이후에도 result 공개 0')
  await settleIdle()

  // ── 4) 구조화 오류 보존: QWEN_NO_RESPONSE 가 일반 timeout 으로 뭉개지지 않는다 ──
  // Python 이 스스로 먼저 보고할 수 있도록 stall 축을 넉넉히 둔다(Electron 이 끼어들면 안 된다).
  await setSeam({ stallMs: 60000, inactivityMs: 60000, tickMs: 250 })
  await setFixtureMode('structured-error'); await armEvents()
  await startSynth()
  ok(await until(async () => (await events()).error.length > 0, 20000), '구조화 오류 수신')
  await sleep(500)
  ev = await events()
  const errBlob = JSON.stringify(ev.error)
  ok(/QWEN_NO_RESPONSE/.test(errBlob), 'code=QWEN_NO_RESPONSE 가 보존된다(일반 timeout 으로 대체되지 않음)')
  ok(!/한 조각도 진행하지 못했습니다|5분간 응답 없음/.test(errBlob),
    'Python 이 먼저 보고했으므로 Electron 측 시간 초과 문구로 덮이지 않는다')
  ok(ev.result.length === 0, '오류 경로에 result 공개 0')
  ok(qwenJobDirs(OUT_BASE).length === 0, '오류 후 staging 잔존 0')

  ok(pageErrors.length === 0, `pageerror 0(관측 ${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0] : ''})`)
  ok(crashes.length === 0, `crash 0(관측 ${crashes.length})`)
} catch (e) {
  failed++
  log('EXCEPTION', e && e.message ? e.message : String(e))
} finally {
  try { await app.close() } catch { /* noop */ }
  const leftover = readPid()
  ok(!isAlive(leftover), '앱 종료 후 fixture 자식 잔존 0')
  ok(JSON.stringify(snapshotTree(RES_DIR)) === JSON.stringify(resBefore), 'resources/ 원본 불변')
  try { fs.rmSync(ISO, { recursive: true, force: true }) } catch { /* noop */ }
  log('SUMMARY', { failed, pageErrors: pageErrors.length, crashes: crashes.length })
  process.exit(failed ? 1 : 0)
}
