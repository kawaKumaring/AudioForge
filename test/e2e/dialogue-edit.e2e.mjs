// 대화 구간 수정 — 표적 확인.
//
// **화자 분석을 새로 돌리지 않는다.** 분석이 끝난 상태를 얹고, 사용자가 하는 동작만 본다.
//
//   1) 구간·화자·시간이 보이고, 누르면 원본의 그 부분을 재생한다
//   2) 배정과 경계를 고칠 수 있고, 되돌리면 최초 분석 값으로 돌아온다
//   3) 시간 범위 오류를 고치는 순간 알리고 내보내기에서 뺀다
//   4) 다시 만들기가 **모델을 다시 돌리지 않고** 수정한 구간을 실제로 반영한다
//   5) 겹친 목소리를 갈라냈다고 말하지 않는다
//
// ★2026-09-28: 화면이 9-27 에 새로 만들어졌다(인물 카드 + 시간순 발언 목록).
//   **기능은 그대로 있다** — 시작·끝 고치기는 '시간 고치기' 단추 뒤로 들어갔고,
//   구간 듣기는 공용 파형(Web Audio)이 낸다. 확인하는 항목은 하나도 줄이지 않고
//   **겨누는 자리만** 새 화면에 맞췄다.
//
// 실행: node test/e2e/dialogue-edit.e2e.mjs   (사전: npm run build. GPU 불필요)
import { _electron as electron } from 'playwright'
import { installAudioProbe, seekedTo } from './_audio-probe.mjs'
import { OUTPUT_ROOT_DIRNAME, FEATURE_FOLDERS, dayFolder } from '../../src/shared/outputLayout.ts'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isolatedInput, cleanupIsolated, isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const FIXTURE = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav')
if (!fs.existsSync(FIXTURE)) { console.error('fixture 없음'); process.exit(2) }
// ★결과 자리 규칙이 2026-09-28 에 바뀌었다 — 기본은 **앱이 관리하는 자리**다
//   (`AudioForge_output/<기능>/<날짜>/…`). 원본 옆에 쌓는 것은 설정에서 켤 때만이다.
//   원본은 여전히 격리 폴더에 둔다 — 저장소 fixture 옆에 아무것도 만들지 않는다.
const { dir: ISO, input: SRC } = isolatedInput(FIXTURE)
const RESULT_ROOT = path.join(APP, OUTPUT_ROOT_DIRNAME, FEATURE_FOLDERS['dialogue-rebuild'], dayFolder(new Date()))

const UD = isolatedUserData()
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'af-dlg-'))
const SEGMENTS = [
  { start: 0, end: 5, speaker: '화자 A' },
  { start: 5, end: 11, speaker: '화자 B' },
  { start: 11, end: 18, speaker: '화자 A' },
]

