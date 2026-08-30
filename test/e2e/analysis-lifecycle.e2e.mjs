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
import {
  killWorkerPids, listAnalysisWorkers, newWorkerPids, waitForGone, workerPidSet,
} from './_analysis-workers.mjs'
import { execSync } from 'child_process'

const APP = process.cwd()
let failed = 0
const log = (...a) => console.log('[analysis]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }

if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) {
  console.error('빌드 필요 — npm run build')
  process.exit(2)
}

// 승인 대본은 저장소에 추적되지 않는다. 경로를 코드에 박으면 그 PC 에서만 되는 측정이
// 되므로 **환경 변수로만** 받는다. 없으면 장문 측정만 건너뛰고 그 사실을 로그로 남긴다.
const gobackPath = (process.env.AF_E2E_GOBACK_SCRIPT || '').trim()
const LONG = gobackPath && fs.existsSync(gobackPath) ? fs.readFileSync(gobackPath, 'utf-8') : null

// 종료 계약은 **PID** 로 본다. 개수 비교는 질의를 실행하는 powershell 이 자기 명령줄 때문에
// 스스로를 세어 실제 worker 가 0 이어도 통과시켰다.
const workersBefore = workerPidSet()
let spawnedWorkerPids = null

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
    log('INFO goback 대본 없음 — 장문 측정 생략(AF_E2E_GOBACK_SCRIPT 로 지정한다)')
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
  // **PID 로** 죽인다. 명령줄 문자열로 고르던 방식은 powershell 자신을 목록에 넣었고,
  // 따옴표가 어긋난 뒤에는 아무것도 죽이지 않은 채 이 검사를 껍데기로 만들었다.
  const before = listAnalysisWorkers() ?? []
  const killed = killWorkerPids(before.map((w) => w.pid))
  ok(killed > 0, 'worker 를 실제로 강제 종료했다(검사 전제)', `killed=${killed}/${before.length}`)
  log('INFO worker 강제 종료', killed)
  const afterKill = await call('종료 뒤 첫 요청입니다.', 'e4')
  ok(typeof afterKill.ok === 'boolean', '죽은 뒤에도 응답이 온다(매달리지 않는다)',
    `${afterKill.ms}ms ok=${afterKill.ok} code=${afterKill.code ?? '-'}`)
  ok(afterKill.ms < 25000, '타임아웃 전에 끝난다', `${afterKill.ms}ms`)
  const recovered = await call('복구 뒤 요청입니다.', 'e5')
  ok(recovered.ok === true, '새 worker 로 복구된다', `${recovered.ms}ms`)
  // 종료 계약이 볼 대상은 **지금 살아 있는** worker 다(중간에 일부러 죽인 것 말고).
  spawnedWorkerPids = newWorkerPids(workersBefore)
  ok((spawnedWorkerPids ?? []).length > 0, '복구된 worker 프로세스가 실재한다',
    `pids=${(spawnedWorkerPids ?? []).length}`)

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

// 종료 계약 — 이 테스트가 띄운 PID 가 실제로 사라졌는지 본다.
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
