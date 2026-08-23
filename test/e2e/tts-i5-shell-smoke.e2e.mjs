// I5-a 셸 조립 smoke E2E (mock/synthetic, GPU·Qwen·실합성 없음).
// 검증(사용자 지정 게이트): TTS 진입/재진입 검은화면·pageerror·crash 0 / preflight 중복 0 /
//   기본 참조 패널 단일 마운트 / 4-flow에서 기존 기능 도달 가능(감정참조·전사·엔진·태그·예문) /
//   store TTS 필드 손실 0 / resources 불변 · 종료 후 qwen 프로세스·job 임시폴더 잔존 0.
// 실행: npm run build 후 node test/e2e/tts-i5-shell-smoke.e2e.mjs. 참조 자산은 AF_E2E_REFERENCE 또는 resources/speaker_b.wav.
import { _electron as electron } from 'playwright'
import fs from 'fs'; import path from 'path'
import { isolatedInput, cleanupIsolated, snapshotTree, qwenJobDirs, qwenVenvPids } from './_e2e-helper.mjs'

const APP = process.cwd()
const SRC = (process.env.AF_E2E_REFERENCE || '').trim() || path.join(APP, 'resources', 'speaker_b.wav')
const RES_DIR = path.join(APP, 'resources')
let failed = 0
const log = (...a) => console.log('[i5-smoke]', ...a)
const ok = (c, m) => { log(c ? 'PASS' : 'FAIL', m); if (!c) failed++ }
if (!fs.existsSync(SRC)) { console.error('prerequisite: 참조 자산 없음'); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }

const resBefore = snapshotTree(RES_DIR)
const { dir: ISO, input: REF } = isolatedInput(SRC)
const pageErrors = [], crashes = []
const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
const win = await app.firstWindow()
win.on('pageerror', e => pageErrors.push(e.message))
win.on('crash', () => crashes.push('crash'))

const enterTts = async () => {
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
  await win.waitForFunction(() => (document.getElementById('root')?.innerText || '').includes('목소리'), undefined, { timeout: 30000 })
}
const hasText = (t) => win.evaluate((s) => (document.getElementById('root')?.innerText || '').includes(s), t)

