// 테스트개발 작업실이 **실제로 이어져 있는가**.
//
// 규칙 자체는 단위 시험(src/shared/labWorkspace.test.ts)이 본다. 여기서 보는 것은 배선이다.
//   목소리 고르기 → 대본 → 만들기 → 다시 만들기(새 테이크) → 고르기 → 대사 수정/되돌리기
//   → 전체 듣기 → 내보내기 → 앱을 다시 켜서 복원
//
// ★GPU 생성은 **두 번만** 한다(첫 생성 + 한 번의 재생성). 그 둘을 그대로 재사용해
//   테이크 보존·채택·전체 듣기·내보내기·복원을 전부 확인한다. 반복 생성하지 않는다.
// ★검사 통과는 **연결이 됐다**는 뜻이지, 소리 품질 합격이 아니다. 품질은 사용자가 듣고 판단한다.
//
// 실행: node test/e2e/lab-workspace.e2e.mjs   (사전: npm run build, AF_E2E_REFERENCE)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isolatedInput, cleanupIsolated, isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
const SRC = (process.env.AF_E2E_REFERENCE || '').trim()
if (!SRC || !fs.existsSync(SRC)) {
  console.error('SKIP(prerequisite): AF_E2E_REFERENCE 미설정 — 승인된 참조 음성이 필요합니다(경로 미출력).')
  process.exit(2)
}
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const GEN_MS = Number(process.env.AF_LAB_GEN_MS || 8 * 60 * 1000)   // 생성 한 건 대기 상한
const LINE = '오늘 회의는 세 시에 시작합니다.'                        // 짧은 대본 한 줄
const EDITED = '오늘 회의는 네 시로 옮겨졌습니다.'

const { dir: ISO, input: REF } = isolatedInput(SRC)
const UD = isolatedUserData()                 // 두 번의 실행이 같은 보관 자리를 쓴다
const OUTDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'af-lab-out-'))
const EXPORT_TO = path.join(OUTDIR, 'lab-script.wav')

let failed = 0
const log = (...a) => console.log('[lab]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function launch() {
  const app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: {
      ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD,
      AF_E2E_SELECT_FILE: REF,          // '목소리 고르기' 가 이 파일을 고른 것으로 한다
      AF_E2E_EXPORT_PATH: EXPORT_TO,    // 저장 대화상자 대신 이 자리로 쓴다
    },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  // 이 앱의 껍데기는 **원본 파일을 불러와야** 모드 탭이 나온다(모든 모드 공통, 기존 동작).
  // 그래서 '파일 불러오기' 가 하는 일을 그대로 해 준 뒤 탭을 고른다.
  await win.waitForFunction(() => !!window.__afStore, undefined, { timeout: 30000 })
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
  }, REF)
  await win.getByTestId('mode-lab').waitFor({ timeout: 30000 })
  return { app, win }
}

/** 선택한 줄의 테이크 칩들 — 붙은 꼬리표와 채택 여부. */
const takesOf = (win) => win.evaluate(() =>
  [...document.querySelectorAll('[data-testid="lab-take"]')].map((el) => ({
    adopted: el.getAttribute('data-adopted') === '1',
    badge: el.getAttribute('data-badge') || '',
  })))
const lineStatusAttr = (win) =>
  win.locator('[data-testid="lab-line"]').first().getAttribute('data-line-status')
const statusText = (win) => win.getByTestId('lab-status').textContent()

/** 생성 한 건이 끝날 때까지 기다린다 — 테이크 수가 늘거나, 오류가 뜨거나, 시간이 다 되거나. */
async function waitTake(win, want, limitMs) {
  const t0 = Date.now()
  let lastMsg = ''
  while (Date.now() - t0 < limitMs) {
    const n = await win.locator('[data-testid="lab-take"]').count()
    if (n >= want) return { ok: true, ms: Date.now() - t0 }
    const msg = await win.getByTestId('lab-message').textContent().catch(() => null)
    if (msg && msg !== lastMsg) { lastMsg = msg; log('  화면 알림:', msg.replace('닫기', '').trim()) }
    const busy = await win.getByTestId('lab-cancel').count()
    if (!busy && Date.now() - t0 > 15000 && lastMsg) return { ok: false, ms: Date.now() - t0, msg: lastMsg }
    await sleep(2000)
  }
  return { ok: false, ms: Date.now() - t0, msg: '제한 시간 초과' }
}

