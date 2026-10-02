// 낭독 내 목소리 보관 — 임시 조각만 받고, 같은 소리는 한 벌, 쓰는 것만 남긴다(2026-10-03).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
// @ts-ignore TS5097: node --test 가 요구하는 명시적 .ts 확장자
import { keepVoiceClip, pruneVoiceStore, insideDir } from './reader-voice-store.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'af-voice-store-'))
  const tempRoot = join(root, 'refclips'), storeDir = join(root, 'readerVoices')
  const clip = (name: string, body: string) => { const d = join(tempRoot, 'audioforge_refclip_' + name); mkdirSync(d, { recursive: true }); const p = join(d, 'reference_clip_24k.wav'); writeFileSync(p, body); return p }
  return { root, tempRoot, storeDir, clip, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('임시 조각을 보관 자리로 옮겨 적고, 임시 자리를 치워도 남는다', () => {
  const f = fixture()
  try {
    const src = f.clip('a', 'AAA')
    const kept = keepVoiceClip(src, { tempRoot: f.tempRoot, storeDir: f.storeDir, keep: [] })
    assert.ok(insideDir(f.storeDir, kept))
    rmSync(f.tempRoot, { recursive: true, force: true })          // 앱이 켤 때·끌 때 하는 청소
    assert.ok(existsSync(kept), '임시 자리를 치우자 보관본도 사라졌다')
  } finally { f.done() }
})

test('준비가 만든 조각이 아니면 받지 않는다(아무 파일이나 앱 자리로 복사시키지 않는다)', () => {
  const f = fixture()
  try {
    const outside = join(f.root, '사용자 원본.wav'); writeFileSync(outside, 'X')
    assert.throws(() => keepVoiceClip(outside, { tempRoot: f.tempRoot, storeDir: f.storeDir, keep: [] }), /준비한 목소리 조각이 아닙니다/)
    assert.throws(() => keepVoiceClip(join(f.tempRoot, '..', '사용자 원본.wav'), { tempRoot: f.tempRoot, storeDir: f.storeDir, keep: [] }), /아닙니다/)
  } finally { f.done() }
})

test('같은 소리는 한 벌 — 쓰지 않는 보관본은 지운다(남길 것과 새것은 남긴다)', () => {
  const f = fixture()
  try {
    const a = keepVoiceClip(f.clip('a', 'AAA'), { tempRoot: f.tempRoot, storeDir: f.storeDir, keep: [] })
    const a2 = keepVoiceClip(f.clip('a2', 'AAA'), { tempRoot: f.tempRoot, storeDir: f.storeDir, keep: [a] })
    assert.equal(a2, a, '같은 소리를 두 벌 보관한다')
    const b = keepVoiceClip(f.clip('b', 'BBB'), { tempRoot: f.tempRoot, storeDir: f.storeDir, keep: [a] })
    assert.deepEqual(readdirSync(f.storeDir).length, 2)
    const c = keepVoiceClip(f.clip('c', 'CCC'), { tempRoot: f.tempRoot, storeDir: f.storeDir, keep: [b] })   // a 는 더 이상 쓰지 않는다
    assert.ok(!existsSync(a) && existsSync(b) && existsSync(c), '쓰지 않는 보관본이 남거나 쓰는 것이 지워졌다')
    writeFileSync(join(f.storeDir, 'x.wav.part'), 'half')
    assert.equal(pruneVoiceStore(f.storeDir, [b, c]), 1, '쓰다 만 파일을 남긴다')
  } finally { f.done() }
})
