// **만들어진 소리의 재생 빠르기** — 다시 만들지 않고 듣는 빠르기만 바꾸는가(실제 앱).
//
// ★지시 (2026-09-30): "만들어진 소리에서 배속을 빠르게 하거나 느리게 하는 기능이 필요하다.
//   일부러 만들 때 배속을 빠르게 한 게 아닌 만들어진 것의 속도를 조절하는 기능이다."
//
// 여기서 보는 것 (기본 목소리 · CPU)
//   1) 낭독 아래 막대에서 1.5배를 고르고 읽으면, 틀고 있는 소리의 빠르기가 1.5이고 음 높이 유지가 켜져 있다
//   2) ★실제로 빨리 흐른다 — 재생 위치가 벽시계 2초에 약 3초 나아간다
//   3) 읽는 도중 0.75배로 바꾸면 **틀고 있는 소리에 즉시** 걸린다
//   4) 다른 조각으로 넘어가도(새 소리 파일) 빠르기가 1배로 돌아가지 않는다
//   5) ★다시 만들지 않는다 — 빠르기를 바꿔도 새로 만든 조각이 없다
//   6) 설정에 남고, ★생성 카드 화면에는 빠르기 고르기가 없다(낭독 전용 — 2026-10-01 지시)
//
// 실행: node test/e2e/playback-rate.e2e.mjs   (사전: npm run build)
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
const BOOK = path.join(ISO, '빠르기 책.txt')
fs.writeFileSync(BOOK, Array.from({ length: 12 }, (_, i) =>
  `${i + 1}번째 문단이다. 그는 천천히 문을 열고 어두운 복도를 내다보았다. 멀리서 물소리가 일정하게 이어졌다.`).join('\n'), 'utf-8')

let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}
const logText = () => fs.readdirSync(path.join(UD, 'logs')).map((n) => fs.readFileSync(path.join(UD, 'logs', n), 'utf-8')).join('')
const settingsJson = () => { try { return JSON.parse(fs.readFileSync(path.join(UD, 'settings.json'), 'utf-8')) } catch { return {} } }

