// 낭독이 **도는 동안 남에게 보이는가** — 공용 판정(synthesisGate)의 반대 방향.
//
// ★왜 (2026-09-30): 낭독은 시작 전에 다른 작업을 보고 비켰지만, 낭독이 참조 목소리로 소리를 만드는 동안에는
//   다른 화면이 몰라서 합성을 눌러 **파이썬 둘이 같은 GPU 를 동시에** 물 수 있었다. "한쪽만 보는 가드는 가드가 아니다."
// ★기본 목소리는 알리지 않는다 — CPU 이고, 책을 열기만 해도 앞서 만들어 둔다. 알리면 책을 연 것만으로 합성이 거절된다.
//
// 여기서 보는 것 (기능 검사의 낭독 길을 그대로 탄다 — 낭독 줄·제 폴더·같은 설정)
//   1) 아무것도 안 돌면 거절 사유가 없다
//   2) 낭독 · 기본 목소리가 만드는 동안 — 낭독 때문에 거절되지 **않는다**
//   3) 낭독 · 참조 목소리가 만드는 동안 — 합성이 '낭독' 사유로 거절된다(사람 말로)
//   4) 끝나면 다시 비워진다
// ★합성을 실제로 눌러 보지 않는다 — 누르면 그것이 작업을 띄워 낭독을 막는다. 공용 판정의 답만 묻는다(검사 전용 창구).
// ★GPU 를 쓴다(참조 목소리 한 문장 · 30초~1분).
//
// 실행: node test/e2e/reader-gate.e2e.mjs   (사전: npm run build)
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import fs from 'fs'
import path from 'path'
import { _electron as electron } from 'playwright'
import { isolatedUserData, cleanupUserData, enterStudio } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const UD = isolatedUserData()
let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}

/** 검사 하나를 돌리는 동안 공용 판정의 답을 계속 묻는다. 본 사유들을 돌려준다. */
async function watchWhile(win, id) {
  return await win.evaluate(async (checkId) => {
    const seen = []
    let done = false
    const run = window.api.selfcheck.run(checkId).then((r) => { done = true; return r })
    while (!done) {
      const why = await window.api.audio.e2eBusyReason('합성')
      if (why && !seen.includes(why)) seen.push(why)
      await new Promise((r) => setTimeout(r, 150))
    }
    const result = await run
    return { seen, state: result?.ok === true ? 'ok' : (result?.reason || result?.error || 'fail'), after: await window.api.audio.e2eBusyReason('합성') }
  }, id)
}

let app = null
try {
  app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, HF_HUB_OFFLINE: '1' } })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)
  await enterStudio(win)        // 시작 화면의 '작업실 시작'(2026-10-03)

  ok(await win.evaluate(() => window.api.audio.e2eBusyReason('합성')) === '', '아무것도 안 돌면 거절 사유가 없다')

  const builtin = await watchWhile(win, 'reader-builtin')
  ok(builtin.state === 'ok', '낭독 · 기본 목소리 검사가 실제로 통과한다', builtin)
  ok(!builtin.seen.some((w) => /낭독/.test(w)), '★기본 목소리가 만드는 동안 낭독 때문에 합성이 막히지 않는다', builtin.seen)

  const ref = await watchWhile(win, 'reader-reference')
  ok(ref.state === 'ok', '낭독 · 참조 목소리 검사가 실제로 통과한다', ref)
  ok(ref.seen.some((w) => /낭독이 GPU 목소리\(참조 목소리·Qwen\)로 소리를 만드는 중에는 합성을 시작할 수 없습니다/.test(w)),
    '★참조 목소리가 만드는 동안 합성이 낭독 사유로 거절된다', ref.seen)
  ok(ref.after === '', '끝나면 다시 비워진다', ref.after)
} catch (e) {
  console.error('FAIL', e?.message || e)
  fails.push(String(e?.message || e))
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
}
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
