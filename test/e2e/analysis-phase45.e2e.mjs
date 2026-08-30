// 입력 추정 UI — PHASE 4(성능·동시성) / PHASE 5(계약·접근성·화면 크기) 검증.
// 실행: npm run test:e2e:analysis-phase45
//
// 여기서는 GPU 합성을 돌리지 않는다. 검사 대상은 **분석 패널이 각 상태에서 어떻게 행동하는가**
// 이고, 그 상태의 권위는 store 의 `status` 다. 실제 합성을 돌려도 패널이 보는 입력은 같은
// `status` 하나이므로, 상태를 직접 구동하는 편이 같은 것을 더 정확하게 잰다.
// (합성 자체의 정확성은 이 파일의 범위가 아니다 — 그 검증은 별도 E2E 가 한다.)
//
// 원문은 남기지 않는다 — 글자 수·문단 수·SHA 앞자리·소요 시간만 본다.
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { randomUUID } from 'crypto'
import { execSync } from 'child_process'
import { listAnalysisWorkers, newWorkerPids, waitForGone, workerPidSet } from './_analysis-workers.mjs'
import { makeSyntheticWav, cleanupSyntheticWav } from './_e2e-helper.mjs'

const APP = process.cwd()
let failed = 0
const log = (...a) => console.log('[p45]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }
const info = (m, extra = '') => log('INFO', m, extra)

if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

// 저장소에는 추적된 오디오 자산이 **하나도 없다**. 이 테스트가 필요한 것은 '파일 하나' 뿐이고
// (참조 클립 확정·전사 경로를 타지 않는다) 그래서 이번 실행 전용 합성 WAV 를 만들어 쓴다.
// 본체 저장소의 미추적 `resources/` 를 뒤지면 clean clone·다른 PC·CI 에서 재현되지 않는
// 검증이 된다 — 실제로 detached clean worktree 에서 그 경로로 통과해 버렸다.
const SYNTH = makeSyntheticWav(
  path.join(os.tmpdir(), 'af_e2e_' + randomUUID() + '.wav'), 12)
const REF = (process.env.AF_E2E_REFERENCE || '').trim() || SYNTH

// 승인 대본만 쓴다. 길이·감정 변수를 섞은 임의 시나리오를 새로 만들지 않는다.
// 두 대본 모두 저장소에 추적되지 않는다. **경로를 코드에 박지 않고** 환경 변수로만 받는다 —
// 박아 두면 그 PC 에서만 되는 측정이 되고, 없는 곳에서는 조용히 건너뛴 것을 알 수 없다.
const readIfSet = (envName, pick) => {
  const p = (process.env[envName] || '').trim()
  if (!p || !fs.existsSync(p)) return null
  try { return pick(fs.readFileSync(p, 'utf-8')) } catch { return null }
}
const GOBACK = readIfSet('AF_E2E_GOBACK_SCRIPT', (t) => t)
const SAMPLE4 = readIfSet('AF_E2E_SAMPLE4_SCRIPT',
  (t) => (t.trimStart().startsWith('{') ? (JSON.parse(t).ttsText || null) : t))

const sha8 = (s) => crypto.createHash('sha256').update(s, 'utf-8').digest('hex').slice(0, 8)
const SHORT = '짧은 문장입니다.'
const MULTI = '첫 문단입니다. 이어지는 문장입니다.\n\n둘째 문단입니다.\n셋째 문단입니다.'

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

const sleep = (ms) => win.waitForTimeout(ms)

const setText = (text) => win.evaluate((t) => {
  const ta = document.querySelector('section[aria-label="대사"] textarea')
  if (!ta) return false
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, t)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}, text)

const panel = () => win.evaluate(() => {
  const el = document.querySelector('[data-testid="input-analysis"]')
  if (!el) return { present: false }
  const sum = document.querySelector('[data-testid="input-analysis-summary"]')
  const rows = [...document.querySelectorAll('[data-testid="analysis-paragraphs"] > div')]
  const splits = [...document.querySelectorAll('[data-testid="analysis-splits"] > div')]
  return {
    present: true, status: el.getAttribute('data-status'),
    summary: (sum?.textContent || '').trim(),
    paragraphRows: rows.length,
    splitRows: splits.length,   // 제목은 span 이라 div 개수가 곧 행 수다
  }
})

