// 입력 분석 lifecycle E2E — 실제 Electron 앱에서 IPC 왕복을 잰다.
// 실행: npm run test:e2e:analysis
//
// 확인하는 것:
//   · main 에 uncaught exception 이 없다(실제 앱에서 EPIPE 로 터지던 경로)
//   · prewarm → cold analyze → warm analyze 가 모두 응답으로 끝난다
//   · 죽은 worker 에 쓰는 상황을 만들어도 앱이 살아 있고 응답이 유한 시간에 온다
//   · GPU·torch·음성 모델 로딩 0
//   · stale/out-of-order 응답이 최신 요청을 덮지 않는다
// 대사 원문은 출력하지 않는다 — 길이와 시간만 남긴다.
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const APP = process.cwd()
let failed = 0
const log = (...a) => console.log('[analysis]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }

if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) {
  console.error('빌드 필요 — npm run build')
  process.exit(2)
}

// 승인 대본은 본체 저장소의 resources 에 있다(worktree 에는 없다).
const gobackCandidates = [
  path.join(APP, 'resources', 'reference-audio', 'goback', 'goback-longform.txt'),
  path.join(APP, '..', '..', 'AudioForge', 'resources', 'reference-audio', 'goback', 'goback-longform.txt'),
]
const gobackPath = gobackCandidates.find((p) => fs.existsSync(p))
const LONG = gobackPath ? fs.readFileSync(gobackPath, 'utf-8') : null

// 자기가 띄운 분석 worker 만 센다. 다른 python·합성 프로세스는 건드리지 않는다.
const countAnalysisWorkers = () => {
  const q = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '
    + String.fromCharCode(39) + '*analysis_worker.py*' + String.fromCharCode(39)
    + ' } | Measure-Object | Select-Object -ExpandProperty Count'
  try {
    return parseInt(execSync('powershell -NoProfile -Command "' + q + '"',
      { encoding: 'utf-8' }).trim(), 10) || 0
  } catch { return -1 }
}
const workersBefore = countAnalysisWorkers()

const app = await electron.launch({
  args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' },
})
const win = await app.firstWindow()
const mainErrors = []
const pageErrors = []
app.process().stderr?.on('data', (d) => {
  const s = String(d)
  if (/Uncaught Exception|EPIPE|UnhandledPromiseRejection/.test(s)) mainErrors.push(s.trim())
})
win.on('pageerror', (e) => pageErrors.push(e.message))

const call = (text, id) => win.evaluate(async ([t, rid]) => {
  const t0 = performance.now()
  const res = await window.api.analysis.analyze({ requestId: rid, text: t })
  return { ms: Math.round(performance.now() - t0), ok: res.ok, code: res.code,
    calls: res.ok ? res.result.plannedCalls : null,
    paras: res.ok ? res.result.sourceParagraphCount : null,
    segs: res.ok ? res.result.segmentCount : null,
    tokenizer: res.ok ? res.result.tokenizer : null,
    conf: res.ok ? res.result.confidence : null }
}, [text, id])

