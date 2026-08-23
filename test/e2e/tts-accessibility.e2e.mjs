// TTS 접근성 E2E (계약 UX-3 §4~7) — synthetic/mock 상태 구동. GPU·Qwen·Whisper·실합성·미디어 없음.
// 키보드 도달·focus-visible·ARIA(progressbar/alert/status/expanded/label)·반응형·대비/조작영역(참고)·
// 진행 단계·오류 카드(원시 미노출·재시도 접근)·취소 스타일 렌더. 실행: npm run test:e2e:tts-accessibility
import { _electron as electron } from 'playwright'
import fs from 'fs'; import path from 'path'
import { isolatedInput, cleanupIsolated, snapshotTree, refClipDirs, qwenVenvPids } from './_e2e-helper.mjs'

const APP = process.cwd()
const REF_ENV = process.env.AF_E2E_REFERENCE
const SRC = REF_ENV && REF_ENV.trim() ? REF_ENV.trim() : path.join(APP, 'resources', 'speaker_b.wav')
const RES_DIR = path.join(APP, 'resources')
const SHOT = path.join(APP, '작업파일', 'e2e_shots'); fs.mkdirSync(SHOT, { recursive: true })
let failed = 0
const logLines = []
const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); logLines.push(s); console.log('[a11y]', s) }
const ok = (c, m) => { log(c ? 'PASS' : 'FAIL', m); if (!c) failed++ }
const info = (m) => log('INFO', m)
if (!fs.existsSync(SRC)) { console.error('참조 자산 없음'); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const resBefore = snapshotTree(RES_DIR)
const ISO = isolatedInput(SRC)
const pageErrors = [], crashes = []
const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_PITCH_CAPABILITY: 'supported' } })
const win = await app.firstWindow()
win.on('pageerror', e => pageErrors.push(e.message))
win.on('crash', () => crashes.push('crash'))

