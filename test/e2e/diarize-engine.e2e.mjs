// 대화 분석 엔진 선택과 겹침 표시 — 표적 확인.
//
// **화자 분석을 돌리지 않는다.** 화면 배선과 표현만 본다(모델은 아직 준비되지 않았다).
//
//   1) 대화 모드에만 '분석 방식' 선택이 있고 **기본은 기존 엔진**이다
//   2) 고른 값이 실제 실행 인자로 나간다
//   3) 겹침 정보를 구간 목록과 **따로** 보여 주고, 갈라냈다고 말하지 않는다
//   4) 모델이 없으면 **실패를 그대로 알린다**(몰래 기존 엔진으로 바꾸지 않는다)
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

  // 실제로 실행해 본다 — 모델이 없으므로 **실패해야** 한다(그것이 확인 대상이다).
  const t0 = Date.now()
  await win.evaluate(() => window.__afStore.setState({ nSpeakers: 2 }))
  await win.getByRole('button', { name: /대화 분리 시작/ }).click().catch(async () => {
    // 버튼 이름이 다르면 store 를 통해 직접 부른다.
    await win.evaluate(async (p) => {
      const s = window.__afStore.getState()
      await window.api.audio.process(p, 'conversation', {
        nSpeakers: 2, diarizeEngine: s.diarizeEngine,
      })
    }, SRC)
  })
  let err = ''
  while (Date.now() - t0 < 90000) {
    err = await win.evaluate(() => window.__afStore.getState().error || '')
    if (err) break
    await sleep(1000)
  }
  ok(!!err, '모델이 없으면 실패한다(조용히 넘어가지 않는다)', `"${String(err).slice(0, 70)}"`)
  ok(/DIARIZE_(MODEL|VENV)_MISSING|이용 조건|모델이 없습니다/.test(String(err)),
    '**무엇이 없어서 실패했는지** 사유가 나온다', `"${String(err).slice(0, 90)}"`)
  const madeAny = fs.existsSync(path.join(path.dirname(SRC), 'AudioForge_output'))
    && fs.readdirSync(path.join(path.dirname(SRC), 'AudioForge_output'))
      .some((d) => {
        const full = path.join(path.dirname(SRC), 'AudioForge_output', d)
        return fs.statSync(full).isDirectory() && fs.readdirSync(full).some((f) => f.endsWith('.wav'))
      })
  ok(!madeAny, '실패했으므로 기존 엔진으로 몰래 돌려 결과를 만들지 않는다')

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

log(failed === 0 ? '전부 통과 — 엔진 선택·겹침 표시 확인(분석 실행 없음).' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