try {
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.api?.analysis, null, { timeout: 15000 })

  // ── prewarm(사용자 텍스트 없음) ────────────────────────────────────────────
  const warm = await win.evaluate(async () => {
    const t0 = performance.now()
    const r = await window.api.analysis.prewarm()
    return { ms: Math.round(performance.now() - t0), ready: r?.ready === true }
  })
  ok(typeof warm.ready === 'boolean', 'prewarm 이 응답으로 끝난다',
    `${warm.ms}ms ready=${warm.ready}`)

  // ── cold / warm ────────────────────────────────────────────────────────────
  const cold = await call('짧은 문장입니다. 두 번째 문장입니다.', 'e1')
  ok(cold.ok === true, 'cold 분석 성공', `${cold.ms}ms 묶음=${cold.calls} tokenizer=${cold.tokenizer}`)
  const warm1 = await call('짧은 문장입니다. 두 번째 문장입니다. 세 번째.', 'e2')
  ok(warm1.ok === true, 'warm 분석 성공', `${warm1.ms}ms 묶음=${warm1.calls}`)
  ok(warm1.ms < cold.ms || cold.ms < 500, 'warm 이 cold 보다 빠르다(또는 이미 데워져 있었다)',
    `cold ${cold.ms}ms / warm ${warm1.ms}ms`)

  if (LONG) {
    const long = await call(LONG, 'e3')
    ok(long.ok === true, `goback ${LONG.length}자 분석 성공`,
      `${long.ms}ms 문단=${long.paras} 구간=${long.segs} 묶음=${long.calls} conf=${long.conf}`)
  } else {
    log('INFO goback 대본 없음 — 장문 측정 생략')
  }

  // ── 빠른 연속 입력: 마지막 것만 살아남는다 ────────────────────────────────
  const burst = await win.evaluate(async () => {
    const out = []
    for (let i = 0; i < 6; i += 1) {
      out.push(window.api.analysis.analyze({ requestId: `b${i}`, text: '연속 입력 '.repeat(i + 1) }))
    }
    const rs = await Promise.all(out)
    return rs.map((r) => ({ ok: r.ok, code: r.code }))
  })
  ok(burst.every((r) => r.ok === true || r.code === 'SUPERSEDED' || r.code === 'CANCELLED'),
    '연속 입력이 전부 구조화 응답으로 끝난다', JSON.stringify(burst.map((r) => r.code ?? 'ok')))
  ok(burst[burst.length - 1].ok === true, '마지막 요청은 결과를 받는다')

  // ── 죽은 파이프: 앱이 살아 있고 응답이 온다 ───────────────────────────────
  // 테스트 프로세스에서 직접 죽인다 — analysis_worker 만 고른다(다른 python 은 건드리지 않는다).
  const killed = (() => {
    const ps = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '
      + String.fromCharCode(39) + '*analysis_worker.py*' + String.fromCharCode(39)
      + ' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'
    try {
      execSync('powershell -NoProfile -Command "' + ps + '"', { stdio: 'ignore' })
      return true
    } catch { return false }
  })()
  log('INFO worker 강제 종료', killed)
  const afterKill = await call('종료 뒤 첫 요청입니다.', 'e4')
  ok(typeof afterKill.ok === 'boolean', '죽은 뒤에도 응답이 온다(매달리지 않는다)',
    `${afterKill.ms}ms ok=${afterKill.ok} code=${afterKill.code ?? '-'}`)
  ok(afterKill.ms < 25000, '타임아웃 전에 끝난다', `${afterKill.ms}ms`)
  const recovered = await call('복구 뒤 요청입니다.', 'e5')
  ok(recovered.ok === true, '새 worker 로 복구된다', `${recovered.ms}ms`)

  // ── GPU·모델 로딩 0 ───────────────────────────────────────────────────────
  const gpu = (() => {
    try {
      return execSync('nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader',
        { encoding: 'utf-8' }).trim()
    } catch { return 'UNKNOWN' }
  })()
  ok(!/python/i.test(gpu), 'GPU 연산 프로세스에 분석 worker 가 없다', gpu || '(없음)')

  ok(mainErrors.length === 0, 'main 에 uncaught exception 이 없다',
    mainErrors.slice(0, 2).join(' | '))
  ok(pageErrors.length === 0, 'renderer 오류 0', pageErrors.slice(0, 2).join(' | '))
} catch (e) {
  ok(false, `예외: ${e && e.message}`)
} finally {
  await app.close().catch(() => {})
}

// 종료 뒤 자기가 만든 worker 가 남지 않아야 한다(정상·실패·예외 어느 경로든 여기를 지난다).
{
  let after = countAnalysisWorkers()
  for (let i = 0; i < 20 && after > workersBefore; i += 1) {
    await new Promise((r) => setTimeout(r, 250))
    after = countAnalysisWorkers()
  }
  ok(workersBefore < 0 || after <= workersBefore,
    '종료 뒤 analysis worker 고아 0', `before=${workersBefore} after=${after}`)
}

log(failed === 0 ? '전부 통과' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
