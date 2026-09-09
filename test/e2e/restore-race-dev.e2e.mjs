// 복원 중 목소리 선택 변경 — 표적 검사 하나. (GPU·음성 생성 없음)
//
// 시나리오(2026-09-09 관리자 지시)
//   1) 저장된 목소리 A 의 복원이 **진행 중일 때** 사용자가 B 를 지정한다.
//   2) A 의 복원 결과가 나중에 도착해도 B 의 원본·구간·클립·준비 상태가 유지돼야 한다.
//   3) 화면 상태뿐 아니라 **B 의 실제 클립 파일이 살아 있는지** 확인한다.
//   4) 합성에 전달할 참조도 B 인지 확인한다(음성은 만들지 않는다).
//   5) main 의 클립 등록·교체에서도 늦은 A 가 B 의 클립을 교체·삭제하지 않는지 본다.
//
// 타이밍은 **검사 안에서만** 맞춘다: 복원이 A 를 트림하는 실제 창(분석+자르기+전사) 동안
// 화면의 '목소리 바꾸기' 를 누른다. 실제 복원·지정 경로는 손대지 않는다(대역은 OS 선택창뿐).
//
// 실행: node test/e2e/restore-race-dev.e2e.mjs
import { spawn, execFileSync } from 'child_process'
import { chromium } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isolatedInput, cleanupIsolated } from './_e2e-helper.mjs'

const APP = process.cwd()
const OUT = path.join(APP, '_local', 'artifacts', 'diagnostics', 'restore-race')
fs.mkdirSync(OUT, { recursive: true })
const FIX = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav')
if (!fs.existsSync(FIX)) { console.error('fixture 없음:', FIX); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

// 작업 원본(대본이 붙는 파일) + 목소리 A + 목소리 B — 경로가 서로 달라야 교체가 실제 교체다.
const work = isolatedInput(FIX)
const voiceA = isolatedInput(FIX)
const voiceB = isolatedInput(FIX)
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'af-race-'))
const PORT = 9760 + (process.pid % 120)
const SPK = 'spk_a'
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const logLines = []
let failed = 0
const log = (...a) => {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  logLines.push(s); console.log('[race]', s)
}
const ok = (id, pass, what, detail = '') => {
  log(`${pass ? 'PASS' : 'FAIL'} ${id} ${what}${detail ? ' — ' + detail : ''}`)
  if (!pass) failed += 1
}

// ── 저장 기록을 미리 심는다 ──────────────────────────────────────────────────
// 복원은 '저장된 기록이 있고 이 작업에 아직 인물이 없을 때' 시작된다. 두 단계로 앱을 띄우는
// 대신 기록을 직접 써 두면 그 조건이 결정적으로 만들어진다(기록 형식은 shared/workDraft 계약).
const workKey = work.input.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const draft = {
  schemaVersion: 1,
  sourcePath: work.input,
  updatedAt: new Date().toISOString(),
  ttsText: `[화자 인물A]${String.fromCharCode(10)}안녕하세요.`,
  speakerMode: 'multi',
  speakers: { [SPK]: { source: voiceA.input, region: { start: 0.12, duration: 9.64 }, label: '인물A' } },
  renames: {},
  inheritSpeakerId: null,
}
fs.writeFileSync(path.join(USER_DATA, 'settings.json'), JSON.stringify({
  workDrafts: { schemaVersion: 1, drafts: { [workKey]: draft } },
}, null, 2), 'utf-8')

const childLog = []
const child = spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
  cwd: APP, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: USER_DATA, AF_E2E_CDP_PORT: String(PORT),
    // OS 파일 선택창만 대신한다. 검사 중에 '다음 선택' 을 B 로 바꿔 지정한다.
    AF_E2E_SELECT_FILE: voiceB.input,
  },
})
const pushLog = (s) => { for (const l of String(s).split(/\r?\n/)) if (l.trim()) childLog.push(l) }
child.stdout.setEncoding('utf-8'); child.stdout.on('data', pushLog)
child.stderr.setEncoding('utf-8'); child.stderr.on('data', pushLog)
let childExited = false
child.on('exit', () => { childExited = true })
const killOwnTree = () => {
  if (childExited || !child.pid) return
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* */ }
}

async function waitForCdp(timeoutMs) {
  const t0 = Date.now()
  for (;;) {
    if (childExited) return { ok: false, reason: 'CHILD_EXITED' }
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return { ok: true, ms: Date.now() - t0 } } catch { /* */ }
    if (Date.now() - t0 > timeoutMs) return { ok: false, reason: 'TIMEOUT' }
    await sleep(500)
  }
}

