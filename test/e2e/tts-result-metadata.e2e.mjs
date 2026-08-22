// 생성 metadata 결과 GUI E2E (공용 마감 1) — synthetic setResult 주입. GPU·Qwen·실합성·미디어 없음.
// 다중 chunk 표시·details 열기/닫기·구 session(필드 없음) 숨김·잘못된 타입 무크래시·반응형(800x600·150%).
// 실행: npm run test:e2e:tts-result-metadata
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
const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); logLines.push(s); console.log('[result-meta]', s) }
const ok = (c, m) => { log(c ? 'PASS' : 'FAIL', m); if (!c) failed++ }
if (!fs.existsSync(SRC)) { console.error('참조 자산 없음'); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const resBefore = snapshotTree(RES_DIR)
const ISO = isolatedInput(SRC)
const pageErrors = [], crashes = []
const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
const win = await app.firstWindow()
win.on('pageerror', e => pageErrors.push(e.message))
win.on('crash', () => crashes.push('crash'))

const setResult = (meta) => win.evaluate((m) => {
  const s = window.__afStore
  s.getState().setResult([{ name: 'synthesized', label: '합성 음성', path: 'X:/out/synthesized.wav' }], 'X:/out', m)
}, meta)
const rootText = () => win.evaluate(() => document.getElementById('root')?.innerText || '')

try {
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, ISO.input)
  await win.waitForFunction(() => /\d/.test(document.getElementById('root')?.innerText || ''), undefined, { timeout: 30000 })

  // ── 1. 다중 chunk 정상 metadata ──
  await setResult({
    requested_engine: 'auto', actual_engine: 'qwen3', device: 'cuda:0',
    generation_limit: 253, generated_iterations: 158, termination_reason: 'completed_before_limit',
    generation_chunks: [
      { original_segment_index: 0, chunk_index: 0, chunk_count: 3, production_tokens: 30, generation_limit: 247, generated_iterations: 90, termination_reason: 'completed_before_limit', emotion_id: 'happy' },
      { original_segment_index: 0, chunk_index: 1, chunk_count: 3, production_tokens: 25, generation_limit: 232, generated_iterations: 70, termination_reason: 'completed_before_limit', emotion_id: 'happy' },
      { original_segment_index: 0, chunk_index: 2, chunk_count: 3, production_tokens: 33, generation_limit: 256, generated_iterations: 158, termination_reason: 'completed_before_limit', emotion_id: 'happy' },
    ],
  })
  await win.waitForTimeout(200)
  let txt = await rootText()
  ok(/합성\s*정보/.test(txt), '결과 카드(합성 정보) 표시')
  ok(/생성:\s*안전 범위 내 완료/.test(txt), '기본 카드 생성 요약 표시')
  ok(/반복\s*158\/253/.test(txt), '대표 iters/limit 표시')
  ok(/조각\s*3/.test(txt), '자동분할 조각 수 표시')
  // details 열기
  const summary = win.getByText('상세 정보', { exact: false }).first()
  ok(await summary.count() > 0, 'details 요약 존재')
  await summary.click({ timeout: 8000 }).catch(() => {})
  await win.waitForTimeout(150)
  txt = await rootText()
  ok(/문장 1 · 조각 1\/3/.test(txt) && /문장 1 · 조각 3\/3/.test(txt), 'details per-chunk 표시(문장/조각)')
  ok(/토큰\s*33/.test(txt) && /반복\s*158\/256/.test(txt), 'details 토큰·반복 표시')
  ok(/상한 전 완료/.test(txt), 'details termination 표시')
  // 내용/경로 미노출
  ok(!/synthesized\.wav|X:\/out|Traceback/.test(txt.replace('합성 음성', '')), '전체경로/원시 미노출')

  // ── 2. 구 session(생성 필드 없음) → 생성 요약 숨김·크래시 없음 ──
  await setResult({ requested_engine: 'auto', actual_engine: 'qwen3', device: 'cuda:0' })
  await win.waitForTimeout(150)
  txt = await rootText()
  ok(/합성\s*정보/.test(txt) && !/생성:\s*안전 범위 내 완료/.test(txt), '구 session: 결과 카드 O, 생성 요약 숨김')

  // ── 3. 잘못된 타입 chunk → 무크래시 ──
  await setResult({
    actual_engine: 'qwen3', generation_limit: 'x', generated_iterations: null, termination_reason: 'weird',
    generation_chunks: [null, 3, 'nope', { chunk_index: 0 }],
  })
  await win.waitForTimeout(150)
  txt = await rootText()
  ok(/합성\s*정보/.test(txt), '잘못된 타입 metadata에도 결과 카드 렌더(무크래시)')

  // ── 4. 반응형(다중 chunk 상태로) ──
  await setResult({
    actual_engine: 'qwen3', generation_limit: 256, generated_iterations: 158, termination_reason: 'completed_before_limit',
    generation_chunks: Array.from({ length: 5 }, (_, i) => ({ original_segment_index: 0, chunk_index: i, chunk_count: 5, production_tokens: 30, generation_limit: 250, generated_iterations: 100 + i, termination_reason: 'completed_before_limit' })),
  })
  await win.getByText('상세 정보', { exact: false }).first().click({ timeout: 8000 }).catch(() => {})
  for (const [w, h, zoom] of [[800, 600, 1], [1000, 700, 1.5]]) {
    await win.setViewportSize({ width: w, height: h })
    await win.evaluate((z) => { document.body.style.zoom = String(z) }, zoom)
    await win.waitForTimeout(120)
    const hscroll = await win.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2)
    ok(!hscroll, `반응형 ${w}x${h} zoom${zoom}: 문서 수평 스크롤 없음`)
  }
  await win.evaluate(() => { document.body.style.zoom = '1' })

  ok(pageErrors.length === 0 && crashes.length === 0, `pageerror/crash 0(pe=${pageErrors.length},cr=${crashes.length})`)
} catch (e) {
  failed++; log('EXCEPTION', e?.message || String(e))
} finally {
  try { await app.close() } catch { /* ignore */ }
  ok(qwenVenvPids().length === 0, '종료 후 Qwen venv 자식 0')
  ok(refClipDirs().length === 0, '종료 후 refclip 임시폴더 0')
  ok(snapshotTree(RES_DIR) === resBefore, 'resources/ 원본 불변')
  cleanupIsolated(ISO.dir)
  fs.writeFileSync(path.join(SHOT, 'tts-result-metadata_log.txt'), logLines.join('\n'), 'utf-8')
}
log('SUMMARY', JSON.stringify({ failed, pageErrors: pageErrors.length, crashes: crashes.length }))
process.exit(failed === 0 ? 0 : 1)
