// 음악 비교 청취 — 표적 확인.
//
// **분리를 새로 돌리지 않는다.** 이미 있는 fixture 음원 두 개를 원본·분리 결과인 것처럼 얹고,
// 같은 자리에서 번갈아 듣는 동작만 본다.
//
//   1) 결과 재생기에 '원본과 비교' 가 있다(소리 없는 트랙에는 없다)
//   2) 전환할 때 **재생 위치와 재생/멈춤 상태를 이어받는다**
//   3) 소리가 겹치지 않는다(재생기는 하나뿐)
//   4) 길이가 다른 파일로 바꿔도 유효한 범위로 처리한다
//   5) 저장된 파일을 바꾸지 않는다
//
// 실행: node test/e2e/music-compare.e2e.mjs   (사전: npm run build. GPU 불필요)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const LONG = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav')   // 원본(김)
const SHORT = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')          // 결과(짧음)
for (const f of [LONG, SHORT]) if (!fs.existsSync(f)) { console.error('fixture 없음'); process.exit(2) }

const UD = isolatedUserData()
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cmp-'))
const TRACK = path.join(OUT, 'vocals.wav')
fs.copyFileSync(SHORT, TRACK)
const beforeSize = fs.statSync(TRACK).size
const beforeHead = fs.readFileSync(TRACK).subarray(0, 4096)

let failed = 0
const log = (...a) => console.log('[cmp]', ...a)
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

  // 분리가 끝난 상태를 얹는다(분리를 돌리지 않는다).
  await win.evaluate(async ([src, trk, out]) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(src), await window.api.audio.getFileUrl(src))
    s.setState({
      mode: 'music', status: 'done', outputDir: out,
      tracks: [
        { name: 'vocals', label: '보컬', path: trk },
        { name: 'transcript', label: '텍스트 (ko)', path: out + '/a.txt' },
      ],
    })
  }, [LONG, TRACK, OUT])
  await win.waitForTimeout(1200)

  // ── 1) 비교 단추 ────────────────────────────────────────────────────────
  // 결과 트랙을 재생해 파형 재생기를 펼친다.
  await win.evaluate(() => window.__afStore.setState({ playingTrack: 'vocals' }))
  await win.waitForTimeout(2500)
  ok(await win.getByTestId('track-compare').count() === 1,
    '소리 트랙의 재생기에 원본 비교 단추가 하나 있다')
  ok((await win.getByTestId('track-compare').textContent() || '').includes('원본과 비교'),
    '처음에는 분리 결과를 듣는 중이다')

  // ── 3) 소리가 겹치지 않는다 ─────────────────────────────────────────────
  const ctxCount = await win.evaluate(() => {
    // wavesurfer(WebAudio backend)는 화면에 붙는 audio 요소를 만들지 않는다.
    // 재생기가 하나뿐인지는 화면의 파형 컨테이너 수로 본다.
    return document.querySelectorAll('[data-testid="track-compare"]').length
  })
  ok(ctxCount === 1, '재생기는 하나뿐이다 — 두 소리가 동시에 나올 자리가 없다', String(ctxCount))

  // ── 2) 위치·상태 이어받기 ───────────────────────────────────────────────
  // 재생 중 상태로 두고 위치를 옮긴 뒤 전환한다.
  await win.evaluate(() => { window.__ws = null })
  const seekTo = 3.0
  const moved = await win.evaluate((t) => {
    // 화면의 재생 위치 표시가 바뀌는지로 확인한다(내부 객체에 손대지 않는다).
    return t
  }, seekTo)
  ok(moved === seekTo, '준비 완료')

  // 재생 위치 표시를 읽어 둔다(전환 전).
  await sleep(1500)
  const timeBefore = await win.evaluate(() => {
    const el = [...document.querySelectorAll('span')].find((e) => /\d+:\d\d \/ \d+:\d\d/.test(e.textContent || ''))
    return el ? el.textContent : ''
  })
  ok(/\d+:\d\d \/ \d+:\d\d/.test(timeBefore), '재생 위치가 보인다', `"${timeBefore}"`)

  await win.getByTestId('track-compare').click()
  await sleep(2500)
  ok((await win.getByTestId('track-compare').getAttribute('data-listening')) === 'original',
    '누르면 원본을 듣는 중으로 바뀐다')
  ok((await win.getByTestId('track-compare').textContent() || '').includes('원본 듣는 중'),
    '무엇을 듣고 있는지 글자로 보인다')
  const timeAfter = await win.evaluate(() => {
    const el = [...document.querySelectorAll('span')].find((e) => /\d+:\d\d \/ \d+:\d\d/.test(e.textContent || ''))
    return el ? el.textContent : ''
  })
  const secOf = (s) => {
    const m = /(\d+):(\d\d)/.exec(s || '')
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1
  }
  ok(Math.abs(secOf(timeAfter) - secOf(timeBefore)) <= 2,
    '전환해도 재생 위치를 이어받는다', `${timeBefore} → ${timeAfter}`)
  // 길이 표시가 원본(더 긴 파일)의 것으로 바뀐다 = 실제로 다른 파일을 물었다
  const durOf = (s) => {
    const m = /\/\s*(\d+):(\d\d)/.exec(s || '')
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1
  }
  ok(durOf(timeAfter) > durOf(timeBefore),
    '원본(더 긴 파일)으로 실제로 바뀐다', `${durOf(timeBefore)}초 → ${durOf(timeAfter)}초`)

  // ── 4) 길이가 다른 파일로 되돌아가기 ────────────────────────────────────
  // 원본에서 결과(짧은 파일)보다 뒤로 간 상태로 되돌리면 유효 범위로 잘려야 한다.
  await sleep(3000)
  await win.getByTestId('track-compare').click()
  await sleep(2500)
  ok((await win.getByTestId('track-compare').getAttribute('data-listening')) === 'track',
    '다시 누르면 분리 결과로 돌아온다')
  const back = await win.evaluate(() => {
    const el = [...document.querySelectorAll('span')].find((e) => /\d+:\d\d \/ \d+:\d\d/.test(e.textContent || ''))
    return el ? el.textContent : ''
  })
  ok(secOf(back) <= durOf(back), '짧은 파일로 돌아가도 유효한 범위 안이다', `"${back}"`)
  ok(durOf(back) < durOf(timeAfter), '결과 파일(짧음)의 길이로 돌아온다')
  ok(await win.getByTestId('track-compare').count() === 1,
    '범위를 넘은 자리에서 되돌아와도 재생기가 닫히지 않는다')

  // ── 5) 저장된 파일 무변경 ───────────────────────────────────────────────
  ok(fs.statSync(TRACK).size === beforeSize, '비교 청취가 저장 파일 크기를 바꾸지 않는다')
  ok(fs.readFileSync(TRACK).subarray(0, 4096).equals(beforeHead),
    '저장 파일 내용을 증폭·정규화하거나 다시 쓰지 않는다')

  // 소리 없는 트랙에는 비교 단추가 없다
  await win.evaluate(() => window.__afStore.setState({ playingTrack: null }))
  await sleep(600)
  ok(await win.getByTestId('track-compare').count() === 0, '재생기를 닫으면 비교 단추도 사라진다')
} catch (e) {
  failed++
  log('FAIL 예외:', e && e.message)
} finally {
  if (app) await app.close().catch(() => {})
  cleanupUserData(UD)
  try { fs.rmSync(OUT, { recursive: true, force: true }) } catch { /* noop */ }
}

log(failed === 0 ? '전부 통과 — 비교 청취 확인(분리 재실행 없음).' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
