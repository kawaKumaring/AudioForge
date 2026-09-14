// 대화 분석 엔진 선택과 겹침 표시 — 표적 확인.
//
// 화면에서 시작해 **실제로 한 번** 돌린다. 모델이 없으면 사유와 함께 실패하는지를 본다.
//
//   1) 대화 모드에만 '분석 방식' 선택이 있고 **기본은 기존 엔진**이다
//   2) 고른 값이 실제 실행 인자로 나간다
//   3) 겹침 정보를 구간 목록과 **따로** 보여 주고, 갈라냈다고 말하지 않는다
//   4) 준비됐으면 구간 표시·화자별 출력까지 가고, 없으면 사유와 함께 실패한다
//      (어느 쪽이든 몰래 기존 엔진으로 바꾸지 않는다)
//
// 실행: node test/e2e/diarize-engine.e2e.mjs   (사전: npm run build. GPU·모델 불필요)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isolatedInput, cleanupIsolated, isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const FIXTURE = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav')
if (!fs.existsSync(FIXTURE)) { console.error('fixture 없음'); process.exit(2) }
const { dir: ISO, input: SRC } = isolatedInput(FIXTURE)
// 결과는 원본 옆 AudioForge_output 에 생긴다(앱의 기존 규칙).
const RESULT_ROOT = path.join(path.dirname(SRC), 'AudioForge_output')

