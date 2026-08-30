// 분석 패널 DOM 상태 전이 E2E — IPC 응답이 아니라 **실제 화면 문구**를 본다.
// 실행: npm run test:e2e:analysis-panel
//
// `대사 분석 준비 중…` 에서 풀리지 않던 결함의 회귀다. 10초 안에 준비 상태를 벗어나지
// 못하면 실패시킨다.
//
// 원문은 남기지 않는다 — requestId·SHA 앞자리·상태·오류 코드·소요 시간만 기록한다.
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { newWorkerPids, waitForGone, workerPidSet } from './_analysis-workers.mjs'
import crypto from 'crypto'

const APP = process.cwd()
let failed = 0
const log = (...a) => console.log('[panel]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }

if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) {
  console.error('빌드 필요 — npm run build')
  process.exit(2)
}

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

// 종료 계약은 **PID** 로 본다. 개수 비교는 두 번 틀렸다 — 질의를 실행하는 powershell 이
// 자기 명령줄 때문에 스스로를 세었고, worker 를 못 띄운 실행도 `before==after` 로 통과했다.
const workersBefore = workerPidSet()
let spawnedWorkerPids = null

const app = await electron.launch({
  args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' },
})
const win = await app.firstWindow()
const mainErrors = []
app.process().stderr?.on('data', (d) => {
  const s = String(d)
  if (/Uncaught Exception|EPIPE|UnhandledPromiseRejection/.test(s)) mainErrors.push(s.trim())
})
win.on('pageerror', (e) => mainErrors.push(`renderer: ${e.message}`))

/** 패널의 현재 상태와 보이는 문구. 대사 원문은 읽지 않는다. */
const panelState = () => win.evaluate(() => {
  const el = document.querySelector('[data-testid="input-analysis"]')
  if (!el) return { present: false }
  const summary = document.querySelector('[data-testid="input-analysis-summary"]')
  const status = document.querySelector('[data-testid="input-analysis-status"]')
  return {
    present: true,
    status: el.getAttribute('data-status'),
    summary: (summary?.textContent || '').trim(),
    statusText: (status?.textContent || '').trim(),
    paragraphs: !!document.querySelector('[data-testid="analysis-paragraphs"]'),
    splits: !!document.querySelector('[data-testid="analysis-splits"]'),
  }
})

const waitFor = async (pred, ms, label) => {
  const t0 = Date.now()
  for (;;) {
    const s = await panelState()
    if (pred(s)) return { s, ms: Date.now() - t0 }
    if (Date.now() - t0 > ms) return { s, ms: Date.now() - t0, timedOut: true, label }
    await win.waitForTimeout(120)
  }
}

try {
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.api?.analysis?.analyze, null, { timeout: 15000 })
  ok(true, 'preload analysis API 노출', 'analyze/prewarm/cancel')
  const hasBuild = await win.evaluate(() => typeof window.api?.app?.getBuildInfo === 'function')
  ok(hasBuild, 'preload getBuildInfo 노출')
  const build = await win.evaluate(() => window.api.app.getBuildInfo())
  ok(!!build?.version, '실행 중 build 정보', `${build?.version} / ${build?.commit ?? '-'}`)

  // TTS 모드로 들어가 대사를 넣는다. 편집기 textarea 를 직접 채우지 않고 store 를 쓴다면
  // 화면 계약이 달라지므로, 실제 사용자와 같게 textarea 에 입력한다.
  // TTS 편집기는 파일이 있어야 열린다 — 다른 E2E 와 같은 경로로 진입한다(합성은 하지 않는다).
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
  await win.waitForSelector('section[aria-label="대사"] textarea', { timeout: 30000 })

  const entered = await win.evaluate(async (script) => {
    const ta = document.querySelector('section[aria-label="대사"] textarea')
    if (!ta) return { ok: false, reason: 'NO_TEXTAREA' }
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, script)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return { ok: true, len: ta.value.length }
  }, SCRIPT)
  ok(entered.ok, '대사 입력', entered.ok ? `${entered.len}자 sha8=${SHA8}` : entered.reason)
  if (!entered.ok) throw new Error(entered.reason)

  // ── 준비 중 → 분석 중 → 결과 ──────────────────────────────────────────────
  const appeared = await waitFor((s) => s.present, 5000, 'panel')
  ok(!appeared.timedOut, '분석 패널이 나타난다', `${appeared.ms}ms status=${appeared.s.status}`)
  log('INFO 초기 상태', JSON.stringify(appeared.s))

  const left = await waitFor(
    (s) => s.present && s.status !== 'preparing' && s.status !== 'idle', 10000, 'leave-preparing')
  ok(!left.timedOut, '10초 안에 준비 상태를 벗어난다',
    `${left.ms}ms status=${left.s.status} 문구="${left.s.statusText || left.s.summary}"`)

  const done = await waitFor((s) => s.status === 'ready', 10000, 'ready')
  ok(!done.timedOut, '결과 상태에 도달한다', `${done.ms}ms status=${done.s.status}`)
  // worker 가 실제로 떴는지 여기서 PID 를 잡아 둔다(종료 계약 검사의 재료).
  spawnedWorkerPids = newWorkerPids(workersBefore)
  ok((spawnedWorkerPids ?? []).length > 0, '분석 worker 프로세스가 떴다',
    `pids=${(spawnedWorkerPids ?? []).length}`)
  if (!done.timedOut) {
    ok(/예상 음성|예측 자료 부족/.test(done.s.summary), '요약 문구가 표시된다', done.s.summary)
    ok(done.s.paragraphs, '문단 목록이 그려진다')
  }

  // ── 재입력: stale 을 거쳐 다시 결과로 ─────────────────────────────────────
  await win.evaluate((extra) => {
    const ta = document.querySelector('section[aria-label="대사"] textarea')
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ta.value + extra)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }, ' 세 번째 문장 추가입니다.')
  const again = await waitFor((s) => s.status === 'ready', 10000, 'ready-2')
  ok(!again.timedOut, '재입력 뒤에도 결과로 돌아온다', `${again.ms}ms status=${again.s.status}`)

  ok(mainErrors.length === 0, 'main·renderer 오류 0', mainErrors.slice(0, 2).join(' | '))
} catch (e) {
  ok(false, `예외: ${e && e.message}`)
} finally {
  await app.close().catch(() => {})
}

// 종료 계약 — **이 테스트가 실제로 띄운 PID** 가 사라졌는지 본다.
// worker 를 애초에 못 띄웠다면 그것부터 실패다(개수만 같아서 초록이 되던 구멍).
{
  const created = spawnedWorkerPids ?? []
  ok(workersBefore === null || created.length > 0,
    '테스트가 분석 worker 를 실제로 띄웠다', `pids=${created.length}`)
  const stillAlive = created.length ? await waitForGone(created) : []
  ok(stillAlive === null || stillAlive.length === 0,
    '종료 뒤 그 worker PID 가 사라졌다', `띄움=${created.length} 잔존=${(stillAlive ?? []).length}`)
}

log(failed === 0 ? '전부 통과' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
