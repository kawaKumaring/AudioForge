// 낭독 — **기본 목소리 여럿을 들어 보고 고른다**(Supertonic 3 열 개 + piper 하나).
//
// ★지시 (2026-09-30): "기본 모델들을 여러 개 연결해 봐라, 하나씩 사용자가 들어 보고 선택하게."
// ★Supertonic 은 받아 둔 파일만 연다(인터넷에 닿지 않는다). 받아 두지 않은 설치에서는 건너뛴다(SKIP 으로 말한다).
//
// 여기서 보는 것 (실제 앱 · CPU)
//   1) 낭독자 고르기에 기본 목소리가 (묶음 탭을 넘겨 보면) 전부 보이고 '들어 보기' 는 창 아래 하나다
//   2) Supertonic 목소리 하나를 들어 보면 실제로 소리가 나고 기록에 남는다
//   3) 그 목소리를 고르면 아래 막대에 이름이 뜨고, 그 목소리로 책을 읽는다(읽는 구절이 뜬다)
//   4) 들어 본 소리·읽은 소리가 Supertonic 으로 만든 것이다(기록의 엔진 이름)
//   5) 목소리가 많아도 설정 창이 화면 안에서 굴러간다(아래 설정에 닿을 수 있다)
//
// 실행: node test/e2e/reader-voices.e2e.mjs   (사전: npm run build)
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { _electron as electron } from 'playwright'
import { isolatedUserData, cleanupUserData, cleanupIsolated } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const UD = isolatedUserData()
const ISO = path.join(os.tmpdir(), 'audioforge_e2e_' + randomUUID())
fs.mkdirSync(ISO, { recursive: true })
const BOOK = path.join(ISO, '짧은 책.txt')
// ★멈출 때 아직 읽고 있을 만큼 길게 — 두 문장짜리였을 때 읽기가 제풀에 끝나는 순간과 '멈춤' 누름이 겹쳐
//   **다시 읽기 시작**했고, 뒤의 Qwen 판정이 그 탓에 셋 중 둘 흔들렸다(따로 떼어 4회 재현 시 0회 — 제품이 아니라 검사의 경주).
fs.writeFileSync(BOOK, Array.from({ length: 12 }, (_, i) =>
  `${i + 1}번째 문단이다. 그는 천천히 문을 열고 어두운 복도를 내다보았다. 멀리서 물소리가 일정하게 이어졌다.`).join('\n'), 'utf-8')

let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}
const logText = () => fs.readdirSync(path.join(UD, 'logs')).map((n) => fs.readFileSync(path.join(UD, 'logs', n), 'utf-8')).join('')

