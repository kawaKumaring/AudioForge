// I5-c 세부 표현 컨트롤 Electron E2E (mock/synthetic, GPU·실합성 없음).
// 검증: 블록 존재·라벨/값 순서(끝 여백 120ms·페이드 8ms·감정 간격 200ms) / padding·fade 스왑 금지(표시·store) /
//   tailMode off|auto·emotionMode immediate|pause store 반영 / pause일 때만 감정 간격 편집 / 범위 밖 값 오류+합성 차단 /
//   신규=auto / 800×600·125/150% 넘침 0 / aria. 참조는 합성 WAV(사용자 미디어 미사용).
import { _electron as electron } from 'playwright'
import fs from 'fs'; import path from 'path'
import { isolatedInput, cleanupIsolated } from './_e2e-helper.mjs'

const APP = process.cwd()
const SRC = (process.env.AF_E2E_REFERENCE || '').trim() || path.join(APP, 'resources', 'speaker_b.wav')
let failed = 0
const log = (...a) => console.log('[i5c-detail]', ...a)
const ok = (c, m) => { log(c ? 'PASS' : 'FAIL', m); if (!c) failed++ }
if (!fs.existsSync(SRC)) { console.error('prerequisite: 참조 자산 없음'); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const { dir: ISO, input: REF } = isolatedInput(SRC)
const pageErrors = []
const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
const win = await app.firstWindow()
win.on('pageerror', e => pageErrors.push(e.message))

const store = () => win.evaluate(() => {
  const s = window.__afStore.getState()
  return { tailMode: s.ttsTailMode, pad: s.ttsTailPaddingMs, fade: s.ttsTailFadeMs, emo: s.ttsEmotionBoundaryMode, gap: s.ttsEmotionBoundaryPauseMs }
})
const rootText = () => win.evaluate(() => document.getElementById('root')?.innerText || '')
const sec = () => win.locator('section[aria-label="세부 표현"]')
const setRange = async (label, v) => {
  // React 제어 range: native value setter + input 이벤트로 onChange 트리거(조용한 clamp 없이 값 반영).
  await win.evaluate(({ label, v }) => {
    const el = [...document.querySelectorAll('input[type=range]')].find(r => r.getAttribute('aria-label') === label)
    if (!el) throw new Error('range not found: ' + label)
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, { label, v })
  await win.waitForTimeout(80)
}

try {
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
  await win.waitForFunction(() => (document.getElementById('root')?.innerText || '').includes('세부 표현'), undefined, { timeout: 30000 })

  // ── 1) 신규 세션 기본 = auto/pause + 라벨/값 순서(스왑 없음) ──
  const s0 = await store()
  ok(s0.tailMode === 'auto', `신규 세션 tailMode=auto(=${s0.tailMode})`)
  ok(s0.pad === 120 && s0.fade === 8 && s0.gap === 200, `기본값 padding=120·fade=8·gap=200(=${s0.pad}/${s0.fade}/${s0.gap})`)
  const sum = await rootText()
  ok(sum.includes('끝 여백 120ms'), '요약에 "끝 여백 120ms" 표시')
  ok(sum.includes('페이드 8ms'), '요약에 "페이드 8ms" 표시')
  ok(sum.includes('쉼 후 200ms'), '요약에 "쉼 후 200ms" 표시')

  // ── 2) 펼치기 + 직접 조절 ON ──
  await sec().getByRole('button', { name: '펼치기' }).click({ timeout: 8000 })
  await sec().getByText('세부 값 직접 조절', { exact: false }).locator('input[type=checkbox]').check()

  // ── 3) padding/fade 스왑 금지(표시·store) ──
  await setRange('끝 여백 (ms)', 90)
  let s1 = await store()
  ok(s1.pad === 90 && s1.fade === 8, `끝 여백 슬라이더 → padding=90·fade 불변 8(=${s1.pad}/${s1.fade})`)
  await setRange('말끝 페이드 (ms)', 15)
  s1 = await store()
  ok(s1.fade === 15 && s1.pad === 90, `페이드 슬라이더 → fade=15·padding 불변 90(=${s1.pad}/${s1.fade})`)
  const disp = await rootText()
  ok(disp.includes('끝 여백') && disp.includes('90ms') && disp.includes('말끝 페이드') && disp.includes('15ms'), '표시도 스왑 없음(끝 여백 90 / 페이드 15)')

  // ── 4) tailMode 토글 ──
  await sec().getByRole('button', { name: '끔' }).click()
  ok((await store()).tailMode === 'off', 'tailMode 끔 → off')
  await sec().getByRole('button', { name: '자동' }).click()
  ok((await store()).tailMode === 'auto', 'tailMode 자동 → auto')

  // ── 5) 감정 전환 모드 + pause일 때만 간격 편집 ──
  await sec().getByRole('button', { name: '즉시' }).click()
  ok((await store()).emo === 'immediate', 'emotionMode 즉시 → immediate')
  const gapDisabledImm = await win.evaluate(() => {
    const el = [...document.querySelectorAll('input[type=range]')].find(r => r.getAttribute('aria-label') === '감정 전환 간격 (ms)')
    return el ? el.disabled : null
  })
  ok(gapDisabledImm === true, `immediate에서 감정 간격 슬라이더 비활성(=${gapDisabledImm})`)
  await sec().getByRole('button', { name: '쉼 후' }).click()
  await setRange('감정 전환 간격 (ms)', 350)
  ok((await store()).gap === 350 && (await store()).emo === 'pause', 'pause에서 감정 간격 편집 → gap=350')

  // ── 6) 범위 밖 값 → 오류 표시 + 합성 차단(조용한 clamp 아님) ──
  // ProcessButton 차단 사유는 우선순위 체인(대사 없음 > 참조 미확정 > ... > 표현). 표현 사유를 표면화하려면
  // 대사·참조 준비를 먼저 만족시켜야 한다(그래야 합성 버튼이 '표현 범위 위반'으로 차단됨을 확인).
  await win.locator('textarea').first().fill('안녕하세요.')
  await win.evaluate(() => window.__afStore.setState({ ttsRefReady: true }))
  await win.evaluate(() => window.__afStore.setState({ ttsTailMode: 'auto', ttsTailPaddingMs: 9999 }))
  await win.waitForTimeout(150)
  const invText = await rootText()
  ok(invText.includes('허용 범위'), '범위 밖 값 → 세부 표현 블록 오류 안내 표시')
  ok((await store()).pad === 9999, `store 값 조용히 clamp 안 됨(=${(await store()).pad})`)
  ok(invText.includes('세부 표현 값이 허용 범위를 벗어났습니다'), '합성 차단 사유 표시(ProcessButton gate)')
  // 복구
  await win.evaluate(() => window.__afStore.setState({ ttsTailPaddingMs: 120 }))

  // ── 7) 반응형 800×600 + 125/150% 가로 넘침 0 ──
  for (const [w, h, zoom] of [[800, 600, ''], [1000, 700, '1.25'], [1000, 700, '1.5']]) {
    await win.setViewportSize({ width: w, height: h })
    await win.evaluate((z) => { document.body.style.zoom = z || '' }, zoom)
    await win.waitForTimeout(120)
    const overflow = await win.evaluate(() => { const r = document.getElementById('root'); return r ? r.scrollWidth - r.clientWidth : 0 })
    ok(overflow <= 2, `${w}x${h} zoom=${zoom || '100%'} 가로 넘침 0(=${overflow}px)`)
  }
  await win.evaluate(() => { document.body.style.zoom = '' })

  // ── 8) aria ──
  const aria = await win.evaluate(() => {
    const s = document.querySelector('section[aria-label="세부 표현"]')
    const exp = s?.querySelector('button[aria-expanded]')
    const seg = s?.querySelector('button[aria-pressed]')
    const rng = [...(s?.querySelectorAll('input[type=range]') || [])].every(r => r.getAttribute('aria-label'))
    return { hasExpanded: !!exp, hasPressed: !!seg, allRangeLabeled: rng }
  })
  ok(aria.hasExpanded && aria.hasPressed && aria.allRangeLabeled, `aria(expanded/pressed/range label) 존재`)

  ok(pageErrors.length === 0, `pageerror 0 (=${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0] : ''})`)
  await win.screenshot({ path: path.join(APP, '_local', 'artifacts', 'diagnostics', 'e2e-shots', 'i5c-detail.png') }).catch(() => {})
} catch (e) {
  failed++; log('EXCEPTION', e?.message || String(e))
} finally {
  await app.close().catch(() => {})
  cleanupIsolated(ISO)
}
log(failed === 0 ? 'ALL PASS' : `${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
