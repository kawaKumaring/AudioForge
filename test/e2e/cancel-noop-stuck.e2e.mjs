// C2-P0.1 회귀 — "취소가 결과를 삼키고 UI가 cancelling에 영구 고착"(감사 R1)을 결정적으로 재현한다.
//
// 예전 동작: 렌더러가 invoke '이전에' beginCancelling()으로 status를 확정했고, main의 noop 분기는
// 어떤 terminal 이벤트도 보내지 않았다. 그 뒤 도착한 result/error는 status==='cancelling'이라는
// 이유로 렌더러가 버렸고, cancelling에서는 setFile/reset/재시도가 전부 차단돼 탈출구가 없었다.
//
// 지금 계약: main이 수락 권위다. noop이면 {accepted:false, reasonCode}를 돌려주고 audio:cancelling을
// 보내지 않으며, 렌더러는 그 이벤트로만 전이한다 → 상태는 processing 그대로, 결과는 정상 채택.
//
// 합성/GPU 없이 store만으로 재현한다(실행 중이 아닐 때 취소를 누르는 것이 곧 noop 경로다).
//
// 이 테스트가 증명하는 것: main의 수락 응답 계약, noop이 상태를 망가뜨리지 않음, noop 직후 도착한
// 결과가 채택됨, 반복 취소의 idempotency, 탈출 경로 생존. 수정 전(734dd00) 산출물로 돌리면 응답
// 계약 단언 3건이 실패한다.
// 이 테스트가 증명하지 '않는' 것: 버튼 핸들러의 낙관적 전이 자체. 그 경로는 실제 실행 중 클릭이
// 필요해 여기서 재현하지 않는다 — 대신 handleCancel에서 사전 전이를 제거했고(코드상 경로 소멸),
// 전이 규칙은 cancelContract의 순수 리듀서 단위테스트가 고정한다.
import { _electron as electron } from 'playwright'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { randomUUID } from 'crypto'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }

let failed = 0
const ok = (c, m) => { console.log(c ? '[cancel-noop] PASS' : '[cancel-noop] FAIL', m); if (!c) failed++ }

const USERDATA = path.join(os.tmpdir(), 'audioforge_e2e_userdata_' + randomUUID())
fs.mkdirSync(USERDATA, { recursive: true })

const app = await electron.launch({
  args: ['out/main/index.js', '--user-data-dir=' + USERDATA],
  cwd: APP,
  env: { ...process.env, AF_E2E: '1' },
})
const win = await app.firstWindow()
const pageErrors = [], crashes = []
win.on('pageerror', e => pageErrors.push(e.message))
win.on('crash', () => crashes.push('crash'))

try {
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.__afStore, undefined, { timeout: 20000 })

  // 실행 중이 아닌 상태에서의 취소 = main의 NO_ACTIVE_JOB noop 경로.
  const noop = await win.evaluate(async () => await window.api.audio.cancel())
  ok(noop && noop.accepted === false, `noop 취소가 accepted:false (${JSON.stringify(noop)})`)
  ok(noop && noop.reasonCode === 'NO_ACTIVE_JOB', `사유 코드 NO_ACTIVE_JOB (${noop && noop.reasonCode})`)

  // processing 상태로 두고 취소 → noop이므로 상태가 망가지면 안 된다.
  await win.evaluate(() => window.__afStore.setState({
    mode: 'tts',
    fileInfo: { path: 'X', name: 'probe.wav', duration: 5, channels: 1, sampleRate: 24000, format: 'wav' },
    status: 'processing', tracks: [], error: null, errorInfo: null, progress: 10,
  }))
  const after = await win.evaluate(async () => {
    const r = await window.api.audio.cancel()
    return { resp: r, status: window.__afStore.getState().status }
  })
  ok(after.resp && after.resp.accepted === false, 'processing인데 실제 러너가 없으면 여전히 noop')
  ok(after.status === 'processing', `noop 취소 후 상태 불변(${after.status}) — cancelling 고착 없음`)

  // noop 직후 도착한 정상 결과가 버려지지 않는지(핵심 데이터 손실 시나리오).
  const settled = await win.evaluate(async () => {
    const s = window.__afStore.getState()
    s.setResult([{ name: 'synthesized', path: 'Y' }], 'OUT', null)
    return { status: window.__afStore.getState().status, tracks: window.__afStore.getState().tracks.length }
  })
  ok(settled.status === 'done' && settled.tracks === 1,
    `noop 취소 뒤 도착한 결과를 정상 채택(status=${settled.status}, tracks=${settled.tracks})`)

  // 반복 취소가 상태를 망가뜨리지 않는다(idempotent).
  const repeated = await win.evaluate(async () => {
    const rs = []
    for (let i = 0; i < 3; i++) rs.push(await window.api.audio.cancel())
    return { rs, status: window.__afStore.getState().status }
  })
  ok(repeated.rs.every(r => r && r.accepted === false), '반복 취소 전부 noop')
  ok(repeated.status === 'done', `반복 취소 후에도 결과 상태 유지(${repeated.status})`)

  // cancelling 고착이 아니므로 파일 교체/리셋 같은 탈출 경로가 살아 있어야 한다.
  const escape = await win.evaluate(() => {
    window.__afStore.getState().reset()
    return window.__afStore.getState().status
  })
  ok(escape === 'idle', `reset으로 idle 복귀 가능(${escape})`)

  ok(pageErrors.length === 0, `pageerror 0(${pageErrors.length})`)
  ok(crashes.length === 0, `crash 0(${crashes.length})`)
} finally {
  try { await app.close() } catch { /* 이미 종료 */ }
  if (path.basename(USERDATA).startsWith('audioforge_e2e_userdata_') && path.dirname(USERDATA) === os.tmpdir()) {
    try { fs.rmSync(USERDATA, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

console.log('[cancel-noop] SUMMARY', JSON.stringify({ failed, pageErrors: pageErrors.length, crashes: crashes.length }))
process.exit(failed === 0 ? 0 : 1)
