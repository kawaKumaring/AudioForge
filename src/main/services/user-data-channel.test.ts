// 채널별 사용자 데이터 폴더 — 실제 폴더로 확인한다.
//
// 보는 것
//   · 정식·RC·모름 → 기본 폴더, 개발선만 -dev
//   · 첫 실행에 앱 소유 항목만 복사하고 Electron 캐시는 옮기지 않는다
//   · 원본은 바뀌지 않는다(이름·크기·내용)
//   · 두 번째 실행은 아무것도 하지 않는다 — 표식만 있어도(설정을 지웠어도) 다시 복사하지 않는다
//   · 원본에 설정이 없으면 복사하지 않는다
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  APP_OWNED_ENTRIES, SEED_MARKER_FILE, USER_DATA_DIR_DEV, USER_DATA_DIR_STABLE,
  seedDevUserData, userDataDirNameFor,
} from './user-data-channel.ts'
import { CHANNEL_DEVELOPMENT, CHANNEL_RELEASE_CANDIDATE, CHANNEL_STABLE } from '../../shared/buildMetadata.ts'

function scratch() {
  const base = mkdtempSync(join(tmpdir(), 'af-udc-'))
  const from = join(base, USER_DATA_DIR_STABLE)
  const to = join(base, USER_DATA_DIR_DEV)
  return { base, from, to, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

function fillStable(from: string) {
  mkdirSync(join(from, 'reference-library'), { recursive: true })
  mkdirSync(join(from, 'lab-takes', 'doc1'), { recursive: true })
  mkdirSync(join(from, 'Cache'), { recursive: true })
  mkdirSync(join(from, 'Code Cache'), { recursive: true })
  writeFileSync(join(from, 'settings.json'), JSON.stringify({ playbackVolume: 0.5 }), 'utf-8')
  writeFileSync(join(from, 'reference-library', 'manifest.json'), '{"records":[]}', 'utf-8')
  writeFileSync(join(from, 'lab-takes', 'doc1', 'take.wav'), Buffer.alloc(64, 7))
  writeFileSync(join(from, 'Cache', 'big.bin'), Buffer.alloc(1024, 1))
  writeFileSync(join(from, 'Preferences'), '{}', 'utf-8')
}

function fingerprint(dir: string): string {
  const out: string[] = []
  const walk = (d: string, rel: string) => {
    for (const n of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, n.name); const r = rel + '/' + n.name
      if (n.isDirectory()) walk(p, r)
      else out.push(`${r}:${statSync(p).size}:${readFileSync(p).toString('hex').slice(0, 32)}`)
    }
  }
  walk(dir, '')
  return out.join('\n')
}

test('폴더 이름 — 개발선만 -dev, 나머지는 기본', () => {
  assert.equal(userDataDirNameFor(CHANNEL_DEVELOPMENT), 'audio-forge-dev')
  assert.equal(userDataDirNameFor(CHANNEL_STABLE), 'audio-forge')
  assert.equal(userDataDirNameFor(CHANNEL_RELEASE_CANDIDATE), 'audio-forge', 'RC 는 정식과 같은 데이터를 본다')
  assert.equal(userDataDirNameFor(null), 'audio-forge', '모르는 접미사는 지어내지 않고 기본')
})

test('첫 실행: 앱 소유 항목만 복사, 캐시는 두고, 원본은 그대로', () => {
  const s = scratch()
  try {
    fillStable(s.from)
    const before = fingerprint(s.from)
    const r = seedDevUserData({ from: s.from, to: s.to, now: () => new Date(2026, 8, 17, 23, 0, 0) })
    assert.equal(r.seeded, true)
    if (r.seeded) {
      assert.deepEqual(r.copied, ['settings.json', 'reference-library', 'lab-takes'])
      assert.deepEqual(r.skipped, ['refclips', 'emotion-sampler-cache'], '원본에 없는 항목은 건너뛴 것으로 적는다')
    }
    assert.equal(readFileSync(join(s.to, 'settings.json'), 'utf-8'), JSON.stringify({ playbackVolume: 0.5 }))
    assert.ok(existsSync(join(s.to, 'reference-library', 'manifest.json')))
    assert.equal(readFileSync(join(s.to, 'lab-takes', 'doc1', 'take.wav')).length, 64, '중첩 폴더까지 복사된다')
    assert.equal(existsSync(join(s.to, 'Cache')), false, 'Electron 캐시는 옮기지 않는다')
    assert.equal(existsSync(join(s.to, 'Code Cache')), false)
    assert.equal(existsSync(join(s.to, 'Preferences')), false, '목록에 없는 것은 옮기지 않는다')
    const marker = JSON.parse(readFileSync(join(s.to, SEED_MARKER_FILE), 'utf-8'))
    assert.equal(marker.fromDirName, 'audio-forge')
    assert.equal(marker.seededAt, new Date(2026, 8, 17, 23, 0, 0).toISOString())
    assert.ok(!JSON.stringify(marker).includes(s.base), '표식에 절대 경로가 없다')
    assert.equal(fingerprint(s.from), before, '원본은 이름·크기·내용 그대로')
  } finally { s.cleanup() }
})

test('두 번째 실행은 아무것도 하지 않는다 — 개발선에서 바꾼 값이 되돌아가지 않는다', () => {
  const s = scratch()
  try {
    fillStable(s.from)
    seedDevUserData({ from: s.from, to: s.to })
    writeFileSync(join(s.to, 'settings.json'), JSON.stringify({ playbackVolume: 0.9 }), 'utf-8')
    const r = seedDevUserData({ from: s.from, to: s.to })
    assert.deepEqual(r, { seeded: false, reason: 'already_initialized' })
    assert.equal(JSON.parse(readFileSync(join(s.to, 'settings.json'), 'utf-8')).playbackVolume, 0.9)
  } finally { s.cleanup() }
})

test('설정을 지웠어도 표식이 있으면 다시 복사하지 않는다 — 지운 뜻을 존중한다', () => {
  const s = scratch()
  try {
    fillStable(s.from)
    seedDevUserData({ from: s.from, to: s.to })
    rmSync(join(s.to, 'settings.json'))
    const r = seedDevUserData({ from: s.from, to: s.to })
    assert.deepEqual(r, { seeded: false, reason: 'already_initialized' })
    assert.equal(existsSync(join(s.to, 'settings.json')), false)
  } finally { s.cleanup() }
})

test('원본에 설정이 없으면 복사하지 않는다(새 PC) — 폴더도 만들지 않는다', () => {
  const s = scratch()
  try {
    mkdirSync(s.from, { recursive: true })
    const r = seedDevUserData({ from: s.from, to: s.to })
    assert.deepEqual(r, { seeded: false, reason: 'no_source' })
    assert.equal(existsSync(s.to), false)
  } finally { s.cleanup() }
})

test('같은 폴더면 아무것도 하지 않는다', () => {
  const s = scratch()
  try {
    fillStable(s.from)
    assert.deepEqual(seedDevUserData({ from: s.from, to: s.from }), { seeded: false, reason: 'same_dir' })
  } finally { s.cleanup() }
})

test('옮기는 항목 목록은 앱 소유 다섯 개뿐이다 — 늘리려면 여기서 의도를 밝혀야 한다', () => {
  assert.deepEqual([...APP_OWNED_ENTRIES], ['settings.json', 'reference-library', 'refclips', 'lab-takes', 'emotion-sampler-cache'])
})
