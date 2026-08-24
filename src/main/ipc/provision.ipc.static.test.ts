// provision.ipc.ts 정적 회귀 — 소스 텍스트만 검사(electron 의존 import 회피, audio.ipc.static.test 관례).
// 계약: apply 항상 차단(설치 로직·spawn 0) / renderer 전달 전 assertNoAbsolutePaths 가드 /
//       provisioner Python은 명시 주입만(벤더·드라이브레터 하드코딩 0) / 다운로드·pip·venv 생성 0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('./provision.ipc.ts', import.meta.url)), 'utf-8')
const HELPERS = readFileSync(fileURLToPath(new URL('./provision-helpers.ts', import.meta.url)), 'utf-8')
const ROOT_HELPERS = readFileSync(fileURLToPath(new URL('./provision-root-helpers.ts', import.meta.url)), 'utf-8')
const PRELOAD = readFileSync(fileURLToPath(new URL('../../preload/index.ts', import.meta.url)), 'utf-8')

// ── apply 항상 차단 ──────────────────────────────────────────────────────────
test('provision:apply 핸들러는 항상 APPLY_DISABLED를 반환(설치 로직 없음)', () => {
  assert.ok(/ipcMain\.handle\('provision:apply'/.test(SRC), 'provision:apply 핸들러 없음')
  // apply 핸들러 본문에 실제 설치/다운로드/pip/venv 생성 흔적이 없어야 한다.
  assert.ok(/reasonCode: 'APPLY_DISABLED'/.test(SRC), 'apply가 APPLY_DISABLED를 안 냄')
})

test('다운로드·pip install·venv 생성·설치 디렉터리 생성 로직이 없다', () => {
  // 실제 설치 호출 패턴만 검사(설명 산문의 단어에 걸리지 않도록 구체 패턴으로).
  assert.ok(!/pip\s+install/i.test(SRC), 'pip install 흔적 잔존')
  assert.ok(!/['"]install['"]/.test(SRC), "'install' 인자 리터럴 잔존")
  assert.ok(!/venv\.(create|EnvBuilder)|createVenv|EnvBuilder/i.test(SRC), 'venv 생성 흔적 잔존')
  assert.ok(!/https?:\/\//.test(SRC), 'URL(다운로드) 리터럴 잔존')
  // runtime/model 설치 디렉터리 생성 금지(cfg는 tmpdir에 write만; mkdir로 설치 위치를 만들지 않는다).
  assert.ok(!/mkdirSync|makedirs/.test(SRC), '설치 디렉터리 생성 흔적 잔존')
})

// ── renderer 절대경로 가드 ───────────────────────────────────────────────────
test('plan/verify 결과는 renderer 전달 전 assertNoAbsolutePaths로 가드된다', () => {
  assert.ok(/assertNoAbsolutePaths\(/.test(SRC), 'assertNoAbsolutePaths 가드 호출 없음')
  // plan/verify 핸들러가 배선돼 있다.
  assert.ok(/ipcMain\.handle\('provision:plan'/.test(SRC), 'provision:plan 핸들러 없음')
  assert.ok(/ipcMain\.handle\('provision:verify'/.test(SRC), 'provision:verify 핸들러 없음')
})

// ── provisioner Python은 명시 주입만(하드코딩 0) ─────────────────────────────
test('벤더/드라이브레터 python 경로 하드코딩이 없다(명시 주입만)', () => {
  assert.ok(!/['"][^'"]*ComfyUI[^'"]*['"]/.test(SRC + HELPERS), 'ComfyUI 경로 문자열 리터럴 잔존')
  assert.ok(!/['"][A-Za-z]:[\\/][^'"]*python[^'"]*['"]/i.test(SRC + HELPERS), '드라이브레터 python 경로 리터럴 잔존')
  // provisioner Python은 pickProvisionPython(명시 주입원)에서만 온다.
  assert.ok(/pickProvisionPython\(/.test(SRC), 'pickProvisionPython 배선 없음')
  assert.ok(/AUDIOFORGE_PROVISION_PYTHON/.test(HELPERS), 'env 주입 경로 없음')
})

// ── P 코어 재구현 금지(단일 소스 소비) ───────────────────────────────────────
test('fingerprint/manifest/staging을 Q가 재구현하지 않는다(subprocess로 P 코어 소비)', () => {
  // TS에서 sha256 계산·manifest 조립을 하지 않는다 — Python cli(P core)가 canonical JSON+fingerprint 발급.
  assert.ok(!/createHash\(|sha256/i.test(SRC), 'TS에서 자체 해시/fingerprint 계산 흔적')
  assert.ok(/provision_cli\.py/.test(SRC), 'provision_cli.py 진입점 배선 없음')
})

test('managed root folder picker는 main 권위이며 renderer가 전체 경로를 주고받지 않는다', () => {
  assert.ok(/dialog\.showOpenDialog\(mainWindow/.test(SRC), 'main folder picker 배선 없음')
  assert.ok(/provision:select-managed-root/.test(SRC), 'managed root 선택 IPC 없음')
  assert.ok(/selectManagedRoot:\s*\(\)/.test(PRELOAD), 'preload root 선택은 무인자여야 한다')
  assert.ok(/rootStatus\(\)/.test(SRC), 'renderer-safe root status 반환 없음')
  assert.ok(!/return\s*\{[^}]*baseRoot/s.test(SRC), 'renderer 응답에 baseRoot 원문 노출')
})

test('approval context는 profile+plan+opaque selection context를 결합', () => {
  for (const key of ['profile', 'planFingerprint', 'approvalContext']) {
    assert.ok(ROOT_HELPERS.includes(key), `${key} 결합 누락`)
  }
  assert.ok(/approvalFingerprint\(/.test(SRC), 'plan 응답에 approval fingerprint 미배선')
})

test('apply는 root 선택과 무관하게 계속 비활성이고 설치·다운로드는 없다', () => {
  assert.ok(/reasonCode: 'APPLY_DISABLED'/.test(SRC))
  assert.ok(!/mkdirSync|pip\s+install|https?:\/\//i.test(SRC + ROOT_HELPERS))
})

test('root 재선택 성공은 runtime resolver cache를 무효화한다', () => {
  assert.ok(/onManagedRootChanged\?\.\(\)/.test(SRC))
})
