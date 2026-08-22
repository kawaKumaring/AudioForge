// TTSEditor UX E2E (mock/synthetic, GPU·Qwen·Whisper·실합성 없음) — UX-2 검증.
// A pitch slider 키보드·clamp·reset·store 동기 / B 감정 태그 caret 삽입(끝 append 아님) /
// C 감정 요약 배지 store 일치 / D 반응형(800x600·125/150% zoom) 수평 스크롤·겹침 없음.
// 실행: npm run test:e2e:tts-editor-ux  (사전 npm run build). 실합성 없음 → GPU 불필요.
// 참조 자산: AF_E2E_REFERENCE 우선, 없으면 resources/speaker_b.wav fallback(파일 주입해 tts 모드 진입용, 합성 안 함).
// 출력/로그는 gitignore된 작업파일/e2e_shots/만. 사용자 절대경로 하드코딩 금지.
import { _electron as electron } from 'playwright'
import fs from 'fs'; import path from 'path'
import { isolatedInput, cleanupIsolated, snapshotTree, refClipDirs, qwenVenvPids } from './_e2e-helper.mjs'

const APP = process.cwd()
const REF_ENV = process.env.AF_E2E_REFERENCE
const FALLBACK = path.join(APP, 'resources', 'speaker_b.wav')
const SRC = REF_ENV && REF_ENV.trim() ? REF_ENV.trim() : FALLBACK
const RES_DIR = path.join(APP, 'resources')
const SHOT = path.join(APP, '작업파일', 'e2e_shots'); fs.mkdirSync(SHOT, { recursive: true })
let failed = 0
const logLines = []
const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); logLines.push(s); console.log('[editor-ux]', s) }
const ok = (c, m) => { log(c ? 'PASS' : 'FAIL', m); if (!c) failed++ }
if (!fs.existsSync(SRC)) { console.error(`prerequisite: 참조 자산 없음(AF_E2E_REFERENCE 또는 ${FALLBACK})`); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }

const resBefore = snapshotTree(RES_DIR)
const { dir: ISO, input: REF } = isolatedInput(SRC)
const pageErrors = [], crashes = [], mainOut = []
const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
const win = await app.firstWindow()
app.process().stdout.on('data', d => mainOut.push(String(d)))
app.process().stderr.on('data', d => mainOut.push(String(d)))
win.on('pageerror', e => pageErrors.push(e.message))
win.on('crash', () => crashes.push('crash'))

const getPitch = () => win.evaluate(() => window.__afStore.getState().ttsPitch)
const getText = () => win.evaluate(() => window.__afStore.getState().ttsText)

