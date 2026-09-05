// 합성 화면 `한 명 | 여러 명` 재정리 — 개발 앱(npm run dev, 격리 userData, CDP) 실제 화면 확인 1회.
// 실행: node test/e2e/tts-synth-tabs-dev.e2e.mjs        (GPU·음성 생성 없음. 참조 준비(분석·구간 자동 확정)만 돈다)
// 확인: 합성 메뉴 아래 전체 폭 탭 / 한 명 = 목소리+대사 한 칸 / 여러 명 = 단일 목소리 영역 없음 / 준비 완료 후·준비 도중 전환 시
//       첫 인물이 기본 목소리(확정 구간 포함)를 이어받음 / 같은 음성 재등록·재확정 요구 없음 / 대화 추가 하나(기존·새) / 취소 무변경 /
//       같은 인물 카드 목소리 공유 / 탭 전환 무손실 / 좁은 창 겹침·넘침 0. 화면 캡처 4장을 _local 진단 폴더에 남긴다.
import { spawn, execFileSync } from 'child_process'
import { chromium } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isolatedInput, cleanupIsolated } from './_e2e-helper.mjs'

const APP = process.cwd()
const SHOTS = path.join(APP, '_local', 'artifacts', 'diagnostics', 'ux-redesign-20260905', 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
// 18초 실제 발화 fixture(저장소 테스트 자산) — 10초를 넘어 기본 목소리가 **구간 클립**을 쓰는, 첨부 화면과 같은 상황.
const FIX = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav')
const iso1 = isolatedInput(FIX)
const iso2 = isolatedInput(FIX)
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'af-tabs-'))
const PORT = 9800 + (process.pid % 150)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const ok = (id, pass, what, detail = '') => { results.push({ id, pass: !!pass, what, detail }); console.log(`[tabs] ${pass ? 'PASS' : 'FAIL'} ${id} ${what}${detail ? ' — ' + detail : ''}`) }

