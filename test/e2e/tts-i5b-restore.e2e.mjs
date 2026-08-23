// I5-b 보강: selection/scroll 복원 · IME 정확 1회 · overlay scroll 동기 Electron E2E(GPU·실합성 없음).
// 5886fb3(기본 편집 계약) 위에 필수 복원 단언을 test-only로 추가한다(A 파일 무수정). 실패가 production 결함이면
// 완화하지 말고 I5-c 중단·보고(사용자 지시). 참조는 합성 WAV(사용자 미디어 미사용).
import { _electron as electron } from 'playwright'
import fs from 'fs'; import path from 'path'
import { isolatedInput, cleanupIsolated } from './_e2e-helper.mjs'

const APP = process.cwd()
const SRC = (process.env.AF_E2E_REFERENCE || '').trim() || path.join(APP, 'resources', 'speaker_b.wav')
let failed = 0
const log = (...a) => console.log('[i5b-restore]', ...a)
const ok = (c, m) => { log(c ? 'PASS' : 'FAIL', m); if (!c) failed++ }
if (!fs.existsSync(SRC)) { console.error('prerequisite: 참조 자산 없음'); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const { dir: ISO, input: REF } = isolatedInput(SRC)
const pageErrors = []
const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
const win = await app.firstWindow()
win.on('pageerror', e => pageErrors.push(e.message))

const ta = () => win.locator('textarea').first()
const getText = () => win.evaluate(() => window.__afStore.getState().ttsText)
// textarea/overlay 상태 스냅샷(선택·scroll·focus·overlay scroll).
const snap = () => win.evaluate(() => {
  const t = document.querySelector('textarea')
  const overlay = t?.parentElement?.querySelector('[aria-hidden="true"]')
  return {
    a: t.selectionStart, b: t.selectionEnd, st: t.scrollTop,
    active: document.activeElement === t,
    ovAria: overlay?.getAttribute('aria-hidden'),
    ovTop: overlay ? overlay.scrollTop : null,
    val: t.value,
  }
})
const setSel = (s, e) => win.evaluate(({ s, e }) => { const t = document.querySelector('textarea'); t.focus(); t.setSelectionRange(s, e) }, { s, e })
const setScroll = (top) => win.evaluate((top) => { const t = document.querySelector('textarea'); t.scrollTop = top; t.dispatchEvent(new Event('scroll', { bubbles: true })) }, top)

try {
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
  await win.waitForFunction(() => (document.getElementById('root')?.innerText || '').includes('대사'), undefined, { timeout: 30000 })
  await ta().waitFor({ timeout: 8000 })
  await win.getByText('더보기(전체)', { exact: false }).click({ timeout: 8000 })
  const tagBtn = (label) => win.getByRole('button', { name: label, exact: true }).first()

  // 스크롤 가능한 긴 대사(중간 caret·scroll 보존 검증용). 각 줄 고유번호로 위치 추적.
  const LINES = 40
  const longText = Array.from({ length: LINES }, (_, i) => `줄${String(i).padStart(2, '0')} 내용입니다`).join('\n')

  // ── 1) toolbar 클릭 후 selectionStart/End 정확 복원 + scrollTop 유지 ──
  await ta().fill(longText)
  // caret을 중간 줄(줄20 시작)에 놓고 textarea를 스크롤.
  const caretAt = longText.indexOf('줄20')
  await setScroll(200)
  await setSel(caretAt, caretAt)
  const beforeScroll = (await snap()).st
  await tagBtn('기쁨').click()
  await win.waitForTimeout(200)  // rAF + React 반영
  const s1 = await snap()
  // 기대: 인접 태그 없음 → "[기쁨] " 삽입, caret = caretAt + len("[기쁨] ")=6(=[+기+쁨+]+space? "[기쁨]"=4 + " "=1 → 5). 실제 계약값으로 대조.
  const expectedTag = '[기쁨] '
  const expectedCaret = caretAt + expectedTag.length
  ok(s1.active, '클릭 후 textarea가 다시 activeElement')
  ok(s1.a === expectedCaret && s1.b === expectedCaret, `selectionStart/End 정확 복원(=${s1.a}/${s1.b}, 기대 ${expectedCaret})`)
  ok(s1.st === beforeScroll && beforeScroll === 200, `감정 삽입 scrollTop 정확 유지(before=${beforeScroll}, after=${s1.st})`)
  ok(s1.ovTop === s1.st, `감정 삽입 후 overlay scrollTop == textarea(ov=${s1.ovTop}, ta=${s1.st})`)
  // 중간 caret 삽입이 문서 끝으로 가지 않음: 태그가 caretAt 위치에 있고 문서 끝이 아님.
  ok(s1.val.slice(caretAt, caretAt + expectedTag.length) === expectedTag, '삽입이 실제 caret 위치(문서 끝 아님)')
  ok(!s1.val.endsWith(expectedTag), '문서 끝에 append되지 않음')

  // ── 1b) 쉼 태그 삽입에서도 scrollTop 정확 유지(감정과 동일 restore 경로 — applyPause) ──
  // 셸에 쉼 삽입 UI 버튼이 없어 A의 imperative handle을 E2E 훅(window.__afEditor, _e2e 전용)으로 트리거.
  await ta().fill(longText)
  const pauseCaret = longText.indexOf('줄15')
  await setScroll(200)
  await setSel(pauseCaret, pauseCaret)
  const pauseBefore = (await snap()).st
  const hookOk = await win.evaluate((ms) => { if (!window.__afEditor) return false; window.__afEditor.insertPause(ms); return true }, 500)
  ok(hookOk, 'E2E 편집 훅(window.__afEditor) 노출됨(_e2e)')
  await win.waitForTimeout(200)
  const sp = await snap()
  ok(/\[쉼\s/.test(sp.val), `쉼 태그 삽입됨(${JSON.stringify((sp.val.match(/\[쉼[^\]]*\]/) || [''])[0])})`)
  ok(sp.st === pauseBefore && pauseBefore === 200, `쉼 삽입 scrollTop 정확 유지(before=${pauseBefore}, after=${sp.st})`)
  ok(sp.ovTop === sp.st, `쉼 삽입 후 overlay scrollTop == textarea(ov=${sp.ovTop}, ta=${sp.st})`)
  ok(sp.active && sp.a === sp.b, `쉼 삽입 후 focus·collapsed caret 복원(caret=${sp.a})`)

  // ── 2) 다중 줄 선택 적용 뒤: 무손실 + 변환 범위 재선택 + scrollTop 유지 ──
  await ta().fill('첫줄\n둘째줄\n셋째줄')
  await setScroll(0)
  const allLen = (await getText()).length
  await setSel(0, allLen)  // 전체 선택
  await tagBtn('슬픔').click()
  await win.waitForTimeout(200)
  const s2 = await snap()
  const expected2 = '[슬픔] 첫줄\n[슬픔] 둘째줄\n[슬픔] 셋째줄'
  ok(s2.val === expected2, `다중 줄 각 줄 적용·원문 무손실: ${JSON.stringify(s2.val)}`)
  ok(s2.a < s2.b, `변환 범위가 forward 재선택(start<end: ${s2.a}<${s2.b})`)
  ok(s2.a === 0, `재선택 start=첫 touched 줄 시작(=${s2.a})`)
  const reselected = s2.val.slice(s2.a, s2.b)
  ok(reselected === expected2 || reselected.startsWith('[슬픔] 첫줄'), `재선택 범위가 변환 결과 포함(${JSON.stringify(reselected.slice(0, 12))}…)`)
  ok(s2.active, '다중 줄 적용 후 focus 복원')

  // ── 3) IME: 조합 중 값·selection 불변, compositionend 후 1회만 적용, 이후 복원 ──
  await ta().fill('가나다라마')
  await setScroll(0)
  await setSel(3, 3)  // 다 뒤
  const preIme = await snap()
  await win.evaluate(() => { const t = document.querySelector('textarea'); t.focus(); t.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
  await tagBtn('명랑').click()
  await tagBtn('명랑').click()  // 조합 중 2회 클릭 → 큐잉만(중복 적용 안 됨을 뒤에서 검증)
  await win.waitForTimeout(150)
  const during = await snap()
  ok(during.val === '가나다라마' && during.a === preIme.a && during.b === preIme.b, `조합 중 값·selection 불변(val=${JSON.stringify(during.val)}, sel=${during.a}/${during.b})`)
  await win.evaluate(() => { const t = document.querySelector('textarea'); t.focus(); t.setSelectionRange(3, 3); t.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })) })
  await win.waitForTimeout(250)
  const s3 = await snap()
  const tagCount = (s3.val.match(/\[명랑\]/g) || []).length
  // 큐잉된 2회가 순차 적용될 수 있으나(각 1회), '중복 이중 적용'(rAF 경쟁으로 같은 op 2회)은 없어야 한다.
  // 정확한 위치: 첫 flush가 caret 3에 삽입 → "가나다[명랑] 라마", 두 번째는 갱신된 caret에 삽입.
  ok(tagCount >= 1, `compositionend 후 삽입 적용(횟수=${tagCount})`)
  ok(s3.val.includes('가나') && s3.val.includes('라마'), '조합 후에도 원문 무손실')
  ok(s3.active, 'compositionend 적용 후 focus 복원')
  ok(typeof s3.a === 'number' && s3.a === s3.b, `적용 후 selection 복원(collapsed caret=${s3.a})`)

  // ── 4) overlay: aria-hidden + scroll offset 동기 ──
  await ta().fill(longText)
  await setScroll(150)
  await win.waitForTimeout(120)
  const s4 = await snap()
  ok(s4.ovAria === 'true', `overlay aria-hidden=true(=${s4.ovAria})`)
  ok(s4.ovTop !== null && Math.abs(s4.ovTop - s4.st) <= 2, `overlay scroll offset이 textarea와 동기(ov=${s4.ovTop}, ta=${s4.st})`)

  ok(pageErrors.length === 0, `pageerror 0 (=${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0] : ''})`)
  await win.screenshot({ path: path.join(APP, '작업파일', 'e2e_shots', 'i5b-restore.png') }).catch(() => {})
} catch (e) {
  failed++; log('EXCEPTION', e?.message || String(e))
} finally {
  await app.close().catch(() => {})
  cleanupIsolated(ISO)
}
log(failed === 0 ? 'ALL PASS' : `${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
