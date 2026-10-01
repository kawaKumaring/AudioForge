// 낭독 — **Qwen 지정 목소리(소희)만** 본다. 다른 기본 목소리는 거치지 않는다.
//
// ★왜 따로 두나 (2026-09-30 사용자 지적: "테스트를 할 거면 Qwen 을 테스트해야 하는데 자꾸 기본을 반복하는 이유는")
//   목소리 고르기 검사(reader-voices)는 Supertonic 단계를 먼저 거쳐, Qwen 만 보고 싶을 때도 매번 그것을 되풀이했고
//   앞 단계의 흔적(앞서 만들던 조각)이 Qwen 판정에 섞였다. 여기서는 책을 열고 곧바로 Qwen 을 고른다.
//
// 여기서 보는 것
//   1) 목록에 Qwen 소희가 있고 이름표에 느리다고 적힌다
//   2) ★고르기만 해서는 GPU 로 만들지 않는다 — 공용 판정에 '낭독 중' 이 한 번도 서지 않는다(4초)
//   3) (AF_E2E_GPU=1) 누르면 소희로 읽는다 — 만드는 동안 합성이 비키고, 읽는 구절이 뜬다
//
// 실행: node test/e2e/reader-qwen.e2e.mjs   (사전: npm run build)   · AF_E2E_GPU=1 이면 3) 까지(1분 남짓)
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
// 틀고 있는지 볼 동안 끝나지 않을 만큼 — 한 덩이가 약 20초 분량이 되게.
fs.writeFileSync(BOOK, Array.from({ length: 6 }, (_, i) =>
  `${i + 1}번째 문단이다. 그는 천천히 문을 열고 어두운 복도를 내다보았다. 멀리서 물소리가 일정하게 이어졌다.`).join('\n'), 'utf-8')

