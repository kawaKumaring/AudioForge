// split 임시 폴더 정리 규칙 회귀 — 실제 fs를 쓰되 자기 소유 tmp 트리 안에서만.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  SPLIT_TEMP_PREFIX,
  isSafeRunToken,
  splitTempPrefixFor,
  removeSplitTempDirs,
  listSplitTempDirs,
} from './split-temp-cleanup.ts'

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), 'af_split_cleanup_test_'))
}

test('isSafeRunToken: 경로 조작·빈 값·특수문자 거부', () => {
  assert.equal(isSafeRunToken('abc123'), true)
  assert.equal(isSafeRunToken('a1b2-c3d4'), true)
  assert.equal(isSafeRunToken(''), false)
  assert.equal(isSafeRunToken('ab'), false)          // 너무 짧음
  assert.equal(isSafeRunToken('../escape'), false)
  assert.equal(isSafeRunToken('a/b'), false)
  assert.equal(isSafeRunToken('a_b'), false)         // '_'는 접두사 구분자라 토큰에 금지
  assert.equal(isSafeRunToken(undefined), false)
  assert.equal(isSafeRunToken(123), false)
})

test('splitTempPrefixFor: 접두사 형태 고정 + 잘못된 토큰은 throw', () => {
  assert.equal(splitTempPrefixFor('run1234'), `${SPLIT_TEMP_PREFIX}run1234_`)
  assert.throws(() => splitTempPrefixFor('../x'))
})

test('removeSplitTempDirs: 이 실행 토큰의 폴더만 지운다', () => {
  const dir = sandbox()
  try {
    const mine = join(dir, `${SPLIT_TEMP_PREFIX}tok1234_abcd`)
    const other = join(dir, `${SPLIT_TEMP_PREFIX}tok9999_zzzz`)  // 다른 실행
    const unrelated = join(dir, 'audioforge_refclip_1234')       // 다른 기능
    const stranger = join(dir, 'some_other_app')
    for (const d of [mine, other, unrelated, stranger]) mkdirSync(d)
    writeFileSync(join(mine, 'source.wav'), 'x')

    const removed = removeSplitTempDirs(dir, 'tok1234')
    assert.equal(removed.length, 1)
    assert.equal(existsSync(mine), false)
    // 나머지는 전부 보존 — 남의 실행/다른 기능/외부 폴더를 건드리지 않는다.
    assert.equal(existsSync(other), true)
    assert.equal(existsSync(unrelated), true)
    assert.equal(existsSync(stranger), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('removeSplitTempDirs: 잘못된 토큰이면 아무것도 지우지 않는다', () => {
  const dir = sandbox()
  try {
    const d = join(dir, `${SPLIT_TEMP_PREFIX}tok1234_abcd`)
    mkdirSync(d)
    assert.deepEqual(removeSplitTempDirs(dir, '../..'), [])
    assert.deepEqual(removeSplitTempDirs(dir, ''), [])
    assert.equal(existsSync(d), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('removeSplitTempDirs: 존재하지 않는 tmpDir도 안전(빈 배열)', () => {
  assert.deepEqual(removeSplitTempDirs(join(tmpdir(), 'af_does_not_exist_zzz'), 'tok1234'), [])
})

test('listSplitTempDirs: 조회만 하고 삭제하지 않는다(orphan 자동삭제 금지)', () => {
  const dir = sandbox()
  try {
    const a = join(dir, `${SPLIT_TEMP_PREFIX}tokaaaa_1`)
    const b = join(dir, `${SPLIT_TEMP_PREFIX}tokbbbb_2`)
    const unrelated = join(dir, 'audioforge_config_1.json')
    mkdirSync(a); mkdirSync(b); writeFileSync(unrelated, '{}')

    const found = listSplitTempDirs(dir)
    assert.equal(found.length, 2)                       // 디렉터리만, 파일 제외
    for (const f of found) assert.equal(typeof f.mtimeMs, 'number')
    // 조회 후에도 그대로 남아 있어야 한다.
    assert.equal(existsSync(a), true)
    assert.equal(existsSync(b), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
