// 설정 파일의 판 번호 — 쓸 때 찍히고, 읽을 때 올라가고, 모르는 것은 버리지 않는다.
//
// 여기서 보는 것
//   · 번호 이전 파일(판 0)을 읽으면 판 1 로 올라가되 데이터는 한 글자도 바뀌지 않는다
//   · 쓰면 meta{formatVersion, lastWrittenBy, lastWrittenAt} 이 찍힌다 — 다른 키는 그대로
//   · 모르는 키(미래의 영역)는 보존된다
//   · 파일 판이 아는 판보다 높으면 내리지 않는다(읽기도, 쓰기도)
//   · meta 는 IPC 가 아니라 저장소만 쓴다 — 키 이름으로 직접 쓰려 하면 거절
//   · 단계가 빠진 번호 올림은 개발 오류로 즉시 드러난다(예외)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  SETTINGS_FORMAT_VERSION, SETTINGS_META_KEY, migrateSettings, readSettingsMeta, setSettingsKey,
  stampSettingsMeta, readSettingsFile,
} from './settings-store.ts'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'af-settings-meta-'))
  return { dir, file: join(dir, 'settings.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
const T0 = new Date(2026, 8, 17, 23, 30, 0)

test('아는 판은 1 이고 meta 키는 하나다', () => {
  assert.equal(SETTINGS_FORMAT_VERSION, 1)
  assert.equal(SETTINGS_META_KEY, 'meta')
})

test('번호 이전 파일은 판 0 으로 읽힌다 — 깨진 meta 도 판 0', () => {
  assert.deepEqual(readSettingsMeta({}), { formatVersion: 0, lastWrittenBy: null, lastWrittenAt: null })
  assert.deepEqual(readSettingsMeta({ meta: 'garbage' }), { formatVersion: 0, lastWrittenBy: null, lastWrittenAt: null })
  assert.deepEqual(readSettingsMeta({ meta: { formatVersion: -3 } }).formatVersion, 0)
  assert.deepEqual(readSettingsMeta({ meta: { formatVersion: 1.5 } }).formatVersion, 0, '정수만 판이다')
  assert.deepEqual(readSettingsMeta({ meta: { formatVersion: 2, lastWrittenBy: '1.13.0', lastWrittenAt: 'x' } }),
    { formatVersion: 2, lastWrittenBy: '1.13.0', lastWrittenAt: 'x' })
})

test('판 0 → 1 이전은 데이터를 한 글자도 바꾸지 않는다 — 모르는 키 포함', () => {
  const legacy = {
    lastDir: 'E:/x', playbackVolume: 0.7,
    workDrafts: { k: { ttsText: '대사', speakerMode: 'multi' } },
    futureArea: { anything: [1, 2, 3] },
  }
  const r = migrateSettings(legacy)
  assert.equal(r.from, 0); assert.equal(r.to, 1); assert.equal(r.newerThanKnown, false)
  assert.deepEqual(r.settings, legacy, '값 동일')
  assert.notEqual(r.settings, legacy, '새 객체다 — 입력을 고치지 않는다')
})

test('쓰면 meta 가 찍히고 다른 키는 그대로다', () => {
  const s = scratch()
  try {
    writeFileSync(s.file, JSON.stringify({ lastDir: 'E:/x', futureArea: { keep: true } }), 'utf-8')
    const r = setSettingsKey(s.file, 'playbackVolume', 0.5, { writtenBy: '1.12.0-dev', now: () => T0 })
    assert.deepEqual(r, { ok: true })
    const saved = JSON.parse(readFileSync(s.file, 'utf-8'))
    assert.deepEqual(saved, {
      lastDir: 'E:/x', futureArea: { keep: true }, playbackVolume: 0.5,
      meta: { formatVersion: 1, lastWrittenBy: '1.12.0-dev', lastWrittenAt: T0.toISOString() },
    })
  } finally { s.cleanup() }
})

test('앱 판을 모르면 null 로 찍는다 — 지어내지 않는다', () => {
  const s = scratch()
  try {
    setSettingsKey(s.file, 'a', 1, { now: () => T0 })
    assert.equal(JSON.parse(readFileSync(s.file, 'utf-8')).meta.lastWrittenBy, null)
  } finally { s.cleanup() }
})

test('파일 판이 아는 판보다 높으면 내리지 않는다 — 읽기도 쓰기도', () => {
  const newer = { meta: { formatVersion: 7, lastWrittenBy: '9.0.0', lastWrittenAt: 'later' }, newArea: { x: 1 }, lastDir: 'E:/y' }
  const r = migrateSettings(newer)
  assert.equal(r.newerThanKnown, true); assert.equal(r.from, 7); assert.equal(r.to, 7)
  assert.deepEqual(r.settings, newer, '그대로 읽는다')

  const s = scratch()
  try {
    writeFileSync(s.file, JSON.stringify(newer), 'utf-8')
    setSettingsKey(s.file, 'playbackVolume', 0.3, { writtenBy: '1.12.0-dev', now: () => T0 })
    const saved = JSON.parse(readFileSync(s.file, 'utf-8'))
    assert.equal(saved.meta.formatVersion, 7, '판을 내리지 않는다')
    assert.equal(saved.meta.lastWrittenBy, '1.12.0-dev', '쓴 앱은 사실대로')
    assert.deepEqual(saved.newArea, { x: 1 }, '모르는 영역은 보존')
    assert.equal(saved.playbackVolume, 0.3)
  } finally { s.cleanup() }
})

test('meta 를 키로 직접 쓰려 하면 거절하고 파일을 건드리지 않는다', () => {
  const s = scratch()
  try {
    writeFileSync(s.file, '{"a":1}', 'utf-8')
    const r = setSettingsKey(s.file, 'meta', { formatVersion: 99 })
    assert.deepEqual(r, { ok: false, code: 'SETTINGS_META_IS_OWNED_BY_STORE', preserved: true })
    assert.equal(readFileSync(s.file, 'utf-8'), '{"a":1}')
  } finally { s.cleanup() }
})

test('stamp 는 입력을 고치지 않고 새 객체를 돌려준다', () => {
  const input = { a: 1 }
  const out = stampSettingsMeta(input, '1.12.0-dev', T0)
  assert.deepEqual(input, { a: 1 })
  assert.deepEqual(out, { a: 1, meta: { formatVersion: 1, lastWrittenBy: '1.12.0-dev', lastWrittenAt: T0.toISOString() } })
})

test('두 번 써도 meta 는 하나고 마지막 시각으로 갱신된다', () => {
  const s = scratch()
  try {
    setSettingsKey(s.file, 'a', 1, { writtenBy: '1.12.0-dev', now: () => T0 })
    const T1 = new Date(2026, 8, 17, 23, 31, 0)
    setSettingsKey(s.file, 'b', 2, { writtenBy: '1.12.0-dev', now: () => T1 })
    const got = readSettingsFile(s.file)
    assert.equal(got.kind, 'ok')
    if (got.kind === 'ok') {
      assert.deepEqual(Object.keys(got.settings).sort(), ['a', 'b', 'meta'])
      assert.equal(readSettingsMeta(got.settings).lastWrittenAt, T1.toISOString())
    }
  } finally { s.cleanup() }
})