const childLog = []
const child = spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
  cwd: APP, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: USER_DATA, AF_E2E_CDP_PORT: String(PORT) },
})
const pushLog = (s) => { for (const l of String(s).split(/\r?\n/)) if (l.trim()) childLog.push(l) }
child.stdout.setEncoding('utf-8'); child.stdout.on('data', pushLog)
child.stderr.setEncoding('utf-8'); child.stderr.on('data', pushLog)
let childExited = false
child.on('exit', () => { childExited = true })
const killOwnTree = () => { if (childExited || !child.pid) return; try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* */ } }
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
  ok('boot', up.ok, 'npm run dev 로 앱이 뜬다', up.ok ? `${up.ms}ms` : `${up.reason} ${childLog.slice(-4).join(' / ')}`)
  if (!up.ok) throw new Error(up.reason)
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  let page = null
  for (let i = 0; i < 60 && !page; i += 1) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) { if (await p.evaluate(() => !!window.api).catch(() => false)) { page = p; break } }
    if (!page) await sleep(500)
  }
  if (!page) throw new Error('NO_PAGE')
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.api?.audio?.process, null, { timeout: 60000 })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false })

  // ── 도우미 ──────────────────────────────────────────────────────────────
  const st = (fn, arg) => page.evaluate(fn, arg)
  const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel)
  const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel)
  const waitUntil = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(200) } return false }
  const tab = async (t) => { await page.click(`[data-testid="dialogue-tabs"] [data-tab="${t}"]`); await sleep(150) }
  const store = () => st(() => { const s = window.__afStore.getState(); return { text: s.ttsText, mode: s.ttsSpeakerMode, refReady: s.ttsRefReady, refClip: s.ttsReferenceClip, refRegion: s.ttsReferenceRegion, refMsg: s.ttsRefMessage, refs: s.ttsSpeakerRefState, labels: s.ttsSpeakerLabels, inherit: s.ttsSpeakerInherit } })
  const loadFile = (p) => page.evaluate(async (fp) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(fp), await window.api.audio.getFileUrl(fp))
    s.getState().setMode('tts')
  }, p)
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, name), fullPage: true })
  const cardVoices = () => st(() => [...document.querySelectorAll('[data-testid="dialogue-row"] [data-testid="card-voice"], [data-testid="starter-card"] [data-testid="card-voice"]')].map((b) => b.textContent.trim()))
  const typeInto = async (sel, value) => {
    await page.click(sel); await page.fill(sel, value)
  }
  const RAW = 'section[aria-label="대사"] div[data-af-tts-editor] textarea'

  // ── 시나리오 1: 파일 불러오기 → 한 명(기본) → 기본 목소리 준비(구간 자동 확정) → 여러 명 전환 ──
  await loadFile(iso1.input)
  await page.waitForSelector('[data-testid="dialogue-tabs"]', { timeout: 60000 })
  const tabsN = await count('[data-testid="dialogue-tabs"]')
  const geo = await st(() => {
    const tabs = document.querySelector('[data-testid="dialogue-tabs"]')?.getBoundingClientRect()
    const parent = document.querySelector('[data-testid="dialogue-tabs"]')?.parentElement?.getBoundingClientRect()
    const voice = document.querySelector('section[aria-label="목소리"]')?.getBoundingClientRect()
    const inHeader = !!document.querySelector('section[aria-label="대사"] header [data-testid="dialogue-tabs"]')
    return { tabsW: tabs?.width, parentW: parent?.width, tabsTop: tabs?.top, voiceTop: voice?.top, inHeader }
  })
  ok('1', tabsN === 1 && !geo.inHeader && geo.tabsW && Math.abs(geo.tabsW - geo.parentW) < 2 && geo.tabsTop < geo.voiceTop,
    '전체 폭 한 명|여러 명 탭 1개가 목소리 영역 위에 있고, 대사 옆 중복 탭 없음', JSON.stringify(geo))
  const single = await st(() => ({ voice: document.querySelectorAll('section[aria-label="목소리"]').length, textareas: document.querySelectorAll('section[aria-label="대사"] textarea').length,
    multi: document.querySelectorAll('[data-testid="multi-dialogue"],[data-testid="dialogue-row"],[data-testid="starter-card"],[data-testid="common-options"],[data-testid="default-voice-driver"]').length,
    n2: document.querySelector('section[aria-label="대사"] header span[aria-hidden]')?.textContent, n3: document.querySelector('section[aria-label="말하는 느낌"] header span[aria-hidden]')?.textContent }))
  ok('2', (await store()).mode === 'single' && single.voice === 1 && single.textareas === 1 && single.multi === 0 && single.n2 === '2' && single.n3 === '3',
    '한 명: 목소리 설정 1 + 대사 한 칸, 여러 명 요소 0, 번호 1·2·3', JSON.stringify(single))
  // 기본 목소리 준비 — 18초 원본은 구간 자동 확정(참조 전사 검증 포함)까지 간다.
  const readyOnce = await waitUntil(async () => { const s = await store(); return s.refReady === true && !!s.refClip }, 150000)
  const s1 = await store()
  ok('3', readyOnce, '기본 목소리 준비됨(구간 클립 확정)', `ready=${s1.refReady} clip=${!!s1.refClip} region=${JSON.stringify(s1.refRegion)} msg=${s1.refMsg}`)
  await shot('1-single.png')

  await tab('multi')
  const multiDom = await st(() => ({ voice: document.querySelectorAll('section[aria-label="목소리"]').length, starter: document.querySelectorAll('[data-testid="starter-card"]').length,
    common: document.querySelectorAll('[data-testid="common-options"]').length, driver: document.querySelectorAll('[data-testid="default-voice-driver"]').length,
    palette: document.querySelectorAll('[aria-label="감정 태그 팔레트"]').length, raw: document.querySelectorAll('section[aria-label="인물과 대사"] div[data-af-tts-editor] textarea').length,
    n1: document.querySelector('section[aria-label="인물과 대사"] header span[aria-hidden]')?.textContent, n2: document.querySelector('section[aria-label="말하는 느낌"] header span[aria-hidden]')?.textContent,
    addBtns: [...document.querySelectorAll('[data-testid="multi-dialogue"] button')].filter((b) => b.textContent.includes('대화 추가')).length,
    oldAdd: document.querySelectorAll('#dlg-new-speaker, #dlg-new-line, [data-testid="starter-add"]').length }))
  ok('4', (await store()).mode === 'multi' && multiDom.voice === 0 && multiDom.starter === 1 && multiDom.common === 1 && multiDom.driver === 1 && multiDom.palette === 0 && multiDom.raw === 0
    && multiDom.n1 === '1' && multiDom.n2 === '2' && multiDom.addBtns === 1 && multiDom.oldAdd === 0,
    '여러 명: 단일 목소리 영역 0, 인물1 시작 카드 1, 공통 옵션 1, 상단 감정 버튼 0, 원문 편집기 접힘, 번호 1·2, 대화 추가 버튼 1', JSON.stringify(multiDom))
  // 첫 인물이 기본 목소리의 확정 구간을 이어받는다(재선택·재확정 없음).
  const inherited = await waitUntil(async () => { const s = await store(); const r = s.refs['인물1']; return !!r && r.ready === true && !!r.clip && r.clip !== s.refClip }, 20000)
  const s2 = await store()
  const r1 = s2.refs['인물1']
  ok('5', inherited && r1 && r1.region && s2.refRegion && Math.abs(r1.region.start - s2.refRegion.start) < 1e-6 && Math.abs(r1.region.duration - s2.refRegion.duration) < 1e-6 && s2.inherit === null
    && (await cardVoices())[0]?.includes('준비됨'),
    '준비 완료 후 전환: 인물1 = 기본 목소리의 원본·확정 구간(복사된 클립) 이어받음, 카드 준비됨', JSON.stringify({ card: (await cardVoices())[0], region: r1?.region, ownClip: !!r1?.clip && r1.clip !== s2.refClip, inherit: s2.inherit }))
  await shot('2-multi-first-card.png')

  // 카드 안 목소리 상세 열기 → 재확정 요구 없음(준비 유지), 구간 수정은 접혀 있다가 펼치면 파형.
  await page.click('[data-testid="starter-card"] [data-testid="card-voice"]')
  const panelIn = await waitUntil(async () => (await count('[data-testid="starter-card"] [data-testid="voice-panel"]')) === 1, 5000)
  await sleep(2500)
  const afterOpen = await store()
  const noReconfirm = afterOpen.refs['인물1']?.ready === true && (await count('[data-testid="speaker-voice-reason"]')) === 0
  const regionTools = await count('[data-testid="voice-panel"] input[type="range"]')
  await page.click('[data-testid="voice-region-toggle"]')
  const waveform = await waitUntil(async () => (await count('[data-testid="voice-panel"] input[type="range"]')) >= 2, 20000)
  ok('6', panelIn && noReconfirm && regionTools === 0 && waveform, '카드 안 상세: 준비 유지(재확정 요구 없음), 구간 수정은 접혀 있다가 펼치면 원본 파형·슬라이더', JSON.stringify({ panelIn, noReconfirm, regionToolsClosed: regionTools, waveform }))
  await shot('4-card-voice-region.png')
  const stillReady = await waitUntil(async () => (await store()).refs['인물1']?.ready === true, 3000)
  ok('6b', stillReady && (await cardVoices())[0]?.includes('준비됨'), '구간 편집기를 펼쳐도(재분석) 준비 유지', (await cardVoices())[0])
  await page.click('[data-testid="voice-panel-close"]'); await sleep(150)

  // 첫 대사는 시작 카드에 바로 — blur 로 반영(별도 추가 버튼 없음).
  await typeInto('[data-testid="starter-card"] [data-testid="starter-line"]', '첫 번째 대사입니다')
  await page.keyboard.press('Tab')
  const rows1 = await waitUntil(async () => (await count('[data-testid="dialogue-row"]')) === 1 && (await count('[data-testid="starter-card"]')) === 0, 15000)
  const t1 = (await store()).text
  ok('7', rows1 && t1 === '[화자 인물1]\n첫 번째 대사입니다' && (await store()).refs['인물1']?.ready === true, '시작 카드 첫 대사 → 카드 1개(원문 반영), 인물1 준비 유지', JSON.stringify(t1))

  // + 대화 추가(하나) → 기존 인물: 준비된 목소리 재사용, 빈 카드에 포커스 → 대사 → 반영
  await page.click('[data-testid="dialogue-add-open"]')
  const dlg = await waitUntil(async () => (await count('[data-testid="dialogue-add-dialog"]')) === 1, 3000)
  await shot('3-add-dialog.png')
  await page.click('[data-testid="dialogue-add-done"]')
  const pendingFocused = await waitUntil(async () => st(() => document.activeElement?.getAttribute('data-testid') === 'pending-line'), 3000)
  await page.keyboard.type('두 번째 대사입니다')
  await page.keyboard.press('Tab')
  const rows2 = await waitUntil(async () => (await count('[data-testid="dialogue-row"]')) === 2, 15000)
  ok('8', dlg && pendingFocused && rows2 && (await store()).text.endsWith('두 번째 대사입니다') && (await count('[data-testid="dialogue-add-dialog"]')) === 0,
    '대화 추가 → 기존 인물 → 카드에 포커스 → 대사 입력으로 반영(설정 창에 대사 칸 없음)', JSON.stringify((await store()).text))
  // 같은 인물의 두 카드 = 같은 목소리 상태
  const cv = await cardVoices()
  ok('9', cv.length === 2 && cv[0] === cv[1] && cv[0].includes('준비됨'), '같은 인물의 반복 카드가 같은 목소리(준비됨·같은 구간)', JSON.stringify(cv))

  // 새 인물 추가: 이름만 → 시작 카드 → 대사 → 반영. 첫 음성이 자동 대체되지 않는다(목소리 선택 필요).
  await page.click('[data-testid="dialogue-add-open"]')
  await page.click('[data-testid="dialogue-add-dialog"] input[type="radio"]:nth-of-type(1)').catch(() => {})
  await page.getByLabel('새 인물').check()
  await page.fill('[data-testid="dialogue-add-name"]', '인물2')
  await page.click('[data-testid="dialogue-add-done"]')
  const starter2 = await waitUntil(async () => (await count('[data-testid="starter-card"]')) === 1, 3000)
  const starter2Voice = await text('[data-testid="starter-card"] [data-testid="card-voice"]')
  await typeInto('[data-testid="starter-card"] [data-testid="starter-line"]', '인물2의 대사')
  await page.keyboard.press('Tab')
  const rows3 = await waitUntil(async () => (await count('[data-testid="dialogue-row"]')) === 3, 15000)
  const s3 = await store()
  ok('10', starter2 && starter2Voice?.includes('목소리 선택 필요') && rows3 && s3.text.includes('[화자 인물2]\n인물2의 대사') && !s3.refs['인물2'],
    '새 인물 추가 → 이름 카드 → 대사 반영. 2번 인물에게 첫 음성 자동 대체 없음', JSON.stringify({ starter2Voice, refs: Object.keys(s3.refs) }))

  // 취소 = 무변경(원문·인물·목소리)
  const before = JSON.stringify(await store())
  await page.click('[data-testid="dialogue-add-open"]')
  await page.getByLabel('새 인물').check()
  await page.fill('[data-testid="dialogue-add-name"]', '취소인물')
  await page.click('[data-testid="dialogue-add-cancel"]')
  await sleep(200)
  ok('11', JSON.stringify(await store()) === before && (await count('[data-testid="starter-card"]')) === 0 && (await count('[data-testid="dialogue-add-dialog"]')) === 0, '취소 시 원문·인물·목소리 무변경')

  // 탭 왕복 — 원문·인물·목소리 그대로, 카드 재생성 없음(첫 인물 슬롯 그대로)
  const snap0 = JSON.stringify(await store())
  for (let i = 0; i < 5; i += 1) { await tab('single'); await tab('multi') }
  await sleep(300)
  const snap1 = JSON.stringify(await store())
  ok('12', snap1 === snap0 && (await count('[data-testid="dialogue-row"]')) === 3, '탭 10회 전환 후 원문·목소리 지정·이름 동일, 카드 3개', snap1 === snap0 ? '' : `before=${snap0.slice(0, 400)} after=${snap1.slice(0, 400)}`)
  await tab('single')
  const singleAgain = await st(() => ({ voice: document.querySelectorAll('section[aria-label="목소리"]').length, raw: document.querySelectorAll('section[aria-label="대사"] div[data-af-tts-editor] textarea').length, cards: document.querySelectorAll('[data-testid="dialogue-row"]').length }))
  const s13 = await store()
  ok('13', singleAgain.voice === 1 && singleAgain.raw === 1 && singleAgain.cards === 0 && s13.refReady === true, '한 명으로 돌아오면 목소리 섹션·원문 편집기, 기본 목소리 준비 유지', JSON.stringify({ ...singleAgain, refReady: s13.refReady, refMsg: s13.refMsg }))
  await tab('multi')

  // 좁은 창: 가로 넘침·겹침·세로로 쪼개진 버튼 0 (1100 / 720 / 560)
  const layoutCheck = async () => page.evaluate(() => {
    const root = document.querySelector('section[aria-label="인물과 대사"]')
    const btns = [...document.querySelectorAll('[data-testid="dialogue-tabs"] button, [data-testid="multi-dialogue"] button, [data-testid="common-options"] button')]
    const tall = btns.filter((b) => b.getBoundingClientRect().height > 44).length
    const clipped = btns.filter((b) => b.scrollWidth > b.clientWidth + 1).length
    const rows = [...document.querySelectorAll('[data-testid="dialogue-row"]')].map((r) => r.getBoundingClientRect())
    let overlaps = 0
    for (let i = 1; i < rows.length; i += 1) if (rows[i].top < rows[i - 1].bottom - 1) overlaps += 1
    return { overflow: root ? root.scrollWidth - root.clientWidth : -1, tall, clipped, overlaps, docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }
  })
  const lay = {}
  for (const w of [1100, 720, 560]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(300)
    lay[w] = await layoutCheck()
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(200)
  ok('14', Object.values(lay).every((l) => l.overflow <= 0 && l.docOverflow <= 0 && l.tall === 0 && l.clipped === 0 && l.overlaps === 0), '1100·720·560 폭: 가로 넘침 0, 쪼개진 버튼 0, 카드 겹침 0', JSON.stringify(lay))

  // ── 시나리오 2: 준비 **도중** 여러 명으로 전환 → 완료 결과가 첫 인물에 연결 ──
  await loadFile(iso2.input)
  await page.waitForSelector('[data-testid="dialogue-tabs"]', { timeout: 60000 })
  await tab('multi')
  const midState = await store()
  const midReady = midState.refReady
  const laterReady = await waitUntil(async () => { const s = await store(); const r = s.refs['인물1']; return s.refReady === true && !!r && r.ready === true && !!r.clip && r.clip !== s.refClip }, 150000)
  const s4 = await store()
  ok('15', laterReady && s4.inherit === null && (await cardVoices())[0]?.includes('준비됨'),
    `준비 도중 전환(전환 시 준비=${midReady}) → 완료 시 인물1이 같은 결과(확정 구간 클립 복사) 이어받음`, JSON.stringify({ card: (await cardVoices())[0], region: s4.refs['인물1']?.region }))
  // 새 파일 = 새 작업: 이전 인물 슬롯이 비고 첫 인물만 다시 연결(2번 인물 자동 없음)
  ok('16', Object.keys(s4.refs).length === 1, '새 파일 불러오기 뒤 인물 슬롯은 첫 인물 하나', JSON.stringify(Object.keys(s4.refs)))

  ok('err', pageErrors.length === 0, 'renderer 페이지 오류 0', pageErrors.slice(0, 3).join(' | '))
} catch (e) {
  ok('fatal', false, '치명 오류', String(e?.stack || e?.message || e))
} finally {
  try { await browser?.close() } catch { /* */ }
  killOwnTree()
  for (let i = 0; i < 40 && !childExited; i += 1) await sleep(250)
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* */ }
  cleanupIsolated(iso1.dir); cleanupIsolated(iso2.dir)
  const fails = results.filter((r) => !r.pass).length
  fs.writeFileSync(path.join(SHOTS, '..', 'results.json'), JSON.stringify(results, null, 1))
  console.log(`[tabs] SUMMARY pass=${results.length - fails} fail=${fails} childExited=${childExited} shots=${fs.readdirSync(SHOTS).join(',')}`)
  process.exit(fails ? 1 : 0)
}
