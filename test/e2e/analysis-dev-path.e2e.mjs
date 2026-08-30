// 개발 실행 경로 E2E — 사용자가 실제로 쓰는 경로 그대로.
//
//   AudioForge 개발버전 실행.lnk -> run.bat -> af-launch.mjs -> npm run dev
//
// 실행: npm run test:e2e:analysis-dev
//
// 왜 이 파일이 따로 있는가
// ------------------------
// `대사 분석 준비 중…` 이 풀리지 않던 결함은 **개발 경로에서만** 났다. React 개발 빌드의
// StrictMode 가 effect 를 setup -> cleanup -> setup 으로 두 번 부르는데, 첫 cleanup 이
// 내려둔 `alive` 를 되살리지 않아 그 훅 인스턴스가 영원히 죽어 있었다. `out/` production
// 번들을 띄우는 기존 E2E 는 이중 호출이 없어 매번 초록이었다 — 회귀를 막지 못한다.
//
// 그래서 여기서는 빌드 산출물이 아니라 **개발 서버를 실제로 띄우고** 그 Electron 에 붙는다.
// StrictMode 이중 호출이 관측되지 않으면 그 자체를 실패로 본다(조건을 재현하지 못한 실행을
// 통과시키면 이 파일은 존재 이유가 없다).
//
// 원문은 남기지 않는다 — requestId·SHA 앞자리·상태·코드·소요 시간만 본다.
import { chromium } from 'playwright'
import { spawn, execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { newWorkerPids, waitForGone, workerPidSet } from './_analysis-workers.mjs'

const APP = process.cwd()
let failed = 0
const log = (...a) => console.log('[dev]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }

if (process.platform !== 'win32') { console.error('개발 경로 E2E 는 Windows 전용'); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'node_modules'))) { console.error('npm install 필요'); process.exit(2) }

const REF = (() => {
  const cands = [
    path.join(APP, 'resources', 'speaker_b.wav'),
    path.join(APP, '..', '..', 'AudioForge', 'resources', 'speaker_b.wav'),
  ]
  return cands.find((p) => fs.existsSync(p)) || null
})()
if (!REF) { console.error('참조 자산 없음'); process.exit(2) }

const SCRIPT = '첫 줄입니다. 두 번째 문장입니다.\n[기쁨] 둘째 줄입니다.'
const SHA8 = crypto.createHash('sha256').update(SCRIPT, 'utf-8').digest('hex').slice(0, 8)
// 로그에 원문이 새는지 검사할 때 쓰는 조각(원문 자체는 어디에도 출력하지 않는다).
const LEAK_PROBES = ['첫 줄입니다', '둘째 줄입니다', '두 번째 문장']

const PORT = 9333 + (process.pid % 200)

/**
 * 종료 시나리오.
 *   window — 창을 닫아 정상 경로로 내린다(사용자가 앱을 끄는 경우).
 *   tree   — 트리를 통째로 강제 종료한다(개발 서버 강제 종료·Ctrl+C·테스트 중단에 해당).
 *            이때 Electron 의 종료 훅은 **돌지 않는다**. 그래도 worker 는 stdin 이 닫히면서
 *            EOF 로 스스로 끝나야 한다 — 그 마지막 안전망을 여기서 검사한다.
 */
const EXIT_MODE = (process.argv.includes('--exit=tree')
  || process.env.AF_DEV_E2E_EXIT === 'tree') ? 'tree' : 'window'
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'af-devpath-'))

const workersBefore = workerPidSet()
let spawnedWorkerPids = null