let app1 = null, app2 = null
try {
  // ── 1회차 ────────────────────────────────────────────────────────────────
  const first = await launch()
  app1 = first.app
  const win = first.win

  // 탭이 합성 옆에 있는가 + 기존 화면은 그대로인가
  ok(await win.getByTestId('mode-lab').count() === 1, '테스트개발 탭이 있다')
  ok(await win.getByTestId('mode-tts').count() === 1, '합성 탭이 그대로 있다')
  // 합성 화면이 그대로인지 — 탭을 눌러 보고 원래 자리로 돌아온다
  await win.getByTestId('mode-tts').click()
  await win.waitForTimeout(600)
  ok(await win.getByTestId('lab-workspace').count() === 0, '합성 탭에는 새 화면이 끼어들지 않는다')
  await win.getByTestId('mode-lab').click()
  await win.waitForTimeout(500)
  ok(await win.getByTestId('lab-workspace').count() === 1, '작업실 화면이 열린다')

  // 목소리 고르기 → 기존 준비 경로를 탄다
  await win.getByTestId('lab-pick-voice').click()
  const t0 = Date.now()
  while (Date.now() - t0 < 180000) {
    const s = await statusText(win)
    if (s && !/목소리를 먼저|목소리 준비 중/.test(s)) break
    await sleep(1500)
  }
  const label = await win.getByTestId('lab-voice-label').textContent()
  ok(!!label && label.trim().length > 0, '목소리가 걸린다', `(준비 ${Math.round((Date.now() - t0) / 1000)}초)`)

  // 대본 한 줄
  const input = win.getByTestId('lab-line-input').first()
  await input.click()
  await input.fill(LINE)
  await win.waitForTimeout(300)
  ok(await lineStatusAttr(win) === 'none', '대사만 쓰면 "아직 안 만듦"')

  // ── 생성 ①: 첫 성공은 자동 채택 ────────────────────────────────────────
  log('생성 ① 시작 — 실제 합성 경로(GPU/CPU 는 제품 정책대로)')
  await win.getByTestId('lab-line-generate').click()
  const g1 = await waitTake(win, 1, GEN_MS)
  ok(g1.ok, '생성 ① 이 테이크를 남긴다', g1.ok ? `(${Math.round(g1.ms / 1000)}초)` : `(${g1.msg})`)
  if (!g1.ok) throw new Error('생성 ① 실패 — 이후 확인은 의미가 없다')
  await win.waitForTimeout(1500)
  let takes = await takesOf(win)
  ok(takes.length === 1 && takes[0].adopted, '첫 성공 결과가 기본 채택된다')
  ok(await lineStatusAttr(win) === 'ready', '줄 상태가 "준비됨"')

  // 생성이 끝난 **직후** 바로 다시 만들 수 있어야 한다. 예전에는 참조 준비가 다시 돌아
  // 27초 동안 잠겼다 — 왜 잠겼는지 바로 보이도록 상태를 찍어 둔다.
  const gate = await win.evaluate(() => {
    const s = window.__afStore.getState()
    return { status: s.status, refReady: s.ttsRefReady, hasClip: !!s.ttsReferenceClip, refPhase: s.ttsRefPhase }
  })
  log('  생성 후 상태:', JSON.stringify(gate))
  ok(!(await win.getByTestId('lab-line-generate').isDisabled()),
    '생성이 끝나면 곧바로 다시 만들 수 있다', JSON.stringify(gate))

  // ── 생성 ②: 덮지 않고 새 테이크. 채택은 그대로 ──────────────────────────
  log('생성 ② 시작 — 다른 테이크')
  await win.getByTestId('lab-line-generate').click()
  const g2 = await waitTake(win, 2, GEN_MS)
  ok(g2.ok, '다시 만들면 새 테이크가 생긴다', g2.ok ? `(${Math.round(g2.ms / 1000)}초)` : `(${g2.msg})`)
  if (!g2.ok) throw new Error('생성 ② 실패')
  await win.waitForTimeout(1500)
  takes = await takesOf(win)
  ok(takes.length === 2, '이전 파일을 덮지 않는다 — 생성본 2개')
  ok(takes[0].adopted && !takes[1].adopted, '새 테이크가 고른 결과를 자동 교체하지 않는다')

  // 사용자가 두 번째를 고른다
  await win.getByTestId('lab-take-adopt').nth(1).click()
  await win.waitForTimeout(400)
  takes = await takesOf(win)
  ok(!takes[0].adopted && takes[1].adopted, '사용자가 고른 것으로 바뀐다')

  // ── 대사 수정 → 보존 + 꼬리표 ───────────────────────────────────────────
  await input.fill(EDITED)
  await win.waitForTimeout(400)
  takes = await takesOf(win)
  ok(takes.length === 2, '대사를 고쳐도 이전 테이크가 남는다')
  ok(takes.every((t) => t.badge === '수정 전 대사'), '이전 테이크에 "수정 전 대사" 가 붙는다')
  ok(await lineStatusAttr(win) === 'stale_text', '줄이 "수정 전 대사의 결과" 로 표시된다')
  const exportDisabled = await win.getByTestId('lab-export').isDisabled()
  ok(exportDisabled, '준비 안 된 자리가 있으면 내보내기가 막힌다')
  const changed = await win.getByTestId('lab-generate-changed').textContent()
  ok(/\(1\)/.test(changed || ''), '변경된 문장만 다시 만들기 대상이 된다', `"${(changed || '').trim()}"`)

  // 되돌리면 다시 준비됨 — 생성을 더 하지 않고도 원래 결과를 되찾는다
  await input.fill(LINE)
  await win.waitForTimeout(400)
  ok(await lineStatusAttr(win) === 'ready', '대사를 되돌리면 원래 결과가 다시 유효해진다')

  // ── 전체 듣기 ───────────────────────────────────────────────────────────
  await win.evaluate(() => {
    window.__played = []
    const orig = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function patched(...a) {
      window.__played.push({ src: this.src, volume: this.volume })
      return orig.apply(this, a)
    }
  })
  await win.getByTestId('lab-play-all').click()
  await win.waitForTimeout(2500)
  const played = await win.evaluate(() => window.__played || [])
  ok(played.length >= 1, '전체 듣기가 채택된 결과를 실제로 재생한다', `(${played.length}건)`)
  ok(played.every((p) => p.volume <= 1 && p.volume > 0), '공용 음량이 걸린 채로 나간다',
    played.length ? `(volume=${played[0].volume})` : '')

  // ── 내보내기 ────────────────────────────────────────────────────────────
  await win.getByTestId('lab-export').click()
  await win.waitForTimeout(2500)
  ok(fs.existsSync(EXPORT_TO), '내보내기 파일이 만들어진다')
  if (fs.existsSync(EXPORT_TO)) {
    const buf = fs.readFileSync(EXPORT_TO)
    ok(buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE', '내보낸 파일이 WAV 다')
    ok(buf.length > 44, '소리가 실제로 들어 있다', `(${Math.round(buf.length / 1024)}KB)`)
  }
  const msg = await win.getByTestId('lab-message').textContent().catch(() => '')
  log('  내보내기 알림:', (msg || '').replace('닫기', '').trim())

  // 저장이 끝나도록 잠깐 둔다(자동 저장 600ms)
  await win.waitForTimeout(1500)
  await app1.close()
  app1 = null

  // ── 2회차: 앱을 다시 켠다 ───────────────────────────────────────────────
  const second = await launch()
  app2 = second.app
  const win2 = second.win
  await win2.getByTestId('mode-lab').click()
  await win2.waitForTimeout(1500)
  const restoredText = await win2.getByTestId('lab-line-input').first().inputValue()
  ok(restoredText === LINE, '대본이 복원된다')
  await win2.getByTestId('lab-line-input').first().click()   // 조작은 고른 줄 아래에 붙는다
  await win2.waitForTimeout(400)
  const takes2 = await takesOf(win2)
  ok(takes2.length === 2, '테이크가 복원된다', `(${takes2.length}개)`)
  ok(takes2.length === 2 && !takes2[0].adopted && takes2[1].adopted, '고른 결과가 그대로 복원된다')
  ok(await win2.locator('[data-testid="lab-line"]').first().getAttribute('data-line-status') === 'ready',
    '복원 직후 바로 내보낼 수 있는 상태다')
} catch (e) {
  failed++
  log('FAIL 예외:', e && e.message)
} finally {
  if (app1) await app1.close().catch(() => {})
  if (app2) await app2.close().catch(() => {})
  cleanupIsolated(ISO)
  cleanupUserData(UD)
  try { fs.rmSync(OUTDIR, { recursive: true, force: true }) } catch { /* noop */ }
}

log(failed === 0 ? '전부 통과 — 배선 확인. 소리 품질은 사용자가 직접 듣고 판단한다.' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