let app = null
try {
  app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, AF_E2E_SELECT_FILE: BOOK, HF_HUB_OFFLINE: '1' } })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)
  if (!((await win.evaluate(() => window.api.cards.builtinVoices()))?.data?.voices || []).length) {
    console.log('SKIP 기본 목소리가 없는 설치입니다')
    await app.close(); cleanupUserData(UD); cleanupIsolated(ISO); process.exit(0)
  }
  // 틀기 시작한 소리 요소를 붙잡는다 — 낭독의 소리 요소는 화면(DOM)에 없다.
  await win.evaluate(() => {
    const orig = HTMLMediaElement.prototype.play
    window.__played = []
    HTMLMediaElement.prototype.play = function () { window.__played.push(this); return orig.call(this) }
  })
  const current = () => win.evaluate(() => {
    const el = window.__played.at(-1)
    return el ? { rate: el.playbackRate, def: el.defaultPlaybackRate, pitch: el.preservesPitch, src: el.src.slice(-40), paused: el.paused, t: el.currentTime } : null
  })

  await win.getByTestId('mode-reader').click()
  await win.getByTestId('reader-add-text').first().click()
  await win.waitForSelector('[data-testid="reader-paragraph"]')

  // ── 1·2. 1.5배로 읽기 ──────────────────────────────────────────────
  await win.getByTestId('reader-rate').selectOption('1.5')
  await win.getByTestId('reader-play').click()
  await win.waitForFunction(() => { const el = window.__played?.at(-1); return !!el && !el.paused && el.currentTime > 0.2 }, null, { timeout: 60000 })
  const a = await current()
  ok(a.rate === 1.5 && a.def === 1.5 && a.pitch === true, '★틀고 있는 소리가 1.5배 · 음 높이 유지', a)
  const t0 = a.t
  await win.waitForTimeout(2000)
  const moved = (await current()).t - t0
  ok(moved > 2.5 && moved < 3.6, '★실제로 빨리 흐른다 — 벽시계 2초에 재생 위치 약 3초', { moved: Number(moved.toFixed(2)) })

  // ── 3. 읽는 도중 0.75배 ─────────────────────────────────────────────
  await win.getByTestId('reader-rate').selectOption('0.75')
  const b = await current()
  ok(b.rate === 0.75 && !b.paused, '★읽는 도중 바꾸면 틀고 있는 소리에 즉시 걸린다', b)
  // ── 5. 다시 만들지 않는다 — 같은 소리 파일이 끊기지 않고 이어서 흐른다(처음으로 돌아가지 않는다) ──
  ok(b.src === a.src && b.t >= t0 + moved - 0.2, '★빠르기를 바꿔도 다시 만들거나 처음부터 틀지 않는다(같은 파일 · 이어서)',
    { same: b.src === a.src, before: Number((t0 + moved).toFixed(2)), after: Number(b.t.toFixed(2)) })

  // ── 4. 다른 조각으로 넘어가도 ───────────────────────────────────────
  const srcBefore = b.src
  await win.getByTestId('reader-paragraph').nth(8).click()
  await win.waitForFunction((s) => { const el = window.__played?.at(-1); return !!el && el.src.slice(-40) !== s && !el.paused }, srcBefore, { timeout: 60000 })
  const c = await current()
  ok(c.rate === 0.75 && c.def === 0.75, '★다른 조각(새 소리 파일)으로 넘어가도 1배로 돌아가지 않는다', c)

  // ── 7. 스피커 음량(2026-10-01 지시) — 읽는 도중 바꾸면 틀고 있는 소리에 곧바로 · 소리 끄기/켜기는 앞 음량으로 · 보관 ──
  await win.getByTestId('reader-volume').fill('0.4')
  await win.getByTestId('reader-volume').dispatchEvent('pointerup')
  const vol1 = await win.evaluate(() => window.__played.at(-1).volume)
  ok(Math.abs(vol1 - 0.4) < 0.01, '★낭독 음량을 바꾸면 틀고 있는 소리에 곧바로 걸린다', vol1)
  await win.getByTestId('reader-mute').click()
  const vol0 = await win.evaluate(() => window.__played.at(-1).volume)
  await win.getByTestId('reader-mute').click()
  const vol2 = await win.evaluate(() => window.__played.at(-1).volume)
  ok(vol0 === 0 && Math.abs(vol2 - 0.4) < 0.01, '★소리 끄기 → 켜기는 앞 음량(40%)으로 돌아온다(100% 로 튀지 않는다)', { vol0, vol2 })
  await win.waitForTimeout(300)
  ok(Math.abs((settingsJson().playbackVolume ?? -1) - 0.4) < 0.01, '음량이 설정에 남는다', settingsJson().playbackVolume)
  // ★검사는 소리를 내지 않는다(2026-10-01 사용자 요청) — 재생은 그대로 흐르고(위 검사들) 스피커로만 나가지 않는다.
  ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => w.webContents.isAudioMuted())),
    '★검사 창은 소리를 내지 않는다(무음)')

  await win.getByTestId('reader-play').click()

  // ── 6. 설정에 남고, 카드 화면도 같은 값 ─────────────────────────────
  await win.waitForTimeout(300)
  ok(settingsJson().playbackRate === 0.75, '설정에 남는다', settingsJson().playbackRate)
  await win.getByTestId('mode-tts').click()
  await win.getByTestId('add-generation-card').first().click()
  await win.getByRole('dialog', { name: '목소리 고르기' }).waitFor()
  await win.getByTestId('pick-voice-builtin').first().click()
  await win.getByTestId('pick-voice-confirm').click()
  await win.getByTestId('generation-card').first().waitFor()
  // ★낭독 전용(2026-10-01 지시) — 생성 카드 화면에는 빠르기 고르기가 없고, 낭독에서 고른 0.75배가 새지 않는다.
  ok(await win.locator('[data-testid="card-rate"], [data-testid="playback-rate"]').count() === 0, '★생성 카드 화면에는 빠르기 고르기가 없다(낭독 전용)')
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
