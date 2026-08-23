// 독립 실행(standalone) 런타임 launch smoke — ComfyUI·GPU 없이 부팅하고,
// 런타임 미구성 상태를 "검은 화면/크래시 없이" 사용자에게 표면화하는지 검증한다(R4).
//
// 결정성: 격리된 빈 userData(--user-data-dir)로 실행하고 AUDIOFORGE_RUNTIME_ROOT를 제거한다.
// R3 계약상 조용한 'python' fallback이 없으므로, 이 조건에서 런타임은 반드시 미해석(resolved=0)이어야 한다.
// 즉 이 스모크는 (a) 독립 부팅 (b) 미구성의 우아한 표면화 (c) 무-fallback 계약을 동시에 확인한다.
// 실행: node test/e2e/standalone-runtime.e2e.mjs  (사전: npm run build)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }

let failed = 0
const ok = (c, m) => { console.log(c ? '[e2e] PASS' : '[e2e] FAIL', m); if (!c) failed++ }

// 격리 userData — 사용자의 실제 설정/런타임 구성에 의존하지 않는다.
const USERDATA = path.join(os.tmpdir(), 'audioforge_e2e_userdata_' + randomUUID())
fs.mkdirSync(USERDATA, { recursive: true })

// AUDIOFORGE_RUNTIME_ROOT 제거 + AF_E2E 게이트.
const env = { ...process.env, AF_E2E: '1' }
delete env.AUDIOFORGE_RUNTIME_ROOT

const pageErrors = [], crashes = []

const app = await electron.launch({
  args: ['out/main/index.js', '--user-data-dir=' + USERDATA],
  cwd: APP,
  env,
})
const win = await app.firstWindow()
win.on('pageerror', e => pageErrors.push(e.message))
win.on('crash', () => crashes.push('crash'))

try {
  await win.waitForLoadState('domcontentloaded')
  ok((await app.windows()).length === 1, '단일 윈도우로 부팅')

  // 초기 화면 non-empty + 전체화면 overlay(검은 화면/ErrorBoundary) 없음
  const view = await win.evaluate(() => {
    const root = document.getElementById('root')
    const txt = root?.innerText || ''
    const overlays = [...document.querySelectorAll('*')].filter(el => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el)
      return r.width >= innerWidth * 0.98 && r.height >= innerHeight * 0.98 &&
        (s.position === 'fixed' || s.position === 'absolute') && +(s.zIndex || 0) > 1000
    })
    return { len: txt.length, overlays: overlays.length }
  })
  ok(view.len > 20, `초기 화면 non-empty(len=${view.len})`)
  ok(view.overlays === 0, '검은 화면/ErrorBoundary overlay 없음')

  // 런타임 상태 패널이 나타날 때까지 대기(settings:get 비동기 해석 이후 렌더).
  let statusVisible = true
  try {
    await win.waitForSelector('[data-testid="runtime-status"]', { timeout: 15000 })
  } catch { statusVisible = false }
  ok(statusVisible, '런타임 상태 패널이 렌더됨')

  const status = await win.evaluate(() => {
    const el = document.querySelector('[data-testid="runtime-status"]')
    if (!el) return null
    return {
      tone: el.getAttribute('data-tone'),
      resolved: el.getAttribute('data-resolved'),
      hasSelectButton: !!el.querySelector('[data-testid="runtime-select-interpreter"]'),
    }
  })
  ok(status !== null, '런타임 상태 속성 판독 가능')
  if (status) {
    ok(['ready', 'action', 'incomplete'].includes(status.tone), `유효한 tone(${status.tone})`)
    // 무-fallback 계약: 격리 userData + AUDIOFORGE_RUNTIME_ROOT 제거 → 미해석이어야 한다.
    ok(status.resolved === '0', `격리 환경에서 런타임 미해석(resolved=${status.resolved}) — 조용한 fallback 없음`)
    ok(status.hasSelectButton === true, '미구성 시 "파이썬 실행기 선택" 버튼 노출')
    ok(status.tone === 'action' || status.tone === 'incomplete', `미구성 tone은 action/incomplete(${status.tone})`)
  }

  ok(pageErrors.length === 0, `pageerror 0(${pageErrors.length})`)
  ok(crashes.length === 0, `crash 0(${crashes.length})`)
} finally {
  try { await app.close() } catch { /* 이미 종료 */ }
  // 자신이 만든 격리 userData만 삭제(prefix 가드).
  if (path.basename(USERDATA).startsWith('audioforge_e2e_userdata_') && path.dirname(USERDATA) === os.tmpdir()) {
    try { fs.rmSync(USERDATA, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

console.log('[e2e] SUMMARY', JSON.stringify({ failed, pageErrors: pageErrors.length, crashes: crashes.length }))
process.exit(failed === 0 ? 0 : 1)