// ── 개발 경로 기동: run.bat 을 그대로 부른다 ────────────────────────────────
const childLog = []
const pushLog = (s) => {
  for (const line of String(s).split(/\r?\n/)) if (line.trim()) childLog.push(line)
}
// cmd 는 PATH 로 찾는다 — 현재 폴더 탐색이 꺼진 환경도 있어 절대 경로로 부른다.
const child = spawn('cmd.exe', ['/c', path.join(APP, 'run.bat')], {
  cwd: APP,
  env: {
    ...process.env,
    AF_E2E: '1',
    AF_E2E_USER_DATA: USER_DATA,
    AF_E2E_CDP_PORT: String(PORT),
    AUDIOFORGE_NO_PAUSE: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
child.stdout.setEncoding('utf-8'); child.stdout.on('data', pushLog)
child.stderr.setEncoding('utf-8'); child.stderr.on('data', pushLog)
let childExited = false
child.on('exit', () => { childExited = true })

/** 우리가 띄운 이 트리만 정리한다. 다른 프로세스는 건드리지 않는다. */
const killOwnTree = () => {
  if (childExited || !child.pid) return
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) }
  catch { /* 이미 내려갔다 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 개발 서버 + Electron 이 뜰 때까지. 첫 실행은 vite 컴파일 때문에 느리다. */
async function waitForCdp(timeoutMs) {
  const t0 = Date.now()
  for (;;) {
    if (childExited) return { ok: false, reason: 'CHILD_EXITED' }
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) return { ok: true, ms: Date.now() - t0 }
    } catch { /* 아직 안 떴다 */ }
    if (Date.now() - t0 > timeoutMs) return { ok: false, reason: 'TIMEOUT', ms: Date.now() - t0 }
    await sleep(500)
  }
}

let browser = null
try {
  const up = await waitForCdp(240000)
  ok(up.ok, '개발 경로로 앱이 뜬다 (run.bat → af-launch → npm run dev)',
    up.ok ? `${up.ms}ms port=${PORT}` : `${up.reason} — ${childLog.slice(-3).join(' / ')}`)
  if (!up.ok) throw new Error(up.reason)

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)

  // preload 가 붙은 창을 고른다(개발자도구 등 다른 대상과 섞이지 않게).
  let page = null
  for (let i = 0; i < 60 && !page; i += 1) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        const hasApi = await p.evaluate(() => !!window.api).catch(() => false)
        if (hasApi) { page = p; break }
      }
      if (page) break
    }
    if (!page) await sleep(500)
  }
  ok(!!page, 'renderer 창에 붙었다')
  if (!page) throw new Error('NO_PAGE')

  // ── 계측 수집 ─────────────────────────────────────────────────────────────
  const consoleLines = []
  const pageErrors = []
  page.on('console', (m) => consoleLines.push(m.text()))
  // 스택까지 남긴다 — 메시지만으로는 어느 경로에서 났는지 알 수 없어 추적이 또 길어진다.
  page.on('pageerror', (e) => pageErrors.push(
    `${e.message} :: ${String(e.stack || '').split(String.fromCharCode(10))
      .slice(0, 4).join(' | ')}`))

  // 리스너를 붙이기 전에 이미 흘러간 로그는 볼 수 없다. 새로 고쳐 renderer 수명을
  // 처음부터 관측한다 — StrictMode 이중 호출도 이때 잡힌다.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.api?.analysis?.analyze, null, { timeout: 60000 })

  const build = await page.evaluate(() => window.api.app.getBuildInfo())
  ok(!!build?.version, '개발 빌드 정보', `${build?.version} / ${build?.commit ?? '-'}`)

  const traces = () => consoleLines
    .filter((l) => l.startsWith('[analysis]'))
    .map((l) => {
      const m = /^\[analysis\] (\S+) (.*)$/.exec(l)
      if (!m) return null
      try { return { event: m[1], fields: JSON.parse(m[2]) } } catch { return { event: m[1], fields: {} } }
    })
    .filter(Boolean)

  // ── TTS 편집기 진입 → 대사 입력 ───────────────────────────────────────────
  await page.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
  await page.waitForSelector('section[aria-label="대사"] textarea', { timeout: 60000 })

  // StrictMode 이중 호출이 실제로 일어났는가. 이것이 없으면 이 테스트는 개발 경로를
  // 재현하지 못한 것이고, 그 실행은 회귀를 막지 못하므로 실패로 본다.
  const mounts = traces().filter((t) => t.event === 'mount').length
  const unmounts = traces().filter((t) => t.event === 'unmount').length
  ok(mounts >= 2 && unmounts >= 1,
    'StrictMode setup → cleanup → setup 이 실제로 일어났다', `mount=${mounts} unmount=${unmounts}`)

  const beforeFired = traces().filter((t) => t.event === 'debounce_fired').length
  const entered = await page.evaluate((script) => {
    const ta = document.querySelector('section[aria-label="대사"] textarea')
    if (!ta) return { ok: false }
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, script)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return { ok: true, len: ta.value.length }
  }, SCRIPT)
  ok(entered.ok, '대사 입력', `${entered.len}자 sha8=${SHA8}`)

  // ── 준비 상태를 유한 시간에 벗어나 결과가 뜬다 ────────────────────────────
  const panelState = () => page.evaluate(() => {
    const el = document.querySelector('[data-testid="input-analysis"]')
    if (!el) return { present: false }
    const sum = document.querySelector('[data-testid="input-analysis-summary"]')
    return { present: true, status: el.getAttribute('data-status'),
      summary: (sum?.textContent || '').trim() }
  })
  const waitFor = async (pred, ms, label) => {
    const t0 = Date.now()
    for (;;) {
      const s = await panelState()
      if (pred(s)) return { s, ms: Date.now() - t0 }
      if (Date.now() - t0 > ms) return { s, ms: Date.now() - t0, timedOut: true, label }
      await sleep(150)
    }
  }
  const left = await waitFor((s) => s.present && s.status !== 'preparing' && s.status !== 'idle',
    20000, 'leave-preparing')
  ok(!left.timedOut, '준비 상태를 유한 시간 안에 벗어난다', `${left.ms}ms status=${left.s.status}`)
  const done = await waitFor((s) => s.status === 'ready', 20000, 'ready')
  ok(!done.timedOut, '분석 결과가 화면에 뜬다', `${done.ms}ms "${done.s.summary}"`)

  // 개수 아닌 실체 — worker 프로세스가 실제로 생겼는가.
  spawnedWorkerPids = newWorkerPids(workersBefore)
  ok((spawnedWorkerPids ?? []).length > 0, '분석 worker 프로세스가 떴다',
    `pids=${(spawnedWorkerPids ?? []).length}`)

  // ── debounce 가 한 번만 발화했는가 ────────────────────────────────────────
  const fired = traces().filter((t) => t.event === 'debounce_fired').length - beforeFired
  ok(fired === 1, '입력 한 번에 debounce 요청이 정확히 한 번', `fired=${fired}`)

  // ── request → main → worker → response → ready 가 한 ID 로 이어진다 ───────
  const reqs = traces().filter((t) => t.event === 'request')
  const winner = reqs.length ? reqs[reqs.length - 1].fields.requestId : null
  const resp = traces().find((t) => t.event === 'response' && t.fields.requestId === winner)
  ok(!!winner && !!resp && resp.fields.ok === true && resp.fields.identity === true,
    'renderer: request → response 가 같은 ID 로 정착한다',
    `id=${winner ?? '-'} ok=${resp?.fields.ok} identity=${resp?.fields.identity}`)
  // main 쪽 한 줄. worker 가 되돌려준 신원이 같으면 Python 까지 갔다 온 것이다.
  const mainLine = childLog
    .filter((l) => l.includes('[analysis] ipc'))
    .map((l) => { try { return JSON.parse(l.slice(l.indexOf('{'))) } catch { return null } })
    .filter(Boolean)
    .find((f) => f.requestId === winner)
  ok(!!mainLine && mainLine.ok === true && mainLine.workerRequestId === winner,
    'main·worker 도 같은 ID 로 기록된다',
    mainLine ? `sha8=${mainLine.sha8} worker=${mainLine.workerRequestId} ${mainLine.ms}ms` : '기록 없음')
  ok(!!mainLine && mainLine.sha8 === SHA8, 'main 이 본 원문 SHA 가 우리가 넣은 것과 같다',
    `${mainLine?.sha8 ?? '-'} vs ${SHA8}`)

  // ── 응답이 버려지지 않았다(= alive 가 재진입에서 복구됐다) ────────────────
  const ignoredUnmounted = traces()
    .filter((t) => t.event === 'response_ignored' && t.fields.reason === 'UNMOUNTED').length
  ok(ignoredUnmounted === 0,
    'StrictMode 재진입 뒤에도 응답을 버리지 않는다(alive 복구)', `ignored=${ignoredUnmounted}`)
  const watchdogFired = traces().filter((t) => t.event === 'watchdog_fired').length
  ok(watchdogFired === 0, 'watchdog 이 발화하지 않았다(정상 경로)', `fired=${watchdogFired}`)

  // ── 오류 0 ────────────────────────────────────────────────────────────────
  const mainUncaught = childLog.filter((l) =>
    /Uncaught Exception|UnhandledPromiseRejection|EPIPE/.test(l))
  ok(mainUncaught.length === 0, 'main uncaught 오류 0', mainUncaught.slice(0, 2).join(' | '))
  ok(pageErrors.length === 0, 'renderer uncaught 오류 0', pageErrors.slice(0, 2).join(' | '))

  // ── 원문 유출 0 ───────────────────────────────────────────────────────────
  const hay = childLog.concat(consoleLines).join('\n')
  const leaked = LEAK_PROBES.filter((s) => hay.includes(s))
  ok(leaked.length === 0, '로그에 사용자 원문 0', `유출 조각 ${leaked.length}개`)
} catch (e) {
  ok(false, `예외: ${e && e.message}`)
} finally {
  // ── 종료: 창을 닫아 정상 경로로 내린다. 그래도 남으면 우리 트리만 강제 정리. ──
  if (EXIT_MODE === 'window') {
    try {
      for (const c of (browser?.contexts?.() ?? [])) {
        for (const p of c.pages()) await p.evaluate(() => window.close()).catch(() => {})
      }
    } catch { /* 이미 닫혔다 */ }
    try { await browser?.close() } catch { /* noop */ }
    for (let i = 0; i < 40 && !childExited; i += 1) await sleep(250)
    ok(childExited, '창을 닫으면 개발 서버 트리도 함께 내려간다',
      childExited ? '정상 종료' : '남아 있어 강제 정리함')
    killOwnTree()
  } else {
    // 종료 훅이 돌 틈을 주지 않는다. 살아남는 worker 가 있으면 여기서 드러난다.
    try { await browser?.close() } catch { /* noop */ }
    killOwnTree()
    for (let i = 0; i < 40 && !childExited; i += 1) await sleep(250)
    ok(childExited, '강제 종료로 개발 서버 트리가 내려간다', childExited ? '종료됨' : '남음')
  }
  await sleep(1000)
}

// ── 종료 계약: 이 테스트가 띄운 worker PID 가 사라졌는가 ────────────────────
{
  log('INFO 종료 시나리오', EXIT_MODE)
  const created = spawnedWorkerPids ?? []
  ok(workersBefore === null || created.length > 0,
    '테스트가 분석 worker 를 실제로 띄웠다', `pids=${created.length}`)
  const stillAlive = created.length ? await waitForGone(created, 15000) : []
  ok(stillAlive === null || stillAlive.length === 0,
    '종료 뒤 그 worker PID 가 사라졌다', `띄움=${created.length} 잔존=${(stillAlive ?? []).length}`)
}
try { fs.rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* noop */ }

log(failed === 0 ? '전부 통과' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
