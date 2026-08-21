// Qwen 실행별 임시폴더 스윕 회귀 — node:test + 실제 fs(임시 디렉터리).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { sweepQwenJobDirs } from './qwen-cleanup.ts'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'af-qwen-sweep-'))
  return dir
}

test('.qwen-job-* 폴더만 제거하고 최종/세션/타 파일은 보존', () => {
  const out = setup()
  try {
    // 실행별 임시폴더 2개 + 그 안에 세그먼트
    for (const j of ['.qwen-job-111', '.qwen-job-222']) {
      mkdirSync(join(out, j))
      writeFileSync(join(out, j, 'segment_qwen_001.wav'), 'x')
      writeFileSync(join(out, j, 'pending.wav'), 'x')
    }
    // 보존돼야 할 것들
    writeFileSync(join(out, 'synthesized.wav'), 'FINAL')
    writeFileSync(join(out, 'session.json'), '{}')
    mkdirSync(join(out, 'other_dir'))
    writeFileSync(join(out, 'other_dir', 'keep.wav'), 'k')
    // 이름이 비슷하지만 폴더가 아닌 파일(동명 파일 보호)
    writeFileSync(join(out, '.qwen-job-notadir'), 'file-not-dir')

    const removed = sweepQwenJobDirs(out).sort()
    assert.deepEqual(removed, ['.qwen-job-111', '.qwen-job-222'])

    assert.ok(!existsSync(join(out, '.qwen-job-111')), '임시폴더1 제거')
    assert.ok(!existsSync(join(out, '.qwen-job-222')), '임시폴더2 제거')
    assert.equal(readdirSync(join(out)).includes('synthesized.wav'), true, 'synthesized.wav 보존')
    assert.equal(existsSync(join(out, 'synthesized.wav')), true)
    assert.equal(existsSync(join(out, 'session.json')), true, 'session.json 보존')
    assert.equal(existsSync(join(out, 'other_dir', 'keep.wav')), true, '타 폴더 보존')
    assert.equal(existsSync(join(out, '.qwen-job-notadir')), true, '동명 파일(폴더 아님) 보존')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('임시폴더가 없으면 빈 배열(무해)', () => {
  const out = setup()
  try {
    writeFileSync(join(out, 'synthesized.wav'), 'FINAL')
    assert.deepEqual(sweepQwenJobDirs(out), [])
    assert.equal(existsSync(join(out, 'synthesized.wav')), true)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('존재하지 않는 output_dir → 빈 배열(throw 안 함)', () => {
  const missing = join(tmpdir(), 'af-qwen-sweep-does-not-exist-xyz')
  assert.deepEqual(sweepQwenJobDirs(missing), [])
})