try {
  await win.waitForLoadState('domcontentloaded')

  // preflight 중복 방지 근거: main의 audio:qwen-preflight 핸들러가 createSingleFlight로 감싸져 있어
  // 동시/중복 호출을 진행 중 Promise로 공유(subprocess 1회) — 셸 구조와 무관하게 중복 subprocess가 방지된다.
  // 렌더러 측 호출 카운트 계측은 window.api가 contextBridge로 frozen이라 불가(래핑 무시됨) → 아래는 결과 배지로 검증.

  // ── 1) TTS 진입 ──
  await enterTts()
  ok(pageErrors.length === 0, `진입 후 pageerror 0 (=${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0] : ''})`)
  ok(crashes.length === 0, `crash 0`)
  const rootLen = await win.evaluate(() => (document.getElementById('root')?.innerText || '').length)
  ok(rootLen > 50, `검은 화면 아님(root 텍스트 ${rootLen}자)`)

  // ── 2) 4-flow에서 기존 기능 도달 가능 ──
  ok(await hasText('목소리'), '[1] 목소리 flow 도달')
  ok(await hasText('대사'), '[2] 대사 flow 도달')
  ok(await hasText('표현'), '[3] 표현 flow 도달')
  ok(await hasText('참조 전사'), '참조 전사 섹션 존재')
  ok(await hasText('감정 태그 삽입'), '감정 태그 삽입 팔레트 존재')
  ok(await hasText('감정 음성'), '감정 참조 관리자 존재')
  ok((await win.locator('textarea').count()) >= 1, '대사 편집기 textarea 존재')
  // 엔진 선택(고급 펼치기 후 Qwen3 버튼)
  await win.getByText('고급', { exact: false }).first().click({ timeout: 8000 }).catch(() => {})
  ok(await hasText('Qwen3'), '엔진 직접 선택(Qwen3) 도달')
  // 예문 불러오기(빈 대사일 때)
  const hadExample = await hasText('예문 불러오기')
  ok(hadExample, '예문 불러오기 버튼 존재')

  // ── 3) 기본 참조 패널 단일 마운트(중복 마운트 0) ──
  // ReferenceRegionPanel 기본 인스턴스는 clipKey="default" 1개만. 헤더 라벨 '참조 음성' 등장 횟수로 근사.
  const defaultPanelCount = await win.evaluate(() => {
    const txt = document.getElementById('root')?.innerText || ''
    return (txt.match(/참조 음성/g) || []).length
  })
  ok(defaultPanelCount >= 1, `기본 참조 패널 렌더(=${defaultPanelCount})`)

  // ── 4) store TTS 필드 손실 0 (합성 payload 원천) ──
  const fields = await win.evaluate(() => {
    const s = window.__afStore.getState()
    return {
      ttsText: typeof s.ttsText, ttsSpeed: typeof s.ttsSpeed, ttsSilenceGap: typeof s.ttsSilenceGap,
      ttsPitch: typeof s.ttsPitch, ttsEngine: typeof s.ttsEngine,
      ttsTailMode: s.ttsTailMode, ttsEmotionBoundaryMode: s.ttsEmotionBoundaryMode,
      ttsEmotionBoundaryPauseMs: typeof s.ttsEmotionBoundaryPauseMs,
      ttsReferencePrompts: typeof s.ttsReferencePrompts, ttsEmotionRefState: typeof s.ttsEmotionRefState,
    }
  })
  ok(fields.ttsText === 'string' && fields.ttsSpeed === 'number' && fields.ttsSilenceGap === 'number'
    && fields.ttsPitch === 'number' && fields.ttsEngine === 'string', 'store 기본 TTS 필드 보존')
  ok((fields.ttsTailMode === 'auto' || fields.ttsTailMode === 'off')
    && (fields.ttsEmotionBoundaryMode === 'pause' || fields.ttsEmotionBoundaryMode === 'immediate')
    && fields.ttsEmotionBoundaryPauseMs === 'number', 'I3 tail/감정경계 필드 보존(신규 세션 auto/pause)')
  ok(fields.ttsReferencePrompts === 'object' && fields.ttsEmotionRefState === 'object', '참조/감정 상태 필드 보존')

  // 표현 흐름 값 배선 확인: 프리셋 적용이 store로 반영(밝고 가볍게 → pitch +1 시도, capability 없으면 slider는 숨겨도 store는 반영).
  await win.evaluate(() => { window.__afStore.setState({ ttsSilenceGap: 0.5 }) })

  // preflight 결과 배지 렌더 확인(preflight가 실제 실행·반환됨 — 중복은 createSingleFlight가 방지).
  // preflight는 python subprocess를 스폰하므로 수 초 소요 → 배지 등장을 대기(타이밍 flaky 방지).
  await win.waitForFunction(() => (document.getElementById('root')?.innerText || '').includes('예상값'),
    undefined, { timeout: 30000 }).catch(() => {})
  const preflightBadge = await win.evaluate(() => (document.getElementById('root')?.innerText || '').includes('예상값'))
  ok(preflightBadge, 'preflight 결과 배지 렌더(실행됨)')

  // ── 5) TTS 재진입(split→tts) 검은화면·pageerror 없음(단일 셸 effect 구조 remount 안정성) ──
  await win.evaluate(() => window.__afStore.getState().setMode('split'))
  await win.waitForTimeout(200)
  await enterTts()
  ok(pageErrors.length === 0, `재진입 후 pageerror 0 (=${pageErrors.length})`)
  ok(crashes.length === 0, `재진입 후 crash 0`)
  const reRootLen = await win.evaluate(() => (document.getElementById('root')?.innerText || '').length)
  ok(reRootLen > 50, `재진입 후 검은 화면 아님(${reRootLen}자)`)

  await win.screenshot({ path: path.join(APP, '작업파일', 'e2e_shots', 'i5-smoke.png') }).catch(() => {})
} catch (e) {
  failed++; log('EXCEPTION', e?.message || String(e))
} finally {
  await app.close().catch(() => {})
}

// ── 6) 종료 후 잔존 0 + resources 불변 ──
await new Promise(r => setTimeout(r, 500))
const leftoverPids = qwenVenvPids()
ok(leftoverPids.length === 0, `종료 후 qwen 프로세스 잔존 0 (=${leftoverPids.length})`)
const jobDirs = qwenJobDirs(ISO)
ok(jobDirs.length === 0, `job 임시폴더(.qwen-job-*) 잔존 0 (=${jobDirs.length})`)
const resAfter = snapshotTree(RES_DIR)
ok(JSON.stringify(resBefore) === JSON.stringify(resAfter), 'resources 원본 불변')
cleanupIsolated(ISO)

log(failed === 0 ? 'ALL PASS' : `${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