let app = null
try {
  app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, AF_E2E_SELECT_FILE: BOOK, HF_HUB_OFFLINE: '1' } })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)
  const listed = await win.evaluate(() => window.api.cards.builtinVoices())
  const voices = listed?.data?.voices || []
  const st = voices.filter((v) => v.engineId === 'supertonic')
  if (!st.length) {
    console.log('SKIP Supertonic 을 받아 두지 않은 설치입니다', JSON.stringify(listed?.data?.skipped || []))
    await app.close(); cleanupUserData(UD); cleanupIsolated(ISO); process.exit(0)
  }
  ok(st.length === 10, 'Supertonic 목소리 열 개가 기본 목소리 목록에 오른다', st.map((v) => v.label))

  await win.getByTestId('mode-reader').click()
  await win.getByTestId('reader-add-text').first().click()
  await win.waitForSelector('[data-testid="reader-paragraph"]')

  // ── 1. 설정 창의 목록 ──────────────────────────────────────────────
  await win.getByTestId('reader-voice').click()
  const dialog = win.getByRole('dialog', { name: '낭독자 고르기' })
  await dialog.waitFor()
  // ★새 고르기는 묶음 탭(빠른 낭독 · 고품질 · 외국어 억양 · 기타)이라 한 번에 한 묶음만 보인다 — 탭을 하나씩 넘겨 모은다.
  const GROUP_TABS = /^(빠른 낭독|고품질|외국어 억양|기타)$/
  const tabs = dialog.getByRole('button', { name: GROUP_TABS })
  const tabNames = await tabs.allInnerTexts()
  const rows = [], chips = [], perTab = {}
  for (let i = 0; i < tabNames.length; i++) {
    await tabs.nth(i).click()
    const labels = await win.getByTestId('reader-voice-builtin').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || ''))
    rows.push(...labels); perTab[tabNames[i]] = labels
    chips.push(...await win.getByTestId('reader-voice-builtin').evaluateAll((els) => els.map((e) => (e.textContent || '').trim())))
  }
  ok(rows.length === voices.length && rows.includes('Supertonic 여성 1') && rows.includes('Supertonic 남성 5'),
    '★낭독자 고르기에 기본 목소리가 (묶음 탭을 넘기면) 전부 보인다', { rows, tabNames })
  // ★묶음 칩 — 칩에는 짧은 이름(여성 1)만, 엔진 이름은 묶음 탭 한 번(2026-10-01 신고: 길게 나열돼 보기 좋지 않다).
  ok(chips.some((t) => t.includes('여성 1')) && chips.some((t) => t.includes('남성 5')) && chips.every((t) => !/Supertonic/.test(t)), '★칩에는 짧은 이름만 보인다', chips)
  const fastTab = perTab['빠른 낭독'] || []
  ok(tabNames.filter((n) => n === '빠른 낭독').length === 1 && fastTab.length === st.length && fastTab.every((l) => /^Supertonic/.test(l))
    && Object.entries(perTab).every(([n, ls]) => n === '빠른 낭독' || ls.every((l) => !/^Supertonic/.test(l))),
    '★Supertonic 은 "빠른 낭독" 묶음 하나에만 있다(한 묶음 · 한 번)', perTab)
  ok(await win.getByTestId('reader-voice-try').count() === 1, '★들어 보기는 창 아래 하나 — 줄마다 두지 않는다')
  await tabs.filter({ hasText: '빠른 낭독' }).click()      // 아래 들어 보기는 빠른 낭독 묶음에서

  // ── 5. 목소리가 많아도 창 안에서 굴러간다 ───────────────────────────
  const fit = await dialog.evaluate((d) => {
    const r = d.getBoundingClientRect()
    const body = d.querySelector('.af-card-modal-body')
    return { inView: r.top >= 0 && r.bottom <= window.innerHeight + 1, scrolls: !!body && (body.scrollHeight <= body.clientHeight + 1 || getComputedStyle(body).overflowY === 'auto') }
  })
  ok(fit.inView && fit.scrolls, '★고르기 창이 화면 안에 들고, 넘치면 창 안에서 굴러간다', fit)

  // ── 2. 들어 보기 ───────────────────────────────────────────────────
  const idx = rows.findIndex((t) => t === 'Supertonic 여성 2')
  const t0 = Date.now()
  await win.getByTestId('reader-voice-builtin').nth(idx).click()
  ok(await win.getByTestId('reader-voice-builtin').nth(idx).getAttribute('aria-checked') === 'true', '칩을 누르면 골라진다(아직 확정 전)')
  await win.getByTestId('reader-voice-try').click()
  // 기록이 답이다 — 들어 보기는 끝나면 '들어 보기 — 이름' 을, 실패하면 '들어 보기 실패 — 이름' 을 남긴다.
  let heard = false, failed = false
  for (let i = 0; i < 120 && !heard && !failed; i++) {
    const l = logText()
    heard = /들어 보기 — Supertonic 여성 2/.test(l)
    failed = /들어 보기 실패 — Supertonic 여성 2/.test(l)
    if (!heard && !failed) await win.waitForTimeout(500)
  }
  const tryMs = Date.now() - t0
  const note = await dialog.getByRole('alert').innerText().catch(() => '')
  ok(heard && !failed && !note, '★Supertonic 목소리를 들어 볼 수 있고 기록에 남는다(오류 없이)', { tryMs, note })

  // ── 3. 고르고 읽기 ─────────────────────────────────────────────────
  await win.getByTestId('reader-voice-confirm').click()
  // 낭독자 단추는 짧은 이름(여성 2)을 보이고, 전체 이름(Supertonic 여성 2)은 툴팁에 있다.
  ok((await win.getByTestId('reader-voice').innerText()).includes('여성 2') && ((await win.getByTestId('reader-voice').getAttribute('title')) || '').includes('Supertonic 여성 2'),
    '고른 목소리 이름이 낭독자 단추에 뜬다(짧은 이름 · 툴팁에 전체 이름)')
  await win.getByTestId('reader-play').click()
  const read = await win.waitForSelector('[data-testid="reader-phrase"]', { timeout: 60000 }).then(() => true).catch(() => false)
  ok(read, '★그 목소리로 책을 읽는다(읽는 구절이 뜬다)')
  // ★읽는 중일 때만 멈춘다 — 짧은 책은 이미 끝났을 수 있고, 그때 누르면 **다시 읽기 시작한다**(실측: 뒤 검사가 그 탓에 흔들렸다).
  if (await win.getByTestId('reader-play').getAttribute('aria-label') === '낭독 멈추기') await win.getByTestId('reader-play').click()
  await win.waitForFunction(() => document.querySelector('[data-testid="reader-play"]')?.getAttribute('aria-label') === '낭독 시작')
  ok(true, '(낭독을 멈춰 둔다)')

  // ── 4. 엔진 확인 ───────────────────────────────────────────────────
  await win.waitForTimeout(800)
  const log = logText()
  ok(/\[reader\] 만듦 kind=builtin voice=F2\.json/.test(log), '★읽은 소리가 고른 Supertonic 목소리 파일로 만들어졌다(기록)', (log.match(/\[reader\] 만듦.*/g) || []).slice(-3))
  ok(!/\[net\] 바깥 요청을 막았다/.test(log), '바깥으로 나가려 한 요청이 없다')

  // Qwen 지정 목소리(소희)는 따로 본다 — reader-qwen.e2e.mjs (이 검사의 Supertonic 단계를 되풀이하지 않게).
} catch (e) {
  console.error('FAIL', e?.message || e)
  fails.push(String(e?.message || e))
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
  cleanupIsolated(ISO)
}
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
