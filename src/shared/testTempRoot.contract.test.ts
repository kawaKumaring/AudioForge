import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// ★검사를 한 파일씩 곧바로 돌려도 C 드라이브로 가지 않는다(2026-09-28 지시 "C 드라이브로 가지 않아야 한다").
//   게이트는 맨 위에서 임시 자리를 바꾸지만, 검사 파일을 단독으로 돌리면 그 파일의 import 순서가 전부다.
//   검사 도구(Playwright)는 불러오는 순간 임시 자리를 정해 두므로 **첫 import** 여야 한다(실측 — 둘째 줄이면 늦다).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E2E = path.join(ROOT, 'test', 'e2e')
const TR = createRequire(import.meta.url)(path.join(ROOT, 'tools', 'test-root.cjs'))   // 테스트 전용 폴더(_local/테스트)

test('실제 앱·화면 검사 파일은 첫 import 로 임시 자리를 바꾼다', () => {
  const bad: string[] = []
  let seen = 0
  for (const n of readdirSync(E2E)) {
    if (!n.endsWith('.mjs') || n.startsWith('_')) continue   // _ 로 시작하는 것은 도움 파일 — 단독 실행하지 않는다
    seen++
    const first = readFileSync(path.join(E2E, n), 'utf-8').split(/\r?\n/).find((l) => /^import\s/.test(l)) || '(import 없음)'
    if (!/^import\s+['"]\.\.\/_temp-root\.mjs['"]/.test(first)) bad.push(`${n}: ${first.slice(0, 60)}`)
  }
  assert.ok(seen > 50, `검사 파일을 거의 못 찾았다(${seen}) — 폴더가 바뀌었나`)
  assert.deepEqual(bad, [])
})

// ★파이썬 검사도 단독으로 돌리면 C 로 갔다(C 에 잔해 13,879개 실측). 첫 import 가 _test_temp 여야 한다.
//   내장 파이썬은 스크립트 폴더를 경로에 넣지 않으므로 바로 앞 한 줄이 경로를 보강한다.
test('파이썬 검사 파일은 첫 import 로 임시 자리를 바꾼다', () => {
  const PY = path.join(ROOT, 'python')
  const bad: string[] = []
  let seen = 0
  for (const n of readdirSync(PY)) {
    if (!/^test_.*\.py$/.test(n)) continue
    seen++
    const lines = readFileSync(path.join(PY, n), 'utf-8').split(/\r?\n/)
    const i = lines.findIndex((l) => /^import _test_temp\b/.test(l))
    const firstOther = lines.findIndex((l) => /^(import|from)\s/.test(l) && !/^import os, sys; sys\.path\.insert/.test(l))
    if (i < 0 || i !== firstOther || !/^import os, sys; sys\.path\.insert\(0, os\.path\.dirname\(os\.path\.abspath\(__file__\)\)\)/.test(lines[i - 1] || '')) bad.push(n)
  }
  assert.ok(seen > 100, `파이썬 검사 파일을 거의 못 찾았다(${seen})`)
  assert.deepEqual(bad, [])
})

test('도움 파일이 임시 자리를 먼저 바꾼다 — 단위 검사 명령도', () => {
  const helper = readFileSync(path.join(E2E, '_e2e-helper.mjs'), 'utf-8').split(/\r?\n/).find((l) => /^import\s/.test(l)) || ''
  assert.match(helper, /_temp-root\.mjs/)
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
  assert.match(pkg.scripts.test, /--import \.\/test\/_temp-root\.mjs/)
})

// ★실행마다 제 폴더를 쓰고 끝나면 지운다 — 자리만 옮겼을 때는 치우지 않는 검사들의 잔해가 쌓였다(4,812개 · 1.6GB).
test('검사 실행이 끝나면 그 실행의 임시 폴더가 사라진다 · 자식은 부모 폴더를 물려받는다', async () => {
  const { spawnSync } = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const script = [
    "const r = await import('file:///' + " + JSON.stringify(path.join(ROOT, 'test', '_temp-root.mjs').split(path.sep).join('/')) + ")",
    "const fs = await import('node:fs'); const os = await import('node:os'); const cp = await import('node:child_process')",
    "fs.writeFileSync(os.tmpdir() + '/x.txt', 'x')",
    "const child = cp.spawnSync(process.execPath, ['-e', 'console.log(require(\"os\").tmpdir())'], { encoding: 'utf8' }).stdout.trim()",
    "console.log(JSON.stringify({ dir: r.TEST_TEMP_ROOT, tmp: os.tmpdir(), child }))",
  ].join(';')
  const env = { ...process.env }
  delete env.AF_TEST_RUN_DIR
  delete env.AF_KEEP_TEST_TEMP
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env })
  assert.equal(out.status, 0, out.stderr)
  const got = JSON.parse(out.stdout.trim().split(/\r?\n/).pop() as string)
  assert.equal(path.dirname(got.dir), path.join(TR.TEST_ROOT, TR.SUB.temp))
  assert.match(path.basename(got.dir), /^r\d+$/)
  assert.equal(got.tmp, got.dir, '이 실행의 임시 자리가 제 폴더가 아니다')
  assert.equal(got.child, got.dir, '자식이 부모 폴더를 물려받지 않았다')
  assert.ok(!existsSync(got.dir), `끝난 실행의 폴더가 남았다: ${got.dir}`)
})
