// 폴더 훑기 — 실제 임시 폴더(정션 순환 포함)로 본다(2026-10-03).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
// @ts-ignore TS5097
import { scanTextPaths, scannedPaths } from './folder-scan.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'af-scan-'))
  const w = (p: string, s = '본문') => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), s) }
  w('작품A/10화.txt'); w('작품A/2화.txt'); w('작품A/1화.txt'); w('작품A/표지.jpg', 'x')
  w('묶음/시리즈B/1권/1화.txt'); w('묶음/시리즈B/2권/1화.txt')   // '묶음'·'시리즈B' 는 파일 없이 하위 폴더만
  w('낱권.txt'); w('메모.md')
  w('큰책/큰.txt', 'x'.repeat(2000))
  return root
}
const clean = (root: string) => {
  // 연결은 링크만 끊고 지운다(따라가 지우지 않는다).
  for (const l of [join(root, '작품A', '되돌이')]) { try { unlinkSync(l) } catch { /* 없음 */ } }
  rmSync(root, { recursive: true, force: true })
}

test('하위 폴더까지 훑고, 파일을 직접 담은 폴더만 작품이 되며, 이름은 자연 정렬', async () => {
  const root = fixture()
  try {
    const r = await scanTextPaths([join(root, '작품A'), join(root, '묶음'), join(root, '낱권.txt'), join(root, '메모.md')], 1000)
    assert.deepEqual(r.works.map((w) => w.name), ['작품A', '1권', '2권'], '중간 폴더(묶음·시리즈B)는 묶음이 아니다')
    assert.deepEqual(r.works[0].files.map((f) => f.name), ['1화.txt', '2화.txt', '10화.txt'])
    assert.deepEqual(r.loose.map((f) => f.name), ['낱권.txt'], '파일로 놓은 글은 묶지 않는다')
    assert.equal(r.unsupported, 1, '표지는 가져오고 메모.md만 건너뛴다')
    assert.equal(r.works[0].coverPath, join(root, '작품A', '표지.jpg'))
    assert.equal(scannedPaths(r).length, 6)
  } finally { clean(root) }
})

test('크기 상한을 넘으면 따로 세고 넣지 않는다 · 없는 자리는 missing', async () => {
  const root = fixture()
  try {
    const r = await scanTextPaths([join(root, '큰책'), join(root, '없는폴더')], 1000)
    assert.equal(r.works.length, 0); assert.equal(r.tooLarge, 1)
    assert.deepEqual(r.missing, [join(root, '없는폴더')])
  } finally { clean(root) }
})

test('★연결(정션) 순환을 따라가지 않는다', async () => {
  const root = fixture()
  try {
    symlinkSync(root, join(root, '작품A', '되돌이'), 'junction')
    assert.ok(existsSync(join(root, '작품A', '되돌이', '작품A')), '검사 준비: 순환 연결이 있다')
    const r = await scanTextPaths([root], 1000)
    assert.ok(r.links >= 1, '연결을 세고 건너뛴다')
    assert.equal(r.works.filter((w) => w.name === '작품A').length, 1, '같은 작품을 두 번 훑지 않는다')
    assert.equal(r.truncated, false)
  } finally { clean(root) }
})


test('표지 이름을 우선하고 이미지가 여러 장이면 임의로 고르지 않는다', async () => {
  const root = fixture()
  try {
    writeFileSync(join(root, '작품A', '삽화.png'), 'x')
    let r = await scanTextPaths([join(root, '작품A')], 1000)
    assert.equal(r.works[0].coverPath, join(root, '작품A', '표지.jpg'))
    unlinkSync(join(root, '작품A', '표지.jpg'))
    r = await scanTextPaths([join(root, '작품A')], 1000)
    assert.equal(r.works[0].coverPath, join(root, '작품A', '삽화.png'))
    writeFileSync(join(root, '작품A', '다른삽화.png'), 'x')
    r = await scanTextPaths([join(root, '작품A')], 1000)
    assert.equal(r.works[0].coverPath, undefined)
  } finally { clean(root) }
})
