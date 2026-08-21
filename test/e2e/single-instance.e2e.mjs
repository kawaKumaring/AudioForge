// Electron 단일 인스턴스 회귀 — 두 번째 실행은 창을 만들지 않고 종료, 첫 인스턴스만 유지.
// 실행: node test/e2e/single-instance.e2e.mjs  (사전: npm run build)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
let failed = 0
const ok = (c, m) => { console.log(c ? '[e2e] PASS' : '[e2e] FAIL', m); if (!c) failed++ }

const first = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
await first.firstWindow()
ok((await first.windows()).length === 1, '첫 인스턴스 윈도우 1개')

// 두 번째 인스턴스: 락 실패로 즉시 종료되어야 함. Playwright launch는 창이 안 뜨고 프로세스가
// 바로 종료되면 rejection한다 — 그 rejection(또는 창 없음)이 단일 인스턴스 동작의 증거다.
let second = null
let secondBlocked = false
try {
  second = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
  let secondWindow = null
  try { secondWindow = await second.firstWindow({ timeout: 4000 }) } catch { /* 창 안 열림 */ }
  secondBlocked = (secondWindow === null)
} catch {
  secondBlocked = true  // launch 자체가 rejection = 두 번째가 즉시 종료됨(락 정상)
}
ok(secondBlocked, '두 번째 인스턴스는 창을 만들지 않고 종료됨(단일 인스턴스 락)')
ok((await first.windows()).length === 1, '첫 인스턴스는 여전히 윈도우 1개')

if (second) { try { await second.close() } catch { /* 이미 종료 */ } }
await first.close()
console.log('[e2e] SUMMARY', JSON.stringify({ failed }))
process.exit(failed === 0 ? 0 : 1)
