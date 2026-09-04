// 여러 명 대화 화면 — 개발 경로(npm run dev) 확인.
//
//   실행: npm run test:e2e:tts-multi-dialogue-dev
//
// 무엇을 보나: DOM 텍스트·속성·store 값만 본다. 스크린샷 없음. 사용자 파일 없음(합성 WAV,
// 격리 userData). 끝나면 자기가 띄운 프로세스 트리만 내린다.
//
// 왜 개발 경로인가: React 개발 빌드의 StrictMode 이중 호출이 이 화면의 첫 결함(빈 인물 카드
// 4개가 같은 ID)을 만들었다. production 번들로는 재현되지 않는다.
//
// 항목 번호는 관리자 화면 확인 목록(1~12)을 따른다.
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
const WAV = makeSyntheticWav(path.join(os.tmpdir(), 'af_multi_' + randomUUID() + '.wav'), 12)
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
/** 우리가 띄운 이 트리만 정리한다. */
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
  const RAW = 'section[aria-label="대사"] textarea:not([data-testid="dialogue-body"])'
  await page.waitForSelector(RAW, { timeout: 60000 })

  // ── 도우미 ────────────────────────────────────────────────────────────────
  const store = () => page.evaluate(() => window.__afStore.getState().ttsText)
  const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel)
  const tab = async (t) => { await page.click(`[data-testid="dialogue-tabs"] [data-tab="${t}"]`); await sleep(50) }
  const rowSpeakers = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="dialogue-row"]')].map((r) => r.getAttribute('data-speaker')))
  const rowBodies = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="dialogue-body"]')].map((t) => t.value))
  const sourceOnlyText = () => page.evaluate(() => document.querySelector('[data-testid="multi-dialogue-source-only"]')?.textContent ?? null)
  const diag = () => page.evaluate(() => {
    const root = document.querySelector('[data-testid="multi-dialogue"],[data-testid="multi-dialogue-source-only"]')
    return `mode=${root?.getAttribute('data-mode') ?? '-'} blockers=[${root?.getAttribute('data-blockers') ?? '-'}] rows=${document.querySelectorAll('[data-testid="dialogue-row"]').length}`
  })
  const setSource = async (text) => {
    await page.evaluate(([sel, t]) => {
      const ta = document.querySelector(sel)
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, t)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }, [RAW, text])
    await sleep(600)
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

  // ── 11. 한 명 탭 — 기존 화면 그대로 ──────────────────────────────────────
  await setSource('')
  const tabsN = await count('[data-testid="dialogue-tabs"] [role="tab"]')
  const singleSel = await page.evaluate(() => document.querySelector('[data-testid="dialogue-tabs"] [data-tab="single"]')?.getAttribute('aria-selected'))
  const multiDom = await count('[data-testid="multi-dialogue"],[data-testid="multi-dialogue-source-only"],[data-testid="speaker-card"],[data-testid="dialogue-row"]')
  ok('11', tabsN === 2 && singleSel === 'true' && multiDom === 0 && (await count(RAW)) === 1,
    '한 명 탭 기본 선택, 여러 명 UI 요소 0, 원문 편집기 1', `tabs=${tabsN} multiDom=${multiDom}`)
  ok('11b', (await count('details[data-testid="voice-config-save-load"][open]')) === 0,
    '목소리 구성 저장/불러오기 절은 열려 있지 않다')

  // ── 1. 빈 대본 → 첫 대화 생성 ─────────────────────────────────────────────
  await tab('multi')
  await sleep(300)
  const cards = await page.evaluate(() => [...document.querySelectorAll('[data-testid="speaker-card"]')].map((c) => ({ id: c.getAttribute('data-speaker'), pending: c.getAttribute('data-pending') })))
  ok('1a', cards.length === 2 && cards.every((c) => c.pending === 'true') && new Set(cards.map((c) => c.id)).size === 2 && (await store()) === '',
    '빈 대본에서 서로 다른 ID 의 빈 인물 카드 2개, 원문은 빈 문자열', JSON.stringify(cards))
  await page.fill(`#spk-name-${cards[0].id}`, '민수')
  await page.fill(`#spk-name-${cards[1].id}`, '영희')
  await sleep(100)
  ok('1b', (await store()) === '', '이름만 입력해도 원문에 쓰지 않는다')
  await page.selectOption('#dlg-new-speaker', '민수')
  await page.fill('#dlg-new-line', '첫 대사')
  await page.click('[data-testid="dialogue-add"] button')
  await sleep(100)
  const created = await store()
  const rows1 = await waitRows(1)
  ok('1c', created === '[화자 민수]\n첫 대사' && rows1, '첫 대화 생성 → 원문 [화자 민수]⏎첫 대사, 행 1개', `len=${created.length} ${await diag()}`)

  // ── 12. 목소리 지정 버튼 ──────────────────────────────────────────────────
  const voiceBtns = await page.evaluate(() => [...document.querySelectorAll('[data-testid="speaker-card"] button')].filter((b) => /목소리 (지정|바꾸기)/.test(b.textContent)).length)
  ok('12', voiceBtns >= 1, '인물 카드에 목소리 지정 버튼', `n=${voiceBtns}`)

  // ── 5·6. 여러 화자 시간순 + 같은 화자 반복 ────────────────────────────────
  const SCRIPT = '[화자 민수]\n안녕\n[화자 영희]\n[기쁨] 반가워\n[화자 민수]\n[슬픔] 잘 가'
  await setSource(SCRIPT)
  const rows3 = await waitRows(3)
  const spk = await rowSpeakers()
  const bodies = await rowBodies()
  ok('5', rows3 && spk.join(',') === '민수,영희,민수', '시간순 3행, 인물 순서 민수→영희→민수', `${spk.join(',')} ${await diag()}`)
  ok('6', spk[0] === spk[2] && bodies.join('|') === '안녕|반가워|잘 가', '같은 인물 반복 + 본문에 지시 없음', bodies.join('|'))
  ok('5b', (await count('[data-testid="speaker-card"]')) === 2 && (await count('[data-testid="speaker-card"][data-pending="true"]')) === 0,
    '인물 카드 2개, pending 0')

  // ── 4. 탭 전환은 원문을 쓰지 않는다 ───────────────────────────────────────
  const before4 = await store()
  await tab('single'); await tab('multi'); await tab('single'); await tab('multi')
  await sleep(200)
  ok('4', (await store()) === before4 && await waitRows(3), '탭 4회 전환 후 원문 동일, 행 3개 유지')

  // ── 9. 인물 삭제는 대사를 지우지 않는다 ───────────────────────────────────
  const delState = await page.evaluate(() => [...document.querySelectorAll('[data-testid="speaker-card"] button')].filter((b) => b.textContent.trim() === '인물 삭제').map((b) => b.disabled))
  ok('9', delState.length === 2 && delState.every(Boolean) && (await store()) === before4, '대사 있는 인물의 삭제 버튼 비활성, 원문 불변', JSON.stringify(delState))

  // ── 2. 빠른 타이핑 글자 손실 없음 ─────────────────────────────────────────
  const FAST = '빠르게 입력하는 문장입니다 하나 둘 셋 넷 다섯'
  const body0 = page.locator('[data-testid="dialogue-body"]').first()
  await body0.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type(FAST, { delay: 0 })
  const draftVal = await body0.inputValue()
  await page.keyboard.press('Tab')
  const committed2 = await waitUntil(async () => (await store()).includes(FAST))
  ok('2', draftVal === FAST && committed2, '행 본문 빠른 타이핑 → 손실 없이 원문 반영', `draftLen=${draftVal.length}/${FAST.length}`)
  await page.click(RAW)
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' 추가', { delay: 0 })
  await sleep(100)
  ok('2b', (await store()).endsWith('잘 가 추가'), '원문 편집기 빠른 타이핑 반영')

  // ── 3. 타이핑 중 직접 입력으로 튕기지 않는다(계획이 낡아도) ───────────────
  const body1 = page.locator('[data-testid="dialogue-body"]').nth(1)
  await body1.click()
  await page.keyboard.press('Control+A')
  let snapped = 0, lostFocus = 0, bodyCountBad = 0
  const SLOW = '천천히 치는 동안에도 편집기가 남아 있어야 합니다'
  const typing = page.keyboard.type(SLOW, { delay: 45 })
  const t0 = Date.now()
  while (Date.now() - t0 < SLOW.length * 45 + 200) {
    const s = await page.evaluate(() => ({
      so: document.querySelectorAll('[data-testid="multi-dialogue-source-only"]').length,
      bodies: document.querySelectorAll('[data-testid="dialogue-body"]').length,
      focus: document.activeElement?.getAttribute('data-testid'),
    }))
    if (s.so > 0) snapped += 1
    if (s.focus !== 'dialogue-body') lostFocus += 1
    if (s.bodies !== 3) bodyCountBad += 1
    await sleep(80)
  }
  await typing
  const draft3 = await body1.inputValue()
  await page.keyboard.press('Tab')
  // 계획이 늦으면 초안은 보류되고 계획이 온 뒤 반영된다. 이 행은 [기쁨] 태그 뒤에 온다.
  const committed3 = await waitUntil(async () => (await store()).includes('[기쁨] ' + SLOW + '\n'))
  ok('3', snapped === 0 && lostFocus === 0 && bodyCountBad === 0 && draft3 === SLOW && committed3,
    '타이핑 동안 소스전용 0회·포커스 유지·행 3개 유지, 반영', `snapped=${snapped} lostFocus=${lostFocus} bad=${bodyCountBad} draftLen=${draft3.length}/${SLOW.length} committed=${committed3}`)
  const bodiesOk = await waitUntil(async () => { const b = await rowBodies(); return b[0] === FAST && b[1] === SLOW && b[2] === '잘 가 추가' })
  ok('3b', bodiesOk, '반영 뒤 행 본문 3개가 원문 내용과 일치(낡은 좌표 조각 없음)', JSON.stringify(await rowBodies()).slice(0, 120))

  // ── 7. 한 대사 안의 여러 감정 태그 보존 ───────────────────────────────────
  await setSource('[화자 민수]\n[기쁨] 앞부분 [슬픔] 뒷부분\n[화자 영희]\n네')
  ok('7a', await waitRows(2), '중간 태그 대본 2행')
  const midNotice = await page.evaluate(() => /중간 감정 태그/.test(document.querySelector('[data-testid="dialogue-row"]')?.textContent || ''))
  const chosen = await page.evaluate(() => {
    const sel = document.querySelectorAll('[data-testid="dialogue-row"] select')[1]
    const opt = [...sel.options].find((o) => o.value !== 'default' && o.value !== 'happy' && o.value !== 'sad')
    return { id: sel.id, value: opt.value, label: opt.textContent }
  })
  await page.selectOption('#' + chosen.id, chosen.value)
  const ok7 = await waitUntil(async () => (await store()).startsWith(`[화자 민수]\n[${chosen.label}] 앞부분 [슬픔] 뒷부분\n`))
  ok('7', ok7 && midNotice, '기본 감정 변경 후 중간 [슬픔] 태그 보존 + 안내 문구', `base=${chosen.label}`)

  // ── 8. 표현 불가 대본은 직접 입력 유지 + 원문 보존 ────────────────────────
  const COMPLEX = '[화자 민수]\n안녕 [쉼 1] 잘 지냈어?\n[모르는지시] 이상한 줄'
  await setSource(COMPLEX)
  const so8ok = await waitUntil(async () => (await sourceOnlyText()) !== null)
  const so8 = await sourceOnlyText()
  const raw8 = await page.evaluate((s) => document.querySelector(s).value, RAW)
  await tab('single'); await tab('multi'); await sleep(300)
  ok('8', so8ok && so8.includes('직접 입력') && raw8 === COMPLEX && (await store()) === COMPLEX,
    '알 수 없는 지시 대본 → 이유 표시 + 원문 그대로', `notice=${(so8 || '').replace(/\s+/g, ' ').slice(0, 80)}`)
  const PAUSE_ONLY = '[화자 민수]\n안녕 [쉼 1] 잘 지냈어?\n[화자 영희]\n응'
  await setSource(PAUSE_ONLY)
  const rows8b = await waitRows(2, 10000)
  ok('8b', rows8b && (await store()) === PAUSE_ONLY && (await rowBodies())[0].includes('[쉼 1]'),
    '줄 안의 쉼 표기: 구조화 2행, 쉼은 본문에 남고 원문 보존')

  // ── 13. 화자 표기가 없는 대사 = 기본 인물(빈 칸 아님), 명시 인물로 바꾸면 표기가 생긴다 ──
  const NO_SPK = '그냥 한 줄\n[기쁨] 둘째 줄'
  await setSource(NO_SPK)
  ok('13a', await waitRows(2), '표기 없는 대본 2행')
  const firstSel = await page.evaluate(() => {
    const sel = document.querySelectorAll('[data-testid="dialogue-row"] select')[0]
    return { value: sel.value, text: sel.options[sel.selectedIndex]?.textContent }
  })
  const noteN = await count('[data-testid="default-speaker-note"]')
  ok('13b', firstSel.value === '' && firstSel.text === '기본 인물' && noteN === 1,
    '인물 칸이 기본 인물로 보이고 안내 한 줄이 있다', JSON.stringify(firstSel))
  const before13 = await store()
  await tab('single'); await tab('multi'); await sleep(200)
  ok('13c', (await store()) === before13, '탭을 열기만 해서는 원문이 바뀌지 않는다')
  await page.click('[data-testid="multi-speakers"] button:has-text("+ 인물 추가")')
  await sleep(100)
  const pendingId = await page.evaluate(() => document.querySelector('[data-testid="speaker-card"][data-pending="true"]')?.getAttribute('data-speaker'))
  ok('13d', !!pendingId && (await store()) === before13, '인물 카드를 추가해도 원문은 그대로', `id=${pendingId}`)
  await page.fill(`#spk-name-${pendingId}`, '민수')
  await sleep(100)
  const row0Sel = await page.evaluate(() => document.querySelectorAll('[data-testid="dialogue-row"] select')[0].id)
  await page.selectOption('#' + row0Sel, '민수')
  const switched = await waitUntil(async () => (await store()) === '[화자 민수]\n그냥 한 줄\n[화자 기본]\n[기쁨] 둘째 줄')
  ok('13e', switched, '기본 인물 → 민수: 대사 앞에 [화자 민수], 다음 대사는 [화자 기본] 으로 복원', (await store()).length + '자')

  // ── 14. 목소리 지정 버튼은 기존 파일 선택 경로(window.api.audio.selectFile)를 부른다 ──
  // 실제 창을 띄우지 않고 그 자리에서 '취소' 를 돌려준다. 사용자 파일은 읽지 않는다.
  await waitRows(2)
  const wrapped = await page.evaluate(() => {
    try {
      const orig = window.api.audio.selectFile
      window.__afSelectFileCalls = 0
      window.api.audio.selectFile = async () => { window.__afSelectFileCalls += 1; return '' }
      return typeof orig === 'function' && window.api.audio.selectFile !== orig
    } catch { return false }
  })
  if (wrapped) {
    const before14 = await store()
    await page.click('[data-testid="speaker-card"]:not([data-pending="true"]) button:has-text("목소리 지정")')
    await sleep(300)
    const calls = await page.evaluate(() => window.__afSelectFileCalls)
    const decisionAfter = await page.evaluate(() => [...document.querySelectorAll('[data-testid="speaker-voice-decision"]')].map((e) => e.textContent.trim()))
    ok('14', calls === 1 && (await store()) === before14,
      '목소리 지정 클릭 → 파일 선택 1회 호출, 취소하면 아무것도 바뀌지 않음', `calls=${calls} decisions=${JSON.stringify(decisionAfter).slice(0, 80)}`)
  } else {
    ok('14', (await page.locator('[data-testid="speaker-card"]:not([data-pending="true"]) button:has-text("목소리 지정")').count()) >= 1,
      '목소리 지정 버튼 존재(파일 선택 경로 호출은 브릿지 객체가 고정되어 자동 확인 불가 — 사용자 직접 확인)')
  }

  // ── 15. 한 명 화면의 화자 구조 보호 + 명시 전환 ──────────────────────────
  // 목소리 지정은 store 에 합성 파일로 직접 넣는다(파일 선택창·참조 분석 없음). 사용자 파일 없음.
  const GUARD_SCRIPT = '[화자 민수]\n[기쁨] 안녕 [쉼 1] 잘\n[화자 영희]\n응\n[화자 민수]\n또'
  await setSource(GUARD_SCRIPT)
  await page.evaluate((wav) => {
    window.__afStore.setState({ ttsSpeakerRefState: {
      '민수': { source: wav, clip: '', ready: true, message: '' },
      '영희': { source: wav, clip: '', ready: true, message: '' },
    } })
  }, WAV)
  const snapshot = () => page.evaluate(() => {
    const s = window.__afStore.getState()
    return JSON.stringify({ text: s.ttsText, refs: s.ttsSpeakerRefState, emo: s.ttsSpeakerEmotionRefs, labels: s.ttsSpeakerLabels })
  })
  const snap0 = await snapshot()
  for (let i = 0; i < 5; i += 1) { await tab('single'); await tab('multi') }
  await sleep(200)
  ok('15a', (await snapshot()) === snap0, '탭 10회 전환 후 원문·목소리 지정·감정별 참조·이름 전부 동일')
  await tab('single'); await sleep(200)
  const guardN = await count('[data-testid="single-guard"]')
  const guardText = await page.evaluate(() => document.querySelector('[data-testid="single-guard"]')?.textContent ?? '')
  ok('15b', guardN === 1 && guardText.includes('인물 2명') && (await count('[data-testid="single-convert-panel"]')) === 0,
    '한 명 화면에 인물 2명 안내 + 전환 버튼(패널은 닫힘)', guardText.slice(0, 60))
  // 본문만 고치는 편집은 반영된다(A→B→A 순서·감정·쉼·알 수 없는 지시 유지).
  const EDITED = GUARD_SCRIPT.replace('안녕 [쉼 1] 잘', '안녕하세요 [쉼 1] 잘 지냈어요')
  await setSource(EDITED)
  const acc = await store()
  ok('15c', acc === EDITED && (await count('[data-testid="single-guard-blocked"]')) === 0,
    '한 명 화면의 본문 수정은 반영되고 화자 표기·순서는 그대로')
  // 표기를 지우는 편집은 반영되지 않고 알린다.
  await setSource(EDITED.replace('[화자 영희]\n', ''))
  const blockedN = await count('[data-testid="single-guard-blocked"]')
  ok('15d', (await store()) === EDITED && blockedN === 1, '화자 표기 삭제 편집은 거부 + 안내', `blocked=${blockedN}`)
  // 표기 이름을 바꾸는 편집도 거부.
  await setSource(EDITED.replace('[화자 영희]', '[화자 지은]'))
  ok('15e', (await store()) === EDITED, '화자 이름 변경 편집도 거부')
  // 전환 취소 = 완전 무변경.
  const snap1 = await snapshot()
  await page.click('[data-testid="single-convert-open"]')
  await sleep(100)
  const panelText = await page.evaluate(() => document.querySelector('[data-testid="single-convert-panel"]')?.textContent ?? '')
  ok('15f', panelText.includes('인물 구분이 제거되며 모든 대사가 기본 목소리를 사용합니다') && panelText.includes('삭제되지 않습니다'),
    '전환 패널이 결과를 먼저 설명한다')
  await page.click('[data-testid="single-convert-cancel"]')
  await sleep(100)
  ok('15g', (await snapshot()) === snap1 && (await count('[data-testid="single-convert-panel"]')) === 0, '취소: 원문·설정 한 글자도 안 바뀜')
  // 여러 명으로 돌아가면 비변환 상태가 그대로 — 인물 2명, 목소리 지정 유지(목소리 바꾸기 버튼).
  await tab('multi'); await waitRows(3, 10000)
  const cardsBack = await page.evaluate(() => [...document.querySelectorAll('[data-testid="speaker-card"]')].map((c) => c.getAttribute('data-speaker')))
  const changeBtns = await page.locator('[data-testid="speaker-card"] button:has-text("목소리 바꾸기")').count()
  ok('15h', cardsBack.join(',') === '민수,영희' && changeBtns === 2 && (await rowSpeakers()).join(',') === '민수,영희,민수',
    '여러 명 복귀: 인물 순서·이름·목소리 지정 그대로', `cards=${cardsBack.join(',')} change=${changeBtns} rows=${(await rowSpeakers()).join(',')}`)
  // 전환 승인 = 화자 표기만 제거, 목소리 지정·목소리 구성 보존.
  await tab('single'); await sleep(200)
  await page.click('[data-testid="single-convert-open"]'); await sleep(100)
  await page.click('[data-testid="single-convert-confirm"]'); await sleep(200)
  const converted = await store()
  const refsAfter = await page.evaluate(() => JSON.stringify(window.__afStore.getState().ttsSpeakerRefState))
  ok('15i', converted === '[기쁨] 안녕하세요 [쉼 1] 잘 지냈어요\n응\n또' && refsAfter === JSON.stringify(JSON.parse(snap1).refs) && (await count('[data-testid="single-guard"]')) === 0,
    '전환 승인: 화자 표기만 제거(감정·쉼 유지), 목소리 지정 보존, 안내 사라짐', `len=${converted.length} refsKept=${refsAfter === JSON.stringify(JSON.parse(snap1).refs)}`)
  await page.evaluate(() => window.__afStore.setState({ ttsSpeakerRefState: {} }))

  // ── 10. 배역 세트(VoiceCast) 자동 생성 없음 ───────────────────────────────
  const settings = await page.evaluate(() => window.api.settings.get())
  const vc = settings?.voiceCasts
  const settingsFile = path.join(USER_DATA, 'settings.json')
  const fileHasVc = fs.existsSync(settingsFile) && /"voiceCasts"\s*:\s*(\[\s*[^\]]|\{\s*")/.test(fs.readFileSync(settingsFile, 'utf-8'))
  ok('10', (vc == null || (Array.isArray(vc) ? vc.length === 0 : Object.keys(vc).length === 0)) && !fileHasVc,
    '설정에 voiceCasts 항목 없음(메모리·파일 모두)')

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
