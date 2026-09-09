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
// 세 번째 선택용 — **쓸 수 없는 파일**(0.5초 거의 무음). 교체 실패 경로를 실제로 지나게 한다.
// 파이썬·GPU 없이 만든다: 44바이트 헤더 + 무음 PCM.
const BAD = path.join(path.dirname(iso2.input), 'unusable-0p5s.wav')
;(() => {
  const sr = 24000, n = Math.round(sr * 0.5), bytes = n * 2
  const b = Buffer.alloc(44 + bytes)
  b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(bytes, 40)
  fs.writeFileSync(BAD, b)     // 표본은 전부 0 — '거의 무음' 으로 막혀야 한다
})()
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

  // C1b. 손을 댄 뒤 자동으로 찾은 구간으로 되돌아갈 수 있는가.
  // 예전에는 이 길이 없어서 목소리를 다시 등록해야 했다(사용자 지적).
  const setNum = (sel, v) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  const reset = await st((fnSrc) => {
    const setNum = eval('(' + fnSrc + ')')
    const btn = document.querySelector('[data-testid="region-reset-recommend"]')
    if (!btn) return { present: false }
    const before = {
      start: document.querySelector('[data-testid="region-start-number"]')?.value,
      dur: document.querySelector('[data-testid="region-dur-number"]')?.value,
      disabled: btn.disabled,          // 처음에는 추천 그대로라 눌러도 할 일이 없다
    }
    setNum('[data-testid="region-start-number"]', Number(before.start) + 3.5)
    setNum('[data-testid="region-dur-number"]', 4.5)
    return { present: true, before }
  }, setNum.toString())
  await sleep(400)
  const afterEdit = await st(() => ({
    start: document.querySelector('[data-testid="region-start-number"]')?.value,
    dur: document.querySelector('[data-testid="region-dur-number"]')?.value,
    enabled: !document.querySelector('[data-testid="region-reset-recommend"]')?.disabled,
  }))
  await st(() => document.querySelector('[data-testid="region-reset-recommend"]')?.click())
  await sleep(400)
  const afterReset = await st(() => ({
    start: document.querySelector('[data-testid="region-start-number"]')?.value,
    dur: document.querySelector('[data-testid="region-dur-number"]')?.value,
    disabled: document.querySelector('[data-testid="region-reset-recommend"]')?.disabled,
  }))
  // 처음 값이 곧 추천값인 것은 아니다 — 전에 확정해 둔 구간이 있으면 거기서 시작한다.
  // 그래서 '되돌리기 전 상태'가 아니라 **되돌린 뒤가 추천값인가**를 본다.
  const recommended = await st(() => {
    const el = document.querySelector('[data-testid="region-reset-recommend"]')
    // 버튼 설명에 목적지가 적혀 있다: "…구간(0.00~9.76초)으로 되돌립니다"
    const m = /\((\d+\.\d+)~(\d+\.\d+)초\)/.exec(el?.title || '')
    return m ? { start: m[1], end: m[2] } : null
  })
  ok('C1b',
    reset.present
      && afterEdit.enabled === true                          // 손대면 활성이 되고
      && afterEdit.start !== afterReset.start                // 되돌리기가 실제로 값을 바꾸며
      && afterReset.disabled === true                        // 되돌린 뒤에는 다시 비활성이고
      && (!recommended || Math.abs(Number(afterReset.start) - Number(recommended.start)) < 0.01),
    '구간을 바꾼 뒤 자동으로 찾은 구간으로 되돌릴 수 있다',
    JSON.stringify({ before: reset.before, afterEdit, afterReset, recommended }))
  // 되돌린 구간을 다시 확정해 원래 상태로 돌려놓는다. 이 검사가 목소리를 '미확정' 으로
  // 남기면 뒤 검사(E1: 준비된 목소리에는 다시 준비 버튼이 없다)의 전제가 깨진다.
  await st(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /이 구간으로 확정/.test(x.textContent))
    if (b) b.click()
  })
  await page.waitForFunction(
    () => [...document.querySelectorAll('button')].some((b) => /✓ 확정됨/.test(b.textContent)),
    { timeout: 60000 },
  ).catch(() => {})

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
  // 설정 반영은 손을 뗀 뒤 0.5초 늦게 온다(끄는 동안 재분석이 걸리지 않게 한 장치).
  await sleep(1200)
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
  // 첫 인물은 기본 목소리 준비를 **이어받는다** — 그쪽이 끝나야 준비된다. 정착을 기다린 뒤 센다
  // (즉시 읽으면 아직 준비 중인 인물을 '실패' 로 오해한다 — 2026-09-09 실측).
  const allReady = await waitUntil(async () => await st(() => {
    const s = window.__afStore.getState().ttsSpeakerRefState
    const ids = Object.keys(s)
    return ids.length > 0 && ids.every((k) => s[k]?.ready === true)
  }), 180000)
  const retryWhenReady = await count('[data-testid="card-voice-retry"]')
  ok('E1', allReady && retryWhenReady === 0, '준비가 끝난 목소리에는 다시 준비 버튼이 없다',
    `정착=${allReady} 버튼 ${retryWhenReady}개`)
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
  // 상한이 5인 이유: 위 넷 + C1b 가 '되돌린 구간을 다시 확정' 하는 한 번(2026-09-08 추가).
  // 이 숫자는 '중복 없이 필요한 만큼만 잘랐는가' 를 재는 것이지 성능 목표가 아니다.
  ok('F1', calls.trim <= 5, '같은 구간을 반복해서 자르지 않는다', JSON.stringify(calls))

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

  // ── H: 목소리 교체 · 교체 실패 · 연속 선택 (2026-09-09 관리자 검수 표적) ───────
  // 판정이 안내 문구에 걸려 있었고, 새 목소리를 준비하기 전에 이전 클립을 지웠고, 늦게 도착한
  // 결과를 원본 경로로만 걸렀다. 상태 기계는 store 시험이 재고, 여기서는 **실제 화면**을 지난다.
  const hSpk = await st(() => {
    const s = window.__afStore.getState().ttsSpeakerRefState
    // 교체 검사는 **드라이버가 준비한 인물**로 한다(이어받기 인물은 기본 목소리와 얽혀 있다).
    const hit = Object.entries(s).find(([id, v]) => v?.ready
      && id !== window.__afStore.getState().ttsSpeakerInherit?.speakerId)
    return hit ? hit[0] : ''
  })
  if (!hSpk) {
    const dump = await st(() => JSON.stringify((window.__afSlotLog || [])
      .filter((e) => e.id === '인물1').slice(-8)))
    ok('H0', false, '교체 검사를 시작할 준비된 인물이 있다', dump.slice(0, 2400))
  } else {
    const before = await st((id) => {
      const v = window.__afStore.getState().ttsSpeakerRefState[id]
      return { source: v.source, clip: v.clip, region: v.region, reqId: v.reqId, phase: v.phase }
    }, hSpk)

    // H1. 정상 교체 — **화면의 '목소리 바꾸기' 버튼**으로 바꾼다.
    //   store 를 직접 부르면 훅의 '직전 정상 목소리 보관' 을 지나지 않아 되돌리기가 성립하지 않는다.
    const openCard = async (id) => await st((sid) => {
      const rows = [...document.querySelectorAll('[data-testid="dialogue-row"]')]
      const row = rows.find((r) => r.getAttribute('data-speaker') === sid)
      const b = row?.querySelector('[data-testid="card-voice"]')
      if (!b) return false
      b.click()
      return true
    }, id)
    const clickAssign = async () => await st(() => {
      const b = document.querySelector('[data-testid="card-voice-assign"]')
      if (!b) return false
      b.click()
      return true
    })
    await openCard(hSpk)
    await sleep(600)
    await st((f) => window.api.audio.e2eSetSelectFile(f), iso.input)
    const swapped = await clickAssign()
    const okReady = swapped ? await waitUntil(async () => {
      const v = await st((id) => window.__afStore.getState().ttsSpeakerRefState[id], hSpk)
      return v?.phase === 'ready'
    }, 180000) : false
    const afterSwap = await st((id) => window.__afStore.getState().ttsSpeakerRefState[id], hSpk)
    ok('H1', okReady && afterSwap.source === iso.input && afterSwap.reqId !== before.reqId,
      '정상 교체 — 새 파일로 준비됨까지 가고 요청 식별자가 새것이다',
      JSON.stringify({ phase: afterSwap.phase, newReq: afterSwap.reqId !== before.reqId }))

    // H2. 교체 실패 — 쓸 수 없는 파일(0.5초 무음)로 바꾼다. 이전 목소리가 남아야 한다.
    const keep = { source: afterSwap.source, clip: afterSwap.clip, region: afterSwap.region }
    await st((f) => window.api.audio.e2eSetSelectFile(f), BAD)
    await clickAssign()
    const settled = await waitUntil(async () => {
      const v = await st((id) => window.__afStore.getState().ttsSpeakerRefState[id], hSpk)
      return v?.source === keep.source && v?.phase === 'ready'
    }, 180000)
    const afterBad = await st((id) => window.__afStore.getState().ttsSpeakerRefState[id], hSpk)
    ok('H2', settled && afterBad.source === keep.source && afterBad.clip === keep.clip
        && JSON.stringify(afterBad.region) === JSON.stringify(keep.region),
      '교체 실패 — 이전 원본·클립·구간·준비 상태가 그대로 남는다',
      JSON.stringify({ source: afterBad.source === keep.source, clip: afterBad.clip === keep.clip,
        phase: afterBad.phase }))
    const notice = await st(() => document.querySelector('[data-testid="voice-replace-notice"]')?.textContent || '')
    ok('H3', notice.length > 0, '교체 실패를 화면이 알린다', notice.slice(0, 40))
    // 되돌린 클립 파일이 실제로 살아 있어야 되돌리기가 의미가 있다.
    const alive = keep.clip ? fs.existsSync(keep.clip) : true
    ok('H4', alive, '되돌린 클립 파일이 디스크에 살아 있다', keep.clip ? String(alive) : '클립 없는 준비(원본 전체)')
    await shot('H-replace-failure.png')
  }

  // ── I: 자동 저장 (2026-09-09 관리자 검수 ② 표적) ─────────────────────────
  // 700ms 저장 대기 중 화면을 전환하면 마지막 변경이 사라졌다(대기를 그냥 취소했다).
  // 이제 전환 직전에 먼저 쓴다. 저장 파일을 직접 읽어 확인한다 — 화면 문구가 아니라 파일이 근거다.
  const settingsPath = path.join(USER_DATA, 'settings.json')
  const readDrafts = () => {
    try {
      const j = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      return j.workDrafts ?? null
    } catch { return null }
  }
  // 대사를 바꾸고 **700ms 이 지나기 전에** 한 명 ↔ 여러 명을 전환한다.
  const marker = `저장확인-${Date.now()}`
  await st((m) => {
    const ta = document.querySelector('section[aria-label="대사"] textarea')
      || document.querySelector('textarea')
    if (!ta) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    ta.focus()
    setter.call(ta, ta.value + m)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, marker)
  await sleep(120)                                  // 700ms 보다 훨씬 짧게 — 대기 중이다
  await page.click('[data-testid="dialogue-tabs"] [data-tab="single"]')
  await sleep(1500)
  const savedAfterSwitch = JSON.stringify(readDrafts() || {})
  ok('I1', savedAfterSwitch.includes(marker),
    '저장 대기 중 화면을 전환해도 마지막 변경이 저장된다',
    savedAfterSwitch.includes(marker) ? '기록에 있다' : '기록에 없다(유실)')

  // I2. 저장 실패를 알린다 — **실제로 실패하게** 만든다(대역을 심지 않는다).
  //     설정 파일을 읽기 전용으로 두면 원자 교체가 실패한다. 화면은 '저장됐다' 로 두면 안 된다.
  let madeReadOnly = false
  try { fs.chmodSync(settingsPath, 0o444); madeReadOnly = true } catch { madeReadOnly = false }
  const marker2 = `실패확인-${Date.now()}`
  await st((m) => {
    const ta = document.querySelector('section[aria-label="대사"] textarea')
      || document.querySelector('textarea')
    if (!ta) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    ta.focus()
    setter.call(ta, ta.value + m)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, marker2)
  const shown = await waitUntil(async () => await st(() =>
    !!document.querySelector('[data-testid="work-draft-save-error"]')), 20000)
  const retryThere = await count('[data-testid="work-draft-save-retry"]')
  ok('I2', madeReadOnly && shown && retryThere === 1,
    '저장이 실패하면 미저장 상태와 다시 시도 자리를 보여 준다',
    `읽기전용=${madeReadOnly} 알림=${shown} 다시저장=${retryThere}개`)

  // I3. 원인을 없애고 '다시 저장' 을 누르면 알림이 사라지고 실제로 기록에 들어간다.
  try { fs.chmodSync(settingsPath, 0o666) } catch { /* */ }
  await st(() => {
    const b = document.querySelector('[data-testid="work-draft-save-retry"]')
    if (b) b.click()
  })
  const gone = await waitUntil(async () => await st(() =>
    !document.querySelector('[data-testid="work-draft-save-error"]')), 20000)
  const savedAfterRetry = JSON.stringify(readDrafts() || {})
  ok('I3', gone && savedAfterRetry.includes(marker2),
    '다시 저장이 성공하면 알림이 사라지고 그 변경이 기록에 들어간다',
    `알림사라짐=${gone} 기록=${savedAfterRetry.includes(marker2)}`)

  // I4. 종료 직전 — 동기 통로가 열려 있고 그 키에만 쓴다.
  const syncOk = await st(() => {
    const r = window.api.settings.setSync('pythonPath', 'X')     // 허용되지 않은 키
    return r && r.ok === false && r.code === 'KEY_NOT_ALLOWED'
  })
  ok('I4', syncOk, '종료 직전 동기 저장은 자동 저장 키에만 열려 있다')
  await page.click('[data-testid="dialogue-tabs"] [data-tab="multi"]')
  await sleep(400)

  // ── B3 는 대본을 바꾸므로 맨 뒤에 둔다 ─────────────────────────────────
  // 앞에 두었더니 카드 구성이 달라져 구간 편집기 검사(C)가 무너졌다 — 검사가 검사의
  // 전제를 바꾸면 통과·실패가 순서에 좌우된다.
  // B3. 대사를 고치는 동안 화면이 통째로 바뀌지 않는가.
  // 예전에는 대본 구조가 잠깐 깨지는 것만으로 카드 목록이 사유 텍스트로 교체됐다(사용자 지적).
  // 카드가 있어야 볼 수 있으므로 대본을 먼저 넣고, 그 다음 '쉼만 있는 줄' 을 만들어 본다.
  // 대본은 **화면을 통해** 넣는다. store 에 직접 써도 편집기가 자기 값으로 되돌린다(실측).
  // 여러 명 화면에는 원문 칸이 없으므로 한 명 화면에서 넣고 돌아온다.
  await page.click('[data-testid="dialogue-tabs"] [data-tab="single"]')
  await sleep(400)
  const seeded = await st(() => {
    const ta = document.querySelector('section[aria-label="대사"] textarea')
      || document.querySelector('textarea')
    if (!ta) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    const nl = String.fromCharCode(10)
    ta.focus()
    setter.call(ta, '[화자 인물A]' + nl + '안녕하세요.' + nl + '[화자 인물B]' + nl + '반갑습니다.')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })
  await sleep(2500)
  await page.click('[data-testid="dialogue-tabs"] [data-tab="multi"]')
  const gotRows = await waitUntil(async () => await count('[data-testid="dialogue-row"]') >= 2, 60000)
  void seeded
  const layoutBefore = await st(() => ({
    rows: document.querySelectorAll('[data-testid="dialogue-row"]').length,
    sourceOnly: !!document.querySelector('[data-testid="multi-dialogue-source-only"]'),
    top: document.querySelector('[data-testid="multi-rows"]')?.getBoundingClientRect().top ?? null,
  }))
  const typed = await st(() => {
    const ta = document.querySelector('[data-testid="dialogue-row"] [data-testid="dialogue-body"]')
    if (!ta) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    const nl = String.fromCharCode(10)
    ta.focus()
    // 대사 뒤에 쉼만 있는 줄을 만든다 — 예전에 화면을 통째로 바꾸던 바로 그 모양.
    setter.call(ta, ta.value + nl + '[쉼 0.4]' + nl)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })
  await sleep(3000)
  const layoutAfter = await st(() => ({
    rows: document.querySelectorAll('[data-testid="dialogue-row"]').length,
    sourceOnly: !!document.querySelector('[data-testid="multi-dialogue-source-only"]'),
    notStructured: !!document.querySelector('[data-testid="multi-not-structured"]'),
    top: document.querySelector('[data-testid="multi-rows"]')?.getBoundingClientRect().top ?? null,
  }))
  ok('B3', gotRows && typed && layoutBefore.rows >= 2
      && layoutAfter.rows === layoutBefore.rows
      && layoutAfter.sourceOnly === false && layoutAfter.notStructured === false
      && layoutAfter.top === layoutBefore.top,
    '대사를 고쳐도 카드 화면이 사유 텍스트로 바뀌지 않고 자리도 그대로다',
    JSON.stringify({ gotRows, layoutBefore, layoutAfter }))

  // ── J: 기본 목소리 슬롯의 보고자는 하나다 (2026-09-09 관리자 지시) ─────────
  // 여러 명 화면에는 숨은 기본 목소리 구동이 붙어 있고, 기본 인물 카드에도 편집기가 있었다.
  // 둘이 같은 슬롯을 갱신하면 서로의 결론을 덮는다. 규칙: 접혀 있으면 구동이, 펼치면 카드가 맡는다.
  //
  // 기본 인물 카드가 생기려면 **인물 표기가 없는 대사**가 있어야 한다.
  await page.click('[data-testid="dialogue-tabs"] [data-tab="single"]')
  await sleep(300)
  await st(() => {
    const ta = document.querySelector('section[aria-label="대사"] textarea')
      || document.querySelector('textarea')
    if (!ta) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    const nl = String.fromCharCode(10)
    ta.focus()
    setter.call(ta, '이건 기본 인물의 대사입니다.' + nl + '[화자 인물A]' + nl + '이건 인물A 대사입니다.')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })
  await sleep(2500)
  await page.click('[data-testid="dialogue-tabs"] [data-tab="multi"]')
  const hasDefaultCard = await waitUntil(async () => await st(() =>
    [...document.querySelectorAll('[data-testid="dialogue-row"]')]
      .some((r) => (r.getAttribute('data-speaker') || '') === '')), 60000)
  const readyBefore = await st(() => window.__afStore.getState().ttsRefReady)
  const driverClosed = await count('[data-testid="default-voice-driver"]')
  ok('J1', hasDefaultCard && driverClosed === 1,
    '기본 인물 카드가 접혀 있으면 숨은 구동 하나만 맡는다',
    `기본카드=${hasDefaultCard} 구동=${driverClosed}개`)

  // 기본 인물의 목소리 설정 → 구간 수정을 펼친다. 그러면 구동이 물러나야 한다.
  const opened = await st(() => {
    const rows = [...document.querySelectorAll('[data-testid="dialogue-row"]')]
    const row = rows.find((r) => (r.getAttribute('data-speaker') || '') === '')
    const b = row?.querySelector('[data-testid="card-voice"]')
    if (!b) return false
    b.click()
    return true
  })
  await sleep(700)
  const regionToggled = await st(() => {
    const b = document.querySelector('[data-testid="voice-region-toggle"]')
    if (!b) return false
    b.click()
    return true
  })
  await sleep(900)
  const driverOpen = await count('[data-testid="default-voice-driver"]')
  const editorThere = await count('[data-testid="region-start-number"]')
  ok('J2', opened && regionToggled && driverOpen === 0 && editorThere >= 1,
    '구간 수정을 펼치면 숨은 구동이 물러나고 카드가 맡는다',
    `펼침=${opened && regionToggled} 구동=${driverOpen}개 편집기=${editorThere}개`)
  const readyAfterOpen = await st(() => window.__afStore.getState().ttsRefReady)
  ok('J3', readyBefore === false || readyAfterOpen === true,
    '편집기를 펼쳐도 준비 상태가 내려가지 않는다',
    `열기전=${readyBefore} 열고나서=${readyAfterOpen}`)

  // 다시 접으면 구동이 돌아오고, 준비 상태는 그대로다.
  await st(() => {
    const b = document.querySelector('[data-testid="voice-region-toggle"]')
    if (b) b.click()
  })
  await sleep(900)
  const driverBack = await count('[data-testid="default-voice-driver"]')
  const readyAfterClose = await st(() => window.__afStore.getState().ttsRefReady)
  ok('J4', driverBack === 1 && readyAfterClose === readyAfterOpen,
    '다시 접으면 구동이 돌아오고 준비 상태는 그대로다',
    `구동=${driverBack}개 준비=${readyAfterClose}`)

  // 기본 목소리가 준비된 상태에서는 '다시 준비' 입구가 없다(인물 슬롯의 E1 과 같은 규칙).
  // ★'다시 준비가 새 요청이고 클립·구간을 보존한다' 는 것은 여기서 확인하지 않는다 —
  //   준비된 상태에서는 그 버튼이 없기 때문이다. 그 동작은 store 상태 전이 시험이 재고 있다
  //   (speakerRefRequest.test.ts, '기본 목소리: ready 는 단계의 거울이고…').
  const readyNow = await st(() => window.__afStore.getState().ttsRefReady)
  // **기본 인물 카드 안에서만** 센다 — 전역으로 세면 다른 인물 카드의 버튼이 섞인다(실측).
  const retryEntries = await st(() => {
    const rows = [...document.querySelectorAll('[data-testid="dialogue-row"]')]
    const row = rows.find((r) => (r.getAttribute('data-speaker') || '') === '')
    return row ? row.querySelectorAll('[data-testid="card-voice-retry"]').length : -1
  })
  ok('J5', readyNow ? retryEntries === 0 : retryEntries >= 1,
    "준비된 기본 목소리에는 '다시 준비' 입구가 없다(미준비면 있다)",
    `준비=${readyNow} 기본카드안 입구=${retryEntries}개`)

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
