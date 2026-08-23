// audio.ipc.ts 정적 회귀 — 소스 텍스트만 검사(electron 의존 import 회피).
// 계약: 하드코딩 인터프리터/ffprobe 절대경로 0, exists-only 채택 0, 조용한 'python' fallback 0,
//       renderer로 나가는 오류/설정 응답에 전체 경로 0, config.roots 주입 배선 존재.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('./audio.ipc.ts', import.meta.url)), 'utf-8')

// ── 하드코딩 / silent fallback 0 ─────────────────────────────────────────────
test('하드코딩 인터프리터 상수·옛 해석기·WinGet ffprobe 상수가 없다', () => {
  assert.ok(!/\bconst\s+DEFAULT_PYTHON\b/.test(SRC), 'DEFAULT_PYTHON 상수 잔존')
  assert.ok(!/\bconst\s+FFPROBE_PATHS\b/.test(SRC), 'FFPROBE_PATHS 상수 잔존')
  assert.ok(!/\bfunction\s+resolvePythonPath\b/.test(SRC), 'resolvePythonPath 함수 잔존')
  // 벤더 절대경로 문자열 리터럴(예: ComfyUI 임베디드 python, WinGet ffmpeg) 0.
  assert.ok(!/['"][^'"]*ComfyUI[^'"]*['"]/.test(SRC), 'ComfyUI 경로 문자열 리터럴 잔존')
  assert.ok(!/['"][^'"]*WinGet[^'"]*['"]/.test(SRC), 'WinGet 경로 문자열 리터럴 잔존')
  // 드라이브레터 하드코딩 python 경로 리터럴 0.
  assert.ok(!/['"][A-Za-z]:[\\/][^'"]*python[^'"]*['"]/i.test(SRC), '드라이브레터 python 경로 리터럴 잔존')
})

test("조용한 시스템 python fallback(return 'python')이 없다", () => {
  assert.ok(!/return\s+['"]python['"]/.test(SRC), "return 'python' 조용한 fallback 잔존")
})

// ── ensureRuntime 게이트 배선 ────────────────────────────────────────────────
test('런타임 게이트(ensureRuntime)와 RUNTIME_NOT_CONFIGURED 코드가 배선돼 있다', () => {
  assert.ok(/async function ensureRuntime\b/.test(SRC), 'ensureRuntime 정의 없음')
  assert.ok(/RUNTIME_NOT_CONFIGURED/.test(SRC), 'RUNTIME_NOT_CONFIGURED 코드 없음')
  // 옛 `existsSync(pythonPath)` 게이트(전체 경로를 오류에 실어 renderer로 흘리던 패턴) 0.
  assert.ok(!/existsSync\(pythonPath\)/.test(SRC), '옛 existsSync(pythonPath) 게이트 잔존')
  // 옛 "Python을 찾을 수 없습니다: ${pythonPath}" 경로 누출 메시지 0.
  assert.ok(!/Python을 찾을 수 없습니다: \$\{pythonPath\}/.test(SRC), 'python 경로 누출 오류메시지 잔존')
})

// ── config.roots 주입 배선 ───────────────────────────────────────────────────
test('separate.py config에 roots를 주입하는 withRoots 배선이 있다', () => {
  assert.ok(/function withRoots\b/.test(SRC), 'withRoots 헬퍼 없음')
  assert.ok(/getResolvedRuntime\b/.test(SRC), 'getResolvedRuntime 접근자 없음')
  // 주 합성 config 작성이 withRoots를 통과한다.
  assert.ok(/writeFileSync\(configPath, JSON\.stringify\(withRoots\(config\)/.test(SRC), 'audio:process config가 withRoots를 안 거침')
})

// ── renderer로 전체 경로 미노출(§2) ──────────────────────────────────────────
test('settings:get / select-python-path가 전체 경로 대신 basename/상태만 반환', () => {
  // settings:get이 { pythonPath } 원시 경로를 반환하지 않는다.
  assert.ok(!/return\s*\{\s*pythonPath\s*\}/.test(SRC), 'settings:get이 원시 pythonPath 반환')
  assert.ok(/interpreterBasename/.test(SRC), 'settings:get이 basename 기반 응답을 안 함')
  // select-python-path가 raw filePaths[0]를 그대로 반환하지 않는다.
  assert.ok(!/return\s+pythonPath\b/.test(SRC), 'select-python-path가 원시 경로 반환')
})
