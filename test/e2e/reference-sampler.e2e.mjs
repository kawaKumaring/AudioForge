// 묶음 A 전용 E2E — 참조 라이브러리 등록부터 감정 샘플 캐시·미리듣기·삭제까지.
//
// 실제 GPU·모델·사용자 미디어를 쓰지 않는다. 참조 원본은 이번 실행이 만든 synthetic WAV 이고,
// 감정 샘플 생성은 AF_E2E 게이트의 가짜 runner 결과로 대체한다.
// 실행: node test/e2e/reference-sampler.e2e.mjs   (사전 npm run build)
import { _electron as electron } from 'playwright'
import { randomUUID, createHash } from 'crypto'
import fs from 'fs'; import path from 'path'; import os from 'os'
import { makeSyntheticWav, cleanupSyntheticWav } from './_e2e-helper.mjs'

const APP = process.cwd()
let failed = 0
const ok = (c, m) => { console.log(c ? '[reflib-sampler] PASS' : '[reflib-sampler] FAIL', m); if (!c) failed++ }
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex')

if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

// 격리된 userData — 사용자의 실제 라이브러리를 절대 건드리지 않는다.
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'af_e2e_userdata_'))
const SRC = makeSyntheticWav(path.join(os.tmpdir(), 'af_e2e_ref_' + randomUUID() + '.wav'), 12)
const SRC_SHA_BEFORE = sha(SRC)
const REF_ROOT = path.join(USER_DATA, 'reference-library')
const CACHE_ROOT = path.join(USER_DATA, 'emotion-sampler-cache')
const TRANSCRIPT = '안녕하세요. 오늘은 날씨가 참 좋습니다.'

const launch = () => electron.launch({
  args: ['out/main/index.js'], cwd: APP,
  env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: USER_DATA },
})

const pageErrors = []
const listDir = (d) => { try { return fs.readdirSync(d) } catch { return [] } }
const stagingLeft = () => [
  ...listDir(path.join(REF_ROOT, 'staging')),
  ...listDir(path.join(CACHE_ROOT, 'staging')),
]

let app = await launch()
let win = await app.firstWindow()
win.on('pageerror', (e) => pageErrors.push(String(e)))
let referenceId = null

