// 대사 분석 패널이 **계획을 그대로 보여 주는지** — 실제 개발 실행 경로에서 확인한다.
//
//   AudioForge 개발버전 실행.lnk -> run.bat -> af-launch.mjs -> npm run dev
//
// 실행: npm run test:e2e:analysis-plan
//
// 무엇을 보는가
// -------------
// 화면에 뜬 문단·발화·생성 묶음·감정 구간·경고의 **개수와 문구**를, 같은 대본으로 받은
// 계획(IPC 응답)과 하나씩 맞춰 본다. 어긋나면 화면이 자기 계산을 갖고 있다는 뜻이다.
// 이미지 대신 숫자와 문구로 남긴다 — 화면 캡처는 이름표 없이 밖으로 나가고 지울 수 없다.
//
// 대본 원문은 보고서에 넣지 않는다. 미리보기 칸은 길이만 세고, 로그 유출 검사에는
// 조각을 쓰되 그 조각 자체를 출력하지 않는다.
import { chromium } from 'playwright'
import { spawn, execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { makeSyntheticWav, cleanupSyntheticWav } from './_e2e-helper.mjs'
import { newWorkerPids, waitForGone, workerPidSet } from './_analysis-workers.mjs'

const APP = process.cwd()
let failed = 0
const log = (...a) => console.log('[plan]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }

if (process.platform !== 'win32') { console.error('개발 경로 E2E 는 Windows 전용'); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'node_modules'))) { console.error('npm install 필요'); process.exit(2) }

// 참조 오디오는 편집기에 들어가기 위한 파일 하나면 된다(참조 확정·전사 경로를 타지 않는다).
// 저장소 밖의 사용자 자산을 뒤지지 않는다 — 그러면 다른 PC 에서 재현되지 않는다.
const SYNTH = makeSyntheticWav(
  path.join(os.tmpdir(), 'af_plan_' + randomUUID() + '.wav'), 12)

const LF = String.fromCharCode(10)

/**
 * 세 가지 대본. 각각 다른 것을 보여 준다.
 *
 *  structure — 문단 2, 한 문단 안에서 감정이 바뀌어 발화가 늘고, 쉼이 하나 있다.
 *  warned    — 닫히지 않은 표기 + 말이 없는 문단. 파서는 계속 권위를 갖는다.
 *  fallback  — 알 수 없는 표기. 파서가 물러나 줄 단위 근사가 된다.
 */
const CASES = [
  {
    id: 'structure',
    text: '[기쁨] 첫 문장입니다. [쉼 0.5] 둘째 문장입니다.' + LF + LF + '[슬픔] 둘째 문단입니다.',
    expect: { warnings: [], authority: true, utteranceRows: 3 },
  },
  {
    id: 'warned',
    text: '[기쁨 닫히지 않은 표기입니다.' + LF + LF + '[쉼 1.0]' + LF + LF + '[슬픔] 말이 있는 문단입니다.',
    expect: { warnings: ['UNCLOSED_TAG', 'DIRECTIVE_ONLY_PARAGRAPH'], authority: true },
  },
  {
    id: 'fallback',
    text: '[없는감정] 알 수 없는 표기입니다.' + LF + LF + '둘째 문단입니다.',
    expect: { warnings: ['UNKNOWN_DIRECTIVE'], authority: false },
  },
]

// 원문이 콘솔·화면 밖으로 새는지 볼 조각(출력하지 않는다).
const LEAK_PROBES = ['첫 문장입니다', '둘째 문단입니다', '말이 있는 문단']

const PORT = 9633 + (process.pid % 200)
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'af-planpanel-'))
const workersBefore = workerPidSet()
let spawnedWorkerPids = null

const childLog = []
const pushLog = (s) => {
  for (const line of String(s).split(/\r?\n/)) if (line.trim()) childLog.push(line)
}
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