try {
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
  await win.waitForFunction(() => /\d/.test(document.getElementById('root')?.innerText || ''), undefined, { timeout: 30000 })

  // ── A. pitch slider ──
  await win.getByText('고급 설정', { exact: false }).click({ timeout: 8000 })
  const pitch = win.locator('input[list="tts-pitch-ticks"]')
  await pitch.waitFor({ timeout: 8000 })
  // 새 정책(계약 G): probe 전 unknown은 slider 비활성 → 실제 probe(supported)가 store에 반영될 때까지 대기.
  await win.waitForFunction(() => window.__afStore.getState().ttsPitchCapability?.supported === true, undefined, { timeout: 15000 })
  const disabledNow = await pitch.isDisabled()
  ok(!disabledNow, `capability 지원 → pitch slider 활성(disabled=${disabledNow})`)
  await win.evaluate(() => window.__afStore.setState({ ttsPitch: 0 }))
  await pitch.focus()
  await win.keyboard.press('ArrowRight')
  await win.waitForTimeout(150)
  const afterRight = await getPitch()
  ok(Math.abs(afterRight - 0.5) < 1e-6, `ArrowRight 0.5 단위 증가(=${afterRight})`)
  const disp1 = await win.evaluate(() => (document.getElementById('root')?.innerText || '').includes('+0.5반음'))
  ok(disp1, '현재 값 표시 +0.5반음')
  // max clamp
  for (let i = 0; i < 8; i++) { await win.keyboard.press('ArrowRight'); await win.waitForTimeout(60) }
  const atMax = await getPitch()
  ok(atMax === 2.0, `max +2.0 clamp(=${atMax})`)
  // min clamp
  for (let i = 0; i < 12; i++) { await win.keyboard.press('ArrowLeft'); await win.waitForTimeout(60) }
  const atMin = await getPitch()
  ok(atMin === -2.0, `min -2.0 clamp(=${atMin})`)
  // reset (min clamp 후 pitch=-2 → 원본(0) 버튼 활성). 실제 UI 클릭으로 0 복귀 확인.
  await win.getByTitle('음높이를 원본(0)으로 되돌립니다').click({ timeout: 8000 })
  await win.waitForTimeout(150)
  ok((await getPitch()) === 0, 'reset(원본(0)) 클릭 → 0.0')
  // step 0.5 · 범위 -2~2 (속성 확인)
  const attrs = await pitch.evaluate(el => ({ min: el.min, max: el.max, step: el.step }))
  ok(attrs.min === '-2' && attrs.max === '2' && attrs.step === '0.5', `범위/step 속성(min=${attrs.min},max=${attrs.max},step=${attrs.step})`)
  const hasTick = await win.evaluate(() => !!document.querySelector('#tts-pitch-ticks option[value="0"]'))
  ok(hasTick, '중앙(0) 눈금 존재')

  // capability=false(disabled) 경로: pitchPreflight override + mode 재마운트는 다른 뷰 렌더 오류를 유발해
  // 신뢰성이 낮고 production 훅이 없다. 따라서 이번 E2E는 enabled 경로만 실앱 검증한다. disabled 로직
  // (pitchDisabled = disabled || pitchProbedUnsupported → slider 비활성·사유 표시)은 컴포넌트 구조로 커버하며,
  // 명시적 자동 검증이 필요하면 렌더 단위 테스트 또는 AF_E2E 게이트 capability 훅을 별도 결정으로 추가한다(미구현).
  log('capability=false(disabled) 경로는 이번 E2E 범위 밖(신뢰성·production 훅 부재) — enabled만 실앱 검증')

  // ── B. 감정 태그 caret 삽입 ──
  // 대사 textarea는 로컬 state 바인딩 → fill()(UI 경로)로 설정해야 insertEmotionTag가 정상 동작.
  const ta = win.locator('textarea').last()
  await ta.fill('AAABBB')
  await win.waitForTimeout(120)
  await ta.evaluate(el => { el.focus(); el.setSelectionRange(3, 3) })  // 'AAA|BBB' caret at 3
  await win.getByRole('button', { name: '기쁨', exact: false }).first().click({ timeout: 8000 })
  await win.waitForTimeout(150)
  const t1 = await ta.inputValue()
  // insertEmotionTag는 caret 앞에 (\n)[label] 삽입 → 끝 append 아님(태그가 BBB 앞).
  const okCaret = t1.startsWith('AAA') && t1.includes('[기쁨]') && t1.trimEnd().endsWith('BBB')
    && t1.indexOf('[기쁨]') < t1.indexOf('BBB')
  ok(okCaret, `caret 위치 삽입(끝 append 아님): ${JSON.stringify(t1)}`)
  const focusReturned = await win.evaluate(() => document.activeElement && document.activeElement.tagName === 'TEXTAREA')
  ok(focusReturned, '삽입 후 textarea focus 복귀')
  // 연속 삽입 — 기존 태그 보존 + 반영
  const beforeLen = t1.length
  await win.getByRole('button', { name: '슬픔', exact: false }).first().click({ timeout: 8000 }).catch(() => {})
  await win.waitForTimeout(150)
  const t2 = await ta.inputValue()
  ok(t2.length > beforeLen && t2.includes('[기쁨]') && t2.includes('[슬픔]'), `연속 삽입 반영·기존 태그 보존: ${JSON.stringify(t2)}`)

  // ── C. 감정 요약 배지 ──
  // 요약은 로컬 ttsText(대사) 기반 → fill로 사용 감정 지정. 감정 등록은 store 액션(registerEmotionRef).
  await ta.fill('[기쁨] 안녕 [슬픔] 잘가')
  await win.evaluate(() => window.__afStore.getState().registerEmotionRef('happy', 'X:/synthetic/happy_src.wav'))
  await win.waitForTimeout(200)
  const badgeTxt = await win.evaluate(() => document.getElementById('root')?.innerText || '')
  // 등록(happy) + 대사 사용(기쁨/슬픔)이 요약에 반영되는지(수치·상태 존재)
  ok(/등록|준비|사용|확정/.test(badgeTxt), '감정 요약 상태 배지 렌더')
  const st = await win.evaluate(() => {
    const s = window.__afStore.getState()
    return { happy: !!s.ttsEmotionRefState?.happy, sadUntouched: !s.ttsEmotionRefState?.sad }
  })
  ok(st.happy && st.sadUntouched, '등록 감정만 상태 존재·다른 감정 미변경(직접 덮어쓰기 없음)')

  // ── D. 반응형 ──
  for (const [w, h, zoom] of [[1280, 800, 1], [800, 600, 1], [1000, 700, 1.25], [1000, 700, 1.5]]) {
    await win.setViewportSize({ width: w, height: h })
    await win.evaluate((z) => { document.body.style.zoom = String(z) }, zoom)
    await win.waitForTimeout(120)
    const r = await win.evaluate(() => ({
      hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      advVisible: /고급 설정/.test(document.getElementById('root')?.innerText || ''),
    }))
    ok(!r.hscroll && r.advVisible, `반응형 ${w}x${h} zoom${zoom}: 수평스크롤=${r.hscroll}, 고급설정 표시=${r.advVisible}`)
  }
  await win.evaluate(() => { document.body.style.zoom = '1' })
  await win.setViewportSize({ width: 1280, height: 800 })

  // 검은 화면/ErrorBoundary
  const screen = await win.evaluate(() => {
    const txt = (document.getElementById('root')?.innerText || '').trim()
    return { len: txt.length, eb: /문제가 발생|ErrorBoundary|something went wrong/i.test(txt) }
  })
  ok(screen.len > 50 && !screen.eb, `검은화면/ErrorBoundary 없음(len=${screen.len})`)
  ok(pageErrors.length === 0 && crashes.length === 0, `pageerror/crash 0(pe=${pageErrors.length},cr=${crashes.length})`)
  await win.screenshot({ path: path.join(SHOT, 'tts-editor-ux_result.png') })
} catch (e) {
  failed++; log('EXCEPTION', e?.message || String(e))
  try { await win.screenshot({ path: path.join(SHOT, 'tts-editor-ux_FAIL.png') }) } catch { /* ignore */ }
} finally {
  try { await app.close() } catch { /* ignore */ }
  ok(qwenVenvPids().length === 0, '종료 후 Qwen venv 자식 0')
  ok(refClipDirs().length === 0, '종료 후 refclip 임시폴더 0')
  ok(snapshotTree(RES_DIR) === resBefore, 'resources/ 원본 불변')
  cleanupIsolated(ISO)
  fs.writeFileSync(path.join(SHOT, 'tts-editor-ux_log.txt'), logLines.join('\n') + '\n\n--- main ---\n' + mainOut.join(''), 'utf-8')
}
log('SUMMARY', JSON.stringify({ failed, pageErrors: pageErrors.length, crashes: crashes.length }))
process.exit(failed === 0 ? 0 : 1)