let failed = 0
const log = (...a) => console.log('[dlg]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let app = null
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.__afStore, undefined, { timeout: 30000 })
  await win.evaluate(async ([src, segs, out]) => {
    const s = window.__afStore
    const info = await window.api.audio.getFileInfo(src)
    s.getState().setFile(info, await window.api.audio.getFileUrl(src))
    s.setState({
      mode: 'conversation', resultMode: 'conversation', status: 'done', outputDir: out,
      tracks: [{ name: 'speaker_a', label: '화자 A', path: out + '/speaker_a.wav' }],
    })
    // 새 화면은 **분석 한 덩어리**를 받는다(원본·실행 식별자까지 함께) —
    // 늦게 온 앞 실행의 결과가 지금 작업을 덮지 않게 하려고 그렇게 만들었다.
    s.getState().beginDialogueRun('E2E-1')
    s.getState().adoptDialogueAnalysis({
      sourceKey: src, runId: 'E2E-1',
      segments: segs, speakers: [...new Set(segs.map((x) => x.speaker))],
      overlaps: [], outputDir: out, durationSec: info?.duration || 18,
      trimSilence: false, transcribe: false,
    })
  }, [SRC, SEGMENTS, OUT])
  await win.waitForTimeout(1000)

  // ── 1) 목록과 구간 듣기 ─────────────────────────────────────────────────
  ok(await win.getByTestId('dialogue-workspace').count() === 1, '분석 결과 아래에 구간 수정 자리가 나온다')
  ok(await win.getByTestId('dialogue-row').count() === 3, '구간이 줄로 펼쳐진다')
  const sp = await win.getByTestId('dialogue-speaker').nth(1).inputValue()
  ok(sp === '화자 B', '구간마다 배정된 화자가 보인다', sp)
  // 시작·끝은 **'시간 고치기'** 뒤에 있다. 늘 펼쳐 두면 목록이 빽빽해지기 때문이다.
  ok(await win.getByTestId('dialogue-toggle-times').count() === 1, '시간 고치기로 들어가는 길이 있다')
  ok(await win.getByTestId('dialogue-start').count() === 0, '켜기 전에는 시간 칸이 없다')
  await win.getByTestId('dialogue-toggle-times').click()
  await sleep(300)
  const st = await win.getByTestId('dialogue-start').nth(1).inputValue()
  const en = await win.getByTestId('dialogue-end').nth(1).inputValue()
  ok(st === '5' && en === '11', '시작·끝이 보인다', `${st} → ${en}`)

  await win.evaluate(eval(installAudioProbe))
  await win.getByTestId('dialogue-play').nth(1).click()
  await sleep(900)
  ok(seekedTo(await win.evaluate(() => window.__seeks), 5), '누른 구간의 시작으로 이동한다',
    JSON.stringify(await win.evaluate(() => window.__seeks)))
  ok((await win.evaluate(() => window.__plays)).length >= 1, '원본을 실제로 재생한다',
    JSON.stringify(await win.evaluate(() => window.__plays)))
  await win.getByTestId('dialogue-play').nth(2).click()
  await sleep(700)
  ok(await win.evaluate(() => window.__pauses) >= 1, '다른 구간을 누르면 이전 재생을 정리한다')

  // ── 1.5) ★고쳐도 목록이 덜컹이지 않는다 ───────────────────────────────
  //   지적(2026-09-28): "발언 되돌리기때문에 UX가 들쑥날쑥해진다".
  //   되돌리기는 고친 줄에만 뜬다 — 그때 줄 크기가 바뀌면 목록 전체가 움직인다.
  const boxes = () => win.evaluate(() => [...document.querySelectorAll('[data-testid="dialogue-row"]')]
    .map((r) => { const b = r.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) } }))
  const beforeEdit = await boxes()
  ok(beforeEdit.length === 3 && new Set(beforeEdit.map((b) => b.h)).size === 1,
    '★고치기 전 — 줄 높이가 모두 같다', JSON.stringify(beforeEdit))

  await win.getByTestId('dialogue-speaker').nth(1).selectOption('화자 A')
  await sleep(500)
  const afterEdit = await boxes()
  ok(JSON.stringify(afterEdit) === JSON.stringify(beforeEdit),
    '★되돌리기가 생겨도 줄 크기가 그대로다 — 목록이 덜컹이지 않는다',
    JSON.stringify({ beforeEdit, afterEdit }))
  ok(await win.getByTestId('dialogue-revert').count() === 1, '고친 줄에만 되돌리기가 뜬다')

  // 되돌린 뒤에도 마찬가지다.
  await win.getByTestId('dialogue-revert').first().click()
  await sleep(400)
  ok(JSON.stringify(await boxes()) === JSON.stringify(beforeEdit),
    '★되돌린 뒤에도 줄 크기가 그대로다')

  // ── 2) 배정·경계 고치기 / 되돌리기 ──────────────────────────────────────
  await win.getByTestId('dialogue-speaker').nth(1).selectOption('화자 A')
  await sleep(500)
  // 새 화면은 인물 수·발언 수와 함께 '고친 곳 N' 으로 한 줄에 적는다.
  const stateLine = await win.getByTestId('dialogue-state').textContent()
  ok((stateLine || '').includes('고친 곳 1'), '고친 구간 수가 보인다', `"${(stateLine || '').trim()}"`)
  ok(await win.evaluate(() =>
    document.querySelectorAll('[data-testid="dialogue-row"]')[1].getAttribute('data-edited')) === '1',
    '고친 구간이 표시된다')
  const kept = await win.evaluate(() => window.__afStore.getState().dialogueAnalysis.segments[1].speaker)
  ok(kept === '화자 B', '**최초 분석 결과는 그대로 남는다**', kept)

  await win.getByTestId('dialogue-revert').first().click()
  await sleep(400)
  ok(await win.getByTestId('dialogue-speaker').nth(1).inputValue() === '화자 B',
    '되돌리면 최초 분석 값으로 돌아온다')

  // ── 3) 시간 범위 오류 ───────────────────────────────────────────────────
  await win.getByTestId('dialogue-end').nth(1).fill('2')
  await sleep(600)
  const flagged = await win.evaluate(() => [...document.querySelectorAll('[data-testid="dialogue-row"]')]
    .filter((r) => (r.dataset.problem || '').length > 0).length)
  ok(flagged >= 1, '끝이 시작보다 앞이면 그 자리에서 알린다', String(flagged))
  const blocked = await win.getByTestId('dialogue-blocked').textContent()
  ok((blocked || '').includes('빠집니다'), '내보낼 때 빠진다는 것도 알린다', `"${(blocked || '').trim().slice(0, 40)}…"`)
  await win.getByTestId('dialogue-end').nth(1).fill('11')
  await sleep(500)
  ok(await win.getByTestId('dialogue-blocked').count() === 0, '고치면 경고가 사라진다')

  // ── 5) 표현 ─────────────────────────────────────────────────────────────
  const body = await win.getByTestId('dialogue-workspace').textContent()
  ok((body || '').includes('겹쳐 말한 부분을 한 사람의 목소리로 갈라내지는 않습니다'),
    '배정과 갈라내기를 구분해 말한다')
  ok((body || '').includes('화자 분석을 다시 돌리지 않습니다'), '재분석을 하지 않는다고 알린다')

  // ── 4) 수정본으로 다시 만들기 — **실제로 돌린다** ──────────────────────
  // 화자 분석(VAD·임베딩·군집)은 돌지 않는다. 원본에서 구간을 떠다 트랙에 올릴 뿐이다.
  // 2번 구간의 화자를 바꿔 **셋 다 화자 A** 로 만든 뒤 다시 만들면, 결과는 화자 A 하나여야 한다.
  await win.getByTestId('dialogue-speaker').nth(1).selectOption('화자 A')
  await sleep(500)
  const t0 = Date.now()
  await win.getByTestId('dialogue-rebuild').click()
  // 결과가 나올 때까지 기다린다(모델을 올리지 않으므로 오래 걸리지 않는다).
  let made = []
  let madeDir = ''
  while (Date.now() - t0 < 120000) {
    if (fs.existsSync(RESULT_ROOT)) {
      for (const d of fs.readdirSync(RESULT_ROOT)) {
        const full = path.join(RESULT_ROOT, d)
        const wavs = fs.statSync(full).isDirectory()
          ? fs.readdirSync(full).filter((f) => f.endsWith('.wav')) : []
        if (wavs.length) { made = wavs; madeDir = full; break }
      }
    }
    if (made.length > 0) break
    await sleep(1000)
  }
  const elapsed = Math.round((Date.now() - t0) / 1000)
  const why = await win.evaluate(() => ({
    status: window.__afStore.getState().status,
    error: window.__afStore.getState().error,
    말: [...document.querySelectorAll('[data-testid="dialogue-apply-state"],[role="alert"]')]
      .map((e) => (e.textContent || '').trim()).filter(Boolean).join(' | '),
  }))
  ok(made.length > 0, '수정본으로 트랙을 다시 만든다',
    `${made.length}개 · ${elapsed}초 · ${JSON.stringify(why)} · 찾은 자리 ${RESULT_ROOT}`)
  ok(made.length === 1 && made[0].includes('화자 A'),
    '**고친 배정이 실제로 반영된다** — 셋 다 화자 A 로 바꾸자 화자 A 트랙 하나만 나온다',
    JSON.stringify(made))
  if (made.length === 1) {
    // 길이가 원본 전체에 걸쳐 있어야 한다(0~18초를 전부 배정했으므로).
    const bytes = fs.statSync(path.join(madeDir, made[0])).size
    ok(bytes > 100000, '떠 온 소리가 실제로 들어 있다', `${Math.round(bytes / 1024)}KB`)
  }
  const status = await win.evaluate(() => window.__afStore.getState().status)
  ok(status !== 'error', '다시 만들기가 오류로 끝나지 않는다', String(status))

} catch (e) {
  failed++
  log('FAIL 예외:', e && e.message)
} finally {
  if (app) await app.close().catch(() => {})
  cleanupUserData(UD)
  cleanupIsolated(ISO)
  try { fs.rmSync(OUT, { recursive: true, force: true }) } catch { /* noop */ }
}

log(failed === 0 ? '전부 통과 — 대화 구간 수정 확인(분석 재실행 없음).' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