const UD = isolatedUserData()
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'af-dz-'))
let failed = 0
const log = (...a) => console.log('[dz]', ...a)
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
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.setState({ mode: 'conversation' })
  }, SRC)
  await win.waitForTimeout(1200)
  // 옵션은 기본 접힘이다 — 사용자가 하듯 펼친다.
  const openOptions = async () => {
    if (await win.getByTestId('diarize-engine-row').count() === 0) {
      await win.getByRole('button', { name: /옵션/ }).first().click().catch(() => {})
      await sleep(600)
    }
  }
  await openOptions()

  // ── 1) 선택이 있고 기본은 기존 엔진 ─────────────────────────────────────
  ok(await win.getByTestId('diarize-engine-row').count() === 1, '대화 모드에 분석 방식 선택이 있다')
  ok(await win.evaluate(() => window.__afStore.getState().diarizeEngine) === 'builtin',
    '**기본은 기존 엔진**이다')
  const tip = await win.getByTestId('diarize-engine-community-1').getAttribute('title')
  ok((tip || '').includes('이 컴퓨터 밖으로 나가지 않습니다'),
    '음원이 밖으로 나가지 않는다고 알린다')
  ok((tip || '').includes('준비돼 있지 않으면 실패를 그대로 알립니다'),
    '준비 안 됐을 때 어떻게 되는지 알린다')

  // 다른 모드에는 없다
  await win.evaluate(() => window.__afStore.setState({ mode: 'music' }))
  await sleep(500)
  ok(await win.getByTestId('diarize-engine-row').count() === 0, '다른 모드에는 나오지 않는다')
  await win.evaluate(() => window.__afStore.setState({ mode: 'conversation' }))
  await sleep(500)
  await openOptions()

  // ── 2) 고른 값이 실제로 나간다 ──────────────────────────────────────────
  await win.getByTestId('diarize-engine-community-1').click()
  await sleep(400)
  ok(await win.evaluate(() => window.__afStore.getState().diarizeEngine) === 'community-1',
    '고르면 상태가 바뀐다')

  // 실제로 한 번 돌린다 — 화면에서 시작해 구간 표시·화자별 출력까지.
  // 모델이 준비돼 있으면 성공해야 하고, 없으면 **사유와 함께 실패**해야 한다. 둘 다 확인한다.
  const t0 = Date.now()
  await win.evaluate(() => window.__afStore.setState({ nSpeakers: 2 }))
  await win.getByRole('button', { name: /대화 분리 시작/ }).click()
  let state = ''
  while (Date.now() - t0 < 300000) {
    state = await win.evaluate(() => {
      const s = window.__afStore.getState()
      return s.error ? 'error:' + s.error : s.status
    })
    if (state === 'done' || state.startsWith('error:')) break
    await sleep(2000)
  }
  const elapsed = Math.round((Date.now() - t0) / 1000)

  if (state.startsWith('error:')) {
    // 준비 안 된 환경 — 사유가 나와야 하고, 몰래 기존 엔진으로 돌려 결과를 만들면 안 된다.
    ok(/DIARIZE_(MODEL|VENV)_MISSING|DIARIZE_NOT_READY|이용 조건|모델이 없습니다/.test(state),
      '준비 안 됐으면 **무엇이 없어서** 실패했는지 알린다', `"${state.slice(6, 96)}"`)
    const madeAny = fs.existsSync(RESULT_ROOT) && fs.readdirSync(RESULT_ROOT).some((d) => {
      const full = path.join(RESULT_ROOT, d)
      return fs.statSync(full).isDirectory() && fs.readdirSync(full).some((f) => f.endsWith('.wav'))
    })
    ok(!madeAny, '실패했으므로 기존 엔진으로 몰래 돌려 결과를 만들지 않는다')
  } else {
    ok(state === 'done', 'Community-1 분석이 완주한다', `${elapsed}초`)
    const segs = await win.evaluate(() => window.__afStore.getState().dialogueSegments || [])
    ok(segs.length > 0, '화자 구간이 화면 상태로 들어온다', `${segs.length}개`)
    ok(await win.getByTestId('dialogue-segments').count() === 1, '구간 수정 화면이 나온다')
    ok(await win.getByTestId('dialogue-row').count() === segs.length,
      '구간이 줄로 그대로 표시된다', `${await win.getByTestId('dialogue-row').count()}줄`)
    // 화자별 출력이 실제로 만들어졌는가 — 원본 시간축·표본율을 따라야 한다.
    const dirs = fs.existsSync(RESULT_ROOT) ? fs.readdirSync(RESULT_ROOT) : []
    let wavs = []
    for (const d of dirs) {
      const full = path.join(RESULT_ROOT, d)
      if (fs.statSync(full).isDirectory()) {
        const w = fs.readdirSync(full).filter((f) => f.endsWith('.wav'))
        if (w.length) { wavs = w.map((f) => path.join(full, f)); break }
      }
    }
    ok(wavs.length > 0, '화자별 출력 파일이 만들어진다', `${wavs.length}개`)
    ok(wavs.every((f) => fs.statSync(f).size > 10000), '출력에 실제 소리가 들어 있다')
  }

  // ── 3) 겹침 표시 ────────────────────────────────────────────────────────
  await win.evaluate(() => window.__afStore.setState({
    status: 'done', error: null,
    dialogueSegments: [
      { start: 0, end: 5, speaker: 'SPEAKER_00' },
      { start: 5, end: 9, speaker: 'SPEAKER_01' },
    ],
    dialogueOverlaps: [{ start: 4.5, end: 5.2 }],
    tracks: [{ name: 'speaker_a', label: 'SPEAKER_00', path: 'x.wav' }],
  }))
  await sleep(900)
  ok(await win.getByTestId('dialogue-overlaps').count() === 1, '겹침 정보를 따로 보여 준다')
  const ov = await win.getByTestId('dialogue-overlaps').textContent()
  ok((ov || '').includes('동시에 말한 구간 1곳'), '몇 곳인지 알린다', `"${(ov || '').trim().slice(0, 34)}…"`)
  ok((ov || '').includes('갈라낸 것은 아닙니다'),
    '**겹침을 찾은 것과 갈라낸 것을 구분한다**')
  ok(await win.getByTestId('dialogue-row').count() === 2,
    '겹침이 구간 목록에 섞이지 않는다(구간은 2개 그대로)')

  // 겹침이 없으면 그 자리도 없다
  await win.evaluate(() => window.__afStore.setState({ dialogueOverlaps: [] }))
  await sleep(500)
  ok(await win.getByTestId('dialogue-overlaps').count() === 0, '겹침이 없으면 표시하지 않는다')
} catch (e) {
  failed++
  log('FAIL 예외:', e && e.message)
} finally {
  if (app) await app.close().catch(() => {})
  cleanupUserData(UD)
  cleanupIsolated(ISO)
  try { fs.rmSync(OUT, { recursive: true, force: true }) } catch { /* noop */ }
}

log(failed === 0 ? '전부 통과 — 엔진 선택·실제 실행·겹침 표시 확인.' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
