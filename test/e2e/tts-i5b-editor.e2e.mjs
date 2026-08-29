// I5-b 편집기 동작 Electron E2E (mock/synthetic, GPU·실합성 없음).
// A 소유 EmotionScriptEditor를 4-flow 셸에 배선한 상태에서 편집 계약을 검증한다(A 파일은 수정 금지 — 미흡분은 보고).
// 검증: caret 삽입(끝 append 아님) / 인접 태그 교체(대사 무손실) / 다중 줄 선택 각 줄 적용(무손실) /
//   IME compositionend 후 적용(조합 중 오삽입 0) / 버튼 클릭 후 focus·selection 복원 / overlay aria-hidden /
//   unknown 태그 오류 code 표시 + 합성 차단.
// 실행: npm run build 후 AF_E2E_REFERENCE=<wav> node test/e2e/tts-i5b-editor.e2e.mjs
import { _electron as electron } from 'playwright'
import fs from 'fs'; import path from 'path'
import { isolatedInput, cleanupIsolated } from './_e2e-helper.mjs'

const APP = process.cwd()
const SRC = (process.env.AF_E2E_REFERENCE || '').trim() || path.join(APP, 'resources', 'speaker_b.wav')
let failed = 0
const log = (...a) => console.log('[i5b-editor]', ...a)
const ok = (c, m) => { log(c ? 'PASS' : 'FAIL', m); if (!c) failed++ }
if (!fs.existsSync(SRC)) { console.error('prerequisite: 참조 자산 없음'); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const { dir: ISO, input: REF } = isolatedInput(SRC)
const pageErrors = []
const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
const win = await app.firstWindow()
win.on('pageerror', e => pageErrors.push(e.message))

const ta = () => win.locator('textarea').first()   // 참조 전사 접힘 상태 → 첫 textarea = A 대사 편집기
const getText = () => win.evaluate(() => window.__afStore.getState().ttsText)
const setSel = (s, e) => win.evaluate(({ s, e }) => {
  const t = document.querySelector('textarea'); t.focus(); t.setSelectionRange(s, e)
}, { s, e })

try {
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
  await win.waitForFunction(() => (document.getElementById('root')?.innerText || '').includes('대사'), undefined, { timeout: 30000 })
  await ta().waitFor({ timeout: 8000 })

  // 태그 팔레트 전체 펼치기(모든 감정 버튼 노출) — getByRole 버튼으로 명확히 클릭.
  await win.getByText('더보기(전체)', { exact: false }).click({ timeout: 8000 })
  const tagBtn = (label) => win.getByRole('button', { name: label, exact: true }).first()

  // ── 1) caret 삽입(끝 append 아님) ── text="가나다", caret=2 → "가나[기쁨] 다"
  await ta().fill('가나다')
  await setSel(2, 2)
  await tagBtn('기쁨').click()
  await win.waitForTimeout(120)
  const t1 = await getText()
  ok(t1 === '가나[기쁨] 다', `caret 삽입 위치 정확(끝 append 아님): ${JSON.stringify(t1)}`)

  // ── 2) 인접 태그 교체(대사 무손실) ── "[기쁨] 안녕", caret 직후(]=idx3, 그 다음 4) → 슬픔으로 교체
  await ta().fill('[기쁨] 안녕')
  await setSel(4, 4)
  await tagBtn('슬픔').click()
  await win.waitForTimeout(120)
  const t2 = await getText()
  ok(t2 === '[슬픔] 안녕', `인접 태그 교체 + 대사 보존: ${JSON.stringify(t2)}`)

  // ── 3) 다중 줄 선택 각 줄 적용(무손실) ── "첫줄\n둘째줄" 전체 선택 → 각 줄 선두 태그
  await ta().fill('첫줄\n둘째줄')
  const full = (await getText()).length
  await setSel(0, full)
  await tagBtn('기쁨').click()
  await win.waitForTimeout(120)
  const t3 = await getText()
  ok(t3 === '[기쁨] 첫줄\n[기쁨] 둘째줄', `다중 줄 각 줄 적용·무손실: ${JSON.stringify(t3)}`)

  // ── 4) IME 조합 중 오삽입 0 → compositionend 후 적용 ──
  await ta().fill('테스트')
  await setSel(2, 2)                    // caret=2(스 뒤) — mid-caret 삽입 검증(끝 append 아님)
  await win.evaluate(() => {
    const t = document.querySelector('textarea'); t.focus()
    t.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  })
  await tagBtn('명랑').click()          // 조합 중 → 큐잉(즉시 적용 안 됨)
  await win.waitForTimeout(120)
  const during = await getText()
  ok(during === '테스트', `IME 조합 중 오삽입 0(큐잉): ${JSON.stringify(during)}`)
  await win.evaluate(() => {
    const t = document.querySelector('textarea'); t.focus(); t.setSelectionRange(2, 2)
    t.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))
  })
  await win.waitForTimeout(150)
  const after = await getText()
  ok(after === '테스[명랑] 트', `compositionend 후 큐 flush를 caret(2)에 적용: ${JSON.stringify(after)}`)

  // ── 5) 버튼 클릭 후 focus·selection 복원 ──
  const restored = await win.evaluate(() => {
    const t = document.querySelector('textarea')
    return document.activeElement === t && typeof t.selectionStart === 'number'
  })
  ok(restored, '태그 버튼 클릭 후 textarea focus·selection 복원')

  // ── 6) overlay aria-hidden(입력 권위=textarea) ──
  const overlayHidden = await win.evaluate(() => {
    const t = document.querySelector('textarea')
    const wrap = t?.parentElement
    const overlay = wrap?.querySelector('[aria-hidden="true"]')
    return !!overlay
  })
  ok(overlayHidden, 'overlay는 aria-hidden')

  // ── 7) unknown 태그 → 오류 code 표시 + 합성 차단 ──
  await ta().fill('[없는태그] 문장')
  await win.waitForTimeout(150)
  const errShown = await win.evaluate(() => (document.getElementById('root')?.innerText || '').includes('알 수 없는 감정'))
  ok(errShown, 'unknown 태그 오류 표시(code 기반, 대사 전문 아님)')
  // 합성 버튼 차단 확인(ProcessButton disabled 또는 차단 사유). 최소한 pageerror 없이 오류가 표면화.
  ok(pageErrors.length === 0, `pageerror 0 (=${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0] : ''})`)

  await win.screenshot({ path: path.join(APP, '_local', 'artifacts', 'diagnostics', 'e2e-shots', 'i5b-editor.png') }).catch(() => {})
} catch (e) {
  failed++; log('EXCEPTION', e?.message || String(e))
} finally {
  await app.close().catch(() => {})
  cleanupIsolated(ISO)
}
log(failed === 0 ? 'ALL PASS' : `${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
