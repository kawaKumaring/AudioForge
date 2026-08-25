// validateE2EReferencePath 순수 함수 단위테스트(GPU·Qwen·decode 없음).
// 실행: node --test test/e2e/_e2e-helper.reference.test.mjs
// requireE2EReference는 process.exit를 호출하므로 여기서는 순수 검증 함수만 대상으로 한다.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import { validateE2EReferencePath, makeSyntheticWav, cleanupSyntheticWav } from './_e2e-helper.mjs'

const DIR = path.join(os.tmpdir(), 'audioforge_reftest_' + randomUUID())
fs.mkdirSync(DIR, { recursive: true })
const created = []
const mk = (name, fn) => { const p = path.join(DIR, name); fn(p); created.push(p); return p }

after(() => {
  for (const p of created) cleanupSyntheticWav(p)
  try { fs.rmSync(DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

test('unset: 빈 문자열/undefined → kind=unset', () => {
  assert.equal(validateE2EReferencePath(undefined).kind, 'unset')
  assert.equal(validateE2EReferencePath('').kind, 'unset')
  assert.equal(validateE2EReferencePath('   ').kind, 'unset')
})

test('missing: 존재하지 않는 경로 → kind=missing', () => {
  const r = validateE2EReferencePath(path.join(DIR, 'nope.wav'))
  assert.equal(r.ok, false); assert.equal(r.kind, 'missing')
})

test('ext: 존재하지만 .wav 아님 → kind=ext', () => {
  const p = mk('note.txt', (fp) => fs.writeFileSync(fp, Buffer.alloc(128 * 1024)))
  const r = validateE2EReferencePath(p)
  assert.equal(r.ok, false); assert.equal(r.kind, 'ext')
})

test('small: .wav지만 최소 바이트 미만 → kind=small', () => {
  const p = mk('tiny.wav', (fp) => makeSyntheticWav(fp, 0.1))   // ≈4.8KB < 64KB
  const r = validateE2EReferencePath(p)
  assert.equal(r.ok, false); assert.equal(r.kind, 'small')
})

test('ok: 충분한 크기의 .wav → ok=true, path/bytes 반환', () => {
  const p = mk('good.wav', (fp) => makeSyntheticWav(fp, 30))    // ≈1.44MB
  const r = validateE2EReferencePath(p)
  assert.equal(r.ok, true); assert.equal(r.path, p); assert.ok(r.bytes > 64 * 1024)
})

test('minBytes 옵션 존중: 임계값을 넘기면 통과', () => {
  const p = mk('mid.wav', (fp) => makeSyntheticWav(fp, 1))      // ≈48KB
  assert.equal(validateE2EReferencePath(p).kind, 'small')       // 기본 64KB 기준 미달
  assert.equal(validateE2EReferencePath(p, { minBytes: 8 * 1024 }).ok, true)  // 8KB 기준 통과
})

test('순수성: 검증이 파일을 수정/삭제하지 않는다', () => {
  const p = mk('immutable.wav', (fp) => makeSyntheticWav(fp, 30))
  const before = fs.statSync(p).size
  validateE2EReferencePath(p)
  assert.ok(fs.existsSync(p))
  assert.equal(fs.statSync(p).size, before)
})
