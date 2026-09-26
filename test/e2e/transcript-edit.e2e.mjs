// 텍스트 교정 — 표적 확인.
//
// 전사를 **새로 돌리지 않는다.** 이미 있는 fixture 음원과 전사 결과 모양을 얹고,
// 사용자가 실제로 하는 동작만 본다.
//
//   1) 문장과 시작·끝 시간이 함께 보인다
//   2) 문장을 누르면 **그 구간**을 재생하고, 다른 문장·정지·화면 이동에서 이전 재생을 정리한다
//   3) 글자를 고쳐도 재전사가 돌지 않고, 되돌리면 처음 인식한 글자로 돌아온다
//   4) 교정본 TXT·SRT 가 저장되고 **처음 인식한 파일은 그대로 남는다**
//   5) 저장 실패를 안내한다 / 고친 내용이 앱을 다시 켜도 남는다
//
// 실행: node test/e2e/transcript-edit.e2e.mjs   (사전: npm run build. GPU 불필요)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const SRC = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav')
if (!fs.existsSync(SRC)) { console.error('fixture 없음'); process.exit(2) }

const UD = isolatedUserData()
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'af-tr-'))
// 처음 인식한 파일이 있는 것처럼 둔다 — 교정본이 이것을 덮지 않는지 본다.
fs.writeFileSync(path.join(OUT, 'a.txt'), '처음 인식한 결과', 'utf-8')
fs.writeFileSync(path.join(OUT, 'a.srt'), '1\n00:00:00,000 --> 00:00:02,500\n처음 인식한 결과\n', 'utf-8')

let failed = 0
const log = (...a) => console.log('[tr-edit]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SEGMENTS = [
  { start: 0, end: 2.5, text: '첫 문장입니다.' },
  { start: 2.5, end: 5.0, text: '둘째 문장입니다.' },
  { start: 5.0, end: 8.0, text: '셋째 문장입니다.' },
]

async function launch() {
  const app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.__afStore, undefined, { timeout: 30000 })
  // 전사가 끝난 상태를 그대로 얹는다(전사를 새로 돌리지 않는다).
  await win.evaluate(async ([p, segs, out]) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.setState({
      mode: 'transcribe', status: 'done', outputDir: out,
      tracks: [{ name: 'transcript', label: '텍스트 (ko)', path: out + '/a.txt',
                 text: segs.map((x) => x.text).join(' '), language: 'ko', base: 'a', segments: segs }],
    })
  }, [SRC, SEGMENTS, OUT])
  await win.waitForTimeout(900)
  return { app, win }
}

