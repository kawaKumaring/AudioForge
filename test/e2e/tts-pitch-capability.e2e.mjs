// pitch capability gate E2E (계약 G-E) — AF_E2E_PITCH_CAPABILITY로 결정적 시나리오. GPU·Qwen·실합성 없음.
// supported: slider 활성·키보드/reset·nonzero pitch 합성 gate 정상(비차단).
// unsupported/probe-failed: slider 비활성·사유·저장된 +1에서 합성 버튼 차단·정확 사유·reset 활성·reset 후 차단 해제.
// 실행: npm run test:e2e:tts-pitch-capability  (사전 npm run build)
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
const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); logLines.push(s); console.log('[pitch-cap]', s) }
const ok = (c, m) => { log(c ? 'PASS' : 'FAIL', m); if (!c) failed++ }
if (!fs.existsSync(SRC)) { console.error(`prerequisite: 참조 자산 없음(AF_E2E_REFERENCE 또는 ${FALLBACK})`); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }

const resBefore = snapshotTree(RES_DIR)
const ISO = isolatedInput(SRC)   // 시나리오 3회 재기동이 공유(합성 없음 — 입력 주입용). finally에서 정리.
const pageErrors = [], crashes = []

async function launch(cap) {
  const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_PITCH_CAPABILITY: cap } })
  const win = await app.firstWindow()
  win.on('pageerror', e => pageErrors.push(`${cap}:${e.message}`))
  win.on('crash', () => crashes.push(cap))
  return { app, win }
}

// 파일·tts 모드·참조 준비·대사 세팅 → pitch 외 gate는 모두 통과 상태로. preset ttsPitch는 마운트 전 store에 주입.
async function setupReady(win, ref, presetPitch) {
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async ({ p, pitch }) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    if (pitch !== 0) s.setState({ ttsPitch: pitch })   // 마운트 전 주입 → TTSEditor 로컬이 이 값으로 init
    s.getState().setMode('tts')
  }, { p: ref, pitch: presetPitch })
  await win.waitForFunction(() => /\d/.test(document.getElementById('root')?.innerText || ''), undefined, { timeout: 30000 })
  await win.evaluate(async (p) => {
    const s = window.__afStore
    const base = await window.api.audio.trimReference(p, 6.0, 7.0, 'default')
    s.getState().setTtsRefState({ clip: base.clip_path, region: { start: 6.0, duration: 7.0 }, ready: true, message: '' })
  }, ref)
  const ta = win.locator('textarea').last()
  await ta.fill('안녕하세요. 합성 gate 확인용 문장입니다.')
  await win.getByText('고급 설정', { exact: false }).click({ timeout: 8000 }).catch(() => {})
  // 비동기 pitch probe(IPC)가 store에 반영될 때까지 대기 — probed=true 확정 후에만 단언(unknown 오판 방지).
  await win.waitForFunction(() => window.__afStore.getState().ttsPitchCapability?.probed === true, undefined, { timeout: 15000 })
}

const pbState = (win) => win.evaluate(() => {
  const txt = document.getElementById('root')?.innerText || ''
  return {
    pitchBlocked: /음높이 보정 지원을 확인할 수 없어/.test(txt),
    startText: /음성 합성 시작/.test(txt),
    pitchVal: window.__afStore.getState().ttsPitch,
  }
})

try {
  // ── supported ──
  {
    const { app, win } = await launch('supported')
    await setupReady(win, ISO.input, 0)
    const slider = win.locator('input[list="tts-pitch-ticks"]')
    await slider.waitFor({ timeout: 8000 })
    ok(!(await slider.isDisabled()), '[supported] slider 활성')
    await win.evaluate(() => window.__afStore.setState({ ttsPitch: 0 }))
    await slider.focus(); await win.keyboard.press('ArrowRight'); await win.waitForTimeout(150)
    ok(Math.abs((await win.evaluate(() => window.__afStore.getState().ttsPitch)) - 0.5) < 1e-6, '[supported] 키보드 0.5 변경')
    const pb = await pbState(win)  // pitch=0.5, supported → pitch 비차단
    ok(!pb.pitchBlocked, '[supported] nonzero pitch에도 합성 gate 비차단')
    await app.close()
  }
  // ── unsupported (저장된 +1) ──
  {
    const { app, win } = await launch('unsupported')
    await setupReady(win, ISO.input, 1.0)  // 마운트 전 ttsPitch=+1 주입(세션 복원 상황)
    const slider = win.locator('input[list="tts-pitch-ticks"]')
    await slider.waitFor({ timeout: 8000 })
    ok(await slider.isDisabled(), '[unsupported] slider 비활성')
    const reason = await win.evaluate(() => /이 환경에서는 음높이 보정을 사용할 수 없|사용할 수 없습니다/.test(document.getElementById('root')?.innerText || ''))
    ok(reason, '[unsupported] 미지원 사유 표시')
    let pb = await pbState(win)
    ok(pb.pitchVal === 1.0 && pb.pitchBlocked, `[unsupported] 저장된 +1에서 합성 버튼 차단 + 정확 사유(pitch=${pb.pitchVal})`)
    // reset 버튼 활성 → 클릭 → 0 → 차단 해제
    const resetBtn = win.getByTitle('음높이를 원본(0)으로 되돌립니다')
    ok(!(await resetBtn.isDisabled()), '[unsupported] reset 버튼 활성(미지원이어도)')
    await resetBtn.click({ timeout: 8000 }); await win.waitForTimeout(200)
    pb = await pbState(win)
    ok(pb.pitchVal === 0, '[unsupported] reset 클릭 → ttsPitch=0')
    ok(!pb.pitchBlocked, '[unsupported] reset 후 pitch 합성 차단 해제')
    await app.close()
  }
  // ── probe-failed (unknown 성격) ──
  {
    const { app, win } = await launch('probe-failed')
    await setupReady(win, ISO.input, 1.0)
    const slider = win.locator('input[list="tts-pitch-ticks"]')
    await slider.waitFor({ timeout: 8000 })
    ok(await slider.isDisabled(), '[probe-failed] slider 비활성')
    const pb = await pbState(win)
    ok(pb.pitchVal === 1.0 && pb.pitchBlocked, '[probe-failed] nonzero pitch 합성 차단(조용한 무시 없음)')
    await app.close()
  }
  ok(pageErrors.length === 0 && crashes.length === 0, `pageerror/crash 0(pe=${pageErrors.length}, cr=${crashes.length})`)
} catch (e) {
  failed++; log('EXCEPTION', e?.message || String(e))
} finally {
  ok(qwenVenvPids().length === 0, '종료 후 Qwen venv 자식 0')
  ok(refClipDirs().length === 0, '종료 후 refclip 임시폴더 0')
  ok(snapshotTree(RES_DIR) === resBefore, 'resources/ 원본 불변')
  cleanupIsolated(ISO.dir)
  fs.writeFileSync(path.join(SHOT, 'tts-pitch-capability_log.txt'), logLines.join('\n'), 'utf-8')
}
log('SUMMARY', JSON.stringify({ failed, pageErrors: pageErrors.length, crashes: crashes.length }))
process.exit(failed === 0 ? 0 : 1)
