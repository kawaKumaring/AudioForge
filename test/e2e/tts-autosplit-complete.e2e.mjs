// Optional slow E2E — 실제 Qwen·GPU·참조 자산 필요. 긴 한 줄 자동 분할(계약 B) + 생성 안전상한(계약 A)이
// 실제 Electron 앱에서 회귀하지 않는지 검증한다: 검은 화면, 진행률 시작 즉시 90% 점프, chunk 진행 미표시,
// 결과 카드 미표시, 잔존 프로세스/임시폴더.
//
// 기본 `npm test`·빠른 `test:e2e`에는 포함하지 않는다(수 분·GPU). 실행:
//   npm run test:e2e:tts-autosplit
// 참조 자산: AF_E2E_REFERENCE 환경변수 경로 우선, 없으면 resources/speaker_b.wav fallback.
//   둘 다 없으면 prerequisite 오류로 종료(사용자 경로 하드코딩 금지).
// 출력/스크린샷/로그는 비추적 _local/artifacts/diagnostics/e2e-shots에만. resources 원본 전후 snapshot 불변.
// chunk 시작/완료 progress의 완전한 단조·경계 단언은 python/test_autosplit_bridge.py(단위)에서 고정하고,
// 여기서는 그 시작/완료 진행이 실제 앱 UI에 표면화되는지를 확인한다.
import { _electron as electron } from 'playwright'
import fs from 'fs'; import path from 'path'
import { isolatedInput, cleanupIsolated, snapshotTree, refClipDirs, qwenJobDirs, qwenVenvPids, nvidiaSmiGpu0, requireE2EReference } from './_e2e-helper.mjs'

const WAIT_MS = 350000
const APP = process.cwd()
const SRC = requireE2EReference()   // 명시 AF_E2E_REFERENCE 단일 권위(speaker_b.wav 하드코딩·fallback 없음)
const RES_DIR = path.join(APP, 'resources')
const SHOT = path.join(APP, '_local', 'artifacts', 'diagnostics', 'e2e-shots'); fs.mkdirSync(SHOT, { recursive: true })
let failed = 0
const logLines = []
const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); logLines.push(s); console.log('[autosplit]', s) }
const ok = (c, m) => { log(c ? 'PASS' : 'FAIL', m); if (!c) failed++ }

// (참조 자산 검증은 requireE2EReference가 처리 — 경로·내용 미출력)
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }
log('참조 자산: AF_E2E_REFERENCE(명시)')

// 긴 한 줄(자동분할 ≥2). 비민감 진단문.
const LONG_KO = '오늘은 여러 절을 이어 붙여 아주 길게 만든 한국어 문장으로 자동 분할이 실제로 일어나는지 그리고 각 조각이 안전한 생성 상한 안에서 자연스럽게 끝나는지 확인하기 위한 예문이며 문장 부호와 쉼표 그리고 충분한 길이를 갖도록 구성했습니다.'

const resBefore = snapshotTree(RES_DIR)
const { dir: ISO, input: REF } = isolatedInput(SRC)
const OUT_BASE = path.join(path.dirname(REF), 'AudioForge_output')
const pageErrors = [], crashes = [], mainOut = []

log('시작 nvidia-smi GPU0(used/free MiB):', nvidiaSmiGpu0() || '측정 실패')
const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
const win = await app.firstWindow()
app.process().stdout.on('data', d => mainOut.push(String(d)))
app.process().stderr.on('data', d => mainOut.push(String(d)))
win.on('pageerror', e => pageErrors.push(e.message))
win.on('crash', () => crashes.push('crash'))