try {
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, ISO.input)
  await win.waitForFunction(() => /\d/.test(document.getElementById('root')?.innerText || ''), undefined, { timeout: 30000 })
  // 4-flow: 구 '고급 설정' 아코디언 대신 표현/세부 표현 카드의 '펼치기'를 열어 더 많은 focusable(모드 토글·슬라이더) 노출.
  await win.getByRole('button', { name: '펼치기' }).first().click({ timeout: 8000 }).catch(() => {})

  // ── §4A 키보드 도달 + accessible name 수집 (Playwright keyboard로 실제 Tab 순회) ──
  await win.evaluate(() => document.body.focus())
  const order = []
  for (let i = 0; i < 30; i++) {
    await win.keyboard.press('Tab')
    const a = await win.evaluate(() => { const el = document.activeElement; if (!el || el === document.body) return null
      const name = (el.getAttribute('aria-label') || el.getAttribute('title') || (el.tagName === 'BUTTON' ? el.innerText : '') || el.getAttribute('placeholder') || '').trim().slice(0, 24)
      return { tag: el.tagName.toLowerCase(), name, disabled: !!el.disabled } })
    if (a) order.push(a)
  }
  const names = order.map(o => `${o.tag}:${o.name}`)
  info(`Tab 순서(앞 12): ${JSON.stringify(names.slice(0, 12))}`)
  ok(order.length >= 5, `키보드로 도달한 focusable ≥5 (${order.length})`)
  const reachedSlider = order.some(o => o.tag === 'input')
  const reachedButtons = order.filter(o => o.tag === 'button').length
  ok(reachedButtons >= 3, `버튼 키보드 도달 ≥3 (${reachedButtons})`)
  // Shift+Tab 역방향
  await win.keyboard.press('Shift+Tab')
  const backOk = await win.evaluate(() => document.activeElement && document.activeElement !== document.body)
  ok(backOk, 'Shift+Tab 역방향 focus 이동')

  // ── §4B focus-visible: 키보드 focus 시 outline ──
  // 4-flow: 구 '고급 설정' 버튼 대신 표현/세부 표현의 '펼치기' 버튼(항상 존재)에 focus.
  await win.getByRole('button', { name: '펼치기' }).first().focus().catch(() => {})
  const fv = await win.evaluate(() => {
    const el = document.activeElement; if (!el) return null
    const cs = getComputedStyle(el)
    return { outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle, outlineColor: cs.outlineColor, boxShadow: cs.boxShadow }
  })
  info(`focus-visible computed: ${JSON.stringify(fv)}`)
  ok(fv && ((fv.outlineStyle !== 'none' && fv.outlineWidth !== '0px') || (fv.boxShadow && fv.boxShadow !== 'none')), '키보드 focus 시각 표시(outline/boxShadow) 존재')

  // ── §4C ARIA: progressbar (processing) ──
  await win.evaluate(() => { const s = window.__afStore; s.getState().setProcessing(); s.getState().setProgress(0, '준비 중') })
  await win.waitForTimeout(120)
  const pbar = await win.evaluate(() => {
    const el = document.querySelector('[role="progressbar"]'); if (!el) return null
    return { now: el.getAttribute('aria-valuenow'), min: el.getAttribute('aria-valuemin'), max: el.getAttribute('aria-valuemax'), label: el.getAttribute('aria-label') }
  })
  ok(pbar && pbar.min === '0' && pbar.max === '100' && pbar.label, `progressbar role+valuemin/max/label(${JSON.stringify(pbar)})`)

  // ── §5 진행 단계(mock) — 단조 비감소 + 메시지 + CPU 장시간 안내 + 완료 result card ──
  const stages = [[6, 'Qwen 장치: CPU (...) — 문장당 ~30초로 느릴 수 있음'], [10, '모델 로딩 중'], [45, '합성 중... (문장 1/1, 조각 1/3 시작)'], [90, '문장 이어붙이기 중...'], [99, '완료!']]
  const seenNow = []
  let cpuShown = false
  for (const [pct, msg] of stages) {
    await win.evaluate(({ pct, msg }) => window.__afStore.getState().setProgress(pct, msg), { pct, msg })
    await win.waitForTimeout(80)
    const snap = await win.evaluate(() => ({ now: Number(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')), txt: document.getElementById('root')?.innerText || '' }))
    seenNow.push(snap.now)
    if (msg.includes('CPU') && /CPU|느릴 수 있|~30초/.test(snap.txt)) cpuShown = true   // 해당 단계 시점에 확인
  }
  let mono = true; for (let i = 1; i < seenNow.length; i++) if (seenNow[i] < seenNow[i - 1]) mono = false
  ok(mono, `진행 단계 valuenow 단조 비감소(${JSON.stringify(seenNow)})`)
  ok(cpuShown, 'CPU 장시간 안내 표시(해당 진행 단계 시점)')
  // 완료 → result card
  await win.evaluate(() => { const s = window.__afStore; s.getState().setResult([{ name: 'synthesized', label: '합성 음성', path: 'X:/x.wav' }], 'X:/out', { actual_engine: 'qwen3', device: 'cuda:0', requested_engine: 'auto' }) })
  await win.waitForTimeout(150)
  const doneCard = await win.evaluate(() => { const t = document.getElementById('root')?.innerText || ''; return { card: /합성\s*정보/.test(t), processingGone: !/이어붙이기 중|합성 중\.\.\./.test(t) } })
  ok(doneCard.card && doneCard.processingGone, `완료 후 result card 전환·processing UI 잔존 없음(${JSON.stringify(doneCard)})`)

  // ── §6 오류 UX: synthetic 오류 각각 → role=alert 카드·재시도·원시 미노출 ──
  const rawLeak = (t) => /Traceback|File \"|\.py\"|\bat [A-Za-z]|[A-Z]:\\\\|\/home\/|stack/i.test(t)
  const errs = [
    ['GENERATION_LIMIT_EXCEEDED', "GENERATION_LIMIT_EXCEEDED — 감정 'default' 문장이 동적 생성 상한(max_new_tokens=256)에 도달했습니다(생성 반복 256). 참조 오디오와 전사 내용이 맞지 않을 때 나타날 수 있습니다 — 참조 구간/전사를 확인한 뒤 다시 시도하세요."],
    ['TEXT_SEGMENT_TOO_LONG', "TEXT_SEGMENT_TOO_LONG — 감정 'default' 줄이 안전한 단일 합성 길이를 초과합니다. 문장별로 나누거나 줄바꿈을 추가하세요. (production 토큰 500, 허용 33)"],
    ['PITCH_UNAVAILABLE', '음높이 보정(rubberband)을 사용할 수 없습니다. 원본(0)으로 되돌린 뒤 다시 시도하세요.'],
    ['REF_EXPIRED', '확정한 참조 클립이 만료되었습니다 — 참조 구간을 다시 확정하세요.'],
    ['GENERIC', 'Qwen 합성 오류: 알 수 없는 오류가 발생했습니다.'],
  ]
  for (const [tag, msg] of errs) {
    await win.evaluate((m) => window.__afStore.getState().setError(m), msg)
    await win.waitForTimeout(120)
    const card = await win.evaluate(() => {
      const alert = document.querySelector('[role="alert"]')
      const txt = alert?.innerText || ''
      const retry = [...(alert?.querySelectorAll('button') || [])].find(b => /다시 시도|재시도|수정/.test(b.innerText))
      return { hasAlert: !!alert, txt, hasRetry: !!retry, retryFocusable: retry ? (retry.tabIndex >= 0 || retry.tagName === 'BUTTON') : false }
    })
    ok(card.hasAlert && card.txt.length > 5, `[${tag}] role=alert 오류 카드 표시`)
    ok(!rawLeak(card.txt), `[${tag}] 원시 stack/path/전사 미노출`)
    ok(card.hasRetry && card.retryFocusable, `[${tag}] 재시도/수정 버튼 존재·키보드 접근`)
  }
  // 자동 재시도 없음: '다시 시도'는 idle로 되돌리는 dismiss(재합성 자동 실행 아님) — 클릭 후 status idle
  await win.evaluate(() => window.__afStore.getState().setError('테스트 오류'))
  await win.waitForTimeout(80)
  await win.evaluate(() => { const b = [...document.querySelectorAll('[role="alert"] button')].find(x => /다시 시도/.test(x.innerText)); b && b.click() })
  await win.waitForTimeout(120)
  const afterRetry = await win.evaluate(() => ({ status: window.__afStore.getState().status, err: window.__afStore.getState().error }))
  ok(afterRetry.status === 'idle' && !afterRetry.err, '재시도 버튼 = idle 복귀(dismiss). 자동 재합성 없음')
  info('GENERATION_LIMIT 재시도: 전용 재합성 배선 아님 — 공통 "다시 시도"(dismiss→idle) 후 사용자가 재클릭(표시 준비 O / 전용 배선 X, 후속 공용 마감 대상)')

  // ── §7 취소 스타일(synthetic 렌더 가능성) ──
  await win.evaluate(() => { const s = window.__afStore; s.getState().setProcessing(); s.getState().setProgress(30, '합성 중') })
  await win.waitForTimeout(100)
  const cancelBtn = await win.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === '처리 취소'); return { has: !!b } })
  ok(cancelBtn.has, '[취소] 처리 취소 버튼 accessible name 존재(cancelling 스타일은 렌더 가능·실제 전환은 후속)')
  await win.evaluate(() => window.__afStore.setState({ status: 'idle', progress: 0 }))

  // ── §4D 반응형 + 오류 카드 넘침 ──
  await win.evaluate(() => window.__afStore.getState().setError('아주 긴 한국어 오류 문구입니다. '.repeat(6)))
  for (const [w, h, zoom] of [[1280, 800, 1], [800, 600, 1], [1000, 700, 1.25], [1000, 700, 1.5]]) {
    await win.setViewportSize({ width: w, height: h })
    await win.evaluate((z) => { document.body.style.zoom = String(z) }, zoom)
    await win.waitForTimeout(100)
    const r = await win.evaluate(() => {
      const hscroll = document.documentElement.scrollWidth > document.documentElement.clientWidth + 2
      const alert = document.querySelector('[role="alert"]')
      const overflow = alert ? (alert.scrollWidth > alert.clientWidth + 2) : false
      return { hscroll, overflow }
    })
    ok(!r.hscroll && !r.overflow, `반응형 ${w}x${h} zoom${zoom}: 수평스크롤=${r.hscroll}, 오류카드넘침=${r.overflow}`)
  }
  await win.evaluate(() => { document.body.style.zoom = '1'; window.__afStore.setState({ error: null, status: 'idle' }) })
  await win.setViewportSize({ width: 1280, height: 800 })

  // ── §4E 대비·조작영역(참고 기록) ──
  const contrast = await win.evaluate(() => {
    function lum(rgb) { const m = rgb.match(/\d+(\.\d+)?/g); if (!m) return null; const [r, g, b] = m.map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
    function ratio(fg, bg) { const a = lum(fg), b = lum(bg); if (a == null || b == null) return null; const hi = Math.max(a, b), lo = Math.min(a, b); return (hi + 0.05) / (lo + 0.05) }
    function bgOf(el) { let e = el; while (e) { const c = getComputedStyle(e).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; e = e.parentElement } return 'rgb(0,0,0)' }
    const out = []
    for (const sel of ['button', 'input', '[role="alert"] span']) {
      const el = document.querySelector(sel); if (!el) continue
      const cs = getComputedStyle(el)
      out.push({ sel, color: cs.color, bg: bgOf(el), ratio: Math.round((ratio(cs.color, bgOf(el)) || 0) * 100) / 100 })
    }
    // 주요 버튼 bounding box
    const boxes = [...document.querySelectorAll('button')].slice(0, 8).map(b => { const r = b.getBoundingClientRect(); return { name: (b.getAttribute('aria-label') || b.innerText || '').trim().slice(0, 14), w: Math.round(r.width), h: Math.round(r.height) } }).filter(b => b.w > 0)
    return { out, boxes }
  })
  info(`대비 샘플: ${JSON.stringify(contrast.out)}`)
  info(`버튼 조작영역: ${JSON.stringify(contrast.boxes)}`)
  const small = contrast.boxes.filter(b => b.h < 24 || b.w < 24)
  info(`작은 조작영역(<24px, 개선 후보): ${JSON.stringify(small)}`)
  const lowContrast = contrast.out.filter(c => c.ratio && c.ratio < 3)
  ok(lowContrast.length === 0, `대비 3:1 미만 심각 항목 없음(참고, 미달=${JSON.stringify(lowContrast)})`)

  ok(pageErrors.length === 0 && crashes.length === 0, `pageerror/crash 0(pe=${pageErrors.length}, cr=${crashes.length})`)
} catch (e) {
  failed++; log('EXCEPTION', e?.message || String(e))
  try { await win.screenshot({ path: path.join(SHOT, 'a11y_FAIL.png') }) } catch { /* ignore */ }
} finally {
  try { await app.close() } catch { /* ignore */ }
  ok(qwenVenvPids().length === 0, '종료 후 Qwen venv 자식 0')
  ok(refClipDirs().length === 0, '종료 후 refclip 임시폴더 0')
  ok(snapshotTree(RES_DIR) === resBefore, 'resources/ 원본 불변')
  cleanupIsolated(ISO.dir)
  fs.writeFileSync(path.join(SHOT, 'tts-accessibility_log.txt'), logLines.join('\n'), 'utf-8')
}
log('SUMMARY', JSON.stringify({ failed, pageErrors: pageErrors.length, crashes: crashes.length }))
process.exit(failed === 0 ? 0 : 1)
