// TTSEditor UX E2E (mock/synthetic, GPU·Qwen·Whisper·실합성 없음) — UX-2 검증.
// A pitch slider 키보드·clamp·reset·store 동기 / B 감정 태그 caret 삽입(끝 append 아님) /
// C 감정 요약 배지 store 일치(고급 설정 > 음성 탭) / D 반응형(800x600·125/150% zoom) 수평 스크롤·겹침 없음.
// 실행: npm run test:e2e:tts-editor-ux  (사전 npm run build). 실합성 없음 → GPU 불필요.
// 참조 자산: AF_E2E_REFERENCE 우선, 없으면 이번 실행 전용 합성 WAV(파일 주입해 tts 모드 진입용, 합성 안 함).
// 출력/로그는 비추적 _local/artifacts/diagnostics/e2e-shots 만. 사용자 절대경로 하드코딩 금지.
import { _electron as electron } from 'playwright'
import fs from 'fs'; import path from 'path'; import os from 'os'
import {
  isolatedInput, cleanupIsolated, snapshotTree, refClipDirs, qwenVenvPids,
  makeSyntheticWav, cleanupSyntheticWav,
} from './_e2e-helper.mjs'

const APP = process.cwd()
const REF_ENV = process.env.AF_E2E_REFERENCE
// 저장소에 추적된 오디오 자산은 없다. 이 테스트는 '파일 하나' 만 있으면 되므로 이번 실행
// 전용 합성 WAV 를 쓴다. 본체 저장소를 뒤지면 그 PC 에서만 되는 검증이 된다.
const SYNTH = makeSyntheticWav(
  path.join(os.tmpdir(), 'af_e2e_' + randomUUID() + '.wav'), 12)