const waitReady = async (ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    const s = await panel()
    if (s.status === 'ready') return { s, ms: Date.now() - t0 }
    if (Date.now() - t0 > ms) return { s, ms: Date.now() - t0, timedOut: true }
    await sleep(120)
  }
}

/** 화면이 아니라 분석 결과 자체를 직접 묻는다(planner parity 대조용). */
const analyzeDirect = (text, id) => win.evaluate(async ([t, rid]) => {
  const t0 = performance.now()
  const r = await window.api.analysis.analyze({ requestId: rid, text: t })
  return {
    ms: Math.round(performance.now() - t0), ok: r.ok, code: r.code,
    calls: r.ok ? r.result.plannedCalls : null,
    paras: r.ok ? r.result.sourceParagraphCount : null,
    segs: r.ok ? r.result.segmentCount : null,
    sha: r.ok ? r.result.sourceSha256.slice(0, 8) : null,
    conf: r.ok ? r.result.confidence : null,
    chunkRows: r.ok ? r.result.chunks.length : null,
  }
}, [text, id])

const setStatus = (fn) => win.evaluate((f) => {
  const s = window.__afStore.getState()
  s[f]()
  return window.__afStore.getState().status
}, fn)

try {
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.api?.analysis?.analyze, null, { timeout: 20000 })
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
  await win.waitForSelector('section[aria-label="대사"] textarea', { timeout: 30000 })
  // tokenizer 를 먼저 데운다 — 이후 측정에 첫 로드 시간이 섞이지 않게.
  // prewarm 응답만으로는 부족하다: 훅도 mount 에서 prewarm 을 부르고, worker 는 한 줄로
  // 처리하므로 뒤이은 첫 analyze 가 남은 로드 뒤에 줄을 선다. 실제 analyze 한 번을 버려
  // 그 줄까지 비운 뒤에 잰다.
  const warmT0 = Date.now()
  await win.evaluate(() => window.api.analysis.prewarm())
  await analyzeDirect(SHORT, 'warm0')
  info('콜드 로드(측정 대상 아님)', `${Date.now() - warmT0}ms`)

  spawnedWorkerPids = newWorkerPids(workersBefore)
  ok((spawnedWorkerPids ?? []).length > 0, '분석 worker 프로세스가 떴다',
    `pids=${(spawnedWorkerPids ?? []).length}`)

  // ══ PHASE 4 — 성능·동시성 ══════════════════════════════════════════════════
  log('── PHASE 4 ──')

  // P4-1. 승인 대본 장문 분석
  if (SAMPLE4) {
    const r = await analyzeDirect(SAMPLE4, 's4')
    const r2 = await analyzeDirect(SAMPLE4 + ' ', 's4b')
    ok(r.ok === true, `sample_4 ${SAMPLE4.length}자 분석 성공`,
      `${r.ms}ms 문단=${r.paras} 구간=${r.segs} 묶음=${r.calls} conf=${r.conf}`)
    ok(r2.ms < 500, 'sample_4 분석이 편집을 끊지 않는 시간 안에 끝난다',
      `1회=${r.ms}ms 2회=${r2.ms}ms`)
    ok(r.chunkRows === r.calls, 'chunk 행 수 == 묶음 수', `${r.chunkRows} vs ${r.calls}`)
  } else {
    info('sample_4 대본 없음 — 측정 생략(AF_E2E_SAMPLE4_SCRIPT 로 지정한다)')
  }
  if (GOBACK) {
    const r = await analyzeDirect(GOBACK, 'gb')
    ok(r.ok === true, `goback ${GOBACK.length}자 분석 성공`,
      `${r.ms}ms 문단=${r.paras} 구간=${r.segs} 묶음=${r.calls} conf=${r.conf}`)
  } else {
    info('goback 대본 없음 — 측정 생략(AF_E2E_GOBACK_SCRIPT 로 지정한다)')
  }

  // P4-1b. 신뢰도 표시가 죽은 라벨이 아닌지 — 실측 범위에 드는 입력이 실제로 있는가.
  // 승인 대본 두 편은 둘 다 '외삽' 이 나온다(goback 1054 token·sample_4 2397 token 은
  // 실측 구간 396~1342 frame 밖이다). 라벨이 늘 한 값이면 정보가 아니라 잡음이므로,
  // 승인 대본의 앞부분을 잘라 실측 구간에 드는 입력으로 반대쪽을 확인한다.
  // (품질 시나리오가 아니라 라벨 도달성 확인이다 — 새 대본을 지어내지 않는다.)
  if (GOBACK) {
    let measured = null
    for (const n of [400, 500, 600, 700]) {
      const r = await analyzeDirect(GOBACK.slice(0, n), `c${n}`)
      if (r.ok && r.conf === 'measured') { measured = { n, r }; break }
    }
    ok(!!measured, '실측 구간에 드는 입력에서는 신뢰도가 measured 로 바뀐다',
      measured ? `goback 앞 ${measured.n}자 → ${measured.r.conf}` : '어떤 길이에서도 measured 없음')
  }

  // P4-2. 순서 어긋난 적용 0 — 연속 요청 뒤 화면에 남는 것은 마지막 입력의 결과여야 한다.
  await setText(SHORT)
  await waitReady()
  const burst = await win.evaluate(async ([a, b, c]) => {
    const p = [a, b, c].map((t, i) =>
      window.api.analysis.analyze({ requestId: `x${i}`, text: t }))
    const rs = await Promise.all(p)
    return rs.map((r, i) => ({
      i, ok: r.ok, code: r.code, sha: r.ok ? r.result.sourceSha256.slice(0, 8) : null,
    }))
  }, [SHORT, MULTI, SHORT + ' 마지막입니다.'])
  const settled = burst.filter((r) => r.ok)
  ok(burst.every((r) => r.ok || r.code === 'SUPERSEDED' || r.code === 'CANCELLED'),
    '연속 요청이 모두 구조화 응답으로 끝난다', JSON.stringify(burst.map((r) => r.code ?? 'ok')))
  ok(settled.every((r) => r.sha === sha8([SHORT, MULTI, SHORT + ' 마지막입니다.'][r.i])),
    '성공한 응답의 SHA 가 그 요청의 원문과 일치한다(순서 어긋난 적용 0)',
    settled.map((r) => `${r.i}:${r.sha}`).join(' '))

  // P4-3. 입력 지연 + long task — 한 글자씩 넣는 동안 프레임이 막히지 않아야 한다.
  const typing = await win.evaluate(async () => {
    const ta = document.querySelector('section[aria-label="대사"] textarea')
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value').set
    const long = []
    const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(e.duration) })
    try { obs.observe({ entryTypes: ['longtask'] }) } catch { /* 미지원 브라우저 */ }
    const lat = []
    setter.call(ta, ''); ta.dispatchEvent(new Event('input', { bubbles: true }))
    for (let i = 0; i < 60; i += 1) {
      const t0 = performance.now()
      setter.call(ta, ta.value + '가')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => requestAnimationFrame(() => r()))
      lat.push(performance.now() - t0)
    }
    await new Promise((r) => setTimeout(r, 300))
    try { obs.disconnect() } catch { /* noop */ }
    lat.sort((a, b) => a - b)
    return {
      n: lat.length, p50: lat[Math.floor(lat.length * 0.5)], p95: lat[Math.floor(lat.length * 0.95)],
      max: lat[lat.length - 1], longTasks: long.length, longMax: long.length ? Math.max(...long) : 0,
    }
  })
  ok(typing.p95 < 50, '타이핑 60회 입력 지연 p95 < 50ms',
    `p50=${typing.p50.toFixed(1)}ms p95=${typing.p95.toFixed(1)}ms max=${typing.max.toFixed(1)}ms`)
  ok(typing.longMax < 200, '타이핑 중 long task 200ms 미만',
    `건수=${typing.longTasks} 최대=${typing.longMax.toFixed(0)}ms`)

  // P4-4. worker 자원 — 상주 프로세스가 메모리를 계속 불리지 않아야 한다.
  const wpid = (spawnedWorkerPids ?? [])[0]
  const usage = (pid) => {
    try {
      const q = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`
        + ' | Select-Object -ExpandProperty WorkingSetSize'
      return Number(execSync(`powershell -NoProfile -Command "${q}"`, { encoding: 'utf-8' }).trim())
    } catch { return NaN }
  }
  const memBefore = wpid ? usage(wpid) : NaN
  for (let i = 0; i < 20; i += 1) await analyzeDirect(MULTI + ' 반복 ' + i, `r${i}`)
  const memAfter = wpid ? usage(wpid) : NaN
  if (Number.isFinite(memBefore) && Number.isFinite(memAfter)) {
    const grow = (memAfter - memBefore) / 1048576
    ok(grow < 50, '분석 20회 뒤 worker 메모리 증가 50MiB 미만',
      `${(memBefore / 1048576).toFixed(0)} → ${(memAfter / 1048576).toFixed(0)} MiB (+${grow.toFixed(1)})`)
  } else {
    info('worker 메모리 조회 실패 — 측정 생략')
  }

  // P4-5. GPU 사용 0 — 분석 worker 가 연산 프로세스 목록에 없어야 한다.
  const gpu = (() => {
    try {
      return execSync('nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader',
        { encoding: 'utf-8' }).trim()
    } catch { return 'UNKNOWN' }
  })()
  const gpuPids = gpu === 'UNKNOWN' ? [] : gpu.split(/\r?\n/)
    .map((l) => Number(l.split(',')[0])).filter(Number.isFinite)
  const alive = (listAnalysisWorkers() ?? []).map((w) => w.pid)
  ok(!alive.some((p) => gpuPids.includes(p)), '분석 worker 가 GPU 연산 프로세스에 없다',
    `worker=${alive.join(',') || '-'} gpu=${gpuPids.join(',') || '(없음)'}`)

  // P4-6. 합성 중 동시성 — 편집이 잠긴 동안 새 분석을 쏘지 않는다.
  await setText(MULTI)
  await waitReady()
  const beforeProcessing = await panel()
  const st1 = await setStatus('setProcessing')
  await sleep(1200)
  const during = await panel()
  ok(st1 === 'processing', '합성 시작 상태로 전환', st1)
  ok(during.present && during.status !== 'preparing' && during.status !== 'analyzing',
    '합성 중 패널이 진행 중 상태에 갇히지 않는다', `status=${during.status}`)
  ok(during.summary === beforeProcessing.summary,
    '합성 중에도 직전 예상값이 그대로 보인다', during.summary)

  // P4-7. 취소·완료 뒤 복귀
  const st2 = await setStatus('beginCancelling')
  await sleep(300)
  const st3 = await setStatus('finishCancelled')
  info('상태 전이', `${st1} → ${st2} → ${st3}`)
  await setText(MULTI + ' 취소 뒤 추가.')
  const back = await waitReady()
  ok(!back.timedOut, '취소 뒤 분석이 다시 결과까지 간다', `${back.ms}ms status=${back.s.status}`)

  // 완료(done) 상태도 같은 계약이다 — 결과가 나온 뒤에도 패널이 깨지지 않아야 한다.
  await win.evaluate(() => window.__afStore.getState().setResult([], null, null))
  await sleep(500)
  const afterDone = await panel()
  ok(afterDone.present && afterDone.status === 'ready',
    '합성 완료 뒤에도 예상 정보가 그대로 보인다', `status=${afterDone.status}`)
  await win.evaluate(() => window.__afStore.getState().clearError())

  // P4-8. 모드 전환에서 pending 정리 — 편집기가 사라졌다가 돌아와도 멀쩡해야 한다.
  await setText(MULTI + ' 모드 전환 직전 입력입니다.')
  await win.evaluate(() => window.__afStore.getState().setMode('split'))
  await sleep(600)
  const goneAway = await panel()
  ok(!goneAway.present, '모드를 바꾸면 분석 패널이 사라진다')
  await win.evaluate(() => window.__afStore.getState().setMode('tts'))
  await win.waitForSelector('section[aria-label="대사"] textarea', { timeout: 30000 })
  await setText(MULTI)
  const revisit = await waitReady()
  ok(!revisit.timedOut, '모드를 되돌리면 분석이 정상 재개된다', `${revisit.ms}ms`)

  // ══ PHASE 5 — 계약·접근성·화면 크기 ═════════════════════════════════════════
  log('── PHASE 5 ──')

  // P5-1. 화면의 묶음 수 == production planner 의 chunk 수
  for (const [name, text] of [['goback', GOBACK], ['sample_4', SAMPLE4], ['다문단', MULTI]]) {
    if (!text) continue
    await setText(text)
    const r = await waitReady()
    if (r.timedOut) { ok(false, `${name} 화면 결과 도달`, `status=${r.s.status}`); continue }
    const direct = await analyzeDirect(text, `v-${name}`)
    const shown = Number(/(\d+)개 묶음/.exec(r.s.summary)?.[1] ?? NaN)
    ok(shown === direct.calls, `${name}: 화면 묶음 수 == planner chunk 수`,
      `화면=${shown} planner=${direct.calls}`)
    ok(r.s.paragraphRows === direct.paras, `${name}: 문단 줄 수 == source_paragraph_count`,
      `${r.s.paragraphRows} vs ${direct.paras}`)
    ok(r.s.splitRows === Math.max(0, direct.calls - 1),
      `${name}: 분할 줄 == 실제 경계 수(묶음-1)`, `분할=${r.s.splitRows} 묶음=${direct.calls}`)
  }

  // P5-2. 자료 부족 상태 — 시간을 지어내지 않는다.
  await setText('음.')
  await sleep(1200)
  const tiny = await panel()
  info('짧은 입력 상태', `status=${tiny.status} "${tiny.summary}"`)
  ok(!/예상 작업 (0초|NaN)/.test(tiny.summary), '자료가 모자라면 시간을 지어내지 않는다', tiny.summary)

  // P5-3. 접근성 — 상태만 알리고, 결과 표는 낭독으로 밀어붙이지 않는다.
  await setText(MULTI)
  await waitReady()
  const a11y = await win.evaluate(() => {
    const q = (s) => document.querySelector(s)
    const root = q('[data-testid="input-analysis"]')
    const live = [...root.querySelectorAll('[aria-live]')].map((e) => ({
      id: e.getAttribute('data-testid'), v: e.getAttribute('aria-live'),
    }))
    const toggle = q('[data-testid="input-analysis-toggle"]')
    const detail = q('[data-testid="input-analysis-detail-toggle"]')
    return {
      live,
      status: q('[data-testid="input-analysis-status"]')?.getAttribute('role'),
      toggleExpanded: toggle?.getAttribute('aria-expanded'),
      detailExpanded: detail?.getAttribute('aria-expanded'),
      summaryLabel: q('[data-testid="input-analysis-summary"]')?.getAttribute('aria-label'),
      paraLabel: q('[data-testid="analysis-paragraphs"]')?.getAttribute('aria-label'),
      toggleTag: toggle?.tagName, detailTag: detail?.tagName,
    }
  })
  ok(a11y.live.filter((e) => e.v === 'polite').length === 1,
    'aria-live=polite 는 상태 한 곳뿐이다', JSON.stringify(a11y.live))
  ok(a11y.live.every((e) => e.v === 'polite' || e.v === 'off'),
    '결과 영역은 aria-live=off 로 낭독에서 뺀다', JSON.stringify(a11y.live))
  ok(a11y.status === 'status', '상태 span 에 role=status')
  ok(a11y.toggleExpanded === 'true' || a11y.toggleExpanded === 'false',
    '패널 토글에 aria-expanded', String(a11y.toggleExpanded))
  ok(a11y.toggleTag === 'BUTTON' && a11y.detailTag === 'BUTTON',
    '토글이 진짜 button 이라 키보드로 닿는다', `${a11y.toggleTag}/${a11y.detailTag}`)
  ok(!!a11y.paraLabel, '문단 목록에 접근성 이름', a11y.paraLabel ?? '-')

  // stale 은 이름으로도 '이전 입력' 임을 말해야 한다.
  await setText(MULTI + ' 새 문장을 덧붙입니다.')
  await sleep(120)
  const staleLabel = await win.evaluate(() =>
    document.querySelector('[data-testid="input-analysis-summary"]')?.getAttribute('aria-label'))
  ok(!staleLabel || /이전 입력/.test(staleLabel) || /예상/.test(staleLabel),
    'stale 상태의 접근성 이름이 이전 입력임을 밝힌다', String(staleLabel))
  await waitReady()

  // P5-4. 키보드만으로 접고 펼 수 있다.
  const kbBefore = await win.evaluate(() => {
    const t = document.querySelector('[data-testid="input-analysis-toggle"]')
    t.focus()
    const focused = document.activeElement === t
    const before = t.getAttribute('aria-expanded')
    t.click()   // React 재렌더는 다음 틱이다 — 여기서 읽으면 항상 옛 값이 나온다
    return { focused, before }
  })
  await sleep(200)
  const kb = {
    ...kbBefore,
    after: await win.evaluate(() =>
      document.querySelector('[data-testid="input-analysis-toggle"]').getAttribute('aria-expanded')),
  }
  ok(kb.focused, '패널 토글에 포커스가 간다')
  ok(kb.before !== kb.after, '토글이 실제로 접힌다', `${kb.before} → ${kb.after}`)
  await win.evaluate(() => document.querySelector('[data-testid="input-analysis-toggle"]').click())

  // P5-5. 작은 창 · 높은 확대(= 좁아진 CSS 뷰포트)에서 가로 넘침 0
  const sizes = [[1280, 800, '기본'], [900, 700, '작은 창'], [860, 540, '150% 확대 상당']]
  for (const [w, h, name] of sizes) {
    await win.setViewportSize({ width: w, height: h })
    await sleep(250)
    const box = await win.evaluate(() => {
      const el = document.querySelector('[data-testid="input-analysis"]')
      const ta = document.querySelector('section[aria-label="대사"] textarea')
      return {
        present: !!el,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        panelOverflow: el ? el.scrollWidth - el.clientWidth : 0,
        panelW: el ? Math.round(el.getBoundingClientRect().width) : 0,
        taW: ta ? Math.round(ta.getBoundingClientRect().width) : 0,
        processBtn: !!document.querySelector('button[data-testid="process-button"], button')
          && document.body.scrollHeight > 0,
      }
    })
    ok(box.present, `${name} ${w}x${h}: 패널이 남아 있다`)
    ok(box.overflowX <= 1, `${name}: 문서 가로 넘침 0`, `${box.overflowX}px`)
    ok(box.panelOverflow <= 1, `${name}: 패널 가로 넘침 0`, `${box.panelOverflow}px`)
    ok(Math.abs(box.panelW - box.taW) <= 24,
      `${name}: 패널 폭이 대사 입력 폭을 넘지 않는다`, `패널=${box.panelW} 대사=${box.taW}`)
  }
  await win.setViewportSize({ width: 1280, height: 800 })
  await sleep(250)

  // P5-6. 기존 레이아웃 불변 — 패널이 있을 때와 없을 때 대사 입력 상자가 같아야 한다.
  const withPanel = await win.evaluate(() => {
    const ta = document.querySelector('section[aria-label="대사"] textarea').getBoundingClientRect()
    return { w: Math.round(ta.width), h: Math.round(ta.height), x: Math.round(ta.left) }
  })
  await setText('')
  await sleep(700)
  const without = await win.evaluate(() => {
    const ta = document.querySelector('section[aria-label="대사"] textarea').getBoundingClientRect()
    return {
      w: Math.round(ta.width), h: Math.round(ta.height), x: Math.round(ta.left),
      panel: !!document.querySelector('[data-testid="input-analysis"]'),
    }
  })
  ok(!without.panel, '대사가 비면 패널이 사라진다')
  ok(withPanel.w === without.w && withPanel.h === without.h && withPanel.x === without.x,
    '패널 유무가 대사 입력 상자를 바꾸지 않는다',
    `${withPanel.w}x${withPanel.h}@${withPanel.x} vs ${without.w}x${without.h}@${without.x}`)

  // ── 사용자 확인 자료 ──────────────────────────────────────────────────────
  // 화면 캡처는 허락 없이 찍지 않는다. 이 패널은 글자만 있는 화면이므로, 렌더된 문구를
  // 그대로 옮기면 캡처와 같은 것을 전한다. **문단 미리보기는 대사 원문 조각이므로 길이만
  // 남기고 내용은 담지 않는다.**
  const material = []
  const scenarios = [
    ['짧은 문장', SHORT],
    ['다문단', MULTI],
    ['분할 경계', GOBACK],
    ['일반 장문', SAMPLE4],
    ['자료 부족', '음.'],
  ]
  for (const [name, text] of scenarios) {
    if (!text) { material.push({ name, skipped: '대본 없음' }); continue }
    await setText(text)
    const r = await waitReady()
    const shot = await win.evaluate(() => {
      const q = (s) => document.querySelector(s)
      const detail = q('[data-testid="input-analysis-detail-toggle"]')
      if (detail && detail.getAttribute('aria-expanded') === 'false') detail.click()
      return null
    })
    void shot
    await sleep(200)
    const cap = await win.evaluate(() => {
      const q = (s) => document.querySelector(s)
      const rows = [...document.querySelectorAll('[data-testid="analysis-paragraphs"] > div')]
      return {
        status: q('[data-testid="input-analysis"]')?.getAttribute('data-status'),
        summary: (q('[data-testid="input-analysis-summary"]')?.textContent || '').trim(),
        // 미리보기 칸(2번째 span)은 대사 조각이라 길이만 센다.
        paragraphs: rows.map((d) => {
          const sp = [...d.querySelectorAll('span')].map((x) => (x.textContent || '').trim())
          return { label: sp[0], previewChars: (sp[1] || '').length, cells: sp.slice(2) }
        }),
        splits: [...document.querySelectorAll('[data-testid="analysis-splits"] > div')]
          .map((d) => (d.textContent || '').trim()),
        detail: [...document.querySelectorAll('[data-testid="analysis-detail"] > span')]
          .map((x) => (x.textContent || '').trim()),
      }
    })
    material.push({ name, chars: text.length, sha8: sha8(text), readyMs: r.ms, ...cap })
  }
  const outDir = path.join(APP, '_local', 'artifacts', 'diagnostics')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, 'input-estimator-review.json')
  fs.writeFileSync(outPath, JSON.stringify({ generatedFor: 'INPUT_ESTIMATOR_UI_REVIEW', material },
    null, 2), 'utf-8')
  // 승인 대본 둘은 저장소에 없을 수 있다(env 로만 받는다). 그래서 **자산 없이도 항상
  // 가능한 시나리오**를 기준으로 삼고, 건너뛴 것은 개수로 드러낸다 — 조용히 줄어들면 안 된다.
  const collected = material.filter((m) => !m.skipped).length
  const skipped = material.filter((m) => m.skipped).length
  ok(collected >= 3, '사용자 확인 자료 수집(자산 없이 가능한 시나리오)',
    `수집 ${collected} / 건너뜀 ${skipped} → _local/artifacts/diagnostics/`)
  for (const m of material) {
    if (m.skipped) { info(`자료[${m.name}]`, m.skipped); continue }
    info(`자료[${m.name}]`, `${m.chars}자 sha8=${m.sha8} status=${m.status} | ${m.summary}`)
    if (m.splits.length) info(`  분할`, m.splits.slice(0, 4).join(' / ')
      + (m.splits.length > 4 ? ` … 외 ${m.splits.length - 4}` : ''))
    for (const d of m.detail) info('  상세', d)
  }

  // ── 오류 0 ────────────────────────────────────────────────────────────────
  ok(mainErrors.length === 0, 'main uncaught 오류 0', mainErrors.slice(0, 2).join(' | '))
  ok(pageErrors.length === 0, 'renderer uncaught 오류 0', pageErrors.slice(0, 2).join(' | '))
} catch (e) {
  ok(false, `예외: ${e && e.message}`)
} finally {
  await app.close().catch(() => {})
}

{
  const created = spawnedWorkerPids ?? []
  ok(workersBefore === null || created.length > 0,
    '테스트가 분석 worker 를 실제로 띄웠다', `pids=${created.length}`)
  const stillAlive = created.length ? await waitForGone(created) : []
  ok(stillAlive === null || stillAlive.length === 0,
    '종료 뒤 그 worker PID 가 사라졌다', `띄움=${created.length} 잔존=${(stillAlive ?? []).length}`)
}

cleanupSyntheticWav(SYNTH)

log(failed === 0 ? '전부 통과' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
