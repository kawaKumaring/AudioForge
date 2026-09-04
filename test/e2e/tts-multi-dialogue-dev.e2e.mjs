// 여러 명 대화 화면 — 개발 경로(npm run dev) 확인.
//
//   실행: npm run test:e2e:tts-multi-dialogue-dev
//
// 무엇을 보나: DOM 텍스트·속성·store 값만 본다. 스크린샷 없음. 사용자 파일 없음(합성 WAV,
// 격리 userData). 끝나면 자기가 띄운 프로세스 트리만 내린다.
//
// 화면 구조(재설계): 한 명 = 기존 편집기 그대로(제한 없음). 여러 명 = 인물의 한 발화 카드가 기본 단위
// (인물·목소리 상태·`+ 감정`·대사 한 칸·위/아래/삭제), 요약 한 줄, 선택 인물 한 명의 목소리 패널,
// 원문 직접 편집은 `고급 · 대본 표기 직접 편집` 로 접힘(카드와 상호 배타).
import { chromium } from 'playwright'
import { spawn, execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { makeSyntheticWav, cleanupSyntheticWav } from './_e2e-helper.mjs'

const APP = process.cwd()
const results = []
const ok = (id, c, m, extra = '') => {
  results.push({ id, pass: !!c })
  console.log(`[multi] [${id}] ${c ? 'PASS' : 'FAIL'} ${m} ${extra}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (process.platform !== 'win32') { console.error('개발 경로 E2E 는 Windows 전용'); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'node_modules'))) { console.error('npm install 필요'); process.exit(2) }

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'af-multi-'))
// 8초: 3~10초 안이라 통째로 유효한 참조 — 패널이 다시 확인해도 구간 자르기 없이 준비됨이 된다.
const WAV = makeSyntheticWav(path.join(os.tmpdir(), 'af_multi_' + randomUUID() + '.wav'), 8)
const PORT = 9400 + (process.pid % 200)

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
const killOwnTree = () => {
  if (childExited || !child.pid) return
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 이미 내려갔다 */ }
}

async function waitForCdp(timeoutMs) {
  const t0 = Date.now()
  for (;;) {
    if (childExited) return { ok: false, reason: 'CHILD_EXITED' }
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return { ok: true, ms: Date.now() - t0 } } catch { /* 아직 */ }
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
  await page.waitForFunction(() => !!window.api?.analysis?.analyze, null, { timeout: 60000 })

  await page.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, WAV)
  const RAW = 'section[aria-label="대사"] div[data-af-tts-editor] textarea'
  await page.waitForSelector(RAW, { timeout: 60000 })

  // ── 도우미 ────────────────────────────────────────────────────────────────
  const store = () => page.evaluate(() => window.__afStore.getState().ttsText)
  const mode = () => page.evaluate(() => window.__afStore.getState().ttsSpeakerMode)
  const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel)
  const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel)
  const tab = async (t) => { await page.click(`[data-testid="dialogue-tabs"] [data-tab="${t}"]`); await sleep(80) }
  const rowSpeakers = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="dialogue-row"]')].map((r) => r.getAttribute('data-speaker')))
  const rowBodies = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="dialogue-body"]')].map((t) => t.value))
  const diag = () => page.evaluate(() => {
    const root = document.querySelector('[data-testid="multi-dialogue"],[data-testid="multi-dialogue-source-only"]')
    return `mode=${root?.getAttribute('data-mode') ?? '-'} blockers=[${root?.getAttribute('data-blockers') ?? '-'}] rows=${document.querySelectorAll('[data-testid="dialogue-row"]').length}`
  })
  /** 원문을 넣는다. 여러 명 모드에서는 `고급 · 대본 표기 직접 편집` 을 잠깐 열어 넣고 다시 닫는다. */
  const setSource = async (t) => {
    let opened = false
    if ((await count(RAW)) === 0 && (await count('[data-testid="direct-edit-toggle"]')) > 0) {
      await page.click('[data-testid="direct-edit-toggle"]'); await sleep(150); opened = true
    }
    await page.evaluate(([sel, v]) => {
      const ta = document.querySelector(sel)
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, v)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }, [RAW, t])
    await sleep(600)
    // 넣은 대본이 구조화 불가면 토글 자체가 사라진다(셸이 열림 상태를 접는다) — 그때는 닫을 것이 없다.
    if (opened && (await count('[data-testid="direct-edit"][data-open="true"]')) > 0) { await page.click('[data-testid="direct-edit-toggle"]'); await sleep(150) }
  }
  const waitRows = async (n, ms = 30000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (await count('[data-testid="dialogue-row"]') === n) return true; await sleep(100) }
    return false
  }
  const waitUntil = async (fn, ms = 10000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100) }
    return false
  }
  const snapshot = () => page.evaluate(() => {
    const s = window.__afStore.getState()
    return JSON.stringify({ text: s.ttsText, refs: s.ttsSpeakerRefState, emo: s.ttsSpeakerEmotionRefs, labels: s.ttsSpeakerLabels })
  })

  // ── 1. 한 명 = 기본. 여러 명 UI 요소 0, 기존 편집기 1 ────────────────────
  await setSource('')
  ok('1', (await mode()) === 'single'
    && (await count('[data-testid="dialogue-tabs"] [role="tab"]')) === 2
    && (await count('[data-testid="multi-dialogue"],[data-testid="dialogue-row"],[data-testid="starter-card"],[data-testid="voice-panel"]')) === 0
    && (await count(RAW)) === 1,
    '한 명 기본: 탭 2개, 여러 명 요소 0, 기존 편집기 1')

  // ── 2. 여러 명 처음 열기: 시작 카드 2개, 원문 쓰기 0, 카드 안에서 이름·첫 대사 ──
  await tab('multi'); await sleep(300)
  const starters = await page.evaluate(() => [...document.querySelectorAll('[data-testid="starter-card"]')].map((c) => c.getAttribute('data-speaker')))
  ok('2a', starters.length === 2 && new Set(starters).size === 2 && (await store()) === '' && (await count(RAW)) === 0,
    '시작 카드 2개(서로 다른 id), 원문 빈 문자열, 원문 편집기는 접혀 있음', JSON.stringify(starters))
  await page.fill(`#spk-name-${starters[0]}`, '민수')
  await page.fill(`#spk-name-${starters[1]}`, '영희')
  await sleep(100)
  ok('2b', (await store()) === '' && (await text('[data-testid="multi-summary"]') ?? '').includes('인물'), '이름만 입력해도 원문에 쓰지 않는다')
  await page.fill(`[data-testid="starter-card"][data-speaker="${starters[0]}"] [data-testid="starter-line"]`, '첫 대사')
  await page.click(`[data-testid="starter-card"][data-speaker="${starters[0]}"] [data-testid="starter-add"]`)
  await sleep(100)
  const created = await store()
  ok('2c', created === '[화자 민수]\n첫 대사' && await waitRows(1) && (await count('[data-testid="starter-card"]')) === 1,
    '첫 대화 → 원문 [화자 민수]⏎첫 대사, 카드 1개, 남은 시작 카드 1개(영희)', `len=${created.length} ${await diag()}`)

  // ── 3. 발화 카드 하나에 인물·목소리·감정·대사 ──────────────────────────────
  const cardParts = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="dialogue-row"]')
    return {
      speaker: !!c?.querySelector('select'), voice: c?.querySelector('[data-testid="card-voice"]')?.textContent ?? null,
      emotion: !!c?.querySelector('[data-testid="emotion-add"]'), body: c?.querySelectorAll('textarea').length,
      up: !!c?.querySelector('[aria-label="위로"]'), del: [...(c?.querySelectorAll('button') ?? [])].some((b) => b.textContent.trim() === '삭제'),
    }
  })
  ok('3', cardParts.speaker && (cardParts.voice ?? '').includes('목소리 없음') && cardParts.emotion && cardParts.body === 1 && cardParts.up && cardParts.del,
    '카드: 인물 select · 목소리 상태 · + 감정 · 대사 한 칸 · 위/아래/삭제', JSON.stringify(cardParts))

  // ── 4. 세 화자 시간순 + 같은 인물 반복 + 목소리 상태 공유 ────────────────
  const SCRIPT = '[화자 민수]\n안녕\n[화자 영희]\n[기쁨] 반가워\n[화자 민수]\n[슬픔] 잘 가'
  await setSource(SCRIPT)
  const rows3 = await waitRows(3)
  const spk = await rowSpeakers()
  const bodies = await rowBodies()
  ok('4a', rows3 && spk.join(',') === '민수,영희,민수', '시간순 3카드, 인물 순서 민수→영희→민수', `${spk.join(',')} ${await diag()}`)
  ok('4b', bodies.join('|') === '안녕|[기쁨] 반가워|[슬픔] 잘 가', '대사 한 칸에 감정 태그가 글자 그대로', bodies.join('|'))
  ok('4c', (await text('[data-testid="multi-summary"]') ?? '').includes('인물 2명') && (await count('[data-testid="starter-card"]')) === 0,
    '요약: 인물 2명, 시작 카드 없음', await text('[data-testid="multi-summary"]'))
  // 같은 인물 카드는 같은 목소리 상태를 공유한다 — store 에 지정하면 두 카드 모두 '준비됨'.
  await page.evaluate((wav) => {
    window.__afStore.setState({ ttsSpeakerRefState: {
      '민수': { source: wav, clip: '', ready: true, message: '' },
    } })
  }, WAV)
  await sleep(150)
  const voiceTexts = await page.evaluate(() => [...document.querySelectorAll('[data-testid="dialogue-row"] [data-testid="card-voice"]')].map((b) => b.textContent.trim()))
  ok('4d', voiceTexts.length === 3 && voiceTexts[0].includes('준비됨') && voiceTexts[2].includes('준비됨') && voiceTexts[1].includes('없음'),
    '같은 인물(민수)의 두 카드가 같은 목소리 상태, 영희는 없음', JSON.stringify(voiceTexts))

  // ── 5. 탭 전환은 원문·인물·자산을 쓰지 않는다 ─────────────────────────────
  const snap0 = await snapshot()
  for (let i = 0; i < 5; i += 1) { await tab('single'); await tab('multi') }
  await sleep(200)
  ok('5', (await snapshot()) === snap0 && (await mode()) === 'multi' && await waitRows(3), '탭 10회 전환 후 원문·목소리 지정·이름 동일, 카드 3개')

  // ── 6. 목소리 패널은 선택한 인물 한 명만 ─────────────────────────────────
  await page.click('[data-testid="dialogue-row"][data-index="0"] [data-testid="card-voice"]')
  await sleep(150)
  const panel = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="voice-panel"]')
    return { n: document.querySelectorAll('[data-testid="voice-panel"]').length, speaker: p?.getAttribute('data-speaker'),
      change: !!([...(p?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('목소리 바꾸기'))),
      remove: !!([...(p?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('목소리 해제'))) }
  })
  ok('6a', panel.n === 1 && panel.speaker === '민수' && panel.change && panel.remove, '민수 목소리 패널 1개: 바꾸기·해제', JSON.stringify(panel))
  await page.click('[data-testid="voice-panel-close"]'); await sleep(100)
  ok('6b', (await count('[data-testid="voice-panel"]')) === 0, '닫기 → 카드로 돌아옴')

  // ── 7. 카드 본문 편집: 빠른 타이핑·계획 낡음 중 유지·태그 삭제는 일반 편집 ──
  const FAST = '빠르게 입력하는 문장입니다 하나 둘 셋 넷 다섯'
  const body0 = page.locator('[data-testid="dialogue-body"]').first()
  await body0.click(); await page.keyboard.press('Control+A'); await page.keyboard.type(FAST, { delay: 0 })
  const draftVal = await body0.inputValue()
  await page.keyboard.press('Tab')
  ok('7a', draftVal === FAST && await waitUntil(async () => (await store()).includes(FAST)), '빠른 타이핑 → 손실 없이 반영', `${draftVal.length}/${FAST.length}`)
  const body1 = page.locator('[data-testid="dialogue-body"]').nth(1)
  await body1.click(); await page.keyboard.press('Control+A')
  let snapped = 0, lostFocus = 0
  const SLOW = '천천히 치는 동안에도 카드가 남아 있어야 합니다'
  const typing = page.keyboard.type(SLOW, { delay: 45 })
  const t0 = Date.now()
  while (Date.now() - t0 < SLOW.length * 45 + 200) {
    const s = await page.evaluate(() => ({ so: document.querySelectorAll('[data-testid="multi-dialogue-source-only"]').length, focus: document.activeElement?.getAttribute('data-testid') }))
    if (s.so > 0) snapped += 1
    if (s.focus !== 'dialogue-body') lostFocus += 1
    await sleep(80)
  }
  await typing
  await page.keyboard.press('Tab')
  const committedSlow = await waitUntil(async () => (await store()).includes('\n' + SLOW + '\n'))
  ok('7b', snapped === 0 && lostFocus === 0 && committedSlow, '타이핑 중 소스전용 0·포커스 유지, 태그([기쁨])를 지운 편집도 그대로 반영', `snapped=${snapped} lostFocus=${lostFocus}`)
  await waitRows(3)
  const shown = await waitUntil(async () => { const b = await rowBodies(); return b[0] === FAST && b[1] === SLOW && b[2] === '[슬픔] 잘 가' })
  ok('7c', shown, '반영 뒤 카드 본문 3개가 원문과 일치', JSON.stringify(await rowBodies()).slice(0, 100))

  // ── 8. + 감정: caret 위치 삽입 → 시작/중간, caret 유지, 네이티브 undo ──────
  await setSource('[화자 민수]\n안녕하세요 오랜만\n[화자 영희]\n네')
  ok('8a', await waitRows(2), '감정 삽입용 대본 2카드')
  const b0 = page.locator('[data-testid="dialogue-row"][data-index="0"] [data-testid="dialogue-body"]')
  await b0.click()
  await page.evaluate(() => { const ta = document.querySelector('[data-testid="dialogue-row"][data-index="0"] [data-testid="dialogue-body"]'); ta.setSelectionRange(6, 6); ta.dispatchEvent(new Event('select', { bubbles: true })) })
  await page.click('[data-testid="dialogue-row"][data-index="0"] [data-testid="emotion-add"]')
  await sleep(80)
  const pickerN = await count('[data-testid="emotion-picker"] [role="menuitem"]')
  await page.click('[data-testid="dialogue-row"][data-index="0"] [data-testid="emotion-picker"] [data-emotion="happy"]')
  await sleep(120)
  const afterInsert = await b0.inputValue()
  const caretAfter = await page.evaluate(() => { const ta = document.activeElement; return ta && ta.getAttribute('data-testid') === 'dialogue-body' ? ta.selectionStart : -1 })
  ok('8b', pickerN >= 5 && afterInsert === '안녕하세요 [기쁨]오랜만' && caretAfter === 10,
    '+ 감정 → caret(6) 위치에 [기쁨] 삽입, caret 은 태그 뒤(10)', `picker=${pickerN} value=${JSON.stringify(afterInsert)} caret=${caretAfter}`)
  await page.keyboard.press('Control+Z')
  await sleep(80)
  const afterUndo = await b0.inputValue()
  ok('8c', afterUndo === '안녕하세요 오랜만', '네이티브 undo 로 삽입 되돌리기', JSON.stringify(afterUndo))
  // 맨 앞 삽입 → 시작 감정. blur 로 원문 반영.
  await page.evaluate(() => { const ta = document.querySelector('[data-testid="dialogue-row"][data-index="0"] [data-testid="dialogue-body"]'); ta.focus(); ta.setSelectionRange(0, 0); ta.dispatchEvent(new Event('select', { bubbles: true })) })
  await page.click('[data-testid="dialogue-row"][data-index="0"] [data-testid="emotion-add"]'); await sleep(80)
  await page.click('[data-testid="dialogue-row"][data-index="0"] [data-testid="emotion-picker"] [data-emotion="sad"]'); await sleep(120)
  await page.keyboard.press('Tab')
  const committedTag = await waitUntil(async () => (await store()).startsWith('[화자 민수]\n[슬픔]안녕하세요 오랜만\n'))
  ok('8d', committedTag, '맨 앞 삽입 → 시작 감정, blur 로 원문 반영', (await store()).slice(0, 40))

  // ── 9. 카드 삭제는 원문에서 그 발화만 지운다 — 목소리 자산 무변경 ────────
  await setSource(SCRIPT); await waitRows(3)
  const refsBefore = JSON.parse(await snapshot()).refs
  await page.click('[data-testid="dialogue-row"][data-index="1"] button:has-text("삭제")')
  const deleted = await waitUntil(async () => { const t = await store(); return !t.includes('반가워') && t.includes('안녕') && t.includes('[슬픔] 잘 가') })
  const rows2 = await waitRows(2, 15000)
  ok('9', deleted && rows2 && (await rowSpeakers()).join(',') === '민수,민수' && JSON.stringify(JSON.parse(await snapshot()).refs) === JSON.stringify(refsBefore),
    '2번 카드 삭제 → 그 발화만 제거(카드 2개 민수,민수), 목소리 지정 그대로', JSON.stringify(await store()).slice(0, 60))

  // ── 10. 표현 불가 대본 → 이유 + 원문 편집기 그대로 / 줄 안의 쉼은 카드 유지 ──
  const COMPLEX = '[화자 민수]\n안녕 [쉼 1] 잘 지냈어?\n[모르는지시] 이상한 줄'
  await setSource(COMPLEX)
  const so = await waitUntil(async () => (await count('[data-testid="multi-dialogue-source-only"]')) === 1)
  ok('10a', so && (await count(RAW)) === 1 && (await store()) === COMPLEX && (await count('[data-testid="direct-edit"]')) === 0,
    '알 수 없는 지시 → 이유 표시 + 원문 편집기 자동 표시, 원문 그대로')
  const PAUSE_ONLY = '[화자 민수]\n안녕 [쉼 1] 잘 지냈어?\n[화자 영희]\n응'
  await setSource(PAUSE_ONLY)
  ok('10b', await waitRows(2, 15000) && (await rowBodies())[0].includes('[쉼 1]') && (await store()) === PAUSE_ONLY, '줄 안의 쉼: 카드 2개, 쉼은 대사 안에')

  // ── 11. 화자 없는 대본 = 기본 인물 카드, 새 인물 만들기 → 명시 인물로 ────
  const NO_SPK = '그냥 한 줄\n[기쁨] 둘째 줄'
  await setSource(NO_SPK)
  ok('11a', await waitRows(2), '표기 없는 대본 2카드')
  const firstSel = await page.evaluate(() => { const sel = document.querySelector('[data-testid="dialogue-row"] select'); return { value: sel.value, text: sel.options[sel.selectedIndex]?.textContent } })
  ok('11b', firstSel.value === '' && firstSel.text === '기본 인물' && (await text('[data-testid="multi-summary"]') ?? '').includes('기본 인물'), '인물 칸이 기본 인물, 요약에도 기본 인물', JSON.stringify(firstSel))
  const before11 = await store()
  await page.selectOption('#dlg-new-speaker', '__new__'); await page.click('[data-testid="dialogue-add"] button'); await sleep(120)
  const newStarter = await page.evaluate(() => document.querySelector('[data-testid="starter-card"]')?.getAttribute('data-speaker'))
  ok('11c', !!newStarter && (await store()) === before11, '새 인물 만들기 → 시작 카드, 원문 그대로', `id=${newStarter}`)
  await page.fill(`#spk-name-${newStarter}`, '민수'); await sleep(120)
  const row0Sel = await page.evaluate(() => document.querySelectorAll('[data-testid="dialogue-row"] select')[0].id)
  await page.selectOption('#' + row0Sel, '민수')
  ok('11d', await waitUntil(async () => (await store()) === '[화자 민수]\n그냥 한 줄\n[화자 기본]\n[기쁨] 둘째 줄'), '기본 인물 → 민수: 표기 생성, 다음 대사는 [화자 기본]')
  await page.click(`[data-testid="starter-card"][data-speaker="${newStarter}"] button:has-text("삭제")`).catch(() => {})

  // ── 12. 한 명: 제한 없는 편집 + 비차단 알림·되돌리기 / 자산·구성 보존 ───────
  await setSource(SCRIPT); await waitRows(3)
  await page.evaluate((wav) => { window.__afStore.setState({ ttsSpeakerRefState: {
    '민수': { source: wav, clip: '', ready: true, message: '' }, '영희': { source: wav, clip: '', ready: true, message: '' } } }) }, WAV)
  await tab('single'); await sleep(200)
  ok('12a', (await mode()) === 'single' && (await count('[data-testid="single-mode-note"]')) === 1 && (await count('[data-testid="dialogue-row"]')) === 0
    && (await count('[data-testid="single-guard"],[data-testid="single-convert-open"]')) === 0,
    '한 명: 중립 안내 1줄, 카드 없음, 차단·전환 UI 없음')
  const refs12 = JSON.parse(await snapshot()).refs
  const DELETED = SCRIPT.replace('[화자 영희]\n', '')
  await setSource(DELETED)
  ok('12b', (await store()) === DELETED && (await count('[data-testid="speaker-structure-notice"]')) === 1 && JSON.stringify(JSON.parse(await snapshot()).refs) === JSON.stringify(refs12),
    '표기 삭제 편집 반영 + 비차단 알림, 목소리 지정 무변경')
  await page.click('[data-testid="speaker-structure-undo"]'); await sleep(150)
  ok('12c', (await store()) === SCRIPT && (await count('[data-testid="speaker-structure-notice"]')) === 0, '되돌리기 → 직전 원문')
  await tab('multi'); await waitRows(3)
  const spk12 = (await rowSpeakers()).join(',')
  await page.click('[data-testid="dialogue-row"][data-index="0"] [data-testid="card-voice"]')
  const panelOpened = await waitUntil(async () => (await count('[data-testid="voice-panel"]')) === 1, 3000)
  // 패널이 열리면 그 인물의 참조를 실제로 다시 확인한다(구간 편집기 마운트 → 분석). 합성 WAV(8초)는
  // 통째로 유효하므로 분석이 끝나면 준비됨이 되고, 같은 파일을 쓰는 두 인물의 공유 경고가 뜬다.
  await waitUntil(async () => (await count('[data-testid="speaker-voice-shared"]')) === 1, 25000)
  const sharedN = await count('[data-testid="speaker-voice-shared"]')
  const panelText = (await text('[data-testid="voice-panel"]')) ?? ''
  await page.click('[data-testid="voice-panel-close"]').catch(() => {})
  ok('12d', spk12 === '민수,영희,민수' && panelOpened && sharedN === 1, '여러 명 복귀: 카드 복원, 같은 파일 공유 경고는 패널 안에',
    `rows=${spk12} panel=${panelOpened} shared=${sharedN} text=${panelText.replace(/\s+/g, ' ').slice(0, 80)}`)

  // ── 13. 감정별 목소리는 인물별 opt-in(패널 안) ────────────────────────────
  await page.evaluate((wav) => { const US = String.fromCharCode(31); window.__afStore.setState({ ttsSpeakerEmotionRefs: { ['민수' + US + 'happy']: wav } }) }, WAV)
  await page.click('[data-testid="dialogue-row"][data-index="0"] [data-testid="card-voice"]'); await sleep(150)
  const off = await count('[data-testid="speaker-voice-emotion-off"]'); const toggle = await count('[data-testid="speaker-emotion-voice-toggle"]')
  await page.click('[data-testid="speaker-emotion-voice-toggle"] input'); await sleep(120)
  const enabled = await page.evaluate(() => JSON.stringify(window.__afStore.getState().ttsSpeakerEmotionEnabled))
  const onN = await count('[data-testid="speaker-voice-emotion-override"]')
  await page.click('[data-testid="speaker-emotion-voice-toggle"] input'); await sleep(120)
  const enabled2 = await page.evaluate(() => JSON.stringify(window.__afStore.getState().ttsSpeakerEmotionEnabled))
  await page.click('[data-testid="voice-panel-close"]')
  ok('13', off === 1 && toggle === 1 && enabled === '{"민수":true}' && onN === 1 && enabled2 === '{}' && (await page.evaluate(() => Object.keys(window.__afStore.getState().ttsSpeakerEmotionRefs).length)) === 1,
    '기본 꺼짐 → 켜면 그 인물만 · 사용 중 표시 → 끄면 구성은 그대로', `off=${off} toggle=${toggle} enabled=${enabled}`)
  await page.evaluate(() => window.__afStore.setState({ ttsSpeakerEmotionRefs: {} }))

  // ── 14. 원문 직접 편집은 카드와 상호 배타 ─────────────────────────────────
  await page.click('[data-testid="direct-edit-toggle"]'); await sleep(150)
  const exclusive = (await count(RAW)) === 1 && (await count('[data-testid="dialogue-row"]')) === 0
    && (await count('[data-testid="direct-edit"][data-open="true"]')) === 1
  await page.click('[data-testid="direct-edit-toggle"]'); await sleep(150)
  ok('14', exclusive && await waitRows(3) && (await count(RAW)) === 0, '직접 편집 열면 카드 숨김·원문 편집기 표시, 닫으면 카드 복귀')

  // ── 15. 배역 세트(목소리 구성) 자동 생성 없음 ─────────────────────────────
  const settings = await page.evaluate(() => window.api.settings.get())
  const vc = settings?.voiceCasts
  ok('15', vc == null || (Array.isArray(vc) ? vc.length === 0 : Object.keys(vc).length === 0), '설정에 voiceCasts 항목 없음')

  // ── 16. 폭 1280×800 / 좁은 폭 720: 가로 넘침·겹침·세로로 쪼개진 버튼 없음 ──
  const cdp = await page.context().newCDPSession(page)
  const layoutCheck = async () => page.evaluate(() => {
    const sec = document.querySelector('section[aria-label="대사"]')
    const overflow = sec ? sec.scrollWidth - sec.clientWidth : -1
    const btns = [...document.querySelectorAll('[data-testid="multi-dialogue"] button')]
    const tall = btns.filter((b) => b.getBoundingClientRect().height > 40).length
    const rows = [...document.querySelectorAll('[data-testid="dialogue-row"]')].map((r) => r.getBoundingClientRect())
    let overlaps = 0
    for (let i = 1; i < rows.length; i += 1) if (rows[i].top < rows[i - 1].bottom - 1) overlaps += 1
    return { overflow, tall, overlaps, docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }
  })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await sleep(250)
  const wide = await layoutCheck()
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 800, deviceScaleFactor: 1, mobile: false }); await sleep(250)
  const narrow = await layoutCheck()
  await cdp.send('Emulation.clearDeviceMetricsOverride'); await sleep(150)
  ok('16', wide.overflow <= 0 && wide.tall === 0 && wide.overlaps === 0 && narrow.overflow <= 0 && narrow.tall === 0 && narrow.overlaps === 0,
    '1280×800·720 폭에서 가로 넘침 0, 세로로 쪼개진 버튼 0, 카드 겹침 0', `wide=${JSON.stringify(wide)} narrow=${JSON.stringify(narrow)}`)

  ok('err', pageErrors.length === 0, 'renderer 페이지 오류 0', pageErrors.slice(0, 3).join(' | '))
} catch (e) {
  ok('fatal', false, '치명 오류', String(e?.message || e))
} finally {
  try { await browser?.close() } catch { /* */ }
  killOwnTree()
  for (let i = 0; i < 40 && !childExited; i += 1) await sleep(250)
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* */ }
  cleanupSyntheticWav(WAV)
  const fails = results.filter((r) => !r.pass).length
  console.log(`[multi] SUMMARY pass=${results.length - fails} fail=${fails} childExited=${childExited}`)
  process.exit(fails ? 1 : 0)
}