const SRC = REF_ENV && REF_ENV.trim() ? REF_ENV.trim() : SYNTH
const RES_DIR = path.join(APP, 'resources')
const SHOT = path.join(APP, '_local', 'artifacts', 'diagnostics', 'e2e-shots'); fs.mkdirSync(SHOT, { recursive: true })
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

  // ── A. pitch slider (표현 흐름 ExpressionControls) ──
  // 구 '고급 설정'의 datalist 슬라이더(input[list=tts-pitch-ticks]) + '원본(0)' 버튼 + 중앙 눈금은 재설계로 이동:
  //   pitch → ExpressionControls의 음높이 SliderRow(role=slider, name=음높이).
  //   '원본(0)' 리셋 → 슬라이더를 0으로(동일 기능). 중앙 눈금 → 방향 라벨(낮고 묵직함/높고 가볍게)로 대체.
  //
  // 이관(2026-08-31): 이 블록은 `section[aria-label="표현"]` 을 찾다가 8초 타임아웃으로 실패하고
  // 있었다. 그런 이름의 섹션은 **없다** — 재설계 뒤 기본 화면은 `말하는 느낌`, 고급 쪽은
  // `표현 세부` 다. 제품 게이팅은 정상이고 테스트가 낡은 쪽이었다.
  // 옛 접근 절차(카드 펼치기 → '세부 조절 사용' 체크)도 사라졌다. 지금 계약은 음높이·속도가
  // **기본 노출 축**이라는 것이므로, 그 두 단계를 지우는 대신 '추가 조작 없이 활성' 을
  // 단언한다 — 옛 단언(`capability 지원 + 세부 조절 → 활성`)보다 좁지 않고 더 강하다.
  await win.waitForFunction(() => window.__afStore.getState().ttsPitchCapability?.supported === true, undefined, { timeout: 15000 })
  const exprSec = win.locator('section[aria-label="말하는 느낌"]')
  await exprSec.waitFor({ timeout: 8000 })
  ok(await exprSec.getByRole('button', { name: '펼치기' }).count() === 0,
    "기본 화면 '말하는 느낌' 은 펼치기 없이 바로 보인다")
  const pitch = exprSec.getByRole('slider', { name: '음높이' })
  await pitch.waitFor({ timeout: 8000 })
  const disabledNow = await pitch.isDisabled()
  ok(!disabledNow, `capability 지원 → pitch slider 가 추가 조작 없이 활성(disabled=${disabledNow})`)
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
  // 구 '원본(0)' 버튼 대체: 같은 기능(pitch 0 복귀)을 새 슬라이더로 검증.
  await pitch.evaluate(el => { const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(el, '0'); el.dispatchEvent(new Event('input', { bubbles: true })) })
  await win.waitForTimeout(150)
  ok((await getPitch()) === 0, '슬라이더로 0 복귀 — 구 원본(0) 리셋과 동일 기능')
  // step 0.5 · 범위 -2~2 (속성 확인)
  const attrs = await pitch.evaluate(el => ({ min: el.min, max: el.max, step: el.step }))
  ok(attrs.min === '-2' && attrs.max === '2' && attrs.step === '0.5', `범위/step 속성(min=${attrs.min},max=${attrs.max},step=${attrs.step})`)
  // 구 datalist 중앙(0) 눈금 대체: ExpressionControls 방향 라벨.
  const endLabels = await win.evaluate(() => { const t = document.getElementById('root')?.innerText || ''; return t.includes('낮고 묵직함') && t.includes('높고 가볍게') })
  ok(endLabels, '음높이 방향 라벨(낮고 묵직함/높고 가볍게) 표시 — 구 중앙(0) 눈금 대체')

  // capability=false(disabled) 경로는 이번 E2E 범위 밖(production capability 훅 부재) — enabled만 실앱 검증.
  // (capability=false 로직은 ttsExpressionCapabilities.test.ts + tts-pitch-capability E2E가 별도 커버.)
  log('capability=false(disabled) 경로는 이번 E2E 범위 밖 — enabled 경로만 실앱 검증')

  // ── B. 감정 태그 caret 삽입 ──
  // 대사 textarea는 로컬 state 바인딩 → fill()(UI 경로)로 설정해야 insertEmotionTag가 정상 동작.
  // 4-flow: 대사 편집기는 '대사' 섹션의 textarea(A EmotionScriptEditor) — 의미 기반 셀렉터로 특정.
  const ta = win.locator('section[aria-label="대사"] textarea').first()
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
  // 이관(2026-08-31): 이 배지는 기본 화면에 없다. 재설계로 EmotionReferenceManager 가
  // '고급 설정 > 음성' 탭 안으로 들어갔고(TTSEditor 의 voice 슬롯), 고급 설정은 기본이 닫힘이다.
  // 제품 배치가 맞고 테스트가 낡았던 쪽이므로, 배지 단언을 지우는 대신 **도달 경로까지**
  // 함께 검사한다 — 열기 → 음성 탭 → 배지.
  const adv = win.locator('section[aria-label="고급 설정"]')
  await adv.getByRole('button', { name: '열기' }).click({ timeout: 8000 })
  await adv.getByRole('tab', { name: '음성' }).click({ timeout: 8000 })
  await win.waitForTimeout(250)
  const badgeTxt = await win.evaluate(() => document.getElementById('root')?.innerText || '')
  // 4-flow: 감정 요약은 EmotionReferenceManager — "감정 음성 N개 등록됨" + 준비/확정 배지.
  ok(/감정 음성/.test(badgeTxt) && /등록|준비|확정/.test(badgeTxt), '감정 요약 상태 배지 렌더(EmotionReferenceManager)')
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
      // 이관(2026-08-31): 마커를 '세부 표현' 에서 **기본 화면에 실제로 있는 것**으로 바꾼다.
      // '세부 표현' 은 고급 설정 안으로 들어가 기본 화면 innerText 에 없다 — 그것을 도달성
      // 지표로 쓰면 창 크기와 무관하게 늘 false 다. 검사 의도(좁은 화면에서도 주 흐름이
      // 무너지지 않는다)는 기본 화면의 두 축으로 그대로 지킨다.
      flowVisible: !!document.querySelector('section[aria-label="말하는 느낌"]')
        && !!document.querySelector('section[aria-label="대사"] textarea'),
    }))
    ok(!r.hscroll && r.flowVisible, `반응형 ${w}x${h} zoom${zoom}: 수평스크롤=${r.hscroll}, 주 흐름 표시=${r.flowVisible}`)
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
  cleanupSyntheticWav(SYNTH)
  fs.writeFileSync(path.join(SHOT, 'tts-editor-ux_log.txt'), logLines.join('\n') + '\n\n--- main ---\n' + mainOut.join(''), 'utf-8')
}
log('SUMMARY', JSON.stringify({ failed, pageErrors: pageErrors.length, crashes: crashes.length }))
process.exit(failed === 0 ? 0 : 1)
