// 외부 전송 금지 — **장치가 실제로 막는가**(검사 도구의 보안 정책 우회 없이).
//
// ★사용자 원칙(최우선): "무조건 외부로 보내지 않는다 … 외부로 보내야 한다면 명확하게 지적한 뒤 막아야 한다."
// ★보안 정책(CSP)은 화면이 뜨는 첫 순간에 걸린다(cspPolicy.ts). 검사로 띄운 앱은 검사 도구가 쓰는 eval 만 더
//   허락하고, 바깥 연결 규칙은 제품과 같다 — 그래서 여기서 '바깥이 막히는가' 를 보면 제품을 본 것이다.
//   제품 정책에 eval 이 없는 것은 단위 검사(offlinePolicy.test.ts)가 본다.
//
// 여기서 보는 것
//   1) 보안 정책이 켜진 채로 앱이 뜬다 · 화면에 정책이 있다
//   2) 화면에서 바깥 주소로 요청하면 막힌다
//   3) 본체에서 바깥 주소로 요청하면 막히고, 막았다는 기록이 남는다
//   4) 앱 소리 주소(local-file)는 정책 아래에서도 열린다
//   5) 파이썬에 물려줄 오프라인 설정이 켜져 있다 · 맞춤법 사전 내려받기가 꺼져 있다
//
// 실행: node test/e2e/offline-guard.e2e.mjs   (사전: npm run build. GPU 불필요)
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import fs from 'fs'
import path from 'path'
import { _electron as electron } from 'playwright'
import { isolatedUserData, cleanupUserData, makeSyntheticWav, enterStudio } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const UD = isolatedUserData()
let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let app = null
try {
  app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD } })
  const win = await app.firstWindow()
  let booted = false
  await enterStudio(win)        // 시작 화면의 '작업실 시작'(2026-10-03)
  for (let i = 0; i < 60 && !booted; i++) { booted = await win.evaluate(() => !!window.__afStore).catch(() => false); if (!booted) await sleep(250) }
  ok(booted, '★보안 정책이 켜진 채로 앱이 뜬다')
  const csp = await win.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || '')
  ok(/default-src 'self'/.test(csp) && /connect-src 'self'/.test(csp) && !/(?:https?|wss?):\/\/(?!localhost|127\.0\.0\.1)/.test(csp), '화면에 보안 정책이 걸려 있고 바깥 주소를 허락하지 않는다', csp.slice(0, 80))

  // ── 화면 → 바깥 ─────────────────────────────────────────────────────
  const fromScreen = await win.evaluate(async () => {
    try { await fetch('https://example.com/af-probe'); return 'reached' } catch (e) { return 'blocked' }
  })
  ok(fromScreen === 'blocked', '★화면에서 바깥 주소로 가는 요청은 막힌다', fromScreen)

  // ── 본체 → 바깥 ─────────────────────────────────────────────────────
  const fromMain = await app.evaluate(async ({ net }) => {
    try { await net.fetch('https://example.com/af-probe-main'); return 'reached' } catch { return 'blocked' }
  })
  ok(fromMain === 'blocked', '★본체에서 바깥 주소로 가는 요청도 막힌다', fromMain)
  await sleep(300)
  const log = fs.readdirSync(path.join(UD, 'logs')).map((n) => fs.readFileSync(path.join(UD, 'logs', n), 'utf-8')).join('')
  ok(/\[net\] 바깥 요청을 막았다 — example\.com/.test(log), '막았다는 기록이 남는다(어디로 가려 했는지)')
  ok(/바깥 전송 막음 · 파이썬 오프라인/.test(log), '기동 기록에 외부 전송 차단이 남는다')

  // ── 앱 소리 주소는 열린다 ───────────────────────────────────────────
  const wav = makeSyntheticWav(path.join(UD, 'probe.wav'), 1)
  const media = await win.evaluate(async (p) => {
    const url = await window.api.audio.getFileUrl(p)
    return await new Promise((res) => {
      const a = new Audio(); a.oncanplay = () => res('ok'); a.onerror = () => res('error'); a.src = url
      setTimeout(() => res('timeout'), 8000)
    })
  }, wav)
  ok(media === 'ok', '★앱 소리 주소(local-file)는 보안 정책 아래에서도 열린다', media)

  // ── 파이썬 오프라인 · 맞춤법 사전 ───────────────────────────────────
  const env = await app.evaluate(() => ({ hf: process.env.HF_HUB_OFFLINE, tf: process.env.TRANSFORMERS_OFFLINE, tel: process.env.HF_HUB_DISABLE_TELEMETRY }))
  ok(env.hf === '1' && env.tf === '1' && env.tel === '1', '★파이썬에 물려줄 오프라인 설정이 켜져 있다', env)
  // ★창마다 끄는 것으로는 부족했다 — 세션이 켜진 채 사전을 내려받았고, 그 내려받기는 요청 차단 창구를 거치지 않았다.
  const spell = await app.evaluate(({ session }) => session.defaultSession.isSpellCheckerEnabled())
  ok(spell === false, '★맞춤법 검사기(구글에서 사전을 내려받던 것)가 세션에서 꺼져 있다', spell)
  await sleep(2000)
  const dict = path.join(UD, 'Dictionaries')
  const bdic = fs.existsSync(dict) ? fs.readdirSync(dict).filter((n) => n.endsWith('.bdic')) : []
  ok(bdic.length === 0, '★맞춤법 사전을 내려받지 않았다', bdic)
} catch (e) {
  console.error('FAIL', e?.message || e)
  fails.push(String(e?.message || e))
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
}
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
