// 파생 참조 임시폴더 수명 관리 회귀 — node:test + 실제 fs(임시 디렉터리).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { isRefClipDir, removeRefClipDir, sweepRefClipDirs, REFCLIP_PREFIX } from './refclip-cleanup.ts'

function tmp() { return mkdtempSync(join(tmpdir(), 'af-refclip-test-')) }

test('sweepRefClipDirs: audioforge_refclip_* 폴더만 제거, 타 파일/prefix/폴더 보존', () => {
  const base = tmp()
  try {
    for (const n of [`${REFCLIP_PREFIX}111`, `${REFCLIP_PREFIX}222`]) {
      mkdirSync(join(base, n)); writeFileSync(join(base, n, 'reference_clip_24k.wav'), 'x')
    }
    writeFileSync(join(base, 'synthesized.wav'), 'FINAL')          // 무관 파일
    writeFileSync(join(base, `${REFCLIP_PREFIX}notadir`), 'file')  // 동명 파일(폴더 아님)
    mkdirSync(join(base, 'audioforge_config_999'))                 // 다른 prefix 폴더
    mkdirSync(join(base, 'other'))

    const removed = sweepRefClipDirs(base).sort()
    assert.deepEqual(removed, [`${REFCLIP_PREFIX}111`, `${REFCLIP_PREFIX}222`])
    assert.ok(!existsSync(join(base, `${REFCLIP_PREFIX}111`)))
    assert.ok(!existsSync(join(base, `${REFCLIP_PREFIX}222`)))
    assert.ok(existsSync(join(base, 'synthesized.wav')), 'synthesized.wav 보존')
    assert.ok(existsSync(join(base, `${REFCLIP_PREFIX}notadir`)), '동명 파일 보존')
    assert.ok(existsSync(join(base, 'audioforge_config_999')), '다른 prefix 폴더 보존')
    assert.ok(existsSync(join(base, 'other')), '무관 폴더 보존')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('removeRefClipDir: 정확한 폴더만 삭제, 상위/타 prefix/타 위치/파일 거부', () => {
  const base = tmp()
  try {
    const good = join(base, `${REFCLIP_PREFIX}abc`)
    mkdirSync(good); writeFileSync(join(good, 'reference_clip_24k.wav'), 'x')
    const wrongPrefix = join(base, 'audioforge_config_1'); mkdirSync(wrongPrefix)
    const asFile = join(base, `${REFCLIP_PREFIX}f`); writeFileSync(asFile, 'x')

    // 상위 경로/타 위치 거부(가드)
    assert.equal(isRefClipDir(base, base), false, '자기 자신(상위) 거부')
    assert.equal(isRefClipDir(base, join(base, 'sub', `${REFCLIP_PREFIX}x`)), false, 'tmpDir 직속 아님 거부')
    assert.equal(isRefClipDir(base, wrongPrefix), false, '다른 prefix 거부')
    assert.equal(isRefClipDir(base, good), true)

    assert.equal(removeRefClipDir(base, wrongPrefix), false)
    assert.ok(existsSync(wrongPrefix), '다른 prefix 폴더 불변')
    assert.equal(removeRefClipDir(base, asFile), false, '동명 파일 거부')
    assert.ok(existsSync(asFile))
    assert.equal(removeRefClipDir(base, good), true)
    assert.ok(!existsSync(good), '정확한 파생 폴더만 삭제')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('sweep/ remove: 존재하지 않는 경로에도 throw 안 함', () => {
  const missing = join(tmpdir(), 'af-refclip-none-xyz')
  assert.deepEqual(sweepRefClipDirs(missing), [])
  assert.equal(removeRefClipDir(missing, join(missing, `${REFCLIP_PREFIX}1`)), false)
})
