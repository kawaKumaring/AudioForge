// 편의성 수정 3건을 실제 화면에서 1회 확인 — 개발 앱(npm run dev, 격리 userData, CDP).
// 실행: node test/e2e/tts-convenience-dev.e2e.mjs      (GPU·음성 생성 없음. 참조 분석·구간 자동 확정만 돈다)
//
// 확인하는 것
//  A 이름을 비워도 새 인물의 목소리를 지정할 수 있다(자동 이름 인물A). 완료하면 그 이름으로 카드가 생긴다.
//  B 목소리 파일을 고르면 카드를 열지 않아도 **준비됨까지 저절로 간다**(자동 준비 드라이버가 스스로
//    사라지던 결함의 회귀 가드). 18초 fixture 라 구간 자동 확정 경로를 실제로 지난다.
//  C 구간 편집기에 숫자 입력이 있고, 고급 설정 '엔진·진단'에 설치된 음성 모델 판 선택이 뜬다.
//
// 자산은 저장소 fixture 만 쓰고 격리 폴더로 복사해 주입한다(사용자 resources/ 미접촉).
import { spawn, execFileSync } from 'child_process'
import { chromium } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isolatedInput, cleanupIsolated } from './_e2e-helper.mjs'

const APP = process.cwd()
const OUT = path.join(APP, '_local', 'artifacts', 'diagnostics', 'convenience-20260908')
fs.mkdirSync(OUT, { recursive: true })
const FIX = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav')
if (!fs.existsSync(FIX)) { console.error('fixture 없음:', FIX); process.exit(2) }
const iso = isolatedInput(FIX)
// 첫 인물에게 **다른 파일**을 지정하는 실제 사례를 재현하려면 경로가 달라야 한다(내용은 같아도 된다).
const iso2 = isolatedInput(FIX)
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'af-conv-'))
const PORT = 9600 + (process.pid % 150)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const ok = (id, pass, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail })
  console.log(`[conv] ${pass ? 'PASS' : 'FAIL'} ${id} ${what}${detail ? ' — ' + detail : ''}`)
}

