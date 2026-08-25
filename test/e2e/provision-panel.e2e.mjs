// managed provisioner 패널 launch smoke(R-provision) — GPU·네트워크·다운로드 없이 부팅하고,
// "설치 계획 보기"가 구성요소를 렌더하며, 실제 설치 버튼은 비활성이고, renderer로 전체 절대경로가
// 전혀 새지 않음을 검증한다. provisioner 실행 Python은 테스트에서만 임베디드 파이썬을 **읽기 전용
// 실행 호스트로 주입**한다(production 채택 아님; PYTHONDONTWRITEBYTECODE=1로 바이트코드도 안 씀).
//
// 실행: npm run build && node test/e2e/provision-panel.e2e.mjs
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }

// 테스트 실행 호스트(읽기 전용). 다른 e2e와 동일 관례. 없으면 스킵(2).
const PROVISION_PY = 'E:/AI/ComfyUI_windows_portable_python3.12/python_embeded/python.exe'
if (!fs.existsSync(PROVISION_PY)) { console.error('테스트용 provisioner python 없음(스킵):', PROVISION_PY); process.exit(2) }

let failed = 0
const ok = (c, m) => { console.log(c ? '[e2e] PASS' : '[e2e] FAIL', m); if (!c) failed++ }

const USERDATA = path.join(os.tmpdir(), 'audioforge_e2e_userdata_' + randomUUID())
fs.mkdirSync(USERDATA, { recursive: true })

// 격리 환경 + provisioner python 주입 + 런타임 root 제거(무-fallback 유지) + 바이트코드 미기록.
const env = { ...process.env, AF_E2E: '1', AUDIOFORGE_PROVISION_PYTHON: PROVISION_PY, PYTHONDONTWRITEBYTECODE: '1' }
delete env.AUDIOFORGE_RUNTIME_ROOT

const pageErrors = [], crashes = []

const app = await electron.launch({ args: ['out/main/index.js', '--user-data-dir=' + USERDATA], cwd: APP, env })
const win = await app.firstWindow()
win.on('pageerror', e => pageErrors.push(e.message))
win.on('crash', () => crashes.push('crash'))

try {
  await win.waitForLoadState('domcontentloaded')
  ok((await app.windows()).length === 1, '단일 윈도우로 부팅')

  // provisioner는 메인 화면이 아니라 **관리 모달 안**에 있다 — 기본 CTA로 열고 설치 섹션을 펼친다.
  await win.waitForSelector('[data-testid="runtime-primary-action"]', { timeout: 15000 })
  await win.click('[data-testid="runtime-primary-action"]')
  await win.waitForSelector('[data-testid="runtime-manager-modal"]', { timeout: 15000 })
  let panelVisible = true
  try { await win.waitForSelector('[data-testid="runtime-provision-panel"]', { timeout: 15000 }) } catch { panelVisible = false }
  if (!panelVisible) {
    // manage intent로 열리면 설치 섹션이 접혀 있다 — 명시적으로 펼친다.
    try {
      await win.click('[data-testid="runtime-toggle-install"]')
      await win.waitForSelector('[data-testid="runtime-provision-panel"]', { timeout: 15000 })
      panelVisible = true
    } catch { panelVisible = false }
  }
  ok(panelVisible, 'provision 패널이 관리 모달 안에서 렌더됨')

  // "설치 계획 보기" 클릭 → provision_cli.py subprocess(pure) → 구성요소 렌더.
  await win.click('[data-testid="provision-plan-btn"]')
  let componentsVisible = true
  try { await win.waitForSelector('[data-testid="provision-component"]', { timeout: 30000 }) } catch { componentsVisible = false }
  ok(componentsVisible, '설치 계획 구성요소가 렌더됨')

  const view = await win.evaluate(() => {
    const comps = [...document.querySelectorAll('[data-testid="provision-component"]')]
    const applyBtn = document.querySelector('[data-testid="provision-apply-btn"]')
    const root = document.getElementById('root')
    return {
      count: comps.length,
      resolvedFlags: comps.map(c => c.getAttribute('data-resolved')),
      applyDisabled: applyBtn ? applyBtn.disabled === true || applyBtn.hasAttribute('disabled') : null,
      text: root?.innerText || '',
    }
  })
  ok(view.count > 0, `구성요소 ${view.count}개 렌더`)
  ok(view.applyDisabled === true, '실제 설치 버튼은 비활성(disabled)')

  // renderer 절대경로 0 — 전체 화면 텍스트에 드라이브레터/POSIX 절대경로가 없어야 한다(§11).
  const abs = /[A-Za-z]:[\\/]/.test(view.text) || /(^|\s)\/[A-Za-z0-9_]/.test(view.text) || view.text.includes('\\\\')
  ok(!abs, 'renderer 텍스트에 전체 절대경로 0')
  // 주입한 provisioner python 경로(민감)가 renderer로 새지 않았는지 명시 확인.
  ok(!view.text.includes('python_embeded'), 'provisioner python 경로가 renderer에 노출 안 됨')

  // 다시 검사(verify) — 설치 이력 0이므로 전부 미설치로 정직하게 표시.
  await win.click('[data-testid="provision-verify-btn"]')
  let verifyVisible = true
  try { await win.waitForSelector('[data-testid="provision-verify-item"]', { timeout: 30000 }) } catch { verifyVisible = false }
  ok(verifyVisible, 'verify 결과가 렌더됨')

  ok(pageErrors.length === 0, `pageerror 0(${pageErrors.length})`)
  ok(crashes.length === 0, `crash 0(${crashes.length})`)
} finally {
  try { await app.close() } catch { /* 이미 종료 */ }
  if (path.basename(USERDATA).startsWith('audioforge_e2e_userdata_') && path.dirname(USERDATA) === os.tmpdir()) {
    try { fs.rmSync(USERDATA, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

console.log('[e2e] SUMMARY', JSON.stringify({ failed, pageErrors: pageErrors.length, crashes: crashes.length }))
process.exit(failed === 0 ? 0 : 1)