try {
  await win.waitForLoadState('domcontentloaded')

  // ── 등록: 경로는 이 요청에서만 오간다 ──────────────────────────────────
  const imported = await win.evaluate(async ([p, t]) => window.api.referenceLibrary.import({
    filePath: p, regionStartMs: 1000, regionDurationMs: 4000, transcript: t, transcriptLanguage: 'ko',
  }), [SRC, TRANSCRIPT])
  ok(imported.ok === true, `참조 등록 성공 (${imported.ok ? 'ok' : imported.reason})`)
  referenceId = imported.referenceId
  ok(/^[0-9a-f]{16}$/.test(referenceId || ''), '참조 ID 는 논리 ID 형식')

  // ── 목록 ────────────────────────────────────────────────────────────────
  let list = await win.evaluate(() => window.api.referenceLibrary.list())
  ok(list.status === 'ok' && list.items.length === 1, '목록에 1건')
  ok(list.items[0].transcript === 'present', '전사 상태 present')
  ok(list.items[0].ready === true, '무결성 통과(ready)')
  const listBlob = JSON.stringify(list)
  ok(!listBlob.includes(TRANSCRIPT), '목록에 전사 원문 없음')
  ok(!listBlob.includes(USER_DATA) && !listBlob.includes('.wav'), '목록에 절대 경로 없음')

  // ── 선택 ────────────────────────────────────────────────────────────────
  const sel = await win.evaluate((id) => window.api.referenceLibrary.select(id), referenceId)
  ok(sel.ok === true, '참조 선택 성공')

  // ── 전사 없는 참조는 생성이 막힌다 ───────────────────────────────────────
  const noTx = await win.evaluate(async (p) => window.api.referenceLibrary.import({
    filePath: p, regionStartMs: 6000, regionDurationMs: 3000, transcript: '',
  }), SRC)
  ok(noTx.ok === true, '전사 없이도 등록 자체는 된다')
  const listed2 = await win.evaluate(() => window.api.referenceLibrary.list())
  const noTxItem = listed2.items.find((i) => i.referenceId === noTx.referenceId)
  ok(noTxItem?.transcript === 'TRANSCRIPT_MISSING', '전사 없음이 상태로 드러난다')
  await win.evaluate((id) => window.api.referenceLibrary.select(id), noTx.referenceId)
  const blocked = await win.evaluate((id) => window.api.sampler.generate({ referenceId: id, rowId: 'emotion_happy' }), noTx.referenceId)
  ok(blocked.ok === false && blocked.reason === 'TRANSCRIPT_MISSING', `전사 없음 → 생성 차단 (${blocked.reason})`)

  // 다시 정상 참조로 선택 복귀
  await win.evaluate((id) => window.api.referenceLibrary.select(id), referenceId)

  // ── capability 차단 ─────────────────────────────────────────────────────
  for (const rowId of ['laugh_chuckle', 'punct_vowel_extend']) {
    const r = await win.evaluate(([id, row]) => window.api.sampler.generate({ referenceId: id, rowId: row }), [referenceId, rowId])
    ok(r.ok === false && r.reason === 'CAPABILITY_NOT_USABLE', `${rowId} → capability 차단`)
  }

  // ── 실패 경로: final 캐시에 아무것도 남지 않는다 ─────────────────────────
  for (const [mode, reason] of [['error', 'RUN_FAILED'], ['cancelled', 'CANCELLED'], ['limit', 'LIMIT_EXCEEDED'], ['no-result', 'NO_RESULT'], ['silent', 'CLIP_SILENT']]) {
    await app.evaluate(({ }, m) => { globalThis.__afSamplerFake = m }, mode)
    const r = await win.evaluate((id) => window.api.sampler.generate({ referenceId: id, rowId: 'emotion_happy' }), referenceId)
    ok(r.ok === false && r.reason === reason, `${mode} → ${reason} (실제 ${r.reason})`)
    const inv = await win.evaluate(() => window.api.sampler.inventory())
    ok(inv.keys.length === 0, `${mode} → 캐시 미공개`)
  }

  // ── 성공 경로 ───────────────────────────────────────────────────────────
  await app.evaluate(() => { globalThis.__afSamplerFake = 'success'; globalThis.__afSamplerRuns = 0 })
  const gen = await win.evaluate((id) => window.api.sampler.generate({ referenceId: id, rowId: 'emotion_happy' }), referenceId)
  ok(gen.ok === true && /^[0-9a-f]{64}$/.test(gen.cacheKey || ''), '정상 생성 → 64hex 캐시 키')
  ok(gen.reused === false, '첫 생성은 reuse 아님')
  const runsAfterFirst = await app.evaluate(() => globalThis.__afSamplerRuns)
  ok(runsAfterFirst === 1, `runner 1회 실행 (=${runsAfterFirst})`)

  const inv1 = await win.evaluate(() => window.api.sampler.inventory())
  ok(inv1.keys.length === 1 && inv1.keys[0] === gen.cacheKey, '캐시에 공개됨')
  ok(fs.existsSync(path.join(CACHE_ROOT, gen.cacheKey + '.wav')), 'final 파일명은 64hex.wav')

  // ── 재요청 → reuse, runner 재실행 0 ─────────────────────────────────────
  const again = await win.evaluate((id) => window.api.sampler.generate({ referenceId: id, rowId: 'emotion_happy' }), referenceId)
  ok(again.ok === true && again.reused === true, '같은 키 재요청 → reuse')
  const runsAfterSecond = await app.evaluate(() => globalThis.__afSamplerRuns)
  ok(runsAfterSecond === 1, `reuse 시 runner 재실행 0 (=${runsAfterSecond})`)

  // ── preview URL 은 키 기반 ──────────────────────────────────────────────
  const purl = await win.evaluate((k) => window.api.sampler.previewUrl({ cacheKey: k }), gen.cacheKey)
  ok(purl.ok === true && purl.url === `local-file://sampler/${gen.cacheKey}`, 'preview URL 은 키 형식')
  ok(!String(purl.url).includes(USER_DATA), 'preview URL 에 절대 경로 없음')
  const bad = await win.evaluate(() => window.api.sampler.previewUrl({ cacheKey: '../../etc/passwd' }))
  ok(bad.ok === false && bad.reason === 'INVALID_KEY', '규격 밖 키 거부')

  // 실제로 재생 가능한 주소인지(프로토콜 해석) — 바이트를 읽지 않고 응답 상태만 본다.
  const fetched = await win.evaluate(async (u) => {
    try { const r = await fetch(u); return { status: r.status, len: (await r.arrayBuffer()).byteLength } }
    catch (e) { return { status: -1, len: 0, err: String(e) } }
  }, purl.url)
  ok(fetched.status === 200 && fetched.len > 44, `키 기반 주소가 실제로 열린다 (status=${fetched.status})`)
  const denied = await win.evaluate(async () => {
    try { const r = await fetch('local-file://sampler/' + 'z'.repeat(64)); return r.status } catch { return -1 }
  })
  ok(denied === 404 || denied === -1, `캐시 밖 키는 열리지 않는다 (=${denied})`)

  // ── 500ms 진단 무음은 재생 타임라인에만 ─────────────────────────────────
  const timeline = await win.evaluate(() => ({
    silence: window.__afPreviewSilenceMs ?? null,
  }))
  void timeline
  const cachedBytes = fs.readFileSync(path.join(CACHE_ROOT, gen.cacheKey + '.wav'))
  const frames = cachedBytes.readUInt32LE(40) / 2
  ok(Math.abs(frames / 24000 - 1) < 0.05, `캐시 WAV 에 500ms 무음이 붙지 않았다 (${(frames / 24000).toFixed(2)}s)`)

  // ── 캐시 삭제는 capability 와 독립 ──────────────────────────────────────
  const del = await win.evaluate((k) => window.api.sampler.remove({ cacheKey: k }), gen.cacheKey)
  ok(del.ok === true, '캐시 삭제 성공')
  const invAfter = await win.evaluate(() => window.api.sampler.inventory())
  ok(invAfter.keys.length === 0, '삭제 후 목록 비어 있음')

  // ── 재시작 복원 ─────────────────────────────────────────────────────────
  await app.evaluate(() => { globalThis.__afSamplerFake = 'success' })
  const regen = await win.evaluate((id) => window.api.sampler.generate({ referenceId: id, rowId: 'emotion_happy' }), referenceId)
  ok(regen.ok === true, '재생성 성공(복원 확인용)')
  await app.close()

  app = await launch()
  win = await app.firstWindow()
  win.on('pageerror', (e) => pageErrors.push(String(e)))
  await win.waitForLoadState('domcontentloaded')

  const listAfter = await win.evaluate(() => window.api.referenceLibrary.list())
  ok(listAfter.status === 'ok' && listAfter.items.length === 2, '재시작 후 manifest 복원')
  const restored = listAfter.items.find((i) => i.referenceId === referenceId)
  ok(restored?.selected === true, '재시작 후 선택 복원')
  ok(restored?.transcript === 'present', '재시작 후 전사 sidecar 복원')
  const invRestart = await win.evaluate(() => window.api.sampler.inventory())
  ok(invRestart.keys.length === 1, '재시작 후 캐시 유지')

  // ── 전사 손상 → 다른 사유로 차단 ────────────────────────────────────────
  const txFile = path.join(REF_ROOT, 'transcripts', referenceId + '.json')
  ok(fs.existsSync(txFile), 'transcript sidecar 파일 존재')
  fs.writeFileSync(txFile, 'broken{', 'utf-8')
  const corrupt = await win.evaluate((id) => window.api.sampler.generate({ referenceId: id, rowId: 'emotion_sad' }), referenceId)
  ok(corrupt.ok === false && corrupt.reason === 'TRANSCRIPT_CORRUPT', `전사 손상 → 구분된 사유 (${corrupt.reason})`)
  const listCorrupt = await win.evaluate(() => window.api.referenceLibrary.list())
  ok(listCorrupt.items.find((i) => i.referenceId === referenceId)?.transcript === 'TRANSCRIPT_CORRUPT', '목록도 손상으로 표시')

  // ── 참조 삭제: clip 과 sidecar 상태 일치 ────────────────────────────────
  const inUse = await win.evaluate((id) => window.api.referenceLibrary.remove(id), referenceId)
  ok(inUse.ok === false && inUse.reason === 'REFERENCE_IN_USE', '사용 중 참조 삭제 차단')
  await win.evaluate(() => window.api.referenceLibrary.select(null))
  const removed = await win.evaluate((id) => window.api.referenceLibrary.remove(id), referenceId)
  ok(removed.ok === true, '선택 해제 후 삭제 성공')
  ok(!fs.existsSync(path.join(REF_ROOT, referenceId + '.wav')), 'clip 파일 삭제됨')
  ok(!fs.existsSync(txFile), 'transcript sidecar 도 함께 삭제됨')

  // ── 뷰포트 / 배율 ───────────────────────────────────────────────────────
  for (const [w, h, zoom] of [[800, 600, 1], [800, 600, 1.25], [800, 600, 1.5], [800, 600, 2]]) {
    await win.setViewportSize({ width: w, height: h })
    await win.evaluate((z) => { document.body.style.zoom = String(z) }, zoom)
    await win.waitForTimeout(120)
    const overflow = await win.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
    ok(!overflow, `가로 넘침 없음 (${w}x${h} @${zoom * 100}%)`)
  }
  await win.evaluate(() => { document.body.style.zoom = '1' })

  // ── 접근성 기본 ─────────────────────────────────────────────────────────
  const a11y = await win.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    return {
      total: btns.length,
      unlabeled: btns.filter((b) => !b.getAttribute('aria-label') && !(b.textContent || '').trim()).length,
      focusable: btns.filter((b) => b.tabIndex >= 0).length,
    }
  })
  ok(a11y.total > 0 && a11y.unlabeled === 0, `모든 버튼에 이름이 있다 (${a11y.total}개, 무명 ${a11y.unlabeled})`)
  ok(a11y.focusable === a11y.total, '모든 버튼이 키보드로 도달 가능')

  // ── 잔여물 / 원본 불변 ──────────────────────────────────────────────────
  ok(stagingLeft().length === 0, `staging 잔존 0 (=${stagingLeft().join(',') || 'none'})`)
  ok(sha(SRC) === SRC_SHA_BEFORE, '원본 synthetic WAV SHA-256 불변')
  ok(pageErrors.length === 0, `pageerror 0 (=${pageErrors.length})`)
} catch (e) {
  console.error('[reflib-sampler] EXCEPTION', e)
  failed++
} finally {
  try { await app.close() } catch { /* noop */ }
  cleanupSyntheticWav(SRC)
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* noop */ }
}

console.log('[reflib-sampler] SUMMARY', JSON.stringify({ failed }))
process.exit(failed === 0 ? 0 : 1)
