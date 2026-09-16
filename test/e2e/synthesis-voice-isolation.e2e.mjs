// 일반과 고급이 **서로의 목소리를 지우지 않는가** — 표적 확인.
//
// 실사용 결함(2026-09-16): 고급에서 목소리가 준비돼 있는데도 "목소리를 지정하라" 며 막혔다.
// 사용자 증언 — "이전에 테스트개발 쪽에 기능이 있을 때는 문제가 없었다."
//
// 원인: main 은 파생 참조 클립을 **clipKey 하나당 폴더 하나**로 관리하고, 새로 확정하면
// `releaseRefClip(clipKey)` 로 그 자리의 이전 폴더를 **지운다**. 그런데 일반(작업실)도 고급의
// 기본 목소리와 같은 'default' 를 쓰고 있었다. 합치기 전에는 작업실이 따로 들어가는 탭이라
// 일부러 쓰지 않으면 돌지 않았지만, 합친 뒤에는 **일반이 첫 화면**이라 저장된 목소리만 있으면
// 합성에 들어가는 것만으로 고급의 클립이 지워졌다.
//
// 이 검사는 음성을 만들지 않는다. 참조 준비까지만 돌린다.
//
// 실행: node test/e2e/synthesis-voice-isolation.e2e.mjs   (사전: npm run build. GPU 불필요)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const BASE = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')
if (!fs.existsSync(BASE)) { console.error('fixture 없음'); process.exit(2) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'af-voiceiso-'))
// 고급에는 권장 길이를 넘는 원본을 준다(구간을 잘라 파생 클립이 실제로 만들어지는 조건).
const LONG = makeLong(BASE, path.join(TMP, 'long.wav'), 5)

/** WAV 의 data 조각을 n 번 이어 붙인 파일을 만든다(헤더 길이만 갱신). */
function makeLong(src, dest, times) {
  const buf = fs.readFileSync(src)
  let pos = 12; let dataAt = -1; let dataLen = 0
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'data') { dataAt = pos + 8; dataLen = size; break }
    pos += 8 + size + (size % 2)
  }
  if (dataAt < 0) throw new Error('WAV data 조각을 찾지 못했다')
  const head = Buffer.from(buf.subarray(0, dataAt))
  const body = Buffer.concat(Array.from({ length: times }, () => buf.subarray(dataAt, dataAt + dataLen)))
  head.writeUInt32LE(body.length, dataAt - 4)
  head.writeUInt32LE(head.length + body.length - 8, 4)
  fs.writeFileSync(dest, Buffer.concat([head, body]))
  return dest
}

const UD = isolatedUserData()
let failed = 0
const log = (...a) => console.log('[voiceiso]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let app = null
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
  })
  app.process().stderr?.on('data', (d) => log('main stderr:', String(d).slice(0, 200)))
  const win = await app.firstWindow()
  win.on('crash', () => log('렌더러 crash'))
  win.on('pageerror', (e) => log('page error:', String(e).slice(0, 200)))
  win.on('console', (m) => { if (m.type() === 'error') log('console error:', m.text().slice(0, 200)) })
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.__afStore && !!window.__labStore, undefined, { timeout: 30000 })

  // ── 고급에서 기본 목소리를 준비한다 ────────────────────────────────────
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.setState({ mode: 'tts', synthesisTab: 'advanced', ttsText: '안녕하세요.' })
  }, LONG)

  let ready = false
  for (let i = 0; i < 25 && !ready; i++) {
    await sleep(3000)
    ready = await win.evaluate(() => window.__afStore.getState().ttsRefReady)
  }
  ok(ready, '고급의 기본 목소리가 준비된다')
  if (!ready) throw new Error('준비되지 않아 이후 확인이 의미 없다')

  const advClip = await win.evaluate(() => window.__afStore.getState().ttsReferenceClip)
  ok(!!advClip && fs.existsSync(advClip), '고급이 쓸 파생 클립 파일이 실제로 있다')

  // ── 일반으로 가서 **다른 파일**로 목소리를 준비한다 ────────────────────
  // 사용자가 하는 일 그대로다. 일반은 합성의 첫 화면이라 들어가기만 해도 이 준비가 돈다.
  await win.getByTestId('synthesis-tab-basic').click()
  await sleep(800)
  // 일반은 **자기 설정**으로 준비한다 — 목표 길이를 달리 잡으면 고급과 **다른 구간**이 나온다.
  // 실제로 사용자는 고급에서 구간을 손으로 바꾼다. 그때 두 결과는 서로 다른 파일이어야 한다.
  await win.evaluate(() => {
    const st = window.__labStore.getState()
    st.setSettings({ ...st.doc.settings, refTargetSec: 5 })
  })
  // 일반은 **불러온 파일과 같은 파일**을 목소리로 쓴다(제품이 그때만 준비한다).
  // 바로 이 조건에서 두 화면이 같은 파일을 각자의 설정으로 잘라 **같은 자리**에 넣고 있었다.
  await win.evaluate((p) => window.__labStore.getState().setVoice(p, '목소리'), LONG)

  let labReady = false
  for (let i = 0; i < 25 && !labReady; i++) {
    await sleep(3000)
    labReady = await win.evaluate(() => window.__labStore.getState().ref.ready)
  }
  const labState = await win.evaluate(() => {
    const r = window.__labStore.getState().ref
    return { ready: r.ready, phase: r.phase, msg: (r.message || '').slice(0, 40), clip: !!r.clip, reqId: !!r.reqId,
      voice: !!window.__labStore.getState().doc.voicePath }
  })
  ok(labReady, '일반도 자기 목소리를 준비한다', JSON.stringify(labState))

  const labClip = await win.evaluate(() => window.__labStore.getState().ref.clip)
  ok(!!labClip && labClip !== advClip, '일반과 고급의 파생 클립은 **서로 다른 파일**이다',
    labClip === advClip ? '같은 파일을 가리킨다' : '')

  // ── 핵심 ───────────────────────────────────────────────────────────────
  // 예전에는 여기서 고급의 클립 폴더가 통째로 지워졌다(같은 clipKey 를 썼기 때문).
  ok(fs.existsSync(advClip), '**일반이 목소리를 준비해도 고급의 클립이 사라지지 않는다**')

  await win.getByTestId('synthesis-tab-advanced').click()
  await sleep(1500)
  const stillReady = await win.evaluate(() => window.__afStore.getState().ttsRefReady)
  ok(stillReady, '고급으로 돌아와도 목소리가 그대로 준비돼 있다')
  const blocked = await win.evaluate(() => document.body.innerText.includes('음성 합성 시작 (준비 필요)'))
  ok(!blocked, '고급이 "준비 필요" 로 막히지 않는다')
} catch (e) {
  failed++
  log('FAIL 예외:', e && e.message)
} finally {
  if (app) await app.close().catch(() => {})
  cleanupUserData(UD)
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* noop */ }
}

log(failed === 0 ? '전부 통과 — 일반과 고급이 서로의 목소리를 지우지 않는다.' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