let browser = null
try {
  const up = await waitForCdp(240000)
  ok('boot', up.ok, '앱이 뜬다', up.ok ? `${up.ms}ms` : `${up.reason} ${childLog.slice(-4).join(' / ')}`)
  if (!up.ok) throw new Error(up.reason)
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  let page = null
  for (let i = 0; i < 60 && !page; i += 1) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) {
      if (await p.evaluate(() => !!window.api).catch(() => false)) { page = p; break }
    }
    if (!page) await sleep(500)
  }
  if (!page) throw new Error('NO_PAGE')
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.api?.audio?.process, null, { timeout: 60000 })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1150, height: 950, deviceScaleFactor: 1, mobile: false })

  const st = (fn, arg) => page.evaluate(fn, arg)
  const slotOf = () => st((id) => window.__afStore.getState().ttsSpeakerRefState[id] || null, SPK)
  const waitUntil = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(150) } return false }

  // 작업 원본을 연다 → 저장된 기록으로 복원이 시작된다.
  await st(async (fp) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(fp), await window.api.audio.getFileUrl(fp))
    s.getState().setMode('tts')
  }, work.input)

  // 1) A 의 복원이 **진행 중**인 창을 잡는다: 슬롯이 A 를 들고 아직 준비되지 않은 상태.
  const restoring = await waitUntil(async () => {
    const s = await slotOf()
    return !!s && s.source === voiceA.input && s.ready !== true
  }, 90000)
  const during = await slotOf()
  ok('R1', restoring, 'A 의 복원이 진행 중인 상태를 잡았다',
    `source=A:${during?.source === voiceA.input} phase=${during?.phase} ready=${during?.ready}`)
  const reqDuringRestore = during?.reqId || ''

  // 2) 그 창 안에서 사용자가 B 를 지정한다 — 화면의 '목소리 바꾸기' 경로로.
  await st((f) => window.api.audio.e2eSetSelectFile(f), voiceB.input)
  const assigned = await st(async (arg) => {
    // 카드가 아직 없을 수 있다(복원 초반) — 훅이 쓰는 것과 같은 store 동작을 부르되,
    // '직전 정상 목소리 보관' 이 필요 없는 경우다(A 는 준비되지 않았다).
    const btn = document.querySelector('[data-testid="card-voice-assign"]')
    if (btn) { btn.click(); return 'button' }
    const picked = await window.api.audio.selectFile()
    if (!picked) return ''
    window.__afStore.getState().registerSpeakerRef(arg.id, String(picked))
    return 'store'
  }, { id: SPK })
  ok('R2', assigned !== '', 'B 를 지정했다', `경로=${assigned}`)
  const afterAssign = await slotOf()
  ok('R3', afterAssign?.source === voiceB.input && afterAssign?.reqId !== reqDuringRestore,
    '지정 직후 슬롯이 B 를 들고 새 요청이 발급됐다',
    `source=B:${afterAssign?.source === voiceB.input} 새요청=${afterAssign?.reqId !== reqDuringRestore}`)

  // 3) A 의 늦은 결과가 도착할 시간을 준 뒤 B 가 준비될 때까지 기다린다.
  const settled = await waitUntil(async () => {
    const s = await slotOf()
    return !!s && s.source === voiceB.input && s.ready === true
  }, 180000)
  const finalSlot = await slotOf()
  ok('R4', settled && finalSlot?.source === voiceB.input,
    'B 의 원본·준비 상태가 유지된다(A 의 늦은 결과가 덮지 않았다)',
    `source=B:${finalSlot?.source === voiceB.input} ready=${finalSlot?.ready} phase=${finalSlot?.phase}`)
  ok('R5', !!finalSlot?.region && finalSlot.region.duration > 0,
    'B 의 구간이 남아 있다', JSON.stringify(finalSlot?.region))

  // 4) B 의 실제 클립 파일이 살아 있는가 — 화면 상태가 아니라 디스크가 근거다.
  const clip = finalSlot?.clip || ''
  ok('R6', clip !== '' && fs.existsSync(clip),
    'B 의 클립 파일이 디스크에 살아 있다', clip ? `${fs.existsSync(clip)} ${path.basename(clip)}` : '클립 없음(원본 전체 사용)')

  // 5) 합성에 전달할 참조가 B 인가 — ProcessButton 과 **같은 규칙**으로 계산한다(생성은 하지 않는다).
  const toSend = await st((id) => {
    const s = window.__afStore.getState()
    const slot = s.ttsSpeakerRefState[id]
    const effective = slot?.ready ? (slot.clip || slot.source) : ''
    return { effective, source: slot?.source || '' }
  }, SPK)
  const sendsB = toSend.effective !== '' && (toSend.effective === clip || toSend.effective === voiceB.input)
  ok('R7', sendsB && toSend.source === voiceB.input,
    '합성에 전달할 참조가 B 다', JSON.stringify({ effective: path.basename(toSend.effective), sourceIsB: toSend.source === voiceB.input }))

  // 6) main 의 클립 등록·교체에서도 늦은 A 가 B 의 것을 교체·삭제하지 않았는가.
  //
  //    ★확인용으로 트림을 다시 부르면 안 된다. 처음에는 그렇게 했는데, 설정이 조금 달라
  //    캐시가 어긋나 **새 클립을 만들고 B 의 것을 놓아 버렸다** — 측정이 대상을 바꿨다.
  //    읽기만으로 판정한다: 늦은 결과가 도착할 창을 준 뒤, 앱이 합성에 넘길 파일이 그대로 있는가.
  await sleep(6000)                     // A 의 늦은 결과가 도착할 창
  const late = await slotOf()
  ok('R8', late?.source === voiceB.input && late?.ready === true && (late?.clip || '') === clip,
    '늦은 결과가 도착할 시간을 준 뒤에도 슬롯이 B 를 그대로 가리킨다',
    JSON.stringify({ sourceIsB: late?.source === voiceB.input, ready: late?.ready,
      clipUnchanged: (late?.clip || '') === clip }))
  ok('R9', clip === '' || fs.existsSync(clip),
    '늦은 A 가 B 의 클립 파일을 교체·삭제하지 않았다',
    clip ? `${clip.slice(-38)} exists=${fs.existsSync(clip)}` : '클립 없는 준비(원본 전체)')

  // 7) 파생 클립 폴더에 임자 없는 것이 남지 않았는가(원자 교체가 이전 것을 놓았는가).
  //    A 의 폴더가 남아 있으면 교체가 반쪽이었다는 뜻이다.
  const clipRoot = path.join(USER_DATA, 'refclips')
  const dirs = fs.existsSync(clipRoot)
    ? fs.readdirSync(clipRoot).filter((d) => d.startsWith('audioforge_refclip_'))
    : []
  const liveDirs = await st(() => {
    const s = window.__afStore.getState()
    const out = []
    for (const v of Object.values(s.ttsSpeakerRefState)) if (v?.clip) out.push(v.clip)
    if (s.ttsReferenceClip) out.push(s.ttsReferenceClip)
    for (const v of Object.values(s.ttsEmotionRefState || {})) if (v?.clip) out.push(v.clip)
    return out
  })
  const liveSet = new Set(liveDirs.map((c) => path.basename(path.dirname(c))))
  const orphans = dirs.filter((d) => !liveSet.has(d))
  ok('R10', orphans.length === 0,
    '쓰이지 않는 파생 클립 폴더가 남지 않았다(원자 교체가 이전 것을 놓았다)',
    `폴더 ${dirs.length}개 · 쓰이는 것 ${liveSet.size}개 · 임자 없음 ${orphans.length}개`)

  ok('R11', pageErrors.length === 0, '렌더러 예외 0', pageErrors.slice(0, 3).join(' / '))
  await page.screenshot({ path: path.join(OUT, `race-${STAMP}.png`), fullPage: true })
} catch (e) {
  failed += 1
  log('EXCEPTION', e?.message || String(e))
} finally {
  try { if (browser) await browser.close() } catch { /* */ }
  killOwnTree()
  cleanupIsolated(work.dir); cleanupIsolated(voiceA.dir); cleanupIsolated(voiceB.dir)
  // 실패 로그는 덮지 않는다 — 실행마다 다른 이름으로 남긴다.
  const tag = failed === 0 ? 'ok' : 'FAIL'
  fs.writeFileSync(path.join(OUT, `race-${STAMP}-${tag}.txt`),
    `${logLines.join(String.fromCharCode(10))}${String.fromCharCode(10)}${String.fromCharCode(10)}--- child ---${String.fromCharCode(10)}${childLog.join(String.fromCharCode(10))}`,
    'utf-8')
}
log(failed === 0 ? '전부 통과' : `실패 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