try {
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
  await win.waitForFunction(() => /\d/.test(document.getElementById('root')?.innerText || ''), undefined, { timeout: 30000 })

  await win.evaluate(async ({ p, text }) => {
    const s = window.__afStore
    const base = await window.api.audio.trimReference(p, 6.0, 7.0, 'default')
    s.getState().setTtsRefState({ clip: base.clip_path, region: { start: 6.0, duration: 7.0 }, ready: true, message: '' })
    s.setState({ ttsText: text, ttsPitch: 0.0 })
  }, { p: REF, text: LONG_KO })

  await win.getByText('음성 합성 시작', { exact: false }).click({ timeout: 8000 })
  await win.waitForFunction(() => window.__afStore?.getState().status === 'processing', undefined, { timeout: 8000 })
  ok(true, '합성 시작(긴 한 줄, pitch 0)')

  const deadline = Date.now() + WAIT_MS
  let settled = false, snap = null
  const seq = []
  let firstProcProgress = null
  while (Date.now() < deadline) {
    snap = await win.evaluate(() => { const s = window.__afStore.getState(); return { status: s.status, progress: s.progress, msg: s.progressMessage, err: s.error } })
    if (snap.status === 'processing' && firstProcProgress === null) firstProcProgress = snap.progress
    const last = seq[seq.length - 1]
    if (!last || last.progress !== snap.progress || last.msg !== snap.msg) seq.push({ progress: snap.progress, msg: snap.msg })
    if (['done', 'error'].includes(snap.status)) { settled = true; break }
    await win.waitForTimeout(400)
  }
  const progs = seq.map(x => x.progress).filter(x => typeof x === 'number')
  const msgs = [...new Set(seq.map(x => x.msg).filter(Boolean))]
  const chunkMsgs = msgs.filter(m => /조각\s*\d+\/\d+/.test(m))
  const chunkKeys = [...new Set(chunkMsgs.map(m => (m.match(/조각\s*(\d+)\/(\d+)/) || [])[0]))]
  const hasStart = chunkMsgs.some(m => /시작/.test(m))
  const hasDone = chunkMsgs.some(m => /완료/.test(m))
  log('progress 수열:', progs)
  log('chunk 메시지 키:', chunkKeys)

  ok(settled && snap?.status === 'done', `합성 완료(status=done, err=${snap?.err || '없음'})`)
  ok(firstProcProgress !== null && firstProcProgress < 90, `처리 시작 시 진행률<90 (첫=${firstProcProgress})`)
  let mono = true
  for (let i = 1; i < progs.length; i++) if (progs[i] < progs[i - 1]) mono = false
  ok(mono, `진행률 단조 비감소(${progs.length}개 관측)`)
  ok(progs.some(p => p > 30 && p < 90), '진행률에 30<p<90 중간 단계 존재(점프 아님)')
  ok(chunkKeys.length >= 2, `chunk 진행 메시지 ≥2(${chunkKeys.length})`)
  // 시작/완료 진행이 UI에 표면화되는지(완전 단조·경계는 단위 test_autosplit_bridge.py에서 고정)
  ok(hasStart && hasDone, `chunk 시작·완료 진행 모두 표면화(start=${hasStart}, done=${hasDone})`)

  const st = await win.evaluate(() => ({ outputDir: window.__afStore.getState().outputDir, tracks: window.__afStore.getState().tracks, meta: window.__afStore.getState().resultMetadata }))
  const wav = (st.tracks && st.tracks[0] && st.tracks[0].path) || (st.outputDir && path.join(st.outputDir, 'synthesized.wav'))
  ok(!!wav && fs.existsSync(wav), `synthesized.wav 존재(${wav ? path.basename(path.dirname(wav)) : 'none'})`)
  const gc = st.meta?.generation_chunks || []
  ok(gc.length >= 2, `metadata generation_chunks ≥2(${gc.length})`)
  ok(gc.length ? gc.every(c => c.termination_reason === 'completed_before_limit') : false, '전 chunk completed_before_limit')
  ok(gc.length ? gc.every(c => c.production_tokens <= 33 && c.generation_limit <= 256) : false, '전 chunk tok≤33·limit≤256')

  // 실제 화면에 결과 카드('합성 정보')와 엔진(Qwen3) 표시 확인 — resultMetadata만이 아니라 렌더링 확인
  const screen = await win.evaluate(() => {
    const root = document.getElementById('root'); const txt = (root?.innerText || '')
    const overlay = [...document.querySelectorAll('*')].some(el => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el)
      return r.width >= innerWidth * 0.98 && r.height >= innerHeight * 0.98 &&
        (s.backgroundColor === 'rgb(0, 0, 0)') && s.visibility !== 'hidden'
    })
    return {
      len: txt.trim().length, overlay,
      hasCard: /합성\s*정보/.test(txt), hasEngine: /Qwen3/.test(txt),
      hasErrorBoundary: /문제가 발생|something went wrong|ErrorBoundary/i.test(txt),
    }
  })
  ok(screen.hasCard, `결과 카드('합성 정보') 화면 표시`)
  ok(screen.hasEngine, `실제 엔진(Qwen3) 결과 표시`)
  ok(screen.len > 50 && !screen.overlay && !screen.hasErrorBoundary,
    `검은화면/ErrorBoundary 없음(txtLen=${screen.len}, overlay=${screen.overlay})`)
  ok(pageErrors.length === 0 && crashes.length === 0, `pageerror/crash 0(pe=${pageErrors.length}, cr=${crashes.length})`)
  await win.screenshot({ path: path.join(SHOT, 'tts-autosplit_result.png') })
} catch (e) {
  failed++; log('EXCEPTION', e?.message || String(e))
  try { await win.screenshot({ path: path.join(SHOT, 'tts-autosplit_FAIL.png') }) } catch { /* ignore */ }
} finally {
  try { await app.close() } catch { /* ignore */ }
  ok(qwenVenvPids().length === 0, `종료 후 Qwen venv 자식 0`)
  ok(qwenJobDirs(OUT_BASE).length === 0, `종료 후 .qwen-job-* 0`)
  ok(refClipDirs().length === 0, `종료 후 refclip 임시폴더 0`)
  ok(snapshotTree(RES_DIR) === resBefore, 'resources/ 원본 불변')
  cleanupIsolated(ISO)
  fs.writeFileSync(path.join(SHOT, 'tts-autosplit_log.txt'), logLines.join('\n') + '\n\n--- main ---\n' + mainOut.join(''), 'utf-8')
}
log('SUMMARY', JSON.stringify({ failed, pageErrors: pageErrors.length, crashes: crashes.length }))
process.exit(failed === 0 ? 0 : 1)