const childLog = []
const child = spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
  cwd: APP, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: USER_DATA, AF_E2E_CDP_PORT: String(PORT),
    // '목소리 지정' 버튼이 열던 OS 선택창만 이 파일로 대신한다(나머지는 실제 경로 그대로).
    AF_E2E_SELECT_FILE: iso2.input },
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
  ok('boot', up.ok, 'npm run dev 로 앱이 뜬다', up.ok ? `${up.ms}ms` : `${up.reason} ${childLog.slice(-4).join(' / ')}`)
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
  const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel)
  const waitUntil = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(250) } return false }
  const shot = (name) => page.screenshot({ path: path.join(OUT, name), fullPage: true })

  // 파일 불러오기 → 여러 명
  await st(async (fp) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(fp), await window.api.audio.getFileUrl(fp))
    s.getState().setMode('tts')
  }, iso.input)
  await page.waitForSelector('[data-testid="dialogue-tabs"]', { timeout: 60000 })
  await page.click('[data-testid="dialogue-tabs"] [data-tab="multi"]')
  await sleep(300)

  // ── D: 사용자가 실제로 겪은 경로를 그대로 — **추가 창에서 목소리 지정 버튼을 누른다** ──────
  // 앞선 검사는 store 를 직접 불러 통과했지만 사용자 화면에서는 멈췄다. 그래서 여기서는 화면의 버튼을
  // 누르고, OS 파일 선택창만 대신한다(그것만이 e2e 로 누를 수 없는 부분이다).
  // 타이밍도 사용자와 같게 둔다 — 기본 목소리 준비가 끝나기 전에, 추가 창을 열어 둔 상태로 지정한다.
  const seam = await st(async () => String((await window.api.audio.selectFile()) || ''))
  ok('D0', seam !== '', '파일 선택창만 대신하고 나머지는 실제 화면 경로로 검사한다', seam ? '통로 연결' : '통로 없음')

  await page.click('[data-testid="dialogue-add-open"]')
  await page.waitForSelector('[data-testid="dialogue-add-dialog"]', { timeout: 10000 })
  if (await count('[data-testid="dialogue-add-name"]') === 0) {
    const radios0 = await page.$$('input[name="dlg-add-mode"]')
    if (radios0[1]) await radios0[1].click()
    await sleep(200)
  }
  const beforePick = await st(() => ({
    refReady: window.__afStore.getState().ttsRefReady,
    inherit: window.__afStore.getState().ttsSpeakerInherit?.speakerId || null,
  }))
  await page.click('[data-testid="dialogue-add-voice"]')      // 실제 '목소리 지정' 버튼
  await sleep(500)
  const picked = await st((src) => {
    const s = window.__afStore.getState()
    const hit = Object.entries(s.ttsSpeakerRefState).find(([, v]) => v?.source === src)
    return hit ? { id: hit[0], slot: hit[1] } : null
  }, iso2.input)
  ok('D1', !!picked, '버튼으로 고른 목소리가 그 인물에 등록된다',
    `id=${picked?.id} ready=${picked?.slot?.ready} before(refReady=${beforePick.refReady}, inherit=${beforePick.inherit})`)

  // 추가 창을 **열어 둔 채로** 준비가 끝나는지 본다(사용자 화면 1번과 같은 상태).
  const dlgReady = picked ? await waitUntil(async () => {
    const s = await st((id) => window.__afStore.getState().ttsSpeakerRefState[id] || null, picked.id)
    return !!(s && s.ready)
  }, 180000) : false
  const dlgSlot = picked ? await st((id) => window.__afStore.getState().ttsSpeakerRefState[id] || null, picked.id) : null
  ok('D2', dlgReady, '추가 창을 열어 둔 상태에서도 준비됨까지 저절로 간다',
    `ready=${dlgSlot?.ready} clip=${!!dlgSlot?.clip} region=${JSON.stringify(dlgSlot?.region)} msg=${dlgSlot?.message || ''}`)
  const dlgText = await st(() => document.querySelector('[data-testid="dialogue-add-dialog"]')?.textContent || '')
  ok('D3', dlgReady && !dlgText.includes('목소리 확인 중'),
    "추가 창에 '목소리 확인 중'이 남지 않는다", dlgText.includes('목소리 확인 중') ? '문구 잔존' : '없음')
  await shot('D-add-dialog-assigned.png')
  await page.click('[data-testid="dialogue-add-cancel"]')
  await sleep(300)

  // ── A: 이름을 비워도 목소리를 지정할 수 있다 ──────────────────────────
  await page.click('[data-testid="dialogue-add-open"]')
  await page.waitForSelector('[data-testid="dialogue-add-dialog"]', { timeout: 10000 })
  const newRadio = await page.$('input[name="dlg-add-mode"]:not([disabled])')
  // 기존 인물이 있으면 '새 인물'로 바꿔야 이름 칸이 나온다.
  if (await count('[data-testid="dialogue-add-name"]') === 0) {
    const radios = await page.$$('input[name="dlg-add-mode"]')
    if (radios[1]) await radios[1].click()
    await sleep(200)
  }
  void newRadio
  const addState = await st(() => {
    const name = document.querySelector('[data-testid="dialogue-add-name"]')
    const voice = document.querySelector('[data-testid="dialogue-add-voice"]')
    const done = document.querySelector('[data-testid="dialogue-add-done"]')
    return {
      value: name?.value ?? null, placeholder: name?.getAttribute('placeholder') ?? null,
      voiceDisabled: voice?.hasAttribute('disabled') ?? null,
      doneDisabled: done?.hasAttribute('disabled') ?? null,
      hint: document.querySelector('[data-testid="dialogue-add-dialog"]')?.textContent?.includes('비워 두면') ?? false,
    }
  })
  ok('A1', addState.value === '' && /^인물[A-Z]$/.test(addState.placeholder || '')
    && addState.voiceDisabled === false && addState.doneDisabled === false && addState.hint,
    '이름이 비어도 목소리 지정·완료가 열려 있고 자동 이름을 보여 준다', JSON.stringify(addState))
  await shot('A-add-empty-name.png')

  await page.click('[data-testid="dialogue-add-done"]')
  await sleep(400)
  const madeLabel = addState.placeholder
  const labels = await st(() => [...document.querySelectorAll('[data-testid="dialogue-row"] input[id^="spk-name-"], [data-testid="starter-card"] input[id^="spk-name-"]')].map((i) => i.value))
  ok('A2', labels.includes(madeLabel), `완료하면 ${madeLabel} 카드가 생긴다`, JSON.stringify(labels))

  // ── B: 목소리 파일을 고르면 카드를 열지 않아도 준비됨까지 간다 ────────
  // 파일 선택 대화상자는 e2e 로 누를 수 없으므로, 그 버튼이 하는 일(참조 등록)만 store 로 부른다.
  const speakerId = await st((label) => {
    const s = window.__afStore.getState()
    const ids = Object.keys(s.ttsSpeakerRefState)
    const norm = (x) => x.trim()
    void norm
    // 카드가 만든 인물 id 를 찾는다. 이름 정규화는 앱이 소유하므로 라벨 맵에서 되찾는다.
    const hit = Object.entries(s.ttsSpeakerLabels || {}).find(([, v]) => v === label)
    return hit ? hit[0] : (ids[0] || '')
  }, madeLabel)
  const regId = speakerId || 'spk_auto'
  await st(({ id, label, src }) => {
    window.__afStore.getState().registerSpeakerRef(id, src, label)
  }, { id: regId, label: madeLabel, src: iso.input })
  const prepared = await waitUntil(async () => {
    const s = await st((id) => window.__afStore.getState().ttsSpeakerRefState[id] || null, regId)
    return !!(s && s.ready)
  }, 180000)
  const finalState = await st((id) => window.__afStore.getState().ttsSpeakerRefState[id] || null, regId)
  ok('B1', prepared,
    '카드를 열지 않아도 목소리 준비가 준비됨까지 저절로 끝난다',
    `ready=${finalState?.ready} clip=${!!finalState?.clip} region=${JSON.stringify(finalState?.region)} msg=${finalState?.message || ''}`)
  const cardText = await st(() => document.querySelector('[data-testid="multi-dialogue"]')?.textContent || '')
  ok('B2', prepared && !cardText.includes('목소리 확인 중'),
    "카드에 '목소리 확인 중'이 남지 않는다", cardText.includes('목소리 확인 중') ? '문구 잔존' : '없음')
  await shot('B-auto-prepared.png')

  // ── C: 구간 숫자 입력 + 모델 판 선택 ──────────────────────────────────
  const openedRegion = await st(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '목소리 설정')
      || [...document.querySelectorAll('[data-testid="card-voice"]')][0]
    if (btn) { btn.click(); return true }
    return false
  })
  await sleep(600)
  if (openedRegion) {
    const toggle = await page.$('[data-testid="voice-region-toggle"]')
    if (toggle) { await toggle.click(); await sleep(1200) }
  }
  const nums = await st(() => ({
    start: document.querySelectorAll('[data-testid="region-start-number"]').length,
    dur: document.querySelectorAll('[data-testid="region-dur-number"]').length,
  }))
  ok('C1', nums.start >= 1 && nums.dur >= 1, '구간 편집기에 시작·길이 숫자 입력이 있다', JSON.stringify(nums))
  if (nums.start >= 1) await shot('C-region-numbers.png')

  // 고급 설정 > 엔진·진단
  await st(() => {
    const btn = [...document.querySelectorAll('section[aria-label="고급 설정"] button')].find((b) => b.textContent.trim() === '열기')
    if (btn) btn.click()
  })
  await sleep(300)
  await st(() => {
    const t = document.querySelector('#tts-advanced-tab-engine')
    if (t) t.click()
  })
  await sleep(1500)
  const picker = await st(() => {
    const box = document.querySelector('[data-testid="qwen-model-picker"]')
    const sel = box?.querySelector('select')
    return {
      present: !!box,
      options: sel ? [...sel.options].map((o) => o.textContent) : [],
      value: sel?.value ?? null,
    }
  })
  ok('C2', picker.present && picker.options.length >= 1,
    '엔진·진단에 설치된 음성 모델 판 선택이 뜬다', JSON.stringify(picker))
  if (picker.present) await shot('C-model-picker.png')

  // C2b. 참조 목표 길이 조절 — 자동 추천이 노리는 길이를 사용자가 올릴 수 있어야 한다.
  // 모양 검사로는 '화면에 실제로 붙었는지' 를 알 수 없다(이번 회차에 세 번 겪었다). 여기서 만진다.
  const target = await st(() => {
    const box = document.querySelector('[data-testid="ref-target-length"]')
    const r = box?.querySelector('input[type="range"]')
    if (!r) return { present: false }
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(r, '20')
    r.dispatchEvent(new Event('input', { bubbles: true }))
    r.dispatchEvent(new Event('change', { bubbles: true }))
    return { present: true, max: r.max, text: box.innerText.slice(0, 60) }
  })
  await sleep(500)
  const stored = await st(() => window.__afStore?.getState().ttsRefTargetSec)
  ok('C2b', target.present && target.max === '30' && stored === 20,
    '참조 목표 길이를 30초까지 올릴 수 있고 값이 설정에 남는다',
    JSON.stringify({ ...target, stored }))
  // 원래대로 되돌린다 — 이 검사가 뒤 검사의 전제를 바꾸지 않게.
  await st(() => {
    const r = document.querySelector('[data-testid="ref-target-length"] input[type="range"]')
    if (!r) return
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(r, '0')
    r.dispatchEvent(new Event('input', { bubbles: true }))
    r.dispatchEvent(new Event('change', { bubbles: true }))
  })

  // 음성 탭 정리 — 접힌 자리들이 있고 참조 전사는 접히지 않았다.
  await st(() => { const t = document.querySelector('#tts-advanced-tab-voice'); if (t) t.click() })
  await sleep(400)
  const voiceTab = await st(() => ({
    emotion: document.querySelectorAll('[data-testid="emotion-voice-section"]').length,
    library: document.querySelectorAll('[data-testid="ref-library-section"]').length,
    collapsed: [...document.querySelectorAll('[data-testid="emotion-voice-section"], [data-testid="ref-library-section"]')].every((d) => !d.open),
    transcript: document.querySelectorAll('#tts-reference-transcript').length,
  }))
  ok('C3', voiceTab.emotion === 1 && voiceTab.library === 1 && voiceTab.collapsed && voiceTab.transcript === 1,
    '음성 탭: 보조 항목은 접혀 있고 참조 전사 자리는 그대로 있다', JSON.stringify(voiceTab))
  await shot('C-voice-tab.png')

  // ── E: 준비가 멈춰도 한 번에 되살릴 입구가 있다 ──────────────────────
  // 준비되지 않은 목소리에는 '다시 준비'가 뜨고, 준비된 뒤에는 사라진다.
  const retryWhenReady = await count('[data-testid="card-voice-retry"]')
  ok('E1', retryWhenReady === 0, '준비가 끝난 목소리에는 다시 준비 버튼이 없다', `버튼 ${retryWhenReady}개`)
  const retryShown = await st((id) => {
    const s = window.__afStore.getState()
    s.setSpeakerRefState(id, { clip: '', region: null, ready: false, message: '목소리를 살펴보는 중입니다…' })
    return true
  }, regId)
  void retryShown
  await sleep(400)
  const retryUi = await st(() => ({
    buttons: document.querySelectorAll('[data-testid="card-voice-retry"]').length,
    status: [...document.querySelectorAll('[data-testid="card-voice-status"]')].map((e) => e.textContent?.trim()),
  }))
  ok('E2', retryUi.buttons >= 1 && retryUi.status.some((s) => (s || '').includes('살펴보는 중')),
    '준비 중이면 다시 준비 버튼이 뜨고 상태 문구가 무엇을 기다리는지 말한다', JSON.stringify(retryUi))
  await shot('E-retry-entry.png')

  // ── F: 파이썬 호출 수 — 같은 파일을 몇 번 다시 살펴보고 다시 잘랐는가 ──────────
  // 분석·자르기에는 결과 저장이 없었다. 패널이 다시 마운트되기만 해도 같은 파일을 다시 분석했고,
  // 같은 구간을 다시 확정하면 whisper 전사까지 다시 돌았다(자르기 한 번이 2~3초).
  const spawnCount = (kind) => childLog.filter((l) => l.includes(`audioforge_${kind}_`)).length
  const calls = { analyze: spawnCount('refanalyze'), trim: spawnCount('reftrim') }
  console.log(`[conv] 파이썬 호출 — 살펴보기 ${calls.analyze}회 · 자르기 ${calls.trim}회`)
  // 이 시나리오의 서로 다른 (인물|파일) 조합은 넷이다: 기본 목소리 · 인물a(다른 파일) · 인물A · 인물1.
  // 즉 위 숫자에는 중복이 없다 — 캐시가 줄일 것이 없는 상태다. 그래서 아래에서 **같은 조합을
  // 두 번 마운트**해 캐시가 실제로 듣는지 따로 본다(줄었다고 말하려면 반복을 만들어 재야 한다).
  ok('F1', calls.trim <= 4, '같은 구간을 반복해서 자르지 않는다', JSON.stringify(calls))

  // ── G: 같은 (인물|파일)을 다시 열면 파이썬을 다시 부르지 않는다 ────────────
  // 패널을 닫았다 다시 열면 마운트가 새로 생기고 예전에는 그때마다 다시 분석했다.
  const before = { analyze: spawnCount('refanalyze'), trim: spawnCount('reftrim') }
  const toggled = await st(() => {
    const btns = [...document.querySelectorAll('[data-testid="card-voice"]')]
    if (btns.length === 0) return false
    btns[0].click()                                  // 열려 있으면 닫고
    return true
  })
  await sleep(400)
  if (toggled) {
    await st(() => { const b = document.querySelector('[data-testid="card-voice"]'); if (b) b.click() })
    await sleep(3000)                                // 다시 열었다 — 예전이면 여기서 분석이 돈다
  }
  const after = { analyze: spawnCount('refanalyze'), trim: spawnCount('reftrim') }
  ok('G1', toggled && after.analyze === before.analyze && after.trim === before.trim,
    '같은 목소리를 다시 열어도 살펴보기·자르기를 다시 하지 않는다',
    `전 ${JSON.stringify(before)} → 후 ${JSON.stringify(after)}`)

  ok('err', pageErrors.length === 0, '렌더러 예외 0', pageErrors.slice(0, 3).join(' / '))
} catch (e) {
  ok('fatal', false, '실행 중 예외', String(e?.message || e))
} finally {
  try { await browser?.close() } catch { /* */ }
  killOwnTree()
  for (let i = 0; i < 40 && !childExited; i += 1) await sleep(250)
  try { cleanupIsolated(iso) } catch { /* */ }
  try { cleanupIsolated(iso2) } catch { /* */ }
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* */ }
  const pass = results.filter((r) => r.pass).length
  fs.writeFileSync(path.join(OUT, 'result.json'),
    JSON.stringify({ pass, total: results.length, results }, null, 2), 'utf-8')
  console.log(`\n[conv] ${pass}/${results.length} 통과 · 기록 ${path.join(OUT, 'result.json')}`)
  process.exit(pass === results.length ? 0 : 1)
}
