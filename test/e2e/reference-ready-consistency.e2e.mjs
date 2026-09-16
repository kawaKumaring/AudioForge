// 화면이 "준비 완료" 라고 말하면 **실제로 만들 수 있어야 한다.**
//
// 실사용 보고(2026-09-16): 목소리 카드에는 '참조 준비 완료 · ✓ 확정됨' 이 떠 있는데
// 아래 시작 단추는 '음성 합성 시작 (준비 필요)' 였다. 사용자 말 그대로
// "목소리가 준비 되어있어도 안된다고한다".
//
// 원인은 두 말이 **다른 근거**를 보고 있던 것이다.
//   · 패널 배지 — 이 패널이 만들어 둔 클립이 살아 있는가(자기 지역 상태)
//   · 시작 단추 — 앱이 합성에 쓸 준비가 됐는가(store)
// 그래서 둘이 갈라질 수 있었다. 이 검사는 **갈라지지 않는다**는 것만 본다.
//
// 실행: node test/e2e/reference-ready-consistency.e2e.mjs   (사전: npm run build. GPU 불필요)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
// 이 검사는 **권장 길이(3~10초)를 넘는 원본**이 있어야 의미가 있다. 저장소 음원(7.5초)을
// 이어 붙여 31초짜리를 그 자리에서 만든다 — 새 파일을 저장소에 넣지 않고, 게이트에서도 돈다.
const BASE = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')
if (!fs.existsSync(BASE)) { console.error('fixture 없음'); process.exit(2) }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'af-longref-'))
const SRC = process.env.AF_E2E_LONG_REFERENCE || makeLong(BASE, path.join(TMP, 'long.wav'), 5)

/** WAV 의 data 조각을 n 번 이어 붙인 파일을 만든다(헤더 길이만 갱신). */
function makeLong(src, dest, times) {
  const buf = fs.readFileSync(src)
  let pos = 12
  let dataAt = -1; let dataLen = 0
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
const log = (...a) => console.log('[refok]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const screen = (win) => win.evaluate(() => {
  const body = document.body.innerText
  return {
    // 표식이 아니라 **문구**로 본다 — 표식이 없던 판에서도 같은 질문에 답해야 한다.
    readyBadge: body.includes('참조 준비 완료'),
    confirmedLabel: [...document.querySelectorAll('button')]
      .some((b) => (b.textContent || '').includes('확정됨')),
    blocked: body.includes('음성 합성 시작 (준비 필요)'),
    reason: (body.match(/음성 합성 시작 \(준비 필요\)\s*\n?(.{0,60})/) || [])[1] || '',
    storeReady: window.__afStore.getState().ttsRefReady,
  }
})

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
    s.setState({ mode: 'tts', synthesisTab: 'advanced', ttsText: '안녕하세요. 오늘 회의는 세 시입니다.' })
  }, SRC)

  // 목소리가 준비될 때까지(추천 구간 자동 확정).
  let ready = false
  for (let i = 0; i < 25 && !ready; i++) {
    await sleep(3000)
    ready = await win.evaluate(() => window.__afStore.getState().ttsRefReady)
  }
  ok(ready, '긴 원본도 추천 구간으로 준비된다')
  if (!ready) throw new Error('준비되지 않아 이후 확인이 의미 없다')

  // 배지는 구간 편집을 펼쳐야 그려진다 — 사용자가 본 화면과 같게 펼쳐 둔다.
  const open = win.getByRole('button', { name: /사용 구간 바꾸기/ })
  if (await open.count() > 0) { await open.first().click(); await sleep(2000) }

  let s = await screen(win)
  ok(s.readyBadge && !s.blocked, '준비되면 배지도 뜨고 시작도 가능하다',
    `배지 ${s.readyBadge} / 막힘 ${s.blocked}`)

  // ── 핵심 ─────────────────────────────────────────────────────────────────
  // 앱이 "이 목소리는 아직 못 쓴다" 로 내려간 상태를 만든다. 패널이 만들어 둔 클립은 그대로다 —
  // 예전에는 바로 이때 배지가 계속 떠 있어서 화면이 서로 다른 말을 했다.
  await win.evaluate(() => window.__afStore.setState({ ttsRefReady: false }))
  await sleep(1200)
  s = await screen(win)
  ok(s.blocked, '앱이 못 쓰는 상태면 시작 단추는 막힌다', `사유 "${s.reason.trim().slice(0, 34)}…"`)
  ok(!s.readyBadge, '**그때 "참조 준비 완료" 라고 말하지 않는다**')
  ok(!s.confirmedLabel, '**"✓ 확정됨" 이라고도 말하지 않는다** — 눌러야 할 단추를 누른 것처럼 보이면 안 된다')

  // 막힌 사유는 참고 사항이 아니라 **할 일**이어야 한다.
  ok(s.reason.includes('확정'),
    '막힌 사유가 **할 일**을 말한다 — 길이 안내만 적어 두지 않는다', `"${s.reason.trim().slice(0, 40)}"`)
} catch (e) {
  failed++
  log('FAIL 예외:', e && e.message)
} finally {
  if (app) await app.close().catch(() => {})
  cleanupUserData(UD)
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* noop */ }
}

log(failed === 0 ? '전부 통과 — 화면의 "준비 완료" 와 실제 시작 가능이 갈라지지 않는다.' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