let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}
import { execSync } from 'child_process'
/** 떠 있는 Qwen 상주 실행기 수 — 고아로 남으면 그래픽카드 메모리를 붙든다. */
// ★따옴표를 거치지 않게 명령을 부호화해 넘긴다(처음엔 따옴표가 깨져 늘 -1 이 나왔다).
const COUNT_PS = Buffer.from("@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -like '*qwen_voice_server*' }).Count", 'utf16le').toString('base64')
const serverCount = () => { try { return Number(execSync(`powershell -NoProfile -EncodedCommand ${COUNT_PS}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) } catch { return -1 } }
const logText = () => fs.readdirSync(path.join(UD, 'logs')).map((n) => fs.readFileSync(path.join(UD, 'logs', n), 'utf-8')).join('')

let app = null
try {
  app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, AF_E2E_SELECT_FILE: BOOK, HF_HUB_OFFLINE: '1', AF_E2E_QWEN_IDLE_MS: '6000' } })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)
  const voices = (await win.evaluate(() => window.api.cards.builtinVoices()))?.data?.voices || []
  // 소희를 이름(modelId)으로 찾는다 — 2026-10-01 부터 Qwen 목소리가 여덟이라 '첫 Qwen' 은 소희가 아니다.
  const qwen = voices.find((v) => v.engineId === 'qwen-custom' && v.modelId === 'sohee')
  if (!qwen) {
    console.log('SKIP Qwen 지정 목소리를 받아 두지 않은 설치입니다')
    await app.close(); cleanupUserData(UD); cleanupIsolated(ISO); process.exit(0)
  }
  ok(/소희/.test(qwen.label) && /시작 느림/.test(qwen.label), 'Qwen 소희가 목록에 오르고 이름표에 시작이 느리다고 적힌다', qwen.label)

  await win.getByTestId('mode-reader').click()
  await win.getByTestId('reader-add-text').first().click()
  await win.waitForSelector('[data-testid="reader-paragraph"]')

  // ── 2. 고르기만 — GPU 로 만들지 않는다 ─────────────────────────────
  await win.getByTestId('reader-voice').click()
  await win.getByRole('dialog', { name: '목소리 고르기' }).waitFor()
  const rows = await win.getByTestId('reader-voice-builtin').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || ''))
  const qi = rows.findIndex((t) => t.includes('소희'))
  ok(qi >= 0 && /소희/.test(await win.getByTestId('reader-voice-builtin').nth(qi).innerText()), '★소희는 짧은 이름(소희)으로 고른다', rows)
  await win.getByTestId('reader-voice-builtin').nth(qi).click()
  await win.getByTestId('reader-voice-confirm').click()
  const busySeen = []
  for (let i = 0; i < 16; i++) {
    const why = await win.evaluate(() => window.api.audio.e2eBusyReason('합성'))
    if (why) busySeen.push(why)
    await win.waitForTimeout(250)
  }
  // 소희 것만 센다 — 앞서 쓰던 기본 목소리의 미리 만들기(CPU)는 이 규칙과 무관하다.
  const madeLines = (logText().match(/\[reader\] (만듦|만들지 못함).*/g) || []).filter((l) => /voice=config\.json/.test(l))
  if (process.env.AF_E2E_GPU === '1') {
    // ★GPU 검사에서는 고르는 순간 **모델만 미리 연다**(2026-10-01 — 첫 소리의 모델 열기 약 10초를 누르기 전에 치른다).
    //   소리는 만들지 않는다. 여는 동안 다른 합성이 비키는 사유는 낭독의 것이어야 한다.
    ok(madeLines.length === 0 && busySeen.every((w) => /낭독/.test(w)), '★고르면 모델만 미리 연다 — 소리는 누를 때 만든다', { busy: busySeen.slice(0, 2), made: madeLines.slice(-3) })
  } else {
    ok(busySeen.length === 0 && madeLines.length === 0, '★고르기만 해서는 GPU 로 만들지 않는다(누를 때 만든다)', { busy: busySeen.length, made: madeLines.slice(-3) })
  }

  // ── 3. 누르면 소희로 읽는다 ────────────────────────────────────────
  if (process.env.AF_E2E_GPU === '1') {
    const t0 = Date.now()
    await win.getByTestId('reader-play').click()
    let sawBusy = false
    for (let i = 0; i < 40 && !sawBusy; i++) {
      sawBusy = !!(await win.evaluate(() => window.api.audio.e2eBusyReason('합성')))
      if (!sawBusy) await win.waitForTimeout(250)
    }
    ok(sawBusy, '★소희로 만드는 동안 다른 화면의 합성이 비킨다(GPU)')
    // ★읽는 구절 표시는 누르는 순간 뜬다 — 소리가 났다는 증거가 아니다(처음엔 그것으로 통과시켰다).
    //   증거는 Qwen 모델로 만든 조각의 기록이다. 한 조각에 40초 남짓 — 3분까지 기다린다.
    let logged = false
    for (let i = 0; i < 360 && !logged; i++) {
      logged = /\[reader\] 만듦 kind=builtin voice=config\.json/.test(logText())
      if (!logged) await win.waitForTimeout(500)
    }
    ok(logged, '★누르면 소희(Qwen 모델)로 조각을 만든다(기록)',
      { sec: Math.round((Date.now() - t0) / 1000), reader: (logText().match(/\[reader\] .*/g) || []).slice(-3) })
    // 만든 조각을 실제로 틀었는가 — 낭독의 '기다림' 문구가 사라지고 재생 중이다.
    const playingNow = await win.waitForFunction(() =>
      document.querySelector('[data-testid="reader-play"]')?.getAttribute('aria-label') === '낭독 멈추기'
      && !/만드는 중|기다리는 중/.test(document.querySelector('[data-testid="reader-controls"]')?.textContent || ''),
    null, { timeout: 20000 }).then(() => true).catch(() => false)
    ok(playingNow, '★만든 소희 소리를 틀고 있다(기다림 문구 없음)')

    // ── 4. 띄워 둔 실행기 — 둘째 조각부터는 모델을 다시 열지 않고, 듣는 속도보다 빨리 만든다 ──────
    const qwenLines = () => (logText().match(/\[reader\] 만듦 kind=builtin voice=config\.json.*/g) || [])
    for (let i = 0; i < 240 && qwenLines().length < 2; i++) await win.waitForTimeout(500)
    const [first, second] = qwenLines()
    const num = (l, key) => Number((l || '').match(new RegExp(`${key}=([\\d.]+)s`))?.[1])
    const total2 = Number((second || '').match(/ ([\d.]+)s 상주/)?.[1])
    // ★모델은 고를 때 미리 열었다 — 두 조각 모두 띄워 둔 실행기로 만들고, 조각에서 모델을 여는 일이 없다.
    const log0 = logText()
    ok(/Qwen 상주 실행기 띄움/.test(log0) && log0.indexOf('Qwen 상주 실행기 띄움') < log0.indexOf(first || '\u0000')
      && /상주/.test(first || '') && /상주/.test(second || '') && !/모델 엶/.test(first || '') && !/모델 엶/.test(second || ''),
      '★고를 때 연 모델로 첫 조각부터 만든다(조각에서 모델을 다시 열지 않는다)', { first, second })
    ok(total2 > 0 && total2 < num(second, '소리'), '★둘째 조각은 듣는 속도보다 빨리 만든다(실시간 낭독)', { 만든시간: total2, 소리: num(second, '소리') })
    console.log('INFO 첫 조각:', (first || '').replace(/^.*\[reader\] /, ''))
    console.log('INFO 둘째 조각:', (second || '').replace(/^.*\[reader\] /, ''))
    if (await win.getByTestId('reader-play').getAttribute('aria-label') === '낭독 멈추기') await win.getByTestId('reader-play').click()

    // ── 5. 한동안 안 쓰면 내린다(검사에서는 6초) — 그래픽카드 메모리를 돌려준다 ─────────────
    let unloaded = false
    for (let i = 0; i < 180 && !unloaded; i++) {
      unloaded = /Qwen 상주 실행기 내림\(한동안 안 씀\)/.test(logText())
      if (!unloaded) await win.waitForTimeout(500)
    }
    await win.waitForTimeout(1500)
    ok(unloaded && serverCount() === 0, '★한동안 안 쓰면 실행기를 내린다(프로세스가 남지 않는다)', { unloaded, 남은수: serverCount() })
  } else {
    console.log('SKIP 소희로 읽기 — GPU 로 1분 남짓(AF_E2E_GPU=1 일 때만)')
  }
} catch (e) {
  console.error('FAIL', e?.message || e)
  fails.push(String(e?.message || e))
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
  cleanupIsolated(ISO)
}
// ★앱을 닫은 뒤 실행기가 남지 않는다(고아 금지) — GPU 검사를 돌렸을 때만 의미가 있다.
if (process.env.AF_E2E_GPU === '1') {
  await new Promise((r) => setTimeout(r, 2000))
  ok(serverCount() === 0, '★앱을 닫으면 Qwen 상주 실행기도 남지 않는다', serverCount())
}
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