let app1 = null, app2 = null
try {
  const first = await launch()
  app1 = first.app
  const win = first.win

  // ── 1) 문장과 시간 ──────────────────────────────────────────────────────
  ok(await win.getByTestId('transcript-editor').count() === 1, '전사 결과 아래에 교정 자리가 나온다')
  const rows = await win.getByTestId('transcript-row').count()
  ok(rows === 3, '문장이 줄로 펼쳐진다', String(rows))
  const times = await win.getByTestId('transcript-time').allTextContents()
  ok(times[0].includes('0:00.0') && times[0].includes('0:02.5'),
    '시작·끝 시간이 함께 보인다', `"${times[0]}"`)
  const vals = await win.evaluate(() =>
    [...document.querySelectorAll('[data-testid="transcript-input"]')].map((e) => e.value))
  ok(vals[1] === '둘째 문장입니다.', '처음 인식한 글자가 그대로 보인다')

  // ── 2) 구간 재생 ────────────────────────────────────────────────────────
  await win.evaluate(() => {
    window.__seeks = []
    const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      get() { return d.get.call(this) },
      set(v) { window.__seeks.push(v); return d.set.call(this, v) },
    })
    window.__plays = []; window.__pauses = 0
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (...a) { window.__plays.push(this.src); return play.apply(this, a) }
    const pause = HTMLMediaElement.prototype.pause
    HTMLMediaElement.prototype.pause = function (...a) { window.__pauses += 1; return pause.apply(this, a) }
  })
  await win.getByTestId('transcript-play').nth(1).click()
  await sleep(900)
  const seeks = await win.evaluate(() => window.__seeks)
  ok(seeks.includes(2.5), '누른 문장의 **시작 시간으로 이동**한다', JSON.stringify(seeks))
  ok((await win.evaluate(() => window.__plays)).length === 1, '실제로 재생한다')
  ok((await win.getByTestId('transcript-play').nth(1).textContent() || '').includes('■'),
    '재생 중인 문장이 표시된다')

  // 다른 문장을 누르면 이전 재생을 정리한다
  await win.getByTestId('transcript-play').nth(2).click()
  await sleep(700)
  ok(await win.evaluate(() => window.__pauses) >= 1, '다른 문장을 누르면 이전 재생을 멈춘다')
  ok((await win.evaluate(() => window.__seeks)).includes(5), '새 문장의 시작으로 이동한다')
  ok((await win.getByTestId('transcript-play').nth(1).textContent() || '').includes('▶'),
    '이전 문장 표시가 풀린다')
  // 같은 문장을 다시 누르면 멈춘다
  const before = await win.evaluate(() => window.__plays.length)
  await win.getByTestId('transcript-play').nth(2).click()
  await sleep(500)
  ok(await win.evaluate(() => window.__plays.length) === before, '같은 문장을 다시 누르면 멈춘다(다시 재생하지 않는다)')

  // 화면을 떠나면 재생을 정리한다
  await win.getByTestId('transcript-play').nth(0).click()
  await sleep(600)
  const pausesBefore = await win.evaluate(() => window.__pauses)
  await win.evaluate(() => window.__afStore.setState({ mode: 'music' }))
  await sleep(600)
  ok(await win.evaluate(() => window.__pauses) > pausesBefore, '화면을 떠나면 재생을 정리한다')
  await win.evaluate(() => window.__afStore.setState({ mode: 'transcribe' }))
  await sleep(700)

  // ── 3) 고치기 / 되돌리기 ────────────────────────────────────────────────
  const input = win.getByTestId('transcript-input').nth(1)
  await input.fill('둘째 문장을 고쳤습니다.')
  await sleep(500)
  ok((await win.getByTestId('transcript-edited-count').textContent() || '').includes('1개'),
    '고친 문장 수가 보인다')
  ok(await win.evaluate(() =>
    document.querySelectorAll('[data-testid="transcript-row"]')[1].getAttribute('data-edited')) === '1',
    '고친 줄이 표시된다')
  ok(await win.getByTestId('transcript-notes').count() === 1, '시간을 다시 계산하지 않았다는 안내가 뜬다')
  const note = await win.getByTestId('transcript-notes').textContent()
  ok((note || '').includes('다시 계산하지 않았습니다'),
    '고친 글자에 맞는 시간이라고 말하지 않는다', `"${(note || '').trim().slice(0, 40)}…"`)
  // 글자 수정만으로 재전사·재번역이 돌지 않는다
  const st = await win.evaluate(() => window.__afStore.getState().status)
  ok(st === 'done', '글자 수정으로 다시 돌리지 않는다', st)
  const timesAfter = await win.getByTestId('transcript-time').allTextContents()
  ok(timesAfter[1] === times[1], '고쳐도 시간 표시가 그대로다')

  // 되돌리기
  await win.getByTestId('transcript-revert').first().click()
  await sleep(400)
  const reverted = await win.evaluate(() =>
    [...document.querySelectorAll('[data-testid="transcript-input"]')].map((e) => e.value))
  ok(reverted[1] === '둘째 문장입니다.', '되돌리면 처음 인식한 글자로 돌아온다')
  await input.fill('둘째 문장을 고쳤습니다.')
  await sleep(500)

  // ── 4) 교정본 저장 ──────────────────────────────────────────────────────
  await win.getByTestId('transcript-save').click()
  await sleep(1200)
  const msg = await win.getByTestId('transcript-message').textContent()
  ok((msg || '').includes('저장했습니다'), '저장 결과를 알린다', `"${(msg || '').trim()}"`)
  const txtPath = path.join(OUT, 'a_corrected.txt')
  const srtPath = path.join(OUT, 'a_corrected.srt')
  ok(fs.existsSync(txtPath) && fs.existsSync(srtPath), '교정본 TXT·SRT 가 생긴다')
  const txt = fs.readFileSync(txtPath, 'utf-8')
  ok(txt.includes('둘째 문장을 고쳤습니다.') && txt.includes('첫 문장입니다.'),
    '교정본에 고친 글자가 들어간다')
  const srt = fs.readFileSync(srtPath, 'utf-8')
  // ★이 검사는 예전에 '2.500 --> 5.000' 을 고정하고 있었다(2026-09-24 2차 감사).
  //   그때 교정본 자막은 **손질을 건너뛴 유일한 자막**이었다 — 같은 폴더의
  //   a.srt 는 손질을 거치는데 a_corrected.srt 만 안 거쳤다. 이제 거친다.
  //   둘째 문장은 셋째(5.0s)와 맞닿아 있어 **끝이 4.92s 로 0.08초 떨어진다** —
  //   자막끼리 붙어 깜빡이지 않게 하는 간격이다. 시작은 그대로여야 한다.
  ok(srt.includes('00:00:02,500 --> 00:00:04,920'),
    '시작은 인식한 그대로, 끝만 겹침 방지로 0.08초 당겨진다',
    (srt.split('\n').find((l) => l.startsWith('00:00:02')) || '').trim())
  ok(!srt.includes('00:00:05,000 --> 00:00:05'), '간격을 떼느라 자막을 없애지 않는다')
  ok(fs.readFileSync(path.join(OUT, 'a.txt'), 'utf-8') === '처음 인식한 결과',
    '처음 인식한 파일을 덮어쓰지 않는다')
  ok(fs.readFileSync(path.join(OUT, 'a.srt'), 'utf-8').includes('처음 인식한 결과'),
    '처음 인식한 자막도 그대로다')

  // ── 5) 저장 실패 안내 ───────────────────────────────────────────────────
  await win.evaluate(() => window.__afStore.setState({ outputDir: '' }))
  await sleep(300)
  await win.getByTestId('transcript-save').click()
  await sleep(800)
  const err = await win.getByTestId('transcript-message').textContent()
  ok((err || '').includes('알 수 없습니다') || (err || '').includes('저장하지 못했습니다'),
    '저장 실패를 숨기지 않고 알린다', `"${(err || '').trim()}"`)
  await win.evaluate(([o]) => window.__afStore.setState({ outputDir: o }), [OUT])
  await sleep(900)
  await app1.close()
  app1 = null

  // ── 앱을 다시 켜도 고친 내용이 남는다 ───────────────────────────────────
  const second = await launch()
  app2 = second.app
  const back = await second.win.evaluate(() =>
    [...document.querySelectorAll('[data-testid="transcript-input"]')].map((e) => e.value))
  ok(back[1] === '둘째 문장을 고쳤습니다.', '앱을 다시 켜도 고친 내용이 남는다', `"${back[1]}"`)
  ok(back[0] === '첫 문장입니다.', '고치지 않은 문장은 처음 인식한 글자 그대로다')
} catch (e) {
  failed++
  log('FAIL 예외:', e && e.message)
} finally {
  if (app1) await app1.close().catch(() => {})
  if (app2) await app2.close().catch(() => {})
  cleanupUserData(UD)
  try { fs.rmSync(OUT, { recursive: true, force: true }) } catch { /* noop */ }
}

log(failed === 0 ? '전부 통과 — 텍스트 교정 확인(전사 재실행 없음).' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