const material = []
let browser = null
try {
  const up = await waitForCdp(240000)
  ok(up.ok, '개발 경로로 앱이 뜬다 (run.bat → af-launch → npm run dev)',
    up.ok ? `${up.ms}ms port=${PORT}` : `${up.reason} — ${childLog.slice(-3).join(' / ')}`)
  if (!up.ok) throw new Error(up.reason)

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
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

  const consoleLines = []
  const pageErrors = []
  page.on('console', (m) => consoleLines.push(m.text()))
  page.on('pageerror', (e) => pageErrors.push(String(e.message)))

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.api?.analysis?.analyze, null, { timeout: 60000 })
  const build = await page.evaluate(() => window.api.app.getBuildInfo())
  ok(!!build?.version, '개발 빌드', `${build?.version} / ${build?.commit ?? '-'}`)

  await page.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, SYNTH)
  await page.waitForSelector('section[aria-label="대사"] textarea', { timeout: 60000 })

  // tokenizer 첫 로드는 몇 초 걸린다. 버려지는 분석 한 번으로 큐를 비워 두면 이후 측정이
  // 실제 분석 시간만 담는다(전에 이 준비 비용을 분석 시간으로 잘못 읽은 적이 있다).
  await page.evaluate(() => window.api.analysis.analyze({ requestId: 'warm', text: '준비.' }))
  spawnedWorkerPids = newWorkerPids(workersBefore)

  /** 화면에서 읽는다 — 계산하지 않고 그려진 것을 센다. */
  const readPanel = () => page.evaluate(() => {
    const t = (sel) => document.querySelector(sel)
    const all = (sel) => Array.from(document.querySelectorAll(sel))
    const text = (el) => (el?.textContent || '').trim()
    const panel = t('[data-testid="input-analysis"]')
    return {
      status: panel?.getAttribute('data-status') ?? null,
      summary: text(t('[data-testid="input-analysis-summary"]')),
      structure: text(t('[data-testid="analysis-structure"]')),
      paragraphs: all('[data-testid="analysis-paragraphs"] > div').length,
      utterances: all('[data-testid="analysis-utterance"]').length,
      utteranceEmotions: all('[data-testid="analysis-utterance-emotion"]').map(text),
      emotionSpans: all('[data-testid="analysis-emotion-span"]').length,
      emotionText: all('[data-testid="analysis-emotion-span"]')
        // 미리보기 칸(대본 조각)은 길이만 센다 — 원문을 보고서로 옮기지 않는다.
        .map((el) => Array.from(el.children).slice(0, 2).map(text).join(' / ')),
      // 목록 제목은 span 이라 `> div` 가 곧 행 수다(전에 여기서 하나를 더 뺐다).
      splits: all('[data-testid="analysis-splits"] > div').length,
      warningCodes: all('[data-testid="analysis-plan-warning"]')
        .map((el) => el.getAttribute('data-code')),
      // 행 앞머리 셋(오류/경고 · 이름 · 위치)만 담는다. 뒤의 설명·미리보기는 담지 않는다.
      warningText: all('[data-testid="analysis-plan-warning"]')
        .map((el) => Array.from(el.children).slice(0, 3).map(text).join(' · ')),
      warningKinds: all('[data-testid="analysis-plan-warning"]')
        .map((el) => el.getAttribute('data-blocking')),
      approximate: !!t('[data-testid="analysis-plan-approximate"]'),
      // 아직 없는 축은 상세 정보 안에만 있어야 한다 — 기본 화면에서는 0개여야 한다.
      reservedAxes: all('[data-testid="analysis-reserved-axis"]').map(text),
      detailOpen: t('[data-testid="analysis-detail"]') !== null,
      /**
       * 합성 시작 자리의 상태.
       *
       * 이 자리는 두 모습을 가진다 — 준비가 끝나면 누를 수 있는 버튼, 준비가 덜 됐으면
       * 사유를 적은 안내(`aria-disabled`). E2E 환경은 참조 구간을 확정하지 않으므로
       * 후자가 정상이다. 그래서 "눌리는가" 가 아니라 **경고가 이 상태를 바꾸는가**를 본다.
       */
      synth: (() => {
        const btn = document.querySelector('button[aria-label="음성 합성 시작"]')
        if (btn) return { kind: 'action', disabled: !!btn.disabled, text: '' }
        const blocked = Array.from(document.querySelectorAll('[aria-disabled="true"]'))
          .find((el) => (el.textContent || '').includes('음성 합성 시작'))
        if (blocked) return { kind: 'blocked', disabled: true, text: (blocked.textContent || '').trim() }
        return { kind: 'absent', disabled: null, text: '' }
      })(),
    }
  })

  /** 상세 정보를 펼친다(사용자가 누르는 것과 같은 경로). */
  const openDetail = async () => {
    await page.click('[data-testid="input-analysis-detail-toggle"]')
    await sleep(200)          // React 재렌더를 기다린다 — 즉시 읽으면 이전 상태를 본다
  }

  const typeScript = (script) => page.evaluate((s) => {
    const ta = document.querySelector('section[aria-label="대사"] textarea')
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, s)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return ta.value.length
  }, script)

  const waitReady = async (ms) => {
    const t0 = Date.now()
    for (;;) {
      const s = await readPanel()
      if (s.status === 'ready') return { ok: true, ms: Date.now() - t0, panel: s }
      if (Date.now() - t0 > ms) return { ok: false, ms: Date.now() - t0, panel: s }
      await sleep(150)
    }
  }

  for (const c of CASES) {
    const chars = await typeScript(c.text)
    const got = await waitReady(30000)
    ok(got.ok, `[${c.id}] 준비 상태를 벗어나 결과가 뜬다`,
      `${chars}자 ${got.ms}ms status=${got.panel.status}`)
    if (!got.ok) continue
    const screen = got.panel

    // 같은 대본의 계획을 IPC 로 직접 받아 화면과 맞춘다.
    const res = await page.evaluate(
      (t) => window.api.analysis.analyze({ requestId: 'plan-' + Math.random(), text: t }), c.text)
    const plan = res?.result?.plan
    ok(!!plan, `[${c.id}] 응답에 계획이 실려 온다`,
      `schema=${res?.result?.schemaVersion} plan=${plan?.planSchemaVersion}`)
    if (!plan) continue

    ok(screen.paragraphs === plan.sourceParagraphs.length,
      `[${c.id}] 화면 문단 수 == 계획 문단 수`,
      `screen=${screen.paragraphs} plan=${plan.sourceParagraphs.length}`)
    ok(screen.structure.includes(`문단 ${plan.sourceParagraphs.length}`)
      && screen.structure.includes(`발화 ${plan.utterances.length}`)
      && screen.structure.includes(`생성 묶음 ${plan.chunks.length}`),
      `[${c.id}] 세 축을 각각 다른 이름·수로 말한다`, screen.structure)
    ok(screen.emotionSpans === plan.emotions.length,
      `[${c.id}] 감정 구간 수 == 계획`,
      `screen=${screen.emotionSpans} plan=${plan.emotions.length}`)
    ok(screen.splits === Math.max(0, plan.chunks.length - 1),
      `[${c.id}] 분할 경계 수 == 묶음 수 - 1`,
      `screen=${screen.splits} chunks=${plan.chunks.length}`)
    if (c.expect.utteranceRows !== undefined) {
      // 발화가 둘 이상이거나 지시가 붙은 문단에서는 발화 줄이 실제로 그려져야 한다.
      ok(screen.utterances === c.expect.utteranceRows,
        `[${c.id}] 문단 아래 발화 줄이 계획만큼 뜬다`,
        `screen=${screen.utterances} plan=${plan.utterances.length}`)
    }
    ok(JSON.stringify(screen.warningCodes) === JSON.stringify(plan.warnings.map((w) => w.code)),
      `[${c.id}] 경고 코드가 계획과 같은 순서로 뜬다`,
      `screen=[${screen.warningCodes}] plan=[${plan.warnings.map((w) => w.code)}]`)
    ok(JSON.stringify(screen.warningCodes) === JSON.stringify(c.expect.warnings),
      `[${c.id}] 예상한 경고가 정확히 그것뿐이다`, `[${screen.warningCodes}]`)
    ok(plan.parserAuthority === c.expect.authority,
      `[${c.id}] 파서 권위 상태가 예상과 같다`, String(plan.parserAuthority))
    ok(screen.approximate === !c.expect.authority,
      `[${c.id}] 근사 안내는 물러난 경우에만 뜬다`, String(screen.approximate))
    ok(screen.reservedAxes.length === 0,
      `[${c.id}] 아직 없는 축이 기본 화면을 채우지 않는다`, `${screen.reservedAxes.length}개`)
    // 경고 문구가 합성 자리에 새어 들어가면 그것이 곧 "경고가 막았다" 로 읽힌다.
    const warningWords = ['닫히지 않은', '알 수 없는 표기', '말이 없는', '겹치는 지시']
    ok(!warningWords.some((w) => screen.synth.text.includes(w)),
      `[${c.id}] 합성 자리에 사전 경고가 끼어들지 않는다`,
      `${screen.synth.kind}`)

    material.push({
      case: c.id,
      chars,
      readyMs: got.ms,
      summary: screen.summary,
      structure: screen.structure,
      screen: {
        paragraphs: screen.paragraphs, utterances: screen.utterances,
        emotionSpans: screen.emotionSpans, splits: screen.splits,
        utteranceEmotions: screen.utteranceEmotions,
        emotionRows: screen.emotionText,
        warningRows: screen.warningText,
        approximate: screen.approximate,
        reservedAxesInDefaultView: screen.reservedAxes.length,
        synth: screen.synth.kind + (screen.synth.text ? ' :: ' + screen.synth.text : ''),
      },
      plan: {
        paragraphs: plan.sourceParagraphs.length, utterances: plan.utterances.length,
        chunks: plan.chunks.length, emotions: plan.emotions.length,
        pauses: plan.pauses.length, sentences: plan.sentences.length,
        warnings: plan.warnings.map((w) => `${w.code}@${w.sourceStart}`),
        parserAuthority: plan.parserAuthority,
        structureSha8: String(plan.structureSha256).slice(0, 8),
      },
    })
  }

  // ── 경고가 합성 자리를 바꾸지 않는다 ──────────────────────────────────────
  // 경고 없는 대본과 경고 있는 대본에서 이 자리가 **같아야** 한다. (파서 오류가 있는
  // 대본은 v1.2.0 부터 생성 시작 자체를 막는다 — 그건 fail-closed 정책이고 미리보기
  // 경고와 다른 층이라 비교 대상이 아니다.)
  const synthAt = {}
  for (const id of ['structure', 'warned']) {
    const c = CASES.find((x) => x.id === id)
    await typeScript(c.text)
    await waitReady(30000)
    const st = await readPanel()
    synthAt[id] = st.synth.kind + '|' + st.synth.text
  }
  ok(synthAt.structure === synthAt.warned,
    '사전 경고가 합성 자리의 상태를 바꾸지 않는다',
    `${synthAt.structure} vs ${synthAt.warned}`)

  // ── 상세 정보를 펼치면 아직 없는 축이 보인다 ──────────────────────────────
  await openDetail()
  const detail = await readPanel()
  ok(detail.detailOpen, '상세 정보가 펼쳐진다')
  ok(detail.reservedAxes.length === 6 && detail.reservedAxes.every((s) => s.endsWith('0')),
    '상세 정보에 앞으로 들어올 축 6개가 값 없이 표시된다', detail.reservedAxes.join(' '))

  // ── 버전 표시 ─────────────────────────────────────────────────────────────
  const shown = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="analysis-build"]')
    return (el?.textContent || '').trim()
  })
  ok(/^빌드 v\d+\.\d+\.\d+-dev\+[0-9a-f]{7}$/.test(shown),
    '개발 빌드 표시가 버전 + short SHA 다', shown)

  // ── 위생 ──────────────────────────────────────────────────────────────────
  ok(pageErrors.length === 0, 'renderer 에서 잡히지 않은 오류가 없다',
    pageErrors.slice(0, 2).join(' | '))
  const leaked = LEAK_PROBES.filter(
    (probe) => consoleLines.some((l) => l.includes(probe)) || childLog.some((l) => l.includes(probe)))
  ok(leaked.length === 0, '로그에 대사 원문이 남지 않는다', `${leaked.length}건`)

  log('── 화면 확인 자료 ──')
  log(JSON.stringify(material, null, 2))
} catch (e) {
  ok(false, '예외', String(e?.message ?? e))
} finally {
  try { if (browser) await browser.close() } catch { /* 무시 */ }
  killOwnTree()
  if (spawnedWorkerPids?.length) {
    const gone = await waitForGone(spawnedWorkerPids, 15000)
    ok(gone, '우리가 만든 분석 worker 가 종료됐다', `pids=${spawnedWorkerPids.join(',')}`)
  }
  cleanupSyntheticWav(SYNTH)
  // 실패한 실행의 임시 userData 는 진단을 위해 남긴다.
  if (!failed) { try { fs.rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* 무시 */ } }
}

log(failed ? `실패 ${failed}건` : '전부 통과')
process.exit(failed ? 1 : 0)
