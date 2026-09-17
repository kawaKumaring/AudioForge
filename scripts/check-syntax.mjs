#!/usr/bin/env node
// 검사 스크립트 자체의 문법 점검 — 게이트의 첫 단계.
//
// 왜: v1.11.0 병합 직전 게이트에서 `synthesize.e2e.mjs` 가 0.1초에 실패했다. 원인은 v1.10.0 때 들어간
// `() => a; b` 꼴 문법 오류였고, 그 판에서 GPU 단계를 돌리지 않아 두 판 동안 숨어 있었다.
// **돌리지 않은 검사는 있는 것이 아니다** — 최소한 "읽히는가" 는 매번, 1~3초에 확인한다.
//
// 하는 일: 아래 폴더의 .mjs 파일마다 `node --check` 를 돌린다(실행하지 않는다). 하나라도 실패하면 exit 1.
// 사용: node scripts/check-syntax.mjs [폴더 ...]   (기본: test/e2e, scripts, test)
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ['test/e2e', 'scripts', 'test']

function mjsFiles(dir) {
  const abs = path.isAbsolute(dir) ? dir : path.join(ROOT, dir)
  let names = []
  try { names = readdirSync(abs) } catch { return [] }
  return names
    .filter((n) => n.endsWith('.mjs'))
    .map((n) => path.join(abs, n))
    .filter((p) => { try { return statSync(p).isFile() } catch { return false } })
    .sort()
}

const files = [...new Set(dirs.flatMap(mjsFiles))]
const failures = []
const t0 = Date.now()
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf-8' })
  if (r.status !== 0) {
    failures.push({ file: path.relative(ROOT, f), detail: (r.stderr || '').trim().split('\n').slice(0, 4).join('\n') })
  }
}
const sec = ((Date.now() - t0) / 1000).toFixed(1)

if (failures.length === 0) {
  console.log(`[syntax] ${files.length}개 파일 전부 읽힌다 (${sec}초)`)
  process.exit(0)
}
console.error(`[syntax] ${files.length}개 중 ${failures.length}개가 읽히지 않는다 (${sec}초)`)
for (const f of failures) {
  console.error(`  FAIL ${f.file}`)
  for (const line of f.detail.split('\n')) console.error(`       ${line}`)
}
process.exit(1)
